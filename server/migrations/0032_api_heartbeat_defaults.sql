UPDATE contacts
SET config = json_set(config, '$.heartbeat.enabled', json('true'))
WHERE kind = 'dm'
  AND backend = 'api'
  AND json_valid(config);
