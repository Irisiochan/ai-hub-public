  CREATE TABLE conversation_summaries (
    contact_id         TEXT NOT NULL REFERENCES contacts(id),
    member_id          TEXT NOT NULL DEFAULT '',
    summary            TEXT NOT NULL DEFAULT '',
    through_message_id INTEGER NOT NULL DEFAULT 0,
    version            INTEGER NOT NULL DEFAULT 1,
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (contact_id, member_id)
  );
