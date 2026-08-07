ALTER TABLE messages
  ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX idx_messages_contact_idempotency
  ON messages(contact_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
