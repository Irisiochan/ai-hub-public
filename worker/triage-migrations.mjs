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

export const TRIAGE_SCHEMA_VERSION = 11;

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
  {
    // 路由初筛影子账本：每条建议一行，(item_path, suggest_date) 幂等，
    // 归宿标签驱动改派率统计（followed/overridden）。
    version: 9,
    name: 'route-suggestions',
    up(db) {
      db.exec(`
        CREATE TABLE route_suggestions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_path TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task', 'inbox')),
          suggest_date TEXT NOT NULL,
          stage TEXT NOT NULL,
          recipient TEXT NOT NULL,
          reason TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'followed', 'overridden', 'closed', 'expired')),
          resolved_recipient TEXT,
          resolved_via TEXT,
          event_id TEXT,
          message_id INTEGER,
          created_at INTEGER NOT NULL,
          resolved_at INTEGER,
          UNIQUE(item_path, suggest_date)
        );
        CREATE INDEX idx_route_suggestions_status
          ON route_suggestions(status, created_at);
      `);
    },
  },
  {
    // 阶段二（自动派单）新增 dispatched/vetoed 两个终态。SQLite 的 CHECK
    // 无法 ALTER，只能整表重建搬数据；表极小，单事务安全。
    version: 10,
    name: 'route-suggestions-auto-dispatch-statuses',
    up(db) {
      db.exec(`
        ALTER TABLE route_suggestions RENAME TO route_suggestions_v9;
        CREATE TABLE route_suggestions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_path TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task', 'inbox')),
          suggest_date TEXT NOT NULL,
          stage TEXT NOT NULL,
          recipient TEXT NOT NULL,
          reason TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'followed', 'overridden', 'closed', 'expired', 'dispatched', 'vetoed')),
          resolved_recipient TEXT,
          resolved_via TEXT,
          event_id TEXT,
          message_id INTEGER,
          created_at INTEGER NOT NULL,
          resolved_at INTEGER,
          UNIQUE(item_path, suggest_date)
        );
        INSERT INTO route_suggestions
          (id, item_path, kind, suggest_date, stage, recipient, reason, status,
           resolved_recipient, resolved_via, event_id, message_id, created_at, resolved_at)
        SELECT id, item_path, kind, suggest_date, stage, recipient, reason, status,
               resolved_recipient, resolved_via, event_id, message_id, created_at, resolved_at
        FROM route_suggestions_v9;
        DROP TABLE route_suggestions_v9;
        CREATE INDEX IF NOT EXISTS idx_route_suggestions_status
          ON route_suggestions(status, created_at);
      `);
    },
  },
  {
    // 裸 PASS 的 route-auto 派单不是完成：新增 passed 状态，并持久化实际
    // host round，供运行时对账与存量 claim 清理。旧行的 round 字段为空，
    // worker 会按稳定 idempotencyKey 从房间消息反查。
    version: 11,
    name: 'route-auto-pass-reconciliation',
    up(db) {
      db.exec(`
        ALTER TABLE route_suggestions RENAME TO route_suggestions_v10;
        CREATE TABLE route_suggestions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_path TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task', 'inbox')),
          suggest_date TEXT NOT NULL,
          stage TEXT NOT NULL,
          recipient TEXT NOT NULL,
          reason TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending', 'followed', 'overridden', 'closed', 'expired', 'dispatched', 'vetoed', 'passed')),
          resolved_recipient TEXT,
          resolved_via TEXT,
          event_id TEXT,
          message_id INTEGER,
          dispatch_message_id INTEGER,
          dispatch_round_id TEXT,
          created_at INTEGER NOT NULL,
          resolved_at INTEGER,
          UNIQUE(item_path, suggest_date)
        );
        INSERT INTO route_suggestions
          (id, item_path, kind, suggest_date, stage, recipient, reason, status,
           resolved_recipient, resolved_via, event_id, message_id, created_at, resolved_at)
        SELECT id, item_path, kind, suggest_date, stage, recipient, reason, status,
               resolved_recipient, resolved_via, event_id, message_id, created_at, resolved_at
        FROM route_suggestions_v10;
        DROP TABLE route_suggestions_v10;
        CREATE INDEX idx_route_suggestions_status
          ON route_suggestions(status, created_at);
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
