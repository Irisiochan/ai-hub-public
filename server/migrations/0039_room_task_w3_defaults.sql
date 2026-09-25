-- W3 VPS-default routing: baseline source audit + declared PC-only capabilities.
-- Additive only; existing rows keep NULL (unknown source / no PC declaration).
ALTER TABLE room_tasks ADD COLUMN baseline_source TEXT;
ALTER TABLE room_tasks ADD COLUMN needs_pc TEXT;
