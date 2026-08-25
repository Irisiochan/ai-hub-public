import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Db, JobRow } from '../db.js';
import type { SseHub } from '../sse.js';
import { publicJob } from './deliveryStatus.js';
import { parseCoordinationMarker } from './coordinationReceipt.js';
import {
  problemFingerprint,
  stageForRouteClass,
  type WorkflowSnapshot,
  type WorkflowStage,
  WorkflowProfileStore,
} from './workflowProfiles.js';

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

/** onFinished 经 durable outbox 重放；handler 抛错→指数退避重试，末次仍败→dead。 */
export interface JobFinishContext {
  /** true 表示这是最后一次尝试：handler 应走降级投递而不是再抛错重试。 */
  finalAttempt: boolean;
  /** outbox 行上的持久化步骤标记（如 tailDone），跨重试/重启保留。 */
  meta: Record<string, unknown>;
  setMeta(patch: Record<string, unknown>): void;
}

interface JobOutboxRow {
  id: number;
  job_id: string;
  kind: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  meta: string;
  last_error: string | null;
}

export const OUTBOX_MAX_ATTEMPTS = 8;
const OUTBOX_BASE_DELAY_MS = 30_000;
const OUTBOX_MAX_DELAY_MS = 30 * 60_000;
const OUTBOX_CLAIM_LEASE_MS = 5 * 60_000;
/** 启动补偿只回看这个窗口内的终态 job，避免翻出远古 job 重发回执。 */
const OUTBOX_BACKFILL_WINDOW = '-48 hours';

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
  /** 派单执行选项与服务端路由审计元数据。 */
  options?: {
    model?: string;
    reasoning?: string;
    routeClass?: 'implement' | 'fix' | 'review' | 'recon' | 'mechanical';
    runnerSource?: 'policy' | 'override';
    runnerOverrideReason?: string;
    workflowStage?: WorkflowStage;
    problemFingerprint?: string;
    taskPath?: string;
    workflow?: WorkflowSnapshot;
  };
  /** 委派发生的聊天（DM/群）与当时的最后一条消息 id——前端把任务 thread 挂回这条消息下。 */
  originContactId?: string | null;
  originAnchorId?: number | null;
  /** Optional per-requester queue guard; coordination dedupe runs before this limit. */
  maxOpenJobs?: number;
}

export interface CreateJobResult {
  job: JobRow;
  merged?: boolean;
  /** Human-visible queue diagnostic; the job remains pending and claimable. */
  queueWarning?: string;
}

// pause/cancel 只是「已请求」，旧 worker 可能仍在执行；在真正转成 paused/cancelled
// 终态前，同 taskPath 不允许第二张 job。
const COORDINATION_ACTIVE_STATUSES =
  "('pending','claimed','running','recovering','pause_requested','cancel_requested')";
const DEPLOY_JOB_HEADER = '只运行 deploy/room-deploy-job.ps1，不做任何其他改动、不修任何文件。';

