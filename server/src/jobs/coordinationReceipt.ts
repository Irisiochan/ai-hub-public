import type { JobRow } from '../platform/index.js';
import { deriveDeliverySummary } from './deliveryStatus.js';
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

/**
 * Stage-aware closing for the coordination host receipt. Neutral wording:
 * no persona @mention, no chat PASS verdict. Waiting_review stays at the
 * independent review gate (candidate-bound, not chat approval); real blocked
 * failures and deployment tails each describe their own next step. Never
 * claims a review job was dispatched — dispatch evidence lives in the harness,
 * not in this text.
 */
export function coordinationReceiptClosing(job: JobRow): string {
  const summary = deriveDeliverySummary(job);
  switch (summary.state) {
    case 'waiting_review':
      return '当前停在独立 review 闸门。正式结论以 review 模块的 candidate-bound 审查为准，不在群里用 preview 给 PASS；需要逐项证据时用 worker_job_status 分页 recall，不要替 User 做需求取舍。';
    case 'failure_or_blocked':
      return '当前为失败或受阻，按实际阶段处理失败或阻塞原因，不要用 preview 给 PASS；需要逐项证据时用 worker_job_status 分页 recall，不要替 User 做需求取舍。';
    case 'completed_not_delivered':
      return '当前尚未形成可接收交付，按实际阶段继续处理，不要用 preview 给 PASS；需要逐项证据时用 worker_job_status 分页 recall，不要替 User 做需求取舍。';
    case 'delivered_waiting_deploy':
      return '代码评审通过不等于部署后验证通过；APPROVE 只绑定 candidateSha，不能代替部署成功。按部署闸继续，不要用 preview 给 PASS；需要逐项证据时用 worker_job_status 分页 recall。';
    case 'online_waiting_validation':
      return '变更已经上线，正在等待或执行线上验收；APPROVE 只绑定 candidateSha，不能代替部署后验证。按线上验收继续，不要用 preview 给 PASS；需要逐项证据时用 worker_job_status 分页 recall。';
    case 'closed_loop':
      return '已闭环，无需后续动作；preview 只是索引，结论以正式审查与部署验证为准。需要逐项证据时用 worker_job_status 分页 recall。';
    default:
      return 'preview 只是索引，不能代替 diff/测试证据与正式结论，不要用 preview 给 PASS；需要逐项证据时用 worker_job_status 分页 recall，不要替 User 做需求取舍。';
  }
}

export function formatCoordinationReceipt(job: JobRow, marker: CoordinationMarker): string {
  return formatWorkerReceiptPreview(job, {
    heading: '工作对接回执，请按阶段处理。',
    prefixLines: [
      `任务文件：${marker.taskPath}`,
      `Plan hash：${marker.planHash}`,
    ],
    closing: coordinationReceiptClosing(job),
  });
}
