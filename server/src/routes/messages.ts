import { Router, type RequestHandler } from 'express';
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
import type { ContactRow, Db, MessageRow } from '../db.js';
import type { SseHub } from '../sse.js';

export function messagesRouter(db: Db, sse: SseHub, manager: AgentManager, uploadsDir: string): Router {
  const r = Router();
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

  r.get('/:id/messages', (req, res) => {
    const contact = getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const before = req.query.before ? Number(req.query.before) : null;
    const after = req.query.after ? Number(req.query.after) : null;

    let rows: MessageRow[];
    if (after !== null) {
      rows = db
        .prepare(
          'SELECT * FROM messages WHERE contact_id = ? AND deleted = 0 AND id > ? ORDER BY id ASC LIMIT ?'
        )
        .all(contact.id, after, limit) as MessageRow[];
    } else if (before !== null) {
      rows = (
        db
          .prepare(
            'SELECT * FROM messages WHERE contact_id = ? AND deleted = 0 AND id < ? ORDER BY id DESC LIMIT ?'
          )
          .all(contact.id, before, limit) as MessageRow[]
      ).reverse();
    } else {
      rows = (
        db
          .prepare(
            'SELECT * FROM messages WHERE contact_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?'
          )
          .all(contact.id, limit) as MessageRow[]
      ).reverse();
    }
    res.json({ messages: withAttachmentsMany(db, rows) });
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
    await manager.invalidateConversation(contact);
    res.json({ ok: true });
  });

  /** token 消耗聚合（api/订阅通用，来自 done 消息的 meta.usage）。 */
  r.get('/:id/usage', (req, res) => {
    const contact = getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    const rows = db
      .prepare(
        `SELECT meta, created_at FROM messages
         WHERE contact_id = ? AND deleted = 0 AND role = 'assistant' AND meta LIKE '%usage%'
         ORDER BY id ASC`
      )
      .all(contact.id) as { meta: string; created_at: string }[];
    const rawOffset = Number(req.query.tzOffset ?? 0);
    const tzOffset = Number.isFinite(rawOffset) ? Math.max(-840, Math.min(840, rawOffset)) : 0;
    const localDateKey = (date: Date) =>
      new Date(date.getTime() - tzOffset * 60_000).toISOString().slice(0, 10);
    const today = localDateKey(new Date());
    const empty = () => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
    const sum = { today: empty(), total: empty(), last: empty() };
    for (const r2 of rows) {
      try {
        const u = JSON.parse(r2.meta)?.usage;
        if (!u) continue;
        sum.total.input += u.input ?? 0;
        sum.total.output += u.output ?? 0;
        sum.total.cacheCreation += u.cacheCreation ?? 0;
        sum.total.cacheRead += u.cacheRead ?? 0;
        const stamp = new Date(`${r2.created_at.replace(' ', 'T')}Z`);
        if (!Number.isNaN(stamp.getTime()) && localDateKey(stamp) === today) {
          sum.today.input += u.input ?? 0;
          sum.today.output += u.output ?? 0;
          sum.today.cacheCreation += u.cacheCreation ?? 0;
          sum.today.cacheRead += u.cacheRead ?? 0;
        }
        sum.last = { ...empty(), ...u };
      } catch {}
    }
    res.json(sum);
  });

  r.post('/:id/messages', receiveImages, (req, res) => {
    const contact = getContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    const files = (req.files ?? []) as Express.Multer.File[];
    if (!content && files.length === 0) return res.status(400).json({ error: 'content or image required' });
    let roomTargets: ContactRow[] | undefined;
    if (files.length > 0 && contact.kind === 'room') {
      roomTargets = content ? manager.parseTargets(contact, content) : manager.imageRoomMembers(contact);
    }

    const storedContent = content || '请看这张图片。';

    const result = db
      .prepare(
        `INSERT INTO messages (contact_id, sender, role, kind, content, status)
         VALUES (?, 'user', 'user', 'text', ?, 'done')`
      )
      .run(contact.id, storedContent);
    const row = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as MessageRow;
    try {
      for (const file of files) persistImage(db, uploadsDir, row.id, file);
    } catch (error) {
      deleteMessageFiles(db, uploadsDir, row.id);
      db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
      return res.status(400).json({ error: (error as Error).message });
    }
    const message = withAttachments(db, row);
    sse.broadcast('message', message);

    if (contact.kind === 'room') {
      const targets = manager.dispatchRoomMessage(contact, storedContent, roomTargets);
      return res.status(202).json({ messageId: row.id, queued: true, targets });
    }

    const queued = manager.get(contact).enqueue({ userMessageId: row.id, text: storedContent });
    if (queued === 'full') {
      return res.status(429).json({ error: '排队太长了，等他喘口气', messageId: row.id });
    }
    res.status(202).json({ messageId: row.id, queued: true });
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
