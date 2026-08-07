import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AttachmentRow, Db, MessageRow } from './db.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;
export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export interface PublicAttachment {
  id: number;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

export type MessageWithAttachments = MessageRow & { attachments: PublicAttachment[] };

export function ensureUploadsDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function cleanupOrphanUploads(db: Db, uploadsDir: string): number {
  ensureUploadsDir(uploadsDir);
  const referenced = new Set(
    (db.prepare('SELECT stored_name FROM message_attachments').all() as { stored_name: string }[])
      .map((row) => row.stored_name)
  );
  let removed = 0;
  for (const entry of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
    if (entry.isFile() && !referenced.has(entry.name)) {
      fs.rmSync(path.join(uploadsDir, entry.name), { force: true });
      removed++;
    }
  }
  return removed;
}

function hasImageSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  if (mimeType === 'image/webp') {
    return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

export function attachmentsForMessage(db: Db, messageId: number): AttachmentRow[] {
  return db
    .prepare('SELECT * FROM message_attachments WHERE message_id = ? ORDER BY id ASC')
    .all(messageId) as AttachmentRow[];
}

/** Resolve persisted attachments to trusted local paths for CLI vision backends. */
export function attachmentPathsForMessages(
  db: Db,
  uploadsDir: string,
  messageIds: number[]
): string[] {
  if (messageIds.length === 0) return [];
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT stored_name FROM message_attachments
       WHERE message_id IN (${placeholders}) ORDER BY message_id ASC, id ASC`
    )
    .all(...messageIds) as { stored_name: string }[];
  const root = path.resolve(uploadsDir);
  return rows.flatMap((row) => {
    const file = path.resolve(root, row.stored_name);
    return path.dirname(file) === root && fs.existsSync(file) ? [file] : [];
  });
}

export function publicAttachment(row: AttachmentRow): PublicAttachment {
  return {
    id: row.id,
    name: row.original_name,
    mimeType: row.mime_type,
    size: row.size,
    url: `/api/attachments/${row.id}`,
  };
}

export function withAttachments(db: Db, row: MessageRow): MessageWithAttachments {
  return { ...row, attachments: attachmentsForMessage(db, row.id).map(publicAttachment) };
}

export function withAttachmentsMany(db: Db, rows: MessageRow[]): MessageWithAttachments[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const found = db
    .prepare(`SELECT * FROM message_attachments WHERE message_id IN (${placeholders}) ORDER BY id ASC`)
    .all(...ids) as AttachmentRow[];
  const byMessage = new Map<number, PublicAttachment[]>();
  for (const attachment of found) {
    const list = byMessage.get(attachment.message_id) ?? [];
    list.push(publicAttachment(attachment));
    byMessage.set(attachment.message_id, list);
  }
  return rows.map((row) => ({ ...row, attachments: byMessage.get(row.id) ?? [] }));
}

export function persistImage(
  db: Db,
  uploadsDir: string,
  messageId: number,
  file: Express.Multer.File
): AttachmentRow {
  return persistImageBuffer(db, uploadsDir, messageId, {
    bytes: file.buffer,
    mimeType: file.mimetype,
    originalName: file.originalname,
  });
}

export function persistImageBuffer(
  db: Db,
  uploadsDir: string,
  messageId: number,
  image: { bytes: Buffer; mimeType: string; originalName?: string }
): AttachmentRow {
  if (!ALLOWED_IMAGE_TYPES.has(image.mimeType)) throw new Error('只支持 JPEG、PNG、WebP、GIF 图片');
  if (image.bytes.length > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 10 MB');
  if (!hasImageSignature(image.bytes, image.mimeType)) throw new Error('图片内容与文件格式不匹配');
  ensureUploadsDir(uploadsDir);
  const ext = image.mimeType === 'image/jpeg' ? '.jpg' : `.${image.mimeType.slice(6)}`;
  const storedName = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(uploadsDir, storedName), image.bytes, { mode: 0o600, flag: 'wx' });
  try {
    const result = db
      .prepare(
        `INSERT INTO message_attachments (message_id, stored_name, original_name, mime_type, size)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        messageId,
        storedName,
        path.basename(image.originalName || `image${ext}`),
        image.mimeType,
        image.bytes.length,
      );
    return db
      .prepare('SELECT * FROM message_attachments WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as AttachmentRow;
  } catch (error) {
    fs.rmSync(path.join(uploadsDir, storedName), { force: true });
    throw error;
  }
}

export function deleteMessageFiles(db: Db, uploadsDir: string, messageId: number): void {
  for (const attachment of attachmentsForMessage(db, messageId)) {
    fs.rmSync(path.join(uploadsDir, attachment.stored_name), { force: true });
  }
  db.prepare('DELETE FROM message_attachments WHERE message_id = ?').run(messageId);
}

/**
 * 物理删除消息行（附件先清）。用于内部气泡收回、软删过期 purge 等。
 * 用户主动删除仍走 soft-delete（messages.deleted=1）。
 */
export function hardDeleteMessages(db: Db, uploadsDir: string, messageIds: number[]): number {
  const ids = [...new Set(messageIds.filter((id) => Number.isFinite(id) && id > 0))];
  if (ids.length === 0) return 0;
  const del = db.transaction((batch: number[]) => {
    let n = 0;
    for (const id of batch) {
      deleteMessageFiles(db, uploadsDir, id);
      const r = db.prepare('DELETE FROM messages WHERE id = ?').run(id);
      n += r.changes;
    }
    return n;
  });
  return del(ids);
}

export function attachmentDataUrl(uploadsDir: string, row: AttachmentRow): string {
  const bytes = fs.readFileSync(path.join(uploadsDir, row.stored_name));
  return `data:${row.mime_type};base64,${bytes.toString('base64')}`;
}
