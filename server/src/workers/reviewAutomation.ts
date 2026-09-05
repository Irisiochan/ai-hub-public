import crypto from 'node:crypto';
import type { ContactRow, Db, JobRow, MessageRow } from '../db.js';
import type { HubLogger } from '../logger.js';
import type { SseHub } from '../sse.js';
import {
  dispatchCoordinationRoomHost,
  type CoordinationRoomDispatchInput,
  type CoordinationRoomDispatchResult,
} from '../agents/coordinationRoom.js';
import { contactConfig } from '../agents/configSchemas.js';
import { resolveRoomOrchestratorId } from '../agents/roomPrompt.js';
import { deriveDeliverySummary } from './deliveryStatus.js';
import { parseCoordinationMarker } from './coordinationReceipt.js';
import { formatWorkerReceiptPreview } from './receiptPreview.js';
import { structuredReceiptFields } from './receiptFields.js';
import type { JobStore } from './jobStore.js';
import { problemFingerprint } from './workflowProfiles.js';

type JsonRecord = Record<string, unknown>;

interface ReviewBatchManager {
  imageRoomMembers(room: ContactRow): ContactRow[];
  dispatchRoomMessageTracked(
    room: ContactRow,
    content: string,
    options: {
      targetOverride: ContactRow[];
      capture: false;
      reactionRounds: 0;
      coordinationDomain: true;
      userMessageId?: number;
    },
  ): { completion: Promise<unknown>; deferred?: boolean };
  roomDispatchDraining?(): boolean;
}

export interface ReviewBatchConfig {
  size?: number;
  intervalMinutes?: number;
}

