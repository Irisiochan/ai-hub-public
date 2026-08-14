import type { MessageRow } from '../db.js';
import { normalizeAutomationDescriptor, parseMessageMeta } from './messageSource.js';

type HistoricalMessageRow = Pick<MessageRow, 'sender' | 'role' | 'content' | 'origin' | 'meta'>;

function compact(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

function field(content: string, label: string): string {
  const line = content
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith(`${label}：`));
  return line?.trim().slice(label.length + 1).trim() ?? '';
}

function metaEvent(row: HistoricalMessageRow): string {
  try {
    const event = JSON.parse(row.meta || '{}')?.event;
    return typeof event === 'string' ? event : '';
  } catch {
    return '';
  }
}

function receiptHistoryHandle(row: HistoricalMessageRow): string | null {
  let meta: Record<string, any> = {};
  try {
    const parsed = JSON.parse(row.meta || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
  } catch {}
  const roomReceipt = meta.roomHost?.receipt && typeof meta.roomHost.receipt === 'object'
    ? meta.roomHost.receipt as Record<string, any>
    : null;
  const previewJob = row.content.match(/^Worker job：\s*([^\s]+)/m);
  const legacy = row.content.match(/任务\s+([^\s：:]+)\s*[：:]\s*([^\r\n]+)/);
  const contentReceipt = /^⚙\s*Worker 任务回执/m.test(row.content)
    || /工作对接回执（preview）/.test(row.content);
  if (!roomReceipt && meta.event !== 'worker-receipt' && !(contentReceipt && (previewJob || legacy))) return null;

  const updates = Array.isArray(roomReceipt?.stateUpdates) ? roomReceipt.stateUpdates : [];
  const latest = updates.length && typeof updates[updates.length - 1] === 'object'
    ? updates[updates.length - 1] as Record<string, unknown>
    : {};
  const jobId = String(roomReceipt?.jobId ?? meta.jobId ?? previewJob?.[1] ?? legacy?.[1] ?? '').trim();
  const statusLine = row.content.match(/^(?:终态|状态)：\s*([^\r\n]+)/m)?.[1]?.trim() ?? '';
  const status = [
    latest.status ?? roomReceipt?.status ?? meta.status,
    latest.deliveryState ?? roomReceipt?.deliveryState ?? meta.deliveryState,
  ].filter((value) => typeof value === 'string' && value.trim()).join(' / ')
    || statusLine
    || legacy?.[2]?.trim()
    || '状态未知';
  return `[后台事件] Worker 回执${jobId ? ` · ${jobId}` : ''} · ${compact(status, 160)}`;
}

/** Fold an already-finished automation row when it becomes conversation history. */
export function historicalMessageText(row: HistoricalMessageRow): string {
  if (row.origin === 'side' && row.role === 'assistant') {
    return `[后台回复] ${compact(row.content, 200)}`;
  }

  const receipt = receiptHistoryHandle(row);
  if (receipt) return receipt;

  const automation = normalizeAutomationDescriptor(parseMessageMeta(row.meta));
  if (automation?.messageType === 'background-event') {
    return `[后台事件] 自主事件分派 · 来源 ${automation.eventSource}${
      automation.eventCategory ? ` · ${automation.eventCategory}` : ''
    }${automation.eventPriority ? ` P${automation.eventPriority}` : ''}`;
  }
  if (
    automation?.messageType === 'proactive-trigger'
    || automation?.messageType === 'automation-trigger'
  ) {
    return `[主动消息触发] 来源 ${automation.eventSource}${
      automation.eventCategory ? ` · ${automation.eventCategory}` : ''
    }`;
  }

  const event = metaEvent(row);
  if (event === 'model-switch') return `[后台事件] ${compact(row.content, 160)}`;
  if (event === 'effort-switch') return `[后台事件] ${compact(row.content, 160)}`;
  if (row.content.startsWith('⚡ AI Hub 自主事件分派')) {
    const source = field(row.content, '来源');
    const category = field(row.content, '分类');
    return `[后台事件] 自主事件分派${source ? ` · 来源 ${source}` : ''}${
      category ? ` · ${category}` : ''
    }`;
  }
  if (row.origin === 'main' && row.sender === 'user') return row.content;
  if (row.origin === 'main' && row.sender !== 'user' && row.role === 'user') {
    const rationale = field(row.content, '分诊理由');
    return `[主动消息触发]${rationale ? ` ${compact(rationale, 180)}` : ''}`;
  }
  if (row.origin === 'side') return `[后台事件] ${compact(row.content, 200)}`;
  return row.content;
}
