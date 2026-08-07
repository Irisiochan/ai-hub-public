import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import {
  MEMORY_OUTBOX_MAX_ATTEMPTS,
  VaultClient,
  memoryOutboxRetryDelayMs,
} from '../src/memory/vaultClient.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-vault-outbox-'));
const db = openDb(path.join(tempDir, 'hub.db'));
const logs: string[] = [];
const client = new VaultClient('http://127.0.0.1:1/mcp', db, (message) => logs.push(message));
const calls: string[] = [];

db.prepare("INSERT INTO memory_outbox (tool, args) VALUES ('fail-first', '{}')").run();
db.prepare("INSERT INTO memory_outbox (tool, args) VALUES ('succeed-second', '{}')").run();
db.prepare(
  'INSERT INTO memory_outbox (tool, args, attempts) VALUES (?, ?, ?)'
).run('dead-third', '{}', MEMORY_OUTBOX_MAX_ATTEMPTS - 1);

(client as any).call = async (tool: string) => {
  calls.push(tool);
  if (tool === 'succeed-second') return 'ok';
  throw new Error(`${tool} unavailable`);
};

try {
  const before = Date.now();
  await client.flushOutbox();
  assert.deepEqual(
    calls,
    ['fail-first', 'succeed-second', 'dead-third'],
    'one failed row must not block later due rows'
  );

  const retry = db.prepare(
    "SELECT * FROM memory_outbox WHERE tool = 'fail-first'"
  ).get() as {
    attempts: number;
    status: string;
    next_attempt_at: number;
    last_error: string;
  };
  assert.equal(retry.attempts, 1);
  assert.equal(retry.status, 'pending');
  assert.ok(retry.next_attempt_at >= before + memoryOutboxRetryDelayMs(1));
  assert.match(retry.last_error, /fail-first unavailable/);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM memory_outbox WHERE tool = 'succeed-second'")
      .get()!.count,
    0,
    'successful later rows are deleted'
  );

  const dead = db.prepare(
    "SELECT * FROM memory_outbox WHERE tool = 'dead-third'"
  ).get() as {
    attempts: number;
    status: string;
    next_attempt_at: number;
    dead_at: string | null;
    last_error: string;
  };
  assert.equal(dead.attempts, MEMORY_OUTBOX_MAX_ATTEMPTS);
  assert.equal(dead.status, 'dead');
  assert.equal(dead.next_attempt_at, 0);
  assert.ok(dead.dead_at);
  assert.match(dead.last_error, /dead-third unavailable/);
  assert.ok(logs.some((line) => line.includes('outbox retry scheduled: fail-first')));
  assert.ok(logs.some((line) => line.includes('outbox dead-lettered: dead-third')));

  calls.length = 0;
  db.prepare(
    "UPDATE memory_outbox SET next_attempt_at = 0 WHERE tool = 'fail-first'"
  ).run();
  (client as any).call = async (tool: string) => {
    calls.push(tool);
    return 'ok';
  };
  await client.flushOutbox();
  assert.deepEqual(calls, ['fail-first'], 'dead letters stay parked while due pending rows retry');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM memory_outbox WHERE status = 'pending'")
      .get()!.count,
    0
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM memory_outbox WHERE status = 'dead'")
      .get()!.count,
    1,
    'dead-letter evidence remains durable'
  );
} finally {
  await client.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('vault outbox retry checks passed');
