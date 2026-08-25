-- 跨联系人生活事件（daily check-in P3 S2）。
-- User 在任一 DM 里自述的高时效生活状态，提取成演进式事件（同一件事多次 update），
-- 供其他联系人每轮注入续接。summary 永远是"最新事实一句话"，原文不入表。
CREATE TABLE IF NOT EXISTS life_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  severity          TEXT NOT NULL CHECK (severity IN ('safety','health','schedule','mood')),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','expired')),
  summary           TEXT NOT NULL,
  timeline          TEXT NOT NULL DEFAULT '[]',
  source_contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  last_message_id   INTEGER,
  first_at          TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_life_events_active ON life_events(status, updated_at);

-- 提取调用成本记账（上海日历日），与 caption_usage / contact_affect_score_usage 同模式。
CREATE TABLE IF NOT EXISTS life_event_usage (
  day      TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  cost_cny REAL NOT NULL DEFAULT 0
);
