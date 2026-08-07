import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb } from '../src/db.js';
import { messagesRouter } from '../src/routes/messages.js';
import { SseHub } from '../src/sse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.room-host-smoke.db');
const uploadsDir = path.join(here, '.room-host-smoke-uploads');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
fs.rmSync(uploadsDir, { recursive: true, force: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const db = openDb(dbPath);
const sse = new SseHub();
const members = [
  { id: 'claude', name: 'Claude', kind: 'dm' },
  { id: 'codex', name: 'Codex', kind: 'dm' },
];
let trackedCalls = 0;
let trackedOptions: any;
const fakeManager = {
  imageRoomMembers: () => members,
  parseTargets: () => members,
  dispatchRoomMessageTracked: (_room: any, _content: string, options: any) => {
    trackedCalls++;
    trackedOptions = options;
    return {
      targets: options.targetOverride.map((member: any) => member.id),
      completion: Promise.resolve({
        normal: { spoke: 1, passed: 1, silent: 0, error: 0 },
        reactions: [{ spoke: 0, passed: 2, silent: 0, error: 0 }],
      }),
    };
  },
  get: () => ({ enqueue: () => 'queued' }),
  dispatchRoomMessage: () => [],
  invalidateConversation: async () => {},
  interruptAll: () => {},
  resetConversation: async () => {},
};

db.prepare(
  `INSERT INTO contacts (id, name, backend, kind, config)
   VALUES ('room', '会议室', 'api', 'room', ?)`
).run(JSON.stringify({ members: members.map((member) => member.id) }));
for (const member of members) {
  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config)
     VALUES (?, ?, 'api', 'dm', '{}')`
  ).run(member.id, member.name);
}

const app = express();
app.use(express.json());
app.use('/api/contacts', messagesRouter(db, sse, fakeManager as any, uploadsDir));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;

try {
  const topicResponse = await fetch(
    `http://127.0.0.1:${port}/api/contacts/room/room-host/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '@all 今天聊一个不属于项目优化的话题。',
        hostName: 'DS 主持',
        targetIds: ['all'],
        reactionRounds: 3,
        idempotencyKey: 'idea:test:topic',
      }),
    }
  );
  assert.equal(topicResponse.status, 202);
  const topic = await topicResponse.json() as any;
  assert.equal(topic.status, 'running');
  assert.deepEqual(topic.targets, ['claude', 'codex']);
  assert.equal(trackedCalls, 1);
  assert.equal(trackedOptions.capture, false, 'room-host content must skip memory capture');
  assert.equal(trackedOptions.reactionRounds, 3);

  await new Promise((resolve) => setImmediate(resolve));
  const roundResponse = await fetch(
    `http://127.0.0.1:${port}/api/contacts/room/room-rounds/${topic.roundId}`
  );
  assert.equal(roundResponse.status, 200);
  const round = await roundResponse.json() as any;
  assert.equal(round.status, 'done');
  assert.equal(round.outcome.normal.passed, 1);
  assert.equal(round.outcome.reactions[0].passed, 2);

  const topicRow = db.prepare('SELECT sender, role, meta FROM messages WHERE id = ?')
    .get(topic.messageId) as any;
  assert.equal(topicRow.sender, 'room-host');
  assert.equal(topicRow.role, 'user', 'room members must receive host content as conversation input');
  assert.equal(JSON.parse(topicRow.meta).roomHost.name, 'DS 主持');

  const duplicate = await fetch(
    `http://127.0.0.1:${port}/api/contacts/room/room-host/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'duplicate should not insert',
        targetIds: ['all'],
        idempotencyKey: 'idea:test:topic',
      }),
    }
  );
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json() as any).messageId, topic.messageId);
  assert.equal(trackedCalls, 1);

  const coordination = {
    kind: 'execution',
    taskPath: 'tasks/coordination-smoke.md',
    branch: 'coordination-smoke',
    workspace: 'C:/ai-hub-codex',
    planHash: 'b'.repeat(64),
    executor: 'codex',
  };
  const coordinationResponse = await fetch(
    'http://127.0.0.1:' + port + '/api/contacts/room/room-host/messages',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '@codex 工作对接派单',
        targetIds: ['codex'],
        reactionRounds: 0,
        idempotencyKey: 'coordination:' + coordination.taskPath + ':' + coordination.planHash,
        coordination,
      }),
    }
  );
  assert.equal(coordinationResponse.status, 202);
  const coordinationRound = await coordinationResponse.json() as any;
  await new Promise((resolve) => setImmediate(resolve));
  const coordinationRow = db.prepare('SELECT meta, idempotency_key FROM messages WHERE id = ?')
    .get(coordinationRound.messageId) as any;
  assert.deepEqual(JSON.parse(coordinationRow.meta).roomHost.coordination, coordination);
  assert.equal(
    coordinationRow.idempotency_key,
    'coordination:' + coordination.taskPath + ':' + coordination.planHash,
  );
  assert.equal(trackedCalls, 2);

  const verification = {
    kind: 'verification',
    taskPath: 'tasks/verification-smoke.md',
    due: '2026-08-06',
    verifier: 'codex',
  };
  const verificationResponse = await fetch(
    'http://127.0.0.1:' + port + '/api/contacts/room/room-host/messages',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '@codex 只读验收单',
        targetIds: ['codex'],
        reactionRounds: 0,
        idempotencyKey: 'verification:v1:' + verification.taskPath + ':' + verification.due,
        coordination: verification,
      }),
    }
  );
  assert.equal(verificationResponse.status, 202);
  const verificationRound = await verificationResponse.json() as any;
  await new Promise((resolve) => setImmediate(resolve));
  const verificationRow = db.prepare('SELECT meta, idempotency_key FROM messages WHERE id = ?')
    .get(verificationRound.messageId) as any;
  assert.deepEqual(JSON.parse(verificationRow.meta).roomHost.coordination, verification);
  assert.equal(
    verificationRow.idempotency_key,
    'verification:v1:' + verification.taskPath + ':' + verification.due,
  );
  assert.equal(trackedCalls, 3);

  const mismatchedVerificationResponse = await fetch(
    'http://127.0.0.1:' + port + '/api/contacts/room/room-host/messages',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '@claude 错目标验收单',
        targetIds: ['claude'],
        idempotencyKey: 'verification:v1:' + verification.taskPath + ':' + verification.due,
        coordination: verification,
      }),
    }
  );
  assert.equal(mismatchedVerificationResponse.status, 400);
  assert.equal(trackedCalls, 3, 'verification contract mismatch must fail before room dispatch');

  const forgedCoordinationResponse = await fetch(
    'http://127.0.0.1:' + port + '/api/contacts/room/room-host/messages',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '@codex 伪造派单',
        targetIds: ['codex'],
        idempotencyKey: 'coordination:forged',
        coordination: { ...coordination, planHash: 'not-a-hash' },
      }),
    }
  );
  assert.equal(forgedCoordinationResponse.status, 400);
  assert.equal(trackedCalls, 3, 'invalid coordination meta must fail before room dispatch');

  const summaryResponse = await fetch(
    `http://127.0.0.1:${port}/api/contacts/room/room-host/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: '收尾总结：保留分歧，也保留一点没说完的余味。',
        hostName: 'DS 主持',
        trigger: false,
        idempotencyKey: 'idea:test:summary',
      }),
    }
  );
  assert.equal(summaryResponse.status, 201);
  assert.equal((await summaryResponse.json() as any).status, 'done');
  assert.equal(trackedCalls, 3, 'summary must not open another room round');

  console.log('room host smoke: ok');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sse.close();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.rmSync(uploadsDir, { recursive: true, force: true });
}
