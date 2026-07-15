import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { AttachmentRow, Db } from '../db.js';

export function attachmentsRouter(db: Db, uploadsDir: string): Router {
  const r = Router();

  r.get('/:id', (req, res) => {
    const attachment = db
      .prepare(
        `SELECT a.* FROM message_attachments a
         JOIN messages m ON m.id = a.message_id
         JOIN contacts c ON c.id = m.contact_id
         WHERE a.id = ? AND m.deleted = 0 AND c.enabled = 1`
      )
      .get(Number(req.params.id)) as AttachmentRow | undefined;
    if (!attachment) return res.status(404).json({ error: 'attachment not found' });
    const file = path.join(uploadsDir, attachment.stored_name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'attachment file missing' });
    res.set({
      'Cache-Control': 'private, max-age=3600',
      'Content-Type': attachment.mime_type,
      'Content-Length': String(attachment.size),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`,
      'X-Content-Type-Options': 'nosniff',
    });
    res.sendFile(file);
  });

  return r;
}
