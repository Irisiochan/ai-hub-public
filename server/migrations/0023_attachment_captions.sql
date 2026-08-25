-- 图片 caption 旁路转写（daily check-in P3 S1）。
-- caption 双写：message_attachments.caption 是权威存储；messages.meta 的 $.captions
-- 是反规范化副本，供只拿得到 meta 的文字化链路（historicalMessageText / journalDay）使用。
ALTER TABLE message_attachments ADD COLUMN caption TEXT;
ALTER TABLE message_attachments ADD COLUMN caption_status TEXT NOT NULL DEFAULT 'none';

-- caption 调用成本记账，按上海日历日；与 contact_affect_score_usage 同模式。
CREATE TABLE IF NOT EXISTS caption_usage (
  day      TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  cost_cny REAL NOT NULL DEFAULT 0
);
