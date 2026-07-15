import crypto from 'node:crypto';
import path from 'node:path';
import type { Db, JobRow } from '../db.js';
import type { SseHub } from '../sse.js';

/**
 * Shared job-queue operations, extracted from the workers router so both the
 * HTTP API (frontend / PC worker) and gateway-side delegate tools (contacts
 * dispatching work to the PC) go through one implementation. `onFinished`
 * fires exactly once per terminal transition — the hook behind "worker 结果
 * 回来后触发至多一次 continuation".
 */

export const ACTIVE_STATUSES = new Set(['claimed', 'running', 'pause_requested', 'cancel_requested']);
export const LEASE_SECONDS = 45;

export interface CreateJobInput {
  requestedBy: string;
  runner: 'claude' | 'codex';
  workspace: string;
  prompt: string;
  workerId?: string | null;
  priority?: number;
  ttlMinutes?: number;
  idempotencyKey?: string;
  permissions: { write: boolean; shell: boolean; ssh: boolean };
  /** 委派发生的聊天（DM/群）与当时的最后一条消息 id——前端把任务 thread 挂回这条消息下。 */
  originContactId?: string | null;
  originAnchorId?: number | null;
}

export function workspaceAllowed(workspace: string, roots: string[]): boolean {
  const target = path.resolve(workspace).toLowerCase();
  return roots.some((root) => {
    const base = path.resolve(root).toLowerCase();
    return target === base || target.startsWith(base + path.sep);
  });
}

export class JobStore {
  /** Terminal transition hook (done/failed/interrupted). Set by index.ts. */
  onFinished: ((job: JobRow) => void) | null = null;

  constructor(private db: Db, private sse: SseHub) {}

  get(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  }

  messages(jobId: string, limit = 200): unknown[] {
    return this.db
      .prepare('SELECT * FROM job_messages WHERE job_id = ? ORDER BY id DESC LIMIT ?')
      .all(jobId, limit)
      .reverse();
  }

  addMessage(jobId: string, sender: string, kind: string, content: string, meta: unknown = {}): unknown {
    const result = this.db
      .prepare('INSERT INTO job_messages (job_id, sender, kind, content, meta) VALUES (?, ?, ?, ?, ?)')
      .run(jobId, sender, kind, content.slice(0, 200_000), JSON.stringify(meta));
    const row = this.db
      .prepare('SELECT * FROM job_messages WHERE id = ?')
      .get(Number(result.lastInsertRowid));
    this.sse.broadcast('job-message', row);
    return row;
  }

  emitJob(id: string): void {
    const row = this.get(id);
    if (row) this.sse.broadcast('job', { ...row, permissions: this.json(row.permissions, {}) });
  }

  private json<T>(raw: string, fallback: T): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private notifyFinished(id: string): void {
    const job = this.get(id);
    if (job) this.onFinished?.(job);
  }

  /** TTL 过期 + 租约失联清扫。失联属于终态转换，同样触发 onFinished。 */
  reap(): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'expired', updated_at = datetime('now')
         WHERE status = 'pending' AND ttl_at IS NOT NULL AND ttl_at <= datetime('now')`
      )
      .run();
    const stale = this.db
      .prepare(
        `SELECT id FROM jobs WHERE status IN ('claimed','running','pause_requested','cancel_requested')
         AND lease_until IS NOT NULL AND lease_until <= datetime('now')`
      )
      .all() as { id: string }[];
    for (const { id } of stale) {
      this.db
        .prepare(
          `UPDATE jobs SET status = 'interrupted', error = 'worker lease expired; manual resume required',
           updated_at = datetime('now') WHERE id = ?`
        )
        .run(id);
      this.addMessage(id, 'system', 'state', 'Worker 失联，任务已中断；不会自动重跑副作用。');
      this.emitJob(id);
      this.notifyFinished(id);
    }
  }

  create(input: CreateJobInput): { job: JobRow } | { error: string } {
    if (!input.runner || !input.prompt.trim() || !input.workspace.trim())
      return { error: 'runner/workspace/prompt required' };
    if (input.prompt.length > 100_000 || input.workspace.length > 1000)
      return { error: 'job too large' };
    if (input.runner === 'codex' && !input.permissions.shell)
      return { error: 'Codex 的文件读取/编辑都通过 Shell 工具；Codex 任务必须显式开启 Shell' };

    const id = crypto.randomUUID();
    const ttlMinutes = Math.min(Math.max(Number(input.ttlMinutes) || 1440, 5), 10080);
    try {
      this.db
        .prepare(
          `INSERT INTO jobs
           (id, requested_by, worker_id, runner, workspace, prompt, priority, ttl_at, idempotency_key, permissions,
            origin_contact_id, origin_anchor_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?, ?, ?)`
        )
        .run(
          id,
          input.requestedBy,
          input.workerId || null,
          input.runner,
          input.workspace.trim(),
          input.prompt.trim(),
          Math.min(Math.max(Number(input.priority) || 0, -10), 10),
          `+${ttlMinutes} minutes`,
          input.idempotencyKey?.slice(0, 200) || id,
          JSON.stringify(input.permissions),
          input.originContactId ?? null,
          input.originAnchorId ?? null
        );
    } catch (e: any) {
      if (String(e.message).includes('UNIQUE')) return { error: 'duplicate idempotency key' };
      throw e;
    }
    this.addMessage(id, input.requestedBy, 'prompt', input.prompt.trim(), {
      runner: input.runner,
      workspace: input.workspace.trim(),
      permissions: input.permissions,
    });
    this.emitJob(id);
    return { job: this.get(id)! };
  }

  action(id: string, action: 'cancel' | 'pause' | 'resume', actor: string): { status: string } | { error: string } {
    this.reap();
    const job = this.get(id);
    if (!job) return { error: 'job not found' };
    let next: string | null = null;
    if (action === 'cancel' && job.status === 'pending') next = 'cancelled';
    else if (action === 'cancel' && ACTIVE_STATUSES.has(job.status)) next = 'cancel_requested';
    else if (action === 'pause' && ACTIVE_STATUSES.has(job.status)) next = 'pause_requested';
    else if (action === 'resume' && ['paused', 'interrupted', 'failed'].includes(job.status)) next = 'pending';
    if (!next) return { error: `cannot ${action} from ${job.status}` };
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, lease_until = NULL, error = NULL, updated_at = datetime('now') WHERE id = ?`
      )
      .run(next, job.id);
    this.addMessage(job.id, actor, 'state', `${action}: ${job.status} → ${next}`);
    this.emitJob(job.id);
    return { status: next };
  }

  /** Worker complete 回传的收口，含终态通知（done/failed 才通知；cancelled/paused 是 User 主导的）。 */
  complete(job: JobRow, requested: unknown, result: string | null, error: string | null): string {
    let status =
      requested === 'done' ? 'done'
      : requested === 'paused' ? 'paused'
      : requested === 'interrupted' ? 'interrupted'
      : 'failed';
    if (job.status === 'cancel_requested') status = 'cancelled';
    if (job.status === 'pause_requested') status = 'paused';
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, result = ?, error = ?, lease_until = NULL,
         updated_at = datetime('now') WHERE id = ?`
      )
      .run(status, result, error, job.id);
    this.addMessage(job.id, job.worker_id ?? 'worker', status === 'done' ? 'result' : 'state', result || error || status);
    this.emitJob(job.id);
    if (['done', 'failed', 'interrupted'].includes(status)) this.notifyFinished(job.id);
    return status;
  }
}
