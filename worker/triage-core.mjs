import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_CATEGORIES = [
  'calendar',
  'file-change',
  'rss',
  'backlog',
  'message',
  'system',
  'daily',
  'idea',
  'coordination',
  'other',
];

export const DEFAULT_DAILY_RECIPIENTS = ['claude', 'codex', 'aye'];
export const DELIVERY_POOL_TASK = 'task';
export const DELIVERY_POOL_DAILY = 'daily';
export const DELIVERY_POOL_IDEA = 'idea';
export const DELIVERY_POOL_COORDINATION = 'coordination';
export const DEFAULT_COORDINATION_REMINDER_ROOM_TAGS = ['ai-hub', 'worker', 'deploy', '工程'];
export const DELIVERY_POOL_DIARY = 'diary';
export const EXECUTED_VIA_CONTACT = 'contact';
export const EXECUTED_VIA_WORKER = 'worker';
export const EXECUTED_VIA_NONE = 'none';
export const OUTCOME_LABEL_UNKNOWN = 'unknown';
export const OUTCOME_LABEL_ENGAGED = 'engaged';
export const OUTCOME_LABEL_ACCEPTED = 'accepted';
export const OUTCOME_LABEL_REWORKED = 'reworked';
export const OUTCOME_LABEL_REJECTED = 'rejected';

export const OUTCOME_LABELS = [
  OUTCOME_LABEL_UNKNOWN,
  OUTCOME_LABEL_ENGAGED,
  OUTCOME_LABEL_ACCEPTED,
  OUTCOME_LABEL_REWORKED,
  OUTCOME_LABEL_REJECTED,
];

const DELIVERY_POOLS = new Set([
  DELIVERY_POOL_TASK,
  DELIVERY_POOL_DAILY,
  DELIVERY_POOL_IDEA,
  DELIVERY_POOL_COORDINATION,
  DELIVERY_POOL_DIARY,
]);
const EXECUTED_VIA_VALUES = [
  EXECUTED_VIA_CONTACT,
  EXECUTED_VIA_WORKER,
  EXECUTED_VIA_NONE,
];
const EXECUTED_VIA_SET = new Set(EXECUTED_VIA_VALUES);
const OUTCOME_LABEL_SET = new Set(OUTCOME_LABELS);
const OUTCOME_LABEL_PRIORITY = new Map([
  [OUTCOME_LABEL_UNKNOWN, 0],
  [OUTCOME_LABEL_ENGAGED, 1],
  [OUTCOME_LABEL_ACCEPTED, 2],
  [OUTCOME_LABEL_REWORKED, 3],
  [OUTCOME_LABEL_REJECTED, 4],
]);

const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const FINAL_STATES = new Set(['noop', 'dispatched', 'parked', 'dead']);
const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function boundedText(value, max = 20_000) {
  const text = typeof value === 'string' ? value : stableJson(value);
  return text.trim().slice(0, max);
}

function integerConfig(value, fallback, name, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function shanghaiDayStart(now = Date.now()) {
  const shifted = new Date(now + SHANGHAI_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted.getTime() - SHANGHAI_OFFSET_MS;
}

export function shanghaiClock(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const read = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${read('year')}-${read('month')}-${read('day')}`,
    weekday: read('weekday'),
    hour: Number(read('hour')),
    minute: Number(read('minute')),
    second: Number(read('second')),
    label: `${read('year')}-${read('month')}-${read('day')} ${read('weekday')} ${read('hour')}:${read('minute')}:${read('second')} Asia/Shanghai`,
  };
}

// Silent window is half-open: [startHour, endHour) in Asia/Shanghai.
// Default 0–9 means 00:00 inclusive through 09:00 exclusive.
export function isShanghaiSilentHour(now = Date.now(), startHour = 0, endHour = 9) {
  const start = Math.max(0, Math.min(23, Number(startHour)));
  const end = Math.max(0, Math.min(24, Number(endHour)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  const hour = shanghaiClock(now).hour;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function isDailyMode(sourceOrResult) {
  if (!sourceOrResult || typeof sourceOrResult !== 'object') return false;
  if (sourceOrResult.mode === 'daily') return true;
  if (sourceOrResult.category === 'daily') return true;
  if (sourceOrResult.categoryHint === 'daily') return true;
  if (sourceOrResult.category_hint === 'daily') return true;
  if (sourceOrResult.payload && typeof sourceOrResult.payload === 'object'
    && sourceOrResult.payload.mode === 'daily') {
    return true;
  }
  return false;
}

export function isIdeaMode(sourceOrResult) {
  if (!sourceOrResult || typeof sourceOrResult !== 'object') return false;
  if (sourceOrResult.mode === 'idea') return true;
  if (sourceOrResult.category === 'idea') return true;
  if (sourceOrResult.categoryHint === 'idea') return true;
  if (sourceOrResult.category_hint === 'idea') return true;
  if (sourceOrResult.payload && typeof sourceOrResult.payload === 'object'
    && sourceOrResult.payload.mode === 'idea') {
    return true;
  }
  return false;
}

export function isDiaryMode(sourceOrResult) {
  if (!sourceOrResult || typeof sourceOrResult !== 'object') return false;
  if (sourceOrResult.mode === 'diary') return true;
  if (sourceOrResult.category === 'diary') return true;
  if (sourceOrResult.categoryHint === 'diary') return true;
  if (sourceOrResult.category_hint === 'diary') return true;
  if (sourceOrResult.payload && typeof sourceOrResult.payload === 'object'
    && sourceOrResult.payload.mode === 'diary') {
    return true;
  }
  return false;
}

export function isTaskReminderMode(sourceOrResult) {
  if (!sourceOrResult || typeof sourceOrResult !== 'object') return false;
  if (sourceOrResult.mode === 'task-reminder') return true;
  if (sourceOrResult.categoryHint === 'task-reminder') return true;
  if (sourceOrResult.category_hint === 'task-reminder') return true;
  return sourceOrResult.payload?.mode === 'task-reminder';
}

function taskDateOffset(date, offsetDays) {
  const [year, month, day] = String(date).split('-').map(Number);
  if (![year, month, day].every(Number.isInteger)) return null;
  return new Date(Date.UTC(year, month - 1, day + offsetDays)).toISOString().slice(0, 10);
}

/**
 * Parse the exact open-task snapshot emitted by memory-vault get_task_context.
 * The reminder key deliberately excludes the changing "N days" text: one task
 * is notified once per due date and stage, not once per scan or once per day.
 */
export function buildTaskReminders(snapshot) {
  if (typeof snapshot !== 'string' || !snapshot.trim()) return [];
  const snapshotDate = snapshot.match(/任务快照日期：(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  if (!snapshotDate) return [];
  const reminders = [];
  const linePattern = /^-\s+(?:⚠\s+|🔔\s+)?\*\*(.+?)\*\*\s+\(`([^`]+)`\)(.*)$/;
  for (const rawLine of snapshot.split(/\r?\n/)) {
    const match = rawLine.trim().match(linePattern);
    if (!match) continue;
    const title = match[1].trim();
    const taskPath = match[2].trim().replaceAll('\\', '/');
    const tail = match[3].trim();
    if (!taskPath.startsWith('tasks/')) continue;
    if (/无期限|仍未完成/.test(tail) || /\b(?:done|dropped)\b|已完成|已作废/i.test(tail)) continue;

    let stage = null;
    let dueDate = null;
    let daysUntilDue = null;
    let priority = 1;
    const overdue = tail.match(/已过期\s+(\d+)\s+天/);
    const upcoming = tail.match(/还有\s+(\d+)\s+天(?:（(\d{4}-\d{2}-\d{2}))?/);
    if (overdue) {
      stage = 'overdue';
      daysUntilDue = -Number(overdue[1]);
      dueDate = taskDateOffset(snapshotDate, daysUntilDue);
      priority = 3;
    } else if (/今天到期/.test(tail)) {
      stage = 'due-today';
      daysUntilDue = 0;
      dueDate = snapshotDate;
      priority = 2;
    } else if (upcoming) {
      const days = Number(upcoming[1]);
      if (days < 1 || days > 7) continue;
      stage = 'upcoming';
      daysUntilDue = days;
      dueDate = upcoming[2] ?? taskDateOffset(snapshotDate, days);
      priority = 1;
    }
    if (!stage || !dueDate) continue;

    const reminderKey = `${taskPath}:${dueDate}:${stage}`;
    const conclusion = stage === 'overdue'
      ? `任务“${title}”已过期 ${Math.abs(daysUntilDue)} 天（原定 ${dueDate}）。`
      : stage === 'due-today'
        ? `任务“${title}”今天到期（${dueDate}）。`
        : `任务“${title}”将在 ${daysUntilDue} 天后到期（${dueDate}）。`;
    const nextStep = stage === 'upcoming'
      ? '确认是否仍按计划推进。'
      : '确认完成、改期或作废。';
    reminders.push({
      title,
      taskPath,
      stage,
      dueDate,
      daysUntilDue,
      priority,
      reminderKey,
      summary: `${conclusion}\n下一步：${nextStep}\n需要 User 操作：是。`,
    });
  }
  return reminders;
}

/** 上海日历日字符串，offsetDays=1 表示前一天。Asia/Shanghai 无夏令时，定长换算安全。 */
export function shanghaiDateAt(now = Date.now(), offsetDays = 0) {
  const offset = Number.isFinite(Number(offsetDays)) ? Number(offsetDays) : 0;
  return shanghaiClock(now - offset * 24 * 60 * 60_000).date;
}

/**
 * 到下一个上海墙钟时刻的毫秒数。定时源的 jitter 调度只保证「间隔」，
 * rollup 要的是「每天固定点跑一次」，两者不能混用。
 */
export function nextWallClockDelay({ atHour = 2, atMinute = 30 } = {}, now = Date.now()) {
  const clock = shanghaiClock(now);
  const target = Number(atHour) * 60 + Number(atMinute);
  const current = clock.hour * 60 + clock.minute;
  let deltaMinutes = target - current;
  if (deltaMinutes <= 0) deltaMinutes += 24 * 60;
  return deltaMinutes * 60_000 - clock.second * 1000;
}

export function normalizeDiaryConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('diary must be an object');
  }
  const source = typeof raw.source === 'string' && raw.source.trim()
    ? raw.source.trim().slice(0, 40)
    : 'hub-rollup';
  return {
    enabled: raw.enabled === true,
    atHour: integerConfig(raw.atHour, 2, 'diary.atHour', 0, 23),
    atMinute: integerConfig(raw.atMinute, 30, 'diary.atMinute', 0, 59),
    // 1 = 结算前一天。跑在凌晨、结算完整的昨天，比 23:30 结算今天少漏一截。
    targetOffsetDays: integerConfig(raw.targetOffsetDays, 1, 'diary.targetOffsetDays', 0, 30),
    maxEntries: integerConfig(raw.maxEntries, 8, 'diary.maxEntries', 1, 30),
    // 每多一次都是一整份 transcript 的钱，2 次够覆盖偶发的坏 JSON。
    extractAttempts: integerConfig(raw.extractAttempts, 2, 'diary.extractAttempts', 1, 5),
    minMessages: integerConfig(raw.minMessages, 4, 'diary.minMessages', 0, 1000),
    minUserMessages: integerConfig(raw.minUserMessages, 2, 'diary.minUserMessages', 0, 1000),
    messageLimit: integerConfig(raw.messageLimit, 400, 'diary.messageLimit', 10, 1000),
    transcriptMaxChars: integerConfig(
      raw.transcriptMaxChars,
      24_000,
      'diary.transcriptMaxChars',
      1000,
      100_000,
    ),
    source,
  };
}

/**
 * 待拆分需求的定期清扫。默认开启：这条链路的价值全在「不靠人自觉」，
 * 需要显式关掉时才写 backlogSweep.enabled=false。
 */
export function normalizeBacklogSweepConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('backlogSweep must be an object');
  }
  const query = typeof raw.query === 'string' && raw.query.trim()
    ? raw.query.trim().slice(0, 80)
    : '待拆分需求';
  return {
    enabled: raw.enabled !== false,
    atHour: integerConfig(raw.atHour, 10, 'backlogSweep.atHour', 0, 23),
    atMinute: integerConfig(raw.atMinute, 30, 'backlogSweep.atMinute', 0, 59),
    // 清单没变也要隔几天再提醒一次，否则「攒着不拆」会永远安静。
    renagHours: integerConfig(raw.renagHours, 72, 'backlogSweep.renagHours', 1, 24 * 30),
    maxItems: integerConfig(raw.maxItems, 20, 'backlogSweep.maxItems', 1, 100),
    query,
  };
}

