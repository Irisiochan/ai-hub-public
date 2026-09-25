CREATE TABLE IF NOT EXISTS workflow_module_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  policy_version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_module_arbitration_verdicts (
  task_path TEXT NOT NULL,
  problem_fingerprint TEXT NOT NULL,
  verdict_job_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('proceed', 'needs_iris')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_path, problem_fingerprint)
);

INSERT OR IGNORE INTO workflow_module_state (singleton, policy_version, revision, updated_by)
VALUES (1, 1, 1, 'migration');

CREATE TABLE IF NOT EXISTS workflow_module_bindings (
  module_id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  runner TEXT NOT NULL,
  model TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_module_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  module_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Task-scoped quality counters. Keyed ONLY by task+problem so that config
-- revision / model / phase changes and new attempts never reset them.
CREATE TABLE IF NOT EXISTS workflow_module_streaks (
  task_path TEXT NOT NULL,
  problem_fingerprint TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_path, problem_fingerprint)
);

CREATE TABLE IF NOT EXISTS workflow_module_review_streaks (
  task_path TEXT NOT NULL,
  problem_fingerprint TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_path, problem_fingerprint)
);

CREATE TABLE IF NOT EXISTS workflow_module_quality_events (
  job_id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  problem_fingerprint TEXT NOT NULL DEFAULT '',
  quality TEXT NOT NULL CHECK (quality IN ('success', 'inadequate', 'infrastructure')),
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Manual takeover fencing: old attempt fenced at takeover time; late
-- messages/delivery/quality/closure callbacks for fenced jobs are rejected.
CREATE TABLE IF NOT EXISTS workflow_module_takeovers (
  old_job_id TEXT PRIMARY KEY,
  new_job_id TEXT NOT NULL,
  module_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_module_audit_created
  ON workflow_module_audit(created_at DESC);
