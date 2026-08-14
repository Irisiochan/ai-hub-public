import type { JobRow } from '../db.js';
import { deriveDeliverySummary } from './deliveryStatus.js';

export const WORKER_RECEIPT_PREVIEW_MAX_CHARS = 2_000;

type JsonRecord = Record<string, unknown>;

export interface WorkerReceiptPreviewOptions {
  heading?: string;
  prefixLines?: string[];
  closing?: string;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function deliveryMeta(job: JobRow): JsonRecord {
  try { return job.delivery_meta ? record(JSON.parse(job.delivery_meta)) : {}; } catch { return {}; }
}

function jobOptions(job: JobRow): JsonRecord {
  try { return job.options ? record(JSON.parse(job.options)) : {}; } catch { return {}; }
}

function compact(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > limit ? `${text.slice(0, Math.max(limit - 1, 0))}…` : text;
}

function evidenceSummary(job: JobRow): string {
  const body = job.result || job.error || '';
  const lines = body
    .split(/\r?\n/)
    .map((line) => compact(line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, ''), 280))
    .filter((line) => line && line !== '```' && !/^\{?\s*"?delivery"?\s*:/i.test(line));
  if (lines.length === 0) return '（无 Worker 回执摘要）';

  const noteworthy = /验证|测试|test|build|lint|check|pass|fail|commit|push|deploy|部署|health|http|结论|改动|changed/i;
  const candidates = lines.filter((line) => noteworthy.test(line));
  const selected: string[] = [];
  for (const line of candidates.length > 0 ? candidates : lines.slice(0, 4)) {
    if (!selected.includes(line)) selected.push(line);
    if (selected.length >= 6) break;
  }
  return compact(selected.join(' | '), 440);
}

function deliveryEvidence(job: JobRow): string {
  const meta = deliveryMeta(job);
  const declared = record(meta.declared);
  const deployment = record(meta.deployment);
  const rawGit = record(meta.git);
  const git = Object.keys(rawGit).length > 0 ? rawGit : meta;
  const parts: string[] = [];
  if (typeof declared.committed === 'boolean') parts.push(`commit=${declared.committed ? '是' : '否'}`);
  if (typeof declared.pushed === 'boolean') parts.push(`push=${declared.pushed ? '是' : '否'}`);
  if (typeof declared.stage === 'string' && declared.stage.trim()) {
    parts.push(`stage=${compact(declared.stage, 80)}`);
  }
  if (typeof git.branch === 'string' && git.branch.trim()) parts.push(`branch=${compact(git.branch, 100)}`);
  if (typeof git.head === 'string' && git.head.trim()) parts.push(`HEAD=${compact(git.head, 64)}`);
  if (typeof git.ahead === 'number' && Number.isFinite(git.ahead)) parts.push(`ahead=${git.ahead}`);
  if (typeof git.behind === 'number' && Number.isFinite(git.behind)) parts.push(`behind=${git.behind}`);
  if (Array.isArray(git.dirtyFiles)) parts.push(`dirty=${git.dirtyFiles.length}`);
  if (typeof deployment.commit === 'string' && deployment.commit.trim()) {
    parts.push(`部署 commit=${compact(deployment.commit, 64)}`);
  }
  if (typeof deployment.deployedAt === 'string' && deployment.deployedAt.trim()) {
    parts.push(`deployedAt=${compact(deployment.deployedAt, 80)}`);
  }
  return parts.join(' · ');
}

function deliveryCheckLines(job: JobRow): string[] {
  const checks = deliveryMeta(job).checks;
  if (!Array.isArray(checks) || checks.length === 0) return [];
  const normalized = checks.map(record);
  const failed = normalized.filter((item) => item.pass === false);
  if (failed.length > 0) {
    return failed.map((item) => (
      `机检未通过：${compact(item.id, 80) || 'unknown'} — ${compact(item.detail, 220) || '无详情'}`
    ));
  }
  const skipped = normalized.filter((item) => item.skipped === true).length;
  const passed = normalized.length - skipped;
  return [`机检 ${passed} 项全过${skipped > 0 ? `，${skipped} 项跳过` : ''}`];
}

function boundedReceipt(lines: string[], recall: string): string {
  const suffix = `\n\n${recall}`;
  const available = WORKER_RECEIPT_PREVIEW_MAX_CHARS - suffix.length;
  const content = lines.filter(Boolean).join('\n').trim();
  const bounded = content.length > available
    ? `${content.slice(0, Math.max(available - 1, 0)).trimEnd()}…`
    : content;
  return `${bounded}${suffix}`;
}

/** A bounded model-facing receipt. The complete result remains on the job row. */
export function formatWorkerReceiptPreview(
  job: JobRow,
  options: WorkerReceiptPreviewOptions = {},
): string {
  const delivery = deriveDeliverySummary(job);
  const declared = record(deliveryMeta(job).declared);
  const omitUndeclaredReviewConclusion = jobOptions(job).routeClass === 'review'
    && Object.keys(declared).length === 0;
  const evidence = deliveryEvidence(job);
  const recall = [
    `Recall 全文：调用 worker_job_status(job_id="${job.id}", result_offset=0, result_limit=4000)，`,
    '按返回的下一页 offset 继续，直到“已到全文末尾”。',
    ['blocked_local_changes', 'blocked_unpushed'].includes(job.delivery_state ?? '')
      ? `Vault 备援：read_file("tasks/worker-tail-${job.id}.md")。`
      : '',
  ].filter(Boolean).join('');

  return boundedReceipt([
    compact(options.heading ?? '⚙ Worker 任务回执（preview）', 100),
    ...(options.prefixLines ?? []).map((line) => compact(line, 180)),
    `Worker job：${job.id}`,
    `状态：${job.status} / ${job.delivery_state ?? 'unknown'}`,
    `runner：${job.runner}`,
    omitUndeclaredReviewConclusion ? '' : `结论：${compact(delivery.summary, 300)}`,
    `下一步负责人：${compact(delivery.nextOwner, 80)}`,
    evidence ? `commit/push/部署摘要：${compact(evidence, 320)}` : '',
    ...deliveryCheckLines(job),
    `验证要点：${evidenceSummary(job)}`,
    compact(options.closing ?? '请按 preview 验收；需要逐项证据时先 recall 完整回执。', 180),
  ], recall);
}
