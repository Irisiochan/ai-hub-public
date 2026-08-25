import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3';
import { openDb, type MessageRow } from '../src/db.js';
import { loadMigrationFiles } from '../src/migrations.js';
import { messagesRouter } from '../src/routes/messages.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-message-idempotency-'));
const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(tempDir, 'hub.db');
const uploadsDir = path.join(tempDir, 'uploads');
const db = openDb(dbPath);
const broadcasts: unknown[] = [];
const enqueued: Array<{ userMessageId: number; text: string }> = [];
const sse = {
  broadcast(event: string, data: unknown) {
    if (event === 'message') broadcasts.push(data);
  },
};
const manager = {
  get: () => ({
    enqueue(input: { userMessageId: number; text: string }) {
      enqueued.push(input);
      return input.text === 'force queue full' ? 'full' : 'queued';
    },
  }),
};

const app = express();
app.use(express.json());
app.use('/api/contacts', messagesRouter(db, sse as any, manager as any, uploadsDir));
const listener = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => listener.once('listening', resolve));
const address = listener.address();
assert(address && typeof address === 'object');
const endpoint = `http://127.0.0.1:${address.port}/api/contacts/codex/messages`;

async function postJson(body: Record<string, unknown>): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function imageForm(idempotencyKey: string): FormData {
  const form = new FormData();
  form.set('content', 'multipart image');
  form.set('idempotencyKey', idempotencyKey);
  form.append(
    'images',
    new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }),
    'tiny.png'
  );
  return form;
}

try {
  db.prepare(
    "INSERT INTO contacts (id, name, backend, kind, config) VALUES ('codex', 'Codex', 'api', 'dm', '{}')"
  ).run();

  const first = await postJson({ content: 'one logical send', idempotencyKey: 'client:key:1' });
  assert.equal(first.status, 202);
  const firstBody = await first.json() as { messageId: number; queued: boolean; persisted: boolean };
  assert.equal(firstBody.persisted, true);
  assert.equal(firstBody.queued, true);

  const duplicate = await postJson({ content: 'one logical send', idempotencyKey: 'client:key:1' });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), {
    messageId: firstBody.messageId,
    persisted: true,
    queued: null,
    duplicate: true,
  });

  const full = await postJson({ content: 'force queue full', idempotencyKey: 'client:key:full' });
  assert.equal(full.status, 429);
  const fullBody = await full.json() as {
    messageId: number;
    persisted: boolean;
    queued: boolean;
  };
  assert.equal(fullBody.persisted, true);
  assert.equal(fullBody.queued, false);
  assert.ok(fullBody.messageId > 0, 'queue-full response retains the persisted message id');

  const fullRetry = await postJson({
    content: 'force queue full',
    idempotencyKey: 'client:key:full',
  });
  assert.equal(fullRetry.status, 200);
  assert.equal(
    (await fullRetry.json() as { messageId: number }).messageId,
    fullBody.messageId
  );

  const automation = {
    content: 'triage event',
    automation: {
      messageType: 'background-event',
      eventSource: 'quarter-hour-check',
      eventId: 'event-42',
      eventCategory: 'system',
      eventPriority: 2,
    },
  };
  const automatedFirst = await postJson(automation);
  assert.equal(automatedFirst.status, 202);
  const automatedId = (await automatedFirst.json() as { messageId: number }).messageId;
  const automatedRetry = await postJson(automation);
  assert.equal(automatedRetry.status, 200);
  assert.equal(
    (await automatedRetry.json() as { messageId: number }).messageId,
    automatedId,
    'automation.eventId is a server-side idempotency fallback'
  );

  const formFirst = await fetch(endpoint, { method: 'POST', body: imageForm('client:key:image') });
  assert.equal(formFirst.status, 202);
  const formId = (await formFirst.json() as { messageId: number }).messageId;
  const formRetry = await fetch(endpoint, { method: 'POST', body: imageForm('client:key:image') });
  assert.equal(formRetry.status, 200);
  assert.equal((await formRetry.json() as { messageId: number }).messageId, formId);

  const rows = db.prepare('SELECT * FROM messages ORDER BY id').all() as MessageRow[];
  assert.equal(rows.length, 4, 'JSON, queue-full, automation, and FormData each persist once');
  assert.deepEqual(
    rows.map((row) => row.idempotency_key),
    [
      'client:key:1',
      'client:key:full',
      'automation:quarter-hour-check:event-42',
      'client:key:image',
    ]
  );
  assert.equal(enqueued.length, 4, 'duplicates must not be dispatched to the runtime');
  assert.equal(broadcasts.length, 4, 'duplicates must not be broadcast over SSE');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM message_attachments WHERE message_id = ?')
      .get(formId)!.count,
    1,
    'a repeated multipart request must not persist another attachment'
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => error ? reject(error) : resolve())
  );
  db.close();
}

const upgradePath = path.join(tempDir, 'upgrade.db');
const legacy = new Database(upgradePath);
for (const migration of loadMigrationFiles(path.resolve(here, '../migrations')).slice(0, 15)) {
  legacy.exec(migration.sql);
}
legacy.pragma('user_version = 15');
legacy.prepare(
  "INSERT INTO contacts (id, name, backend, kind, config) VALUES ('legacy', 'Legacy', 'api', 'dm', '{}')"
).run();
legacy.prepare("INSERT INTO memory_outbox (tool, args) VALUES ('write_memory', '{}')").run();
legacy.close();

const upgraded = openDb(upgradePath);
try {
  assert.equal(upgraded.pragma('user_version', { simple: true }), 27);
  const messageColumns = upgraded.pragma('table_info(messages)') as Array<{ name: string }>;
  assert.ok(messageColumns.some((column) => column.name === 'idempotency_key'));
  const outbox = upgraded.prepare('SELECT * FROM memory_outbox').get() as {
    status: string;
    next_attempt_at: number;
    dead_at: string | null;
  };
  assert.deepEqual(
    { status: outbox.status, nextAttemptAt: outbox.next_attempt_at, deadAt: outbox.dead_at },
    { status: 'pending', nextAttemptAt: 0, deadAt: null }
  );
  const writebackColumns = upgraded.pragma('table_info(task_writebacks)') as Array<{ name: string }>;
  assert.ok(writebackColumns.some((column) => column.name === 'idempotency_key'));
  assert.ok(writebackColumns.some((column) => column.name === 'command_id'));
  assert.ok(writebackColumns.some((column) => column.name === 'event_id'));
  upgraded.prepare(
    `INSERT INTO messages (
       contact_id, sender, role, kind, content, status, meta, origin, idempotency_key
     ) VALUES ('legacy', 'user', 'user', 'text', 'first', 'done', '{}', 'main', 'same-key')`
  ).run();
  assert.throws(
    () => upgraded.prepare(
      `INSERT INTO messages (
         contact_id, sender, role, kind, content, status, meta, origin, idempotency_key
       ) VALUES ('legacy', 'user', 'user', 'text', 'second', 'done', '{}', 'main', 'same-key')`
    ).run(),
    /UNIQUE constraint failed/
  );
} finally {
  upgraded.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('message idempotency and migration smoke passed');
