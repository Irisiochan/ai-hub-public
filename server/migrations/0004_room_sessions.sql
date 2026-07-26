  ALTER TABLE sessions ADD COLUMN member_id TEXT NOT NULL DEFAULT '';
  DROP INDEX idx_sessions_active;
  CREATE UNIQUE INDEX idx_sessions_active ON sessions(contact_id, member_id) WHERE active = 1;

  CREATE TABLE room_member_state (
    contact_id   TEXT NOT NULL,
    member_id    TEXT NOT NULL,
    last_seen_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (contact_id, member_id)
  );
