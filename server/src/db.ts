import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { ContactBackend, ContactConfig } from '@ai-hub/contact-config';
import { loadMigrations } from './migrations.js';

export type Db = Database.Database;

export interface ContactRow {
  id: string;
  name: string;
  avatar: string;
  color: string;
  backend: ContactBackend;
  kind: 'dm' | 'room';
  config: string; // JSON
  /** Parsed once by openContact; non-enumerable so secrets never spread into API payloads. */
  configParsed?: ContactConfig;
  sort_order: number;
  enabled: number;
  created_at: string;
}

export interface MessageRow {
  id: number;
  contact_id: string;
  sender: string;
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'thinking' | 'tool_use' | 'error';
  content: string;
  status: 'streaming' | 'done' | 'error' | 'interrupted';
  turn_id: string | null;
  meta: string; // JSON
  created_at: string;
  deleted: number;
}

export interface AttachmentRow {
  id: number;
  message_id: number;
  stored_name: string;
  original_name: string;
  mime_type: string;
  size: number;
  created_at: string;
}

export interface ConversationSummaryRow {
  contact_id: string;
  member_id: string;
  summary: string;
  through_message_id: number;
  version: number;
  updated_at: string;
}

export interface WorkerRow {
  id: string;
  name: string;
  token_hash: string;
  capabilities: string;
  status: string;
  accepting_jobs: number;
  boot_id: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface JobRow {
  id: string;
  requested_by: string | null;
  worker_id: string | null;
  runner: 'codex' | 'claude';
  workspace: string;
  prompt: string;
  status: string;
  priority: number;
  ttl_at: string | null;
  lease_until: string | null;
  session_id: string | null;
  idempotency_key: string;
  permissions: string;
  result: string | null;
  error: string | null;
  delivery_state: string | null;
  delivery_meta: string | null;
  origin_contact_id: string | null;
  origin_anchor_id: number | null;
  /** JSON: {model?, reasoning?} — 派单时指定的模型和推理强度覆盖 */
  options: string;
  /** 1 = 任务窗口已软删/隐藏（UI 不再展示；行与审计日志保留） */
  deleted: number;
  created_at: string;
  updated_at: string;
}

const MIGRATIONS = loadMigrations();

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const version = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

export function getActiveSession(db: Db, contactId: string, memberId = ''): string | null {
  const row = db
    .prepare(
      'SELECT session_id FROM sessions WHERE contact_id = ? AND member_id = ? AND active = 1'
    )
    .get(contactId, memberId) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function saveSession(db: Db, contactId: string, sessionId: string, memberId = ''): void {
  const existing = getActiveSession(db, contactId, memberId);
  if (existing === sessionId) {
    db.prepare(
      "UPDATE sessions SET updated_at = datetime('now') WHERE contact_id = ? AND member_id = ? AND active = 1"
    ).run(contactId, memberId);
    return;
  }
  db.prepare(
    'UPDATE sessions SET active = 0 WHERE contact_id = ? AND member_id = ? AND active = 1'
  ).run(contactId, memberId);
  db.prepare(
    'INSERT INTO sessions (contact_id, member_id, session_id, active) VALUES (?, ?, ?, 1)'
  ).run(contactId, memberId, sessionId);
}

export function deactivateSession(db: Db, contactId: string, memberId?: string): void {
  if (memberId === undefined) {
    // 整个会话（DM 或群聊全员）作废
    db.prepare('UPDATE sessions SET active = 0 WHERE contact_id = ? AND active = 1').run(contactId);
  } else {
    db.prepare(
      'UPDATE sessions SET active = 0 WHERE contact_id = ? AND member_id = ? AND active = 1'
    ).run(contactId, memberId);
  }
}
export function getLastSeen(db: Db, contactId: string, memberId: string): number {
  const row = db
    .prepare('SELECT last_seen_id FROM room_member_state WHERE contact_id = ? AND member_id = ?')
    .get(contactId, memberId) as { last_seen_id: number } | undefined;
  return row?.last_seen_id ?? 0;
}

export function setLastSeen(db: Db, contactId: string, memberId: string, id: number): void {
  db.prepare(
    `INSERT INTO room_member_state (contact_id, member_id, last_seen_id) VALUES (?, ?, ?)
     ON CONFLICT(contact_id, member_id) DO UPDATE SET last_seen_id = excluded.last_seen_id`
  ).run(contactId, memberId, id);
}

export function invalidateConversationSummary(db: Db, contactId: string, memberId?: string): void {
  if (memberId === undefined) {
    db.prepare('DELETE FROM conversation_summaries WHERE contact_id = ?').run(contactId);
  } else {
    db.prepare('DELETE FROM conversation_summaries WHERE contact_id = ? AND member_id = ?').run(
      contactId,
      memberId
    );
  }
}
