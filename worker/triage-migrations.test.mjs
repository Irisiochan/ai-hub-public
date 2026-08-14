import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  migrateTriageDb,
  TRIAGE_MIGRATIONS,
  TRIAGE_SCHEMA_VERSION,
} from './triage-migrations.mjs';
import { DELIVERY_POOL_COORDINATION, EXECUTED_VIA_CONTACT, TriageStore } from './triage-core.mjs';

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function indexes(db, table) {
  return db.prepare(`PRAGMA index_list(${table})`).all().map((row) => row.name);
}

function userVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version);
}

/** 生产最老形态（98d8600 之前）：deliveries 无 pool/message_id/executed_via，
 *  events 无 triage_latency_ms，followups 无新列。user_version=0。 */
function writeOldestFixture(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE triage_events (
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
      cost_cny REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE triage_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      delivered_at INTEGER NOT NULL,
      FOREIGN KEY(event_id) REFERENCES triage_events(id)
    );
    CREATE TABLE triage_source_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE triage_followups (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      activity TEXT NOT NULL,
      expected_minutes INTEGER NOT NULL,
      due_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      recipient_key TEXT,
      event_id TEXT,
      cancel_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(contact_id, message_id)
    );
    INSERT INTO triage_events (id, source, summary, created_at, updated_at)
    VALUES ('legacy-event', 'legacy', 'kept across migration', 1000, 1000);
    INSERT INTO triage_deliveries (event_id, recipient_id, delivered_at)
    VALUES ('legacy-event', 'codex', 2000);
    INSERT INTO triage_source_state (key, value, updated_at)
    VALUES ('coordination:v1', '{"tasks/legacy.md":"hash"}', 3000);
  `);
  db.close();
}

/** 中间形态：已有 pool 列（98d8600 修复后）但没有 message_id/executed_via。 */
function writeMidFixture(file) {
  writeOldestFixture(file);
  const db = new DatabaseSync(file);
  db.exec(`
    ALTER TABLE triage_events ADD COLUMN triage_latency_ms INTEGER;
    ALTER TABLE triage_deliveries ADD COLUMN pool TEXT NOT NULL DEFAULT 'task';
  `);
  db.close();
}

test('fresh db and every historical fixture upgrade to the latest schema', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-migrations-'));
  try {
    const fixtures = [
      { name: 'fresh', prepare: () => {} },
      { name: 'oldest', prepare: writeOldestFixture },
      { name: 'mid', prepare: writeMidFixture },
    ];
    for (const fixture of fixtures) {
      const file = path.join(dir, `${fixture.name}.db`);
      fixture.prepare(file);
      const db = new DatabaseSync(file);
      const outcome = migrateTriageDb(db);
      assert.equal(outcome.to, TRIAGE_SCHEMA_VERSION, `${fixture.name} 必须升到最新`);
      assert.equal(userVersion(db), TRIAGE_SCHEMA_VERSION);
      assert.ok(columns(db, 'triage_events').includes('triage_latency_ms'), fixture.name);
      for (const column of ['pool', 'message_id', 'executed_via']) {
        assert.ok(columns(db, 'triage_deliveries').includes(column), `${fixture.name}: deliveries.${column}`);
      }
      for (const column of ['return_commitment', 'fallback_reminded_at']) {
        assert.ok(columns(db, 'triage_followups').includes(column), `${fixture.name}: followups.${column}`);
      }
      assert.ok(indexes(db, 'triage_deliveries').includes('idx_triage_deliveries_pool'), fixture.name);
      // 幂等：重复迁移是 no-op
      const again = migrateTriageDb(db);
      assert.deepEqual(again, { from: TRIAGE_SCHEMA_VERSION, to: TRIAGE_SCHEMA_VERSION });
      db.close();

      // 迁移后的 DB 能被 TriageStore 正常打开并完整走一遍写路径
      const store = new TriageStore(file);
      try {
        if (fixture.name !== 'fresh') {
          assert.equal(
            store.getSourceState('coordination:v1'),
            '{"tasks/legacy.md":"hash"}',
            '存量数据必须原样保留',
          );
          assert.equal(
            store.db.prepare("SELECT COUNT(*) AS c FROM triage_deliveries WHERE event_id = 'legacy-event'").get().c,
            1,
          );
        }
        const event = store.enqueue({ source: 'migration-smoke', summary: 'post-upgrade write path' });
        store.settleCoordinationDispatch(event.id, {
          recipientId: 'room',
          pool: DELIVERY_POOL_COORDINATION,
          messageId: 42,
          executedVia: EXECUTED_VIA_CONTACT,
          taskPath: 'tasks/smoke.md',
          sourceStates: [{ key: 'migration-smoke', value: 'ok' }],
          triageResult: {
            actionable: true,
            needsLocalExec: false,
            category: 'coordination',
            priority: 1,
            suggestedRecipient: null,
            rationale: 'migration smoke',
          },
          finishRecipientId: 'codex',
        });
        assert.equal(store.poolUsage(DELIVERY_POOL_COORDINATION).count, 1, fixture.name);
      } finally {
        store.close();
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing migration rolls back atomically and leaves no half-migrated state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-migrations-fault-'));
  try {
    const file = path.join(dir, 'fault.db');
    writeOldestFixture(file);
    const db = new DatabaseSync(file);
    // 故障注入：v3（pool 列）执行到一半抛错
    const sabotaged = TRIAGE_MIGRATIONS.map((migration) => migration.version === 3
      ? {
        ...migration,
        up(target) {
          migration.up(target);
          target.exec(`
            CREATE TABLE half_migrated_marker (id INTEGER PRIMARY KEY);
          `);
          throw new Error('injected crash inside migration v3');
        },
      }
      : migration);
    assert.throws(() => migrateTriageDb(db, sabotaged), /v3 .*rolled back.*injected crash/);
    // v1、v2 已提交；v3 整体回滚：既没有 pool 列，也没有半截 marker 表
    assert.equal(userVersion(db), 2, '失败迁移不得推进版本号');
    assert.equal(columns(db, 'triage_deliveries').includes('pool'), false);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'half_migrated_marker'").get().c,
      0,
      '事务内的中间产物必须随回滚消失',
    );
    // 修好后重启：从 v2 继续升到最新
    const resumed = migrateTriageDb(db);
    assert.deepEqual(resumed, { from: 2, to: TRIAGE_SCHEMA_VERSION });
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a db from a newer worker is refused instead of silently downgraded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-migrations-newer-'));
  try {
    const file = path.join(dir, 'newer.db');
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${TRIAGE_SCHEMA_VERSION + 1}`);
    assert.throws(() => migrateTriageDb(db), /newer than this worker supports/);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
