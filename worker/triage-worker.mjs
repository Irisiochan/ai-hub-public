import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  buildDailyCheckSummary,
  chooseRecipient,
  dailyPolicyState,
  DEFAULT_CATEGORIES,
  DELIVERY_POOL_DAILY,
  DELIVERY_POOL_TASK,
  isDailyMode,
  isShanghaiSilentHour,
  nextTimerDelay,
  normalizeProactiveConfig,
  shanghaiClock,
  timerSchedule,
  TriageStore,
  validateTriageMode,
} from './triage-core.mjs';
import { DeepSeekClient, HubClient, VaultClient } from './triage-clients.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(process.argv.find((arg) => !arg.startsWith('--') && arg !== process.argv[0] && arg !== process.argv[1])
  ?? path.join(scriptDir, 'triage.config.json'));
const once = process.argv.includes('--once');
const metricsOnly = process.argv.includes('--metrics');

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
  return value;
}

function log(level, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    level,
    time: new Date().toISOString(),
    component: 'triage-worker',
    msg: message,
    ...fields,
  })}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function bearerMatches(header, token) {
  if (!token) return true;
  const actual = Buffer.from(String(header ?? ''));
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function retryDelay(attempt) {
  return Math.min(15 * 60_000, 5000 * (2 ** Math.max(0, attempt - 1)));
}

function dispatchPrompt(event, result, { daily = false } = {}) {
  if (daily) {
    return [
      '这是一次已经通过 daily triage 的主动陪伴机会。',
      '请现在直接用你自己的自然语气对 Iris 说一条简短消息。',
      '不要提及 triage、路由、系统事件、后台判断或 NO_OP；不要复述本指令。',
      '除非上下文里确有具体待办，否则不要登记任务或写长期记忆。',
      `分诊理由：${result.rationale}`,
      '',
      '可参考的当前线索：',
      event.summary.slice(0, 6000),
    ].join('\n');
  }
  return [
    '⚡ AI Hub 自主事件分派',
    `来源：${event.source}`,
    `分类：${result.category}｜优先级：P${result.priority}`,
    `判断：${result.rationale}`,
    '',
    '真实事件上下文：',
    event.summary.slice(0, 16_000),
    '',
    '请先判断是否需要行动；需要时直接处理或登记任务，不需要时简短说明 NO_OP。',
  ].join('\n');
}

class TriageWorker {
  constructor(config) {
    this.config = config;
    this.store = new TriageStore(config.stateFile);
    this.deepseek = new DeepSeekClient(config.deepseek ?? {}, config.categories);
    this.hub = new HubClient(config.hub ?? {});
    this.vault = new VaultClient(config.vault ?? {});
    this.stopping = false;
    this.closed = false;
    this.timers = [];
    this.watchers = [];
    this.server = null;
    this.backlogCache = { value: '', expires: 0 };
  }

  enqueue(event) {
    const result = this.store.enqueue(event);
    if (result.inserted) log('info', 'event queued', { eventId: result.id, source: event.source });
    return result;
  }

  async backlog() {
    if (!this.vault.enabled) return '';
    const now = Date.now();
    if (this.backlogCache.expires > now) return this.backlogCache.value;
    const value = await this.vault.backlog(this.config.vault?.backlogQuery ?? 'triage-backlog');
    this.backlogCache = {
      value,
      expires: now + Math.max(30_000, Number(this.config.vault?.cacheMs ?? 5 * 60_000)),
    };
    return value;
  }

  breakerReason() {
    const summary = this.store.dailySummary();
    if (summary.total >= this.config.breakers.dailyEvents) return 'daily event breaker';
    if (
      this.config.breakers.dailyCostCny > 0
      && summary.costCny >= this.config.breakers.dailyCostCny
    ) {
      return 'daily cost breaker';
    }
    return null;
  }

  proactiveConfig() {
    return this.config.proactive ?? normalizeProactiveConfig({});
  }

  isDailyEvent(event) {
    // Delivery pools are a trusted event-source property. Never let L1 move a
    // normal task into the daily pool by returning category=daily.
    return isDailyMode(event);
  }

  dailyPolicy(now = Date.now()) {
    return dailyPolicyState(
      this.proactiveConfig(),
      this.store.poolUsage(DELIVERY_POOL_DAILY, now),
      now,
    );
  }

  async proactiveContext(contacts, now = Date.now()) {
    const usage = this.store.poolUsage(DELIVERY_POOL_DAILY, now);
    const recentConversations = contacts
      .filter((contact) => contact?.last_at)
      .sort((a, b) => Date.parse(b.last_at) - Date.parse(a.last_at))
      .slice(0, 3)
      .map((contact) => ({
        recipient: contact.config?.routing?.recipientKey ?? contact.id,
        name: contact.name,
        lastAt: contact.last_at,
      }));
    const openTasks = this.vault.enabled
      ? await this.vault.taskContext().catch((error) => {
        log('warn', 'proactive task context unavailable', { error: error.message });
        return '';
      })
      : '';
    return {
      currentShanghaiTime: shanghaiClock(now).label,
      dailyDeliveryCount: usage.count,
      lastDailyDeliveryAt: usage.lastAt === null ? null : new Date(usage.lastAt).toISOString(),
      recentConversations,
      openTaskSnapshot: openTasks.slice(0, 3000) || '(unavailable)',
    };
  }

  routeOptions(isDaily) {
    const proactive = this.proactiveConfig();
    if (!isDaily) {
      return {
        rules: this.config.routing?.rules ?? {},
        usageOf: (recipientId) => this.store.recipientUsage(recipientId, Date.now(), DELIVERY_POOL_TASK),
        allowedRecipientKeys: null,
        ignoreRecipientLimits: false,
        modelOnly: false,
      };
    }
    return {
      // Daily proactive routing is model-owned: never apply the static task rules table.
      rules: {},
      usageOf: () => ({ count: 0, lastAt: null }),
      allowedRecipientKeys: proactive.recipients,
      ignoreRecipientLimits: true,
      modelOnly: true,
    };
  }

  async processOne() {
    const event = this.store.claim();
    if (!event) return false;
    let costCny = Number(event.cost_cny ?? 0);
    let triageLatencyMs = event.triage_latency_ms === null
      ? null
      : Number(event.triage_latency_ms);
    let triageResult = event.triageResult ?? null;
    try {
      const breaker = this.breakerReason();
      if (breaker) {
        this.store.retry(event.id, breaker, 60 * 60_000);
        log('warn', 'breaker deferred event', { eventId: event.id, breaker });
        return true;
      }

      const isDaily = this.isDailyEvent(event);
      const proactive = this.proactiveConfig();
      if (
        isDaily
        && isShanghaiSilentHour(Date.now(), proactive.silentStartHour, proactive.silentEndHour)
      ) {
        const silentResult = triageResult ?? {
          actionable: false,
          category: 'daily',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'Shanghai quiet hours 00:00–09:00',
        };
        this.store.finish(event.id, 'noop', {
          triageResult: silentResult,
          costCny,
          triageLatencyMs,
        });
        log('info', 'event suppressed by silent hours', { eventId: event.id });
        return true;
      }
      const initialDailyPolicy = isDaily ? this.dailyPolicy() : null;
      if (isDaily && (initialDailyPolicy.poolFull || initialDailyPolicy.gapBlocked)) {
        const fullResult = triageResult ?? {
          actionable: false,
          category: 'daily',
          priority: 1,
          suggestedRecipient: null,
          rationale: initialDailyPolicy.poolFull
            ? 'daily proactive pool exhausted for Shanghai day'
            : 'minimum daily proactive gap is still active',
        };
        this.store.finish(event.id, 'noop', {
          triageResult: fullResult,
          costCny,
          triageLatencyMs,
        });
        log('info', 'event suppressed by daily proactive policy', {
          eventId: event.id,
          limit: proactive.dailyDispatchLimit,
          reason: initialDailyPolicy.poolFull ? 'pool-full' : 'minimum-gap',
        });
        return true;
      }

      let contacts = null;
      if (!triageResult) {
        let backlogSummary = '';
        let triageOptions = {};
        if (isDaily) {
          contacts = await this.hub.contacts();
          triageOptions = {
            mode: 'daily',
            dailyRecipients: proactive.recipients,
            forceActionable: initialDailyPolicy.forceActionable,
            proactiveContext: await this.proactiveContext(contacts),
          };
        } else {
          backlogSummary = await this.backlog().catch((error) => {
            log('warn', 'backlog unavailable', { error: error.message });
            return '';
          });
        }
        const reviewed = await this.deepseek.triage(
          event,
          backlogSummary,
          triageOptions,
        );
        triageResult = reviewed.result;
        costCny += reviewed.costCny;
        triageLatencyMs = reviewed.latencyMs;
      }
      validateTriageMode(triageResult, {
        mode: isDaily ? 'daily' : 'task',
        dailyRecipients: proactive.recipients,
        forceActionable: isDaily && initialDailyPolicy.forceActionable,
      });
      if (!triageResult.actionable) {
        this.store.finish(event.id, 'noop', { triageResult, costCny, triageLatencyMs });
        log('info', 'event classified NO_OP', {
          eventId: event.id,
          category: triageResult.category,
          priority: triageResult.priority,
          costCny,
          triageLatencyMs,
        });
        return true;
      }

      const currentDailyPolicy = isDaily ? this.dailyPolicy() : null;
      if (isDaily && (currentDailyPolicy.poolFull || currentDailyPolicy.gapBlocked)) {
        this.store.finish(event.id, 'noop', {
          triageResult: {
            ...triageResult,
            actionable: false,
            rationale: `${triageResult.rationale} | ${
              currentDailyPolicy.poolFull ? 'daily pool full' : 'minimum gap active'
            }`,
          },
          costCny,
          triageLatencyMs,
        });
        log('info', 'actionable daily dropped by policy', {
          eventId: event.id,
          reason: currentDailyPolicy.poolFull ? 'pool-full' : 'minimum-gap',
        });
        return true;
      }

      contacts ??= await this.hub.contacts();
      const options = this.routeOptions(isDaily);
      let route = chooseRecipient({
        contacts,
        result: triageResult,
        ...options,
      });
      let fallbackUsed = triageResult.fallbackUsed === true;
      if (
        !route.contact
        && route.reason === 'no-route'
        && !fallbackUsed
        && this.config.routing?.fuzzyFallback !== false
      ) {
        const fallback = await this.deepseek.fuzzyRoute(event, triageResult, contacts, {
          allowedRecipientKeys: isDaily ? proactive.recipients : null,
        });
        costCny += fallback.costCny;
        fallbackUsed = true;
        triageResult = {
          ...triageResult,
          suggestedRecipient: fallback.result.suggestedRecipient,
        };
        route = chooseRecipient({
          contacts,
          result: triageResult,
          ...this.routeOptions(isDaily),
        });
      }
      const storedResult = { ...triageResult, fallbackUsed };

      if (!route.contact) {
        if (route.reason === 'all-candidates-busy' || route.reason === 'all-candidates-rate-limited') {
          this.store.retry(event.id, route.reason, 15 * 60_000, {
            triageResult: storedResult,
            costCny,
            triageLatencyMs,
          });
          log('info', 'event deferred by recipient policy', { eventId: event.id, reason: route.reason });
          return true;
        }
        if (this.vault.enabled) {
          await this.vault.park(event, storedResult, route.reason);
        }
        this.store.finish(event.id, 'parked', {
          triageResult: storedResult,
          error: route.reason,
          costCny,
          triageLatencyMs,
        });
        log('warn', 'event parked without route', { eventId: event.id, reason: route.reason });
        return true;
      }

      await this.hub.dispatch(
        route.contact.id,
        dispatchPrompt(event, storedResult, { daily: isDaily }),
      );
      this.store.recordDelivery(
        event.id,
        route.contact.id,
        Date.now(),
        isDaily ? DELIVERY_POOL_DAILY : DELIVERY_POOL_TASK,
      );
      this.store.finish(event.id, 'dispatched', {
        triageResult: storedResult,
        recipientId: route.contact.id,
        costCny,
        triageLatencyMs,
      });
      log('info', 'event dispatched', {
        eventId: event.id,
        recipientId: route.contact.id,
        category: storedResult.category,
        priority: storedResult.priority,
        pool: isDaily ? DELIVERY_POOL_DAILY : DELIVERY_POOL_TASK,
        fallbackUsed,
        costCny,
        triageLatencyMs,
      });
    } catch (error) {
      if (event.attempts >= this.config.maxAttempts) {
        if (this.vault.enabled && triageResult) {
          await this.vault.park(event, triageResult, `dead after ${event.attempts} attempts: ${error.message}`)
            .catch(() => {});
        }
        this.store.finish(event.id, 'dead', {
          triageResult,
          error: error.message,
          costCny,
          triageLatencyMs,
        });
        log('error', 'event exhausted retries', { eventId: event.id, error: error.message });
      } else {
        this.store.retry(event.id, error.message, retryDelay(event.attempts), {
          triageResult,
          costCny,
          triageLatencyMs,
        });
        log('warn', 'event scheduled for retry', {
          eventId: event.id,
          attempt: event.attempts,
          error: error.message,
        });
      }
    }
    return true;
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
      if (source.type === 'timer') {
        const { intervalMs } = timerSchedule(source);
        const daily = isDailyMode(source);
        const emit = () => {
          const now = Date.now();
          if (daily) {
            const proactive = this.proactiveConfig();
            if (!proactive.enabled) return;
            if (isShanghaiSilentHour(now, proactive.silentStartHour, proactive.silentEndHour)) {
              log('info', 'daily timer skipped: silent hours', { source: source.id });
              return;
            }
            const policy = this.dailyPolicy(now);
            if (policy.poolFull || policy.gapBlocked) {
              log('info', 'daily timer skipped by proactive policy', {
                source: source.id,
                reason: policy.poolFull ? 'pool-full' : 'minimum-gap',
              });
              return;
            }
          }
          const policy = daily ? this.dailyPolicy(now) : null;
          this.enqueue({
            source: source.id,
            categoryHint: source.category ?? (daily ? 'daily' : 'system'),
            dedupeKey: `${source.id}:${Math.floor(now / intervalMs)}`,
            summary: daily
              ? buildDailyCheckSummary({
                ...source,
                recipients: this.proactiveConfig().recipients,
              }, now, {
                proactive: this.proactiveConfig(),
                forceActionable: policy.forceActionable,
              })
              : (source.summary ?? `Scheduled wake from ${source.id}`),
            payload: {
              ...(source.payload && typeof source.payload === 'object' ? source.payload : {}),
              mode: daily ? 'daily' : 'task',
              emittedAt: now,
            },
          });
        };
        if (once) {
          emit();
        } else {
          const slot = this.timers.push(null) - 1;
          const schedule = (first) => {
            if (this.stopping) return;
            this.timers[slot] = setTimeout(() => {
              emit();
              schedule(false);
            }, nextTimerDelay(source, { first }));
          };
          schedule(true);
        }
      } else if (source.type === 'file') {
        if (once) continue;
        const watcher = fs.watch(path.resolve(source.path), { recursive: source.recursive === true }, (eventType, filename) => {
          const relative = String(filename ?? '');
          const key = `${source.id}:${eventType}:${relative}:${Math.floor(Date.now() / 1000)}`;
          this.enqueue({
            source: source.id,
            categoryHint: source.category ?? 'file-change',
            dedupeKey: key,
            summary: `File event ${eventType}: ${relative || source.path}`,
            payload: { path: source.path, filename: relative, eventType },
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
    if (once) await new Promise((resolve) => setImmediate(resolve));
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

  async run() {
    const recovered = this.store.recoverStale(this.config.claimTimeoutMs);
    if (recovered) log('warn', 'recovered stale events', { count: recovered });
    if (metricsOnly) {
      process.stdout.write(`${JSON.stringify(this.store.dailySummary(), null, 2)}\n`);
      return;
    }
    await this.startSources();
    this.startWebhook();
    do {
      const worked = await this.processOne();
      if (once && !worked) break;
      if (!worked) await sleep(this.config.pollMs);
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
    this.store.close();
  }
}

const config = loadConfig();
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
