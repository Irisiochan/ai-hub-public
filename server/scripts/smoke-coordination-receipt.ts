import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type ContactRow, type JobRow } from '../src/db.js';
import { attachWorkerCompletion } from '../src/server.js';
import { JobStore } from '../src/workers/jobStore.js';
import {
  formatCoordinationReceipt,
  parseCoordinationMarker,
} from '../src/workers/coordinationReceipt.js';
import {
  coordinationRoomHealth,
  dispatchCoordinationRoomHost,
} from '../src/agents/coordinationRoom.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-coordination-receipt-'));
const db = openDb(path.join(dir, 'test.db'));
const broadcasts: unknown[] = [];
const sse = { broadcast: (_event: string, value: unknown) => broadcasts.push(value) } as any;
const store = new JobStore(db, sse);
const roomDispatches: Array<{ room: ContactRow; text: string; options: any }> = [];

db.prepare("INSERT INTO contacts (id, name, kind, backend) VALUES ('room', '会议室', 'room', 'api')").run();
db.prepare("INSERT INTO contacts (id, name, kind, backend) VALUES ('claude', 'Claude', 'dm', 'claude-cli')").run();
db.prepare("INSERT INTO contacts (id, name, kind, backend) VALUES ('codex', 'Codex', 'dm', 'codex')").run();
const room = db.prepare("SELECT * FROM contacts WHERE id = 'room'").get() as ContactRow;
const claude = db.prepare("SELECT * FROM contacts WHERE id = 'claude'").get() as ContactRow;
const codex = db.prepare("SELECT * FROM contacts WHERE id = 'codex'").get() as ContactRow;
const fallbackEnqueues: Array<{ contactId: string; input: any }> = [];

const manager = {
  imageRoomMembers: (value: ContactRow) => value.id === room.id ? [claude, codex] : [],
  dispatchRoomMessageTracked: (value: ContactRow, text: string, options: any) => {
    roomDispatches.push({ room: value, text, options });
    return {
      targets: options.targetOverride.map((item: ContactRow) => item.id),
      completion: Promise.resolve({ normal: { spoke: 1, passed: 0 }, reactions: [] }),
    };
  },
  get: (contact: ContactRow) => ({
    enqueue: (input: any) => {
      fallbackEnqueues.push({ contactId: contact.id, input });
      return 'queued';
    },
  }),
} as any;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

attachWorkerCompletion({
  db,
  jobStore: store,
  manager,
  logger,
  sse,
  vault: null,
} as any);

const planHash = 'a'.repeat(64);
const prompt = [
  '[AI_HUB_COORDINATION_V1]',
  'taskPath=tasks/demo.md',
  `planHash=${planHash}`,
  '只执行任务文件 Plan。',
].join('\n');
const marker = parseCoordinationMarker(prompt);
assert.deepEqual(marker, { taskPath: 'tasks/demo.md', planHash });
assert.equal(parseCoordinationMarker(prompt.replace(planHash, 'bad')), null);
const dispatchKey = `coordination:tasks/demo.md:${planHash}`;
db.prepare(
  `INSERT INTO messages
     (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
   VALUES ('room', 'room-host', 'user', 'text', '@codex 工作对接派单', 'done', '{}', 'main', ?)`
).run(dispatchKey);

const created = store.create({
  requestedBy: 'codex',
  runner: 'codex',
  workspace: 'C:/ai-hub-codex',
  prompt,
  permissions: { write: true, shell: true, ssh: false },
  originContactId: 'codex',
  originAnchorId: 42,
});
if ('error' in created) throw new Error(created.error);
db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(created.job.id);
const running = store.get(created.job.id) as JobRow;
const first = store.complete(
  running,
  'done',
  'worker tests 101/101 PASS',
  null,
  'delivered',
  JSON.stringify({
    branch: 'coordination-demo',
    head: 'abc123def456',
    ahead: 0,
    dirtyFiles: [],
    declared: { summary: 'worker npm test 101/101 PASS' },
  }),
);
assert.deepEqual(first, { status: 'done', changed: true });
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(roomDispatches.length, 1);
assert.equal(roomDispatches[0].room.id, 'room');
assert.deepEqual(roomDispatches[0].options.targetOverride.map((item: ContactRow) => item.id), ['claude']);
assert.equal(roomDispatches[0].options.capture, false);
assert.equal(roomDispatches[0].options.reactionRounds, 0);
assert.match(roomDispatches[0].text, /@claude 工作对接回执/);
assert.match(roomDispatches[0].text, /tasks\/demo\.md/);
assert.match(roomDispatches[0].text, /branch=coordination-demo/);
assert.match(roomDispatches[0].text, /101\/101 PASS/);
assert.match(roomDispatches[0].text, /Recall 全文：调用 worker_job_status/);