/** search_vault 的行格式：`- **标题** (\`路径\`)  [tag, tag]` */
export function parseVaultSearchHits(text) {
  const hits = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = line.match(/^-\s+\*\*(.+?)\*\*\s+\(`(.+?)`\)/);
    if (match) hits.push({ title: match[1].trim(), path: match[2].trim() });
  }
  return hits;
}

/**
 * 决定这一轮清扫要不要出声。三种情况才发：清单有内容且（第一次扫到 /
 * 清单变了 / 距上次提醒超过 renagHours）。清单空了直接闭嘴。
 */
export function planBacklogSweep({ text, previous, now = Date.now(), config }) {
  const cfg = config ?? normalizeBacklogSweepConfig({});
  const hits = parseVaultSearchHits(text).slice(0, cfg.maxItems);
  if (hits.length === 0) return { emit: false, reason: 'no unsorted requests', hits, state: null };

  const digest = crypto.createHash('sha256')
    .update(hits.map((hit) => hit.path).join('\n'))
    .digest('hex')
    .slice(0, 16);
  const prev = parseSweepState(previous);
  if (prev && prev.digest === digest && now - prev.at < cfg.renagHours * 3_600_000) {
    return { emit: false, reason: 'unchanged and still within the re-nag window', hits, state: null };
  }
  const lines = hits.map((hit) => `- ${hit.title} (${hit.path})`).join('\n');
  return {
    emit: true,
    reason: prev ? (prev.digest === digest ? 're-nag window elapsed' : 'request list changed') : 'first sweep',
    hits,
    digest,
    state: `${digest}:${now}`,
    summary: [
      `记忆库里有 ${hits.length} 条待拆分需求，还没进需求账本。`,
      '请给出拆分提案：每条说明是并进哪个已有任务（给出任务路径），还是独立开一条（给出 slug 与标题）；',
      '拿不准的直接说拿不准。不要自行 add_task，提案先给 User 过目。',
      '',
      lines,
    ].join('\n'),
  };
}

function parseSweepState(value) {
  const match = /^([0-9a-f]{4,64}):(\d+)$/.exec(String(value ?? ''));
  return match ? { digest: match[1], at: Number(match[2]) } : null;
}

/**
 * L1 抽取结果的严格解析。日记条目会永久落进 vault，宁可整批拒绝重试，
 * 也不要把半个残缺条目写进 User 的日记。
 */
export function parseDiaryEntries(value, { maxEntries = 8 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('diary response must be a JSON object');
  }
  if (!Array.isArray(value.entries)) throw new Error('diary response must carry an entries array');
  const seen = new Set();
  const entries = [];
  for (const item of value.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('diary entry must be an object');
    }
    const time = String(item.time ?? '').trim();
    if (!HHMM_RE.test(time)) throw new Error(`diary entry time must be HH:MM: ${item.time}`);
    const text = String(item.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('diary entry text must be a non-empty string');
    const key = text.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ time, text: text.slice(0, 300) });
  }
  entries.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return entries.slice(0, Math.max(1, Number(maxEntries) || 8));
}

export function normalizeProactiveConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('proactive must be an object');
  }
  const recipients = raw.recipients === undefined
    ? [...DEFAULT_DAILY_RECIPIENTS]
    : [...new Set(
      (Array.isArray(raw.recipients) ? raw.recipients : [])
        .map((item) => String(item).trim().toLowerCase())
        .filter(Boolean),
    )];
  if (!recipients.length) throw new Error('proactive.recipients must contain at least one recipient');
  const dailyDispatchLimit = integerConfig(
    raw.dailyDispatchLimit,
    10,
    'proactive.dailyDispatchLimit',
    0,
    1000,
  );
  const minDailyDispatches = integerConfig(
    raw.minDailyDispatches,
    1,
    'proactive.minDailyDispatches',
    0,
    1000,
  );
  if (minDailyDispatches > dailyDispatchLimit) {
    throw new Error('proactive.minDailyDispatches cannot exceed proactive.dailyDispatchLimit');
  }
  return {
    enabled: raw.enabled !== false,
    dailyDispatchLimit,
    minDailyDispatches,
    forceAfterHour: integerConfig(raw.forceAfterHour, 18, 'proactive.forceAfterHour', 0, 23),
    minimumGapMinutes: integerConfig(
      raw.minimumGapMinutes,
      180,
      'proactive.minimumGapMinutes',
      0,
      24 * 60,
    ),
    silentStartHour: integerConfig(raw.silentStartHour, 0, 'proactive.silentStartHour', 0, 23),
    silentEndHour: integerConfig(raw.silentEndHour, 9, 'proactive.silentEndHour', 0, 24),
    recipients,
  };
}

export function normalizeTaskReminderConfig(raw = {}, proactive = normalizeProactiveConfig({})) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('taskReminders must be an object');
  }
  const allowedRecipients = proactive.recipients ?? DEFAULT_DAILY_RECIPIENTS;
  const recipient = String(raw.recipient ?? allowedRecipients[0] ?? '').trim().toLowerCase();
  if (!recipient || !allowedRecipients.includes(recipient)) {
    throw new Error('taskReminders.recipient must be included in proactive.recipients');
  }
  return {
    // New production behavior is opt-in. Deploy code, run --reminder-shadow,
    // then add taskReminders.enabled=true only after the shadow gate passes.
    enabled: raw.enabled === true,
    intervalMinutes: integerConfig(raw.intervalMinutes, 45, 'taskReminders.intervalMinutes', 15, 24 * 60),
    jitterSeconds: integerConfig(raw.jitterSeconds, 900, 'taskReminders.jitterSeconds', 0, 60 * 60),
    recipient,
  };
}

export function normalizeIdeaConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('idea must be an object');
  }
  const roomId = typeof raw.roomId === 'string' ? raw.roomId.trim() : '';
  return {
    enabled: raw.enabled === true,
    writeDiary: raw.writeDiary !== false,
    roomId,
    hostName: typeof raw.hostName === 'string' && raw.hostName.trim()
      ? raw.hostName.trim().slice(0, 80)
      : 'DS 主持',
    dailyDispatchLimit: integerConfig(
      raw.dailyDispatchLimit,
      1,
      'idea.dailyDispatchLimit',
      0,
      30,
    ),
    reactionRounds: integerConfig(raw.reactionRounds, 2, 'idea.reactionRounds', 0, 3),
    recentTopicLimit: integerConfig(raw.recentTopicLimit, 12, 'idea.recentTopicLimit', 3, 100),
    maxTopicAttempts: integerConfig(raw.maxTopicAttempts, 3, 'idea.maxTopicAttempts', 1, 10),
    roundPollMs: integerConfig(raw.roundPollMs, 2000, 'idea.roundPollMs', 100, 60_000),
    roundTimeoutMs: integerConfig(
      raw.roundTimeoutMs,
      20 * 60_000,
      'idea.roundTimeoutMs',
      10_000,
      60 * 60_000,
    ),
  };
}

