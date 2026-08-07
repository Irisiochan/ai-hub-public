CREATE TABLE task_writebacks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key  TEXT NOT NULL UNIQUE,
  message_id       INTEGER NOT NULL,
  contact_id       TEXT NOT NULL,
  contact_name     TEXT NOT NULL,
  task_path        TEXT,
  action           TEXT,
  confidence       REAL,
  due              TEXT,
  source_quote     TEXT NOT NULL,
  source_ref       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'processing'
                   CHECK (status IN (
                     'processing', 'applied', 'proposed', 'rejected',
                     'ambiguous', 'conflict', 'queued', 'failed'
                   )),
  detail           TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_task_writebacks_status
  ON task_writebacks(status, updated_at, id);

CREATE INDEX idx_task_writebacks_task
  ON task_writebacks(task_path, updated_at, id);
