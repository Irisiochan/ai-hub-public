import { Router, type RequestHandler } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import type { AgentManager } from '../agents/manager.js';
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  deleteMessageFiles,
  persistImage,
  withAttachments,
  withAttachmentsMany,
} from '../attachments.js';
import type { ContactRow, Db, MessageOrigin, MessageRow } from '../db.js';
import type { SseHub } from '../sse.js';
import { UsageRepo } from '../agents/usageRepo.js';
import {
  automationMeta,
  legacyAutomationDescriptor,
  normalizeAutomationDescriptor,
  type AutomationDescriptor,
} from '../agents/messageSource.js';
import { getMessageReadState, markMessagesRead } from '../readState.js';
import { normalizeRoomCoordinationDispatch } from '../agents/roomPrompt.js';

export function messagesRouter(db: Db, sse: SseHub, manager: AgentManager, uploadsDir: string): Router {
  const r = Router();
  const usageRepo = new UsageRepo(db);
  // Room execution is in-memory, but its observable status is durable. Any
  // round still marked running when the gateway constructs a fresh router was
  // interrupted by the previous process and must fail closed instead of
  // leaving the worker polling forever.
  db.prepare(
    `UPDATE messages
     SET meta = json_set(
       COALESCE(meta, '{}'),
       '$.roomHost.status', 'error',
       '$.roomHost.error', 'gateway restarted before room round completion'
     )
     WHERE sender = 'room-host'
       AND json_extract(meta, '$.roomHost.status') = 'running'`
  ).run();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_MESSAGE },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) cb(null, true);
      else cb(new Error('只支持 JPEG、PNG、WebP、GIF 图片'));
    },
  });
  const receiveImages: RequestHandler = (req, res, next) => {
    upload.array('images', MAX_IMAGES_PER_MESSAGE)(req, res, (error) => {
      if (!error) return next();
      const message = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
        ? '单张图片不能超过 10 MB'
        : error instanceof multer.MulterError && error.code === 'LIMIT_FILE_COUNT'
          ? `每条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片`
          : error.message;
      res.status(400).json({ error: message });
    });
  };

  const getContact = (id: string): ContactRow | undefined =>
    db.prepare('SELECT * FROM contacts WHERE id = ? AND enabled = 1').get(id) as
      | ContactRow
      | undefined;

  const findIdempotentMessage = (
    contactId: string,
    idempotencyKey: string
  ): MessageRow | undefined =>
    db.prepare(
      `SELECT * FROM messages
       WHERE contact_id = ? AND idempotency_key = ?
       ORDER BY id DESC LIMIT 1`
    ).get(contactId, idempotencyKey) as MessageRow | undefined;

  const duplicateMessageResponse = (row: MessageRow) => ({
    messageId: row.id,
    persisted: true,
    queued: null,
    duplicate: true,
  });

  const parseMeta = (row: MessageRow): Record<string, any> => {
    try {
      return JSON.parse(row.meta || '{}') as Record<string, any>;
    } catch {
      return {};
    }
  };

  const roomHostResponse = (row: MessageRow) => {
    const roomHost = parseMeta(row).roomHost ?? {};
    return {
      messageId: row.id,
      roundId: roomHost.roundId ?? null,
      status: roomHost.status ?? 'done',
      targets: roomHost.targets ?? [],
      lastMessageId: roomHost.lastMessageId ?? row.id,
      outcome: roomHost.outcome ?? null,
      error: roomHost.error ?? null,
    };
  };

  r.get('/:id/messages', (req, res) => {
    const contact = getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const before = req.query.before ? Number(req.query.before) : null;
    const after = req.query.after ? Number(req.query.after) : null;
    const origin = typeof req.query.origin === 'string' ? req.query.origin : 'main';
    // Initial unread hydration may request more than one normal 50-row page.
    const limit = Math.min(Number(req.query.limit) || 50, after !== null ? 1000 : 200);
    if (!['main', 'side', 'all'].includes(origin)) {
      return res.status(400).json({ error: 'origin must be main, side, or all' });
    }
    const originClause = origin === 'all' ? '' : ' AND origin = ?';
    const originArgs = origin === 'all' ? [] : [origin];
    const visibleClause = " AND COALESCE(json_extract(meta, '$.uiHidden'), 0) != 1";

    let rows: MessageRow[];
    if (after !== null) {
      rows = db
        .prepare(
          `SELECT * FROM messages WHERE contact_id = ? AND deleted = 0${originClause}${visibleClause}
           AND id > ? ORDER BY id ASC LIMIT ?`
        )
        .all(contact.id, ...originArgs, after, limit) as MessageRow[];
    } else if (before !== null) {
      rows = (
        db
          .prepare(
            `SELECT * FROM messages WHERE contact_id = ? AND deleted = 0${originClause}${visibleClause}
             AND id < ? ORDER BY id DESC LIMIT ?`
          )
          .all(contact.id, ...originArgs, before, limit) as MessageRow[]
      ).reverse();
    } else {
      rows = (
        db
          .prepare(
            `SELECT * FROM messages WHERE contact_id = ? AND deleted = 0${originClause}${visibleClause}
             ORDER BY id DESC LIMIT ?`
          )
          .all(contact.id, ...originArgs, limit) as MessageRow[]
      ).reverse();
    }
    res.json({
      messages: withAttachmentsMany(db, rows),
      readState: origin === 'all'
        ? null
        : getMessageReadState(db, contact.id, origin as MessageOrigin),
    });
  });


  r.patch('/:id/messages/read', (req, res) => {
    const contact = getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    const origin = req.body?.origin;
    const throughMessageId = Number(req.body?.throughMessageId);
    if (origin !== 'main' && origin !== 'side') {
      return res.status(400).json({ error: 'origin must be main or side' });
    }
    if (!Number.isSafeInteger(throughMessageId) || throughMessageId <= 0) {
      return res.status(400).json({ error: 'throughMessageId must be a positive integer' });
    }
    try {
      const readState = markMessagesRead(db, contact.id, origin, throughMessageId);
      sse.broadcast('read-state', { contactId: contact.id, ...readState });
      res.json({ readState });
    } catch (error) {
      res.status(404).json({ error: (error as Error).message });
    }
  });
  r.get('/:id/room-rounds/:roundId', (req, res) => {
    const contact = getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    if (contact.kind !== 'room') return res.status(400).json({ error: 'contact is not a room' });
    const row = db.prepare(
      `SELECT * FROM messages
       WHERE contact_id = ? AND sender = 'room-host'
         AND json_extract(meta, '$.roomHost.roundId') = ?
       ORDER BY id DESC LIMIT 1`
    ).get(contact.id, req.params.roundId) as MessageRow | undefined;
    if (!row) return res.status(404).json({ error: 'room round not found' });
    res.json(roomHostResponse(row));
  });

  /** 非 User 发起的群主持消息。该入口永不触发 memory capture。 */
  r.post('/:id/room-host/messages', (req, res) => {
    const contact = getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    if (contact.kind !== 'room') return res.status(400).json({ error: 'contact is not a room' });

    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) return res.status(400).json({ error: 'content is required' });
    const hostName = typeof req.body?.hostName === 'string' && req.body.hostName.trim()
      ? req.body.hostName.trim().slice(0, 80)
      : 'DS 主持';
    const trigger = req.body?.trigger !== false;
    const idempotencyKey = typeof req.body?.idempotencyKey === 'string'
      ? req.body.idempotencyKey.trim().slice(0, 200)
      : '';
    const coordinationSupplied = req.body?.coordination !== undefined;
    const coordination = normalizeRoomCoordinationDispatch(req.body?.coordination);
    if (coordinationSupplied && !coordination) {
      return res.status(400).json({ error: 'coordination metadata is invalid' });
    }

    const members = manager.imageRoomMembers(contact);
    const requested: string[] = Array.isArray(req.body?.targetIds)
      ? [...new Set<string>(
        req.body.targetIds
          .map((value: unknown) => String(value).trim())
          .filter((value: string) => Boolean(value))
      )]
      : [];
    const targetOverride = requested.some((value: string) => value.toLowerCase() === 'all')
      ? members
      : requested.length > 0
        ? members.filter((member) => requested.includes(member.id))
        : manager.parseTargets(contact, content);
    if (trigger && targetOverride.length === 0) {
      return res.status(400).json({ error: 'room host message must target at least one room member' });
    }
    if (coordination) {
      const expectedTarget = coordination.kind === 'verification'
        ? coordination.verifier
        : coordination.executor;
      const expectedKey = coordination.kind === 'verification'
        ? `verification:v1:${coordination.taskPath}:${coordination.due}`
        : `coordination:${coordination.taskPath}:${coordination.planHash}`;
      if (!trigger
          || targetOverride.length !== 1
          || targetOverride[0].id !== expectedTarget
          || idempotencyKey !== expectedKey) {
        return res.status(400).json({ error: 'coordination routing contract mismatch' });
      }
    }

    if (idempotencyKey) {
      const existing = db.prepare(
        `SELECT * FROM messages
         WHERE contact_id = ? AND sender = 'room-host'
           AND json_extract(meta, '$.roomHost.idempotencyKey') = ?
         ORDER BY id DESC LIMIT 1`
      ).get(contact.id, idempotencyKey) as MessageRow | undefined;
      if (existing) return res.status(200).json(roomHostResponse(existing));
    }

    const roundId = crypto.randomUUID();
    const initialMeta = {
      roomHost: {
        name: hostName,
        roundId,
        idempotencyKey: idempotencyKey || undefined,
        status: trigger ? 'running' : 'done',
        targets: targetOverride.map((member) => member.id),
        reactionRounds: trigger
          ? Math.min(Math.max(Number(req.body?.reactionRounds ?? 2), 0), 3)
          : 0,
        coordination: coordination || undefined,
      },
    };
    const result = db.prepare(
      `INSERT INTO messages
         (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
       VALUES (?, 'room-host', 'user', 'text', ?, 'done', ?, 'main', ?)`
    ).run(contact.id, content, JSON.stringify(initialMeta), idempotencyKey || null);
    const row = db.prepare('SELECT * FROM messages WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as MessageRow;
    sse.broadcast('message', withAttachments(db, row));

    if (!trigger) {
      const doneMeta = {
        ...initialMeta,
        roomHost: { ...initialMeta.roomHost, lastMessageId: row.id },
      };
      db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(doneMeta), row.id);
      const doneRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id) as MessageRow;
      sse.broadcast('message', withAttachments(db, doneRow));
      return res.status(201).json(roomHostResponse(doneRow));
    }

    const tracked = manager.dispatchRoomMessageTracked(contact, content, {
      targetOverride,
      capture: false,
      reactionRounds: initialMeta.roomHost.reactionRounds,
    });
    void tracked.completion.then((outcome) => {
      const lastMessageId = Number(
        (db.prepare('SELECT COALESCE(MAX(id), ?) AS id FROM messages WHERE contact_id = ?')
          .get(row.id, contact.id) as { id: number }).id
      );
      const doneMeta = {
        ...initialMeta,
        roomHost: {
          ...initialMeta.roomHost,
          status: 'done',
          lastMessageId,
          completedAt: new Date().toISOString(),
          outcome,
        },
      };
      db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(doneMeta), row.id);
      const doneRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id) as MessageRow;
      sse.broadcast('message', withAttachments(db, doneRow));
    }).catch((error: Error) => {
      const failedMeta = {
        ...initialMeta,
        roomHost: {
          ...initialMeta.roomHost,
          status: 'error',
          completedAt: new Date().toISOString(),
          error: error.message.slice(0, 500),
        },
      };
      db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(failedMeta), row.id);
      const failedRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id) as MessageRow;
      sse.broadcast('message', withAttachments(db, failedRow));
    });

    res.status(202).json(roomHostResponse(row));
  });

  /** 编辑提示词并重新生成：内容可选更新，其后的消息全部软删，CLI 上下文重置回放。 */
  r.post('/:id/messages/:mid/regenerate', async (req, res) => {
    const contact = getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    const mid = Number(req.params.mid);
    const row = db
      .prepare('SELECT * FROM messages WHERE id = ? AND contact_id = ? AND deleted = 0')
      .get(mid, contact.id) as MessageRow | undefined;
    if (!row) return res.status(404).json({ error: 'message not found' });
    if (row.role !== 'user') return res.status(400).json({ error: '只能从你自己的消息重新生成' });
    if (contact.kind === 'room')
      return res.status(400).json({ error: '群聊里暂不支持重新生成（v1）' });

    let text = row.content;
    if (typeof req.body?.content === 'string' && req.body.content.trim()) {
      text = req.body.content.trim();
      db.prepare(
        `UPDATE messages SET content = ?, meta = json_set(COALESCE(meta,'{}'), '$.edited', 1) WHERE id = ?`
      ).run(text, mid);
      const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(mid) as MessageRow;
      sse.broadcast('message', withAttachments(db, updated));
    }

    const queued = await manager.get(contact).regenerateFrom(mid, text);
    if (queued === 'full') return res.status(429).json({ error: '排队太长了' });
    res.status(202).json({ ok: true, messageId: mid });
  });

  /** 删除单条消息：软删 + CLI 上下文重置（被删内容不再进入任何上下文）。 */
  r.delete('/:id/messages/:mid', async (req, res) => {
    const contact = getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    const mid = Number(req.params.mid);
    const row = db
      .prepare('SELECT * FROM messages WHERE id = ? AND contact_id = ? AND deleted = 0')
      .get(mid, contact.id) as MessageRow | undefined;
    if (!row) return res.status(404).json({ error: 'message not found' });

    db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(mid);
    deleteMessageFiles(db, uploadsDir, mid);
    sse.broadcast('prune', { contactId: contact.id, ids: [mid] });
    const origin = row.origin;
    sse.broadcast('read-state', {
      contactId: contact.id,
      ...getMessageReadState(db, contact.id, origin),
    });
    await manager.invalidateConversation(contact, mid);
    res.json({ ok: true });
  });

  /** token 消耗聚合（api/订阅通用，由 migration trigger 维护索引表）。 */
  r.get('/:id/usage', (req, res) => {
    const contact = getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    res.json(usageRepo.summary(contact.id, Number(req.query.tzOffset ?? -480)));
  });

  r.post('/:id/messages', receiveImages, (req, res) => {
    const contact = getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    const files = (req.files ?? []) as Express.Multer.File[];
    if (!content && files.length === 0) return res.status(400).json({ error: 'content or image required' });
    const explicitAutomation = normalizeAutomationDescriptor(req.body?.automation);
    const legacyAutomation = explicitAutomation ? null : legacyAutomationDescriptor(content);
    const automated = req.body?.automated === true || explicitAutomation !== null || legacyAutomation !== null;
    let automation: AutomationDescriptor | null = explicitAutomation ?? legacyAutomation;
    const hidden = req.body?.hidden === true;
    const requestedOrigin = automation?.messageType === 'background-event'
      ? 'side'
      : req.body?.origin ?? 'main';
    if (requestedOrigin !== 'main' && requestedOrigin !== 'side') {
      return res.status(400).json({ error: 'origin must be main or side' });
    }
    if (hidden && !automated) {
      return res.status(400).json({ error: 'hidden messages must be automated' });
    }
    const origin: MessageOrigin = contact.kind === 'room' ? 'main' : requestedOrigin;
    if (automated && !automation) {
      automation = {
        messageType: requestedOrigin === 'side'
          ? 'background-event'
          : hidden ? 'proactive-trigger' : 'automation-trigger',
        eventSource: 'unspecified-automation',
      };
    }
    const explicitIdempotencyKey = typeof req.body?.idempotencyKey === 'string'
      ? req.body.idempotencyKey.trim().slice(0, 200)
      : '';
    const idempotencyKey = explicitIdempotencyKey
      || (automation?.eventId
        ? `automation:${automation.eventSource}:${automation.eventId}`.slice(0, 200)
        : '');
    if (idempotencyKey) {
      const existing = findIdempotentMessage(contact.id, idempotencyKey);
      if (existing) return res.status(200).json(duplicateMessageResponse(existing));
    }
    const sender = automated ? 'system' : 'user';
    let roomTargets: ContactRow[] | undefined;
    if (files.length > 0 && contact.kind === 'room') {
      roomTargets = content ? manager.parseTargets(contact, content) : manager.imageRoomMembers(contact);
    }

    const storedContent = content || '请看这张图片。';

    let messageId: number;
    try {
      const result = db
        .prepare(
          `INSERT INTO messages (
             contact_id, sender, role, kind, content, status, meta, origin, idempotency_key
           )
           VALUES (?, ?, 'user', 'text', ?, 'done', ?, ?, ?)`
        )
        .run(
          contact.id,
          sender,
          storedContent,
          JSON.stringify(automation ? automationMeta(automation, { hidden }) : {}),
          origin,
          idempotencyKey || null
        );
      messageId = Number(result.lastInsertRowid);
    } catch (error) {
      const existing = idempotencyKey
        ? findIdempotentMessage(contact.id, idempotencyKey)
        : undefined;
      if (existing) return res.status(200).json(duplicateMessageResponse(existing));
      throw error;
    }
    const row = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(messageId) as MessageRow;
    try {
      for (const file of files) persistImage(db, uploadsDir, row.id, file);
    } catch (error) {
      deleteMessageFiles(db, uploadsDir, row.id);
      db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
      return res.status(400).json({ error: (error as Error).message });
    }
    const message = withAttachments(db, row);
    if (!hidden) sse.broadcast('message', message);

    if (contact.kind === 'room') {
      const targets = manager.dispatchRoomMessage(contact, storedContent, roomTargets, row.id);
      return res.status(202).json({ messageId: row.id, persisted: true, queued: true, targets });
    }

    const queued = manager.get(contact).enqueue({ userMessageId: row.id, text: storedContent });
    if (queued === 'full') {
      return res.status(429).json({
        error: '排队太长了，等他喘口气',
        messageId: row.id,
        persisted: true,
        queued: false,
      });
    }
    res.status(202).json({ messageId: row.id, persisted: true, queued: true });
  });

  r.post('/:id/interrupt', (req, res) => {
    const contact = getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    manager.interruptAll(contact);
    res.status(202).json({ ok: true });
  });

  r.post('/:id/session/reset', async (req, res) => {
    const contact = getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    await manager.resetConversation(contact);
    res.json({ ok: true });
  });

  return r;
}
