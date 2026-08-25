import crypto from 'node:crypto';

/**
 * triage 系列共享原语：投递池/结果标签/执行途径常量与派生集合、
 * 稳定 JSON 序列化、事件规范化与上海日界。triage-core（纯函数库）与
 * triage-store（SQLite 账本）都依赖这里，保持无环：shared ← store ← core(仅 re-export)。
 */

export const DELIVERY_POOL_TASK = 'task';
export const DELIVERY_POOL_DAILY = 'daily';
export const DELIVERY_POOL_IDEA = 'idea';
export const DELIVERY_POOL_COORDINATION = 'coordination';
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

export const DELIVERY_POOLS = new Set([
  DELIVERY_POOL_TASK,
  DELIVERY_POOL_DAILY,
  DELIVERY_POOL_IDEA,
  DELIVERY_POOL_COORDINATION,
  DELIVERY_POOL_DIARY,
]);
export const EXECUTED_VIA_VALUES = [
  EXECUTED_VIA_CONTACT,
  EXECUTED_VIA_WORKER,
  EXECUTED_VIA_NONE,
];
export const EXECUTED_VIA_SET = new Set(EXECUTED_VIA_VALUES);
export const OUTCOME_LABEL_SET = new Set(OUTCOME_LABELS);
export const OUTCOME_LABEL_PRIORITY = new Map([
  [OUTCOME_LABEL_UNKNOWN, 0],
  [OUTCOME_LABEL_ENGAGED, 1],
  [OUTCOME_LABEL_ACCEPTED, 2],
  [OUTCOME_LABEL_REWORKED, 3],
  [OUTCOME_LABEL_REJECTED, 4],
]);

export const FINAL_STATES = new Set(['noop', 'dispatched', 'parked', 'dead']);
export const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function boundedText(value, max = 20_000) {
  const text = typeof value === 'string' ? value : stableJson(value);
  return text.trim().slice(0, max);
}

export function shanghaiDayStart(now = Date.now()) {
  const shifted = new Date(now + SHANGHAI_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted.getTime() - SHANGHAI_OFFSET_MS;
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
