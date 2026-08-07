import type { Db, MessageOrigin } from './db.js';

export interface MessageReadState {
  origin: MessageOrigin;
  lastReadMessageId: number;
  firstUnreadId: number | null;
  unreadCount: number;
}

const ELIGIBLE_MESSAGE_SQL = `
  deleted = 0
  AND COALESCE(json_extract(meta, '$.uiHidden'), 0) != 1
  AND kind IN ('text', 'error')
  AND NOT (origin = 'main' AND sender = 'user' AND role = 'user')
`;

export function getMessageReadState(
  db: Db,
  contactId: string,
  origin: MessageOrigin
): MessageReadState {
  const cursor = db.prepare(
    `SELECT last_read_message_id AS lastReadMessageId
     FROM message_read_cursors WHERE contact_id = ? AND origin = ?`
  ).get(contactId, origin) as { lastReadMessageId: number } | undefined;
  const lastReadMessageId = cursor?.lastReadMessageId ?? 0;
  const row = db.prepare(
    `SELECT MIN(id) AS firstUnreadId, COUNT(*) AS unreadCount
     FROM messages
     WHERE contact_id = ? AND origin = ? AND id > ? AND ${ELIGIBLE_MESSAGE_SQL}`
  ).get(contactId, origin, lastReadMessageId) as {
    firstUnreadId: number | null;
    unreadCount: number;
  };
  return {
    origin,
    lastReadMessageId,
    firstUnreadId: row.firstUnreadId ?? null,
    unreadCount: Number(row.unreadCount),
  };
}

export function markMessagesRead(
  db: Db,
  contactId: string,
  origin: MessageOrigin,
  throughMessageId: number
): MessageReadState {
  const target = db.prepare(
    `SELECT id FROM messages
     WHERE id = ? AND contact_id = ? AND origin = ? AND deleted = 0
       AND COALESCE(json_extract(meta, '$.uiHidden'), 0) != 1`
  ).get(throughMessageId, contactId, origin) as { id: number } | undefined;
  if (!target) throw new Error('message not found in channel');

  db.prepare(
    `INSERT INTO message_read_cursors (contact_id, origin, last_read_message_id)
     VALUES (?, ?, ?)
     ON CONFLICT(contact_id, origin) DO UPDATE SET
       last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
       updated_at = CASE
         WHEN excluded.last_read_message_id > last_read_message_id THEN datetime('now')
         ELSE updated_at
       END`
  ).run(contactId, origin, throughMessageId);
  return getMessageReadState(db, contactId, origin);
}

export function readStatesForContact(db: Db, contactId: string) {
  return {
    main: getMessageReadState(db, contactId, 'main'),
    side: getMessageReadState(db, contactId, 'side'),
  };
}
