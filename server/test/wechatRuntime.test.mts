import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openContact } from '../src/agents/configSchemas.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { AsyncQueue, type AgentBackend, type TurnEvent } from '../src/agents/types.js';
import type { HubConfig } from '../src/config.js';
import { openDb, type MessageRow } from '../src/db.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-wechat-runtime-'));
const uploadsDir = path.join(tempDir, 'uploads');
fs.mkdirSync(uploadsDir);
const db = openDb(path.join(tempDir, 'hub.db'));
const config: HubConfig = {
  port: 3900,
  host: '127.0.0.1',
  dbPath: path.join(tempDir, 'hub.db'),
  agentsDir: path.join(tempDir, 'agents'),
  webDist: '',
  uploadsDir,
  releasesDir: path.join(tempDir, 'releases'),
  claude: { cliPath: 'claude', turnTimeoutMs: 5_000 },
  codex: { cliPath: 'codex', turnTimeoutMs: 5_000 },
  grok: { cliPath: 'grok', turnTimeoutMs: 5_000 },
  memory: {
    mcpUrl: null,
    repoPath: null,
    injectOnSpawn: false,
    searchPerTurn: false,
    capture: false,
    maxTurnChars: 1_200,
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

try {
  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config)
     VALUES ('tracked', 'Claude', 'api', 'dm', ?)`,
  ).run(JSON.stringify({
    provider: 'openai-compat',
    apiKey: 'test',
    model: 'test',
    memory: { injectOnSpawn: false, searchPerTurn: false, capture: false },
  }));
  const contact = openContact(db.prepare('SELECT * FROM contacts WHERE id = ?').get('tracked') as any);
  const input = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('tracked', 'user', 'user', 'text', '微信来的', 'done', '{}', 'main')`,
  ).run();
  const backend: AgentBackend = {
    kind: 'api',
    alive: () => true,
    start: async () => {},
    stop: async () => {},
    sendTurn: () => {
      const events = new AsyncQueue<TurnEvent>();
      events.push({ type: 'delta', text: '跟踪回复' });
      events.push({ type: 'done', finalText: '跟踪回复' });
      events.end();
      return { events, interrupt: async () => {} };
    },
  };
  const runtime = new AgentRuntime(contact, contact, {
    db,
    sse: { broadcast() {} } as any,
    config,
    vault: null,
    jobStore: null,
  });
  (runtime as any).backend = backend;
  const tracked = runtime.enqueueTracked({
    userMessageId: Number(input.lastInsertRowid),
    text: '微信来的',
  });
  assert.equal(tracked.status, 'queued');
  const result = await tracked.completion;
  assert.deepEqual(
    { outcome: result.outcome, text: result.text },
    { outcome: 'done', text: '跟踪回复' },
  );
  assert.ok(result.messageId);
  const reply = db.prepare('SELECT * FROM messages WHERE id = ?').get(result.messageId) as MessageRow;
  assert.equal(reply.content, '跟踪回复');
  assert.equal(JSON.parse(reply.meta).replyToMessageId, Number(input.lastInsertRowid));
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('wechat tracked runtime completion test passed');
