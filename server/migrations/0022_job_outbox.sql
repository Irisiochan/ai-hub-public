-- Durable outbox for job terminal-transition side effects (receipt / tail /
-- continuation). The terminal UPDATE and the outbox enqueue commit in one
-- transaction; a crash before the in-memory onFinished callback no longer
-- loses the receipt — the pending row survives restart and is replayed with
-- backoff. UNIQUE(job_id, kind) keeps terminal retries from double-firing.
CREATE TABLE job_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL DEFAULT 'finished',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  -- epoch ms; also doubles as an in-flight lease while a drain is processing
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(job_id, kind)
);
CREATE INDEX idx_job_outbox_claim ON job_outbox(status, next_attempt_at);
