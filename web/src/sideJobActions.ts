import type { Message, WorkerJob } from './api';

export interface PendingReceiptCard {
  message: Message;
  job: WorkerJob;
}

export function workerReceiptJobId(message: Pick<Message, 'meta' | 'origin' | 'kind'>): string | null {
  if (message.kind !== 'text') return null;
  try {
    const meta = JSON.parse(message.meta || '{}') as {
      event?: unknown;
      jobId?: unknown;
      roomHost?: {
        coordination?: { jobId?: unknown };
        receipt?: { jobId?: unknown };
      };
    };
    const roomJobId = meta.roomHost?.receipt?.jobId ?? meta.roomHost?.coordination?.jobId;
    return typeof roomJobId === 'string' && roomJobId.trim() ? roomJobId.trim() : null;
  } catch {
    return null;
  }
}

export function visibleJobsForContact(
  contactId: string,
  messages: readonly Pick<Message, 'meta' | 'origin' | 'kind'>[],
  jobs: readonly WorkerJob[],
  activeStatuses: ReadonlySet<string>,
): WorkerJob[] {
  const receiptJobIds = new Set<string>();
  for (const message of messages) {
    const jobId = workerReceiptJobId(message);
    if (jobId) receiptJobIds.add(jobId);
  }
  return jobs.filter(
    (job) =>
      receiptJobIds.has(job.id) ||
      job.origin_contact_id === contactId ||
      (!job.origin_contact_id && job.requested_by === contactId && activeStatuses.has(job.status))
  );
}

export function receiptDeliveryState(
  job: Pick<WorkerJob, 'delivery_summary' | 'delivery_meta'>,
): string {
  const declared = job.delivery_meta?.declared?.stage;
  const summary = job.delivery_summary?.state;
  const raw = typeof summary === 'string' && summary.trim()
    ? summary
    : typeof declared === 'string' ? declared : '';
  return raw.toLowerCase().replace(/-/g, '_');
}

/** Pin bar only lists receipts that still need a human action. */
export function isActionableReceiptJob(
  job: Pick<WorkerJob, 'delivery_summary' | 'delivery_meta'>,
): boolean {
  return receiptDeliveryState(job) !== 'closed_loop';
}

export const HANDLED_RECEIPTS_STORAGE_PREFIX = 'ai-hub:handled-receipts:';

export function loadHandledReceiptIds(contactId: string, storage: Pick<Storage, 'getItem'> | null = defaultStorage()): Set<number> {
  if (!storage || !contactId) return new Set();
  try {
    const raw = storage.getItem(`${HANDLED_RECEIPTS_STORAGE_PREFIX}${contactId}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is number => Number.isSafeInteger(value)));
  } catch {
    return new Set();
  }
}

export function saveHandledReceiptIds(
  contactId: string,
  ids: ReadonlySet<number>,
  storage: Pick<Storage, 'setItem'> | null = defaultStorage(),
): void {
  if (!storage || !contactId) return;
  storage.setItem(
    `${HANDLED_RECEIPTS_STORAGE_PREFIX}${contactId}`,
    JSON.stringify([...ids].sort((a, b) => a - b)),
  );
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function pendingReceiptCards(
  messages: readonly Message[],
  jobs: readonly WorkerJob[],
  handledMessageIds: ReadonlySet<number> = new Set(),
): PendingReceiptCard[] {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const pending: PendingReceiptCard[] = [];
  for (const message of messages) {
    if (handledMessageIds.has(message.id)) continue;
    const jobId = workerReceiptJobId(message);
    const job = jobId ? jobsById.get(jobId) : undefined;
    if (job && isActionableReceiptJob(job)) pending.push({ message, job });
  }
  return pending;
}

export function reworkIdempotencyKey(jobId: string, receiptMessageId: number): string {
  return `rework-${jobId}-${receiptMessageId}`;
}

function stableKeyPart(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export interface FollowupJobInput {
  instruction: string;
  runner: WorkerJob['runner'];
  workspace: string;
}

export function followupIdempotencyKey(
  jobId: string,
  receiptMessageId: number,
  input: FollowupJobInput
): string {
  return `followup-${jobId}-${receiptMessageId}-${stableKeyPart(
    `${input.runner}\n${input.workspace.trim()}\n${input.instruction.trim()}`
  )}`;
}

export function buildReworkPrompt(job: Pick<WorkerJob, 'prompt'>, receipt: Pick<Message, 'content'>): string {
  return [
    '## 打回重做（Worker 回执结构化操作）',
    '',
    '这是原任务的直接返工，不是一个脱离上下文的新需求。请依据下面的原指令和本次 Worker 回执修正问题，完成相称验证后再交付。',
    '',
    '### 原任务指令',
    job.prompt.trim(),
    '',
    '### 本次 Worker 回执 / 验收依据',
    receipt.content.trim(),
  ].join('\n');
}

export function buildFollowupPrompt(
  input: Pick<FollowupJobInput, 'instruction'>,
  receipt: Pick<Message, 'content'>
): string {
  return [
    '## 再派一单（Worker 回执结构化操作）',
    '',
    '### 新指令',
    input.instruction.trim(),
    '',
    '### 来源 Worker 回执',
    receipt.content.trim(),
  ].join('\n');
}

export function taskPathCandidates(
  job: Pick<WorkerJob, 'prompt'>,
  receipt: Pick<Message, 'content'>
): string[] {
  const found = `${job.prompt}\n${receipt.content}`.match(/tasks\/[a-z0-9][a-z0-9-]*\.md/gi) ?? [];
  return [...new Set(found.map((candidate) => candidate.toLowerCase()))];
}

export function isTailTaskPath(taskPath: string): boolean {
  return /^tasks\/(?:worker-tail-|deploy-)/i.test(taskPath.trim());
}

export function defaultClosableTaskPath(
  job: Pick<WorkerJob, 'prompt'>,
  receipt: Pick<Message, 'content'>
): string {
  const candidates = taskPathCandidates(job, receipt).filter((candidate) => !isTailTaskPath(candidate));
  return candidates.length === 1 ? candidates[0] : '';
}

/** 验收卡置 done：vault 任务已关闭/归档时仍应收口卡片，不要把 409 当成操作失败。 */
export function vaultTaskAlreadySettled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = 'status' in error ? Number((error as { status?: unknown }).status) : NaN;
  const message = error instanceof Error ? error.message : '';
  if (status === 404) return true;
  return status === 409 && /任务不是 open 状态/.test(message);
}
