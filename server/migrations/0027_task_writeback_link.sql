ALTER TABLE task_writebacks
  ADD COLUMN command_id TEXT;

ALTER TABLE task_writebacks
  ADD COLUMN event_id TEXT;
