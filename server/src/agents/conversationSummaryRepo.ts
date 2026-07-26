import type { ConversationSummaryRow, Db, MessageRow } from '../db.js';

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

  update(contactId: string, memberId: string, summary: string, throughMessageId: number): void {
    this.statements.update.run(summary, throughMessageId, contactId, memberId);
  }

  upsert(contactId: string, memberId: string, summary: string, throughMessageId: number): void {
    this.statements.upsert.run(contactId, memberId, summary, throughMessageId);
  }
}
