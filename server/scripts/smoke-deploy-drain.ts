import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentManager } from '../src/agents/manager.js';
import { RoomDispatchDrain } from '../src/agents/roomDispatchDrain.js';
import type { HubConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { prepareDeployDrain, type DeployDrainManager } from '../src/routes/system.js';
import { SseHub } from '../src/sse.js';

const gate = new RoomDispatchDrain();
assert.equal(gate.begin(), true);
let dispatched = 0;
const deferred = gate.defer(async () => { dispatched++; return 'sent'; });
await new Promise((resolve) => setTimeout(resolve, 15));
assert.equal(dispatched, 0, 'drain must block a newly admitted room dispatch');
assert.equal(gate.release(), 1);
assert.equal(await deferred, 'sent');
assert.equal(dispatched, 1, 'release must dispatch the deferred event exactly once');

let draining = false;
let releases = 0;
const manager: DeployDrainManager = {
  beginRoomDispatchDrain: () => {
    if (draining) return false;
    draining = true;
    return true;
  },
  endRoomDispatchDrain: () => {
    draining = false;
    releases++;
    return 0;
  },
  activeRoomRoundCount: () => 1,
  roomDispatchDrainPendingCount: () => 2,
};
const cancelled = await prepareDeployDrain(manager, 25, 5);
assert.deepEqual(cancelled, {
  ok: false,
  error: '部署已取消：会议室在途轮次 10 分钟内未清空',
  activeRounds: 1,
  deferredDispatches: 2,
});
assert.equal(draining, false, 'timed-out deploy must release drain instead of restarting');
assert.equal(releases, 1);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-deploy-drain-'));
const db = openDb(path.join(tempDir, 'hub.sqlite'));
const sse = new SseHub();
try {
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room', '会议室', 'api', 'room', ?)`)
    .run(JSON.stringify({ members: ['claude'] }));
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('claude', 'Claude', 'api', 'dm', '{}')`).run();
  const source = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta)
     VALUES ('room', 'user', 'user', 'text', '@claude durable', 'done', '{}')`,
  ).run();
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
  const room = db.prepare(`SELECT * FROM contacts WHERE id = 'room'`).get() as any;
  const claude = db.prepare(`SELECT * FROM contacts WHERE id = 'claude'`).get() as any;
  const agentManager = new AgentManager({ db, sse, config, vault: null, jobStore: null });
  const outcome = { normal: { spoke: 1, passed: 0, silent: 0, error: 0 }, reactions: [] };
  (agentManager as any).scheduleRoomRound = async () => outcome;
  assert.equal(agentManager.beginRoomDispatchDrain(), true);
  const tracked = agentManager.dispatchRoomMessageTracked(room, '@claude durable', {
    targetOverride: [claude],
    capture: false,
    userMessageId: Number(source.lastInsertRowid),
  });
  assert.equal(tracked.deferred, true);
  const deferredMeta = JSON.parse((db.prepare('SELECT meta FROM messages WHERE id = ?')
    .get(source.lastInsertRowid) as any).meta);
  assert.equal(deferredMeta.roomDispatch.status, 'deferred');
  agentManager.endRoomDispatchDrain();
  assert.deepEqual(await tracked.completion, outcome);
  await new Promise((resolve) => setImmediate(resolve));
  const doneMeta = JSON.parse((db.prepare('SELECT meta FROM messages WHERE id = ?')
    .get(source.lastInsertRowid) as any).meta);
  assert.equal(doneMeta.roomDispatch.status, 'done', 'released durable dispatch records completion');

  db.prepare(`UPDATE messages SET meta = json_set(meta, '$.roomDispatch.status', 'dispatching') WHERE id = ?`)
    .run(source.lastInsertRowid);
  const recoveredManager = new AgentManager({ db, sse, config, vault: null, jobStore: null });
  (recoveredManager as any).scheduleRoomRound = async () => outcome;
  assert.equal(recoveredManager.recoverDeferredRoomDispatches(), 1, 'restart recovers deferred or dispatching rows');
  await new Promise((resolve) => setImmediate(resolve));
  const recoveredMeta = JSON.parse((db.prepare('SELECT meta FROM messages WHERE id = ?')
    .get(source.lastInsertRowid) as any).meta);
  assert.equal(recoveredMeta.roomDispatch.status, 'done');
} finally {
  sse.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('deploy drain smoke: ok');
