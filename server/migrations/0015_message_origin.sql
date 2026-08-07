ALTER TABLE messages
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'main'
  CHECK (origin IN ('main', 'side'));

CREATE INDEX idx_messages_contact_origin
  ON messages(contact_id, origin, id);
