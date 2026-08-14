import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { DirectApiBackend } from '../src/agents/directApi/base.js';
import { openContact } from '../src/agents/configSchemas.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { AsyncQueue, type AgentBackend, type TurnEvent } from '../src/agents/types.js';
import type { HubConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { sessionAuth } from '../src/middleware/auth.js';
import { SseHub } from '../src/sse.js';
import { JobStore } from '../src/workers/jobStore.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-backend-reliability-'));
const uploadsDir = path.join(tempDir, 'uploads');
fs.mkdirSync(uploadsDir);
const db = openDb(path.join(tempDir, 'test.sqlite'));
const sse = new SseHub();

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
}

async function authPathBoundary(): Promise<void> {
  const app = express();
  const auth = sessionAuth('test-secret');
  assert.ok(auth);
  app.use(auth);
  app.get('/api/worker/check', (_req, res) => res.json({ ok: true }));
  app.get('/api/workers/check', (_req, res) => res.json({ ok: true }));
  app.get('/api/jobs/check', (_req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  try {
    const baseUrl = await listen(server);
    assert.equal((await fetch(`${baseUrl}/api/worker/check`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/workers/check`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/jobs/check`)).status, 401);
  } finally {
    await close(server);
  }
}

async function workerCompletionIsIdempotent(): Promise<void> {
  const jobs = new JobStore(db, sse);
  const created = jobs.create({
    requestedBy: 'codex',
    runner: 'claude',
    workspace: tempDir,
    prompt: '完成后只通知一次',
    permissions: { write: false, shell: false, ssh: false },
  });
  assert.ok(!('error' in created));
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(created.job.id);

  let finished = 0;
  jobs.onFinished = () => { finished++; };
  const first = jobs.complete(created.job, 'done', 'ok', null);
  assert.deepEqual(first, { status: 'done', changed: true });
  const messagesAfterFirst = jobs.messages(created.job.id).length;

  const duplicate = jobs.complete(created.job, 'done', 'ok', null);
  assert.deepEqual(duplicate, { status: 'done', changed: false });
  await jobs.drainOutbox();
  assert.equal(finished, 1, 'durable outbox must fire the hook exactly once across terminal retries');
  assert.equal(jobs.messages(created.job.id).length, messagesAfterFirst);

  const cancelled = jobs.create({
    requestedBy: 'codex',
    runner: 'claude',
    workspace: tempDir,
    prompt: '取消后不能复活',
    permissions: { write: false, shell: false, ssh: false },
  });
  assert.ok(!('error' in cancelled));
  db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(cancelled.job.id);
  assert.deepEqual(
    jobs.complete(cancelled.job, 'done', 'late result', null),
    { status: 'cancelled', changed: false }
  );
  assert.equal(jobs.get(cancelled.job.id)?.status, 'cancelled');
}

async function directApiStopAbortsTurn(): Promise<void> {
  let markRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
  const upstream = http.createServer((_req, res) => {
    markRequestStarted();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    setTimeout(() => {
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'late' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    }, 150);
  });

  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config)
     VALUES ('direct-stop', 'direct-stop', 'api', 'dm', '{}')`
  ).run();
  const inserted = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status)
     VALUES ('direct-stop', 'user', 'user', 'text', 'hello', 'done')`
  ).run();

  try {
    const baseUrl = await listen(upstream);
    const backend = new DirectApiBackend({
      provider: 'openai-compat',
      baseUrl,
      apiKey: 'test',
      model: 'test',
      maxHistoryMessages: 10,
      historyTokenBudget: 2000,
      minRecentTurns: 1,
      summaryMaxTokens: 256,
      historySummaryStrategy: 'off',
      maxTokens: 64,
      contextWindowTokens: 10_000,
      turnTimeoutMs: 5000,
      db,
      uploadsDir,
      contactId: 'direct-stop',
      log: () => {},
    });
    await backend.start(null);
    const handle = backend.sendTurn({
      text: 'hello',
      userMessageId: Number(inserted.lastInsertRowid),
    });
    await requestStarted;
    await backend.stop();
    const events: TurnEvent[] = [];
    for await (const event of handle.events) events.push(event);
    assert.equal(backend.alive(), false);
    assert.ok(events.some((event) => event.type === 'error'));
    assert.ok(!events.some((event) => event.type === 'delta' || event.type === 'done'));
  } finally {
    await close(upstream);
  }
}

