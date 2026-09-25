-- Capture the first implementation's starting HEAD once; preserve historical tasks.
ALTER TABLE room_tasks ADD COLUMN baseline_sha TEXT;
