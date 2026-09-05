import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { AgentManager, type RoomRoundStats } from '../src/agents/manager.js';
import type { HubConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { messagesRouter } from '../src/routes/messages.js';
import { SseHub } from '../src/sse.js';
import { executionDispatchKey } from '../src/workers/coordinationKeys.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-deploy-resume-'));
const db = openDb(path.join(tempDir, 'hub.sqlite'));
const sse = new SseHub();
let listener: Server | null = null;
const outcome: RoomRoundStats = {
  normal: { spoke: 1, passed: 0, silent: 0, error: 0 },
  reactions: [],
};
const config: HubConfig = {
  port: 3900, host: '127.0.0.1', dbPath: path.join(tempDir, 'hub.sqlite'),
  agentsDir: tempDir, webDist: '', uploadsDir: tempDir, releasesDir: tempDir,
  claude: { cliPath: 'claude', turnTimeoutMs: 300_000 },
  codex: { cliPath: 'codex', turnTimeoutMs: 300_000 },
  grok: { cliPath: 'grok', turnTimeoutMs: 300_000 },
  memory: {
    mcpUrl: null, repoPath: null, injectOnSpawn: false, searchPerTurn: false,
    capture: false, maxTurnChars: 1200, sessionMaxAgeHours: 0,
  },
  backup: { enabled: false, dir: tempDir, intervalHours: 24, keep: 1 },
  purge: {
    enabled: false, messagesRetentionDays: 14, jobsRetentionDays: 30,
    intervalHours: 24, batchSize: 100,
  },
};