export function normalizeCoordinationConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('coordination must be an object');
  }
  const roomId = typeof raw.roomId === 'string' ? raw.roomId.trim() : '';
  const tasksDir = typeof raw.tasksDir === 'string' && raw.tasksDir.trim()
    ? raw.tasksDir.trim()
    : '/opt/memory-vault/tasks';
  const reminderRoomTags = Array.isArray(raw.reminderRoomTags)
    ? [...new Set(raw.reminderRoomTags
      .map((value) => String(value).trim().toLowerCase())
      .filter(Boolean))]
    : [...DEFAULT_COORDINATION_REMINDER_ROOM_TAGS];
  return {
    enabled: raw.enabled === true,
    roomId,
    hostName: typeof raw.hostName === 'string' && raw.hostName.trim()
      ? raw.hostName.trim().slice(0, 80)
      : 'DS 主持',
    tasksDir,
    reminderRoomTags,
    dailyLimit: integerConfig(raw.dailyLimit, 8, 'coordination.dailyLimit', 0, 100),
    scanIntervalMinutes: integerConfig(
      raw.scanIntervalMinutes,
      5,
      'coordination.scanIntervalMinutes',
      1,
      24 * 60,
    ),
  };
}

export function buildIdeaDiaryRequest({
  eventId,
  room,
  topic,
  topicCategory,
  targetNames = [],
  participantNames = [],
  outcome = null,
  roundId,
  topicMessageId,
  summaryMessageId,
  summary,
  completedAt = Date.now(),
}) {
  const id = String(eventId ?? '').trim();
  const finalMessageId = String(summaryMessageId ?? '').trim();
  const prompt = String(topic ?? '').trim();
  const wrapUp = String(summary ?? '').trim();
  if (!id || !finalMessageId || !prompt || !wrapUp) {
    throw new Error('idea diary requires eventId, summaryMessageId, topic, and summary');
  }
  const date = shanghaiClock(completedAt).date;
  const topicLabel = String(topicCategory ?? 'other').trim().slice(0, 100) || 'other';
  const roomId = String(room?.id ?? '').trim();
  const roomName = String(room?.name ?? roomId).trim();
  const targets = [...new Set(targetNames.map((item) => String(item).trim()).filter(Boolean))];
  const participants = [...new Set(
    participantNames.map((item) => String(item).trim()).filter(Boolean),
  )];
  const digest = crypto
    .createHash('sha256')
    .update(`${id}\0${finalMessageId}`)
    .digest('hex')
    .slice(0, 16);
  const pointer = roomId
    ? `AI Hub room \`${roomId}\`（${roomName || roomId}），消息 \`${topicMessageId}\` 到 \`${summaryMessageId}\`，round \`${roundId}\`。`
    : `AI Hub 消息 \`${topicMessageId}\` 到 \`${summaryMessageId}\`，round \`${roundId}\`。`;
  return {
    slug: `idea-${date}-${digest}`,
    title: `Idea 讨论：${prompt.slice(0, 120)}`,
    tags: ['日记', 'ai-hub', 'idea-discussion', topicLabel],
    source: 'ai-hub-triage',
    content: [
      '## 主题',
      '',
      prompt,
      '',
      '## 元数据',
      '',
      `- 完成日期：${date}（Asia/Shanghai）`,
      `- Idea event：\`${id}\``,
      `- 主题分类：\`${topicLabel}\``,
      `- Room：\`${roomId}\`（${roomName || roomId}）`,
      `- Topic message：\`${topicMessageId}\``,
      `- Summary message：\`${summaryMessageId}\``,
      `- Round：\`${roundId}\``,
      '',
      '## 参与概况',
      '',
      `- 邀请：${targets.length ? targets.join('、') : '未记录'}`,
      `- 实际发言：${participants.length ? participants.join('、') : '未记录'}`,
      `- 轮次统计：${outcome ? stableJson(outcome) : '未记录'}`,
      '',
      '## DS 收尾总结',
      '',
      wrapUp,
      '',
      '## 完整对话位置',
      '',
      pointer,
    ].join('\n'),
  };
}

export function normalizeOutcomeConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    intervalMinutes: integerConfig(
      config.intervalMinutes,
      5,
      'outcomes.intervalMinutes',
      1,
      24 * 60,
    ),
    maxAgeDays: integerConfig(config.maxAgeDays, 30, 'outcomes.maxAgeDays', 1, 365),
    batchSize: integerConfig(config.batchSize, 50, 'outcomes.batchSize', 1, 200),
  };
}

// Explicit stop-delivery only (stop sending / reminding / pushing / dispatching).
// Gaps must stay inside one sentence: never cross 。！？； or .!?; or newlines.
// .{0,N} previously glued "不要…。" with a later "派" and mislabeled engineering
// instructions as rejected (M1 false positive, delivery_id=24).
const EXPLICIT_REJECTION_PATTERNS = [
  // With 再: 别再发了 / 不要再提醒我 / 不要再发这种提醒了 / 不要再派这种任务了
  /(?:别|不要|不用|停止|取消|关掉)[^。！？；\n\r]{0,8}再[^。！？；\n\r]{0,6}(?:发|推送|提醒|派|叫|打扰)/u,
  // Without 再 but clear delivery targets: 别推送这个 / 停止推送 / 取消提醒 / 别打扰 / 不要派单
  /(?:别|不要|不用|停止|取消|关掉)[^。！？；\n\r]{0,6}(?:推送|派单|提醒|打扰|叫我|主动(?:发|推送|提醒|消息|派)|发了|发这个|发这种|发这些|发消息)/u,
  // 别再/不要再 + messaging object (still sentence-bounded)
  /(?:别再|不要再|不用再)[^。！？；\n\r]{0,20}(?:这个|这种|这些|类似)?(?:消息|提醒|派单|主动消息)/u,
  // English: do not / stop / never + delivery verb, no cross-sentence glue
  /\b(?:do not|don't|dont|stop|never)\b[^.!?;\n\r]{0,30}\b(?:send|notify|remind|dispatch|message|ping)\b/iu,
];

export function classifyOutcomeMessage(message) {
  if (!message || message.sender !== 'user' || message.role !== 'user') return null;
  if (message.status && message.status !== 'done') return null;
  let meta = message.meta ?? {};
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      meta = {};
    }
  }
  if (meta?.automation || meta?.automated || meta?.uiHidden) return null;
  const content = String(message.content ?? '').trim();
  if (!content) return null;
  return EXPLICIT_REJECTION_PATTERNS.some((pattern) => pattern.test(content))
    ? OUTCOME_LABEL_REJECTED
    : OUTCOME_LABEL_ENGAGED;
}

export function isTaskCompletionMessage(message, taskPath) {
  if (!message || message.sender === 'user' || (message.status && message.status !== 'done')) {
    return false;
  }
  const exactPath = String(taskPath ?? '').trim();
  if (!exactPath) return false;
  const content = String(message.content ?? '');
  return content.includes(`已更新并归档：${exactPath} → done`)
    || content.includes(`已更新：${exactPath} → done`);
}

export function linkedReworkTail(taskPath, eventIdValue, tails = []) {
  const taskNeedle = String(taskPath ?? '').trim();
  const eventNeedle = String(eventIdValue ?? '').trim();
  if (!taskNeedle && !eventNeedle) return null;
  return tails.find((tail) => {
    const content = String(tail?.content ?? '');
    return (taskNeedle && content.includes(taskNeedle))
      || (eventNeedle && content.includes(eventNeedle));
  }) ?? null;
}

export function ideaPolicyState(idea, usage = {}) {
  const config = normalizeIdeaConfig(idea);
  const count = Math.max(0, Number(usage.count ?? 0));
  return {
    poolFull: !config.enabled
      || !config.roomId
      || config.dailyDispatchLimit <= 0
      || count >= config.dailyDispatchLimit,
  };
}

export function coordinationPolicyState(coordination, usage = {}) {
  const config = normalizeCoordinationConfig(coordination);
  const count = Math.max(0, Number(usage.count ?? 0));
  return {
    count,
    remaining: Math.max(0, config.dailyLimit - count),
    poolFull: !config.enabled
      || !config.roomId
      || !config.tasksDir
      || config.dailyLimit <= 0
      || count >= config.dailyLimit,
  };
}

export function dailyPolicyState(proactive, usage = {}, now = Date.now(), options = {}) {
  const config = normalizeProactiveConfig(proactive);
  const count = Math.max(0, Number(usage.count ?? 0));
  const lastAt = usage.lastAt === null || usage.lastAt === undefined
    ? null
    : Number.isFinite(Number(usage.lastAt)) ? Number(usage.lastAt) : null;
  const gapMs = config.minimumGapMinutes * 60_000;
  // Marked date-events (birthday/anniversary) clear only the minimum-gap gate and
  // force an actionable slot. Silent hours and the daily hard pool cap still apply.
  const hasTodayDateEvent = options.hasTodayDateEvent === true;
  const gapBlocked = !hasTodayDateEvent
    && lastAt !== null
    && gapMs > 0
    && now - lastAt < gapMs;
  const forceActionable = config.enabled && (
    hasTodayDateEvent
    || (
      count < config.minDailyDispatches
      && shanghaiClock(now).hour >= config.forceAfterHour
    )
  );
  return {
    poolFull: !config.enabled || config.dailyDispatchLimit <= 0 || count >= config.dailyDispatchLimit,
    gapBlocked,
    forceActionable,
    hasTodayDateEvent,
  };
}

export function validateTriageMode(result, {
  mode = 'task',
  dailyRecipients = DEFAULT_DAILY_RECIPIENTS,
  forceActionable = false,
  allowedTaskPaths = null,
} = {}) {
  if (mode !== 'daily') {
    if (result.category === 'daily') {
      throw new Error('task triage cannot return category daily');
    }
    if (Array.isArray(allowedTaskPaths)) {
      const allowed = new Set(allowedTaskPaths);
      if (result.actionable && (!result.taskPath || !allowed.has(result.taskPath))) {
        throw new Error('actionable backlog triage must choose an exact allowed taskPath');
      }
      if (!result.actionable && result.taskPath !== null) {
        throw new Error('NO_OP backlog triage must not choose a taskPath');
      }
    }
    return result;
  }
  if (result.category !== 'daily') throw new Error('daily triage must return category daily');
  const allowed = new Set(dailyRecipients.map((item) => String(item).trim().toLowerCase()));
  if (result.actionable) {
    const recipient = String(result.suggestedRecipient ?? '').trim().toLowerCase();
    if (!recipient || !allowed.has(recipient)) {
      throw new Error('actionable daily triage must choose an allowed recipient');
    }
  } else if (result.suggestedRecipient !== null) {
    throw new Error('NO_OP daily triage must not choose a recipient');
  }
  if (forceActionable && !result.actionable) {
    throw new Error('guaranteed daily slot must be actionable');
  }
  return result;
}

