import crypto from 'node:crypto';
import type { ContactRow, Db, MessageRow } from '../db.js';
import type { HubLogger } from '../logger.js';
import { shanghaiStamp } from '../memory/inject.js';
import type { SseHub } from '../sse.js';

export type CoordinationRoomMessageKind = 'receipt';

export interface CoordinationRoomDispatchInput {
  targetId: string;
  content: string;
  kind: CoordinationRoomMessageKind;
  idempotencyKey?: string;
  exactDispatchKey?: string;
  meta: Record<string, unknown>;
}

export interface CoordinationRoomDispatchResult {
  status: 'posted' | 'duplicate' | 'unavailable';
  roomId?: string;
  messageId?: number;
  reason?: string;
}

export interface CoordinationRoomReceiptUpdateInput {
  idempotencyKey: string;
  status: string;
  deliveryState: string;
  summary: string;
}

export interface CoordinationRoomReceiptUpdateResult {
  status: 'updated' | 'missing';
  roomId?: string;
  messageId?: number;
}

const MAX_RECEIPT_STATE_UPDATES = 5;

interface CoordinationRoomManager {
  imageRoomMembers(room: ContactRow): ContactRow[];
  dispatchRoomMessageTracked(
    room: ContactRow,
    content: string,
    options: { targetOverride: ContactRow[]; capture: false; reactionRounds: 0 }
  ): { completion: Promise<unknown> };
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function messageMeta(raw: string | null | undefined): Record<string, any> {
  try { return record(raw ? JSON.parse(raw) : {}); } catch { return {}; }
}

export function updateCoordinationRoomReceipt(
  deps: { db: Db; sse: SseHub },
  input: CoordinationRoomReceiptUpdateInput,
): CoordinationRoomReceiptUpdateResult {
  const row = deps.db.prepare(
    `SELECT messages.* FROM messages
     JOIN contacts ON contacts.id = messages.contact_id
     WHERE messages.sender = 'room-host'
       AND messages.idempotency_key = ?
       AND contacts.kind = 'room'
     ORDER BY messages.id DESC LIMIT 1`
  ).get(input.idempotencyKey) as MessageRow | undefined;
  if (!row) return { status: 'missing' };

  const sqliteNow = (deps.db.prepare("SELECT datetime('now') AS value").get() as { value: string }).value;
  const at = `${sqliteNow.replace(' ', 'T')}Z`;
  const displayTime = shanghaiStamp(sqliteNow).match(/(\d{2}:\d{2}) CST$/)?.[1] ?? '00:00';
  const summary = input.summary.trim().replace(/\s+/g, ' ').slice(0, 500)
    || `${input.status} / ${input.deliveryState}`;
  const meta = messageMeta(row.meta);
  const roomHost = record(meta.roomHost);
  const receipt = record(roomHost.receipt);
  const priorUpdates = Array.isArray(receipt.stateUpdates) ? receipt.stateUpdates : [];
  const stateUpdate = {
    at,
    status: input.status,
    deliveryState: input.deliveryState,
    summary,
  };
  const nextMeta = {
    ...meta,
    roomHost: {
      ...roomHost,
      receipt: {
        ...receipt,
        status: input.status,
        deliveryState: input.deliveryState,
        stateUpdates: [...priorUpdates.slice(-(MAX_RECEIPT_STATE_UPDATES - 1)), stateUpdate],
      },
    },
  };
  const baseContent = row.content.replace(/(?:\r?\n状态更新 \d{2}:\d{2}：[^\r\n]*)+$/u, '');
  const content = `${baseContent}\n状态更新 ${displayTime}：${summary}`;
  deps.db.prepare('UPDATE messages SET content = ?, meta = ? WHERE id = ?')
    .run(content, JSON.stringify(nextMeta), row.id);
  const updated = deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id) as MessageRow;
  deps.sse.broadcast('message', updated);
  return { status: 'updated', roomId: row.contact_id, messageId: row.id };
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
    const current = deps.db.prepare('SELECT meta FROM messages WHERE id = ?').get(row.id) as { meta: string } | undefined;
    const currentMeta = messageMeta(current?.meta ?? row.meta);
    const currentRoomHost = record(currentMeta.roomHost);
    const doneMeta = {
      ...currentMeta,
      roomHost: {
        ...currentRoomHost,
        status: 'done',
        completedAt: new Date().toISOString(),
        outcome,
      },
    };
    deps.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(doneMeta), row.id);
    const doneRow = deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id) as MessageRow;
    deps.sse.broadcast('message', doneRow);
  }).catch((error: Error) => {
    const current = deps.db.prepare('SELECT meta FROM messages WHERE id = ?').get(row.id) as { meta: string } | undefined;
    const currentMeta = messageMeta(current?.meta ?? row.meta);
    const currentRoomHost = record(currentMeta.roomHost);
    const failedMeta = {
      ...currentMeta,
      roomHost: {
        ...currentRoomHost,
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
         THEN 1 ELSE 0 END), 0) AS receipt_count
     FROM messages
     WHERE sender = 'room-host'
       AND created_at >= datetime('now', '+8 hours', 'start of day', '-8 hours')
       AND json_type(meta, '$.roomHost.coordinationPool') = 'object'`
  ).get() as { total: number; receipt_count: number };
  return {
    total: Number(row.total),
    receipts: Number(row.receipt_count),
  };
}
