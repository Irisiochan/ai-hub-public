import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

export interface ContactRow {
  id: string;
  name: string;
  avatar: string;
  color: string;
  backend: 'claude-cli' | 'codex' | 'grok-cli' | 'api';
  kind: 'dm' | 'room';
  config: string; // JSON
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

const MIGRATIONS: string[] = [
  `
  CREATE TABLE contacts (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    avatar      TEXT NOT NULL DEFAULT '🤖',
    color       TEXT NOT NULL DEFAULT '#888888',
    backend     TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'dm',
    config      TEXT NOT NULL DEFAULT '{}',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id  TEXT NOT NULL REFERENCES contacts(id),
    sender      TEXT NOT NULL,
    role        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'text',
    content     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'done',
    turn_id     TEXT,
    meta        TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_messages_contact ON messages(contact_id, id);

  CREATE TABLE sessions (
    contact_id  TEXT NOT NULL REFERENCES contacts(id),
    session_id  TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX idx_sessions_active ON sessions(contact_id) WHERE active = 1;

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE memory_outbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tool       TEXT NOT NULL,
    args       TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  `
  ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE sessions ADD COLUMN member_id TEXT NOT NULL DEFAULT '';
  DROP INDEX idx_sessions_active;
  CREATE UNIQUE INDEX idx_sessions_active ON sessions(contact_id, member_id) WHERE active = 1;

  CREATE TABLE room_member_state (
    contact_id   TEXT NOT NULL,
    member_id    TEXT NOT NULL,
    last_seen_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (contact_id, member_id)
  );
  `,
  `
  CREATE TABLE workers (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    token_hash    TEXT NOT NULL,
    capabilities  TEXT NOT NULL DEFAULT '{}',
    status        TEXT NOT NULL DEFAULT 'offline',
    last_seen_at  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE jobs (
    id               TEXT PRIMARY KEY,
    requested_by     TEXT,
    worker_id        TEXT REFERENCES workers(id),
    runner           TEXT NOT NULL,
    workspace        TEXT NOT NULL,
    prompt           TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    priority         INTEGER NOT NULL DEFAULT 0,
    ttl_at           TEXT,
    lease_until      TEXT,
    session_id       TEXT,
    idempotency_key  TEXT NOT NULL UNIQUE,
    permissions      TEXT NOT NULL DEFAULT '{}',
    result           TEXT,
    error            TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_jobs_queue ON jobs(status, priority DESC, created_at);
  CREATE INDEX idx_jobs_worker ON jobs(worker_id, status);

  CREATE TABLE job_messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    sender      TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'log',
    content     TEXT NOT NULL,
    meta        TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_job_messages_job ON job_messages(job_id, id);
  `,
  `
  CREATE TABLE conversation_summaries (
    contact_id         TEXT NOT NULL REFERENCES contacts(id),
    member_id          TEXT NOT NULL DEFAULT '',
    summary            TEXT NOT NULL DEFAULT '',
    through_message_id INTEGER NOT NULL DEFAULT 0,
    version            INTEGER NOT NULL DEFAULT 1,
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (contact_id, member_id)
  );
  `,
  `
  CREATE TABLE message_attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    stored_name   TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size          INTEGER NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_message_attachments_message ON message_attachments(message_id, id);
  `,
  `
  ALTER TABLE jobs ADD COLUMN origin_contact_id TEXT;
  ALTER TABLE jobs ADD COLUMN origin_anchor_id INTEGER;
  `,
  `
  ALTER TABLE workers ADD COLUMN accepting_jobs INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE workers ADD COLUMN boot_id TEXT;
  `,
  `
  ALTER TABLE jobs ADD COLUMN delivery_state TEXT;
  ALTER TABLE jobs ADD COLUMN delivery_meta TEXT;
  `,
  `
  UPDATE contacts
     SET config = json_set(
       config,
       '$.baseUrl',
       rtrim(json_extract(config, '$.baseUrl'), '/') ||
         CASE
           WHEN json_extract(config, '$.provider') = 'anthropic' THEN '/v1/messages'
           ELSE '/v1/chat/completions'
         END
     )
   WHERE backend = 'api'
     AND json_valid(config)
     AND typeof(json_extract(config, '$.baseUrl')) = 'text'
     AND trim(json_extract(config, '$.baseUrl')) <> ''
     AND rtrim(json_extract(config, '$.baseUrl'), '/') NOT LIKE '%/messages'
     AND rtrim(json_extract(config, '$.baseUrl'), '/') NOT LIKE '%/chat/completions';
  `,
  `
  ALTER TABLE jobs ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE jobs ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
  `,
];

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
