import type { Db } from '../platform/index.js';

export interface WorkflowPoolStatus { blocked: boolean; reason?: string }

/** The only quota fields the pool check reads; the quota pollers' snapshots satisfy them structurally. */
interface QuotaWindowReading { remainingPct: number; resetsAt: string | null }
export interface WorkflowQuotaSources {
  claude(): { reason?: string; fiveHour?: QuotaWindowReading | null; sevenDay?: QuotaWindowReading | null } | null;
  codex(): { fiveHour?: QuotaWindowReading | null; sevenDay?: QuotaWindowReading | null } | null;
  grok(): { reason?: string; weekly?: QuotaWindowReading | null } | null;
}

/** Reads existing telemetry only. An unavailable telemetry endpoint is not an exhausted model. */
export function readWorkflowPools(db: Db, sources: WorkflowQuotaSources, now = Date.now()): Record<string, WorkflowPoolStatus> {
  const pools: Record<string, WorkflowPoolStatus> = {};
  const depleted = (window: { remainingPct: number; resetsAt: string | null } | null | undefined) =>
    !!window && Number.isFinite(window.remainingPct) && window.remainingPct <= 0
      && (!window.resetsAt || Date.parse(window.resetsAt) > now);
  const block = (runner: string, reason: string) => { pools[`credential:${runner}`] = { blocked: true, reason }; };
  try {
    const quota = sources.claude();
    if (quota?.reason === 'login-expired') block('claude', 'Claude 凭据已失效，请重新登录或手动选择其他凭据池。');
    else if (depleted(quota?.fiveHour) || depleted(quota?.sevenDay)) block('claude', 'Claude 共享额度已耗尽，等待重置或手动选择其他凭据池。');
  } catch { /* unknown */ }
  try {
    const quota = sources.grok();
    if (quota?.reason === 'login-expired') block('grok', 'Grok 凭据已失效，请重新登录或手动选择其他凭据池。');
    else if (depleted(quota?.weekly)) block('grok', 'Grok 共享周额度已耗尽，等待重置或手动选择其他凭据池。');
  } catch { /* unknown */ }
  try {
    const quota = sources.codex();
    if (depleted(quota?.fiveHour) || depleted(quota?.sevenDay)) block('codex', 'Codex 共享额度已耗尽，等待重置或手动选择其他凭据池。');
  } catch { /* unknown */ }
  // Back off after an actual runner credential/quota error, including adapters
  // without quota telemetry. A more recent success or five-minute expiry clears
  // this temporary signal; it never changes bindings or quality counters.
  for (const runner of ['codex', 'claude', 'grok', 'opencode']) {
    if (pools[`credential:${runner}`]) continue;
    const last = db.prepare(`SELECT error, status FROM jobs WHERE runner = ?
      AND status IN ('done','failed','blocked','interrupted') AND updated_at > datetime('now', '-5 minutes')
      AND COALESCE(error, '') NOT LIKE 'workflow-pool:%'
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(runner) as { error: string | null; status: string } | undefined;
    if (last && last.status !== 'done' && /quota.{0,24}(?:exhaust|exceed)|usage.limit|token_expired|login.expired|rate.limit.exceeded|authentication.failed/i.test(last.error ?? '')) {
      block(runner, `${runner} 最近发生额度或认证失败，已暂停重试；可手动选择其他凭据池，或等待恢复后再试。`);
    }
  }
  return pools;
}
