import crypto from 'node:crypto';
import process from 'node:process';
import { verificationDispatchKey, legacyVerificationDispatchKey } from './triage-core.mjs';

/**
 * TriageWorker 各 domain 模块共用的运行时基座：CLI 旗标、结构化日志、
 * 小工具与跨模块 state key 常量。旗标解析基于 process.argv，与主入口
 * 同进程同语义；这里不 parse 配置文件路径（那是主入口的职责）。
 */

export const reminderShadow = process.argv.includes('--reminder-shadow');
export const reminderOnce = process.argv.includes('--task-reminders');
export const once = process.argv.includes('--once') || reminderShadow;
export const metricsOnly = process.argv.includes('--metrics');
/** 手动扫一次待拆分需求：`node triage-worker.mjs --once --sweep` */
export const sweepOnce = process.argv.includes('--sweep');
/** 手动跑一次 Agenda shadow：`node triage-worker.mjs --once --agenda` */
export const agendaOnce = process.argv.includes('--agenda');

export function log(level, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    level,
    time: new Date().toISOString(),
    component: 'triage-worker',
    msg: message,
    ...fields,
  })}\n`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function bearerMatches(header, token) {
  if (!token) return true;
  const actual = Buffer.from(String(header ?? ''));
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function retryDelay(attempt) {
  return Math.min(15 * 60_000, 5000 * (2 ** Math.max(0, attempt - 1)));
}

export const BACKLOG_CLAIMS_KEY = 'backlog-dispatch-claims:v1';
export const DATE_EVENT_CLAIMS_KEY = 'date-event-claims:v1';
// P3 S4: claim key includes updated_at so an escalated event (new update) can
// re-trigger, while the same state never dispatches twice. Per-day counting
// caps runaway churn via safetyEvents.maxPerEventPerDay.
export const SAFETY_EVENT_CLAIMS_KEY = 'safety-event-claims:v1';
export const COORDINATION_SOURCE = 'coordination-sweep';
export const COORDINATION_STATE_KEY = 'coordination:v1';
export const VERIFICATION_MODE = 'coordination-verification';
export const HUB_AUTO_HYGIENE_MODE = 'hub-auto-hygiene';

export function hubAutoHygieneStateKey(date) {
  return `hub-auto-hygiene:v1:${date}`;
}

// v2 state/dispatch keys cover verifier so a reassignment with an unchanged
// due date still re-triggers; legacy v1 keys (due only) are migrated in place
// when the recorded verifier still matches, so the same semantic dispatch
// never fires twice across the upgrade.
export function verificationStateKey(task) {
  return verificationDispatchKey(task);
}

export function legacyVerificationStateKey(task) {
  return legacyVerificationDispatchKey(task);
}
