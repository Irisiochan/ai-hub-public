-- The old UI/schema persisted 4096 on every API contact, so changing only the
-- runtime fallback would leave existing residents silently truncated.
UPDATE contacts
SET config = json_set(config, '$.maxTokens', 8192)
WHERE backend = 'api'
  AND (
    json_extract(config, '$.maxTokens') IS NULL
    OR CAST(json_extract(config, '$.maxTokens') AS INTEGER) = 4096
  );
