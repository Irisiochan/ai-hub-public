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
  assert.equal(db.pragma('user_version', { simple: true }), 21);
  assert.equal(getMessageReadState(db, 'codex', 'main').unreadCount, 0, 'upgrade seeds old main history as read');
  assert.equal(getMessageReadState(db, 'codex', 'side').unreadCount, 0, 'upgrade seeds old side history as read');

  const insert = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('codex', ?, ?, ?, ?, 'done', '{}', ?)`
  );
  const manualId = Number(insert.run('user', 'user', 'text', 'User reply', 'main').lastInsertRowid);
  insert.run('codex', 'assistant', 'thinking', 'internal trace', 'main');
  const mainId = Number(insert.run('codex', 'assistant', 'text', 'new answer', 'main').lastInsertRowid);
  const sideId = Number(insert.run('system', 'system', 'error', 'worker failed', 'side').lastInsertRowid);

  assert.deepEqual(getMessageReadState(db, 'codex', 'main'), {
    origin: 'main',
    lastReadMessageId: 1,
    firstUnreadId: mainId,
    unreadCount: 1,
  });
  assert.deepEqual(getMessageReadState(db, 'codex', 'side'), {
    origin: 'side',
    lastReadMessageId: 2,
    firstUnreadId: sideId,
    unreadCount: 1,
  });

  assert.equal(markMessagesRead(db, 'codex', 'main', mainId).unreadCount, 0);
  assert.equal(
    markMessagesRead(db, 'codex', 'main', manualId).lastReadMessageId,
    mainId,
    'read cursors are monotonic'
  );
  assert.equal(getMessageReadState(db, 'codex', 'side').unreadCount, 1, 'main and side cursors are isolated');

  db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(sideId);
  assert.equal(getMessageReadState(db, 'codex', 'side').firstUnreadId, null, 'deleting the first unread advances the anchor');
} finally {
  db.close();
}

const reopened = openDb(dbPath);
try {
  assert.equal(reopened.pragma('user_version', { simple: true }), 21, 'migration remains idempotent on reopen');
} finally {
  reopened.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('message read state tests passed');
