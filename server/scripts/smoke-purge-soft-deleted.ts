/**
 * Smoke: hard-delete internal retract + retention purge for soft-deleted rows.
 *   npx tsx scripts/smoke-purge-soft-deleted.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hardDeleteMessages } from '../src/attachments.js';
import { openDb } from '../src/db.js';
import { SoftDeletePurge } from '../src/purge.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-purge-'));
const dbPath = path.join(dir, 'test.db');
const uploads = path.join(dir, 'uploads');
fs.mkdirSync(uploads);
const db = openDb(dbPath);

db.prepare(
  `INSERT INTO contacts (id, name, backend, kind, config) VALUES ('c1', 'T', 'api', 'dm', '{}')`
).run();

const insertMsg = db.prepare(
  `INSERT INTO messages (contact_id, sender, role, kind, content, status, deleted, created_at)
   VALUES ('c1', 'user', 'user', 'text', ?, 'done', ?, ?)`
);

// 旧软删 → 应被 purge
insertMsg.run('old soft', 1, "datetime('now', '-20 days')");
// SQLite bind won't evaluate datetime() as SQL — use literal timestamps
db.prepare('DELETE FROM messages').run();

const oldTs = new Date(Date.now() - 20 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
const midTs = new Date(Date.now() - 5 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
const nowTs = new Date().toISOString().replace('T', ' ').slice(0, 19);

const ins = db.prepare(
  `INSERT INTO messages (contact_id, sender, role, kind, content, status, deleted, created_at)
   VALUES ('c1', ?, ?, 'text', ?, 'done', ?, ?)`
);
ins.run('user', 'user', 'old soft deleted', 1, oldTs);
ins.run('user', 'user', 'recent soft deleted', 1, midTs);
ins.run('user', 'user', 'live message', 0, nowTs);
const bubble = ins.run('agent', 'assistant', 'pass bubble', 0, nowTs);

// job: old hidden done → purge; recent hidden → keep; active hidden → keep
db.prepare(
  `INSERT INTO jobs (id, requested_by, runner, workspace, prompt, status, priority, idempotency_key, permissions, deleted, created_at, updated_at)
   VALUES (?, 'iris', 'claude', ?, 'p', ?, 0, ?, '{}', 1, ?, ?)`
).run('job-old', dir, 'done', 'idem-old', oldTs, oldTs);
db.prepare(
  `INSERT INTO jobs (id, requested_by, runner, workspace, prompt, status, priority, idempotency_key, permissions, deleted, created_at, updated_at)
   VALUES (?, 'iris', 'claude', ?, 'p', ?, 0, ?, '{}', 1, ?, ?)`
).run('job-recent', dir, 'done', 'idem-recent', midTs, midTs);
db.prepare(
  `INSERT INTO jobs (id, requested_by, runner, workspace, prompt, status, priority, idempotency_key, permissions, deleted, created_at, updated_at)
   VALUES (?, 'iris', 'claude', ?, 'p', ?, 0, ?, '{}', 1, ?, ?)`
).run('job-running', dir, 'running', 'idem-run', oldTs, oldTs);

// --- hard delete internal bubble ---
const bubbleId = Number(bubble.lastInsertRowid);
const n = hardDeleteMessages(db, uploads, [bubbleId]);
assert.equal(n, 1);
assert.equal(
  (db.prepare('SELECT COUNT(*) AS c FROM messages WHERE id = ?').get(bubbleId) as { c: number }).c,
  0,
  'bubble row gone'
);

// --- purge dry-run then apply ---
const purge = new SoftDeletePurge(
  db,
  uploads,
  {
    enabled: true,
    messagesRetentionDays: 14,
    jobsRetentionDays: 30,
    intervalHours: 24,
    batchSize: 100,
  },
  () => {}
);

// midTs 5d < 14 → 保留；old 20d → purge；job 保留期测 14d 才能覆盖 20d 旧 job
const purgeJobs = new SoftDeletePurge(
  db,
  uploads,
  {
    enabled: true,
    messagesRetentionDays: 14,
    jobsRetentionDays: 14,
    intervalHours: 24,
    batchSize: 100,
  },
  () => {}
);

const dry = await purgeJobs.runOnce({ dryRun: true });
assert.equal(dry.messagesDeleted, 1, 'dry-run counts 1 old soft message');
assert.equal(dry.jobsDeleted, 1, 'dry-run counts 1 old hidden terminal job (not running)');
assert.equal(dry.dryRun, true);

const applied = await purgeJobs.runOnce({ dryRun: false });
assert.equal(applied.messagesDeleted, 1);
assert.equal(applied.jobsDeleted, 1);

assert.equal(
  (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE content = 'old soft deleted'`).get() as { c: number }).c,
  0
);
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE content = 'recent soft deleted'`).get() as { c: number }).c,
  1,
  'recent soft-deleted kept'
);
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE content = 'live message'`).get() as { c: number }).c,
  1
);
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE id = 'job-old'`).get() as { c: number }).c,
  0
);
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE id = 'job-recent'`).get() as { c: number }).c,
  1
);
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE id = 'job-running'`).get() as { c: number }).c,
  1,
  'force-hidden running job not purged'
);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('purge soft-deleted smoke: ok');
void purge;
