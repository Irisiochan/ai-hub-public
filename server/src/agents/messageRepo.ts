import type { Db, MessageOrigin, MessageRow } from '../db.js';

export interface MessageFields {
  role: string;
  kind: string;
  content: string;
  status: string;
  turnId: string | null;
  origin?: MessageOrigin;
  meta?: unknown;
}

export interface RoomDeliveryRow {
  id: number;
  sender: string;
  content: string;
  meta: string;
  /** sqlite UTC 文本；渲染前必须过 shanghaiStamp 转成 +8 */
  created_at: string;
}

export interface RecentTextRow {
  role: MessageRow['role'];
  sender: string;
  content: string;
  origin: MessageOrigin;
  meta: string;
  /** sqlite UTC 文本；渲染前必须过 shanghaiStamp 转成 +8 */
  created_at: string;
}

export class MessageRepo {
  // Statements have heterogeneous bind tuples; better-sqlite3 validates them at prepare/run time.
  private readonly statements: Record<string, any>;

  constructor(private readonly db: Db) {
    this.statements = {
      contactName: db.prepare('SELECT name FROM contacts WHERE id = ?'),
      insert: db.prepare(
        `INSERT INTO messages (contact_id, sender, role, kind, content, status, turn_id, meta, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      byId: db.prepare('SELECT * FROM messages WHERE id = ?'),
      queueSource: db.prepare('SELECT origin, sender, meta FROM messages WHERE id = ?'),
      updateWithMeta: db.prepare('UPDATE messages SET content = ?, status = ?, meta = ? WHERE id = ?'),
      update: db.prepare('UPDATE messages SET content = ?, status = ? WHERE id = ?'),
      softDeleteAfter: db.prepare('UPDATE messages SET deleted = 1 WHERE contact_id = ? AND id > ?'),
      recentText: db.prepare(
        `SELECT role, sender, content, origin, meta, created_at FROM messages
         WHERE contact_id = ? AND kind = 'text' AND status = 'done' AND deleted = 0
         ORDER BY id DESC LIMIT ?`
      ),
      maxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE contact_id = ?'),
      unreadRoomText: db.prepare(
        `SELECT id, sender, content, meta, created_at FROM messages
         WHERE contact_id = ? AND id > ? AND deleted = 0 AND kind = 'text' AND status = 'done'
           AND sender != ?
         ORDER BY id ASC LIMIT ?`
      ),
      historyAfter: db.prepare(
        `SELECT * FROM messages
         WHERE contact_id = ? AND kind = 'text' AND status = 'done' AND deleted = 0
           AND role IN ('user','assistant') AND id > ?
         ORDER BY id ASC`
      ),
    };
  }

  contactName(id: string): string | undefined {
    return (this.statements.contactName.get(id) as { name: string } | undefined)?.name;
  }

  insert(contactId: string, sender: string, fields: MessageFields): MessageRow {
    const result = this.statements.insert.run(
      contactId,
      sender,
      fields.role,
      fields.kind,
      fields.content,
      fields.status,
      fields.turnId,
      JSON.stringify(fields.meta ?? {}),
      fields.origin ?? 'main'
    );
    return this.byId(Number(result.lastInsertRowid));
  }

  update(id: number, content: string, status: string, meta?: unknown): MessageRow {
    if (meta !== undefined) {
      this.statements.updateWithMeta.run(content, status, JSON.stringify(meta), id);
    } else {
      this.statements.update.run(content, status, id);
    }
    return this.byId(id);
  }

  softDeleteAfter(contactId: string, messageId: number): void {
    this.statements.softDeleteAfter.run(contactId, messageId);
  }

  recentText(contactId: string, limit = 30): RecentTextRow[] {
    return this.statements.recentText.all(contactId, limit) as RecentTextRow[];
  }

  maxId(contactId: string): number {
    return (this.statements.maxId.get(contactId) as { m: number }).m;
  }

  unreadRoomText(contactId: string, afterId: number, excludedSender: string, limit: number): RoomDeliveryRow[] {
    return this.statements.unreadRoomText.all(contactId, afterId, excludedSender, limit) as RoomDeliveryRow[];
  }

  historyAfter(contactId: string, afterId: number): MessageRow[] {
    return this.statements.historyAfter.all(contactId, afterId) as MessageRow[];
  }

  queueSource(id: number): { origin: MessageOrigin; sender: string; meta: string } | undefined {
    return this.statements.queueSource.get(id) as
      | { origin: MessageOrigin; sender: string; meta: string }
      | undefined;
  }

  private byId(id: number): MessageRow {
    return this.statements.byId.get(id) as MessageRow;
  }
}
