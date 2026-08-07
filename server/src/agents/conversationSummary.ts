import type { Db, MessageRow } from '../db.js';
import { timestampedMessage } from '../memory/inject.js';
import { estimateTokens } from './tokenEstimate.js';
import { ConversationSummaryRepo } from './conversationSummaryRepo.js';
import { historicalMessageText } from './sideChannel.js';

export type SummaryMutationResult =
  | { action: 'none' }
  | { action: 'kept'; through: number }
  | { action: 'cleared' }
  | { action: 'rebuilt'; through: number; rows: number; tokens: number };

export interface SummaryBudgetOpts {
  summaryMaxTokens: number;
  historyTokenBudget: number;
  /** 群聊时把 sender 映射成显示名；DM 可省略 */
  nameOf?: (sender: string) => string;
}

export const SUMMARY_FORMAT_MARKER = '[摘要格式 time-anchor-v1]';

export function summaryNeedsTimeAnchorUpgrade(summary: string | null | undefined): boolean {
  return !!summary?.trim() && !summary.trimStart().startsWith(SUMMARY_FORMAT_MARKER);
}

function summaryLine(row: MessageRow, nameOf?: (sender: string) => string): string {
  const text = historicalMessageText(row);
  const who = nameOf
    ? nameOf(row.sender)
    : text.startsWith('[后台') || text.startsWith('[主动消息触发]')
      ? '网关'
      : row.role === 'assistant'
        ? '助手'
        : 'User';
  const compact = text.replace(/\s+/g, ' ').trim().slice(0, 240);
  // 摘要行同样是历史，不带时间锚点会被读成"刚刚"
  return `- ${timestampedMessage(`${who}：${compact}`, row.created_at, '历史摘要')}`;
}

/** 本地 extractive 摘要：拼接后按 token 预算保留尾部。 */
export function compactSummaryText(
  existing: string,
  rows: MessageRow[],
  opts: SummaryBudgetOpts
): string {
  const lines = rows.map((r) => summaryLine(r, opts.nameOf));
  const existingBody = existing.trim().startsWith(SUMMARY_FORMAT_MARKER)
    ? existing.trim().slice(SUMMARY_FORMAT_MARKER.length).trimStart()
    : existing.trim();
  const body = [existingBody, ...lines].filter(Boolean).join('\n');
  const appended = [SUMMARY_FORMAT_MARKER, body].filter(Boolean).join('\n');
  const maxTokens = Math.max(
    Math.min(opts.summaryMaxTokens, opts.historyTokenBudget - 512),
    256
  );
  if (estimateTokens(appended) <= maxTokens) return appended;
  const prefix = `${SUMMARY_FORMAT_MARKER}\n[更早的摘要已按预算淘汰]\n`;
  let low = 0;
  let high = body.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateTokens(prefix + body.slice(mid)) <= maxTokens) high = mid;
    else low = mid + 1;
  }
  return prefix + body.slice(low);
}

function listMemberIds(repo: ConversationSummaryRepo, contactId: string, memberId?: string): string[] {
  if (memberId !== undefined) return [memberId];
  const rows = repo.memberIds(contactId);
  // 无摘要行时也覆盖 DM 默认 ''，避免漏清
  if (rows.length === 0) return [''];
  return rows;
}

/**
 * 编辑/删除后的摘要处理：
 * - 变更落在「未摘要的近期原文区」(id > through) → 保留摘要，不重建
 * - 变更落在摘要覆盖区 → 仅用仍存活的、id ≤ 原 through 的消息重做 extractive 摘要
 *   （不回放 through 之后的近期原文，也不是整表 DELETE 后再全量爬）
 * - affectedFromId <= 0 → 兼容旧行为：整份删除
 */
export function touchConversationSummary(
  db: Db,
  contactId: string,
  memberId: string | undefined,
  affectedFromId: number,
  opts: SummaryBudgetOpts
): SummaryMutationResult {
  const repo = new ConversationSummaryRepo(db);
  if (!Number.isFinite(affectedFromId) || affectedFromId <= 0) {
    repo.delete(contactId, memberId);
    return { action: 'cleared' };
  }

  const members = listMemberIds(repo, contactId, memberId);
  let worst: SummaryMutationResult = { action: 'none' };

  for (const mid of members) {
    const result = touchOneMember(repo, contactId, mid, affectedFromId, opts);
    if (result.action === 'rebuilt' || result.action === 'cleared') worst = result;
    else if (worst.action === 'none') worst = result;
  }
  return worst;
}

function touchOneMember(
  repo: ConversationSummaryRepo,
  contactId: string,
  memberId: string,
  affectedFromId: number,
  opts: SummaryBudgetOpts
): SummaryMutationResult {
  const saved = repo.get(contactId, memberId);

  if (!saved || !saved.summary) return { action: 'none' };

  if (affectedFromId > saved.through_message_id) {
    return { action: 'kept', through: saved.through_message_id };
  }

  // 只重读「原摘要覆盖窗」内仍存活的消息，不回放更新近原文
  const rows = repo.rowsThrough(contactId, saved.through_message_id);

  if (rows.length === 0) {
    repo.delete(contactId, memberId);
    return { action: 'cleared' };
  }

  const summary = compactSummaryText('', rows, opts);
  const through = rows[rows.length - 1].id;
  repo.update(contactId, memberId, summary, through);

  return {
    action: 'rebuilt',
    through,
    rows: rows.length,
    tokens: estimateTokens(summary),
  };
}

/** 请求侧工具 schema 的粗估 token，便于 CLI/API 对照日志。 */
export function estimateToolSchemaTokens(
  defs: { name: string; description: string; schema: Record<string, unknown> }[]
): number {
  return estimateTokens(JSON.stringify(defs));
}
