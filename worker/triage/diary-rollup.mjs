import { parseDiaryEntries } from './triage-core.mjs';

/**
 * 日终日记 rollup 的共享实现：定时源和 diary-backfill.mjs 走同一条链路，
 * 补历史和记当天不会出现两套行为。
 *
 * 设计约束：
 * - 日记条目一旦写进 vault 就是 User 的记忆，宁可整天跳过也不写残缺内容；
 * - 抽取只认 User 自己说过的话，AI 回复只当上下文（prompt 里也再约束一次）；
 * - 判空发生在调模型之前，安静的一天不烧钱。
 */

const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

export function shanghaiWeekday(date) {
  const parsed = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
  }).format(parsed);
  const index = WEEKDAY_EN.indexOf(short);
  return index < 0 ? null : `周${WEEKDAY_CN[index]}`;
}

function line(message) {
  const who = message.role === 'user' ? 'User' : (message.contactName || message.contactId);
  const to = message.role === 'user' ? ` → ${message.contactName || message.contactId}` : '';
  const clipped = message.clipped ? ' …(截断)' : '';
  return `${message.at} | role=${message.role} | ${who}${to}: ${message.content}${clipped}`;
}

export function buildTranscript(messages, { maxChars = 24_000 } = {}) {
  const full = messages.map(line).join('\n');
  if (full.length <= maxChars) return { text: full, dropped: 'none' };
  // 先丢 AI 回复——它们只是上下文，User 的原话是唯一的事实来源，不能被挤掉。
  const userOnly = messages.filter((m) => m.role === 'user').map(line).join('\n');
  if (userOnly.length <= maxChars) return { text: userOnly, dropped: 'assistant' };
  return {
    text: `${userOnly.slice(0, maxChars)}\n…(当天原话过长，已截断)`,
    dropped: 'assistant+tail',
  };
}

/**
 * 结算一天。返回 status:
 * - `written`     成功写入（dryRun 时是「本来会写」）
 * - `thin`        当天对话太少，没到结算门槛
 * - `empty`       模型判定这一天没有值得记的日常
 */
export async function rollupDay({
  date,
  hub,
  deepseek,
  vault,
  config,
  log = () => {},
  dryRun = false,
}) {
  const day = await hub.journalDay(date, config.messageLimit);
  const messages = day.messages;
  const userMessages = messages.filter((m) => m.role === 'user');
  if (messages.length < config.minMessages || userMessages.length < config.minUserMessages) {
    return {
      date,
      status: 'thin',
      reason: `only ${messages.length} messages / ${userMessages.length} from User`,
      entries: [],
      written: 0,
      costCny: 0,
      latencyMs: 0,
    };
  }

  const transcript = buildTranscript(messages, { maxChars: config.transcriptMaxChars });

  // 热闹的一天偶尔会让 Flash 吐出解析不了的 JSON，整批就废了。重试一次比让那一天
  // 永远空着划算——成本是 ¥0.00x，而漏掉的是她真过过的一天。attempt 必须传下去：
  // 客户端据此换一次采样，否则 temperature 0 会原样再吐一遍，重试等于白花钱。
  const attempts = Math.max(1, Number(config.extractAttempts ?? 2));
  let costCny = 0;
  let latencyMs = 0;
  let entries = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const extracted = await deepseek.diaryEntries({
        date,
        weekday: shanghaiWeekday(date),
        transcript: transcript.text,
        maxEntries: config.maxEntries,
        attempt,
      });
      costCny += extracted.costCny;
      latencyMs += extracted.latencyMs;
      entries = parseDiaryEntries({ entries: extracted.result }, { maxEntries: config.maxEntries });
      break;
    } catch (error) {
      lastError = error;
      log('warn', 'diary extraction attempt failed', { date, attempt, error: error.message });
    }
  }
  if (entries === null) throw lastError;

  if (!entries.length) {
    return {
      date,
      status: 'empty',
      reason: 'no diary-worthy entries in this day',
      entries: [],
      written: 0,
      costCny,
      latencyMs,
      truncated: day.truncated,
      dropped: transcript.dropped,
    };
  }

  let written = 0;
  if (!dryRun) {
    for (const entry of entries) {
      await vault.logDaily({
        content: entry.text,
        date,
        time: entry.time,
        source: config.source,
      });
      written += 1;
    }
  }
  log('info', 'diary rollup finished', {
    date,
    entries: entries.length,
    written,
    dryRun,
    costCny,
  });

  return {
    date,
    status: 'written',
    entries,
    written,
    costCny,
    latencyMs,
    truncated: day.truncated,
    dropped: transcript.dropped,
  };
}