async function unexpectedEofInterruptsStreamingRows(): Promise<void> {
  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config)
     VALUES ('runtime-eof', 'runtime-eof', 'api', 'dm', ?)`
  ).run(JSON.stringify({
    provider: 'openai-compat',
    apiKey: 'test',
    model: 'test',
    memory: { injectOnSpawn: false, searchPerTurn: false, capture: false },
  }));
  const contact = openContact(
    db.prepare('SELECT * FROM contacts WHERE id = ?').get('runtime-eof') as any
  );
  const inserted = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status)
     VALUES ('runtime-eof', 'user', 'user', 'text', 'hello', 'done')`
  ).run();
  const fakeBackend: AgentBackend = {
    kind: 'api',
    alive: () => true,
    start: async () => {},
    stop: async () => {},
    sendTurn: () => {
      const events = new AsyncQueue<TurnEvent>();
      events.push({ type: 'delta', text: 'partial' });
      events.end();
      return { events, interrupt: async () => {} };
    },
  };
  const config: HubConfig = {
    port: 3900,
    host: '127.0.0.1',
    dbPath: path.join(tempDir, 'test.sqlite'),
    agentsDir: path.join(tempDir, 'agents'),
    webDist: '',
    uploadsDir,
    releasesDir: path.join(tempDir, 'releases'),
    claude: { cliPath: 'claude', turnTimeoutMs: 5000 },
    codex: { cliPath: 'codex', turnTimeoutMs: 5000 },
    grok: { cliPath: 'grok', turnTimeoutMs: 5000 },
    memory: {
      mcpUrl: null,
      repoPath: null,
      injectOnSpawn: false,
      searchPerTurn: false,
      capture: false,
      maxTurnChars: 1200,
      sessionMaxAgeHours: 0,
    },
    backup: { enabled: false, dir: tempDir, intervalHours: 24, keep: 1 },
    purge: {
      enabled: false,
      messagesRetentionDays: 14,
      jobsRetentionDays: 30,
      intervalHours: 24,
      batchSize: 100,
    },
  };
  const runtime = new AgentRuntime(contact, contact, {
    db,
    sse,
    config,
    vault: null,
    jobStore: null,
  });
  (runtime as any).backend = fakeBackend;
  assert.equal(
    runtime.enqueue({ userMessageId: Number(inserted.lastInsertRowid), text: 'hello' }),
    'queued'
  );

  let row: { content: string; status: string } | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    row = db.prepare(
      `SELECT content, status FROM messages
       WHERE contact_id = 'runtime-eof' AND role = 'assistant' AND kind = 'text'
       ORDER BY id DESC LIMIT 1`
    ).get() as { content: string; status: string } | undefined;
    if (row?.status === 'interrupted') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(row, { content: 'partial', status: 'interrupted' });

  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config)
     VALUES ('runtime-terminal-error', 'runtime-terminal-error', 'api', 'dm', ?)`
  ).run(JSON.stringify({
    provider: 'openai-compat',
    apiKey: 'test',
    model: 'test',
    memory: { injectOnSpawn: false, searchPerTurn: false, capture: false },
  }));
  const terminalContact = openContact(
    db.prepare('SELECT * FROM contacts WHERE id = ?').get('runtime-terminal-error') as any
  );
  const terminalInput = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status)
     VALUES ('runtime-terminal-error', 'user', 'user', 'text', 'hello', 'done')`
  ).run();
  const doneBackend: AgentBackend = {
    ...fakeBackend,
    sendTurn: () => {
      const events = new AsyncQueue<TurnEvent>();
      events.push({ type: 'delta', text: 'almost done' });
      events.push({ type: 'done', finalText: 'almost done' });
      events.end();
      return { events, interrupt: async () => {} };
    },
  };
  const throwingSse = {
    broadcast(event: string, payload: unknown) {
      const row = payload as { status?: string };
      if (event === 'message' && row.status === 'done') {
        throw new Error('terminal broadcast failed');
      }
    },
  };
  const terminalRuntime = new AgentRuntime(terminalContact, terminalContact, {
    db,
    sse: throwingSse as any,
    config,
    vault: null,
    jobStore: null,
  });
  (terminalRuntime as any).backend = doneBackend;
  await assert.rejects(
    (terminalRuntime as any).processTurn({
      kind: 'dm',
      userMessageId: Number(terminalInput.lastInsertRowid),
      text: 'hello',
      origin: 'main',
      sourceMeta: '{}',
      userAuthored: true,
      enqueuedAt: Date.now(),
    }),
    /terminal broadcast failed/
  );
  const terminalRow = db.prepare(
    `SELECT content, status FROM messages
     WHERE contact_id = 'runtime-terminal-error' AND role = 'assistant' AND kind = 'text'
     ORDER BY id DESC LIMIT 1`
  ).get();
  assert.deepEqual(terminalRow, { content: 'almost done', status: 'interrupted' });
}

try {
  await authPathBoundary();
  await workerCompletionIsIdempotent();
  await directApiStopAbortsTurn();
  await unexpectedEofInterruptsStreamingRows();
} finally {
  sse.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('backend reliability checks passed');
