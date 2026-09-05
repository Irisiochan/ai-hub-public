import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AgentManager } from '../src/agents/manager.js';
import { MessageRepo } from '../src/agents/messageRepo.js';
import { openDb, type ContactRow } from '../src/db.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-room-delivery-'));
const dbPath = path.join(root, 'hub.db');
const uploadsDir = path.join(root, 'uploads');
const agentsDir = path.join(root, 'agents');
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(agentsDir, { recursive: true });

const requests: any[] = [];
const replies = ['收到，可以工作了。', '[PASS]', '[PASS]'];
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const content = replies[requests.length - 1] ?? '收到。';
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
const port = await new Promise<number>((resolve) => upstream.listen(0, '127.0.0.1', () => {
  resolve((upstream.address() as { port: number }).port);
}));

const db = openDb(dbPath);
const config = {
  port: 3900,
  host: '127.0.0.1',
  dbPath,
  agentsDir,
  webDist: '',
  uploadsDir,
  claude: { cliPath: 'claude', turnTimeoutMs: 5000 },
  codex: { cliPath: 'codex', turnTimeoutMs: 5000, nativeCompact: { enabled: false } },
  grok: { cliPath: 'grok', turnTimeoutMs: 5000 },
  opencode: { cliPath: 'opencode', turnTimeoutMs: 5000 },
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

try {
  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config)
     VALUES ('aye-test', '阿野', 'api', 'dm', ?),
            ('room-test', '会议室', 'room', 'room', ?)`
  ).run(
    JSON.stringify({
      provider: 'openai-compat',
      baseUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      apiKey: 'test',
      model: 'test',
      maxTokens: 64,
      maxHistoryMessages: 80,
      historyTokenBudget: 32_000,
      memory: { injectOnSpawn: false, searchPerTurn: false, capture: false },
    }),
    JSON.stringify({ members: ['aye-test'] }),
  );
  const insert = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status)
     VALUES ('room-test', ?, ?, 'text', ?, 'done')`
  );
  let oldestId = 0;
  for (let index = 0; index < 55; index++) {
    const result = insert.run('room-host', 'user', `旧积压-${index}`);
    if (index === 0) oldestId = Number(result.lastInsertRowid);
  }
  const triggerContent = '@阿野 修好了，可以工作了';
  const triggerId = Number(insert.run('user', 'user', triggerContent).lastInsertRowid);
  let newestId = triggerId;
  for (let index = 0; index < 45; index++) {
    newestId = Number(insert.run('room-host', 'user', `稍后上下文-${index}`).lastInsertRowid);
  }

  const latestWindow = new MessageRepo(db).unreadRoomText('room-test', 0, 'aye-test', 40);
  assert.equal(latestWindow.length, 40);
  assert.equal(latestWindow.at(-1)?.id, newestId, 'unread query keeps the newest message');
  assert.equal(latestWindow.some((row) => row.id === oldestId), false, 'oldest backlog cannot crowd out recent rows');
  assert.equal(latestWindow.some((row) => row.id === triggerId), false, 'fixture proves trigger is outside the latest 40');

  const room = db.prepare("SELECT * FROM contacts WHERE id = 'room-test'").get() as ContactRow;
  const result = manager.dispatchRoomMessageTracked(room, triggerContent, { userMessageId: triggerId });
  assert.deepEqual(result.targets, ['aye-test']);
  const outcome = await result.completion;
  assert.equal(outcome.normal.spoke, 1);
  assert.equal(outcome.normal.passed, 0);
  assert.equal(requests.length, 1);
  const prompt = requests[0].messages.map((message: { content?: unknown }) => String(message.content ?? '')).join('\n');
  assert.match(prompt, /@阿野 修好了，可以工作了/, 'trigger message is forced into the delivery window');
  assert.match(prompt, /"direct_mention":true/);
  assert.match(prompt, /必须至少简短确认，不能只回 \[PASS\]/);
  assert.match(prompt, /sender_type=member\/host 的协调通告、催办或回执一律只回 \[PASS\]/,
    'coordination PASS safety gate remains in place');
  assert.doesNotMatch(prompt, /旧积压-0/, 'stale oldest backlog is not delivered');
  const state = db.prepare(
    "SELECT last_seen_id FROM room_member_state WHERE contact_id = 'room-test' AND member_id = 'aye-test'"
  ).get() as { last_seen_id: number };
  assert.equal(state.last_seen_id, newestId, 'successful turn advances past the newest selected row');

  const member = db.prepare("SELECT * FROM contacts WHERE id = 'aye-test'").get() as ContactRow;
  const hostContent = '@aye-test 路由派单：处理 tasks/example.md';
  const hostId = Number(db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta)
     VALUES ('room-test', 'room-host', 'user', 'text', ?, 'done', ?)`
  ).run(hostContent, JSON.stringify({
    roomHost: { roundId: 'host-round', targets: ['aye-test'], reactionRounds: 0 },
  })).lastInsertRowid);
  const hostRound = manager.dispatchRoomMessageTracked(room, hostContent, {
    targetOverride: [member],
    userMessageId: hostId,
    reactionRounds: 0,
  });
  const hostOutcome = await hostRound.completion;
  assert.equal(hostOutcome.normal.spoke, 0);
  assert.equal(hostOutcome.normal.passed, 1);
  const hostPrompt = requests[1].messages
    .map((message: { content?: unknown }) => String(message.content ?? ''))
    .join('\n');
  assert.match(hostPrompt, /roomHost 本轮明确点名派单给你/);
  assert.match(hostPrompt, /\[PASS\].*说明一句当前无事可做的原因/);
  assert.match(hostPrompt, /delegate_to_worker/);
  assert.doesNotMatch(hostPrompt, /实在没话说也可以只回 \[PASS\]/);
  const visiblePass = db.prepare(
    "SELECT COUNT(*) AS count FROM messages WHERE contact_id = 'room-test' AND sender = 'aye-test' AND content = '[PASS]'"
  ).get() as { count: number };
  assert.equal(visiblePass.count, 1, 'roomHost-targeted bare PASS remains visible');

  const ordinaryId = Number(insert.run('user', 'user', '普通接话轮').lastInsertRowid);
  const ordinaryRound = manager.dispatchRoomMessageTracked(room, '普通接话轮', {
    targetOverride: [member],
    userMessageId: ordinaryId,
    reactionRounds: 0,
  });
  const ordinaryOutcome = await ordinaryRound.completion;
  assert.equal(ordinaryOutcome.normal.passed, 1);
  const passAfterOrdinary = db.prepare(
    "SELECT COUNT(*) AS count FROM messages WHERE contact_id = 'room-test' AND sender = 'aye-test' AND content = '[PASS]'"
  ).get() as { count: number };
  assert.equal(passAfterOrdinary.count, 1, 'ordinary bare PASS is still hard-deleted');
  console.log('room latest delivery and direct mention checks: ok');
} finally {
  await manager.stopAll();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