export function buildDailyCheckSummary(source = {}, now = Date.now(), options = {}) {
  const clock = shanghaiClock(now);
  const proactive = normalizeProactiveConfig(options.proactive ?? {});
  const base = typeof source.summary === 'string' && source.summary.trim()
    ? source.summary.trim()
    : 'Proactive daily companion check for User.';
  const recipients = Array.isArray(source.recipients) && source.recipients.length
    ? source.recipients.join(', ')
    : DEFAULT_DAILY_RECIPIENTS.join(', ');
  const todayDateEvents = Array.isArray(options.todayDateEvents) ? options.todayDateEvents : [];
  const upcomingDateEvents = Array.isArray(options.upcomingDateEvents)
    ? options.upcomingDateEvents
    : [];
  const hasFallbackFollowup = options.hasFallbackFollowup === true;
  const lines = [
    base,
    `Current local time: ${clock.label}.`,
    `Quiet hours are ${String(proactive.silentStartHour).padStart(2, '0')}:00–`
      + `${String(proactive.silentEndHour).padStart(2, '0')}:00 Asia/Shanghai; this wake should only fire outside that window.`,
    'Decide whether a proactive message to User is worthwhile right now.',
    'Allowed intents: care/health/routine nudges, practical reminders, light chat openers, or small affectionate check-ins.',
  ];
  if (todayDateEvents.length) {
    const details = todayDateEvents.map((event) => {
      const years = Number.isFinite(event.yearsSince) && event.yearsSince >= 0
        ? ` (year ${event.yearsSince} / 第 ${event.yearsSince} 年)`
        : '';
      return `${event.label || event.key}${years}`;
    }).join('; ');
    lines.push(
      `TODAY IS A MARKED DATE: ${details}. Build the message around this event — do not ask about meals, water, or generic routine.`,
    );
  }
  if (upcomingDateEvents.length) {
    const details = upcomingDateEvents.map((event) => {
      const when = event.daysUntil === 1 ? 'tomorrow' : `in ${event.daysUntil} days`;
      return `${event.label || event.key} (${when}, ${event.matchDate || event.date})`;
    }).join('; ');
    lines.push(`Upcoming marked dates within 3 days: ${details}.`);
  }
  if (hasFallbackFollowup) {
    lines.push(
      'UNFINISHED FOLLOWUP FROM LAST NIGHT EXISTS. Details stay local and will be attached only for the final companion dispatch.',
    );
  }
  if (todayDateEvents.length && hasFallbackFollowup) {
    lines.push(
      'This wake has both a marked date and an unfinished followup: include both naturally; actionable must be true; do not NO_OP.',
    );
  } else if (todayDateEvents.length) {
    lines.push(
      'This wake has a marked date event: choose one natural message centered on that event; actionable must be true; do not NO_OP.',
    );
  } else if (hasFallbackFollowup) {
    lines.push('This wake has an unfinished followup from last night: center the message on it; actionable must be true; do not NO_OP.');
  } else if (options.forceActionable) {
    lines.push('This is the guaranteed daily slot: choose one natural, low-pressure message instead of NO_OP.');
  } else {
    lines.push('Be selective — not every wake needs a message. Prefer NO_OP when nothing natural fits.');
  }
  lines.push(
    `If actionable, set category to "daily" and choose exactly one suggestedRecipient among: ${recipients}.`,
    'Route by tone and relationship fit; do not invent other recipients.',
  );
  return lines.join('\n');
}

export function summarizeTaskContext(value, maxChars = 800, maxItems = 5) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = lines.find((line) => line.startsWith('任务快照日期：'));
  const tasks = lines.filter((line) => line.startsWith('- **')).slice(0, maxItems);
  const summary = [header, ...tasks].filter(Boolean).join('\n');
  return (summary || text).slice(0, Math.max(100, Number(maxChars) || 800));
}