try {
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room', '会议室', 'api', 'room', ?)`)
    .run(JSON.stringify({ members: ['claude'], coordination: { enabled: true, orchestrator: 'claude' } }));
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('claude', 'Claude', 'api', 'dm', '{}')`).run();
  let release!: (value: RoomRoundStats) => void;
  const firstManager = new AgentManager({ db, sse, config, vault: null, jobStore: null });
  (firstManager as any).runRoomRound = () => new Promise<RoomRoundStats>((resolve) => { release = resolve; });
  const app = express();
  app.use(express.json());
  app.use('/api/contacts', messagesRouter(db, sse, firstManager, tempDir));
  listener = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener!.once('listening', resolve));
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const coordination = {
    kind: 'execution' as const,
    taskPath: 'tasks/deploy-resume-smoke.md',
    branch: 'deploy-resume-smoke',
    workspace: tempDir,
    planHash: 'a'.repeat(64),
    executor: 'claude',
  };
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/contacts/room/room-host/messages`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '@claude durable coordination',
        targetIds: ['claude'],
        reactionRounds: 0,
        idempotencyKey: executionDispatchKey(coordination),
        coordination,
      }),
    },
  );
  assert.equal(response.status, 202);
  const sourceId = (await response.json() as { messageId: number }).messageId;
  await new Promise((resolve) => setImmediate(resolve));
  const dispatchingMeta = JSON.parse((db.prepare('SELECT meta FROM messages WHERE id = ?').get(sourceId) as any).meta);
  assert.equal(dispatchingMeta.roomDispatch.status, 'dispatching');
  const { roomDispatch: _staleDispatch, ...callerInitialMeta } = dispatchingMeta;

  // Exercise the real HTTP completion callback, then simulate the historical
  // stale initialMeta write during runtime.stop(). stopAll's second marker must
  // replay the complete dispatch snapshot before startup recovery runs.
  (firstManager as any).runtimes.set('stale-http-caller', {
    stop: async () => {
      release(outcome);
      await new Promise((resolve) => setImmediate(resolve));
      const afterCompletion = JSON.parse(
        (db.prepare('SELECT meta FROM messages WHERE id = ?').get(sourceId) as any).meta,
      );
      assert.equal(afterCompletion.roomDispatch.interruptionReason, 'deploy-restart');
      db.prepare('UPDATE messages SET meta = ? WHERE id = ?')
        .run(JSON.stringify(callerInitialMeta), sourceId);
    },
  });

  await firstManager.stopAll('deploy-restart');
  const interruptedMeta = JSON.parse((db.prepare('SELECT meta FROM messages WHERE id = ?').get(sourceId) as any).meta);
  assert.equal(interruptedMeta.roomDispatch.status, 'error');
  assert.equal(interruptedMeta.roomDispatch.interruptionReason, 'deploy-restart');
  assert.deepEqual(interruptedMeta.roomDispatch.targetIds, ['claude']);
  assert.equal(interruptedMeta.roomDispatch.reactionRounds, 0);
  assert.equal(interruptedMeta.roomDispatch.coordinationDomain, true);
  assert.deepEqual(interruptedMeta.roomDispatch.coordination, coordination);

  const errorResult = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('room', 'claude', 'system', 'error', '部署重启中断', 'done', ?, 'main')`,
  ).run(JSON.stringify({ interruptionReason: 'deploy-restart', replaySourceMessageId: sourceId }));

  const ordinaryResult = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('room', 'user', 'user', 'text', '@claude ordinary user message', 'done', ?, 'main')`,
  ).run(JSON.stringify({
    roomDispatch: {
      status: 'error', dispatchClass: 'live', interruptionReason: 'deploy-restart', targetIds: ['claude'],
    },
  }));
  const ordinaryId = Number(ordinaryResult.lastInsertRowid);

  const drainResult = db.prepare(
    `INSERT INTO messages
       (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
     VALUES ('room', 'room-host', 'user', 'text', '@claude drain receipt', 'done', ?, 'main', 'receipt:v1:drain-smoke')`,
  ).run(JSON.stringify({
    roomHost: { targets: ['claude'], receipt: { jobId: 'drain-smoke' } },
    roomDispatch: {
      status: 'deferred', dispatchClass: 'drain', interruptionReason: 'deploy-restart', targetIds: ['claude'],
      reactionRounds: 0, coordinationDomain: true,
    },
  }));
  const drainId = Number(drainResult.lastInsertRowid);

  const scheduled: Array<{ messageId: number; targetIds: string[]; options: any }> = [];
  const recoveredManager = new AgentManager({ db, sse, config, vault: null, jobStore: null });
  (recoveredManager as any).scheduleRoomRound = async (_room: unknown, targets: any[], options: { userMessageId: number }) => {
    scheduled.push({ messageId: options.userMessageId, targetIds: targets.map((target) => target.id), options });
    return outcome;
  };
  assert.equal(recoveredManager.recoverDeferredRoomDispatches(), 2);
  assert.deepEqual(scheduled.map((item) => item.messageId).sort((a, b) => a - b), [sourceId, drainId].sort((a, b) => a - b));
  assert.ok(!scheduled.some((item) => item.messageId === ordinaryId), 'ordinary user messages must never deploy-resume');
  const resumed = scheduled.find((item) => item.messageId === sourceId)!;
  assert.deepEqual(resumed.targetIds, ['claude']);
  assert.equal(resumed.options.reactionRounds, 0);
  assert.equal(resumed.options.coordinationDomain, true);
  assert.deepEqual(resumed.options.coordination, coordination);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM messages WHERE idempotency_key = ?')
      .get(executionDispatchKey(coordination)) as any).count,
    1,
    'resume must reuse the original message and idempotency key',
  );
  const queuedError = db.prepare('SELECT content, meta FROM messages WHERE id = ?').get(errorResult.lastInsertRowid) as any;
  assert.equal(queuedError.content, '部署重启中断，已排队续跑');
  assert.equal(JSON.parse(queuedError.meta).resumeQueued, true);
  assert.equal(recoveredManager.recoverDeferredRoomDispatches(), 0, 'completed recovery must not dispatch twice');
  assert.equal(scheduled.filter((item) => item.messageId === drainId).length, 1, 'drain and deploy-resume paths must not double-dispatch');
} finally {
  if (listener) {
    await new Promise<void>((resolve, reject) =>
      listener!.close((error) => error ? reject(error) : resolve())
    );
  }
  sse.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('deploy resume smoke: ok');
