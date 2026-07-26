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

export const RECOVERY_GRACE_SECONDS = 10 * 60;
export const ACTIVE_STATUSES = new Set([
  'claimed',
  'running',
  'recovering',
  'pause_requested',
  'cancel_requested',
]);
/** Statuses where the PC worker may still be executing; soft-deleting the window needs force. */
export const RUNNING_WINDOW_STATUSES = new Set([
  'pending',
  'claimed',
  'running',
  'recovering',
  'pause_requested',
  'cancel_requested',
]);
export const LEASE_SECONDS = 45;

export interface CreateJobInput {
  requestedBy: string;
  runner: 'claude' | 'codex' | 'grok';
  workspace: string;
  prompt: string;
  workerId?: string | null;
  priority?: number;
  ttlMinutes?: number;
  idempotencyKey?: string;
  permissions: { write: boolean; shell: boolean; ssh: boolean };
  /** 派单时指定的模型和推理强度，覆盖 Worker config 默认值。 */
  options?: { model?: string; reasoning?: string };
  /** 委派发生的聊天（DM/群）与当时的最后一条消息 id——前端把任务 thread 挂回这条消息下。 */
  originContactId?: string | null;
  originAnchorId?: number | null;
}

function isWindowsWorkspace(workspace: string): boolean {
  return path.win32.isAbsolute(workspace.trim());
}

export function normalizeWorkspace(workspace: string): string {
  const trimmed = workspace.trim();
  if (isWindowsWorkspace(trimmed)) return path.win32.normalize(trimmed);
  if (path.posix.isAbsolute(trimmed)) return path.posix.normalize(trimmed);
  return trimmed;
}

export function workspaceAllowed(workspace: string, roots: string[]): boolean {
  const targetIsWindows = isWindowsWorkspace(workspace);
  const target = normalizeWorkspace(workspace);
  return roots.some((root) => {
    if (targetIsWindows !== isWindowsWorkspace(root)) return false;
    const base = normalizeWorkspace(root);
    const separator = targetIsWindows ? path.win32.sep : path.posix.sep;
    const comparableTarget = targetIsWindows ? target.toLowerCase() : target;
    const comparableBase = targetIsWindows ? base.toLowerCase() : base;
    return comparableTarget === comparableBase
      || comparableTarget.startsWith(comparableBase + separator);
  });
}

export class JobStore {
  /** Terminal transition hook (done/blocked/failed/interrupted). Set by index.ts. */
  onFinished: ((job: JobRow) => void) | null = null;
  private readonly statements: Record<string, any>;

