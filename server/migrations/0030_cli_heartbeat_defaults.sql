UPDATE contacts
SET config = json_set(config, '$.heartbeat.enabled', json('true'))
WHERE kind = 'dm'
  AND backend IN ('claude-cli', 'codex', 'grok-cli', 'opencode-cli')
  AND json_valid(config);
