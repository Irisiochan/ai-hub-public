  UPDATE contacts
     SET config = json_set(
       config,
       '$.baseUrl',
       rtrim(json_extract(config, '$.baseUrl'), '/') ||
         CASE
           WHEN json_extract(config, '$.provider') = 'anthropic' THEN '/v1/messages'
           ELSE '/v1/chat/completions'
         END
     )
   WHERE backend = 'api'
     AND json_valid(config)
     AND typeof(json_extract(config, '$.baseUrl')) = 'text'
     AND trim(json_extract(config, '$.baseUrl')) <> ''
     AND rtrim(json_extract(config, '$.baseUrl'), '/') NOT LIKE '%/messages'
     AND rtrim(json_extract(config, '$.baseUrl'), '/') NOT LIKE '%/chat/completions';
