-- 个人账本：官方导出导入 + 去重/还款 + 月结。没有聊天手记入口。
CREATE TABLE IF NOT EXISTS ledger_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('alipay', 'wechat', 'cmb-cc')),
  original_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  transfer_count INTEGER NOT NULL DEFAULT 0,
  ignored_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_imports_sha ON ledger_imports(file_sha256);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES ledger_imports(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer', 'ignored')),
  category TEXT NOT NULL DEFAULT '',
  payee TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('alipay', 'wechat', 'cmb-cc')),
  method TEXT NOT NULL DEFAULT '',
  status_text TEXT NOT NULL DEFAULT '',
  source_txn_id TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  duplicate_of INTEGER REFERENCES ledger_transactions(id),
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_txn_fingerprint ON ledger_transactions(source, fingerprint);
CREATE INDEX IF NOT EXISTS idx_ledger_txn_occurred ON ledger_transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_ledger_txn_kind ON ledger_transactions(kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ledger_txn_dup ON ledger_transactions(duplicate_of);

CREATE TABLE IF NOT EXISTS ledger_monthly_summaries (
  year_month TEXT PRIMARY KEY,
  stats_json TEXT NOT NULL,
  advice TEXT,
  generated_at TEXT NOT NULL,
  model TEXT
);

CREATE TABLE IF NOT EXISTS ledger_summary_usage (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  cost_cny REAL NOT NULL DEFAULT 0
);
