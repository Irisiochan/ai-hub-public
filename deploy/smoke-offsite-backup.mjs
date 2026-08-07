import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createBundle, verifyBundle } from './offsite-backup.mjs';

const requireFromServer = createRequire(new URL('../server/package.json', import.meta.url));
const Database = requireFromServer('better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-offsite-smoke-'));
const dbFile = path.join(root, 'hub.db');
const uploads = path.join(root, 'uploads');
const bundle = path.join(root, 'bundle');
fs.mkdirSync(uploads);

let failures = 0;
function check(label, condition, detail = '') {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${condition ? '' : ` ${detail}`}`);
  if (!condition) failures++;
}

try {
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT NOT NULL);
    CREATE TABLE message_attachments (
      id INTEGER PRIMARY KEY,
      message_id INTEGER NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const bytes = Buffer.from('attachment fixture');
  fs.writeFileSync(path.join(uploads, 'fixture.bin'), bytes);
  db.prepare('INSERT INTO messages (id, content) VALUES (1, ?)').run('hello');
  db.prepare(
    `INSERT INTO message_attachments
     (id, message_id, stored_name, original_name, mime_type, size, created_at)
     VALUES (1, 1, 'fixture.bin', 'fixture.bin', 'application/octet-stream', ?, '2026-07-17T00:00:00Z')`
  ).run(bytes.length);
  db.close();

  const manifest = await createBundle({
    dbPath: dbFile,
    uploadsDir: uploads,
    outputDir: bundle,
    sourceCommit: 'smoke',
  });
  check('create includes one message and attachment',
    manifest.database.messageCount === 1 && manifest.database.attachmentCount === 1);

  const verified = verifyBundle(bundle);
  check('verify accepts intact bundle', verified.ok && verified.attachmentCount === 1);

  fs.appendFileSync(path.join(bundle, 'uploads', 'fixture.bin'), 'tampered');
  let tamperFailed = false;
  try {
    verifyBundle(bundle);
  } catch {
    tamperFailed = true;
  }
  check('verify rejects tampered attachment', tamperFailed);

  fs.rmSync(bundle, { recursive: true, force: true });
  fs.rmSync(path.join(uploads, 'fixture.bin'));
  let missingFailed = false;
  try {
    await createBundle({ dbPath: dbFile, uploadsDir: uploads, outputDir: bundle });
  } catch {
    missingFailed = true;
  }
  check('create rejects missing referenced attachment', missingFailed);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nsmoke-offsite-backup: all pass ✅' : `\nsmoke-offsite-backup: ${failures} failure(s) ❌`);
process.exitCode = failures === 0 ? 0 : 1;
