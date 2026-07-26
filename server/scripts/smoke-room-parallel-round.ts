import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../dist/agents/manager.js';
import { openDb, type ContactRow } from '../dist/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.room-parallel.db');
const uploadsDir = path.join(here, '.room-parallel-uploads');
const agentsDir = path.join(here, '.room-parallel-agents');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
for (const dir of [uploadsDir, agentsDir]) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(agentsDir, { recursive: true });

interface RequestRecord { model: string; sequence: number; started: number; ended?: number }
const requests: RequestRecord[] = [];
const counts = new Map<string, number>();
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const model = String(JSON.parse(raw).model);
    const sequence = (counts.get(model) ?? 0) + 1;
    counts.set(model, sequence);
    const record: RequestRecord = { model, sequence, started: Date.now() };
    requests.push(record);
    const normal = sequence === 1;
    const delay = normal ? (model === 'slow-model' ? 280 : 45) : 50;
    const text = normal ? `${model} normal` : '[PASS]';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      record.ended = Date.now();
      res.end();
    }, delay);
  });
});
const port = await new Promise<number>((resolve) =>
  upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as { port: number }).port))
);

const db = openDb(dbPath);
const config = {
  port: 3900, host: '127.0.0.1', dbPath, agentsDir, webDist: '', uploadsDir,
  claude: { cliPath: 'claude', turnTimeoutMs: 5000 },
  codex: { cliPath: 'codex', turnTimeoutMs: 5000 },
  grok: { cliPath: 'grok', turnTimeoutMs: 5000 },
  memory: { mcpUrl: null, repoPath: null, injectOnSpawn: false, searchPerTurn: false, capture: false, maxTurnChars: 0, sessionMaxAgeHours: 0 },
  backup: { enabled: false, dir: '', intervalHours: 24, keep: 1 },
};
const manager = new AgentManager({ db, sse: { broadcast: () => {} } as any, config: config as any, vault: null, jobStore: null });
const contact = (id: string) => db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow;
const addMember = (id: string, model: string) => db.prepare(
  `INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, 'api', 'dm', ?)`
).run(id, id, JSON.stringify({
  provider: 'openai-compat', baseUrl: `http://127.0.0.1:${port}/v1/chat/completions`, apiKey: 'test', model,
  memory: { injectOnSpawn: false, searchPerTurn: false, capture: false }, maxTokens: 32,
}));

try {
  addMember('fast', 'fast-model');
  addMember('slow', 'slow-model');
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room', 'Room', 'room', 'room', ?)`)
    .run(JSON.stringify({ members: ['fast', 'slow'], reactionRounds: 1 }));
  db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status)
              VALUES ('room', 'user', 'user', 'text', '@all parallel', 'done')`).run();
  manager.dispatchRoomMessage(contact('room'), '@all parallel');

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && (requests.length < 4 || manager.statusOf('room').state !== 'idle')) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(requests.length, 4, 'two normal plus two reaction requests expected');
  const normal = requests.filter((request) => request.sequence === 1);
  assert.equal(normal.length, 2);
  assert(Math.abs(normal[0].started - normal[1].started) < 120, 'normal members must start concurrently');

  const rows = db.prepare(
    `SELECT sender, content FROM messages WHERE contact_id = 'room' AND role = 'assistant'
     AND kind = 'text' AND status = 'done' AND deleted = 0 ORDER BY id ASC`
  ).all() as Array<{ sender: string; content: string }>;
  assert.deepEqual(rows.map((row) => row.sender), ['fast', 'slow'], 'normal answers persist by completion order');

  const reactions = requests.filter((request) => request.sequence === 2).sort((a, b) => a.started - b.started);
  const normalFinished = Math.max(...normal.map((request) => request.ended ?? 0));
  assert(reactions[0].started >= normalFinished, 'reaction starts only after every normal answer completes');
  assert(reactions[1].started >= (reactions[0].ended ?? Infinity), 'reaction members remain serial');
  assert.equal(manager.statusOf('room').state, 'idle');
  console.log('room parallel round smoke: ok');
} finally {
  await manager.stopAll();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  for (const dir of [uploadsDir, agentsDir]) fs.rmSync(dir, { recursive: true, force: true });
}
