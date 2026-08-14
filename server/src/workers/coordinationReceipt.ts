import type { JobRow } from '../db.js';
import { legacyExecutionDispatchKey } from './coordinationKeys.js';
import { formatWorkerReceiptPreview } from './receiptPreview.js';

export interface CoordinationMarker {
  taskPath: string;
  planHash: string;
  /** fingerprint v2（覆盖 executor/workspace/branch）；V1 旧 prompt 没有该行。 */
  fingerprint?: string;
}

export function parseCoordinationMarker(prompt: string | null | undefined): CoordinationMarker | null {
  const lines = String(prompt ?? '').split(/\r?\n/);
  const header = lines[0]?.trim();
  if (header !== '[AI_HUB_COORDINATION_V1]' && header !== '[AI_HUB_COORDINATION_V2]') return null;
  const taskPath = lines.find((line) => line.startsWith('taskPath='))?.slice('taskPath='.length).trim() ?? '';
  const planHash = lines.find((line) => line.startsWith('planHash='))?.slice('planHash='.length).trim() ?? '';
  if (!/^tasks\/[^/]+\.md$/i.test(taskPath)) return null;
  if (!/^[a-f0-9]{64}$/.test(planHash)) return null;
  if (header === '[AI_HUB_COORDINATION_V1]') return { taskPath, planHash };
  const fingerprint = lines.find((line) => line.startsWith('fingerprint='))?.slice('fingerprint='.length).trim() ?? '';
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return null;
  return { taskPath, planHash, fingerprint };
}

/** 回执/幂等键必须与派单时 idempotencyKey 完全一致：V2 用 fingerprint，V1 走旧格式。 */
export function coordinationMarkerDispatchKey(marker: CoordinationMarker): string {
  return marker.fingerprint
    ? `coordination:v2:${marker.taskPath}:${marker.fingerprint}`
    : legacyExecutionDispatchKey(marker);
}

export function formatCoordinationReceipt(job: JobRow, marker: CoordinationMarker): string {
  return formatWorkerReceiptPreview(job, {
    heading: '@claude 工作对接回执（preview），请 review。',
    prefixLines: [
      `任务文件：${marker.taskPath}`,
      `Plan hash：${marker.planHash}`,
    ],
    closing: '请依据 preview 给出 PASS/返工结论；需要逐项证据时用 worker_job_status 分页 recall，不要替 User 做需求取舍。',
  });
}
