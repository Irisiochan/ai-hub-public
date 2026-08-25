import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  buildDailyCheckSummary,
  DEFAULT_CATEGORIES,
  fileWatchContentDigest,
  isDailyMode,
  isIdeaMode,
  isShanghaiSilentHour,
  isWebhookProbeInput,
  nextTimerDelay,
  nextWallClockDelay,
  normalizeBacklogSweepConfig,
  normalizeCoordinationConfig,
  normalizeDiaryConfig,
  normalizeIdeaConfig,
  normalizeOutcomeConfig,
  normalizeProactiveConfig,
  normalizeTaskReminderConfig,
  shouldSuppressUnchangedFileWatch,
  shanghaiDateAt,
  timerSchedule,
  TriageStore,
} from './triage-core.mjs';
import { normalizeFollowupConfig } from './followups.mjs';
import { normalizeAgendaConfig } from './agenda-core.mjs';
import { DeepSeekClient, HubClient, VaultClient } from './triage-clients.mjs';
import {
  agendaOnce,
  bearerMatches,
  hash,
  log,
  metricsOnly,
  once,
  reminderOnce,
  reminderShadow,
  sleep,
} from './worker-shared.mjs';
import { followupMethods } from './worker-followups.mjs';
import { coordinationMethods } from './worker-coordination.mjs';
import { proactiveMethods } from './worker-proactive.mjs';
import { outcomeMethods } from './worker-outcomes.mjs';
import { backlogMethods } from './worker-backlog.mjs';
import { reminderMethods } from './worker-reminders.mjs';
import { ideaDiaryMethods } from './worker-idea-diary.mjs';
import { pipelineMethods } from './worker-pipeline.mjs';
import { agendaMethods } from './worker-agenda.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(process.argv.find((arg) => !arg.startsWith('--') && arg !== process.argv[0] && arg !== process.argv[1])
  ?? path.join(scriptDir, 'triage.config.json'));

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing ${configPath}; copy triage.config.example.json and keep secrets in environment variables`);
  }
  const value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  value.categories = Array.isArray(value.categories) && value.categories.length
    ? value.categories
    : DEFAULT_CATEGORIES;
  value.stateFile = path.resolve(path.dirname(configPath), value.stateFile ?? 'data/triage.db');
  value.pollMs = Math.max(250, Number(value.pollMs ?? 1000));
  value.maxAttempts = Math.max(1, Number(value.maxAttempts ?? 5));
  value.claimTimeoutMs = Math.max(30_000, Number(value.claimTimeoutMs ?? 5 * 60_000));
  value.breakers = {
    dailyEvents: Math.max(1, Number(value.breakers?.dailyEvents ?? 2000)),
    dailyCostCny: Math.max(0, Number(value.breakers?.dailyCostCny ?? 5)),
  };
  value.proactive = normalizeProactiveConfig(value.proactive ?? {});
  value.taskReminders = normalizeTaskReminderConfig(value.taskReminders ?? {}, value.proactive);
  value.idea = normalizeIdeaConfig(value.idea ?? {});
  value.coordination = normalizeCoordinationConfig(value.coordination ?? {});
  value.diary = normalizeDiaryConfig(value.diary ?? {});
  value.outcomes = normalizeOutcomeConfig(value.outcomes ?? {});
  value.followups = normalizeFollowupConfig(value.followups ?? {});
  value.backlogSweep = normalizeBacklogSweepConfig(value.backlogSweep ?? {});
  value.agenda = normalizeAgendaConfig(value.agenda ?? {}, value.coordination);
  return value;
}

class TriageWorker {
  constructor(config) {
    this.config = config;
    // 迁移/打开失败不再让进程崩溃进 systemd 重启循环：进入 maintenance mode——
    // webhook intake 落 JSONL 侧账继续收事件，所有派发/runner 面停摆，
    // 修复后重启自动回放侧账（eventId 按 dedupe 派生，回放天然幂等）。
    this.maintenance = null;
    this.store = null;
    try {
      this.store = new TriageStore(config.stateFile);
    } catch (error) {
      this.maintenance = { reason: error.message, since: Date.now() };
    }
    this.deepseek = new DeepSeekClient(config.deepseek ?? {}, config.categories);
    this.hub = new HubClient(config.hub ?? {});
    this.vault = new VaultClient(config.vault ?? {});
    this.stopping = false;
    this.closed = false;
    this.timers = [];
    this.watchers = [];
    this.server = null;
    this.nextOutcomePollAt = 0;
    this.nextFollowupPollAt = 0;
    this.nextCoordinationPollAt = 0;
    /** @type {Promise<unknown>[]} */
    this.pendingSourceJobs = [];
  }

  enqueue(event) {
    const result = this.store.enqueue(event);
    if (result.inserted) log('info', 'event queued', { eventId: result.id, source: event.source });
    return result;
  }

  async pollHttpDiff(source) {
    const response = await fetch(source.url, {
      headers: source.headers ?? {},
      signal: AbortSignal.timeout(Number(source.timeoutMs ?? 20_000)),
    });
    if (!response.ok) throw new Error(`${source.url}: HTTP ${response.status}`);
    const text = (await response.text()).slice(0, Number(source.maxChars ?? 100_000));
    const digest = hash(text);
    const key = `http-diff:${source.id}`;
    const previous = this.store.getSourceState(key);
    this.store.setSourceState(key, digest);
    if (!previous && source.emitInitial !== true) return;
    if (previous === digest) return;
    this.enqueue({
      source: source.id,
      categoryHint: source.category ?? 'rss',
      dedupeKey: digest,
      summary: `${source.label ?? source.url} changed.\n${text.slice(0, 12_000)}`,
      payload: { url: source.url, digest },
    });
  }

  async pollVault(source) {
    if (!this.vault.enabled) return;
    const text = await this.vault.backlog(source.query ?? this.config.vault?.backlogQuery ?? 'triage-backlog');
    const digest = hash(text);
    const key = `vault-backlog:${source.id}`;
    const previous = this.store.getSourceState(key);
    this.store.setSourceState(key, digest);
    if (!previous && source.emitInitial !== true) return;
    if (previous === digest) return;
    this.enqueue({
      source: source.id,
      categoryHint: 'backlog',
      dedupeKey: digest,
      summary: `Memory Vault backlog changed.\n${text.slice(0, 12_000)}`,
    });
  }

  schedulePoll(source, fn) {
    const intervalMs = Math.max(15_000, Number(source.intervalMinutes ?? 15) * 60_000);
    const run = () => fn.call(this, source).catch((error) => {
      log('warn', 'source poll failed', { source: source.id, error: error.message });
    });
    const initial = run();
    if (!once) this.timers.push(setInterval(run, intervalMs));
    return initial;
  }

  async startSources() {
    const initialPolls = [];
    for (const source of this.config.sources ?? []) {
      if (!source?.id || source.enabled === false) continue;
      if (source.type === 'diary-rollup') {
        const diary = this.diaryConfig();
        const emitDiary = () => {
          if (!this.diaryConfig().enabled) {
            log('info', 'diary rollup timer skipped: disabled', { source: source.id });
            return;
          }
          const now = Date.now();
          const date = shanghaiDateAt(now, this.diaryConfig().targetOffsetDays);
          this.enqueue({
            source: source.id,
            categoryHint: 'diary',
            // 一个上海日一个事件；同日重复触发会被 INSERT OR IGNORE 吞掉。
            dedupeKey: `${source.id}:${date}`,
            summary: `Settle the Asia/Shanghai diary for ${date} from real hub conversations.`,
            payload: { mode: 'diary', date, emittedAt: now },
          });
        };
        if (once) {
          emitDiary();
        } else {
          const slot = this.timers.push(null) - 1;
          const schedule = () => {
            if (this.stopping) return;
            this.timers[slot] = setTimeout(() => {
              emitDiary();
              schedule();
            }, nextWallClockDelay(this.diaryConfig()));
          };
          schedule();
          log('info', 'diary rollup scheduled', {
            source: source.id,
            at: `${String(diary.atHour).padStart(2, '0')}:${String(diary.atMinute).padStart(2, '0')}`,
            targetOffsetDays: diary.targetOffsetDays,
            enabled: diary.enabled,
          });
        }
      } else if (source.type === 'timer') {
        const { intervalMs } = timerSchedule(source);
        const daily = isDailyMode(source);
        const idea = isIdeaMode(source);
        const emit = async () => {
          const now = Date.now();
          let dateEvents = { today: [], upcoming: [], unclaimedToday: [] };
          let fallbackFollowups = [];
          let safetyEvents = [];
          if (daily || idea) {
            const proactive = this.proactiveConfig();
            if (daily && !proactive.enabled) return;
            if (idea && !this.ideaConfig().enabled) return;
            // P3 S4: fresh safety life-events pierce silent hours — a flooded
            // apartment at 02:00 still deserves one proactive check-in.
            if (daily) safetyEvents = await this.loadUnclaimedSafetyEvents(now);
            if (isShanghaiSilentHour(now, proactive.silentStartHour, proactive.silentEndHour)) {
              if (!(daily && safetyEvents.length)) {
                log('info', `${idea ? 'idea' : 'daily'} timer skipped: silent hours`, { source: source.id });
                return;
              }
              log('info', 'daily timer piercing silent hours: fresh safety event', {
                source: source.id,
                safetyEventIds: safetyEvents.map((event) => event.id),
              });
            }
            if (daily) {
              dateEvents = await this.loadMatchedDateEvents(now);
              fallbackFollowups = this.followupFallbacks(now);
            }
            const policy = idea
              ? this.ideaPolicy(now)
              : this.dailyPolicy(now, {
                hasTodayDateEvent: dateEvents.unclaimedToday.length > 0 || fallbackFollowups.length > 0,
                hasFreshSafetyEvent: safetyEvents.length > 0,
              });
            if (policy.poolFull || policy.gapBlocked) {
              log('info', `${idea ? 'idea' : 'daily'} timer skipped by pool policy`, {
                source: source.id,
                reason: policy.poolFull ? 'pool-full' : 'minimum-gap',
              });
              return;
            }
          }
          const policy = daily
            ? this.dailyPolicy(now, {
              hasTodayDateEvent: dateEvents.unclaimedToday.length > 0 || fallbackFollowups.length > 0,
              hasFreshSafetyEvent: safetyEvents.length > 0,
            })
            : null;
          this.enqueue({
            source: source.id,
            categoryHint: source.category ?? (idea ? 'idea' : daily ? 'daily' : 'system'),
            dedupeKey: `${source.id}:${Math.floor(now / intervalMs)}`,
            summary: idea
              ? (source.summary ?? 'Daily autonomous room idea discussion.')
              : daily
              ? buildDailyCheckSummary({
                ...source,
                recipients: this.proactiveConfig().recipients,
              }, now, {
                proactive: this.proactiveConfig(),
                forceActionable: policy.forceActionable,
                todayDateEvents: dateEvents.unclaimedToday,
                upcomingDateEvents: dateEvents.upcoming,
                hasFallbackFollowup: fallbackFollowups.length > 0,
                activeSafetyEvents: safetyEvents,
              })
              : (source.summary ?? `Scheduled wake from ${source.id}`),
            payload: {
              ...(source.payload && typeof source.payload === 'object' ? source.payload : {}),
              mode: idea ? 'idea' : daily ? 'daily' : 'task',
              emittedAt: now,
              // Positive scheduler identity for system-timer wake gate only.
              // Webhook/http-diff with categoryHint:'system' must NOT carry this.
              ...(!daily && !idea ? { origin: 'scheduler-timer' } : {}),
              ...(daily && dateEvents.unclaimedToday.length
                ? { todayDateEvents: dateEvents.unclaimedToday }
                : {}),
              ...(daily && fallbackFollowups.length
                ? { fallbackFollowupIds: fallbackFollowups.map((item) => item.id) }
                : {}),
            },
          });
        };
        if (once) {
          this.pendingSourceJobs.push(
            emit().catch((error) => {
              log('error', 'timer emit failed', { source: source.id, error: error.message });
              throw error;
            }),
          );
        } else {
          const slot = this.timers.push(null) - 1;
          const schedule = (first) => {
            if (this.stopping) return;
            this.timers[slot] = setTimeout(() => {
              emit().catch((error) => {
                log('error', 'timer emit failed', { source: source.id, error: error.message });
              });
              schedule(false);
            }, nextTimerDelay(source, { first }));
          };
          schedule(true);
        }
      } else if (source.type === 'file') {
        if (once) continue;
        const watchRoot = path.resolve(source.path);
        const watcher = fs.watch(watchRoot, { recursive: source.recursive === true }, (eventType, filename) => {
          const relative = String(filename ?? '');
          const target = relative ? path.resolve(watchRoot, relative) : watchRoot;
          // mtime/size digest: content unchanged → no downstream triage.
          // Missing stat (delete/rename race) fails open and still enqueues.
          let digest = null;
          try {
            const st = fs.statSync(target);
            digest = fileWatchContentDigest(st, relative || path.basename(watchRoot));
          } catch {
            digest = null;
          }
          const stateKey = `file-watch:${source.id}:${relative || '.'}`;
          const previous = this.store.getSourceState(stateKey);
          if (shouldSuppressUnchangedFileWatch(previous, digest)) {
            log('info', 'file watch suppressed: mtime/size unchanged', {
              source: source.id,
              filename: relative,
              digest,
            });
            return;
          }
          if (digest) this.store.setSourceState(stateKey, digest);
          const key = `${source.id}:${eventType}:${relative}:${digest ?? Math.floor(Date.now() / 1000)}`;
          this.enqueue({
            source: source.id,
            categoryHint: source.category ?? 'file-change',
            dedupeKey: key,
            summary: `File event ${eventType}: ${relative || source.path}`,
            payload: {
              path: source.path,
              filename: relative,
              eventType,
              ...(digest ? { digest } : {}),
            },
          });
        });
        this.watchers.push(watcher);
      } else if (source.type === 'http-diff') {
        initialPolls.push(this.schedulePoll(source, this.pollHttpDiff));
      } else if (source.type === 'vault-backlog') {
        initialPolls.push(this.schedulePoll(source, this.pollVault));
      }
    }
    await Promise.allSettled(initialPolls);
    if (once) {
      // Timer daily emit may await vault.facts(); finish those before --once drains the queue.
      await Promise.allSettled(this.pendingSourceJobs);
      this.pendingSourceJobs = [];
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  startWebhook() {
    const webhook = this.config.webhook;
    if (!webhook?.enabled || once) return;
    const token = process.env[webhook.tokenEnv ?? 'TRIAGE_WEBHOOK_TOKEN'] ?? '';
    this.server = http.createServer((req, res) => {
      const respond = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url === '/health') {
        if (this.maintenance) {
          return respond(200, {
            status: 'maintenance',
            reason: this.maintenance.reason,
            since: this.maintenance.since,
          });
        }
        return respond(200, { status: 'ok', metrics: this.store.dailySummary() });
      }
      if (req.method !== 'POST' || req.url !== '/event') return respond(404, { error: 'not found' });
      if (!bearerMatches(req.headers.authorization, token)) {
        return respond(401, { error: 'unauthorized' });
      }
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 1_000_000) req.destroy();
      });
      req.on('end', () => {
        try {
          const input = JSON.parse(raw || '{}');
          // Probe/health payloads: log + ack only; never enqueue for model triage.
          if (isWebhookProbeInput(input)) {
            log('info', 'webhook probe acknowledged', {
              source: input.source ?? 'webhook',
              kind: input.kind ?? input.payload?.kind ?? 'probe',
            });
            return respond(200, {
              status: 'probe-ok',
              recorded: true,
              enqueued: false,
            });
          }
          if (this.maintenance) {
            fs.appendFileSync(
              this.maintenanceIntakePath(),
              `${JSON.stringify({ receivedAt: Date.now(), input })}\n`,
            );
            return respond(202, { status: 'maintenance-intake', recorded: true, enqueued: false });
          }
          const queued = this.enqueue({
            source: input.source ?? 'webhook',
            summary: input.summary,
            payload: input.payload,
            categoryHint: input.categoryHint,
            dedupeKey: input.dedupeKey,
          });
          respond(202, queued);
        } catch (error) {
          respond(400, { error: error.message });
        }
      });
    });
    this.server.listen(Number(webhook.port ?? 3911), webhook.host ?? '127.0.0.1', () => {
      log('info', 'webhook listening', { host: webhook.host ?? '127.0.0.1', port: Number(webhook.port ?? 3911) });
    });
  }

  maintenanceIntakePath() {
    return `${path.resolve(this.config.stateFile)}.maintenance-intake.jsonl`;
  }

  /** 健康启动时回放维护期侧账；eventId 按 dedupe 派生 + INSERT OR IGNORE，重复回放无副作用。 */
  replayMaintenanceIntake() {
    const file = this.maintenanceIntakePath();
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const lines = raw.split('\n').filter((line) => line.trim());
    let replayed = 0;
    let failed = 0;
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const input = record.input ?? {};
        this.enqueue({
          source: input.source ?? 'webhook',
          summary: input.summary,
          payload: input.payload,
          categoryHint: input.categoryHint,
          dedupeKey: input.dedupeKey,
          ...(Number.isFinite(record.receivedAt) ? { createdAt: record.receivedAt } : {}),
        });
        replayed += 1;
      } catch (error) {
        failed += 1;
        log('warn', 'maintenance intake line replay failed', { error: error.message });
      }
    }
    const archived = `${file}.replayed-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(file, archived);
    log(failed ? 'warn' : 'info', 'maintenance intake replayed', {
      replayed,
      failed,
      archived: path.basename(archived),
    });
  }

  async runMaintenance() {
    log('error', 'maintenance mode: triage store unavailable; webhook intake only, all dispatch disabled', {
      reason: this.maintenance.reason,
    });
    if (agendaOnce) {
      await this.runAgendaShadow();
      return;
    }
    if (metricsOnly || once || reminderOnce) {
      // 一次性命令没有“挂着等修复”的意义：报错退出，让调用方立刻看到。
      process.exitCode = 1;
      return;
    }
    this.startWebhook();
    let lastBeat = Date.now();
    while (!this.stopping) {
      await sleep(Math.min(this.config.pollMs, 5_000));
      if (Date.now() - lastBeat >= 10 * 60_000) {
        lastBeat = Date.now();
        log('warn', 'maintenance mode active', {
          reason: this.maintenance.reason,
          sinceMs: Date.now() - this.maintenance.since,
        });
      }
    }
  }

  async run() {
    if (this.maintenance) return this.runMaintenance();
    if (this.store.migration) {
      log('info', 'triage db ready', {
        schemaFrom: this.store.migration.from,
        schemaTo: this.store.migration.to,
      });
    }
    const recovered = this.store.recoverStale(this.config.claimTimeoutMs);
    if (recovered) log('warn', 'recovered stale events', { count: recovered });
    const recoveredVaultWrites = this.store.recoverStaleVaultWrites(this.config.claimTimeoutMs);
    if (recoveredVaultWrites) log('warn', 'recovered stale vault writes', { count: recoveredVaultWrites });
    if (metricsOnly) {
      process.stdout.write(`${JSON.stringify(this.store.dailySummary(), null, 2)}\n`);
      return;
    }
    if (agendaOnce) {
      await this.startAgenda();
      return;
    }
    // Reminder-only commands must not wake unrelated timers. In particular,
    // --reminder-shadow is a read-only production probe and may never dispatch.
    if (reminderShadow || reminderOnce) {
      await this.startTaskReminders();
      if (reminderShadow) return;
    } else {
      this.replayMaintenanceIntake();
      await this.startSources();
      await this.startTaskReminders();
      await this.startBacklogSweep();
      await this.startAgenda();
    }
    this.startWebhook();
    do {
      await this.collectOutcomesIfDue();
      await this.processFollowupsIfDue();
      await this.scanCoordinationIfDue();
      const vaultWorked = await this.processVaultOutboxOne();
      const eventWorked = await this.processOne();
      if (once && !vaultWorked && !eventWorked) break;
      if (!vaultWorked && !eventWorked) await sleep(this.config.pollMs);
    } while (!this.stopping);
  }

  // Signals only ask the run loop to finish its current event. Tearing the
  // store down from the handler raced with an in-flight processOne() and then
  // ran a second time from the run() finally block, which crashed on an
  // already closed database and made every graceful restart exit 1.
  requestStop() {
    this.stopping = true;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.stopping = true;
    for (const timer of this.timers) clearTimeout(timer);
    for (const watcher of this.watchers) watcher.close();
    await new Promise((resolve) => this.server ? this.server.close(resolve) : resolve());
    await this.vault.close();
    this.store?.close();
  }
}


// Domain 方法按 mixin 挂载；`this` 语义与类内方法一致（无 #private、无继承）。
// TriageWorker 本体只保留生命周期、轮询与调度（constructor/run/close/sources/webhook/maintenance）。
Object.assign(
  TriageWorker.prototype,
  followupMethods,
  coordinationMethods,
  proactiveMethods,
  outcomeMethods,
  backlogMethods,
  reminderMethods,
  ideaDiaryMethods,
  pipelineMethods,
  agendaMethods,
);

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // The documented local Agenda probe must be safe without production config:
    // report the health-gate quiet result and never invent a room/vault target.
    if (agendaOnce && String(error.message).startsWith('Missing ')) {
      log('info', 'agenda shadow quiet', { reason: error.message });
      return;
    }
    throw error;
  }
  const worker = new TriageWorker(config);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log('info', 'shutdown requested', { signal });
      worker.requestStop();
    });
  }

  try {
    await worker.run();
  } finally {
    await worker.close();
  }
}

await main();
