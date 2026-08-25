CREATE TABLE work_items (
  task_id              TEXT PRIMARY KEY,
  source_path          TEXT NOT NULL UNIQUE,
  status               TEXT NOT NULL
                       CHECK (status IN ('proposed', 'open', 'blocked', 'done', 'dropped')),
  version              INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  spec_fingerprint     TEXT NOT NULL,
  content_fingerprint  TEXT NOT NULL,
  due                  TEXT,
  mode                 TEXT NOT NULL DEFAULT 'ask' CHECK (mode IN ('ask', 'auto')),
  parent_id            TEXT,
  source_ref           TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_work_items_status_due
  ON work_items(status, due, task_id);
CREATE INDEX idx_work_items_parent
  ON work_items(parent_id, task_id);

CREATE TABLE task_events (
  event_id        TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES work_items(task_id),
  task_version    INTEGER NOT NULL CHECK (task_version > 0),
  kind            TEXT NOT NULL,
  previous_status TEXT,
  next_status     TEXT NOT NULL,
  actor           TEXT NOT NULL,
  source          TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_task_events_task_version
  ON task_events(task_id, task_version, created_at, event_id);

CREATE TRIGGER task_events_immutable_update
BEFORE UPDATE ON task_events
BEGIN
  SELECT RAISE(ABORT, 'task_events are immutable');
END;

CREATE TRIGGER task_events_immutable_delete
BEFORE DELETE ON task_events
BEGIN
  SELECT RAISE(ABORT, 'task_events are immutable');
END;

CREATE TABLE task_commands (
  command_id       TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL UNIQUE,
  task_id          TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK (expected_version > 0),
  requested_status TEXT NOT NULL,
  actor            TEXT NOT NULL,
  source           TEXT NOT NULL,
  reason           TEXT NOT NULL,
  evidence         TEXT NOT NULL DEFAULT '{}',
  result           TEXT NOT NULL CHECK (result IN ('processing', 'applied', 'rejected')),
  result_version   INTEGER,
  event_id         TEXT,
  error            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at     TEXT
);

CREATE INDEX idx_task_commands_task
  ON task_commands(task_id, created_at, command_id);
CREATE INDEX idx_task_commands_result
  ON task_commands(result, created_at, command_id);

CREATE TABLE task_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        TEXT NOT NULL REFERENCES task_events(event_id),
  task_id         TEXT NOT NULL,
  projection      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'done', 'dead')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(event_id, projection)
);

CREATE INDEX idx_task_outbox_claim
  ON task_outbox(status, next_attempt_at, id);
