import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../dist/agents/manager.js';
import { openDb } from '../dist/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.room-single-target-latency.db');
const uploadsDir = path.join(here, '.room-single-target-uploads');
const agentsDir = path.join(here, '.room-single-target-agents');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
fs.rmSync(uploadsDir, { recursive: true, force: true });
fs.rmSync(agentsDir, { recursive: true, force: true });
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(agentsDir, { recursive: true });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const requests: Array<{ model: string; at: number; firstTokenAt?: number; body: any }> = [];

const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const body = JSON.parse(raw);
    const rec = { model: String(body.model), at: Date.now(), body };
    requests.push(rec);
    const firstDelay = rec.model === 'slow-model' ? 350 : 45;
    const text = rec.model === 'slow-model' ? '慢成员不该被单点名触发' : 'Member A 正常';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    setTimeout(() => {
      rec.firstTokenAt = Date.now();
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 9, completion_tokens: 3 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }, 15);
    }, firstDelay);
  });
});
const port = await new Promise<number>((resolve) =>
  upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as { port: number }).port))
);

const db = openDb(dbPath);
const events: any[] = [];
const sse = { broadcast: (event: string, data: unknown) => events.push({ event, data, at: Date.now() }) };
const config = {
  port: 3900,
  host: '127.0.0.1',
  dbPath,
  agentsDir,
  webDist: '',
  uploadsDir,
  claude: { cliPath: 'claude', turnTimeoutMs: 5000 },
  codex: { cliPath: 'codex', turnTimeoutMs: 5000 },
  grok: { cliPath: 'grok', turnTimeoutMs: 5000 },
  memory: { mcpUrl: null, repoPath: null, injectOnSpawn: false, searchPerTurn: false, capture: false, maxTurnChars: 0, sessionMaxAgeHours: 0 },
  backup: { enabled: false, dir: '', intervalHours: 24, keep: 1 },
};

function addContact(id: string, name: string, model: string): void {
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, 'api', 'dm', ?)`).run(
    id,
    name,
    JSON.stringify({ provider: 'openai-compat', baseUrl: `http://127.0.0.1:${port}/v1/chat/completions`, apiKey: 'test', model, memory: { injectOnSpawn: false, searchPerTurn: false, capture: false }, maxTokens: 64 })
  );
}

function contact(id: string) {
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow;
}

async function waitForMessage(contactId: string, sender: string, afterId: number): Promise<any> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const row = db.prepare(
      `SELECT * FROM messages WHERE contact_id = ? AND sender = ? AND id > ? AND kind = 'text' AND status = 'done' AND deleted = 0 ORDER BY id DESC LIMIT 1`
    ).get(contactId, sender, afterId);
    if (row) return row;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${sender} message in ${contactId}`);
}

try {
  addContact('member-a', 'Member A', 'member-a-model');
  addContact('slow', '慢成员', 'slow-model');
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room', 'AI群聊', 'api', 'room', ?)`)
    .run(JSON.stringify({ members: ['member-a', 'slow'], reactionRounds: 1 }));
  const manager = new AgentManager({ db, sse: sse as any, config: config as any, vault: null, jobStore: null });

  const dmInsert = db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status) VALUES ('member-a', 'user', 'user', 'text', '私聊测速', 'done')`).run();
  const dmStart = Date.now();
  assert.equal(manager.get(contact('member-a')).enqueue({ userMessageId: Number(dmInsert.lastInsertRowid), text: '私聊测速' }), 'queued');
  await waitForMessage('member-a', 'member-a', Number(dmInsert.lastInsertRowid));
  const dmReq = requests.find((r) => r.model === 'member-a-model');
  assert(dmReq?.firstTokenAt, 'DM should receive first token');
  const dmFirstTokenMs = dmReq.firstTokenAt - dmStart;

  requests.length = 0;
  const roomInsert = db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status) VALUES ('room', 'user', 'user', 'text', '@member-a 群聊测速', 'done')`).run();
  const roomStart = Date.now();
  const targets = manager.dispatchRoomMessage(contact('room'), '@member-a 群聊测速');
  assert.deepEqual(targets, ['member-a']);
  await waitForMessage('room', 'member-a', Number(roomInsert.lastInsertRowid));
  await sleep(500);

  assert.equal(requests.length, 1, 'single-target room message must not trigger slow member reaction turns');
  assert.equal(requests[0].model, 'member-a-model');
  assert(requests[0].firstTokenAt, 'room turn should receive first token');
  const roomFirstTokenMs = requests[0].firstTokenAt! - roomStart;
  assert(roomFirstTokenMs < 250, `room first token should match member-a upstream, got ${roomFirstTokenMs}ms`);

  const roomStatuses = events.filter((e) => e.event === 'status' && (e.data as any).contactId === 'room').map((e) => (e.data as any));
  assert(roomStatuses.some((s) => s.member === 'Member A' && s.state === 'thinking'));
  assert(!roomStatuses.some((s) => s.member === '慢成员'), 'slow member should not enter room status for a single @member-a turn');
  // Every non-idle room status must carry member — never leave UI to fall back to room title.
  for (const s of roomStatuses) {
    if (s.state === 'idle') continue;
    assert.equal(typeof s.member, 'string', `busy room status missing member: ${JSON.stringify(s)}`);
    assert.notEqual(s.member, 'AI群聊', 'member must not be room title');
    assert.ok(s.member.length > 0, 'member must be non-empty for busy room status');
  }
  const snap = manager.statusOf('room');
  // After turn completes, idle; during turn statusOf would include member — exercise activeStatuses shape.
  const active = manager.activeStatuses();
  assert(Array.isArray(active), 'activeStatuses returns array');
  assert.equal(snap.state, 'idle');

  // openai-compat room requests must bound completion (incl. reasoning_content).
  assert.equal(typeof requests[0].body.max_tokens, 'number');
  assert(requests[0].body.max_tokens > 0, 'max_tokens must be positive');

  console.log(`room single-target latency smoke: ok dmFirstTokenMs=${dmFirstTokenMs} roomFirstTokenMs=${roomFirstTokenMs} requests=${requests.map((r) => r.model).join(',')}`);
} finally {
  db.close();
  upstream.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  fs.rmSync(agentsDir, { recursive: true, force: true });
}
