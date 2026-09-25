-- Open governance (O1): single holder baton + wake budget counters.
-- Additive only; strict mode mirrors holder_module with owner_module.
ALTER TABLE room_tasks ADD COLUMN holder_module TEXT;
ALTER TABLE room_tasks ADD COLUMN next_module TEXT;
ALTER TABLE room_tasks ADD COLUMN wake_count_date TEXT;
ALTER TABLE room_tasks ADD COLUMN wake_count INTEGER NOT NULL DEFAULT 0;
UPDATE room_tasks SET holder_module = owner_module WHERE holder_module IS NULL;
UPDATE room_tasks SET wake_count = 0 WHERE wake_count IS NULL;
