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
