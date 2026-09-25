/**
 * Worker capability card admission (capability-reject).
 *
 * The worker reports `capabilityCard` beside releaseSha/pendingReleaseSha in
 * its /api/worker/connect heartbeat capabilities
 * (worker/capability-card.mjs): per-runner liveness from a real short call,
 * workspace writability, npm-cache writability, and config readability.
 * Dispatch paths check the SELECTED worker's card after freezing the
 * binding and refuse BEFORE creating the job. A missing card (old worker)
 * passes; probes never take a worker offline.
 *
 * Pure functions so the admission stays unit-testable without a DB.
 */

export interface CapabilityRunnerEntry {
  ok: boolean;
  checkedAt: string;
  error?: string;
}

export interface CapabilityCard {
  runners: Record<string, CapabilityRunnerEntry>;
  workspaceWritable: boolean;
  npmCacheWritable: boolean;
  configVisible: boolean;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Null when the worker reports no (or an unreadable) card: old workers pass. */
export function parseCapabilityCard(capabilities: unknown): CapabilityCard | null {
  const caps = recordOf(capabilities);
  const raw = caps ? recordOf(caps['capabilityCard']) : null;
  if (!raw) return null;
  const runnersRaw = recordOf(raw['runners']) ?? {};
  const runners: Record<string, CapabilityRunnerEntry> = {};
  for (const [name, entry] of Object.entries(runnersRaw)) {
    const rec = recordOf(entry);
    if (!rec) continue;
    runners[String(name)] = {
      ok: rec['ok'] === true,
      checkedAt: typeof rec['checkedAt'] === 'string' ? rec['checkedAt'] : '',
      ...(rec['ok'] === true
        ? {}
        : { error: String(rec['error'] ?? 'probe failed').slice(0, 300) }),
    };
  }
  if (typeof raw['workspaceWritable'] !== 'boolean') return null;
  if (typeof raw['npmCacheWritable'] !== 'boolean') return null;
  if (typeof raw['configVisible'] !== 'boolean') return null;
  return {
    runners,
    workspaceWritable: raw['workspaceWritable'],
    npmCacheWritable: raw['npmCacheWritable'],
    configVisible: raw['configVisible'],
  };
}

export interface CapabilityCheckInput {
  /** Binding runner the attempt would run (e.g. 'opencode'). */
  runner: string;
  /** Whether the attempt needs write permission. */
  needWrite: boolean;
}

export interface CapabilityRejection {
  field: string;
  value: string;
  reason: string;
}

/**
 * First matching refusal, or null when the card passes. Order: bound
 * runner liveness, then workspace writability (only when the attempt needs
 * write), then config visibility. Unknown runners (not probed) pass.
 */
export function capabilityRejection(
  card: CapabilityCard,
  input: CapabilityCheckInput,
): CapabilityRejection | null {
  const runner = String(input.runner ?? '').trim();
  const entry = runner ? card.runners[runner] : undefined;
  if (entry && entry.ok !== true) {
    return {
      field: 'runner',
      value: runner,
      reason: `绑定 runner ${runner} 上次探测不可用(ok=false${entry.error ? `：${entry.error}` : ''})`,
    };
  }
  if (input.needWrite === true && card.workspaceWritable !== true) {
    return {
      field: 'workspaceWritable',
      value: 'false',
      reason: '本轮需要写工作区，但该 Worker 工作区不可写(workspaceWritable=false)',
    };
  }
  if (card.configVisible !== true) {
    return {
      field: 'configVisible',
      value: 'false',
      reason: '该 Worker 配置在沙箱内不可读(configVisible=false)',
    };
  }
  return null;
}

/** Fixed machine-readable line: `capability-reject: <workerId> <field>=<value> <reason>`. */
export function formatCapabilityReject(
  workerId: string,
  field: string,
  value: string,
  reason: string,
): string {
  const singleLine = String(reason ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500) || '能力卡不满足派单要求';
  return `capability-reject: ${String(workerId)} ${String(field)}=${String(value)} ${singleLine}`;
}
