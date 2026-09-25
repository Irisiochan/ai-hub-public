-- Min-closure-2 W-sequence: plan hands the whole W series to the gateway;
-- each proven merge starts the next block's execute Worker directly.
-- Additive only; existing rows keep NULL (no sequence).
ALTER TABLE room_tasks ADD COLUMN sequence_json TEXT;
ALTER TABLE room_tasks ADD COLUMN sequence_index INTEGER;
