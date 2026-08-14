import type { ConversationSummaryRow, Db, MessageRow } from '../db.js';

/**
 * 摘要存储键：DM 与群聊统一用空串。
 * 群聊方案 A（共享群摘要）——不再按 member_id 各滚各的，省 N−1 份计算与 N 份 version 漂移。
 * 视角差异只体现在原文区 role/包装；摘要正文是第三人称 nameOf 叙述，可共享。
 */
export const SHARED_SUMMARY_MEMBER_ID = '';

/** Prepared persistence boundary for rolling conversation summaries. */
export class ConversationSummaryRepo {
  private readonly statements: Record<string, any>;

  constructor(db: Db) {
    this.statements = {
      get: db.prepare('SELECT * FROM conversation_summaries WHERE contact_id = ? AND member_id = ?'),
      memberIds: db.prepare('SELECT member_id FROM conversation_summaries WHERE contact_id = ?'),
      deleteContact: db.prepare('DELETE FROM conversation_summaries WHERE contact_id = ?'),
      deleteMember: db.prepare('DELETE FROM conversation_summaries WHERE contact_id = ? AND member_id = ?'),
      rowsThrough: db.prepare(
        `SELECT * FROM messages
         WHERE contact_id = ? AND kind = 'text' AND status = 'done' AND deleted = 0
           AND role IN ('user','assistant') AND id <= ?
         ORDER BY id ASC`
      ),
      update: db.prepare(
        `UPDATE conversation_summaries
         SET summary = ?, through_message_id = ?, version = version + 1, updated_at = datetime('now')
         WHERE contact_id = ? AND member_id = ?`
      ),
      upsert: db.prepare(
        `INSERT INTO conversation_summaries
           (contact_id, member_id, summary, through_message_id, version, updated_at)
         VALUES (?, ?, ?, ?, 1, datetime('now'))
         ON CONFLICT(contact_id, member_id) DO UPDATE SET
           summary = excluded.summary,
           through_message_id = excluded.through_message_id,
           version = conversation_summaries.version + 1,
           updated_at = datetime('now')`
      ),
    };
  }

  get(contactId: string, memberId: string): ConversationSummaryRow | undefined {
    return this.statements.get.get(contactId, memberId) as ConversationSummaryRow | undefined;
  }

  /**
   * 读取滚动摘要：优先共享行（member_id=''）。
   * 群聊遗留的 per-member 行仅作只读回落，下一次真实 upsert 会写到共享行。
   */
  getSharedOrLegacy(
    contactId: string,
    legacyMemberId?: string
  ): ConversationSummaryRow | undefined {
    const shared = this.get(contactId, SHARED_SUMMARY_MEMBER_ID);
    if (shared) return shared;
    if (legacyMemberId) return this.get(contactId, legacyMemberId);
    return undefined;
  }

  memberIds(contactId: string): string[] {
    return (this.statements.memberIds.all(contactId) as Array<{ member_id: string }>)
      .map((row) => row.member_id);
  }

  delete(contactId: string, memberId?: string): void {
    if (memberId === undefined) this.statements.deleteContact.run(contactId);
    else this.statements.deleteMember.run(contactId, memberId);
  }

  rowsThrough(contactId: string, throughMessageId: number): MessageRow[] {
    return this.statements.rowsThrough.all(contactId, throughMessageId) as MessageRow[];
  }

  /**
   * 仅在 summary/through 实际变化时 bump version。
   * 相同内容的 upsert 若仍 +version，会把 historyCache 判 miss，并让观测侧误以为
   * 前缀在抖动——prompt cache 看的是字节，但我们不应制造无意义的 version 漂移。
   *
   * 共享群摘要额外合约：through_message_id 只前进不回退，避免 N 成员并行/交错
   * 时用更浅的窗口覆盖已推进的共享摘要。
   */
  update(contactId: string, memberId: string, summary: string, throughMessageId: number): boolean {
    const current = this.get(contactId, memberId);
    if (
      current
      && current.summary === summary
      && current.through_message_id === throughMessageId
    ) {
      return false;
    }
    if (current && current.through_message_id > throughMessageId) {
      return false;
    }
    this.statements.update.run(summary, throughMessageId, contactId, memberId);
    return true;
  }

  upsert(contactId: string, memberId: string, summary: string, throughMessageId: number): boolean {
    const current = this.get(contactId, memberId);
    if (
      current
      && current.summary === summary
      && current.through_message_id === throughMessageId
    ) {
      return false;
    }
    // 不回退 through：共享行被多成员写入时，较浅窗口不得覆盖较深窗口。
    if (current && current.through_message_id > throughMessageId) {
      return false;
    }
    this.statements.upsert.run(contactId, memberId, summary, throughMessageId);
    return true;
  }
}
