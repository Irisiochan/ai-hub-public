import type { Db } from '../db.js';

export class SessionRepo {
  // Statements have heterogeneous bind tuples; better-sqlite3 validates them at prepare/run time.
  private readonly statements: Record<string, any>;

  constructor(private readonly db: Db) {
    this.statements = {
      active: db.prepare(
        'SELECT session_id FROM sessions WHERE contact_id = ? AND member_id = ? AND active = 1'
      ),
      touch: db.prepare(
        "UPDATE sessions SET updated_at = datetime('now') WHERE contact_id = ? AND member_id = ? AND active = 1"
      ),
      deactivateOne: db.prepare(
        'UPDATE sessions SET active = 0 WHERE contact_id = ? AND member_id = ? AND active = 1'
      ),
      deactivateConversation: db.prepare(
        'UPDATE sessions SET active = 0 WHERE contact_id = ? AND active = 1'
      ),
      deactivateMember: db.prepare(
        'UPDATE sessions SET active = 0 WHERE member_id = ? AND active = 1'
      ),
      insert: db.prepare(
        'INSERT INTO sessions (contact_id, member_id, session_id, active) VALUES (?, ?, ?, 1)'
      ),
      lastSeen: db.prepare(
        'SELECT last_seen_id FROM room_member_state WHERE contact_id = ? AND member_id = ?'
      ),
      setLastSeen: db.prepare(
        `INSERT INTO room_member_state (contact_id, member_id, last_seen_id) VALUES (?, ?, ?)
         ON CONFLICT(contact_id, member_id) DO UPDATE SET last_seen_id = excluded.last_seen_id`
      ),
    };
  }

  active(contactId: string, memberId = ''): string | null {
    const row = this.statements.active.get(contactId, memberId) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  save(contactId: string, sessionId: string, memberId = ''): void {
    const existing = this.active(contactId, memberId);
    if (existing === sessionId) {
      this.statements.touch.run(contactId, memberId);
      return;
    }
    const replace = this.db.transaction(() => {
      this.statements.deactivateOne.run(contactId, memberId);
      this.statements.insert.run(contactId, memberId, sessionId);
    });
    replace();
  }

  deactivate(contactId: string, memberId?: string): void {
    if (memberId === undefined) this.statements.deactivateConversation.run(contactId);
    else this.statements.deactivateOne.run(contactId, memberId);
  }

  deactivateMemberEverywhere(memberId: string): void {
    this.statements.deactivateMember.run(memberId);
  }

  lastSeen(contactId: string, memberId: string): number {
    const row = this.statements.lastSeen.get(contactId, memberId) as { last_seen_id: number } | undefined;
    return row?.last_seen_id ?? 0;
  }

  setLastSeen(contactId: string, memberId: string, messageId: number): void {
    this.statements.setLastSeen.run(contactId, memberId, messageId);
  }
}
