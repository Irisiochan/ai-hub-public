import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  buildDispatchableTaskContext,
  buildDailyCheckSummary,
  buildIdeaDiaryRequest,
  buildTaskReminders,
  classifyOutcomeMessage,
  chooseRecipient,
  coordinationPolicyState,
  dailyPolicyState,
  DEFAULT_CATEGORIES,
  DELIVERY_POOL_DAILY,
  DELIVERY_POOL_DIARY,
  DELIVERY_POOL_COORDINATION,
  DELIVERY_POOL_IDEA,
  DELIVERY_POOL_TASK,
  EXECUTED_VIA_CONTACT,
  EXECUTED_VIA_NONE,
  EXECUTED_VIA_WORKER,
  ideaPolicyState,
  formatCoordinationDispatchBlock,
  formatTaskReminderRoomNotice,
  formatVerificationDispatchBlock,
  isDailyMode,
  isDiaryMode,
  isIdeaMode,
  isShanghaiSilentHour,
  isTaskCompletionMessage,
  isTaskReminderMode,
  linkedReworkTail,
  nextTimerDelay,
  nextWallClockDelay,
  planBacklogSweep,
  normalizeBacklogSweepConfig,
  normalizeCoordinationConfig,
  normalizeDiaryConfig,
  normalizeIdeaConfig,
  normalizeOutcomeConfig,
  normalizeProactiveConfig,
  normalizeTaskReminderConfig,
  OUTCOME_LABEL_ACCEPTED,
  OUTCOME_LABEL_ENGAGED,
  OUTCOME_LABEL_REJECTED,
  OUTCOME_LABEL_REWORKED,
  shanghaiClock,
  parseCoordinationTask,
  parseVerificationTask,
  shanghaiDayStart,
  shanghaiDateAt,
  summarizeTaskContext,
  taskReminderRoomRoute,
  timerSchedule,
  TriageStore,
  validateTriageMode,
} from './triage-core.mjs';
import { rollupDay } from './diary-rollup.mjs';
import {
  claimDateEventKey,
  filterUnclaimedDateEvents,
  formatDailyDispatchDateBlock,
  matchDateEvents,
  parseDateFacts,
} from './date-events.mjs';
import {
  buildFollowupDispatchSummary,
  evaluateFollowupGate,
  FOLLOWUP_SOURCE,
  FOLLOWUP_STATUS_CANCELLED,
  FOLLOWUP_STATUS_DISPATCHED,
  FOLLOWUP_STATUS_EXPIRED,
  FOLLOWUP_STATUS_PENDING,
  FOLLOWUP_STATUS_QUEUED,
  formatFollowupDispatchBlock,
  formatFollowupFallbackBlock,
  isUserMessage,
  matchesAbsenceKeyword,
  messageNumericId,
  normalizeAbsenceExtract,
  normalizeFollowupConfig,
} from './followups.mjs';
import { DeepSeekClient, HubClient, VaultClient } from './triage-clients.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(process.argv.find((arg) => !arg.startsWith('--') && arg !== process.argv[0] && arg !== process.argv[1])
  ?? path.join(scriptDir, 'triage.config.json'));
const reminderShadow = process.argv.includes('--reminder-shadow');
const reminderOnce = process.argv.includes('--task-reminders');
const once = process.argv.includes('--once') || reminderShadow;
const metricsOnly = process.argv.includes('--metrics');
/** 手动扫一次待拆分需求：`node triage-worker.mjs --once --sweep` */
const sweepOnce = process.argv.includes('--sweep');

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

