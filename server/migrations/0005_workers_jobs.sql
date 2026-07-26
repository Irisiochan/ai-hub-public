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