const message = db.prepare(
  "SELECT * FROM messages WHERE contact_id = 'room' AND sender = 'room-host' ORDER BY id DESC LIMIT 1"
).get() as any;
assert.ok(message);
assert.equal(message.origin, 'main');
assert.equal(JSON.parse(message.meta).roomHost.coordination.jobId, created.job.id);
assert.equal(JSON.parse(message.meta).roomHost.coordination.originAnchorId, 42);
assert.deepEqual(JSON.parse(message.meta).roomHost.receipt, {
  jobId: created.job.id,
  requestedBy: 'codex',
  status: 'done',
  deliveryState: 'delivered',
});
assert.equal(created.job.origin_contact_id, 'codex', 'job origin is a DM, not the dispatch room');

const second = store.complete(running, 'done', 'duplicate', null, 'delivered', '{}');
assert.deepEqual(second, { status: 'done', changed: false });
assert.equal(roomDispatches.length, 1, 'terminal retry must not duplicate room receipt');
assert.ok(broadcasts.length > 0);

const formatted = formatCoordinationReceipt(store.get(created.job.id)!, marker!);
assert.match(formatted, /Plan hash/);

const blockedPlanHash = 'b'.repeat(64);
const blockedPrompt = [
  '[AI_HUB_COORDINATION_V1]',
  'taskPath=tasks/blocked-demo.md',
  `planHash=${blockedPlanHash}`,
  '只执行任务文件 Plan。',
].join('\n');
db.prepare(
  `INSERT INTO messages
     (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
   VALUES ('room', 'room-host', 'user', 'text', '@codex 工作对接派单', 'done', '{}', 'main', ?)`
).run(`coordination:tasks/blocked-demo.md:${blockedPlanHash}`);
const blockedCreated = store.create({
  requestedBy: 'codex',
  runner: 'codex',
  workspace: 'C:/ai-hub-codex',
  prompt: blockedPrompt,
  permissions: { write: true, shell: true, ssh: false },
  originContactId: 'codex',
  originAnchorId: 84,
});
if ('error' in blockedCreated) throw new Error(blockedCreated.error);
db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(blockedCreated.job.id);
const blockedRunning = store.get(blockedCreated.job.id) as JobRow;
const blocked = store.complete(
  blockedRunning,
  'blocked',
  'validation passed; exact-target push approval pending',
  null,
  'blocked_unpushed',
  JSON.stringify({
    branch: 'blocked-demo',
    head: 'deadbeef1234',
    ahead: 1,
    dirtyFiles: [],
    declared: { summary: 'worker npm test PASS; push pending' },
  }),
);
assert.deepEqual(blocked, { status: 'blocked', changed: true });
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(roomDispatches.length, 2, 'blocked terminal job must also post a room receipt');
assert.equal(roomDispatches[1].room.id, 'room');
assert.match(roomDispatches[1].text, /tasks\/blocked-demo\.md/);
assert.match(roomDispatches[1].text, /blocked \/ blocked_unpushed/);
assert.match(roomDispatches[1].text, /read_file\("tasks\/worker-tail-/);
const blockedMessage = db.prepare(
  "SELECT * FROM messages WHERE contact_id = 'room' AND sender = 'room-host' ORDER BY id DESC LIMIT 1"
).get() as any;
const broadcastsBeforeResolution = broadcasts.length;

const resolved = store.resolveBlockedOutOfBand(
  store.get(blockedCreated.job.id)!,
  'User',
  { mode: 'manual' },
);
assert.equal('job' in resolved && resolved.job.status, 'done');
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(roomDispatches.length, 2, 'one job lifecycle must keep one full room receipt');
const updatedBlockedMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(blockedMessage.id) as any;
const updatedBlockedMeta = JSON.parse(updatedBlockedMessage.meta);
assert.equal(updatedBlockedMessage.id, blockedMessage.id);
assert.match(updatedBlockedMessage.content, /状态更新 \d{2}:\d{2}：场外接力成果已经进入主分支，等待部署与线上验收。/);
assert.deepEqual(updatedBlockedMeta.roomHost.receipt.stateUpdates, [{
  at: updatedBlockedMeta.roomHost.receipt.stateUpdates[0].at,
  status: 'done',
  deliveryState: 'delivered_out_of_band',
  summary: '场外接力成果已经进入主分支，等待部署与线上验收。',
}]);
assert.match(updatedBlockedMeta.roomHost.receipt.stateUpdates[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
assert.ok(
  broadcasts.slice(broadcastsBeforeResolution).some((value: any) => value?.id === blockedMessage.id),
  'state update must rebroadcast the original receipt message id',
);

const ordinaryCreated = store.create({
  requestedBy: 'codex',
  runner: 'codex',
  workspace: 'C:/ai-hub-codex',
  prompt: '普通非 coordination worker 任务',
  permissions: { write: true, shell: true, ssh: false },
  originContactId: 'codex',
  originAnchorId: 126,
});
if ('error' in ordinaryCreated) throw new Error(ordinaryCreated.error);
db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(ordinaryCreated.job.id);
const ordinaryRunning = store.get(ordinaryCreated.job.id) as JobRow;
store.complete(ordinaryRunning, 'done', 'ordinary PASS', null, 'delivered', JSON.stringify({
  branch: 'ordinary', head: 'feedface1234', ahead: 0, dirtyFiles: [],
}));
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(roomDispatches.length, 3, 'ordinary terminal jobs should post to the coordination room');
assert.deepEqual(roomDispatches[2].options.targetOverride.map((item: ContactRow) => item.id), ['codex']);
assert.equal(roomDispatches[2].options.capture, false);
assert.equal(roomDispatches[2].options.reactionRounds, 0);
assert.match(roomDispatches[2].text, /⚙ Worker 任务回执/);
assert.match(
  roomDispatches[2].text,
  /请按 preview 验收；需要逐项证据时先 recall 完整回执。/,
);
assert.doesNotMatch(roomDispatches[2].text, /网关自动通知|User 也看得到这条|请直接给出验收结论/);
const ordinaryMessage = db.prepare(
  "SELECT * FROM messages WHERE contact_id = 'room' AND sender = 'room-host' ORDER BY id DESC LIMIT 1"
).get() as any;
assert.deepEqual(JSON.parse(ordinaryMessage.meta).roomHost.receipt, {
  jobId: ordinaryCreated.job.id,
  requestedBy: 'codex',
  status: 'done',
  deliveryState: 'delivered',
});

await new Promise<void>((resolve) => setImmediate(resolve));
assert.deepEqual(coordinationRoomHealth(db), {
  total: 3,
  receipts: 3,
});

db.prepare("UPDATE contacts SET config = ? WHERE id = 'room'")
  .run(JSON.stringify({ coordination: { enabled: false }, members: ['claude', 'codex'] }));
const fallbackCreated = store.create({
  requestedBy: 'codex',
  runner: 'codex',
  workspace: 'C:/ai-hub-codex',
  prompt: 'coordination disabled fallback',
  permissions: { write: true, shell: true, ssh: false },
  originContactId: 'codex',
  originAnchorId: 168,
});
if ('error' in fallbackCreated) throw new Error(fallbackCreated.error);
db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(fallbackCreated.job.id);
store.complete(store.get(fallbackCreated.job.id) as JobRow, 'done', 'fallback PASS', null, 'delivered', '{}');
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(roomDispatches.length, 3, 'disabled room must not add another room dispatch');
assert.equal(fallbackEnqueues.length, 1);
assert.equal(fallbackEnqueues[0].contactId, 'codex');
const fallbackMessage = db.prepare(
  "SELECT * FROM messages WHERE contact_id = 'codex' AND origin = 'main' ORDER BY id DESC LIMIT 1"
).get() as any;
assert.equal(JSON.parse(fallbackMessage.meta).event, 'worker-receipt');
assert.match(fallbackMessage.content, /^【降级投递：会议室不可用】/);
assert.match(fallbackMessage.content, /⚙ Worker 任务回执/);
assert.doesNotMatch(fallbackMessage.content, /网关自动通知|User 也看得到这条|请直接给出验收结论/);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('[PASS] worker receipts route to the coordination room with visible DM main fallback');
