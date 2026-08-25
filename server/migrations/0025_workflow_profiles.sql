CREATE TABLE workflow_profile_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_profile_id TEXT NOT NULL,
  active_profile_version INTEGER NOT NULL,
  previous_profile_id TEXT,
  previous_profile_version INTEGER,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO workflow_profile_state (
  singleton, active_profile_id, active_profile_version, updated_by
) VALUES (1, 'protocol-a', 1, 'migration');

CREATE TABLE workflow_profile_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  from_profile_id TEXT,
  from_profile_version INTEGER,
  to_profile_id TEXT NOT NULL,
  to_profile_version INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE workflow_quality_streaks (
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  task_path TEXT NOT NULL,
  stage TEXT NOT NULL,
  problem_fingerprint TEXT NOT NULL,
  primary_runner TEXT NOT NULL,
  primary_model TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
  fallback_active INTEGER NOT NULL DEFAULT 0 CHECK (fallback_active IN (0, 1)),
  last_quality TEXT,
  last_detail TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (
    profile_id, profile_version, task_path, stage, problem_fingerprint,
    primary_runner, primary_model
  )
);

CREATE TABLE workflow_quality_events (
  job_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  stage TEXT NOT NULL,
  problem_fingerprint TEXT NOT NULL,
  quality TEXT NOT NULL CHECK (quality IN ('success', 'inadequate', 'infrastructure')),
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_workflow_profile_audit_created
  ON workflow_profile_audit(created_at DESC);
