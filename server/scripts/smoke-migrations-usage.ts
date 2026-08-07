import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { UsageRepo } from '../dist/agents/usageRepo.js';
import { openDb } from '../dist/db.js';
import { loadMigrationFiles } from '../dist/migrations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const freshPath = path.join(here, '.migrations-fresh.db');
const upgradePath = path.join(here, '.migrations-upgrade.db');
for (const file of [freshPath, upgradePath]) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
}

const migrations = loadMigrationFiles();
assert.equal(migrations.length, 15);
assert.equal(migrations[0].name, '0001_init.sql');
assert.equal(migrations.at(-1)?.name, '0015_message_origin.sql');

function addContact(db: Database.Database, id: string): void {
  db.prepare('INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, ?, ?)')
    .run(id, id, 'api', 'dm', '{}');
}

function addUsage(db: Database.Database, contactId: string, usage: Record<string, number>): number {
  const result = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta)
     VALUES (?, ?, 'assistant', 'text', 'ok', 'done', ?)`
  ).run(contactId, contactId, JSON.stringify({ usage }));
  return Number(result.lastInsertRowid);
}

let db = openDb(freshPath);
try {
  assert.equal(db.pragma('user_version', { simple: true }), 15);
  addContact(db, 'fresh');
  const first = addUsage(db, 'fresh', { input: 10, output: 2, cacheCreation: 3, cacheRead: 4 });
  const repo = new UsageRepo(db);
  assert.deepEqual(repo.summary('fresh').total, { input: 10, output: 2, cacheCreation: 3, cacheRead: 4 });
  assert.equal(
    (db.prepare('SELECT origin FROM messages WHERE id = ?').get(first) as { origin: string }).origin,
    'main', 'new rows that omit origin must remain compatible with the main window'
  );

  db.prepare('UPDATE messages SET meta = ? WHERE id = ?')
    .run(JSON.stringify({ usage: { input: 20, output: 5, cacheCreation: 0, cacheRead: 8 } }), first);
  assert.deepEqual(repo.summary('fresh').total, { input: 20, output: 5, cacheCreation: 0, cacheRead: 8 });

  const second = addUsage(db, 'fresh', { input: 7, output: 1, cacheCreation: 2, cacheRead: 0 });
  assert.deepEqual(repo.summary('fresh').total, { input: 27, output: 6, cacheCreation: 2, cacheRead: 8 });
  assert.deepEqual(repo.summary('fresh').last, { input: 7, output: 1, cacheCreation: 2, cacheRead: 0 });

  db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(second);
  assert.deepEqual(repo.summary('fresh').total, { input: 20, output: 5, cacheCreation: 0, cacheRead: 8 });
  db.prepare('DELETE FROM messages WHERE id = ?').run(first);
  assert.deepEqual(repo.summary('fresh').total, { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
} finally {
  db.close();
}

const legacy = new Database(upgradePath);
legacy.pragma('foreign_keys = ON');
for (const migration of migrations.slice(0, 13)) {
  legacy.exec(migration.sql);
  legacy.pragma(`user_version = ${migration.version}`);
}
addContact(legacy, 'upgrade');
addUsage(legacy, 'upgrade', { input: 33, output: 9, cacheCreation: 4, cacheRead: 12 });
legacy.close();

db = openDb(upgradePath);
try {
  assert.equal(db.pragma('user_version', { simple: true }), 15);
  assert.deepEqual(new UsageRepo(db).summary('upgrade').total,
    { input: 33, output: 9, cacheCreation: 4, cacheRead: 12 },
    '0014 must backfill existing usage rows');
  assert.deepEqual(
    db.prepare("SELECT DISTINCT origin FROM messages WHERE contact_id = 'upgrade'").all(),
    [{ origin: 'main' }],
    '0015 must leave every historical row in main without heuristic backfill'
  );
} finally {
  db.close();
  for (const file of [freshPath, upgradePath]) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  }
}

console.log('migrations usage smoke: ok');
