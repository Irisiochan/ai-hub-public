CREATE TABLE message_usage (
  message_id     INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  contact_id     TEXT NOT NULL REFERENCES contacts(id),
  day            TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_message_usage_contact_day ON message_usage(contact_id, day);
CREATE INDEX idx_message_usage_contact_message ON message_usage(contact_id, message_id DESC);

CREATE TABLE usage_daily (
  contact_id     TEXT NOT NULL REFERENCES contacts(id),
  day            TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (contact_id, day)
);

INSERT INTO message_usage
  (message_id, contact_id, day, occurred_at, input_tokens, output_tokens, cache_creation, cache_read)
SELECT
  id,
  contact_id,
  date(created_at, '+8 hours'),
  created_at,
  CAST(COALESCE(json_extract(meta, '$.usage.input'), 0) AS INTEGER),
  CAST(COALESCE(json_extract(meta, '$.usage.output'), 0) AS INTEGER),
  CAST(COALESCE(json_extract(meta, '$.usage.cacheCreation'), 0) AS INTEGER),
  CAST(COALESCE(json_extract(meta, '$.usage.cacheRead'), 0) AS INTEGER)
FROM messages
WHERE deleted = 0
  AND role = 'assistant'
  AND json_valid(meta)
  AND json_type(meta, '$.usage') = 'object';

INSERT INTO usage_daily
  (contact_id, day, input_tokens, output_tokens, cache_creation, cache_read)
SELECT contact_id, day, SUM(input_tokens), SUM(output_tokens), SUM(cache_creation), SUM(cache_read)
FROM message_usage
GROUP BY contact_id, day;

CREATE TRIGGER messages_usage_after_insert
AFTER INSERT ON messages
WHEN NEW.deleted = 0
  AND NEW.role = 'assistant'
  AND json_valid(NEW.meta)
  AND json_type(NEW.meta, '$.usage') = 'object'
BEGIN
  INSERT INTO message_usage
    (message_id, contact_id, day, occurred_at, input_tokens, output_tokens, cache_creation, cache_read)
  VALUES (
    NEW.id, NEW.contact_id, date(NEW.created_at, '+8 hours'), NEW.created_at,
    CAST(COALESCE(json_extract(NEW.meta, '$.usage.input'), 0) AS INTEGER),
    CAST(COALESCE(json_extract(NEW.meta, '$.usage.output'), 0) AS INTEGER),
    CAST(COALESCE(json_extract(NEW.meta, '$.usage.cacheCreation'), 0) AS INTEGER),
    CAST(COALESCE(json_extract(NEW.meta, '$.usage.cacheRead'), 0) AS INTEGER)
  );
  INSERT INTO usage_daily
    (contact_id, day, input_tokens, output_tokens, cache_creation, cache_read)
  VALUES (
    NEW.contact_id, date(NEW.created_at, '+8 hours'),
    CAST(COALESCE(json_extract(NEW.meta, '$.usage.input'), 0) AS INTEGER),
    CAST(COALESCE(json_extract(NEW.meta, '$.usage.output'), 0) AS INTEGER),
    CAST(COALESCE(json_extract(NEW.meta, '$.usage.cacheCreation'), 0) AS INTEGER),
    CAST(COALESCE(json_extract(NEW.meta, '$.usage.cacheRead'), 0) AS INTEGER)
  )
  ON CONFLICT(contact_id, day) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_creation = cache_creation + excluded.cache_creation,
    cache_read = cache_read + excluded.cache_read;
END;

CREATE TRIGGER messages_usage_before_update
BEFORE UPDATE OF meta, status, deleted ON messages
WHEN EXISTS (SELECT 1 FROM message_usage WHERE message_id = OLD.id)
BEGIN
  UPDATE usage_daily SET
    input_tokens = input_tokens - (SELECT input_tokens FROM message_usage WHERE message_id = OLD.id),
    output_tokens = output_tokens - (SELECT output_tokens FROM message_usage WHERE message_id = OLD.id),
    cache_creation = cache_creation - (SELECT cache_creation FROM message_usage WHERE message_id = OLD.id),
    cache_read = cache_read - (SELECT cache_read FROM message_usage WHERE message_id = OLD.id)
  WHERE contact_id = OLD.contact_id
    AND day = (SELECT day FROM message_usage WHERE message_id = OLD.id);
  DELETE FROM message_usage WHERE message_id = OLD.id;
  DELETE FROM usage_daily
   WHERE contact_id = OLD.contact_id
     AND input_tokens = 0 AND output_tokens = 0 AND cache_creation = 0 AND cache_read = 0;
END;

CREATE TRIGGER messages_usage_after_update
AFTER UPDATE OF meta, status, deleted ON messages
WHEN NEW.deleted = 0
  AND NEW.role = 'assistant'
  AND json_valid(NEW.meta)
  AND json_type(NEW.meta, '$.usage') = 'object'
BEGIN
  INSERT INTO message_usage
    (message_id, contact_id, day, occurred_at, input_tokens, output_tokens, cache_creation, cache_read)
  VALUES (
    NEW.id, NEW.contact_id, date(NEW.created_at, '+8 hours'), NEW.created_at,
    CAST(COALESCE(json_extract(NEW.meta, '$.usage.input'), 0) AS INTEGER),
    CAST(COALESCE(json_extract(NEW.meta, '$.usage.output'), 0) AS INTEGER),
    CAST(COALESCE(json_extract(NEW.meta, '$.usage.cacheCreation'), 0) AS INTEGER),
    CAST(COALESCE(json_extract(NEW.meta, '$.usage.cacheRead'), 0) AS INTEGER)
  );
  INSERT INTO usage_daily
    (contact_id, day, input_tokens, output_tokens, cache_creation, cache_read)
  SELECT contact_id, day, input_tokens, output_tokens, cache_creation, cache_read
  FROM message_usage WHERE message_id = NEW.id
  ON CONFLICT(contact_id, day) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_creation = cache_creation + excluded.cache_creation,
    cache_read = cache_read + excluded.cache_read;
END;

CREATE TRIGGER messages_usage_before_delete
BEFORE DELETE ON messages
WHEN EXISTS (SELECT 1 FROM message_usage WHERE message_id = OLD.id)
BEGIN
  UPDATE usage_daily SET
    input_tokens = input_tokens - (SELECT input_tokens FROM message_usage WHERE message_id = OLD.id),
    output_tokens = output_tokens - (SELECT output_tokens FROM message_usage WHERE message_id = OLD.id),
    cache_creation = cache_creation - (SELECT cache_creation FROM message_usage WHERE message_id = OLD.id),
    cache_read = cache_read - (SELECT cache_read FROM message_usage WHERE message_id = OLD.id)
  WHERE contact_id = OLD.contact_id
    AND day = (SELECT day FROM message_usage WHERE message_id = OLD.id);
  DELETE FROM message_usage WHERE message_id = OLD.id;
  DELETE FROM usage_daily
   WHERE contact_id = OLD.contact_id
     AND input_tokens = 0 AND output_tokens = 0 AND cache_creation = 0 AND cache_read = 0;
END;
