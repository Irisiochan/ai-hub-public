import type { JobRow } from '../db.js';
import { deriveDeliverySummary } from './deliveryStatus.js';

export interface CoordinationMarker {
  taskPath: string;
  planHash: string;
}

export function parseCoordinationMarker(prompt: string | null | undefined): CoordinationMarker | null {
  const lines = String(prompt ?? '').split(/\r?\n/);
  if (lines[0]?.trim() !== '[AI_HUB_COORDINATION_V1]') return null;
  const taskPath = lines.find((line) => line.startsWith('taskPath='))?.slice('taskPath='.length).trim() ?? '';
  const planHash = lines.find((line) => line.startsWith('planHash='))?.slice('planHash='.length).trim() ?? '';
  if (!/^tasks\/[^/]+\.md$/i.test(taskPath)) return null;
  if (!/^[a-f0-9]{64}$/.test(planHash)) return null;
  return { taskPath, planHash };
}

function deliveryMeta(job: JobRow): Record<string, unknown> {
  try {
    const value = job.delivery_meta ? JSON.parse(job.delivery_meta) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function textList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
    : [];
}

export function formatCoordinationReceipt(job: JobRow, marker: CoordinationMarker): string {
  const delivery = deriveDeliverySummary(job);
  const meta = deliveryMeta(job);
  const dirtyFiles = textList(meta.dirtyFiles);
  const head = typeof meta.head === 'string' && meta.head.trim() ? meta.head.trim() : '（未报告）';
  const branch = typeof meta.branch === 'string' && meta.branch.trim() ? meta.branch.trim() : '（未报告）';
  const ahead = Number.isFinite(Number(meta.ahead)) ? Number(meta.ahead) : null;
  const declared = meta.declared && typeof meta.declared === 'object' && !Array.isArray(meta.declared)
    ? meta.declared as Record<string, unknown>
    : {};
  const validation = typeof declared.summary === 'string' && declared.summary.trim()
    ? declared.summary.trim()
    : (job.result || job.error || '（无 Worker 回执）').slice(0, 2000);
  const hasWorkerTail = ['blocked_local_changes', 'blocked_unpushed'].includes(job.delivery_state ?? '');
  return [
    '@claude 工作对接回执，请 review。',
    `任务文件：${marker.taskPath}`,
    `Plan hash：${marker.planHash}`,
    `Worker job：${job.id}`,
    `终态：${job.status} / ${job.delivery_state ?? 'unknown'}`,
    `交付摘要：${delivery.summary}`,
    `下一步负责人：${delivery.nextOwner}`,
    `执行环境：${job.runner} · ${job.workspace}`,
    `Git：branch=${branch} · HEAD=${head}${ahead === null ? '' : ` · ahead=${ahead}`}`,
    `工作树：${dirtyFiles.length ? `dirty (${dirtyFiles.join(', ')})` : 'clean / 未报告 dirtyFiles'}`,
    `worker-tail：${hasWorkerTail ? `有（tasks/worker-tail-${job.id}.md）` : '无'}`,
    '',
    '验证与 Worker 原始回执：',
    validation,
    '',
    '请只依据这份结构化回执和 worker_job_status 给出 PASS/返工结论；不要替 User 做需求取舍。',
  ].join('\n');
}