interface PendingReceipt extends MessageRow {
  idempotency_key: string;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function parse(raw: string | null | undefined): JsonRecord {
  try { return raw ? record(JSON.parse(raw)) : {}; } catch { return {}; }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function compact(value: unknown, limit = 280): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '未提供摘要';
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function clip(value: unknown, limit: number): string {
  const raw = String(value ?? '').trim();
  return raw.length <= limit ? raw : `${raw.slice(0, limit - 1)}…`;
}

function optionsOf(job: JobRow): JsonRecord {
  return parse(job.options);
}

function declaredStage(job: JobRow): string {
  const declared = record(parse(job.delivery_meta).declared);
  return text(declared.stage).toLowerCase().replace(/-/g, '_');
}

export function isWaitingReviewGate(job: JobRow): boolean {
  const options = optionsOf(job);
  const permissions = parse(job.permissions);
  const routeClass = text(options.routeClass).toLowerCase();
  return ['implement', 'fix'].includes(routeClass)
    && permissions.write === true
    && job.status === 'blocked'
    && job.delivery_state === 'blocked_unpushed'
    && declaredStage(job) === 'waiting_review';
}

export function isHarnessAutoReview(job: JobRow): boolean {
  const options = optionsOf(job);
  return text(options.routeClass).toLowerCase() === 'review'
    && options.dispatchSource === 'harness-auto';
}

function reviewPrompt(parent: JobRow, taskPath: string): string {
  const marker = parseCoordinationMarker(parent.prompt);
  const markerLines = marker ? [
    '[AI_HUB_COORDINATION_V1]',
    `taskPath=${marker.taskPath}`,
    `planHash=${marker.planHash}`,
  ] : [];
  const sourceTask = clip(parent.prompt, 8_000);
  const delivery = deriveDeliverySummary(parent);
  const preview = formatWorkerReceiptPreview(parent);
  const receipt = structuredReceiptFields(parent);
  const reviewReceipt = {
    ...receipt,
    changedFiles: receipt.changedFiles ? {
      ...receipt.changedFiles,
      files: receipt.changedFiles.files.slice(0, 20),
      truncated: receipt.changedFiles.truncated || receipt.changedFiles.files.length > 20,
    } : null,
    tests: receipt.tests?.slice(0, 20).map(({ suite, status }) => ({ suite, status })) ?? null,
  };
  return [
    ...markerLines,
    '【harness-auto review v1】',
    '这是源实现单停在 waiting_review 闸门后由纯规则自动创建的独立只读 review。',
    `parentJobId=${parent.id}`,
    `taskPath=${taskPath || '未提供'}`,
    `workspace=${parent.workspace}`,
    `sourceTerminal=${parent.status}/${parent.delivery_state ?? 'unknown'}`,
    `sourceSummary=${delivery.summary}`,
    '',
    '请在同一 workspace 对源实现单的范围、提交、diff 与验证证据做独立审查；不得修改文件、提交、推送、部署或 SSH。',
    '结论必须明确写 APPROVE 或 REQUEST_CHANGES，并给出最短充分理由。',
    `默认只使用下方 preview 与结构化字段。只有证据不足时才 opt-in recall：worker_job_status(job_id="${parent.id}", result_offset=0, result_limit=4000)，按 nextOffset 翻到 atEnd=true。`,
    '',
    '### 源实现单任务说明',
    sourceTask,
    '',
    '### 源实现单回执 preview',
    preview,
    '',
    '### 结构化字段（harness 原样搬运）',
    JSON.stringify(reviewReceipt),
  ].join('\n');
}

export function ensureAutomaticReviewJob(
  store: JobStore,
  parent: JobRow,
): { status: 'not-eligible' | 'existing' | 'created'; job?: JobRow } {
  if (!isWaitingReviewGate(parent)) return { status: 'not-eligible' };
  const idempotencyKey = `review:v1:${parent.id}:${parent.status}`;
  const existing = store.getByIdempotencyKey(idempotencyKey);
  if (existing) return { status: 'existing', job: existing };

  const parentOptions = optionsOf(parent);
  const marker = parseCoordinationMarker(parent.prompt);
  const taskPath = text(parentOptions.taskPath) || marker?.taskPath || '';
  const fingerprint = text(parentOptions.problemFingerprint)
    || problemFingerprint(parent.prompt, taskPath);
  const workflow = store.workflowProfiles.snapshot({
    stage: 'review',
    taskPath,
    problemFingerprint: fingerprint,
  });
  const created = store.create({
    requestedBy: 'claude',
    runner: workflow.selected.runner,
    workspace: parent.workspace,
    prompt: reviewPrompt(parent, taskPath),
    priority: parent.priority,
    idempotencyKey,
    permissions: { write: false, shell: true, ssh: false },
    originContactId: parent.origin_contact_id,
    originAnchorId: parent.origin_anchor_id,
    options: {
      model: workflow.selected.model,
      reasoning: workflow.selected.reasoning,
      routeClass: 'review',
      runnerSource: 'policy',
      workflowStage: 'review',
      problemFingerprint: fingerprint,
      taskPath,
      workflow,
      parentJobId: parent.id,
      dispatchSource: 'harness-auto',
    },
  });
  if ('error' in created) {
    const replay = store.getByIdempotencyKey(idempotencyKey);
    if (replay) return { status: 'existing', job: replay };
    throw new Error(`automatic review creation failed: ${created.error}`);
  }
  if (created.job.idempotency_key !== idempotencyKey) {
    throw new Error(`automatic review creation merged into unrelated active job ${created.job.id}`);
  }
  return { status: 'created', job: created.job };
}

/** Delay to the next wall-clock interval boundary in Asia/Shanghai. */
export function nextReviewBatchWallClockDelay(intervalMinutes = 30, now = Date.now()): number {
  const interval = Math.min(Math.max(Math.floor(Number(intervalMinutes) || 30), 1), 24 * 60);
  const shanghaiNow = new Date(now + 8 * 60 * 60_000);
  const minuteOfDay = shanghaiNow.getUTCHours() * 60 + shanghaiNow.getUTCMinutes();
  const nextMinute = (Math.floor(minuteOfDay / interval) + 1) * interval;
  const dayAdvance = Math.floor(nextMinute / (24 * 60));
  const targetMinute = nextMinute % (24 * 60);
  const shiftedTarget = Date.UTC(
    shanghaiNow.getUTCFullYear(),
    shanghaiNow.getUTCMonth(),
    shanghaiNow.getUTCDate() + dayAdvance,
    Math.floor(targetMinute / 60),
    targetMinute % 60,
    0,
    0,
  );
  return Math.max(shiftedTarget - (now + 8 * 60 * 60_000), 1);
}

export class ReviewBatchCoordinator {
  private readonly size: number;
  private readonly intervalMinutes: number;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private flushing = false;

  constructor(private readonly deps: {
    db: Db;
    sse: SseHub;
    manager: ReviewBatchManager;
    logger?: HubLogger;
  }, config: ReviewBatchConfig = {}) {
    this.size = Math.min(Math.max(Math.floor(Number(config.size) || 3), 1), 100);
    this.intervalMinutes = Math.min(
      Math.max(Math.floor(Number(config.intervalMinutes) || 30), 1),
      24 * 60,
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.armTimer();
    if (this.readyDecisionCount() >= this.size) this.flushSafely('size');
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  available(): boolean {
    return this.started && this.timer !== null && this.deps.db.open;
  }

  pendingCount(): number {
    const row = this.deps.db.prepare(
      `SELECT COUNT(*) AS count FROM messages
       WHERE sender = 'room-host'
         AND json_extract(meta, '$.roomHost.reviewBatch.status') = 'pending'`
    ).get() as { count: number };
    return Number(row.count);
  }

  dispatchReceipt(job: JobRow, input: CoordinationRoomDispatchInput): CoordinationRoomDispatchResult {
    if (!this.available()) {
      return dispatchCoordinationRoomHost(this.deps, input);
    }
    const options = optionsOf(job);
    const review = isHarnessAutoReview(job);
    const result = dispatchCoordinationRoomHost(this.deps, {
      ...input,
      skipWake: true,
      meta: {
        ...input.meta,
        reviewBatch: {
          version: 1,
          status: 'pending',
          jobId: job.id,
          parentJobId: text(options.parentJobId) || (review ? 'unknown' : job.id),
          routeClass: text(options.routeClass) || 'unknown',
          jobStatus: job.status,
          deliveryState: job.delivery_state ?? 'unknown',
          summary: deriveDeliverySummary(job).summary,
          reviewConclusion: review
            ? compact(job.result || job.error || 'review 未提供文本结论')
            : '等待自动 review 结论',
          queuedAt: new Date().toISOString(),
        },
      },
    });
    if (result.status !== 'unavailable' && this.readyDecisionCount() >= this.size) {
      this.flushSafely('size');
    }
    return result;
  }

  flushNow(reason: 'size' | 'timer' | 'manual' = 'manual'): number {
    try {
      if (this.deps.manager.roomDispatchDraining?.()) {
        this.deps.logger?.info(
          { component: 'review-batch', reason },
          'review batch flush deferred by deploy drain; persisted receipts stay pending',
        );
        return 0;
      }
    } catch (error) {
      this.deps.logger?.error(
        { component: 'review-batch', err: error },
        'deploy drain guard failed open; continuing review batch flush',
      );
    }
    try {
      return this.flush(reason);
    } catch (error) {
      this.deps.logger?.error(
        { component: 'review-batch', err: error },
        'review batch flush failed; waking persisted receipts individually',
      );
      this.failOpenPending(error instanceof Error ? error.message : String(error));
      return 0;
    }
  }

  private armTimer(): void {
    if (!this.started) return;
    const delay = nextReviewBatchWallClockDelay(this.intervalMinutes);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushSafely('timer');
      this.armTimer();
    }, delay);
    this.timer.unref();
  }

  private pendingRows(): PendingReceipt[] {
    const first = this.deps.db.prepare(
      `SELECT * FROM messages
       WHERE sender = 'room-host'
         AND json_extract(meta, '$.roomHost.reviewBatch.status') = 'pending'
       ORDER BY id LIMIT 1`
    ).get() as PendingReceipt | undefined;
    if (!first) return [];
    return this.deps.db.prepare(
      `SELECT * FROM messages
       WHERE contact_id = ? AND sender = 'room-host'
         AND json_extract(meta, '$.roomHost.reviewBatch.status') = 'pending'
       ORDER BY id LIMIT 100`
    ).all(first.contact_id) as PendingReceipt[];
  }

  private readyDecisionCount(): number {
    const row = this.deps.db.prepare(
      `SELECT COUNT(DISTINCT json_extract(meta, '$.roomHost.reviewBatch.parentJobId')) AS count
       FROM messages
       WHERE sender = 'room-host'
         AND json_extract(meta, '$.roomHost.reviewBatch.status') = 'pending'
         AND json_extract(meta, '$.roomHost.reviewBatch.routeClass') = 'review'`
    ).get() as { count: number };
    return Number(row.count);
  }

  private flush(reason: 'size' | 'timer' | 'manual'): number {
    if (this.flushing) return 0;
    this.flushing = true;
    try {
      const rows = this.pendingRows();
      if (rows.length === 0) return 0;
      const room = this.deps.db.prepare('SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = \'room\'')
        .get(rows[0].contact_id) as ContactRow | undefined;
      if (!room) throw new Error('review batch room is unavailable');
      const orchestrator = resolveRoomOrchestratorId(contactConfig(room));
      const flushId = crypto.createHash('sha256')
        .update(rows.map((row) => String(row.id)).join(','))
        .digest('hex')
        .slice(0, 20);
      const grouped = new Map<string, JsonRecord[]>();
      for (const row of rows) {
        const batch = record(record(parse(row.meta).roomHost).reviewBatch);
        const parentJobId = text(batch.parentJobId) || text(batch.jobId) || 'unknown';
        grouped.set(parentJobId, [...(grouped.get(parentJobId) ?? []), batch]);
      }
      const lines = [...grouped.entries()].map(([parentJobId, entries]) => {
        const implementation = entries.find((entry) => ['implement', 'fix'].includes(text(entry.routeClass))) ?? {};
        const review = entries.find((entry) => text(entry.routeClass) === 'review') ?? {};
        return [
          `- parentJobId=${parentJobId}`,
          `status=${text(implementation.jobStatus) || 'unknown'}`,
          `delivery=${text(implementation.deliveryState) || 'unknown'}`,
          `reviewJobId=${text(review.jobId) || 'pending'}`,
          `reviewStatus=${text(review.jobStatus) || 'pending'}/${text(review.deliveryState) || 'unknown'}`,
          `review=${compact(review.reviewConclusion || '等待自动 review 结论')}`,
        ].join(' ');
      });
      const content = [
        `@${orchestrator} 【Review 攒批裁决】`,
        `flushId=${flushId} reason=${reason} count=${grouped.size} receipts=${rows.length}`,
        ...lines,
        'Recall：需要逐项完整证据时调用 worker_job_status(job_id, result_offset, result_limit)。',
      ].join('\n');
      const outcome = dispatchCoordinationRoomHost(this.deps, {
        targetId: orchestrator,
        content,
        kind: 'review-batch',
        exactDispatchKey: rows[0].idempotency_key,
        idempotencyKey: `review-batch:v1:${flushId}`,
        meta: {
          reviewBatchFlush: {
            version: 1,
            flushId,
            reason,
            count: grouped.size,
            receiptCount: rows.length,
            messageIds: rows.map((row) => row.id),
            jobIds: rows.map((row) => text(record(record(parse(row.meta).roomHost).reviewBatch).jobId)),
          },
        },
      });
      if (outcome.status === 'unavailable') {
        throw new Error(`review batch dispatch unavailable: ${outcome.reason ?? 'unknown'}`);
      }
      this.markRows(rows, 'flushed', { flushId, flushMessageId: outcome.messageId ?? null });
      return rows.length;
    } finally {
      this.flushing = false;
    }
  }

  private flushSafely(reason: 'size' | 'timer'): void {
    try { this.flushNow(reason); } catch (fallbackError) {
      this.deps.logger?.error(
        { component: 'review-batch', err: fallbackError },
        'review batch fail-open wake failed; receipts remain pending for the next wall-clock retry',
      );
    }
  }

  private failOpenPending(reason: string): void {
    const rows = this.pendingRows();
    for (const row of rows) {
      const room = this.deps.db.prepare('SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = \'room\'')
        .get(row.contact_id) as ContactRow | undefined;
      const meta = parse(row.meta);
      const roomHost = record(meta.roomHost);
      const targetId = Array.isArray(roomHost.targets) ? text(roomHost.targets[0]) : '';
      const target = room
        ? this.deps.manager.imageRoomMembers(room).find((member) => member.id === targetId)
        : undefined;
      if (!room || !target) throw new Error(`cannot fail-open receipt ${row.id}: room target unavailable`);
      this.deps.manager.dispatchRoomMessageTracked(room, row.content, {
        targetOverride: [target],
        capture: false,
        reactionRounds: 0,
        coordinationDomain: true,
        userMessageId: row.id,
      });
      this.markRows([row], 'fail_open', { reason: compact(reason, 500) });
    }
  }

  private markRows(
    rows: PendingReceipt[],
    status: 'flushed' | 'fail_open',
    detail: JsonRecord,
  ): void {
    const tx = this.deps.db.transaction(() => {
      for (const row of rows) {
        const meta = parse(row.meta);
        const roomHost = record(meta.roomHost);
        const reviewBatch = record(roomHost.reviewBatch);
        const next = {
          ...meta,
          roomHost: {
            ...roomHost,
            wakeSkipped: status === 'flushed',
            reviewBatch: {
              ...reviewBatch,
              status,
              completedAt: new Date().toISOString(),
              ...detail,
            },
          },
        };
        this.deps.db.prepare('UPDATE messages SET meta = ? WHERE id = ?')
          .run(JSON.stringify(next), row.id);
      }
    });
    tx();
    for (const row of rows) {
      const updated = this.deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id) as MessageRow;
      this.deps.sse.broadcast('message', updated);
    }
  }
}
