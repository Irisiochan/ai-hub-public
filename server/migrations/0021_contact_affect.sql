CREATE TABLE contact_affect (
  contact_id  TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  valence     REAL NOT NULL,
  arousal     REAL NOT NULL,
  updated_at  TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE contact_affect_score_usage (
  day       TEXT PRIMARY KEY,
  requests  INTEGER NOT NULL DEFAULT 0,
  cost_cny  REAL NOT NULL DEFAULT 0
);

-- M1 is default-off. The one production canary is Claude; later contacts must
-- be enabled deliberately through their own config.
UPDATE contacts
SET config = json_set(config, '$.affect', 'on')
WHERE id = 'claude';
