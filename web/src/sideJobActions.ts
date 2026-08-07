import type { Message, WorkerJob } from './api';

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
    if (message.origin === 'side' && meta.event === 'worker-receipt') {
      return typeof meta.jobId === 'string' && meta.jobId.trim() ? meta.jobId.trim() : null;
    }
    const roomJobId = meta.roomHost?.receipt?.jobId ?? meta.roomHost?.coordination?.jobId;
    return typeof roomJobId === 'string' && roomJobId.trim() ? roomJobId.trim() : null;
  } catch {
    return null;
  }
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
