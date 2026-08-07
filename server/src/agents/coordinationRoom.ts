import crypto from 'node:crypto';
import type { ContactRow, Db, MessageRow } from '../db.js';
import type { HubLogger } from '../logger.js';
import type { SseHub } from '../sse.js';

export type CoordinationRoomMessageKind = 'receipt' | 'background-notification';

export interface CoordinationRoomDispatchInput {
  targetId: string;
  content: string;
  kind: CoordinationRoomMessageKind;
  idempotencyKey?: string;
  duplicateKey?: string;
  duplicateMinutes?: number;
  exactDispatchKey?: string;
  meta: Record<string, unknown>;
}

export interface CoordinationRoomDispatchResult {
  status: 'posted' | 'duplicate' | 'unavailable';
  roomId?: string;
  messageId?: number;
  reason?: string;
}

interface CoordinationRoomManager {
  imageRoomMembers(room: ContactRow): ContactRow[];
  dispatchRoomMessageTracked(
    room: ContactRow,
    content: string,
    options: { targetOverride: ContactRow[]; capture: false; reactionRounds: 0 }
  ): { completion: Promise<unknown> };
}

function configuredCoordinationRoom(db: Db, exactDispatchKey = ''): ContactRow | undefined {
  if (exactDispatchKey) {
    return db.prepare(
      `SELECT contacts.* FROM messages
       JOIN contacts ON contacts.id = messages.contact_id
       WHERE messages.sender = 'room-host'
         AND messages.idempotency_key = ?
         AND contacts.enabled = 1
         AND contacts.kind = 'room'
         AND COALESCE(json_extract(contacts.config, '$.coordination.enabled'), 1) != 0
       ORDER BY messages.id DESC LIMIT 1`
    ).get(exactDispatchKey) as ContactRow | undefined;
  }
  return db.prepare(
    `SELECT contacts.* FROM contacts
     WHERE contacts.enabled = 1
       AND contacts.kind = 'room'
       AND COALESCE(json_extract(contacts.config, '$.coordination.enabled'), 1) != 0
       AND (
         json_extract(contacts.config, '$.coordination.enabled') = 1
         OR EXISTS (
           SELECT 1 FROM messages
           WHERE messages.contact_id = contacts.id
             AND messages.sender = 'room-host'
             AND json_type(messages.meta, '$.roomHost.coordination') = 'object'
         )
       )
     ORDER BY
       CASE WHEN json_extract(contacts.config, '$.coordination.enabled') = 1 THEN 0 ELSE 1 END,
       (SELECT COALESCE(MAX(messages.id), 0) FROM messages WHERE messages.contact_id = contacts.id) DESC
     LIMIT 1`
  ).get() as ContactRow | undefined;
}

export function dispatchCoordinationRoomHost(
  deps: {
    db: Db;
    sse: SseHub;
    manager: CoordinationRoomManager;
    logger?: HubLogger;
  },
  input: CoordinationRoomDispatchInput,
): CoordinationRoomDispatchResult {
  const room = configuredCoordinationRoom(deps.db, input.exactDispatchKey);
  if (!room) return { status: 'unavailable', reason: 'coordination room is not configured or enabled' };
  const target = deps.manager.imageRoomMembers(room).find((member) => member.id === input.targetId);
  if (!target) {
    return { status: 'unavailable', roomId: room.id, reason: `${input.targetId} is not a room member` };
  }
  const duplicateMinutes = Math.max(0, Number(input.duplicateMinutes ?? 0));
  if (input.duplicateKey && duplicateMinutes > 0) {
    const duplicate = deps.db.prepare(
      `SELECT id FROM messages
       WHERE contact_id = ? AND sender = 'room-host'
         AND json_extract(meta, '$.roomHost.notification.key') = ?
         AND created_at >= datetime('now', ?)
       ORDER BY id DESC LIMIT 1`
    ).get(room.id, input.duplicateKey, `-${duplicateMinutes} minutes`);
    if (duplicate) return { status: 'duplicate', roomId: room.id };
  }
  if (input.idempotencyKey) {
    const duplicate = deps.db.prepare(
      `SELECT id FROM messages
       WHERE contact_id = ? AND sender = 'room-host' AND idempotency_key = ?
       ORDER BY id DESC LIMIT 1`
    ).get(room.id, input.idempotencyKey);
    if (duplicate) return { status: 'duplicate', roomId: room.id };
  }

  const meta = {
    roomHost: {
      name: 'DS 主持',
      roundId: `coordination-${crypto.randomUUID()}`,
      idempotencyKey: input.idempotencyKey || undefined,
      status: 'running',
      targets: [target.id],
      reactionRounds: 0,
      coordinationPool: { kind: input.kind },
      ...input.meta,
    },
  };
  const result = deps.db.prepare(
    `INSERT INTO messages
       (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
     VALUES (?, 'room-host', 'user', 'text', ?, 'done', ?, 'main', ?)`
  ).run(room.id, input.content, JSON.stringify(meta), input.idempotencyKey || null);
  const row = deps.db.prepare('SELECT * FROM messages WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as MessageRow;
  deps.sse.broadcast('message', row);
  const tracked = deps.manager.dispatchRoomMessageTracked(room, input.content, {
    targetOverride: [target],
    capture: false,
    reactionRounds: 0,
  });
  void tracked.completion.then((outcome) => {
    const doneMeta = {
      ...meta,
      roomHost: {
        ...meta.roomHost,
        status: 'done',
        completedAt: new Date().toISOString(),
        outcome,
      },
    };
    deps.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(doneMeta), row.id);
    const doneRow = deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id) as MessageRow;
    deps.sse.broadcast('message', doneRow);
  }).catch((error: Error) => {
    const failedMeta = {
      ...meta,
      roomHost: {
        ...meta.roomHost,
        status: 'error',
        completedAt: new Date().toISOString(),
        error: error.message.slice(0, 500),
      },
    };
    deps.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(failedMeta), row.id);
    const failedRow = deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id) as MessageRow;
    deps.sse.broadcast('message', failedRow);
  });
  return { status: 'posted', roomId: room.id, messageId: row.id };
}

export function coordinationRoomHealth(db: Db): Record<string, number> {
  const row = db.prepare(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN json_extract(meta, '$.roomHost.coordinationPool.kind') = 'receipt'
         THEN 1 ELSE 0 END), 0) AS receipt_count,
       COALESCE(SUM(CASE WHEN json_extract(meta, '$.roomHost.coordinationPool.kind') = 'background-notification'
         THEN 1 ELSE 0 END), 0) AS notification_count
     FROM messages
     WHERE sender = 'room-host'
       AND created_at >= datetime('now', '+8 hours', 'start of day', '-8 hours')
       AND json_type(meta, '$.roomHost.coordinationPool') = 'object'`
  ).get() as { total: number; receipt_count: number; notification_count: number };
  return {
    total: Number(row.total),
    receipts: Number(row.receipt_count),
    backgroundNotifications: Number(row.notification_count),
  };
}