  constructor(private db: Db, private sse: SseHub) {
    this.statements = {
      get: db.prepare('SELECT * FROM jobs WHERE id = ?'),
      softDelete: db.prepare(
        `UPDATE jobs SET deleted = 1, updated_at = datetime('now') WHERE id = ? AND deleted = 0`
      ),
      cancelPending: db.prepare(
        `UPDATE jobs SET status = 'cancelled', lease_until = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      ),
      messages: db.prepare('SELECT * FROM job_messages WHERE job_id = ? ORDER BY id DESC LIMIT ?'),
      addMessage: db.prepare(
        'INSERT INTO job_messages (job_id, sender, kind, content, meta) VALUES (?, ?, ?, ?, ?)'
      ),
      messageById: db.prepare('SELECT * FROM job_messages WHERE id = ?'),
      expirePending: db.prepare(
        `UPDATE jobs SET status = 'expired', updated_at = datetime('now')
         WHERE status = 'pending' AND ttl_at IS NOT NULL AND ttl_at <= datetime('now')`
      ),
      stale: db.prepare(
        `SELECT id, status FROM jobs WHERE status IN ('claimed','running','pause_requested','cancel_requested')
         AND lease_until IS NOT NULL AND lease_until <= datetime('now')`
      ),
      recoverable: db.prepare(
        `UPDATE jobs SET status = 'recovering',
         error = 'worker lease expired; waiting briefly for process/session recovery',
         lease_until = datetime('now', ?), updated_at = datetime('now')
         WHERE id = ? AND status IN ('claimed','running')`
      ),
      staleRecovering: db.prepare(
        `SELECT id FROM jobs WHERE status = 'recovering'
         AND lease_until IS NOT NULL AND lease_until <= datetime('now')`
      ),
      finishRequested: db.prepare(
        `UPDATE jobs SET status = ?, lease_until = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = ?`
      ),
      interrupt: db.prepare(
        `UPDATE jobs SET status = 'interrupted',
         error = 'worker recovery grace expired; manual resume required',
         lease_until = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'recovering'`
      ),
      create: db.prepare(
        `INSERT INTO jobs
         (id, requested_by, worker_id, runner, workspace, prompt, priority, ttl_at, idempotency_key, permissions,
          origin_contact_id, origin_anchor_id, options)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?, ?, ?, ?)`
      ),
      action: db.prepare(
        `UPDATE jobs SET status = ?, lease_until = NULL, error = NULL, updated_at = datetime('now') WHERE id = ?`
      ),
      reconcile: db.prepare(
        `UPDATE jobs SET status = 'done', error = NULL, delivery_state = 'delivered', delivery_meta = ?,
         lease_until = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'blocked'`
      ),
      complete: db.prepare(
        `UPDATE jobs SET status = ?, result = ?, error = ?, delivery_state = ?, delivery_meta = ?, lease_until = NULL,
         updated_at = datetime('now') WHERE id = ?`
      ),
    };
  }

  get(id: string): JobRow | undefined {
    return this.statements.get.get(id) as JobRow | undefined;
  }

  /**
   * Soft-delete (hide) a job window. Keeps the row + job_messages for audit/recovery.
   * Active/queued jobs require `force: true` — caller must have warned the user that
   * the PC worker may keep running in the background unless they cancel first.
   */
  softDelete(
    id: string,
    actor: string,
    opts: { force?: boolean } = {}
  ): { ok: true; job: JobRow } | { error: string; code: 404 | 409 } {
    this.reap();
    const job = this.get(id);
    if (!job) return { error: 'job not found', code: 404 };
    if (job.deleted === 1) return { error: 'job already hidden', code: 404 };
    if (RUNNING_WINDOW_STATUSES.has(job.status) && !opts.force) {
      return {
        error:
          '任务仍在队列或执行中：请先取消，或 force=true 仅隐藏窗口（后台仍可能继续）',
        code: 409,
      };
    }
    this.statements.softDelete.run(job.id);
    this.addMessage(
      job.id,
      actor,
      'state',
      RUNNING_WINDOW_STATUSES.has(job.status)
        ? `window hidden (force): status was ${job.status}; worker may still run until cancel/complete`
        : `window hidden: status was ${job.status}`
    );
    // Pending jobs must leave the claim queue; cancel_requested if still leased so
    // worker heartbeats can stop side effects when the user only meant to hide.
    if (job.status === 'pending') {
      this.statements.cancelPending.run(job.id);
      this.addMessage(job.id, actor, 'state', 'hidden pending job cancelled so it will not be claimed');
    }
    this.emitJob(job.id);
    return { ok: true, job: this.get(id)! };
  }

  messages(jobId: string, limit = 200): unknown[] {
    return this.statements.messages.all(jobId, limit)
      .reverse();
  }

  addMessage(jobId: string, sender: string, kind: string, content: string, meta: unknown = {}): unknown {
    const result = this.statements.addMessage.run(
      jobId, sender, kind, content.slice(0, 200_000), JSON.stringify(meta)
    );
    const row = this.statements.messageById.get(Number(result.lastInsertRowid));
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

  /** TTL 过期 + 租约失联清扫。先留恢复窗口，窗口耗尽才转终态并触发 onFinished。 */
  reap(): void {
    this.statements.expirePending.run();
    const stale = this.statements.stale.all() as { id: string; status: string }[];
    for (const { id, status } of stale) {
      if (status === 'cancel_requested' || status === 'pause_requested') {
        const terminal = status === 'cancel_requested' ? 'cancelled' : 'paused';
        this.statements.finishRequested.run(terminal, id, status);
        this.addMessage(id, 'system', 'state', `Worker 失联，${terminal === 'cancelled' ? '取消' : '暂停'}请求已收口。`);
        this.emitJob(id);
        continue;
      }
      this.statements.recoverable.run(`+${RECOVERY_GRACE_SECONDS} seconds`, id);
      this.addMessage(id, 'system', 'state', 'Worker 租约中断，进入 10 分钟恢复窗口；等待 PID 接管或 CLI session resume。');
      this.emitJob(id);
    }
    const expired = this.statements.staleRecovering.all() as { id: string }[];
    for (const { id } of expired) {
      if (!this.statements.interrupt.run(id).changes) continue;
      this.addMessage(id, 'system', 'state', 'Worker 恢复窗口耗尽，任务已中断；需要人工继续。');
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
    const workspace = normalizeWorkspace(input.workspace);
    const ttlMinutes = Math.min(Math.max(Number(input.ttlMinutes) || 1440, 5), 10080);
    const options = input.options && (input.options.model || input.options.reasoning)
      ? JSON.stringify(input.options) : '{}';
    try {
      this.statements.create.run(
          id,
          input.requestedBy,
          input.workerId || null,
          input.runner,
          workspace,
          input.prompt.trim(),
          Math.min(Math.max(Number(input.priority) || 0, -10), 10),
          `+${ttlMinutes} minutes`,
          input.idempotencyKey?.slice(0, 200) || id,
          JSON.stringify(input.permissions),
          input.originContactId ?? null,
          input.originAnchorId ?? null,
          options
        );
    } catch (e: any) {
      if (String(e.message).includes('UNIQUE')) return { error: 'duplicate idempotency key' };
      throw e;
    }
    this.addMessage(id, input.requestedBy, 'prompt', input.prompt.trim(), {
      runner: input.runner,
      workspace,
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
    else if (action === 'resume' && ['paused', 'interrupted', 'blocked', 'failed'].includes(job.status)) next = 'pending';
    if (!next) return { error: `cannot ${action} from ${job.status}` };
    this.statements.action.run(next, job.id);
    this.addMessage(job.id, actor, 'state', `${action}: ${job.status} → ${next}`);
    this.emitJob(job.id);
    return { status: next };
  }

  reconcileBlocked(
    job: JobRow,
    actor: string,
    deliveryMeta: string,
    head: string
  ): { status: 'done' } | { error: string } {
    if (job.status !== 'blocked') return { error: `cannot reconcile from ${job.status}` };
    if (!['blocked_local_changes', 'blocked_unpushed'].includes(job.delivery_state ?? '')) {
      return { error: `delivery state ${job.delivery_state ?? 'missing'} is not reconcilable` };
    }
    const result = this.statements.reconcile.run(deliveryMeta, job.id);
    if (!result.changes) return { error: 'job changed before reconciliation' };
    this.addMessage(job.id, actor, 'state', `外部续接已自动确认完成（HEAD ${head.slice(0, 12)}，已同步 upstream）`);
    this.emitJob(job.id);
    return { status: 'done' };
  }

  /** Worker complete 回传的收口，含终态通知；cancelled/paused 由用户主导。 */
  complete(
    job: JobRow,
    requested: unknown,
    result: string | null,
    error: string | null,
    deliveryState: string | null = null,
    deliveryMeta: string | null = null
  ): string {
    let status =
      requested === 'done' ? 'done'
      : requested === 'blocked' ? 'blocked'
      : requested === 'paused' ? 'paused'
      : requested === 'interrupted' ? 'interrupted'
      : 'failed';
    if (job.status === 'cancel_requested') status = 'cancelled';
    if (job.status === 'pause_requested') status = 'paused';
    this.statements.complete.run(status, result, error, deliveryState, deliveryMeta, job.id);
    this.addMessage(job.id, job.worker_id ?? 'worker', status === 'done' ? 'result' : 'state', result || error || status);
    this.emitJob(job.id);
    if (['done', 'blocked', 'failed', 'interrupted'].includes(status)) this.notifyFinished(job.id);
    return status;
  }
}
