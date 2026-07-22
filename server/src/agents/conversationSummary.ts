import type { ConversationSummaryRow, Db, MessageRow } from '../db.js';
import { estimateTokens } from './tokenEstimate.js';

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

function summaryLine(row: MessageRow, nameOf?: (sender: string) => string): string {
  const who = nameOf
    ? nameOf(row.sender)
    : row.role === 'assistant'
      ? '助手'
      : 'Iris';
  const compact = row.content.replace(/\s+/g, ' ').trim().slice(0, 240);
  return `- ${who}：${compact}`;
}

/** 本地 extractive 摘要：拼接后按 token 预算保留尾部。 */
export function compactSummaryText(
  existing: string,
  rows: MessageRow[],
  opts: SummaryBudgetOpts
): string {
  const lines = rows.map((r) => summaryLine(r, opts.nameOf));
  const appended = [existing.trim(), ...lines].filter(Boolean).join('\n');
  const maxTokens = Math.max(
    Math.min(opts.summaryMaxTokens, opts.historyTokenBudget - 512),
    256
  );
  if (estimateTokens(appended) <= maxTokens) return appended;
  const prefix = '[更早的摘要已按预算淘汰]\n';
  let low = 0;
  let high = appended.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateTokens(prefix + appended.slice(mid)) <= maxTokens) high = mid;
    else low = mid + 1;
  }
  return prefix + appended.slice(low);
}

function listMemberIds(db: Db, contactId: string, memberId?: string): string[] {
  if (memberId !== undefined) return [memberId];
  const rows = db
    .prepare('SELECT member_id FROM conversation_summaries WHERE contact_id = ?')
    .all(contactId) as { member_id: string }[];
  // 无摘要行时也覆盖 DM 默认 ''，避免漏清
  if (rows.length === 0) return [''];
  return rows.map((r) => r.member_id);
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
  if (!Number.isFinite(affectedFromId) || affectedFromId <= 0) {
    if (memberId === undefined) {
      db.prepare('DELETE FROM conversation_summaries WHERE contact_id = ?').run(contactId);
    } else {
      db.prepare('DELETE FROM conversation_summaries WHERE contact_id = ? AND member_id = ?').run(
        contactId,
        memberId
      );
    }
    return { action: 'cleared' };
  }

  const members = listMemberIds(db, contactId, memberId);
  let worst: SummaryMutationResult = { action: 'none' };

  for (const mid of members) {
    const result = touchOneMember(db, contactId, mid, affectedFromId, opts);
    if (result.action === 'rebuilt' || result.action === 'cleared') worst = result;
    else if (worst.action === 'none') worst = result;
  }
  return worst;
}

function touchOneMember(
  db: Db,
  contactId: string,
  memberId: string,
  affectedFromId: number,
  opts: SummaryBudgetOpts
): SummaryMutationResult {
  const saved = db
    .prepare('SELECT * FROM conversation_summaries WHERE contact_id = ? AND member_id = ?')
    .get(contactId, memberId) as ConversationSummaryRow | undefined;

  if (!saved || !saved.summary) return { action: 'none' };

  if (affectedFromId > saved.through_message_id) {
    return { action: 'kept', through: saved.through_message_id };
  }

  // 只重读「原摘要覆盖窗」内仍存活的消息，不回放更新近原文
  const rows = db
    .prepare(
      `SELECT * FROM messages
       WHERE contact_id = ? AND kind = 'text' AND status = 'done' AND deleted = 0
         AND role IN ('user','assistant')
         AND id <= ?
       ORDER BY id ASC`
    )
    .all(contactId, saved.through_message_id) as MessageRow[];

  if (rows.length === 0) {
    db.prepare('DELETE FROM conversation_summaries WHERE contact_id = ? AND member_id = ?').run(
      contactId,
      memberId
    );
    return { action: 'cleared' };
  }

  const summary = compactSummaryText('', rows, opts);
  const through = rows[rows.length - 1].id;
  db.prepare(
    `UPDATE conversation_summaries
     SET summary = ?, through_message_id = ?, version = version + 1, updated_at = datetime('now')
     WHERE contact_id = ? AND member_id = ?`
  ).run(summary, through, contactId, memberId);

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
