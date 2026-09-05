CREATE TABLE heartbeat_sessions (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL DEFAULT 5,
  tick_count INTEGER NOT NULL DEFAULT 0,
  last_tick_at TEXT,
  stopped_at TEXT,
  stop_reason TEXT
);

CREATE INDEX idx_heartbeat_active
  ON heartbeat_sessions(contact_id)
  WHERE stopped_at IS NULL;
