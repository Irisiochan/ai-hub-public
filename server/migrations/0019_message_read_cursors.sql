CREATE TABLE message_read_cursors (
  contact_id           TEXT NOT NULL REFERENCES contacts(id),
  origin               TEXT NOT NULL CHECK (origin IN ('main', 'side')),
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (contact_id, origin)
);

-- Existing installations start with their current visible history read. This
-- keeps the feature rollout from turning old conversations into new unread.
INSERT INTO message_read_cursors (contact_id, origin, last_read_message_id)
SELECT c.id, origins.origin, COALESCE(MAX(m.id), 0)
FROM contacts c
CROSS JOIN (
  SELECT 'main' AS origin
  UNION ALL
  SELECT 'side' AS origin
) origins
LEFT JOIN messages m
  ON m.contact_id = c.id
 AND m.origin = origins.origin
 AND m.deleted = 0
 AND COALESCE(json_extract(m.meta, '$.uiHidden'), 0) != 1
 AND m.kind IN ('text', 'error')
 AND NOT (m.origin = 'main' AND m.sender = 'user' AND m.role = 'user')
GROUP BY c.id, origins.origin;
