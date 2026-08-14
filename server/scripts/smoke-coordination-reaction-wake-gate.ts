/**
 * Coordination-domain host reaction wake gate (anti-regression).
 *
 * Asserts:
 *  1) coordination host rounds with reactionRounds>0 only wake authority holders
 *  2) non-authority members are counted as passed with zero model calls
 *  3) non-coordination (idea/social) reaction rounds still wake every member
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManager } from '../dist/agents/manager.js';
import {
  coordinationAuthorityHolderIds,
  isRoomHostCoordinationDomain,
  type RoomCoordinationDispatch,
} from '../dist/agents/roomPrompt.js';
import { openDb, type ContactRow } from '../dist/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.coordination-reaction-wake-gate.db');
const uploadsDir = path.join(here, '.coordination-reaction-wake-gate-uploads');
const agentsDir = path.join(here, '.coordination-reaction-wake-gate-agents');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
for (const dir of [uploadsDir, agentsDir]) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(agentsDir, { recursive: true });

interface RequestRecord {
  model: string;
  sequence: number;
  at: number;
}

const requests: RequestRecord[] = [];
const modelCounts = new Map<string, number>();
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const model = String(JSON.parse(raw).model);
    const sequence = (modelCounts.get(model) ?? 0) + 1;
    modelCounts.set(model, sequence);
    requests.push({ model, sequence, at: Date.now() });
    // First call per model speaks (so later reaction rounds have new content);
    // subsequent calls PASS so the round can settle.
    const text = sequence === 1 ? `${model} spoken` : '[PASS]';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 8, completion_tokens: 1 },
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
    }, 20);
  });
});
const port = await new Promise<number>((resolve) =>
  upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as { port: number }).port))
);

const db = openDb(dbPath);
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
  memory: {
    mcpUrl: null,
    repoPath: null,
    injectOnSpawn: false,
    searchPerTurn: false,
    capture: false,
    maxTurnChars: 0,
    sessionMaxAgeHours: 0,
  },
  backup: { enabled: false, dir: '', intervalHours: 24, keep: 1 },
};
const manager = new AgentManager({
  db,
  sse: { broadcast: () => {} } as any,
  config: config as any,
  vault: null,
  jobStore: null,
});

const contact = (id: string) => db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow;
const addMember = (id: string, model: string) =>
  db
    .prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, 'api', 'dm', ?)`)
    .run(
      id,
      id,
      JSON.stringify({
        provider: 'openai-compat',
        baseUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
        apiKey: 'test',
        model,
        memory: { injectOnSpawn: false, searchPerTurn: false, capture: false },
        maxTokens: 32,
      })
    );

const waitIdle = async (roomId: string, minRequests: number, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (requests.length >= minRequests && manager.statusOf(roomId).state === 'idle') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `timeout waiting idle room=${roomId} requests=${requests.length} min=${minRequests} state=${manager.statusOf(roomId).state}`
  );
};

try {
  // Pure helpers: domain detection uses meta.roomHost.coordination / coordinationPool.
  assert.equal(
    isRoomHostCoordinationDomain({ coordination: { kind: 'execution' } }),
    true
  );
  assert.equal(
    isRoomHostCoordinationDomain({ coordinationPool: { kind: 'receipt' } }),
    true
  );
  assert.equal(isRoomHostCoordinationDomain({ name: 'DS 主持' }), false);
  assert.deepEqual(
    coordinationAuthorityHolderIds({
      kind: 'execution',
      taskPath: 'tasks/x.md',
      branch: 'b',
      workspace: 'C:/w',
      planHash: 'a'.repeat(64),
      executor: 'codex',
    }).sort(),
    ['claude', 'codex']
  );
  assert.deepEqual(
    coordinationAuthorityHolderIds({
      kind: 'verification',
      taskPath: 'tasks/x.md',
      due: '2026-08-11',
      verifier: 'aye',
    }).sort(),
    ['aye', 'claude']
  );

  addMember('claude', 'claude-model');
  addMember('codex', 'codex-model');
  addMember('gala', 'gala-model');
  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-coord', '会议室', 'room', 'room', ?)`
  ).run(JSON.stringify({ members: ['claude', 'codex', 'gala'], reactionRounds: 2 }));
  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-idea', 'idea房', 'room', 'room', ?)`
  ).run(JSON.stringify({ members: ['claude', 'codex', 'gala'], reactionRounds: 1 }));

  // ── 1+2: coordination domain host round with default-like reactionRounds=2 ──
  const coordination: RoomCoordinationDispatch = {
    kind: 'execution',
    taskPath: 'tasks/wake-gate-smoke.md',
    branch: 'wake-gate',
    workspace: 'C:/ai-hub-codex',
    planHash: 'b'.repeat(64),
    executor: 'codex',
  };
  db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta)
     VALUES ('room-coord', 'room-host', 'user', 'text', '@codex 工作对接派单', 'done', ?)`
  ).run(
    JSON.stringify({
      roomHost: {
        name: 'DS 主持',
        reactionRounds: 2,
        targets: ['codex'],
        coordination,
      },
    })
  );

  const coordRoom = contact('room-coord');
  const tracked = manager.dispatchRoomMessageTracked(coordRoom, '@codex 工作对接派单', {
    targetOverride: [contact('codex')],
    capture: false,
    reactionRounds: 2,
    coordinationDomain: true,
    coordination,
  });
  // normal: codex speaks; reaction: authority claude+codex may wake; gala never does.
  // Expect at least normal(codex)+reaction(claude) model calls; gala must stay at 0.
  await waitIdle('room-coord', 2);
  const outcome = await tracked.completion;

  const coordModels = requests.map((r) => r.model);
  assert.ok(
    coordModels.includes('codex-model'),
    'executor must be woken on the normal target path'
  );
  assert.ok(
    coordModels.includes('claude-model'),
    'orchestrator must be eligible for coordination reaction wake'
  );
  assert.equal(
    requests.filter((r) => r.model === 'gala-model').length,
    0,
    'non-authority member must not receive any model call'
  );
  assert.equal(
    outcome.normal.spoke + outcome.normal.passed + outcome.normal.silent + outcome.normal.error,
    1
  );
  assert.ok(outcome.reactions.length >= 1, 'reactionRounds>0 must run at least one reaction sweep');
  const firstReaction = outcome.reactions[0];
  assert.ok(
    firstReaction.passed >= 1,
    'reaction accounting must include deterministic PASS for non-authority members'
  );
  assert.equal(
    firstReaction.passed + firstReaction.spoke + firstReaction.silent + firstReaction.error,
    3,
    'one outcome per room member for aggregation compatibility'
  );

  // ── 3: non-coordination idea/social reaction rounds unchanged ──
  requests.length = 0;
  modelCounts.clear();
  db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status)
     VALUES ('room-idea', 'user', 'user', 'text', '@all 随便聊聊', 'done')`
  ).run();
  const ideaTracked = manager.dispatchRoomMessageTracked(contact('room-idea'), '@all 随便聊聊', {
    targetOverride: [contact('claude'), contact('codex'), contact('gala')],
    capture: false,
    reactionRounds: 1,
    // deliberately omit coordinationDomain
  });
  // 3 normal speaks + 3 reaction wakes = 6 (reaction sees peer speech as new content)
  await waitIdle('room-idea', 6);
  const ideaOutcome = await ideaTracked.completion;
  const ideaModels = new Set(requests.map((r) => r.model));
  assert.equal(requests.length, 6, 'idea room must wake every member for normal + reaction');
  assert.deepEqual([...ideaModels].sort(), ['claude-model', 'codex-model', 'gala-model']);
  assert.equal(ideaOutcome.reactions.length, 1);
  assert.equal(
    ideaOutcome.reactions[0].passed
      + ideaOutcome.reactions[0].spoke
      + ideaOutcome.reactions[0].silent
      + ideaOutcome.reactions[0].error,
    3
  );
  assert.ok(
    requests.some((r) => r.model === 'gala-model' && r.sequence >= 1),
    'idea/social reaction path must still include non-authority members'
  );

  console.log('coordination reaction wake gate smoke: ok');
} finally {
  await manager.stopAll();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  for (const dir of [uploadsDir, agentsDir]) fs.rmSync(dir, { recursive: true, force: true });
}
