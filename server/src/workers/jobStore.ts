import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Db, JobRow } from '../db.js';
import type { SseHub } from '../sse.js';
import { publicJob } from './deliveryStatus.js';

const execFileAsync = promisify(execFile);
const GIT_SHA_RE = /^[0-9a-f]{7,64}$/i;

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
export const DELIVERY_STAGES = new Set([
  'delivered_waiting_deploy',
  'online_waiting_validation',
  'closed_loop',
  'user_decision',
  'rework_required',
]);

export interface DeliveryUpdateInput {
  stage: string;
  summary?: string;
  nextOwner?: string;
  blocker?: string;
  evidence?: Record<string, unknown>;
}

function jsonRecord(raw: string | null | undefined): Record<string, unknown> {
  try {
    const value = raw ? JSON.parse(raw) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

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
  private outOfBandTimer: NodeJS.Timeout | null = null;
  private outOfBandSweepRunning = false;

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
      resolveOutOfBand: db.prepare(
        `UPDATE jobs SET status = 'done', error = NULL, delivery_state = 'delivered_out_of_band', delivery_meta = ?,
         lease_until = NULL, updated_at = datetime('now')
         WHERE id = ? AND status = 'blocked' AND delivery_state LIKE 'blocked\_%' ESCAPE '\\'`
      ),
      blockedOutOfBandCandidates: db.prepare(
        `SELECT * FROM jobs WHERE status = 'blocked' AND delivery_state LIKE 'blocked\_%' ESCAPE '\\'
         ORDER BY updated_at ASC LIMIT 100`
      ),
      complete: db.prepare(
        `UPDATE jobs SET status = ?, result = ?, error = ?, delivery_state = ?, delivery_meta = ?, lease_until = NULL,
         updated_at = datetime('now') WHERE id = ? AND status = ?`
      ),
      updateDelivery: db.prepare(
        `UPDATE jobs SET delivery_meta = ?, updated_at = datetime('now')
         WHERE id = ? AND deleted = 0`
      ),
      deploymentCandidates: db.prepare(
        `SELECT * FROM jobs WHERE deleted = 0 AND status = 'done' AND delivery_state = 'delivered'
         ORDER BY updated_at DESC LIMIT 500`
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
    if (row) this.sse.broadcast('job', publicJob(row));
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

  resolveBlockedOutOfBand(
    job: JobRow,
    actor: string,
    resolution: { mode: 'git_ancestor' | 'manual'; head?: string }
  ): { status: 'done'; job: JobRow } | { error: string } {
    if (job.status !== 'blocked') return { error: `cannot resolve out of band from ${job.status}` };
    if (!job.delivery_state?.startsWith('blocked_')) {
      return { error: `delivery state ${job.delivery_state ?? 'missing'} is not resolvable out of band` };
    }
    const previous = jsonRecord(job.delivery_meta);
    const previousDeclared = previous.declared && typeof previous.declared === 'object'
      && !Array.isArray(previous.declared) ? previous.declared as Record<string, unknown> : {};
    const permissions = jsonRecord(job.permissions);
    const resolvedAt = new Date().toISOString();
    const automatic = resolution.mode === 'git_ancestor';
    const reason = automatic
      ? 'declared head is an ancestor of the server checkout HEAD'
      : 'manually confirmed as completed by an out-of-band continuation';
    const deliveryMeta = JSON.stringify({
      ...previous,
      state: 'delivered_out_of_band',
      resolvedAt,
      resolutionReason: reason,
      resolution: {
        mode: resolution.mode,
        reason,
        resolvedAt,
        resolvedBy: actor,
        ...(resolution.head ? { head: resolution.head } : {}),
      },
      declared: {
        ...previousDeclared,
        stage: permissions.write === false ? 'closed_loop' : 'delivered_waiting_deploy',
        summary: permissions.write === false
          ? '场外接力已经完成，结论与证据已交付。'
          : '场外接力成果已经进入主分支，等待部署与线上验收。',
        nextOwner: permissions.write === false ? '无需后续动作' : '部署负责人',
      },
    }).slice(0, 100_000);
    const result = this.statements.resolveOutOfBand.run(deliveryMeta, job.id);
    if (!result.changes) return { error: 'job changed before out-of-band resolution' };
    this.addMessage(
      job.id,
      actor,
      'state',
      automatic
        ? `场外接力已自动确认完成（HEAD ${resolution.head?.slice(0, 12) ?? 'unknown'} 已进入服务端主分支）`
        : '场外接力已由 User 手动确认完成'
    );
    this.emitJob(job.id);
    this.notifyFinished(job.id);
    return { status: 'done', job: this.get(job.id)! };
  }

  async sweepBlockedOutOfBand(repoPath: string): Promise<string[]> {
    if (this.outOfBandSweepRunning) return [];
    this.outOfBandSweepRunning = true;
    try {
      const promoted: string[] = [];
      const candidates = this.statements.blockedOutOfBandCandidates.all() as JobRow[];
      for (const job of candidates) {
        const meta = jsonRecord(job.delivery_meta);
        const head = typeof meta.head === 'string' ? meta.head.trim() : '';
        if (!GIT_SHA_RE.test(head)) continue;
        try {
          await execFileAsync(
            'git',
            ['-c', `safe.directory=${path.resolve(repoPath)}`, '-C', repoPath, 'merge-base', '--is-ancestor', head, 'HEAD'],
            { timeout: 10_000, windowsHide: true }
          );
        } catch {
          // Exit 1 means "not an ancestor"; invalid/missing objects are skipped too.
          continue;
        }
        const outcome = this.resolveBlockedOutOfBand(job, 'system', { mode: 'git_ancestor', head });
        if ('job' in outcome) promoted.push(job.id);
      }
      return promoted;
    } finally {
      this.outOfBandSweepRunning = false;
    }
  }

  startOutOfBandResolver(
    repoPath = process.env.AI_HUB_REPO_PATH ?? '/opt/ai-hub',
    intervalMs = 30_000
  ): void {
    if (this.outOfBandTimer) return;
    void this.sweepBlockedOutOfBand(repoPath);
    this.outOfBandTimer = setInterval(() => void this.sweepBlockedOutOfBand(repoPath), intervalMs);
    this.outOfBandTimer.unref();
  }

  stopOutOfBandResolver(): void {
    if (this.outOfBandTimer) clearInterval(this.outOfBandTimer);
    this.outOfBandTimer = null;
  }

  /**
   * Worker complete 回传的收口，含终态通知。
   * 终态重试必须幂等：不能重复写审计消息/广播/continuation，也不能复活 cancelled/paused。
   */
  complete(
    job: JobRow,
    requested: unknown,
    result: string | null,
    error: string | null,
    deliveryState: string | null = null,
    deliveryMeta: string | null = null
  ): { status: string; changed: boolean } | { error: string } {
    const current = this.get(job.id);
    if (!current) return { error: 'job not found' };
    const terminal = new Set([
      'done',
      'blocked',
      'failed',
      'interrupted',
      'cancelled',
      'paused',
      'expired',
    ]);
    if (terminal.has(current.status)) {
      return { status: current.status, changed: false };
    }
    if (!ACTIVE_STATUSES.has(current.status)) {
      return { error: `cannot complete from ${current.status}` };
    }

    let status =
      requested === 'done' ? 'done'
      : requested === 'blocked' ? 'blocked'
      : requested === 'paused' ? 'paused'
      : requested === 'interrupted' ? 'interrupted'
      : 'failed';
    if (current.status === 'cancel_requested') status = 'cancelled';
    if (current.status === 'pause_requested') status = 'paused';
    const update = this.statements.complete.run(
      status,
      result,
      error,
      deliveryState,
      deliveryMeta,
      current.id,
      current.status
    );
    if (!update.changes) {
      const latest = this.get(current.id);
      if (latest && terminal.has(latest.status)) {
        return { status: latest.status, changed: false };
      }
      return { error: `job changed before completion${latest ? ` (${latest.status})` : ''}` };
    }
    this.addMessage(
      current.id,
      current.worker_id ?? 'worker',
      status === 'done' ? 'result' : 'state',
      result || error || status
    );
    this.emitJob(current.id);
    if (['done', 'blocked', 'failed', 'interrupted'].includes(status)) {
      this.notifyFinished(current.id);
    }
    return { status, changed: true };
  }

  updateDelivery(
    id: string,
    actor: string,
    input: DeliveryUpdateInput
  ): { job: JobRow } | { error: string } {
    const job = this.get(id);
    if (!job || job.deleted === 1) return { error: 'job not found' };
    if (ACTIVE_STATUSES.has(job.status) || job.status === 'pending') {
      return { error: `cannot update delivery while job is ${job.status}` };
    }
    const stage = input.stage.trim().toLowerCase().replace(/-/g, '_');
    if (!DELIVERY_STAGES.has(stage)) return { error: `invalid delivery stage ${stage}` };
    const previous = jsonRecord(job.delivery_meta);
    const {
      stage: _previousStage,
      lifecycleStage: _previousLifecycleStage,
      humanStatus: _previousHumanStatus,
      summary: _previousSummary,
      nextOwner: _previousNextOwner,
      next_owner: _previousNextOwnerSnake,
      blocker: _previousBlocker,
      needsUserDecision: _previousNeedsDecision,
      ...baseMeta
    } = previous;
    const previousDeclared = previous.declared && typeof previous.declared === 'object'
      && !Array.isArray(previous.declared) ? previous.declared as Record<string, unknown> : {};
    const {
      stage: _declaredStage,
      lifecycleStage: _declaredLifecycleStage,
      summary: _declaredSummary,
      nextOwner: _declaredNextOwner,
      next_owner: _declaredNextOwnerSnake,
      blocker: _declaredBlocker,
      needsUserDecision: _declaredNeedsDecision,
      needs_user_decision: _declaredNeedsDecisionSnake,
      ...baseDeclared
    } = previousDeclared;
    const summary = typeof input.summary === 'string' ? input.summary.trim().slice(0, 500) : '';
    const nextOwner = typeof input.nextOwner === 'string' ? input.nextOwner.trim().slice(0, 100) : '';
    const blocker = typeof input.blocker === 'string' ? input.blocker.trim().slice(0, 100) : '';
    const updatedAt = new Date().toISOString();
    const deliveryMeta = JSON.stringify({
      ...baseMeta,
      ...(input.evidence ?? {}),
      declared: {
        ...baseDeclared,
        stage,
        ...(summary ? { summary } : {}),
        ...(nextOwner ? { nextOwner } : {}),
        ...(blocker ? { blocker } : {}),
      },
      conclusionUpdatedAt: updatedAt,
      conclusionUpdatedBy: actor,
    }).slice(0, 100_000);
    const result = this.statements.updateDelivery.run(deliveryMeta, job.id);
    if (!result.changes) return { error: 'job changed before delivery update' };
    this.addMessage(job.id, actor, 'state', `交付结论更新为 ${stage}${summary ? `：${summary}` : ''}`);
    this.emitJob(job.id);
    return { job: this.get(job.id)! };
  }

  deploymentCandidates(): JobRow[] {
    return (this.statements.deploymentCandidates.all() as JobRow[])
      .filter((job) => publicJob(job).delivery_summary.state === 'delivered_waiting_deploy');
  }
}
