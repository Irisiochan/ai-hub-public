import { Router } from 'express';
import type { Db } from '../db.js';

/**
 * Read side of the diary rollup: hand back one Asia/Shanghai calendar day of
 * real conversation so the triage worker can distill it into vault 流水条目.
 *
 * 日界必须跟 migrations/0014_usage_daily.sql 一致地用 `date(created_at, '+8 hours')`
 * 算——sqlite 存的是 UTC 文本，宿主时区不参与。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 400;
const MAX_LIMIT = 1000;
const MAX_CONTENT_CHARS = 2000;

/**
 * 机器正文的开头。`sender`/`origin` 是主要闸门，但历史上有过没打自动化标记就写进主窗的
 * 派单消息（生产里 id=1723 就是 sender=user / origin=main / meta={}），只靠元数据挡不住。
 * 这些正文一旦被当成 User 原话，日记里就会出现她根本没说过的话。
 */
const MACHINE_PREFIXES = [
  '⚡ AI Hub 自主事件分派%',
  '⚙%Worker 任务回执%',
];

export interface JournalMessage {
  id: number;
  contactId: string;
  contactName: string;
  role: 'user' | 'assistant';
  at: string;
  content: string;
  clipped: boolean;
}

interface JournalRow {
  id: number;
  contact_id: string;
  contact_name: string;
  role: 'user' | 'assistant';
  at: string;
  content: string;
}

export function journalDay(db: Db, date: string, limit = DEFAULT_LIMIT): JournalMessage[] {
  const rows = db
    .prepare(
      `SELECT m.id            AS id,
              m.contact_id    AS contact_id,
              c.name          AS contact_name,
              m.role          AS role,
              strftime('%H:%M', m.created_at, '+8 hours') AS at,
              m.content       AS content
         FROM messages m
         JOIN contacts c ON c.id = m.contact_id
        WHERE date(m.created_at, '+8 hours') = ?
          AND m.deleted = 0
          AND m.kind = 'text'
          AND m.status = 'done'
          AND c.kind = 'dm'
          AND m.role IN ('user', 'assistant')
          -- 副窗是机器流水，主窗才是她真正在过的一天。
          AND m.origin = 'main'
          AND COALESCE(json_extract(m.meta, '$.uiHidden'), 0) != 1
          -- 自动触发的消息 sender 是 system / room-host；那是网关自己说的话。
          AND NOT (m.role = 'user' AND m.sender != 'user')
          ${MACHINE_PREFIXES.map(() => 'AND m.content NOT LIKE ?').join('\n          ')}
        ORDER BY m.id ASC
        LIMIT ?`
    )
    .all(date, ...MACHINE_PREFIXES, limit) as JournalRow[];

  return rows.map((row) => ({
    id: row.id,
    contactId: row.contact_id,
    contactName: row.contact_name,
    role: row.role,
    at: row.at ?? '',
    content: row.content.length > MAX_CONTENT_CHARS
      ? row.content.slice(0, MAX_CONTENT_CHARS)
      : row.content,
    clipped: row.content.length > MAX_CONTENT_CHARS,
  }));
}

export function journalRouter(db: Db): Router {
  const r = Router();

  r.get('/journal/day', (req, res) => {
    const date = String(req.query.date ?? '').trim();
    if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      return res.status(400).json({ error: 'date must be a valid YYYY-MM-DD' });
    }
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_LIMIT)
      : DEFAULT_LIMIT;
    const messages = journalDay(db, date, limit);
    res.json({
      date,
      limit,
      truncated: messages.length === limit,
      messages,
    });
  });

  return r;
}
