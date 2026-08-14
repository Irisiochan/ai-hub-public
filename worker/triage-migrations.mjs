/**
 * TriageStore 的版本化 schema 迁移。
 *
 * 历史形态是构造器里 CREATE + PRAGMA table_info + ALTER 混写、没有版本号；
 * commit 98d8600 真实修过一次「先建 pool 索引、后补 pool 列」导致旧生产 DB
 * 启动失败。现在收敛为 user_version 驱动的顺序迁移：
 * - 每个迁移单事务（BEGIN IMMEDIATE … COMMIT），失败整体回滚，
 *   user_version 不前进 —— 不存在半迁移状态；
 * - 存量生产 DB user_version=0 且表已存在：v1 的 CREATE IF NOT EXISTS 原样
 *   跳过，v2+ 的列迁移带存在性守卫，把任意历史变体收敛到最新；这层守卫
 *   只为吸收「无版本号时代」的漂移，v9 起新迁移不再需要守卫；
 * - 重复启动幂等：user_version 已达标的迁移直接跳过。
 */

export const TRIAGE_SCHEMA_VERSION = 8;

function userVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .some((row) => row.name === column);
}

function addColumnIfMissing(db, table, column, definition) {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export const TRIAGE_MIGRATIONS = [
  {
    version: 1,
    name: 'base-schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS triage_events (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          summary TEXT NOT NULL,
          payload TEXT,
          category_hint TEXT,
          status TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          triage_result TEXT,
          recipient_id TEXT,
          error TEXT,
          cost_cny REAL NOT NULL DEFAULT 0,
          triage_latency_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_triage_events_claim
          ON triage_events(status, next_attempt_at, created_at);
        CREATE TABLE IF NOT EXISTS triage_deliveries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL,
          recipient_id TEXT NOT NULL,
          delivered_at INTEGER NOT NULL,
          pool TEXT NOT NULL DEFAULT 'task',
          message_id INTEGER,
          executed_via TEXT NOT NULL DEFAULT 'none'
            CHECK(executed_via IN ('contact', 'worker', 'none')),
          FOREIGN KEY(event_id) REFERENCES triage_events(id)
        );
        CREATE INDEX IF NOT EXISTS idx_triage_deliveries_recipient
          ON triage_deliveries(recipient_id, delivered_at);
        CREATE TABLE IF NOT EXISTS triage_source_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS triage_vault_outbox (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          event_id TEXT NOT NULL,
          dedupe_key TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER,
          error TEXT,
          FOREIGN KEY(event_id) REFERENCES triage_events(id)
        );
        CREATE INDEX IF NOT EXISTS idx_triage_vault_outbox_claim
          ON triage_vault_outbox(status, next_attempt_at, created_at);
        CREATE TABLE IF NOT EXISTS triage_outcomes (
          delivery_id INTEGER PRIMARY KEY,
          event_id TEXT NOT NULL,
          label TEXT NOT NULL CHECK(label IN ('unknown', 'engaged', 'accepted', 'reworked', 'rejected')),
          evidence TEXT NOT NULL DEFAULT '{}',
          labeled_at INTEGER NOT NULL,
          FOREIGN KEY(delivery_id) REFERENCES triage_deliveries(id),
          FOREIGN KEY(event_id) REFERENCES triage_events(id)
        );
        CREATE INDEX IF NOT EXISTS idx_triage_outcomes_label
          ON triage_outcomes(label, labeled_at);
        CREATE TABLE IF NOT EXISTS triage_followups (
          id TEXT PRIMARY KEY,
          contact_id TEXT NOT NULL,
          message_id INTEGER NOT NULL,
          activity TEXT NOT NULL,
          return_commitment TEXT,
          expected_minutes INTEGER NOT NULL,
          due_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'queued', 'dispatched', 'cancelled', 'expired')),
          recipient_key TEXT,
          event_id TEXT,
          cancel_reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          fallback_reminded_at INTEGER,
          UNIQUE(contact_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_triage_followups_due
          ON triage_followups(status, due_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_triage_followups_contact
          ON triage_followups(contact_id, status, created_at);
      `);
    },
  },
  {
    version: 2,
    name: 'events-triage-latency',
    up(db) {
      addColumnIfMissing(db, 'triage_events', 'triage_latency_ms', 'INTEGER');
    },
  },
  {
    version: 3,
    name: 'deliveries-pool',
    up(db) {
      addColumnIfMissing(db, 'triage_deliveries', 'pool', `TEXT NOT NULL DEFAULT 'task'`);
    },
  },
  {
    version: 4,
    name: 'deliveries-message-id',
    up(db) {
      addColumnIfMissing(db, 'triage_deliveries', 'message_id', 'INTEGER');
    },
  },
  {
    version: 5,
    name: 'deliveries-executed-via',
    up(db) {
      addColumnIfMissing(db, 'triage_deliveries', 'executed_via', `TEXT NOT NULL DEFAULT 'none'`);
    },
  },
  {
    version: 6,
    name: 'followups-return-commitment',
    up(db) {
      addColumnIfMissing(db, 'triage_followups', 'return_commitment', 'TEXT');
    },
  },
  {
    version: 7,
    name: 'followups-fallback-reminded-at',
    up(db) {
      addColumnIfMissing(db, 'triage_followups', 'fallback_reminded_at', 'INTEGER');
    },
  },
  {
    // pool 索引必须晚于 pool 列（commit 98d8600 的启动失败教训）。
    version: 8,
    name: 'delivery-pool-and-message-indexes',
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_triage_deliveries_pool
          ON triage_deliveries(pool, delivered_at);
        CREATE INDEX IF NOT EXISTS idx_triage_deliveries_message
          ON triage_deliveries(message_id)
      `);
    },
  },
];

export function migrateTriageDb(db, migrations = TRIAGE_MIGRATIONS) {
  const startVersion = userVersion(db);
  if (startVersion > TRIAGE_SCHEMA_VERSION) {
    throw new Error(
      `triage db schema version ${startVersion} is newer than this worker supports (${TRIAGE_SCHEMA_VERSION}); refusing to run against a downgraded binary`,
    );
  }
  for (const migration of migrations) {
    if (userVersion(db) >= migration.version) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `triage migration v${migration.version} (${migration.name}) failed and was rolled back: ${error.message}`,
      );
    }
  }
  return { from: startVersion, to: userVersion(db) };
}
