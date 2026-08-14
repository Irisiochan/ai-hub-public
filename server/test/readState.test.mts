import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { loadMigrationFiles } from '../src/migrations.js';
import { getMessageReadState, markMessagesRead } from '../src/readState.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-read-state-'));
const dbPath = path.join(tempDir, 'hub.db');
const here = path.dirname(fileURLToPath(import.meta.url));
const legacy = new Database(dbPath);
for (const migration of loadMigrationFiles(path.resolve(here, '../migrations')).slice(0, 18)) {
  legacy.exec(migration.sql);
}
legacy.pragma('user_version = 18');
legacy.prepare(
  "INSERT INTO contacts (id, name, backend, kind, config) VALUES ('codex', 'Codex', 'api', 'dm', '{}')"
).run();
legacy.prepare(
  "INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin) VALUES ('codex', 'codex', 'assistant', 'text', 'old main', 'done', '{}', 'main')"
).run();
legacy.prepare(
  "INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin) VALUES ('codex', 'system', 'system', 'text', 'old side', 'done', '{}', 'side')"
).run();
legacy.close();

const db = openDb(dbPath);
try {
  assert.equal(db.pragma('user_version', { simple: true }), 22);
  assert.equal(getMessageReadState(db, 'codex').unreadCount, 0, 'upgrade seeds old main history as read');

  const insert = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('codex', ?, ?, ?, ?, 'done', '{}', ?)`
  );
  const manualId = Number(insert.run('user', 'user', 'text', 'User reply', 'main').lastInsertRowid);
  insert.run('codex', 'assistant', 'thinking', 'internal trace', 'main');
  const mainId = Number(insert.run('codex', 'assistant', 'text', 'new answer', 'main').lastInsertRowid);
  insert.run('system', 'system', 'error', 'archived worker event', 'side');

  assert.deepEqual(getMessageReadState(db, 'codex'), {
    origin: 'main',
    lastReadMessageId: 1,
    firstUnreadId: mainId,
    unreadCount: 1,
  });
  assert.equal(markMessagesRead(db, 'codex', mainId).unreadCount, 0);
  assert.equal(
    markMessagesRead(db, 'codex', manualId).lastReadMessageId,
    mainId,
    'read cursors are monotonic'
  );
  assert.equal(getMessageReadState(db, 'codex').unreadCount, 0, 'side audit rows never affect main unread state');
} finally {
  db.close();
}

const reopened = openDb(dbPath);
try {
  assert.equal(reopened.pragma('user_version', { simple: true }), 22, 'migration remains idempotent on reopen');
} finally {
  reopened.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('message read state tests passed');
