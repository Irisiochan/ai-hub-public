import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb, type MessageRow } from '../src/db.js';
import { messagesRouter } from '../src/routes/messages.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-message-delete-'));
const db = openDb(path.join(tempDir, 'hub.db'));
const uploadsDir = path.join(tempDir, 'uploads');
const broadcasts: Array<{ event: string; data: any }> = [];
const invalidations: number[] = [];
const sse = {
  broadcast(event: string, data: unknown) {
    broadcasts.push({ event, data });
  },
};
const manager = {
  invalidateConversation(_contact: unknown, affectedFromId: number) {
    invalidations.push(affectedFromId);
    return Promise.resolve();
  },
};

const app = express();
app.use(express.json());
app.use('/api/contacts', messagesRouter(db, sse as any, manager as any, uploadsDir));
const listener = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => listener.once('listening', resolve));
const address = listener.address();
assert(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}/api/contacts/codex/messages`;

try {
  db.prepare(
    "INSERT INTO contacts (id, name, backend, kind, config) VALUES ('codex', 'Codex', 'api', 'dm', '{}')"
  ).run();
  const insert = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, turn_id, meta, origin)
     VALUES ('codex', ?, ?, ?, ?, 'done', ?, '{}', 'main')`
  );
  const userId = Number(insert.run('user', 'user', 'text', 'question', null).lastInsertRowid);
  const thinkingId = Number(insert.run('codex', 'assistant', 'thinking', 'thought', 'turn-a').lastInsertRowid);
  const toolOneId = Number(insert.run('codex', 'assistant', 'tool_use', 'search', 'turn-a').lastInsertRowid);
  const toolTwoId = Number(insert.run('codex', 'assistant', 'tool_use', 'read', 'turn-a').lastInsertRowid);
  const answerId = Number(insert.run('codex', 'assistant', 'text', 'answer', 'turn-a').lastInsertRowid);
  const otherTurnId = Number(insert.run('codex', 'assistant', 'text', 'other answer', 'turn-b').lastInsertRowid);

  const response = await fetch(`${base}/${answerId}?scope=turn`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    ids: [thinkingId, toolOneId, toolTwoId, answerId],
  });
  const rows = db.prepare('SELECT * FROM messages ORDER BY id').all() as MessageRow[];
  assert.deepEqual(
    rows.map((row) => [row.id, row.deleted]),
    [
      [userId, 0],
      [thinkingId, 1],
      [toolOneId, 1],
      [toolTwoId, 1],
      [answerId, 1],
      [otherTurnId, 0],
    ],
    'turn deletion must not touch the user message or another assistant turn',
  );
  assert.deepEqual(
    broadcasts.find((item) => item.event === 'prune')?.data.ids,
    [thinkingId, toolOneId, toolTwoId, answerId],
  );
  assert.deepEqual(invalidations, [thinkingId], 'context invalidation starts at the first deleted row');

  const invalidTurnDelete = await fetch(`${base}/${userId}?scope=turn`, { method: 'DELETE' });
  assert.equal(invalidTurnDelete.status, 400, 'user-message deletion semantics cannot expand to a turn');
  assert.equal(
    (db.prepare('SELECT deleted FROM messages WHERE id = ?').get(userId) as { deleted: number }).deleted,
    0,
  );

  const singleDelete = await fetch(`${base}/${otherTurnId}`, { method: 'DELETE' });
  assert.equal(singleDelete.status, 200);
  assert.equal(
    (db.prepare('SELECT deleted FROM messages WHERE id = ?').get(otherTurnId) as { deleted: number }).deleted,
    1,
    'the existing unscoped endpoint remains a single-message delete',
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => error ? reject(error) : resolve())
  );
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('message turn deletion checks passed');