function dispatchPrompt(event, result, {
  daily = false,
  reminder = false,
  todayDateEvents = [],
  followup = null,
  fallbackFollowups = [],
} = {}) {
  if (reminder) {
    return [
      '这是一次已通过确定性截止日期检查的任务提醒。',
      '请直接用你自己的自然语气把提醒告诉 User；不要提及 triage、路由、定时器、后台扫描或系统事件。',
      '只保留三项：一句结论、一个下一步、是否需要 User 操作。不要扩写背景，不要连续追问。',
      '',
      event.summary.slice(0, 3000),
    ].join('\n');
  }
  if (daily) {
    const dateBlock = formatDailyDispatchDateBlock(todayDateEvents);
    const followupBlock = formatFollowupDispatchBlock(followup);
    const fallbackBlock = formatFollowupFallbackBlock(fallbackFollowups);
    return [
      '这是一次已经通过 daily triage 的主动陪伴机会。',
      '请现在直接用你自己的自然语气对 User 说一条简短消息。',
      '不要提及 triage、路由、系统事件、后台判断或 NO_OP；不要复述本指令。',
      '除非上下文里确有具体待办，否则不要登记任务或写长期记忆。',
      // Date-events must land in THIS prompt: the companion never sees L1 proactiveContext.
      ...(dateBlock ? [dateBlock] : []),
      ...(followupBlock ? [followupBlock] : []),
      ...(fallbackBlock ? [fallbackBlock] : []),
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
    result.taskPath ? `账本任务：${result.taskPath}（本次派单已登记接管，禁止再次派同一路径）` : '',
    '',
    '真实事件上下文：',
    event.summary.slice(0, 16_000),
    '',
    '最终回复第一行必须是路由标记：[AI_HUB_NOTIFY] {"kind":"...","key":"..."}。',
    'kind 只允许 no_op、state_change、due_escalation、failure、delivery_block、user_decision；key 必须描述稳定的“对象:状态”，同一状态重复使用同一 key，实质变化后才换 key。',
    '只有 state_change、due_escalation、failure、delivery_block、user_decision 会通知主聊天；no_op 会保留后台审计但不打扰 User。',
    '请只按下面三种路径选一种，不要扩写成第四种：',
    '1. NO_OP：当前不需要任何动作，kind=no_op，标记后简短说明即可。',
    '2. 登记观察：仅记录 User 当时可直接确认的现象、复现路径、原话与时间；用 memory_vault write_inbox 写入 inbox/，source 必须是 frontend-observation。不要创建或更新 tasks/。猜测只能标成“未验证假设”，并写明本机需独立核查。',
    '3. delegate_to_worker：凡是需要读取真实仓库/文件状态、运行测试或 shell、修改代码/文件、构建或部署的，一律调用 delegate_to_worker 转给本机。只传目标、约束和可判定验收标准，不要只凭聊天上下文猜根因、方案、文件或行号。',
    result.needsLocalExec
      ? '本事件 needsLocalExec=true，只能走 delegate_to_worker；不得由前端联系人就地执行或改记成 task。'
      : '本事件 needsLocalExec=false；若只是可确认的前端现象，优先登记观察，不要把观察升级成任务。',
  ].filter((line) => line !== '').join('\n');
}

const BACKLOG_CLAIMS_KEY = 'backlog-dispatch-claims:v1';
const DATE_EVENT_CLAIMS_KEY = 'date-event-claims:v1';
const COORDINATION_SOURCE = 'coordination-sweep';
const COORDINATION_STATE_KEY = 'coordination:v1';
const VERIFICATION_MODE = 'coordination-verification';

function verificationStateKey(task) {
  return `verification:v1:${task.taskPath}:${task.due}`;
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
    this.nextOutcomePollAt = 0;
    this.nextFollowupPollAt = 0;
    this.nextCoordinationPollAt = 0;
    /** @type {Promise<unknown>[]} */
    this.pendingSourceJobs = [];
  }

  coordinationConfig() {
    return this.config.coordination ?? normalizeCoordinationConfig({});
  }

  isCoordinationEvent(event) {
    return event?.source === COORDINATION_SOURCE
      || event?.payload?.mode === 'coordination';
  }

  followupConfig() {
    return this.config.followups ?? normalizeFollowupConfig({});
  }

  followupFallbacks(now = Date.now()) {
    if (!this.followupConfig().enabled) return [];
    const since = shanghaiDayStart(now) - 24 * 60 * 60_000;
    return this.store.expiredFollowupsForFallback({ since, limit: 1 }).map((followup) => ({
      id: followup.id,
      activity: followup.activity,
      returnCommitment: followup.return_commitment ?? '',
      contactId: followup.contact_id,
      recipientKey: followup.recipient_key,
    }));
  }

  isFollowupEvent(event) {
    return event?.source === FOLLOWUP_SOURCE
      || event?.payload?.mode === 'followup'
      || Boolean(event?.payload?.followupId);
  }

  followupScanCursors() {
    try {
      const parsed = JSON.parse(this.store.getSourceState('followup-scan-cursors:v1') ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  saveFollowupScanCursors(cursors) {
    this.store.setSourceState('followup-scan-cursors:v1', JSON.stringify(cursors));
  }

  async scanAbsenceFollowups(now = Date.now()) {
    const config = this.followupConfig();
    if (!config.enabled || !this.hub.baseUrl) return { scanned: 0, created: 0 };
    let contacts;
    try {
      contacts = await this.hub.contacts();
    } catch (error) {
      log('warn', 'followup contact list unavailable', { error: error.message });
      return { scanned: 0, created: 0 };
    }
    const dms = (Array.isArray(contacts) ? contacts : [])
      .filter((contact) => contact?.kind === 'dm' || contact?.kind === 'api')
      .filter((contact) => contact?.config?.routing?.enabled !== false);
    const cursors = this.followupScanCursors();
    let scanned = 0;
    let created = 0;

    for (const contact of dms) {
      if (this.store.hasOpenFollowupForContact(contact.id)) continue;
      const after = Number(cursors[contact.id] ?? 0);
      let messages = [];
      try {
        messages = await this.hub.messages(contact.id, after, config.scanLimit, 'all');
      } catch (error) {
        log('warn', 'followup message scan failed', {
          contactId: contact.id,
          error: error.message,
        });
        continue;
      }
      if (!messages.length) continue;
      scanned += messages.length;
      let maxId = after;
      for (const message of messages) {
        const mid = messageNumericId(message);
        if (mid !== null && mid > maxId) maxId = mid;
        if (!isUserMessage(message)) continue;
        if (!matchesAbsenceKeyword(message.content)) continue;
        if (mid === null) continue;
        if (this.store.hasOpenFollowupForContact(contact.id)) break;

        let extract;
        try {
          extract = await this.deepseek.extractTemporaryAbsence(message.content);
        } catch (error) {
          log('warn', 'followup extract failed', {
            contactId: contact.id,
            messageId: mid,
            error: error.message,
          });
          continue;
        }
        const absence = normalizeAbsenceExtract(extract.result, config);
        if (!absence) continue;

        const followupId = hash(`followup:${contact.id}:${mid}`);
        const dueAt = now + absence.expectedMinutes * 60_000;
        const recipientKey = contact.config?.routing?.recipientKey ?? contact.id;
        const inserted = this.store.insertFollowup({
          id: followupId,
          contactId: contact.id,
          messageId: mid,
          activity: absence.activity,
          returnCommitment: absence.returnCommitment,
          expectedMinutes: absence.expectedMinutes,
          dueAt,
          recipientKey,
          now,
        });
        if (inserted) {
          created += 1;
          log('info', 'followup scheduled', {
            followupId,
            contactId: contact.id,
            messageId: mid,
            activity: absence.activity,
            returnCommitment: absence.returnCommitment,
            expectedMinutes: absence.expectedMinutes,
            dueAt: new Date(dueAt).toISOString(),
            extractCostCny: extract.costCny,
          });
        }
      }
      if (maxId > after) cursors[contact.id] = maxId;
    }
    this.saveFollowupScanCursors(cursors);
    return { scanned, created };
  }

  async processFollowupsIfDue(now = Date.now()) {
    const config = this.followupConfig();
    if (!config.enabled) return false;
    // Share the outcomes interval (default 5 min) to avoid a second timer chain.
    const intervalMs = (this.config.outcomes?.intervalMinutes ?? 5) * 60_000;
    if (now < this.nextFollowupPollAt) return false;
    this.nextFollowupPollAt = now + intervalMs;

    const scan = await this.scanAbsenceFollowups(now);
    if (scan.created || scan.scanned) {
      log('info', 'followup scan complete', scan);
    }

    const pending = this.store.pendingFollowups({ limit: 50 });
    if (!pending.length) return scan.created > 0;

    const proactive = this.proactiveConfig();
    const silent = isShanghaiSilentHour(now, proactive.silentStartHour, proactive.silentEndHour);
    let acted = false;

    for (const followup of pending) {
      let userMessagesAfter = [];
      try {
        const rows = await this.hub.messages(
          followup.contact_id,
          followup.message_id,
          config.scanLimit,
          'all',
        );
        userMessagesAfter = rows.filter((message) => {
          const mid = messageNumericId(message);
          if (mid !== null && mid <= followup.message_id) return false;
          return isUserMessage(message);
        });
      } catch (error) {
        log('warn', 'followup cancel-check messages failed', {
          followupId: followup.id,
          error: error.message,
        });
        continue;
      }

      const proactiveDeliveredAfter = this.store.hasDailyDeliverySince(
        followup.contact_id,
        followup.created_at,
        now,
      );
      // Followups clear only the minimum gap (like date-events); hard pool + silent still apply.
      const policy = this.dailyPolicy(now, { hasTodayDateEvent: true });
      const poolBlocked = policy.poolFull;

      const gate = evaluateFollowupGate(followup, {
        now,
        userMessagesAfter,
        proactiveDeliveredAfter,
        expireAfterMinutes: config.expireAfterMinutes,
        silent,
        poolBlocked,
      });

      if (gate.action === 'cancel') {
        this.store.updateFollowupStatus(followup.id, FOLLOWUP_STATUS_CANCELLED, {
          cancelReason: gate.reason,
          now,
        });
        log('info', 'followup cancelled', { followupId: followup.id, reason: gate.reason });
        acted = true;
        continue;
      }
      if (gate.action === 'expire') {
        this.store.updateFollowupStatus(followup.id, FOLLOWUP_STATUS_EXPIRED, {
          cancelReason: gate.reason,
          now,
        });
        log('info', 'followup expired', { followupId: followup.id, reason: gate.reason });
        acted = true;
        continue;
      }
      if (gate.action !== 'fire') continue;

      const queued = this.enqueue({
        source: FOLLOWUP_SOURCE,
        categoryHint: 'daily',
        summary: buildFollowupDispatchSummary(followup),
        dedupeKey: `followup:${followup.id}`,
        payload: {
          mode: 'daily',
          followupId: followup.id,
          activity: followup.activity,
          returnCommitment: followup.return_commitment,
          contactId: followup.contact_id,
          recipientKey: followup.recipient_key,
          forceActionable: true,
        },
      });
      this.store.updateFollowupStatus(followup.id, FOLLOWUP_STATUS_QUEUED, {
        eventId: queued.id,
        now,
      });
      log('info', 'followup queued for dispatch', {
        followupId: followup.id,
        eventId: queued.id,
        activity: followup.activity,
      });
      acted = true;
    }
    return acted || scan.created > 0;
  }

  coordinationState() {
    try {
      const parsed = JSON.parse(this.store.getSourceState(COORDINATION_STATE_KEY) ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  saveCoordinationState(state) {
    this.store.setSourceState(COORDINATION_STATE_KEY, JSON.stringify(state));
  }

  coordinationPlans() {
    const config = this.coordinationConfig();
    if (!fs.existsSync(config.tasksDir)) return [];
    return fs.readdirSync(config.tasksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const taskPath = `tasks/${entry.name}`;
        try {
          return parseCoordinationTask(
            fs.readFileSync(path.join(config.tasksDir, entry.name), 'utf8'),
            { taskPath },
          );
        } catch (error) {
          log('warn', 'coordination task read failed', { taskPath, error: error.message });
          return null;
        }
      })
      .filter(Boolean);
  }

  verificationTasks() {
    const config = this.coordinationConfig();
    if (!fs.existsSync(config.tasksDir)) return [];
    return fs.readdirSync(config.tasksDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const taskPath = `tasks/${entry.name}`;
        try {
          return parseVerificationTask(
            fs.readFileSync(path.join(config.tasksDir, entry.name), 'utf8'),
            { taskPath },
          );
        } catch (error) {
          log('warn', 'verification task read failed', { taskPath, error: error.message });
          return null;
        }
      })
      .filter(Boolean);
  }

  coordinationPolicy(now = Date.now()) {
    return coordinationPolicyState(
      this.coordinationConfig(),
      this.store.poolUsage(DELIVERY_POOL_COORDINATION, now),
    );
  }

  scanCoordinationIfDue(now = Date.now()) {
    const config = this.coordinationConfig();
    if (!config.enabled) return false;
    const intervalMs = config.scanIntervalMinutes * 60_000;
    if (now < this.nextCoordinationPollAt) return false;
    this.nextCoordinationPollAt = now + intervalMs;
    const proactive = this.proactiveConfig();
    if (isShanghaiSilentHour(now, proactive.silentStartHour, proactive.silentEndHour)) {
      log('info', 'coordination sweep skipped: silent hours');
      return false;
    }
    const policy = this.coordinationPolicy(now);
    if (policy.poolFull) return false;
    const state = this.coordinationState();
    const plans = this.coordinationPlans()
      .filter((task) => state[task.taskPath] !== task.planHash)
      .slice(0, policy.remaining);
    for (const task of plans) {
      this.enqueue({
        source: COORDINATION_SOURCE,
        categoryHint: 'coordination',
        summary: `Plan-ready coordination dispatch: ${task.taskPath} (${task.planHash.slice(0, 12)})`,
        dedupeKey: `coordination:${task.taskPath}:${task.planHash}`,
        payload: { mode: 'coordination', task },
      });
    }
    const verificationRemaining = Math.max(0, policy.remaining - plans.length);
    const today = shanghaiDateAt(now);
    const verifications = this.verificationTasks()
      .filter((task) => task.due <= today && !this.store.getSourceState(verificationStateKey(task)))
      .slice(0, verificationRemaining);
    for (const task of verifications) {
      const stateKey = verificationStateKey(task);
      this.enqueue({
        source: COORDINATION_SOURCE,
        categoryHint: 'coordination',
        summary: `Due verification coordination dispatch: ${task.taskPath} (${task.due})`,
        dedupeKey: stateKey,
        payload: { mode: VERIFICATION_MODE, task },
      });
    }
    if (plans.length || verifications.length) {
      log('info', 'coordination tasks queued', {
        executionCount: plans.length,
        verificationCount: verifications.length,
        taskPaths: [...plans, ...verifications].map((task) => task.taskPath),
      });
    }
    return plans.length + verifications.length > 0;
  }

  async processCoordination(event) {
    if (event.payload?.mode === VERIFICATION_MODE) {
      await this.processVerification(event);
      return;
    }
    const config = this.coordinationConfig();
    const task = event.payload?.task;
    const validTask = task
      && typeof task.taskPath === 'string'
      && typeof task.planHash === 'string'
      && typeof task.executor === 'string'
      && typeof task.workspace === 'string'
      && typeof task.branch === 'string';
    if (!config.enabled || !config.roomId || !validTask) {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'coordination',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'coordination config or task payload is no longer valid',
        },
      });
      return;
    }
    const state = this.coordinationState();
    if (state[task.taskPath] === task.planHash) {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'coordination',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'same Plan hash already dispatched',
        },
      });
      return;
    }
    const proactive = this.proactiveConfig();
    if (isShanghaiSilentHour(Date.now(), proactive.silentStartHour, proactive.silentEndHour)) {
      this.store.retry(event.id, 'coordination silent hours', 60 * 60_000);
      return;
    }
    if (this.coordinationPolicy().poolFull) {
      this.store.retry(event.id, 'coordination daily pool full', 60 * 60_000);
      return;
    }
    const dispatched = await this.hub.dispatchRoomHost(config.roomId, {
      content: formatCoordinationDispatchBlock(task),
      hostName: config.hostName,
      targetIds: [task.executor],
      reactionRounds: 0,
      idempotencyKey: `coordination:${task.taskPath}:${task.planHash}`,
      coordination: {
        kind: 'execution',
        taskPath: task.taskPath,
        branch: task.branch,
        workspace: task.workspace,
        planHash: task.planHash,
        executor: task.executor,
      },
    });
    state[task.taskPath] = task.planHash;
    this.saveCoordinationState(state);
    this.store.recordDelivery(event.id, config.roomId, Date.now(), DELIVERY_POOL_COORDINATION, {
      messageId: dispatched?.messageId,
      taskPath: task.taskPath,
      executedVia: EXECUTED_VIA_CONTACT,
    });
    this.store.finish(event.id, 'dispatched', {
      triageResult: {
        actionable: true,
        needsLocalExec: true,
        category: 'coordination',
        priority: 2,
        suggestedRecipient: task.executor,
        rationale: `Plan hash dispatched to @${task.executor}`,
        taskPath: task.taskPath,
      },
      recipientId: task.executor,
    });
    log('info', 'coordination plan dispatched', {
      eventId: event.id,
      taskPath: task.taskPath,
      planHash: task.planHash,
      executor: task.executor,
      pool: DELIVERY_POOL_COORDINATION,
    });
  }

  async processVerification(event) {
    const config = this.coordinationConfig();
    const task = event.payload?.task;
    const validTask = task
      && typeof task.taskPath === 'string'
      && typeof task.title === 'string'
      && typeof task.verifier === 'string'
      && typeof task.due === 'string'
      && task.due <= shanghaiDateAt();
    if (!config.enabled || !config.roomId || !validTask) {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'coordination',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'verification config or task payload is no longer valid or due',
        },
      });
      return;
    }
    const stateKey = verificationStateKey(task);
    if (this.store.getSourceState(stateKey)) {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          needsLocalExec: false,
          category: 'coordination',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'same task due date already dispatched for verification',
        },
      });
      return;
    }
    const proactive = this.proactiveConfig();
    if (isShanghaiSilentHour(Date.now(), proactive.silentStartHour, proactive.silentEndHour)) {
      this.store.retry(event.id, 'coordination silent hours', 60 * 60_000);
      return;
    }
    if (this.coordinationPolicy().poolFull) {
      this.store.retry(event.id, 'coordination daily pool full', 60 * 60_000);
      return;
    }
    const dispatched = await this.hub.dispatchRoomHost(config.roomId, {
      content: formatVerificationDispatchBlock(task),
      hostName: config.hostName,
      targetIds: [task.verifier],
      reactionRounds: 0,
      idempotencyKey: stateKey,
      coordination: {
        kind: 'verification',
        taskPath: task.taskPath,
        due: task.due,
        verifier: task.verifier,
      },
    });
    this.store.setSourceState(stateKey, JSON.stringify({
      taskPath: task.taskPath,
      due: task.due,
      verifier: task.verifier,
      dispatchedAt: Date.now(),
    }));
    this.store.recordDelivery(event.id, config.roomId, Date.now(), DELIVERY_POOL_COORDINATION, {
      messageId: dispatched?.messageId,
      taskPath: task.taskPath,
      executedVia: EXECUTED_VIA_CONTACT,
    });
    this.store.finish(event.id, 'dispatched', {
      triageResult: {
        actionable: true,
        needsLocalExec: false,
        category: 'coordination',
        priority: 2,
        suggestedRecipient: task.verifier,
        rationale: `Due verification dispatched to @${task.verifier}`,
        taskPath: task.taskPath,
      },
      recipientId: task.verifier,
    });
    log('info', 'coordination verification dispatched', {
      eventId: event.id,
      taskPath: task.taskPath,
      due: task.due,
      verifier: task.verifier,
      pool: DELIVERY_POOL_COORDINATION,
    });
  }

  dateEventClaims() {
    try {
      const parsed = JSON.parse(this.store.getSourceState(DATE_EVENT_CLAIMS_KEY) ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  saveDateEventClaims(claims) {
    this.store.setSourceState(DATE_EVENT_CLAIMS_KEY, JSON.stringify(claims));
  }

  claimDateEvents(events, { eventId = null, now = Date.now() } = {}) {
    const shanghaiDate = shanghaiClock(now).date;
    const claims = this.dateEventClaims();
    let changed = false;
    for (const event of Array.isArray(events) ? events : []) {
      if (!event?.key) continue;
      const key = claimDateEventKey(event.key, shanghaiDate);
      if (claims[key]) continue;
      claims[key] = { claimedAt: now, eventId, matchDate: shanghaiDate, label: event.label ?? null };
      changed = true;
    }
    // Drop claims older than 40 days to keep the map small (yearly events only need one day).
    const cutoff = now - 40 * 24 * 60 * 60_000;
    for (const [key, value] of Object.entries(claims)) {
      if (!value || typeof value.claimedAt !== 'number' || value.claimedAt < cutoff) {
        delete claims[key];
        changed = true;
      }
    }
    if (changed) this.saveDateEventClaims(claims);
    return claims;
  }

  async loadMatchedDateEvents(now = Date.now()) {
    const empty = { today: [], upcoming: [], unclaimedToday: [] };
    if (!this.vault.enabled) return empty;
    try {
      const text = await this.vault.facts();
      const matched = matchDateEvents(parseDateFacts(text), now, { upcomingDays: 3 });
      const shanghaiDate = shanghaiClock(now).date;
      const unclaimedToday = filterUnclaimedDateEvents(
        matched.today,
        this.dateEventClaims(),
        shanghaiDate,
      );
      return {
        today: matched.today,
        upcoming: matched.upcoming,
        unclaimedToday,
      };
    } catch (error) {
      log('warn', 'date-event facts unavailable', { error: error.message });
      return empty;
    }
  }

  enqueue(event) {
    const result = this.store.enqueue(event);
    if (result.inserted) log('info', 'event queued', { eventId: result.id, source: event.source });
    return result;
  }

  isBacklogSweep(event) {
    return event?.category_hint === 'backlog' || event?.categoryHint === 'backlog';
  }

  backlogClaims() {
    try {
      const parsed = JSON.parse(this.store.getSourceState(BACKLOG_CLAIMS_KEY) ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  saveBacklogClaims(claims) {
    this.store.setSourceState(BACKLOG_CLAIMS_KEY, JSON.stringify(claims));
  }

  async dispatchableBacklog() {
    if (!this.vault.enabled) {
      return { summary: '', taskPaths: [], allTaskPaths: [], ignored: [] };
    }
    const raw = await this.vault.taskContext();
    const claims = this.backlogClaims();
    const snapshot = buildDispatchableTaskContext(raw, {
      claimedTaskPaths: Object.keys(claims),
      maxChars: Math.max(500, Number(this.deepseek.backlogMaxChars ?? 4000)),
    });
    const open = new Set(snapshot.allTaskPaths);
    const pruned = Object.fromEntries(Object.entries(claims).filter(([taskPath]) => open.has(taskPath)));
    if (JSON.stringify(pruned) !== JSON.stringify(claims)) this.saveBacklogClaims(pruned);
    return snapshot;
  }

  async collectOutcomesIfDue(now = Date.now()) {
    const config = this.config.outcomes;
    if (!config?.enabled || now < this.nextOutcomePollAt) return false;
    this.nextOutcomePollAt = now + config.intervalMinutes * 60_000;
    const candidates = this.store.outcomeCandidates({
      since: now - config.maxAgeDays * 24 * 60 * 60_000,
      limit: config.batchSize,
    });
    if (!candidates.length) return false;

    const taskCandidates = candidates.filter((candidate) => candidate.triageResult?.taskPath);
    let openTaskPaths = null;
    let tailBodies = [];
    if (taskCandidates.length && this.vault.enabled) {
      try {
        const raw = await this.vault.taskContext();
        const snapshot = buildDispatchableTaskContext(raw, { maxChars: 500, maxItems: 1 });
        openTaskPaths = new Set(snapshot.allTaskPaths);
        const tailPaths = snapshot.allTaskPaths.filter(
          (taskPath) => /^tasks\/(?:worker-tail-|deploy-)/i.test(taskPath),
        );
        const results = await Promise.allSettled(tailPaths.map(async (taskPath) => ({
          taskPath,
          content: await this.vault.readFile(taskPath),
        })));
        tailBodies = results
          .filter((result) => result.status === 'fulfilled')
          .map((result) => result.value);
      } catch (error) {
        log('warn', 'outcome task evidence unavailable', { error: error.message });
      }
    }

    for (const candidate of candidates) {
      try {
        const priorEvidence = candidate.evidence && typeof candidate.evidence === 'object'
          ? candidate.evidence
          : {};
        const cursor = Number(priorEvidence.cursorMessageId ?? candidate.message_id);
        const messages = await this.hub.messages(candidate.recipient_id, cursor, 200, 'all');
        const classified = messages
          .map((message) => ({ message, label: classifyOutcomeMessage(message) }))
          .filter((item) => item.label);
        const reply = classified.find((item) => item.label === OUTCOME_LABEL_REJECTED)
          ?? classified[0]
          ?? null;
        const taskPath = candidate.triageResult?.taskPath;
        const completion = taskPath
          ? messages.find((message) => isTaskCompletionMessage(message, taskPath)) ?? null
          : null;
        const nextCursor = messages.reduce(
          (max, message) => Math.max(max, Number(message.id) || 0),
          cursor,
        );
        const messageEvidence = {
          ...priorEvidence,
          cursorMessageId: nextCursor,
          ...(reply ? {
            replyMessageId: Number(reply.message.id),
            replyCreatedAt: reply.message.created_at ?? null,
            replyRule: reply.label === OUTCOME_LABEL_REJECTED
              ? 'explicit-rejection'
              : 'manual-user-reply',
          } : {}),
        };
        if (reply) {
          const replyLabel = reply.label === OUTCOME_LABEL_REJECTED
            ? OUTCOME_LABEL_REJECTED
            : OUTCOME_LABEL_ENGAGED;
          this.store.recordOutcome(
            candidate.delivery_id,
            replyLabel,
            messageEvidence,
            now,
          );
          if (replyLabel === OUTCOME_LABEL_REJECTED) {
            this.releaseBacklogClaim(taskPath, candidate.event_id);
          }
        } else if (nextCursor !== cursor) {
          this.store.recordOutcome(candidate.delivery_id, candidate.label, messageEvidence, now);
        }

        if (!taskPath || !openTaskPaths) continue;
        const tail = linkedReworkTail(taskPath, candidate.event_id, tailBodies);
        if (tail) {
          this.store.recordOutcome(candidate.delivery_id, OUTCOME_LABEL_REWORKED, {
            ...messageEvidence,
            taskPath,
            tailPath: tail.taskPath,
            taskRule: 'linked-tail',
          }, now);
          this.releaseBacklogClaim(taskPath, candidate.event_id);
        } else if (!openTaskPaths.has(taskPath) && completion) {
          this.store.recordOutcome(candidate.delivery_id, OUTCOME_LABEL_ACCEPTED, {
            ...messageEvidence,
            taskPath,
            completionMessageId: Number(completion.id),
            taskRule: 'done-tool-result-and-left-open-context',
          }, now);
        }
      } catch (error) {
        log('warn', 'outcome collection failed', {
          eventId: candidate.event_id,
          deliveryId: candidate.delivery_id,
          error: error.message,
        });
      }
    }
    return true;
  }

  claimBacklogTask(taskPath, eventId) {
    if (!taskPath) return;
    const claims = this.backlogClaims();
    claims[taskPath] = { eventId, claimedAt: Date.now() };
    this.saveBacklogClaims(claims);
  }

  releaseBacklogClaim(taskPath, eventId) {
    if (!taskPath) return false;
    const claims = this.backlogClaims();
    const claim = claims[taskPath];
    if (!claim || (eventId && claim.eventId !== eventId)) return false;
    delete claims[taskPath];
    this.saveBacklogClaims(claims);
    return true;
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

  isIdeaEvent(event) {
    return isIdeaMode(event);
  }

  isDiaryEvent(event) {
    return isDiaryMode(event);
  }

  diaryConfig() {
    return this.config.diary ?? normalizeDiaryConfig({});
  }

  backlogSweepConfig() {
    return this.config.backlogSweep ?? normalizeBacklogSweepConfig({});
  }

  taskReminderConfig() {
    return this.config.taskReminders ?? normalizeTaskReminderConfig({}, this.proactiveConfig());
  }

  isTaskReminder(event) {
    return isTaskReminderMode(event);
  }

  taskReminderRoute(reminder) {
    const coordination = this.coordinationConfig();
    if (!coordination.enabled || !coordination.roomId) {
      return { route: 'main', executor: '', verifier: '', tags: [], reason: 'coordination-unavailable' };
    }
    const taskPath = String(reminder?.taskPath ?? '').replaceAll('\\', '/');
    const fileName = path.posix.basename(taskPath);
    if (!/^tasks\/[^/]+\.md$/i.test(taskPath) || !fileName) {
      return { route: 'main', executor: '', verifier: '', tags: [], reason: 'invalid-task-path' };
    }
    try {
      return {
        ...taskReminderRoomRoute(
          fs.readFileSync(path.join(coordination.tasksDir, fileName), 'utf8'),
          { roomTags: coordination.reminderRoomTags },
        ),
        reason: 'task-frontmatter',
      };
    } catch (error) {
      log('warn', 'task reminder route read failed; falling back to main', {
        taskPath,
        error: error.message,
      });
      return { route: 'main', executor: '', verifier: '', tags: [], reason: 'task-read-failed' };
    }
  }

  async scanTaskReminders({ shadow = false } = {}) {
    const config = this.taskReminderConfig();
    if (!config.enabled && !shadow) return { reason: 'disabled', reminders: [] };
    if (!this.vault.enabled) return { reason: 'vault-disabled', reminders: [] };
    const now = Date.now();
    const proactive = this.proactiveConfig();
    if (isShanghaiSilentHour(now, proactive.silentStartHour, proactive.silentEndHour)) {
      log('info', 'task reminder scan skipped: silent hours');
      return { reason: 'silent-hours', reminders: [] };
    }
    const snapshot = await this.vault.taskContext();
    const reminders = buildTaskReminders(snapshot);
    let queued = 0;
    let verificationSkipped = 0;
    for (const reminder of reminders) {
      if (shadow) continue;
      const route = this.taskReminderRoute(reminder);
      if (
        reminder.stage === 'due-today'
        && route.verifier
        && this.store.getSourceState(`verification:v1:${reminder.taskPath}:${reminder.dueDate}`)
      ) {
        verificationSkipped += 1;
        log('info', 'task reminder skipped after same-day verification dispatch', {
          taskPath: reminder.taskPath,
          dueDate: reminder.dueDate,
          verifier: route.verifier,
        });
        continue;
      }
      const result = this.enqueue({
        source: 'task-reminder',
        categoryHint: 'task-reminder',
        dedupeKey: reminder.reminderKey,
        summary: reminder.summary,
        payload: {
          mode: 'task-reminder',
          ...reminder,
          reminderRoute: route.route,
          emittedAt: now,
        },
      });
      if (result.inserted) queued += 1;
    }
    log('info', shadow ? 'task reminder shadow complete' : 'task reminder scan complete', {
      candidates: reminders.length,
      queued,
      verificationSkipped,
      reminders: reminders.map(({ taskPath, stage, dueDate }) => ({ taskPath, stage, dueDate })),
    });
    return { reason: shadow ? 'shadow' : queued ? 'queued' : 'no-op', reminders, queued };
  }

  async startTaskReminders() {
    const config = this.taskReminderConfig();
    if (reminderShadow) {
      await this.scanTaskReminders({ shadow: true });
      return;
    }
    if (!config.enabled) return;
    if (once) {
      if (reminderOnce) await this.scanTaskReminders();
      return;
    }
    const source = {
      intervalMinutes: config.intervalMinutes,
      jitterSeconds: config.jitterSeconds,
    };
    const slot = this.timers.push(null) - 1;
    const schedule = (first) => {
      if (this.stopping) return;
      this.timers[slot] = setTimeout(async () => {
        try {
          await this.scanTaskReminders();
        } catch (error) {
          log('warn', 'task reminder scan failed', { error: error.message });
        }
        schedule(false);
      }, nextTimerDelay(source, { first }));
    };
    schedule(true);
    log('info', 'task reminder scan scheduled', {
      intervalMinutes: config.intervalMinutes,
      jitterSeconds: config.jitterSeconds,
      recipient: config.recipient,
    });
  }

  /**
   * 待拆分需求的定期清扫。联系人随手记的需求先落 inbox，这里定时捞出来要一份
   * 拆分提案——机制的意义就是不靠人自觉，所以默认开，且只在真有东西时出声。
   * 走普通 backlog 事件，沿用现成的静默时段、池子与去重，不另开一条投递通道。
   */
  async sweepBacklogInbox() {
    const config = this.backlogSweepConfig();
    if (!config.enabled) return null;
    if (!this.vault.enabled) {
      log('info', 'backlog sweep skipped: no memory vault configured');
      return null;
    }
    const stateKey = 'backlog-sweep:v1';
    const text = await this.vault.backlog(config.query);
    const plan = planBacklogSweep({
      text,
      previous: this.store.getSourceState(stateKey),
      now: Date.now(),
      config,
    });
    if (!plan.emit) {
      log('info', 'backlog sweep quiet', { reason: plan.reason, pending: plan.hits.length });
      return plan;
    }
    this.store.setSourceState(stateKey, plan.state);
    this.enqueue({
      source: 'backlog-sweep',
      categoryHint: 'backlog',
      dedupeKey: `backlog-sweep:${plan.digest}:${shanghaiDateAt(Date.now(), 0)}`,
      summary: plan.summary,
      payload: { mode: 'backlog-sweep', pending: plan.hits.length, digest: plan.digest },
    });
    log('info', 'backlog sweep queued', { reason: plan.reason, pending: plan.hits.length });
    return plan;
  }

  /**
   * 日终日记 rollup。跟 daily/idea 的区别：不派给任何联系人，也不消耗它们的池——
   * 终点是 vault 的 diary 流水，唯一的额度约束是「一个上海日只结算一次」。
   */
  async processDiary(event) {
    const config = this.diaryConfig();
    const date = typeof event.payload?.date === 'string' ? event.payload.date : null;
    const finishNoop = (rationale, extra = {}) => {
      this.store.finish(event.id, 'noop', {
        triageResult: {
          actionable: false,
          category: 'diary',
          priority: 1,
          suggestedRecipient: null,
          rationale,
        },
        costCny: Number(extra.costCny ?? 0),
        triageLatencyMs: Number(extra.latencyMs ?? 0),
      });
      log('info', 'diary rollup skipped', { eventId: event.id, date, rationale });
    };

    if (!config.enabled) return finishNoop('diary rollup is disabled');
    if (!date) throw new Error('diary event is missing payload.date');
    if (!this.vault.enabled) throw new Error('diary rollup requires a configured memory vault');

    const stateKey = `diary-rollup:${date}`;
    if (this.store.getSourceState(stateKey)) {
      return finishNoop(`diary for ${date} was already settled`);
    }

    const result = await rollupDay({
      date,
      hub: this.hub,
      deepseek: this.deepseek,
      vault: this.vault,
      config,
      log,
    });

    // thin/empty 也要落状态：安静的一天就是没内容，重试只会重复烧钱。
    this.store.setSourceState(stateKey, `${result.status}:${new Date().toISOString()}`);
    if (result.status !== 'written') {
      return finishNoop(`${result.status}: ${result.reason}`, result);
    }

    this.store.recordDelivery(event.id, 'memory-vault', Date.now(), DELIVERY_POOL_DIARY);
    this.store.finish(event.id, 'dispatched', {
      triageResult: {
        actionable: true,
        category: 'diary',
        priority: 1,
        suggestedRecipient: null,
        rationale: `wrote ${result.written} diary entries for ${date}`,
        date,
        entryCount: result.written,
      },
      recipientId: 'memory-vault',
      costCny: result.costCny,
      triageLatencyMs: result.latencyMs,
    });
    log('info', 'diary rollup written', {
      eventId: event.id,
      date,
      entries: result.written,
      truncated: result.truncated === true,
      dropped: result.dropped,
      pool: DELIVERY_POOL_DIARY,
      costCny: result.costCny,
      triageLatencyMs: result.latencyMs,
    });
  }

  dailyPolicy(now = Date.now(), options = {}) {
    return dailyPolicyState(
      this.proactiveConfig(),
      this.store.poolUsage(DELIVERY_POOL_DAILY, now),
      now,
      options,
    );
  }

  ideaConfig() {
    return this.config.idea ?? normalizeIdeaConfig({});
  }

  ideaPolicy(now = Date.now()) {
    return ideaPolicyState(
      this.ideaConfig(),
      this.store.poolUsage(DELIVERY_POOL_IDEA, now),
    );
  }

  async processIdea(event) {
    let costCny = Number(event.cost_cny ?? 0);
    let triageLatencyMs = event.triage_latency_ms === null
      ? 0
      : Number(event.triage_latency_ms);
    let result = event.triageResult?.category === 'idea' ? event.triageResult : null;
    const idea = this.ideaConfig();
    const stateError = (error) => {
      error.ideaState = { costCny, triageLatencyMs, triageResult: result };
      return error;
    };

    try {
      const now = Date.now();
      if (isShanghaiSilentHour(
        now,
        this.proactiveConfig().silentStartHour,
        this.proactiveConfig().silentEndHour,
      )) {
        result = {
          actionable: false,
          category: 'idea',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'Shanghai quiet hours',
        };
        this.store.finish(event.id, 'noop', { triageResult: result, costCny, triageLatencyMs });
        log('info', 'idea event suppressed by silent hours', { eventId: event.id });
        return;
      }
      if (this.ideaPolicy(now).poolFull) {
        result = {
          actionable: false,
          category: 'idea',
          priority: 1,
          suggestedRecipient: null,
          rationale: 'idea pool disabled, unconfigured, or exhausted for Shanghai day',
        };
        this.store.finish(event.id, 'noop', { triageResult: result, costCny, triageLatencyMs });
        log('info', 'idea event suppressed by pool policy', { eventId: event.id });
        return;
      }

      const contacts = await this.hub.contacts();
      const room = contacts.find((contact) =>
        contact.id === idea.roomId && contact.kind === 'room'
      );
      if (!room) throw new Error(`idea room is unavailable: ${idea.roomId}`);
      const memberIds = Array.isArray(room.config?.members) ? room.config.members : [];
      const memberSet = new Set(memberIds);
      const members = contacts.filter((contact) =>
        contact.kind === 'dm' && memberSet.has(contact.id)
      );
      if (members.length < 2) throw new Error('idea room needs at least two enabled members');

      if (!result?.topic) {
        const recentTopics = this.store.recentIdeaTopics(idea.recentTopicLimit);
        const recentCategories = new Set(
          recentTopics.slice(0, 2).map((item) => item.category.trim().toLowerCase())
        );
        const recentTopicKeys = new Set(
          recentTopics.map((item) => hash(item.topic.replace(/\s+/g, '').toLowerCase()))
        );
        let generated = null;
        let rejection = 'no valid topic generated';
        for (let attempt = 1; attempt <= idea.maxTopicAttempts; attempt++) {
          const response = await this.deepseek.ideaTopic({ room, members, recentTopics });
          costCny += response.costCny;
          triageLatencyMs += response.latencyMs;
          const candidate = response.result;
          const targetsValid = candidate.targetIds.length === 1 && candidate.targetIds[0] === 'all'
            || candidate.targetIds.every((targetId) => memberSet.has(targetId));
          const topicKey = hash(candidate.topic.replace(/\s+/g, '').toLowerCase());
          if (!targetsValid) {
            rejection = 'topic selected invalid room targets';
            continue;
          }
          if (recentCategories.has(candidate.category)) {
            rejection = `topic category repeats one of the previous two: ${candidate.category}`;
            continue;
          }
          if (recentTopicKeys.has(topicKey)) {
            rejection = 'topic repeats a recent prompt';
            continue;
          }
          generated = candidate;
          break;
        }
        if (!generated) throw new Error(rejection);
        result = {
          actionable: true,
          category: 'idea',
          priority: 1,
          suggestedRecipient: room.id,
          rationale: generated.rationale,
          ideaCategory: generated.category,
          topic: generated.topic,
          targetIds: generated.targetIds,
          stage: 'topic-generated',
        };
      }

      if (!result.roundId) {
        const mention = result.targetIds.includes('all')
          ? '@all'
          : result.targetIds.map((targetId) => {
            const member = members.find((candidate) => candidate.id === targetId);
            return `@${member?.name ?? targetId}`;
          }).join(' ');
        const opened = await this.hub.dispatchRoomHost(room.id, {
          content: `${mention} ${result.topic}`,
          hostName: idea.hostName,
          targetIds: result.targetIds,
          reactionRounds: idea.reactionRounds,
          idempotencyKey: `idea:${event.id}:topic:${event.attempts}`,
        });
        result = {
          ...result,
          stage: 'round-dispatched',
          roundId: opened.roundId,
          topicMessageId: opened.messageId,
        };
      }

      let round;
      try {
        round = await this.hub.waitRoomRound(room.id, result.roundId, {
          pollMs: idea.roundPollMs,
          timeoutMs: idea.roundTimeoutMs,
        });
      } catch (error) {
        if (String(error.message).startsWith('room round failed:')) {
          result = {
            ...result,
            stage: 'topic-generated',
            roundId: undefined,
            topicMessageId: undefined,
          };
        }
        throw error;
      }
      const rows = await this.hub.messages(room.id, result.topicMessageId, 200);
      const names = new Map(contacts.map((contact) => [contact.id, contact.name]));
      const participantNames = [...new Set(
        rows
          .filter((row) => row.kind === 'text' && row.status === 'done' && row.sender !== 'room-host')
          .map((row) => names.get(row.sender) ?? row.sender),
      )];
      const transcript = rows
        .filter((row) => row.kind === 'text' && row.status === 'done' && row.sender !== 'room-host')
        .map((row) => `${names.get(row.sender) ?? row.sender}: ${row.content}`)
        .join('\n')
        .slice(0, 30_000);
      if (!transcript) throw new Error('idea room round finished without a visible transcript');

      if (!result.summary) {
        const summarized = await this.deepseek.ideaSummary({ topic: result.topic, transcript });
        costCny += summarized.costCny;
        triageLatencyMs += summarized.latencyMs;
        result = {
          ...result,
          stage: 'summarized',
          summary: summarized.result.summary,
          outcome: round.outcome,
        };
      }

      const closed = await this.hub.dispatchRoomHost(room.id, {
        content: result.summary,
        hostName: idea.hostName,
        trigger: false,
        idempotencyKey: `idea:${event.id}:summary`,
      });
      result = {
        ...result,
        stage: 'completed',
        summaryMessageId: closed.messageId,
      };
      const completedAt = Date.now();
      const diaryRequest = idea.writeDiary
        ? buildIdeaDiaryRequest({
          eventId: event.id,
          room,
          topic: result.topic,
          topicCategory: result.ideaCategory,
          targetNames: result.targetIds.includes('all')
            ? members.map((member) => member.name)
            : result.targetIds.map((targetId) => names.get(targetId) ?? targetId),
          participantNames,
          outcome: result.outcome,
          roundId: result.roundId,
          topicMessageId: result.topicMessageId,
          summaryMessageId: result.summaryMessageId,
          summary: result.summary,
          completedAt,
        })
        : null;
      const dedupeKey = `idea:${event.id}:summary:${result.summaryMessageId}`;
      this.store.completeIdea(event.id, {
        roomId: room.id,
        triageResult: result,
        costCny,
        triageLatencyMs,
        vaultWrite: diaryRequest ? {
          id: `idea-diary:${hash(dedupeKey)}`,
          dedupeKey,
          payload: diaryRequest,
        } : null,
      }, completedAt);
      log('info', 'idea discussion completed', {
        eventId: event.id,
        roomId: room.id,
        topicCategory: result.ideaCategory,
        topicMessageId: result.topicMessageId,
        summaryMessageId: result.summaryMessageId,
        outcome: result.outcome,
        diaryQueued: Boolean(diaryRequest),
        pool: DELIVERY_POOL_IDEA,
        costCny,
        triageLatencyMs,
      });
    } catch (error) {
      throw stateError(error);
    }
  }

  async proactiveContext(contacts, now = Date.now(), dateEvents = null) {
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
    const matched = dateEvents ?? await this.loadMatchedDateEvents(now);
    return {
      currentShanghaiTime: shanghaiClock(now).label,
      dailyDeliveryCount: usage.count,
      lastDailyDeliveryAt: usage.lastAt === null ? null : new Date(usage.lastAt).toISOString(),
      recentConversations,
      openTaskSnapshot: summarizeTaskContext(openTasks) || '(unavailable)',
      todayDateEvents: matched.unclaimedToday ?? matched.today ?? [],
      upcomingDateEvents: matched.upcoming ?? [],
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

  async processVaultOutboxOne() {
    const item = this.store.claimVaultWrite();
    if (!item) return false;
    try {
      if (item.kind !== 'idea-diary') {
        throw new Error(`unsupported vault outbox kind: ${item.kind}`);
      }
      if (!this.vault.enabled) {
        throw new Error('memory-vault URL is not configured');
      }
      await this.vault.writeDiary(item.payload);
      this.store.finishVaultWrite(item.id);
      log('info', 'idea diary written', {
        eventId: item.event_id,
        outboxId: item.id,
        slug: item.payload.slug,
        attempts: item.attempts,
      });
    } catch (error) {
      const delayMs = retryDelay(item.attempts);
      this.store.retryVaultWrite(item.id, error.message, delayMs);
      log('warn', 'idea diary scheduled for retry', {
        eventId: item.event_id,
        outboxId: item.id,
        attempt: item.attempts,
        retryInMs: delayMs,
        error: error.message,
      });
    }
    return true;
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

      if (this.isCoordinationEvent(event)) {
        await this.processCoordination(event);
        return true;
      }

      if (this.isIdeaEvent(event)) {
        await this.processIdea(event);
        return true;
      }

      if (this.isDiaryEvent(event)) {
        await this.processDiary(event);
        return true;
      }

      const isFollowup = this.isFollowupEvent(event);
      const followupRow = isFollowup && event.payload?.followupId
        ? this.store.getFollowup(event.payload.followupId)
        : null;
      // Deterministic path: same contact thread, no L1 pick-a-recipient.
      if (isFollowup && !triageResult) {
        if (!followupRow || !['pending', 'queued'].includes(followupRow.status)) {
          this.store.finish(event.id, 'noop', {
            triageResult: {
              actionable: false,
              needsLocalExec: false,
              category: 'daily',
              priority: 1,
              suggestedRecipient: null,
              rationale: 'followup already closed before dispatch',
            },
            costCny,
            triageLatencyMs,
          });
          log('info', 'stale followup event suppressed', {
            eventId: event.id,
            followupId: event.payload?.followupId,
          });
          return true;
        }
        triageResult = {
          actionable: true,
          needsLocalExec: false,
          category: 'daily',
          priority: 1,
          suggestedRecipient: followupRow.recipient_key
            || event.payload?.recipientKey
            || null,
          rationale: `temporary-absence followup: ${followupRow.activity}`,
        };
      }

      const isDaily = this.isDailyEvent(event) || isFollowup;
      const isReminder = this.isTaskReminder(event);
      const isProactive = isDaily || isReminder;
      const isBacklogSweep = !isDaily && this.isBacklogSweep(event);
      let backlogSnapshot = null;
      const proactive = this.proactiveConfig();
      if (
        isProactive
        && isShanghaiSilentHour(Date.now(), proactive.silentStartHour, proactive.silentEndHour)
      ) {
        if (isReminder || isFollowup) {
          this.store.retry(event.id, 'Shanghai quiet hours', 60 * 60_000, {
            triageResult,
            costCny,
            triageLatencyMs,
          });
          log('info', isFollowup ? 'followup deferred by silent hours' : 'task reminder deferred by silent hours', {
            eventId: event.id,
          });
          return true;
        }
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
      const dateEvents = isDaily && !isFollowup
        ? await this.loadMatchedDateEvents()
        : { today: [], upcoming: [], unclaimedToday: [] };
      const fallbackFollowups = isDaily && !isFollowup && Array.isArray(event.payload?.fallbackFollowupIds)
        ? event.payload.fallbackFollowupIds
          .slice(0, 1)
          .map((id) => this.store.getFollowup(id))
          .filter((followup) => followup?.status === FOLLOWUP_STATUS_EXPIRED
            && followup.fallback_reminded_at === null)
          .map((followup) => ({
            id: followup.id,
            activity: followup.activity,
            returnCommitment: followup.return_commitment ?? '',
            contactId: followup.contact_id,
            recipientKey: followup.recipient_key,
          }))
        : [];
      // Direct and next-day followups clear the gap like date-events; all still share the hard pool.
      const hasTodayDateEvent = dateEvents.unclaimedToday.length > 0
        || fallbackFollowups.length > 0
        || isFollowup;
      const initialDailyPolicy = isDaily
        ? this.dailyPolicy(Date.now(), { hasTodayDateEvent })
        : null;
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

      // Privacy-preserving deterministic path: the commitment goes only to the
      // original companion contact, never through external L1 triage.
      if (fallbackFollowups.length && !triageResult) {
        triageResult = {
          actionable: true,
          needsLocalExec: false,
          category: 'daily',
          priority: 1,
          suggestedRecipient: fallbackFollowups[0].recipientKey || proactive.recipients[0],
          rationale: 'unfinished return commitment from last night',
        };
      }
      let contacts = null;
      if (isReminder) {
        if (!this.vault.enabled) throw new Error('task reminders require a configured memory vault');
        const current = buildTaskReminders(await this.vault.taskContext())
          .find((item) => item.reminderKey === event.payload?.reminderKey);
        if (!current) {
          const staleResult = {
            actionable: false,
            needsLocalExec: false,
            category: 'daily',
            priority: 1,
            suggestedRecipient: null,
            rationale: 'task reminder became stale before delivery',
            taskPath: event.payload?.taskPath ?? null,
          };
          this.store.finish(event.id, 'noop', { triageResult: staleResult, costCny, triageLatencyMs });
          log('info', 'stale task reminder suppressed', { eventId: event.id, taskPath: event.payload?.taskPath });
          return true;
        }
        triageResult = {
          actionable: true,
          needsLocalExec: false,
          category: 'daily',
          priority: current.priority,
          suggestedRecipient: this.taskReminderConfig().recipient,
          rationale: `${current.taskPath} entered reminder stage ${current.stage}`,
          taskPath: current.taskPath,
        };
        const reminderRoute = this.taskReminderRoute(current);
        if (
          current.stage === 'due-today'
          && reminderRoute.verifier
          && this.store.getSourceState(`verification:v1:${current.taskPath}:${current.dueDate}`)
        ) {
          this.store.finish(event.id, 'noop', {
            triageResult: {
              ...triageResult,
              actionable: false,
              rationale: 'same-day verification dispatch already covers this due-today reminder',
            },
            costCny,
            triageLatencyMs,
          });
          log('info', 'task reminder suppressed after same-day verification dispatch', {
            eventId: event.id,
            taskPath: current.taskPath,
          });
          return true;
        }
        if (reminderRoute.route === 'room') {
          if (this.coordinationPolicy().poolFull) {
            this.store.retry(event.id, 'coordination daily pool full', 60 * 60_000, {
              triageResult,
              costCny,
              triageLatencyMs,
            });
            return true;
          }
          try {
            const coordination = this.coordinationConfig();
            const dispatched = await this.hub.dispatchRoomHost(coordination.roomId, {
              content: formatTaskReminderRoomNotice(current),
              hostName: coordination.hostName,
              trigger: false,
              reactionRounds: 0,
              idempotencyKey: `reminder:v1:${current.taskPath}:${current.dueDate}:${current.stage}`,
            });
            const storedResult = {
              ...triageResult,
              category: 'coordination',
              suggestedRecipient: null,
              rationale: `${current.taskPath} reminder stage ${current.stage} posted to coordination room`,
            };
            this.store.recordDelivery(
              event.id,
              coordination.roomId,
              Date.now(),
              DELIVERY_POOL_COORDINATION,
              {
                messageId: dispatched?.messageId,
                taskPath: current.taskPath,
                executedVia: EXECUTED_VIA_NONE,
              },
            );
            this.store.finish(event.id, 'dispatched', {
              triageResult: storedResult,
              recipientId: coordination.roomId,
              costCny,
              triageLatencyMs,
            });
            log('info', 'task reminder dispatched to coordination room', {
              eventId: event.id,
              taskPath: current.taskPath,
              stage: current.stage,
              roomId: coordination.roomId,
              pool: DELIVERY_POOL_COORDINATION,
            });
            return true;
          } catch (error) {
            log('warn', 'task reminder room dispatch failed; falling back to main', {
              eventId: event.id,
              taskPath: current.taskPath,
              error: error.message,
            });
          }
        }
      }
      if (isBacklogSweep) {
        backlogSnapshot = await this.dispatchableBacklog();
        if (!backlogSnapshot.taskPaths.length) {
          const noTaskResult = {
            actionable: false,
            category: 'backlog',
            priority: 1,
            suggestedRecipient: null,
            rationale: 'no unclaimed current task; tails, future tasks, and previously handled paths are suppressed',
            taskPath: null,
          };
          this.store.finish(event.id, 'noop', {
            triageResult: noTaskResult,
            costCny,
            triageLatencyMs,
          });
          log('info', 'backlog sweep suppressed before L1', {
            eventId: event.id,
            ignored: backlogSnapshot.ignored.length,
          });
          return true;
        }
        if (triageResult?.taskPath && !backlogSnapshot.taskPaths.includes(triageResult.taskPath)) {
          const staleResult = {
            ...triageResult,
            actionable: false,
            suggestedRecipient: null,
            rationale: `${triageResult.rationale} | task is no longer dispatchable`,
            taskPath: null,
          };
          this.store.finish(event.id, 'noop', {
            triageResult: staleResult,
            costCny,
            triageLatencyMs,
          });
          log('info', 'stale backlog retry suppressed', {
            eventId: event.id,
            taskPath: triageResult.taskPath,
          });
          return true;
        }
      }
      if (!triageResult) {
        let backlogSummary = '';
        let triageOptions = {};
        if (isDaily) {
          contacts = await this.hub.contacts();
          triageOptions = {
            mode: 'daily',
            dailyRecipients: proactive.recipients,
            forceActionable: initialDailyPolicy.forceActionable,
            proactiveContext: await this.proactiveContext(contacts, Date.now(), dateEvents),
          };
        } else {
          if (isBacklogSweep) {
            backlogSummary = backlogSnapshot.summary;
            triageOptions = { allowedTaskPaths: backlogSnapshot.taskPaths };
          } else {
            backlogSummary = await this.vault.taskContext().catch((error) => {
              log('warn', 'task context unavailable', { error: error.message });
              return '';
            });
          }
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
      if (
        isBacklogSweep
        && triageResult.actionable
        && !backlogSnapshot.taskPaths.includes(triageResult.taskPath)
      ) {
        const invalidSelection = {
          ...triageResult,
          actionable: false,
          suggestedRecipient: null,
          rationale: `${triageResult.rationale} | L1 did not select an exact eligible taskPath`,
          taskPath: null,
        };
        this.store.finish(event.id, 'noop', {
          triageResult: invalidSelection,
          costCny,
          triageLatencyMs,
        });
        log('warn', 'backlog sweep rejected invalid L1 task selection', {
          eventId: event.id,
          taskPath: triageResult.taskPath,
        });
        return true;
      }
      if (isBacklogSweep && !triageResult.actionable && triageResult.taskPath !== null) {
        triageResult = { ...triageResult, taskPath: null };
      }
      validateTriageMode(triageResult, {
        mode: isProactive ? 'daily' : 'task',
        dailyRecipients: proactive.recipients,
        forceActionable: isDaily && initialDailyPolicy.forceActionable,
        allowedTaskPaths: isBacklogSweep ? backlogSnapshot.taskPaths : null,
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

      const currentDailyPolicy = isDaily
        ? this.dailyPolicy(Date.now(), { hasTodayDateEvent })
        : null;
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
      const options = this.routeOptions(isProactive);
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
        && (
          triageResult.needsLocalExec !== true
          || contacts.some((contact) => contact.config?.delegation?.enabled === true)
        )
      ) {
        const fallback = await this.deepseek.fuzzyRoute(event, triageResult, contacts, {
          allowedRecipientKeys: isProactive ? proactive.recipients : null,
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
          ...this.routeOptions(isProactive),
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

      const dispatchResult = await this.hub.dispatch(
        route.contact.id,
        dispatchPrompt(event, storedResult, {
          daily: isDaily,
          reminder: isReminder,
          todayDateEvents: isDaily && !isFollowup ? dateEvents.unclaimedToday : [],
          followup: isFollowup ? followupRow : null,
          fallbackFollowups,
        }),
        {
          origin: isProactive ? 'main' : 'side',
          hidden: true,
          idempotencyKey: `automation:${event.source}:${event.id}`,
          automation: {
            messageType: isProactive ? 'proactive-trigger' : 'background-event',
            eventSource: event.source,
            eventId: event.id,
            eventCategory: storedResult.category,
            eventPriority: storedResult.priority,
          },
        },
      );
      if (isBacklogSweep) this.claimBacklogTask(storedResult.taskPath, event.id);
      if (isDaily && !isFollowup && dateEvents.unclaimedToday.length) {
        this.claimDateEvents(dateEvents.unclaimedToday, { eventId: event.id });
      }
      if (isFollowup && followupRow) {
        this.store.updateFollowupStatus(followupRow.id, FOLLOWUP_STATUS_DISPATCHED, {
          eventId: event.id,
        });
      }
      if (fallbackFollowups.length) {
        this.store.markFollowupsFallbackReminded(fallbackFollowups.map((item) => item.id));
      }
      this.store.recordDelivery(
        event.id,
        route.contact.id,
        Date.now(),
        isProactive ? DELIVERY_POOL_DAILY : DELIVERY_POOL_TASK,
        {
          messageId: dispatchResult?.messageId,
          taskPath: storedResult.taskPath ?? null,
          executedVia: isProactive
            ? EXECUTED_VIA_NONE
            : storedResult.needsLocalExec
              ? EXECUTED_VIA_WORKER
              : EXECUTED_VIA_CONTACT,
        },
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
        pool: isProactive ? DELIVERY_POOL_DAILY : DELIVERY_POOL_TASK,
        fallbackUsed,
        dateEvents: isDaily ? dateEvents.unclaimedToday.map((item) => item.key) : undefined,
        costCny,
        triageLatencyMs,
      });
    } catch (error) {
      if (error.ideaState) {
        costCny = error.ideaState.costCny;
        triageLatencyMs = error.ideaState.triageLatencyMs;
        triageResult = error.ideaState.triageResult;
      }
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

  /** 内建日程，不依赖 sources 配置——生产的 triage.config.json 不进 git，
   *  靠配置才能开的机制等于永远开不了。 */
  startBacklogSweep() {
    const config = this.backlogSweepConfig();
    if (!config.enabled) return null;
    const run = () => this.sweepBacklogInbox().catch((error) => {
      log('warn', 'backlog sweep failed', { error: error.message });
    });
    // --once 是「把队列排空就退出」，不是「替所有定时器走一格」；
    // 想手动扫一次用 --once --sweep。
    if (once) return sweepOnce ? run() : null;
    const slot = this.timers.push(null) - 1;
    const schedule = () => {
      if (this.stopping) return;
      this.timers[slot] = setTimeout(() => {
        void run();
        schedule();
      }, nextWallClockDelay(config));
    };
    schedule();
    log('info', 'backlog sweep scheduled', {
      at: `${String(config.atHour).padStart(2, '0')}:${String(config.atMinute).padStart(2, '0')}`,
      query: config.query,
      renagHours: config.renagHours,
    });
    return null;
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
          if (daily || idea) {
            const proactive = this.proactiveConfig();
            if (daily && !proactive.enabled) return;
            if (idea && !this.ideaConfig().enabled) return;
            if (isShanghaiSilentHour(now, proactive.silentStartHour, proactive.silentEndHour)) {
              log('info', `${idea ? 'idea' : 'daily'} timer skipped: silent hours`, { source: source.id });
              return;
            }
            if (daily) {
              dateEvents = await this.loadMatchedDateEvents(now);
              fallbackFollowups = this.followupFallbacks(now);
            }
            const policy = idea
              ? this.ideaPolicy(now)
              : this.dailyPolicy(now, { hasTodayDateEvent: dateEvents.unclaimedToday.length > 0 || fallbackFollowups.length > 0 });
            if (policy.poolFull || policy.gapBlocked) {
              log('info', `${idea ? 'idea' : 'daily'} timer skipped by pool policy`, {
                source: source.id,
                reason: policy.poolFull ? 'pool-full' : 'minimum-gap',
              });
              return;
            }
          }
          const policy = daily
            ? this.dailyPolicy(now, { hasTodayDateEvent: dateEvents.unclaimedToday.length > 0 || fallbackFollowups.length > 0 })
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
              })
              : (source.summary ?? `Scheduled wake from ${source.id}`),
            payload: {
              ...(source.payload && typeof source.payload === 'object' ? source.payload : {}),
              mode: idea ? 'idea' : daily ? 'daily' : 'task',
              emittedAt: now,
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
    const recoveredVaultWrites = this.store.recoverStaleVaultWrites(this.config.claimTimeoutMs);
    if (recoveredVaultWrites) log('warn', 'recovered stale vault writes', { count: recoveredVaultWrites });
    if (metricsOnly) {
      process.stdout.write(`${JSON.stringify(this.store.dailySummary(), null, 2)}\n`);
      return;
    }
    // Reminder-only commands must not wake unrelated timers. In particular,
    // --reminder-shadow is a read-only production probe and may never dispatch.
    if (reminderShadow || reminderOnce) {
      await this.startTaskReminders();
      if (reminderShadow) return;
    } else {
      await this.startSources();
      await this.startTaskReminders();
      await this.startBacklogSweep();
    }
    this.startWebhook();
    do {
      await this.collectOutcomesIfDue();
      await this.processFollowupsIfDue();
      this.scanCoordinationIfDue();
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
