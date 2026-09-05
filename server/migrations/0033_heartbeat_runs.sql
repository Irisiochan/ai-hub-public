-- Independent of messages: silent cleanup must not erase execution or usage evidence.
CREATE TABLE heartbeat_runs (
  session_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  contact_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  tool_count INTEGER NOT NULL DEFAULT 0,
  write_attempted INTEGER NOT NULL DEFAULT 0,
  usage TEXT,
  PRIMARY KEY(session_id, tick)
);
CREATE INDEX heartbeat_runs_contact ON heartbeat_runs(contact_id, started_at);
ALTER TABLE heartbeat_sessions ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE heartbeat_sessions ADD COLUMN paused_reason TEXT;
