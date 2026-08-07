ALTER TABLE memory_outbox
  ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'dead'));

ALTER TABLE memory_outbox
  ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE memory_outbox
  ADD COLUMN dead_at TEXT;

CREATE INDEX idx_memory_outbox_due
  ON memory_outbox(status, next_attempt_at, id);
