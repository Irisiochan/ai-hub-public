CREATE TABLE heartbeat_sessions_next (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  interval_minutes INTEGER NOT NULL DEFAULT 5,
  tick_count INTEGER NOT NULL DEFAULT 0,
  last_tick_at TEXT,
  stopped_at TEXT,
  stop_reason TEXT
);

INSERT INTO heartbeat_sessions_next (
  id,
  contact_id,
  started_at,
  expires_at,
  interval_minutes,
  tick_count,
  last_tick_at,
  stopped_at,
  stop_reason
)
SELECT
  id,
  contact_id,
  started_at,
  expires_at,
  interval_minutes,
  tick_count,
  last_tick_at,
  stopped_at,
  stop_reason
FROM heartbeat_sessions;

DROP TABLE heartbeat_sessions;
ALTER TABLE heartbeat_sessions_next RENAME TO heartbeat_sessions;

CREATE INDEX idx_heartbeat_active
  ON heartbeat_sessions(contact_id)
  WHERE stopped_at IS NULL;
