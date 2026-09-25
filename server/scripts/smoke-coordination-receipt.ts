import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type ContactRow, type JobRow } from '../src/platform/db.js';
import { attachWorkerCompletion } from '../src/server.js';
import { JobStore, OUTBOX_MAX_ATTEMPTS } from '../src/jobs/jobStore.js';
import {
  formatCoordinationReceipt,
  parseCoordinationMarker,
} from '../src/jobs/coordinationReceipt.js';

// Model-driven workflow: completion alone creates zero wakes. Legacy jobs
// keep stored results plus an in-place receipt state update; no new
// room-host dispatches, no DM fallback. Task-ledger jobs fold into their
// task (covered by roomTaskModelDriven.test.mts).
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
  config: {},
} as any);

const drainAll = async (jobId: string): Promise<void> => {
  for (let attempt = 0; attempt <= OUTBOX_MAX_ATTEMPTS; attempt += 1) {
    const outbox = db.prepare(
      "SELECT status, next_attempt_at FROM job_outbox WHERE job_id = ? AND kind = 'finished'"
    ).get(jobId) as { status: string; next_attempt_at: number } | undefined;
    if (!outbox || outbox.status !== 'pending') break;
    await store.drainOutboxOnce(Math.max(Date.now(), outbox.next_attempt_at + 1));
  }
};

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

const messageCount = () => (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;

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
const before = messageCount();
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
await drainAll(created.job.id);
assert.equal(roomDispatches.length, 0, 'completion alone must not dispatch new room receipts');
assert.equal(messageCount(), before, 'completion alone must not insert new messages');
assert.equal(fallbackEnqueues.length, 0, 'degraded DM fallback is retired');

const second = store.complete(running, 'done', 'duplicate', null, 'delivered', '{}');
assert.deepEqual(second, { status: 'done', changed: false });
assert.equal(roomDispatches.length, 0, 'terminal retry must not dispatch either');

const formatted = formatCoordinationReceipt(store.get(created.job.id)!, marker!);
assert.match(formatted, /Plan hash/);

// In-place receipt update still works for pre-existing receipt rows.
const withReceipt = store.create({
  requestedBy: 'codex',
  runner: 'codex',
  workspace: 'C:/ai-hub-codex',
  prompt: '普通非 coordination worker 任务',
  permissions: { write: true, shell: true, ssh: false },
  originContactId: 'codex',
  originAnchorId: 126,
});
if ('error' in withReceipt) throw new Error(withReceipt.error);
db.prepare(
  `INSERT INTO messages
    (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
   VALUES ('room', 'room-host', 'user', 'text', '旧回执', 'done', ?, 'main', ?)`
).run(JSON.stringify({ roomHost: { receipt: { jobId: withReceipt.job.id } } }), `receipt:v1:${withReceipt.job.id}`);
const receiptRow = db.prepare(
  'SELECT * FROM messages WHERE idempotency_key = ?'
).get(`receipt:v1:${withReceipt.job.id}`) as any;
db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(withReceipt.job.id);
store.complete(store.get(withReceipt.job.id) as JobRow, 'done', 'ordinary PASS', null, 'delivered', JSON.stringify({
  branch: 'ordinary', head: 'feedface1234', ahead: 0, dirtyFiles: [],
}));
await drainAll(withReceipt.job.id);
assert.equal(roomDispatches.length, 0, 'in-place receipt update must not dispatch');
const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(receiptRow.id) as any;
assert.equal(updated.id, receiptRow.id, 'receipt update edits the same row');
assert.match(updated.content, /状态更新 \d{2}:\d{2}：/);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('[PASS] completion alone creates zero wakes; pre-existing receipts update in place');
