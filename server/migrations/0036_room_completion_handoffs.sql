-- Explicit start-time completion handoff intent. Existing callbacks stay notifications.
CREATE TABLE IF NOT EXISTS room_task_completion_handoffs (
  job_id TEXT PRIMARY KEY REFERENCES room_task_callbacks(job_id),
  task_id TEXT NOT NULL REFERENCES room_tasks(id),
  from_module TEXT NOT NULL,
  from_contact TEXT NOT NULL,
  after_event_id INTEGER NOT NULL,
  origin_turn_id TEXT NOT NULL DEFAULT '',
  handoff_id TEXT REFERENCES room_task_handoffs(id)
);
