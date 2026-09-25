-- Model-driven room workflow: durable task-scoped operational ledger.
-- Historical job rows / room-host messages are preserved; this migration is
-- purely additive. One control owner per task; no automatic host engine.
-- Handoffs freeze the full target binding/permissions/workspace snapshot at
-- creation; delivery/accept/runtime/execution all use the frozen snapshot.
-- Task creation/import anchors to an authorized room user message (User
-- approval) verified server-side; the approved workspace is bound at
-- creation/import from verified sources.
CREATE TABLE IF NOT EXISTS room_tasks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  task_path TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  requirements TEXT NOT NULL DEFAULT '',
  requirements_sha TEXT NOT NULL DEFAULT '',
  approved_workspace TEXT NOT NULL DEFAULT '',
  anchor_message_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  revision INTEGER NOT NULL DEFAULT 1,
  owner_module TEXT NOT NULL DEFAULT 'plan',
  owner_contact TEXT NOT NULL DEFAULT '',
  active_handoff_id TEXT,
  candidate_sha TEXT,
  candidate_job_id TEXT,
  review_status TEXT,
  review_evidence_id INTEGER,
  imported INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(room_id, task_path)
);
CREATE INDEX IF NOT EXISTS idx_room_tasks_room ON room_tasks(room_id);
CREATE TABLE IF NOT EXISTS room_task_handoffs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES room_tasks(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  from_module TEXT NOT NULL,
  from_contact TEXT NOT NULL,
  to_module TEXT NOT NULL,
  to_contact TEXT NOT NULL,
  to_revision INTEGER NOT NULL,
  to_binding TEXT NOT NULL DEFAULT '{}',
  to_permissions TEXT NOT NULL DEFAULT '{}',
  approved_workspace TEXT NOT NULL DEFAULT '',
  request TEXT NOT NULL DEFAULT '',
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_room_task_handoffs_task ON room_task_handoffs(task_id, id);
CREATE TABLE IF NOT EXISTS room_task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES room_tasks(id),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  module TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_room_task_events_task ON room_task_events(task_id, id);
CREATE TABLE IF NOT EXISTS room_task_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES room_tasks(id),
  kind TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_room_task_evidence_task ON room_task_evidence(task_id, id);
CREATE TABLE IF NOT EXISTS room_task_links (
  job_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES room_tasks(id),
  room_id TEXT NOT NULL,
  attached_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_room_task_links_task ON room_task_links(task_id);
-- Delivery ledger: one row per idempotent wake (handoff or callback).
-- posted = fact recorded AND same captured recipient woken exactly once;
-- failed = retryable. A posted key is never woken again (no double-wake).
CREATE TABLE IF NOT EXISTS room_task_dispatches (
  idempotency_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'posted',
  message_id INTEGER,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Explicit callback registrations: the executor names the return module at
-- start; the gateway freezes the return contact/binding/permissions THEN.
-- Completion delivers this exact snapshot even across rebind/restart; it is
-- never re-resolved live and never borrows the execution recipient.
CREATE TABLE IF NOT EXISTS room_task_callbacks (
  job_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES room_tasks(id),
  return_module TEXT NOT NULL,
  return_contact TEXT NOT NULL,
  return_revision INTEGER NOT NULL,
  return_binding TEXT NOT NULL DEFAULT '{}',
  return_permissions TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_room_task_callbacks_task ON room_task_callbacks(task_id);