/** Extract the task-level mutex key only from trusted fixed job shapes. */
export function coordinationTaskPath(prompt: string | null | undefined): string | null {
  const raw = String(prompt ?? '');
  const marker = parseCoordinationMarker(raw);
  if (marker) return marker.taskPath;

  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes(DEPLOY_JOB_HEADER)) return null;
  if (!lines.some((line) => /^命令[：:].*deploy[\\/]room-deploy-job\.ps1\b.*\s-Sha(?:\s|$)/i.test(line))) {
    return null;
  }
  const taskLine = lines.find((line) => /^deploy-tail 任务文件[：:]/i.test(line));
  const match = /^deploy-tail 任务文件[：:]\s*`?(tasks\/[^/\\\r\n]{1,100}\.md)`?$/i.exec(taskLine ?? '');
  return match?.[1] ?? null;
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
  /**
   * Terminal transition hook (done/blocked/failed/interrupted). Set by index.ts.
   * Invoked through the durable job_outbox: throw to retry with backoff; the
   * ctx tells the handler when it is on its final attempt and lets it persist
   * per-step progress across retries/restarts.
   */
  onFinished: ((job: JobRow, ctx: JobFinishContext) => void | Promise<void>) | null = null;
  private readonly statements: Record<string, any>;
  private outOfBandTimer: NodeJS.Timeout | null = null;
  private outOfBandSweepRunning = false;
  private outboxTimer: NodeJS.Timeout | null = null;
  private outboxDraining = false;
  private outboxDrainScheduled = false;
  readonly workflowProfiles: WorkflowProfileStore;

  constructor(private db: Db, private sse: SseHub) {
    this.workflowProfiles = new WorkflowProfileStore(db);
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
      pendingJobs: db.prepare(
        `SELECT * FROM jobs WHERE deleted = 0 AND status = 'pending' ORDER BY created_at ASC`
      ),
      liveAcceptingWorkers: db.prepare(
        `SELECT id, capabilities FROM workers
         WHERE accepting_jobs = 1 AND last_seen_at IS NOT NULL
           AND last_seen_at >= datetime('now', '-70 seconds')
           AND (? IS NULL OR id = ?)`
      ),
      runnerUnavailableMessage: db.prepare(
        `SELECT id FROM job_messages
         WHERE job_id = ? AND kind = 'state'
           AND json_extract(meta, '$.event') = 'runner-unavailable'
           AND json_extract(meta, '$.runner') = ?
         LIMIT 1`
      ),
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
      activeCoordinationJobs: db.prepare(
        `SELECT * FROM jobs WHERE status IN ${COORDINATION_ACTIVE_STATUSES} ORDER BY created_at ASC, id ASC`
      ),
      openJobsByRequester: db.prepare(
        `SELECT COUNT(*) AS c FROM jobs
         WHERE requested_by = ? AND deleted = 0
           AND status IN ('pending','claimed','running','recovering','pause_requested','cancel_requested')`
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
      outboxEnqueue: db.prepare(
        `INSERT OR IGNORE INTO job_outbox (job_id, kind) VALUES (?, 'finished')`
      ),
      outboxClaimNext: db.prepare(
        `SELECT * FROM job_outbox WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at, id LIMIT 1`
      ),
      outboxLease: db.prepare(
        `UPDATE job_outbox SET attempts = attempts + 1, next_attempt_at = ?, updated_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      ),
      outboxMarkDone: db.prepare(
        `UPDATE job_outbox SET status = 'done', last_error = NULL, updated_at = datetime('now') WHERE id = ?`
      ),
      outboxMarkRetry: db.prepare(
        `UPDATE job_outbox SET next_attempt_at = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?`
      ),
      outboxMarkDead: db.prepare(
        `UPDATE job_outbox SET status = 'dead', last_error = ?, updated_at = datetime('now') WHERE id = ?`
      ),
      outboxSetMeta: db.prepare(
        `UPDATE job_outbox SET meta = ?, updated_at = datetime('now') WHERE id = ?`
      ),
      outboxStatus: db.prepare(
        `SELECT status, COUNT(*) AS c FROM job_outbox GROUP BY status`
      ),
      // 启动补偿：窗口内的终态 coordination/worker job，既没有 outbox 行（迁移前完成
      // 或行丢失）也没有任何可见回执（room-host 幂等键 / DM 降级投递）的，补一行待重放。
      outboxBackfill: db.prepare(
        `INSERT OR IGNORE INTO job_outbox (job_id, kind)
         SELECT j.id, 'finished' FROM jobs j
         WHERE j.status IN ('done','blocked','failed','interrupted')
           AND j.updated_at >= datetime('now', '${OUTBOX_BACKFILL_WINDOW}')
           AND NOT EXISTS (
             SELECT 1 FROM job_outbox o WHERE o.job_id = j.id AND o.kind = 'finished'
           )
           AND NOT EXISTS (
             SELECT 1 FROM messages m
             WHERE m.sender = 'room-host' AND m.idempotency_key = 'receipt:v1:' || j.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM messages m2
             WHERE m2.created_at >= datetime('now', '-72 hours')
               AND json_extract(m2.meta, '$.event') = 'worker-receipt'
               AND json_extract(m2.meta, '$.jobId') = j.id
           )`
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

  /**
   * Make an unclaimable pending job observable without turning a temporary
   * capability removal into a terminal failure. The warning is durable and
   * deduplicated; once a worker advertises the runner again normal claim logic
   * continues unchanged.
   */
  ensureRunnerAvailabilitySignal(job: JobRow): string | undefined {
    if (job.status !== 'pending') return undefined;
    const targetWorkerId = job.worker_id || null;
    const workers = this.statements.liveAcceptingWorkers.all(
      targetWorkerId,
      targetWorkerId
    ) as { id: string; capabilities: string }[];
    const declared = workers.some((worker) => {
      const capabilities = jsonRecord(worker.capabilities);
      return Array.isArray(capabilities.runners) && capabilities.runners.includes(job.runner);
    });
    if (declared) return undefined;

    const target = targetWorkerId ? `（指定 ${targetWorkerId}）` : '';
    const warning =
      `当前没有在线且接单中的 Worker${target} 声明 runner=${job.runner}；` +
      '任务仍保持 pending，Worker 恢复该 runner 后可正常认领。';
    const existing = this.statements.runnerUnavailableMessage.get(job.id, job.runner);
    if (!existing) {
      this.addMessage(job.id, 'system', 'state', warning, {
        event: 'runner-unavailable',
        runner: job.runner,
        workerId: targetWorkerId,
      });
    }
    return warning;
  }

  /** Reconcile jobs created before a worker dynamically changed its runners. */
  signalUnservablePendingJobs(): void {
    const pending = this.statements.pendingJobs.all() as JobRow[];
    for (const job of pending) this.ensureRunnerAvailabilitySignal(job);
  }

  emitJob(id: string): void {
    const row = this.get(id);
    if (row) this.sse.broadcast('job', publicJob(row));
  }

  /** 只入队（供事务内调用）；真正执行由 outbox drain 负责。 */
  private enqueueFinished(id: string): void {
    this.statements.outboxEnqueue.run(id);
  }

  scheduleOutboxDrain(): void {
    if (this.outboxDrainScheduled) return;
    this.outboxDrainScheduled = true;
    setImmediate(() => {
      this.outboxDrainScheduled = false;
      // 关库竞态（进程/测试收尾时 setImmediate 晚于 db.close）只能吞：
      // pending 行本就设计为重启后重放。
      void this.drainOutbox().catch(() => {});
    });
  }

  async drainOutbox(): Promise<void> {
    if (this.outboxDraining) return;
    this.outboxDraining = true;
    try {
      while (this.db.open && await this.drainOutboxOnce()) { /* drain until no due rows */ }
    } finally {
      this.outboxDraining = false;
    }
  }

  /**
   * 处理一条到期 outbox 行。claim 把 next_attempt_at 推成租约，进程崩溃在
   * handler 中途时行保持 pending，租约到期后重放；handler 的幂等键保证不产
   * 生第二个可见回执。
   */
  async drainOutboxOnce(now = Date.now()): Promise<boolean> {
    const row = this.db.transaction((): JobOutboxRow | undefined => {
      const due = this.statements.outboxClaimNext.get(now) as JobOutboxRow | undefined;
      if (!due) return undefined;
      this.statements.outboxLease.run(now + OUTBOX_CLAIM_LEASE_MS, due.id);
      return { ...due, attempts: due.attempts + 1 };
    })();
    if (!row) return false;
    const job = this.get(row.job_id);
    if (!job) {
      this.statements.outboxMarkDead.run('job row missing', row.id);
      return true;
    }
    const finalAttempt = row.attempts >= OUTBOX_MAX_ATTEMPTS;
    const ctx: JobFinishContext = {
      finalAttempt,
      meta: jsonRecord(row.meta),
      setMeta: (patch) => {
        ctx.meta = { ...ctx.meta, ...patch };
        this.statements.outboxSetMeta.run(JSON.stringify(ctx.meta), row.id);
      },
    };
    try {
      await this.onFinished?.(job, ctx);
      this.statements.outboxMarkDone.run(row.id);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      if (finalAttempt) {
        this.statements.outboxMarkDead.run(message, row.id);
      } else {
        const delay = Math.min(OUTBOX_BASE_DELAY_MS * 2 ** (row.attempts - 1), OUTBOX_MAX_DELAY_MS);
        this.statements.outboxMarkRetry.run(now + delay, message, row.id);
      }
    }
    return true;
  }

  /** 可观测状态：pending/done/dead 计数（health 与测试用）。 */
  outboxCounts(): Record<string, number> {
    const rows = this.statements.outboxStatus.all() as { status: string; c: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.c)]));
  }

  /**
   * 启动补偿 + 周期 drain。补偿扫描窗口内缺回执且无 outbox 行的终态 job
   * （迁移前完成的存量），补行后与崩溃遗留的 pending 行一起按租约重放。
   */
  startOutboxProcessor(intervalMs = 30_000): number {
    if (this.outboxTimer) return 0;
    const backfilled = (this.statements.outboxBackfill.run() as { changes: number }).changes;
    this.scheduleOutboxDrain();
    this.outboxTimer = setInterval(() => void this.drainOutbox().catch(() => {}), intervalMs);
    this.outboxTimer.unref();
    return backfilled;
  }

  stopOutboxProcessor(): void {
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    this.outboxTimer = null;
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
      const interrupted = this.db.transaction((jobId: string): boolean => {
        if (!this.statements.interrupt.run(jobId).changes) return false;
        this.enqueueFinished(jobId);
        return true;
      })(id);
      if (!interrupted) continue;
      this.addMessage(id, 'system', 'state', 'Worker 恢复窗口耗尽，任务已中断；需要人工继续。');
      this.emitJob(id);
      this.scheduleOutboxDrain();
    }
  }

  create(input: CreateJobInput): CreateJobResult | { error: string } {
    if (!input.runner || !input.prompt.trim() || !input.workspace.trim())
      return { error: 'runner/workspace/prompt required' };
    if (input.prompt.length > 100_000 || input.workspace.length > 1000)
      return { error: 'job too large' };
    if (input.runner === 'codex' && !input.permissions.shell)
      return { error: 'Codex 的文件读取/编辑都通过 Shell 工具；Codex 任务必须显式开启 Shell' };

    const taskPath = coordinationTaskPath(input.prompt);
    if (taskPath) {
      const existing = (this.statements.activeCoordinationJobs.all() as JobRow[])
        .find((job) => coordinationTaskPath(job.prompt)?.toLowerCase() === taskPath.toLowerCase());
      if (existing) {
        return {
          job: existing,
          merged: true,
          queueWarning: this.ensureRunnerAvailabilitySignal(existing),
        };
      }
    }
    if (Number.isSafeInteger(input.maxOpenJobs) && Number(input.maxOpenJobs) > 0) {
      const open = this.statements.openJobsByRequester.get(input.requestedBy) as { c: number };
      if (open.c >= Number(input.maxOpenJobs)) {
        return { error: `你已有 ${open.c} 个任务在队列里，先用 worker_job_status 看看它们，别刷屏。` };
      }
    }

    const id = crypto.randomUUID();
    const workspace = normalizeWorkspace(input.workspace);
    const ttlMinutes = Math.min(Math.max(Number(input.ttlMinutes) || 1440, 5), 10080);
    const rawOptions = input.options ?? {};
    const workflowTaskPath = rawOptions.taskPath ?? coordinationTaskPath(input.prompt) ?? '';
    const stage = rawOptions.workflowStage ?? stageForRouteClass(rawOptions.routeClass);
    const fingerprint = rawOptions.problemFingerprint ?? problemFingerprint(input.prompt, workflowTaskPath);
    const workflow = rawOptions.workflow ?? this.workflowProfiles.snapshot({
      stage,
      taskPath: workflowTaskPath,
      problemFingerprint: fingerprint,
    });
    const options = JSON.stringify({
      ...rawOptions,
      workflowStage: stage,
      problemFingerprint: fingerprint,
      taskPath: workflowTaskPath,
      workflow,
    });
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
    const job = this.get(id)!;
    const queueWarning = this.ensureRunnerAvailabilitySignal(job);
    this.emitJob(id);
    return { job, queueWarning };
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
    const result = this.db.transaction(() => {
      const change = this.statements.resolveOutOfBand.run(deliveryMeta, job.id);
      if (change.changes) this.enqueueFinished(job.id);
      return change;
    })();
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
    this.scheduleOutboxDrain();
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
    // 终态转换与 outbox 入队同一事务：进程在内存回调前崩溃时，
    // pending 行在重启后仍会驱动回执/tail 重放。
    const update = this.db.transaction(() => {
      const change = this.statements.complete.run(
        status,
        result,
        error,
        deliveryState,
        deliveryMeta,
        current.id,
        current.status
      );
      if (change.changes && ['done', 'blocked', 'failed', 'interrupted'].includes(status)) {
        this.enqueueFinished(current.id);
      }
      return change;
    })();
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
      this.scheduleOutboxDrain();
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