const TASK_SNAPSHOT_LINE_RE = /^- \*\*(.+?)\*\*\s+\(`?(tasks\/[^)`\s]+\.md)`?\)(.*)$/i;
const AUTONOMOUS_TAIL_PATH_RE = /^tasks\/(?:worker-tail-|deploy-)/i;

/**
 * 将 get_task_context 的 Markdown 快照变成可自主派单清单。
 *
 * worker/deploy tail 是交接凭证，不是一个全新需求；未来任务也不应被
 * quarter-hour-check 提前领取。已经成功派过一次的 taskPath 会由调用方
 * 持久化为 claim，在它从 open 快照消失前都不再出现。
 */
export function buildDispatchableTaskContext(value, {
  claimedTaskPaths = [],
  maxChars = 4000,
  maxItems = 20,
} = {}) {
  const text = String(value ?? '').trim();
  const claimed = new Set(
    (Array.isArray(claimedTaskPaths) ? claimedTaskPaths : [])
      .map((item) => String(item).trim())
      .filter(Boolean),
  );
  const allTaskPaths = [];
  const taskPaths = [];
  const selected = [];
  const ignored = [];
  let section = '';
  let header = '';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!header && line.startsWith('任务快照日期：')) header = line;
    if (line.startsWith('## ')) {
      section = line.slice(3).trim();
      continue;
    }
    const match = line.match(TASK_SNAPSHOT_LINE_RE);
    if (!match) continue;
    const [, title, taskPath, suffix] = match;
    allTaskPaths.push(taskPath);
    const future = /未来\s*7\s*天|future\s*7/i.test(section)
      || /还有\s*[1-9]\d*\s*天/.test(suffix);
    const reason = AUTONOMOUS_TAIL_PATH_RE.test(taskPath)
      ? 'tail'
      : claimed.has(taskPath)
        ? 'claimed'
        : future
          ? 'future'
          : null;
    if (reason) {
      ignored.push({ taskPath, title, reason });
      continue;
    }
    if (taskPaths.length >= Math.max(1, Number(maxItems) || 20)) continue;
    taskPaths.push(taskPath);
    selected.push(line);
  }

  const summary = [header, ...selected].filter(Boolean).join('\n')
    .slice(0, Math.max(200, Number(maxChars) || 4000));
  return {
    summary,
    taskPaths,
    allTaskPaths,
    ignored,
  };
}

export function timerSchedule(source) {
  const intervalMs = Math.max(15 * 60_000, Number(source?.intervalMinutes ?? 15) * 60_000);
  const jitterMs = Math.max(0, Number(source?.jitterSeconds ?? 900) * 1000);
  return { intervalMs, jitterMs };
}

// Jitter is added on top of a full interval instead of sliding inside a fixed
// grid, so two consecutive wakes are never closer than intervalMs. The wall
// clock dedupe bucket in triage-worker.mjs relies on that spacing to stay
// collision free.
export function nextTimerDelay(source, { first = false, random = Math.random } = {}) {
  const { intervalMs, jitterMs } = timerSchedule(source);
  const jitter = Math.floor(random() * (jitterMs + 1));
  return first ? jitter : intervalMs + jitter;
}

export function eventId(event) {
  const explicit = typeof event.id === 'string' ? event.id.trim() : '';
  if (explicit) return explicit.slice(0, 200);
  const dedupe = event.dedupeKey ?? event.payload ?? event.summary ?? '';
  return crypto
    .createHash('sha256')
    .update(`${event.source ?? 'unknown'}\0${stableJson(dedupe)}`)
    .digest('hex');
}

function unquoteFrontmatterValue(value) {
  const text = String(value ?? '').trim();
  if ((text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function parseTaskFrontmatter(text) {
  const frontmatterMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatterMatch) return null;
  const frontmatter = {};
  let listKey = '';
  for (const line of frontmatterMatch[1].split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (match) {
      listKey = match[1].toLowerCase();
      const value = unquoteFrontmatterValue(match[2]);
      if (!value) {
        frontmatter[listKey] = [];
      } else if (value.startsWith('[') && value.endsWith(']')) {
        frontmatter[listKey] = value.slice(1, -1)
          .split(',')
          .map((item) => unquoteFrontmatterValue(item))
          .filter(Boolean);
      } else {
        frontmatter[listKey] = value;
      }
      continue;
    }
    const listItem = line.match(/^\s*-\s+(.+?)\s*$/);
    if (listItem && listKey && Array.isArray(frontmatter[listKey])) {
      frontmatter[listKey].push(unquoteFrontmatterValue(listItem[1]));
    }
  }
  return frontmatter;
}

export function taskReminderRoomRoute(raw, { roomTags = DEFAULT_COORDINATION_REMINDER_ROOM_TAGS } = {}) {
  const frontmatter = parseTaskFrontmatter(String(raw ?? ''));
  if (!frontmatter) return { route: 'main', executor: '', verifier: '', tags: [] };
  const executor = String(frontmatter.executor ?? '').trim().toLowerCase();
  const verifier = String(frontmatter.verifier ?? '').trim().toLowerCase();
  const tags = (Array.isArray(frontmatter.tags) ? frontmatter.tags : [frontmatter.tags])
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);
  const configuredTags = new Set((Array.isArray(roomTags) ? roomTags : [])
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean));
  return {
    route: executor || verifier || tags.some((tag) => configuredTags.has(tag)) ? 'room' : 'main',
    executor,
    verifier,
    tags,
  };
}

function normalizeTaskPath(taskPath) {
  const normalized = String(taskPath).trim().replaceAll('\\', '/');
  return /^tasks\/[^/]+\.md$/i.test(normalized) ? normalized : '';
}

function normalizeTaskDate(value) {
  const date = String(value ?? '').trim();
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const normalized = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  )).toISOString().slice(0, 10);
  return normalized === date ? date : '';
}

export function parseCoordinationTask(raw, { taskPath = '' } = {}) {
  const text = String(raw ?? '');
  const frontmatter = parseTaskFrontmatter(text);
  if (!frontmatter) return null;
  if (String(frontmatter.status ?? '').toLowerCase() !== 'open') return null;
  const executor = String(frontmatter.executor ?? '').trim().toLowerCase();
  if (!executor) return null;

  const planIndex = text.search(/^## Plan（/m);
  if (planIndex < 0) return null;
  const planTail = text.slice(planIndex);
  const firstBreak = planTail.indexOf('\n');
  const remainder = firstBreak >= 0 ? planTail.slice(firstBreak + 1) : '';
  const nextHeader = remainder.search(/^##\s+/m);
  const plan = (nextHeader >= 0
    ? planTail.slice(0, firstBreak + 1 + nextHeader)
    : planTail).trim();
  const workspaceSectionIndex = plan.search(/^### 执行者与工作区\s*$/m);
  const workspaceScope = workspaceSectionIndex >= 0 ? plan.slice(workspaceSectionIndex) : plan;
  const branch = workspaceScope.match(/(?:checkout\s+-b|switch\s+-c)\s+`?([A-Za-z0-9._/-]+)/i)?.[1] ?? '';
  const workspace = [...workspaceScope.matchAll(/`((?:[A-Za-z]:[\\/]|\/)[^`\r\n]+)`/g)]
    .map((match) => match[1].trim().replaceAll('\\', '/'))
    .find(Boolean) ?? '';
  if (!branch || !workspace) return null;

  const normalizedTaskPath = normalizeTaskPath(taskPath);
  if (!normalizedTaskPath) return null;
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? normalizedTaskPath;
  const planHash = crypto.createHash('sha256')
    .update(plan.replace(/\r\n/g, '\n'))
    .digest('hex');
  return {
    taskPath: normalizedTaskPath,
    title,
    executor,
    workspace,
    branch,
    planHash,
  };
}

export function parseVerificationTask(raw, { taskPath = '' } = {}) {
  const text = String(raw ?? '');
  const frontmatter = parseTaskFrontmatter(text);
  if (!frontmatter || String(frontmatter.status ?? '').toLowerCase() !== 'open') return null;
  const verifier = String(frontmatter.verifier ?? '').trim().toLowerCase();
  const due = normalizeTaskDate(frontmatter.due);
  const normalizedTaskPath = normalizeTaskPath(taskPath);
  if (!verifier || !due || !normalizedTaskPath) return null;
  return {
    taskPath: normalizedTaskPath,
    title: text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? normalizedTaskPath,
    verifier,
    due,
  };
}

export function coordinationWorkerPrompt(task) {
  return [
    '[AI_HUB_COORDINATION_V1]',
    `taskPath=${task.taskPath}`,
    `planHash=${task.planHash}`,
    '先通过 memory-vault read_file 读取上面的任务文件。只执行其中已批准的 ## Plan 区块；不要把群聊转述扩写成新需求。',
    `工作区必须是 ${task.workspace}；目标分支必须是 ${task.branch}。`,
    '按任务文件逐条运行验证；验证通过才提交。push、部署或外部副作用仍遵守宿主 exact-target 授权。',
    '最终回执必须给出 git HEAD/分支/工作树、真实测试结果、push/部署状态，以及 worker-tail 是否存在。',
  ].join('\n');
}

export function formatCoordinationDispatchBlock(task) {
  const prompt = coordinationWorkerPrompt(task);
  return [
    `@${task.executor} 工作对接派单：${task.title}`,
    `任务文件：${task.taskPath}`,
    `目标分支：${task.branch}`,
    `PC workspace：${task.workspace}`,
    '',
    `请先在群里回复「接单 ${task.taskPath}」；随后立即调用 delegate_to_worker。`,
    'runner 必须按你自己的后端映射：Claude→claude，Codex/GPT→codex，Grok→grok；workspace 使用上面的固定值。',
    'delegate_to_worker.prompt 必须逐字使用下面模板，不允许改写成自由文本任务描述：',
    '---BEGIN FIXED PROMPT---',
    prompt,
    '---END FIXED PROMPT---',
    `执行回执回来后在群里回复「PASS ${task.taskPath}」或写清 blocker；不要自行替 User 关闭任务。room-host 会贴结构化回执并 @claude review。`,
  ].join('\n');
}

export function formatVerificationDispatchBlock(task) {
  return [
    `@${task.verifier} 验收派单：${task.title}`,
    `任务文件：${task.taskPath}`,
    `到期日：${task.due}（上海日界）`,
    '',
    '本单只读：不改代码，不部署。',
    '先通过 memory-vault read_file 读取任务文件，按其中验收标准逐条取证。',
    '把证据写回任务 note；随后在群内按固定格式回复：',
    `验收结论 PASS/FAIL/样本不足 + ${task.taskPath}`,
    '不得将任务置 done，不得改期，不得作废；三项处置权只属于 User。',
  ].join('\n');
}

export function formatTaskReminderRoomNotice(reminder) {
  return [
    `任务催办：${reminder.title}`,
    reminder.summary,
    `任务文件：${reminder.taskPath}`,
    '这是纯通告，不需要群成员接单。',
  ].join('\n');
}

export function normalizeEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('event must be an object');
  const source = boundedText(event.source ?? 'unknown', 100);
  const summary = boundedText(event.summary ?? event.payload ?? '', 20_000);
  if (!summary) throw new Error('event must carry real context in summary or payload');
  return {
    id: eventId(event),
    source,
    summary,
    payload: event.payload ?? null,
    categoryHint: boundedText(event.categoryHint ?? '', 80) || null,
    createdAt: Number.isFinite(event.createdAt) ? Number(event.createdAt) : Date.now(),
  };
}

export function parseTriageJson(raw, categories = DEFAULT_CATEGORIES) {
  if (typeof raw !== 'string') throw new Error('triage response must be text');
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('triage response did not contain a JSON object');
  const value = JSON.parse(text.slice(start, end + 1));
  if (typeof value.actionable !== 'boolean') throw new Error('triage actionable must be boolean');
  if (typeof value.needsLocalExec !== 'boolean') {
    throw new Error('triage needsLocalExec must be boolean');
  }
  if (!categories.includes(value.category)) throw new Error(`triage category is invalid: ${value.category}`);
  if (![1, 2, 3].includes(value.priority)) throw new Error('triage priority must be 1, 2, or 3');
  if (
    value.suggestedRecipient !== null
    && value.suggestedRecipient !== undefined
    && (typeof value.suggestedRecipient !== 'string' || !value.suggestedRecipient.trim())
  ) {
    throw new Error('triage suggestedRecipient must be a non-empty string or null');
  }
  if (typeof value.rationale !== 'string' || !value.rationale.trim()) {
    throw new Error('triage rationale must be a non-empty string');
  }
  return {
    actionable: value.actionable,
    needsLocalExec: value.needsLocalExec,
    category: value.category,
    priority: value.priority,
    suggestedRecipient: value.suggestedRecipient?.trim().slice(0, 200) || null,
    rationale: value.rationale.trim().slice(0, 1000),
    taskPath: typeof value.taskPath === 'string' && value.taskPath.trim()
      ? value.taskPath.trim().replaceAll('\\', '/').slice(0, 500)
      : null,
  };
}

export function estimateCostCny(usage, pricing = {}) {
  const input = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const output = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
  const inputRate = Number(pricing.inputCnyPerMillion ?? 0);
  const outputRate = Number(pricing.outputCnyPerMillion ?? 0);
  if (![input, output, inputRate, outputRate].every(Number.isFinite)) return 0;
  return (input * inputRate + output * outputRate) / 1_000_000;
}

export function contactRoute(contact) {
  const raw = contact?.config?.routing;
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null;
  const categories = Array.isArray(raw.categories)
    ? raw.categories.filter((item) => typeof item === 'string')
    : [];
  return {
    recipientKey: typeof raw.recipientKey === 'string' && raw.recipientKey.trim()
      ? raw.recipientKey.trim()
      : contact.id,
    categories,
    minPriority: [1, 2, 3].includes(Number(raw.minPriority)) ? Number(raw.minPriority) : 1,
    dailyLimit: Number.isFinite(Number(raw.dailyLimit))
      ? Math.max(1, Math.min(1000, Number(raw.dailyLimit)))
      : 10,
    cooldownMinutes: Number.isFinite(Number(raw.cooldownMinutes))
      ? Math.max(0, Math.min(24 * 60, Number(raw.cooldownMinutes)))
      : 30,
    fallback: raw.fallback === true,
  };
}

function contactKeys(contact) {
  const route = contactRoute(contact);
  return new Set([
    contact?.id,
    contact?.name,
    route?.recipientKey,
  ].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim().toLowerCase()));
}

export function chooseRecipient({
  contacts,
  result,
  rules = {},
  usageOf = () => ({ count: 0, lastAt: null }),
  now = Date.now(),
  allowedRecipientKeys = null,
  ignoreRecipientLimits = false,
  modelOnly = false,
}) {
  const allowed = Array.isArray(allowedRecipientKeys) && allowedRecipientKeys.length
    ? new Set(allowedRecipientKeys.map((item) => String(item).trim().toLowerCase()).filter(Boolean))
    : null;
  // modelOnly (daily proactive): never let the static rules table override L1.
  const target = modelOnly
    ? (result.suggestedRecipient ?? null)
    : (rules[result.category] ?? result.suggestedRecipient ?? null);
  const targetKey = typeof target === 'string' ? target.trim().toLowerCase() : null;
  const candidates = contacts
    .filter((contact) => contact?.enabled !== false)
    .filter((contact) => (
      result.needsLocalExec !== true
      || contact.config?.delegation?.enabled === true
    ))
    .map((contact) => ({ contact, route: contactRoute(contact) }))
    .filter(({ contact, route }) => {
      const keys = contactKeys(contact);
      if (allowed) {
        const inAllow = [...keys].some((key) => allowed.has(key));
        if (!inAllow) return false;
      }
      if (targetKey && keys.has(targetKey)) return true;
      if (modelOnly) return false;
      return route
        && route.categories.includes(result.category)
        && result.priority >= route.minPriority;
    })
    .sort((a, b) => {
      const aTarget = targetKey && contactKeys(a.contact).has(targetKey) ? 0 : 1;
      const bTarget = targetKey && contactKeys(b.contact).has(targetKey) ? 0 : 1;
      if (aTarget !== bTarget) return aTarget - bTarget;
      const aBusy = a.contact.state && a.contact.state !== 'idle' ? 1 : 0;
      const bBusy = b.contact.state && b.contact.state !== 'idle' ? 1 : 0;
      return aBusy - bBusy;
    });

  let busy = false;
  let limited = false;
  for (const candidate of candidates) {
    const { contact, route } = candidate;
    if (contact.state && contact.state !== 'idle') {
      busy = true;
      continue;
    }
    const policy = route ?? {
      dailyLimit: 10,
      cooldownMinutes: 30,
    };
    if (!ignoreRecipientLimits) {
      const usage = usageOf(contact.id);
      const cooldownMs = policy.cooldownMinutes * 60_000;
      if (usage.count >= policy.dailyLimit || (usage.lastAt && now - usage.lastAt < cooldownMs)) {
        limited = true;
        continue;
      }
    }
    return {
      contact,
      route: policy,
      reason: targetKey ? (modelOnly ? 'model-suggestion' : 'explicit-or-rule') : 'category-profile',
    };
  }
  return {
    contact: null,
    reason: busy ? 'all-candidates-busy' : limited ? 'all-candidates-rate-limited' : 'no-route',
  };
}

export class TriageStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.closed = false;
    this.db = new DatabaseSync(path.resolve(file));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS triage_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT,
        category_hint TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        triage_result TEXT,
        recipient_id TEXT,
        error TEXT,
        cost_cny REAL NOT NULL DEFAULT 0,
        triage_latency_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_triage_events_claim
        ON triage_events(status, next_attempt_at, created_at);
      CREATE TABLE IF NOT EXISTS triage_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        delivered_at INTEGER NOT NULL,
        pool TEXT NOT NULL DEFAULT 'task',
        message_id INTEGER,
        executed_via TEXT NOT NULL DEFAULT 'none'
          CHECK(executed_via IN ('contact', 'worker', 'none')),
        FOREIGN KEY(event_id) REFERENCES triage_events(id)
      );
      CREATE INDEX IF NOT EXISTS idx_triage_deliveries_recipient
        ON triage_deliveries(recipient_id, delivered_at);
      CREATE TABLE IF NOT EXISTS triage_source_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS triage_vault_outbox (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        event_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        FOREIGN KEY(event_id) REFERENCES triage_events(id)
      );
      CREATE INDEX IF NOT EXISTS idx_triage_vault_outbox_claim
        ON triage_vault_outbox(status, next_attempt_at, created_at);
      CREATE TABLE IF NOT EXISTS triage_outcomes (
        delivery_id INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL,
        label TEXT NOT NULL CHECK(label IN ('unknown', 'engaged', 'accepted', 'reworked', 'rejected')),
        evidence TEXT NOT NULL DEFAULT '{}',
        labeled_at INTEGER NOT NULL,
        FOREIGN KEY(delivery_id) REFERENCES triage_deliveries(id),
        FOREIGN KEY(event_id) REFERENCES triage_events(id)
      );
      CREATE INDEX IF NOT EXISTS idx_triage_outcomes_label
        ON triage_outcomes(label, labeled_at);
      CREATE TABLE IF NOT EXISTS triage_followups (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        activity TEXT NOT NULL,
        return_commitment TEXT,
        expected_minutes INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'queued', 'dispatched', 'cancelled', 'expired')),
        recipient_key TEXT,
        event_id TEXT,
        cancel_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        fallback_reminded_at INTEGER,
        UNIQUE(contact_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_triage_followups_due
        ON triage_followups(status, due_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_triage_followups_contact
        ON triage_followups(contact_id, status, created_at);
    `);
    const columns = new Set(
      this.db.prepare('PRAGMA table_info(triage_events)').all().map((column) => column.name),
    );
    if (!columns.has('triage_latency_ms')) {
      this.db.exec('ALTER TABLE triage_events ADD COLUMN triage_latency_ms INTEGER');
    }
    // Existing production DBs were created before pool existed. ALTER first,
    // then create the pool index — CREATE INDEX on a missing column aborts boot.
    const deliveryColumns = new Set(
      this.db.prepare('PRAGMA table_info(triage_deliveries)').all().map((column) => column.name),
    );
    if (!deliveryColumns.has('pool')) {
      this.db.exec(`ALTER TABLE triage_deliveries ADD COLUMN pool TEXT NOT NULL DEFAULT 'task'`);
    }
    if (!deliveryColumns.has('message_id')) {
      this.db.exec('ALTER TABLE triage_deliveries ADD COLUMN message_id INTEGER');
    }
    if (!deliveryColumns.has('executed_via')) {
      this.db.exec(`ALTER TABLE triage_deliveries ADD COLUMN executed_via TEXT NOT NULL DEFAULT 'none'`);
    }
    const followupColumns = new Set(
      this.db.prepare('PRAGMA table_info(triage_followups)').all().map((column) => column.name),
    );
    if (!followupColumns.has('return_commitment')) {
      this.db.exec('ALTER TABLE triage_followups ADD COLUMN return_commitment TEXT');
    }
    if (!followupColumns.has('fallback_reminded_at')) {
      this.db.exec('ALTER TABLE triage_followups ADD COLUMN fallback_reminded_at INTEGER');
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_triage_deliveries_pool
        ON triage_deliveries(pool, delivered_at);
      CREATE INDEX IF NOT EXISTS idx_triage_deliveries_message
        ON triage_deliveries(message_id)
    `);
  }

  enqueue(input) {
    const event = normalizeEvent(input);
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO triage_events
        (id, source, summary, payload, category_hint, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.source,
      event.summary,
      event.payload === null ? null : stableJson(event.payload),
      event.categoryHint,
      event.createdAt,
      Date.now(),
    );
    return { id: event.id, inserted: result.changes === 1 };
  }

  recoverStale(timeoutMs, now = Date.now()) {
    return this.db.prepare(`
      UPDATE triage_events
      SET status = 'queued', next_attempt_at = ?, updated_at = ?, error = 'recovered stale processing lease'
      WHERE status = 'processing' AND updated_at < ?
    `).run(now, now, now - timeoutMs).changes;
  }

  claim(now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT * FROM triage_events
        WHERE status IN ('queued', 'retry') AND next_attempt_at <= ?
        ORDER BY created_at, id
        LIMIT 1
      `).get(now);
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare(`
        UPDATE triage_events
        SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE id = ?
      `).run(now, row.id);
      this.db.exec('COMMIT');
      return {
        ...row,
        status: 'processing',
        attempts: row.attempts + 1,
        payload: row.payload ? JSON.parse(row.payload) : null,
        triageResult: row.triage_result ? JSON.parse(row.triage_result) : null,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finish(id, status, fields = {}, now = Date.now()) {
    if (!FINAL_STATES.has(status)) throw new Error(`invalid final status: ${status}`);
    this.db.prepare(`
      UPDATE triage_events
      SET status = ?, updated_at = ?, triage_result = ?, recipient_id = ?,
          error = ?, cost_cny = ?, triage_latency_ms = ?
      WHERE id = ?
    `).run(
      status,
      now,
      fields.triageResult ? stableJson(fields.triageResult) : null,
      fields.recipientId ?? null,
      fields.error ? boundedText(fields.error, 2000) : null,
      Number(fields.costCny ?? 0),
      Number.isFinite(Number(fields.triageLatencyMs)) ? Math.max(0, Math.round(Number(fields.triageLatencyMs))) : null,
      id,
    );
  }

  retry(id, error, delayMs, fields = {}, now = Date.now()) {
    this.db.prepare(`
      UPDATE triage_events
      SET status = 'retry', next_attempt_at = ?, updated_at = ?, error = ?,
          triage_result = COALESCE(?, triage_result), cost_cny = ?,
          triage_latency_ms = COALESCE(?, triage_latency_ms)
      WHERE id = ?
    `).run(
      now + Math.max(1000, delayMs),
      now,
      boundedText(error, 2000),
      fields.triageResult ? stableJson(fields.triageResult) : null,
      Number(fields.costCny ?? 0),
      Number.isFinite(Number(fields.triageLatencyMs)) ? Math.max(0, Math.round(Number(fields.triageLatencyMs))) : null,
      id,
    );
  }

  completeIdea(id, {
    roomId,
    triageResult,
    costCny = 0,
    triageLatencyMs = null,
    vaultWrite = null,
  }, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO triage_deliveries (event_id, recipient_id, delivered_at, pool)
        SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM triage_deliveries WHERE event_id = ? AND pool = ?
        )
      `).run(id, roomId, now, DELIVERY_POOL_IDEA, id, DELIVERY_POOL_IDEA);
      if (vaultWrite) {
        this.db.prepare(`
          INSERT OR IGNORE INTO triage_vault_outbox
            (id, kind, event_id, dedupe_key, payload, created_at, updated_at)
          VALUES (?, 'idea-diary', ?, ?, ?, ?, ?)
        `).run(
          vaultWrite.id,
          id,
          vaultWrite.dedupeKey,
          stableJson(vaultWrite.payload),
          now,
          now,
        );
      }
      this.db.prepare(`
        UPDATE triage_events
        SET status = 'dispatched', updated_at = ?, triage_result = ?, recipient_id = ?,
            error = NULL, cost_cny = ?, triage_latency_ms = ?
        WHERE id = ?
      `).run(
        now,
        stableJson(triageResult),
        roomId,
        Number(costCny),
        Number.isFinite(Number(triageLatencyMs))
          ? Math.max(0, Math.round(Number(triageLatencyMs)))
          : null,
        id,
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recoverStaleVaultWrites(timeoutMs, now = Date.now()) {
    return this.db.prepare(`
      UPDATE triage_vault_outbox
      SET status = 'retry', next_attempt_at = ?, updated_at = ?,
          error = 'recovered stale vault outbox lease'
      WHERE status = 'processing' AND updated_at < ?
    `).run(now, now, now - timeoutMs).changes;
  }

  claimVaultWrite(now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT * FROM triage_vault_outbox
        WHERE status IN ('pending', 'retry') AND next_attempt_at <= ?
        ORDER BY created_at, id
        LIMIT 1
      `).get(now);
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare(`
        UPDATE triage_vault_outbox
        SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE id = ?
      `).run(now, row.id);
      this.db.exec('COMMIT');
      return {
        ...row,
        status: 'processing',
        attempts: Number(row.attempts) + 1,
        payload: JSON.parse(row.payload),
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  retryVaultWrite(id, error, delayMs, now = Date.now()) {
    this.db.prepare(`
      UPDATE triage_vault_outbox
      SET status = 'retry', next_attempt_at = ?, updated_at = ?, error = ?
      WHERE id = ?
    `).run(
      now + Math.max(1000, Number(delayMs) || 0),
      now,
      boundedText(error, 2000),
      id,
    );
  }

  finishVaultWrite(id, now = Date.now()) {
    this.db.prepare(`
      UPDATE triage_vault_outbox
      SET status = 'done', updated_at = ?, completed_at = ?, error = NULL
      WHERE id = ?
    `).run(now, now, id);
  }

  recordDelivery(
    eventIdValue,
    recipientId,
    now = Date.now(),
    pool = DELIVERY_POOL_TASK,
    outcome = null,
  ) {
    const normalizedPool = DELIVERY_POOLS.has(pool) ? pool : DELIVERY_POOL_TASK;
    const messageId = Number.isInteger(Number(outcome?.messageId))
      ? Number(outcome.messageId)
      : null;
    const executedVia = EXECUTED_VIA_SET.has(outcome?.executedVia)
      ? outcome.executedVia
      : EXECUTED_VIA_NONE;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare(`
        INSERT INTO triage_deliveries
          (event_id, recipient_id, delivered_at, pool, message_id, executed_via)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(eventIdValue, recipientId, now, normalizedPool, messageId, executedVia);
      const deliveryId = Number(result.lastInsertRowid);
      if (messageId !== null) {
        this.db.prepare(`
          INSERT INTO triage_outcomes (delivery_id, event_id, label, evidence, labeled_at)
          VALUES (?, ?, 'unknown', ?, ?)
        `).run(
          deliveryId,
          eventIdValue,
          stableJson({
            anchorMessageId: messageId,
            cursorMessageId: messageId,
            taskPath: outcome?.taskPath ?? null,
          }),
          now,
        );
      }
      this.db.exec('COMMIT');
      return deliveryId;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordOutcome(deliveryId, label, evidence = {}, now = Date.now()) {
    if (!OUTCOME_LABEL_SET.has(label)) throw new Error(`invalid outcome label: ${label}`);
    const current = this.db.prepare(`
      SELECT label FROM triage_outcomes WHERE delivery_id = ?
    `).get(deliveryId);
    if (!current) throw new Error(`outcome delivery not found: ${deliveryId}`);
    const currentPriority = OUTCOME_LABEL_PRIORITY.get(current.label) ?? -1;
    const nextPriority = OUTCOME_LABEL_PRIORITY.get(label) ?? -1;
    if (nextPriority < currentPriority || (nextPriority === currentPriority && label !== current.label)) {
      return false;
    }
    this.db.prepare(`
      UPDATE triage_outcomes
      SET label = ?, evidence = ?, labeled_at = ?
      WHERE delivery_id = ?
    `).run(label, stableJson(evidence), now, deliveryId);
    return true;
  }

  outcomeCandidates({ since = 0, limit = 50 } = {}) {
    const rows = this.db.prepare(`
      SELECT
        o.delivery_id, o.event_id, o.label, o.evidence, o.labeled_at,
        d.recipient_id, d.delivered_at, d.message_id, d.pool, d.executed_via,
        e.triage_result
      FROM triage_outcomes o
      JOIN triage_deliveries d ON d.id = o.delivery_id
      JOIN triage_events e ON e.id = o.event_id
      WHERE d.message_id IS NOT NULL
        AND d.delivered_at >= ?
        AND o.label NOT IN ('reworked', 'rejected')
      ORDER BY d.delivered_at ASC, o.delivery_id ASC
      LIMIT ?
    `).all(Math.max(0, Number(since) || 0), Math.max(1, Number(limit) || 50));
    return rows.map((row) => ({
      ...row,
      delivery_id: Number(row.delivery_id),
      delivered_at: Number(row.delivered_at),
      message_id: Number(row.message_id),
      labeled_at: Number(row.labeled_at),
      evidence: JSON.parse(row.evidence || '{}'),
      triageResult: row.triage_result ? JSON.parse(row.triage_result) : null,
    }));
  }

  outcomeSummary() {
    const rows = this.db.prepare(`
      SELECT label, COUNT(*) AS count
      FROM triage_outcomes
      GROUP BY label
    `).all();
    const labels = Object.fromEntries(OUTCOME_LABELS.map((label) => [label, 0]));
    for (const row of rows) labels[row.label] = Number(row.count);
    const total = OUTCOME_LABELS.reduce((sum, label) => sum + labels[label], 0);
    const known = total - labels[OUTCOME_LABEL_UNKNOWN];
    const strong = labels[OUTCOME_LABEL_ACCEPTED]
      + labels[OUTCOME_LABEL_REWORKED]
      + labels[OUTCOME_LABEL_REJECTED];
    const last = this.db.prepare(`
      SELECT MAX(labeled_at) AS labeled_at
      FROM triage_outcomes
      WHERE label != 'unknown'
    `).get();
    const byViaRows = this.db.prepare(`
      SELECT
        COALESCE(d.executed_via, 'none') AS executed_via,
        o.label,
        COUNT(*) AS count
      FROM triage_outcomes o
      JOIN triage_deliveries d ON d.id = o.delivery_id
      GROUP BY COALESCE(d.executed_via, 'none'), o.label
    `).all();
    const byExecutedVia = Object.fromEntries(EXECUTED_VIA_VALUES.map((executedVia) => {
      const viaLabels = Object.fromEntries(OUTCOME_LABELS.map((label) => [label, 0]));
      for (const row of byViaRows) {
        if (row.executed_via === executedVia) viaLabels[row.label] = Number(row.count);
      }
      const viaTotal = OUTCOME_LABELS.reduce((sum, label) => sum + viaLabels[label], 0);
      return [executedVia, {
        total: viaTotal,
        labels: viaLabels,
        acceptedRatio: viaTotal ? viaLabels[OUTCOME_LABEL_ACCEPTED] / viaTotal : 0,
        reworkedRatio: viaTotal ? viaLabels[OUTCOME_LABEL_REWORKED] / viaTotal : 0,
      }];
    }));
    return {
      total,
      labels,
      knownCount: known,
      knownRatio: total ? known / total : 0,
      strongCount: strong,
      strongRatio: total ? strong / total : 0,
      unknownRatio: total ? labels[OUTCOME_LABEL_UNKNOWN] / total : 0,
      byExecutedVia,
      lastLabeledAt: last.labeled_at === null
        ? null
        : new Date(Number(last.labeled_at)).toISOString(),
    };
  }

  // Task dispatches use a rolling 24h window and only count the task pool, so
  // proactive daily outreach does not burn per-recipient work quotas.
  recipientUsage(recipientId, now = Date.now(), pool = DELIVERY_POOL_TASK) {
    const since = now - 24 * 60 * 60_000;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count, MAX(delivered_at) AS last_at
      FROM triage_deliveries
      WHERE recipient_id = ? AND delivered_at >= ? AND COALESCE(pool, 'task') = ?
    `).get(recipientId, since, pool);
    return { count: Number(row.count), lastAt: row.last_at === null ? null : Number(row.last_at) };
  }

  // Daily proactive cap is a Shanghai calendar-day total across all recipients.
  poolUsage(pool = DELIVERY_POOL_DAILY, now = Date.now()) {
    const start = shanghaiDayStart(now);
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count, MAX(delivered_at) AS last_at
      FROM triage_deliveries
      WHERE delivered_at >= ? AND COALESCE(pool, 'task') = ?
    `).get(start, pool);
    return {
      count: Number(row.count),
      lastAt: row.last_at === null ? null : Number(row.last_at),
      since: start,
    };
  }

  dailySummary(now = Date.now()) {
    // Business-day metrics are pinned to Asia/Shanghai, independent of host timezone.
    const start = shanghaiDayStart(now);
    const statuses = this.db.prepare(`
      SELECT status, COUNT(*) AS count, COALESCE(SUM(cost_cny), 0) AS cost
      FROM triage_events WHERE created_at >= ? GROUP BY status
    `).all(start);
    const fallback = this.db.prepare(`
      SELECT COUNT(*) AS count FROM triage_events
      WHERE created_at >= ? AND triage_result LIKE '%"fallbackUsed":true%'
    `).get(start);
    const deliveries = this.db.prepare(`
      SELECT recipient_id, COUNT(*) AS count
      FROM triage_deliveries WHERE delivered_at >= ?
      GROUP BY recipient_id ORDER BY count DESC
    `).all(start);
    const poolRows = this.db.prepare(`
      SELECT COALESCE(pool, 'task') AS pool, COUNT(*) AS count
      FROM triage_deliveries WHERE delivered_at >= ?
      GROUP BY COALESCE(pool, 'task')
    `).all(start);
    const coordinationKinds = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN json_extract(events.payload, '$.mode') = 'coordination'
          THEN 1 ELSE 0 END), 0) AS execution_count,
        COALESCE(SUM(CASE WHEN json_extract(events.payload, '$.mode') = 'coordination-verification'
          THEN 1 ELSE 0 END), 0) AS verification_count,
        COALESCE(SUM(CASE WHEN json_extract(events.payload, '$.mode') = 'task-reminder'
          THEN 1 ELSE 0 END), 0) AS reminder_count
      FROM triage_deliveries AS deliveries
      JOIN triage_events AS events ON events.id = deliveries.event_id
      WHERE deliveries.delivered_at >= ?
        AND COALESCE(deliveries.pool, 'task') = ?
    `).get(start, DELIVERY_POOL_COORDINATION);
    const latency = this.db.prepare(`
      SELECT COUNT(*) AS count, AVG(triage_latency_ms) AS average
      FROM triage_events
      WHERE created_at >= ? AND triage_latency_ms IS NOT NULL
    `).get(start);
    const dailyChecks = this.db.prepare(`
      SELECT COUNT(*) AS count,
             SUM(CASE WHEN status = 'noop' THEN 1 ELSE 0 END) AS noop_count
      FROM triage_events
      WHERE created_at >= ? AND triage_result LIKE '%"category":"daily"%'
    `).get(start);
    const ideaChecks = this.db.prepare(`
      SELECT COUNT(*) AS count,
             SUM(CASE WHEN status = 'noop' THEN 1 ELSE 0 END) AS noop_count
      FROM triage_events
      WHERE created_at >= ? AND triage_result LIKE '%"category":"idea"%'
    `).get(start);
    const diaryChecks = this.db.prepare(`
      SELECT COUNT(*) AS count,
             SUM(CASE WHEN status = 'noop' THEN 1 ELSE 0 END) AS noop_count,
             COALESCE(SUM(CASE WHEN status = 'dispatched' THEN 1 ELSE 0 END), 0) AS written_count
      FROM triage_events
      WHERE created_at >= ? AND triage_result LIKE '%"category":"diary"%'
    `).get(start);
    const ideaDiaryOutbox = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('pending', 'processing', 'retry') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retrying,
        SUM(CASE WHEN status = 'done' AND completed_at >= ? THEN 1 ELSE 0 END) AS written
      FROM triage_vault_outbox
      WHERE kind = 'idea-diary'
    `).get(start);
    const ideaDiaryLastError = this.db.prepare(`
      SELECT error FROM triage_vault_outbox
      WHERE kind = 'idea-diary' AND error IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1
    `).get()?.error ?? null;
    const total = statuses.reduce((sum, row) => sum + Number(row.count), 0);
    const noop = statuses.find((row) => row.status === 'noop');
    const pools = Object.fromEntries(poolRows.map((row) => [row.pool, Number(row.count)]));
    const dailyUsage = this.poolUsage(DELIVERY_POOL_DAILY, now);
    const ideaUsage = this.poolUsage(DELIVERY_POOL_IDEA, now);
    const diaryUsage = this.poolUsage(DELIVERY_POOL_DIARY, now);
    return {
      since: new Date(start).toISOString(),
      total,
      noopRatio: total ? Number(noop?.count ?? 0) / total : 0,
      fallbackCount: Number(fallback.count),
      costCny: statuses.reduce((sum, row) => sum + Number(row.cost), 0),
      triagedCount: Number(latency.count),
      avgTriageLatencyMs: latency.average === null ? null : Math.round(Number(latency.average)),
      statuses,
      deliveries,
      pools,
      dailyPoolDispatched: pools[DELIVERY_POOL_DAILY] ?? 0,
      ideaPoolDispatched: pools[DELIVERY_POOL_IDEA] ?? 0,
      coordinationPoolDispatched: pools[DELIVERY_POOL_COORDINATION] ?? 0,
      coordinationExecutionDispatched: Number(coordinationKinds.execution_count),
      coordinationVerificationDispatched: Number(coordinationKinds.verification_count),
      coordinationReminderDispatched: Number(coordinationKinds.reminder_count),
      diaryPoolDispatched: pools[DELIVERY_POOL_DIARY] ?? 0,
      dailyChecks: Number(dailyChecks.count),
      dailyNoops: Number(dailyChecks.noop_count ?? 0),
      ideaChecks: Number(ideaChecks.count),
      ideaNoops: Number(ideaChecks.noop_count ?? 0),
      diaryChecks: Number(diaryChecks.count),
      diaryNoops: Number(diaryChecks.noop_count ?? 0),
      diaryRollups: Number(diaryChecks.written_count ?? 0),
      ideaDiaryPending: Number(ideaDiaryOutbox.pending ?? 0),
      ideaDiaryRetrying: Number(ideaDiaryOutbox.retrying ?? 0),
      ideaDiariesWritten: Number(ideaDiaryOutbox.written ?? 0),
      ideaDiaryLastError,
      outcomes: this.outcomeSummary(),
      lastDailyDeliveryAt: dailyUsage.lastAt === null
        ? null
        : new Date(dailyUsage.lastAt).toISOString(),
      lastIdeaDeliveryAt: ideaUsage.lastAt === null
        ? null
        : new Date(ideaUsage.lastAt).toISOString(),
      lastDiaryRollupAt: diaryUsage.lastAt === null
        ? null
        : new Date(diaryUsage.lastAt).toISOString(),
    };
  }

  recentIdeaTopics(limit = 12) {
    const rows = this.db.prepare(`
      SELECT triage_result FROM triage_events
      WHERE status = 'dispatched' AND triage_result LIKE '%"category":"idea"%'
      ORDER BY updated_at DESC LIMIT ?
    `).all(Math.max(1, Number(limit) || 12));
    return rows.flatMap((row) => {
      try {
        const value = JSON.parse(row.triage_result);
        if (!value?.topic || !value?.ideaCategory) return [];
        return [{
          topic: String(value.topic).slice(0, 500),
          category: String(value.ideaCategory).slice(0, 100),
        }];
      } catch {
        return [];
      }
    });
  }

  getSourceState(key) {
    return this.db.prepare('SELECT value FROM triage_source_state WHERE key = ?').get(key)?.value ?? null;
  }

  setSourceState(key, value, now = Date.now()) {
    this.db.prepare(`
      INSERT INTO triage_source_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, String(value), now);
  }

  insertFollowup({
    id,
    contactId,
    messageId,
    activity,
    returnCommitment = null,
    expectedMinutes,
    dueAt,
    recipientKey = null,
    now = Date.now(),
  }) {
    try {
      this.db.prepare(`
        INSERT INTO triage_followups (
          id, contact_id, message_id, activity, return_commitment, expected_minutes, due_at,
          status, recipient_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        id,
        String(contactId),
        Number(messageId),
        String(activity).slice(0, 80),
        returnCommitment ? String(returnCommitment).slice(0, 120) : null,
        Math.max(1, Number(expectedMinutes) || 30),
        Number(dueAt),
        recipientKey ? String(recipientKey) : null,
        now,
        now,
      );
      return true;
    } catch (error) {
      // UNIQUE(contact_id, message_id) — already tracked.
      if (String(error.message ?? '').includes('UNIQUE')) return false;
      throw error;
    }
  }

  pendingFollowups({ contactId = null, limit = 50 } = {}) {
    if (contactId) {
      return this.db.prepare(`
        SELECT * FROM triage_followups
        WHERE status = 'pending' AND contact_id = ?
        ORDER BY due_at ASC, created_at ASC
        LIMIT ?
      `).all(String(contactId), Math.max(1, Number(limit) || 50));
    }
    return this.db.prepare(`
      SELECT * FROM triage_followups
      WHERE status = 'pending'
      ORDER BY due_at ASC, created_at ASC
      LIMIT ?
    `).all(Math.max(1, Number(limit) || 50));
  }

  expiredFollowupsForFallback({ since = 0, limit = 10 } = {}) {
    return this.db.prepare(`
      SELECT * FROM triage_followups
      WHERE status = 'expired'
        AND fallback_reminded_at IS NULL
        AND updated_at >= ?
      ORDER BY updated_at ASC, created_at ASC
      LIMIT ?
    `).all(Number(since) || 0, Math.max(1, Number(limit) || 10));
  }

  markFollowupsFallbackReminded(ids, now = Date.now()) {
    const values = [...new Set(
      (Array.isArray(ids) ? ids : []).map((id) => String(id).trim()).filter(Boolean),
    )];
    if (!values.length) return 0;
    const placeholders = values.map(() => '?').join(', ');
    return this.db.prepare(`
      UPDATE triage_followups
      SET fallback_reminded_at = ?, updated_at = ?
      WHERE status = 'expired'
        AND fallback_reminded_at IS NULL
        AND id IN (${placeholders})
    `).run(now, now, ...values).changes;
  }

  getFollowup(id) {
    return this.db.prepare('SELECT * FROM triage_followups WHERE id = ?').get(String(id)) ?? null;
  }

  hasOpenFollowupForContact(contactId) {
    const row = this.db.prepare(`
      SELECT 1 AS ok FROM triage_followups
      WHERE contact_id = ? AND status IN ('pending', 'queued')
      LIMIT 1
    `).get(String(contactId));
    return Boolean(row);
  }

  updateFollowupStatus(id, status, {
    cancelReason = null,
    eventId = null,
    now = Date.now(),
  } = {}) {
    const allowed = new Set(['pending', 'queued', 'dispatched', 'cancelled', 'expired']);
    if (!allowed.has(status)) throw new Error(`invalid followup status: ${status}`);
    return this.db.prepare(`
      UPDATE triage_followups
      SET status = ?, cancel_reason = COALESCE(?, cancel_reason),
          event_id = COALESCE(?, event_id), updated_at = ?
      WHERE id = ? AND status IN ('pending', 'queued')
    `).run(
      status,
      cancelReason,
      eventId,
      now,
      String(id),
    ).changes;
  }

  hasDailyDeliverySince(recipientId, since, now = Date.now()) {
    const row = this.db.prepare(`
      SELECT 1 AS ok FROM triage_deliveries
      WHERE recipient_id = ? AND pool = ? AND delivered_at > ? AND delivered_at <= ?
      LIMIT 1
    `).get(String(recipientId), DELIVERY_POOL_DAILY, Number(since), Number(now));
    return Boolean(row);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
