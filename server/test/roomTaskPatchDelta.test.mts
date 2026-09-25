// P3: incremental review patch (patch_delta) — Worker collects patchSince..HEAD,
// execution_get pages it, and the cumulative patch stays untouched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type JobRow } from '../src/platform/db.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { boundedDeliveryMeta } from '../src/jobs/receiptFields.js';
import type { SseHub } from '../src/platform/sse.js';

const SHA = (ch: string) => ch.repeat(40);
const H1 = SHA('a');
const H2 = SHA('b');
const BASE = SHA('c');

const DELTA = `diff --git a/src/second.ts b/src/second.ts
new file mode 100644
--- /dev/null
+++ b/src/second.ts
@@ -0,0 +1 @@
+second-round-hunk
`;
const CUMULATIVE = `diff --git a/src/first.ts b/src/first.ts
new file mode 100644
--- /dev/null
+++ b/src/first.ts
@@ -0,0 +1 @@
+first-round-hunk
${DELTA}`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-cost-p3-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const jobs = new JobStore(db, { broadcast: () => {} } as unknown as SseHub);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(id, id, backend);
  }
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('r1', 'r1', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse', 'aye'], governance: 'open' }));
  const anchor = Number(db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
    VALUES ('r1', 'user', 'user', 'text', 'ok', 'done', '{}', 'main')`).run().lastInsertRowid);
  const dispatch = { dispatchToModule: () => ({ status: 'posted' as const }) };
  return { dir, db, jobs, anchor, dispatch };
}

async function toolCall(fx: ReturnType<typeof setup>, contact: string, moduleId: string, name: string, args: Record<string, unknown>) {
  const { db, jobs, dispatch } = fx;
  const turn = beginRoomTurn(db, { roomId: 'r1', moduleId, contactId: contact });
  try {
    const tool = buildRoomTaskTools(db, jobs, contact, dispatch as never, { readVaultTask: () => null },
      { roomId: 'r1', moduleId, turnId: turn.turnId }).find((item) => item.name === name)!;
    return tool.exec(args);
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

async function passAndStart(fx: ReturnType<typeof setup>, taskPath: string, objective: string): Promise<{ job: JobRow }> {
  const store = new RoomTaskStore(fx.db, fx.jobs, fx.dispatch as never);
  const task = store.getTask('r1', taskPath)!;
  const pass = await toolCall(fx, task.holder_module === 'plan' ? 'codex' : 'muse',
    task.holder_module ?? 'plan', 'task_pass', {
    room_id: 'r1', task_path: taskPath, to_module: 'execute', note: objective,
  });
  assert.equal(pass.ok, true, pass.text);
  const started = await toolCall(fx, 'muse', 'execute', 'execution_start', {
    room_id: 'r1', task_path: taskPath, module: 'execute',
    expected_revision: store.getTask('r1', taskPath)!.revision,
    workspace: fx.dir, objective,
  });
  assert.equal(started.ok, true, started.text);
  return { job: fx.jobs.get((JSON.parse(started.text) as { job: { id: string } }).job.id)! };
}

function finishLinked(fx: ReturnType<typeof setup>, taskPath: string, jobId: string, receipt: Record<string, unknown>, dispatch: unknown = null): void {
  const { db, jobs } = fx;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
  const meta = boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat-p3',
      head: H2,
      diffstat: '2 files changed, 2 insertions(+)',
      changedFiles: { files: ['src/first.ts', 'src/second.ts'], total: 2 },
      tests: [{ suite: 'unit', status: 'pass' }],
      ...receipt,
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'p3' },
  });
  const outcome = jobs.complete(jobs.get(jobId)!, 'done', 'simulated done', null, 'delivered', meta);
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  new RoomTaskStore(db, jobs, dispatch as never).handleJobFinished(jobs.get(jobId)!, { finalAttempt: true, actor: 'muse' });
  void taskPath;
}

test('P3: execution_start carries patchSince from the pinned candidate', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const created = await toolCall(fx, 'codex', 'plan', 'task_create', {
    room_id: 'r1', task_path: 'tasks/delta.md', title: 'P3', requirements: 'req',
    workspace: fx.dir, anchor_message_id: fx.anchor,
  });
  assert.equal(created.ok, true, created.text);
  // First round: no candidate pinned, no patchSince.
  const first = await passAndStart(fx, 'tasks/delta.md', 'first round');
  const firstOptions = JSON.parse(first.job.options) as Record<string, unknown>;
  assert.equal(firstOptions.patchSince, undefined);
  finishLinked(fx, 'tasks/delta.md', first.job.id, { patch: CUMULATIVE, patchChars: CUMULATIVE.length, patchTruncated: false });
  // Review pins H1 as the candidate; the next round must carry it as patchSince.
  fx.db.prepare('UPDATE room_tasks SET candidate_sha = ?, candidate_job_id = ? WHERE id = ?').run(H1, first.job.id, 'r1::tasks/delta.md');
  const second = await passAndStart(fx, 'tasks/delta.md', 'second round');
  const secondOptions = JSON.parse(second.job.options) as Record<string, unknown>;
  assert.equal(secondOptions.patchSince, H1);
});

test('P3: execution_get patch_delta pages the increment, patch stays cumulative', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const created = await toolCall(fx, 'codex', 'plan', 'task_create', {
    room_id: 'r1', task_path: 'tasks/delta.md', title: 'P3', requirements: 'req',
    workspace: fx.dir, anchor_message_id: fx.anchor,
  });
  assert.equal(created.ok, true, created.text);
  const { job } = await passAndStart(fx, 'tasks/delta.md', 'second round');
  finishLinked(fx, 'tasks/delta.md', job.id, {
    patch: CUMULATIVE, patchChars: CUMULATIVE.length, patchTruncated: false,
    patchBase: BASE, patchBaseKind: 'task-baseline',
    patchDelta: DELTA, patchDeltaChars: DELTA.length, patchDeltaTruncated: false,
    patchDeltaBase: H1,
  });
  const get = async (section: string, extra: Record<string, unknown> = {}) => {
    const out = await toolCall(fx, 'muse', 'execute', 'execution_get', {
      room_id: 'r1', task_path: 'tasks/delta.md', job_id: job.id, section, ...extra,
    });
    assert.equal(out.ok, true, out.text);
    return (JSON.parse(out.text) as { receiptPage: Record<string, unknown> }).receiptPage;
  };
  const delta = await get('patch_delta');
  assert.equal(delta.kind, 'patch_delta');
  assert.equal(delta.page, DELTA);
  assert.equal(delta.patchDeltaBase, H1);
  assert.equal(delta.patchTotalChars, DELTA.length);
  assert.deepEqual(delta.patchFiles, ['src/second.ts']);
  assert.equal(delta.patchAtEnd, true);
  const p1 = await get('patch_delta', { patch_limit: 10 });
  assert.equal((p1.page as string).length, 10);
  assert.equal(p1.patchNextOffset, 10);
  assert.equal(p1.patchAtEnd, false);
  assert.match(String((p1 as { hint: string }).hint), /patch_delta/);
  const full = await get('patch');
  assert.equal(full.kind, 'patch');
  assert.equal(full.page, CUMULATIVE);
});

test('P3: a clean rebase reads as an empty delta with the worker verdict, not as a missing one', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const created = await toolCall(fx, 'codex', 'plan', 'task_create', {
    room_id: 'r1', task_path: 'tasks/delta.md', title: 'P3', requirements: 'req',
    workspace: fx.dir, anchor_message_id: fx.anchor,
  });
  assert.equal(created.ok, true, created.text);
  const receipts: string[] = [];
  const { job } = await passAndStart(fx, 'tasks/delta.md', 'rebase round');
  finishLinked(fx, 'tasks/delta.md', job.id, {
    patch: CUMULATIVE, patchChars: CUMULATIVE.length, patchTruncated: false,
    patchBase: BASE, patchBaseKind: 'task-baseline-rebased',
    patchDelta: '', patchDeltaChars: 0, patchDeltaTruncated: false,
    patchDeltaBase: H1, patchDeltaKind: 'rebase-identical',
  }, { dispatchToModule: (_room: string, _module: string, _contact: string, content: string) => { receipts.push(content); return { status: 'posted' as const }; } });
  const out = await toolCall(fx, 'muse', 'execute', 'execution_get', {
    room_id: 'r1', task_path: 'tasks/delta.md', job_id: job.id, section: 'patch_delta',
  });
  assert.equal(out.ok, true, out.text);
  const page = (JSON.parse(out.text) as { receiptPage: Record<string, unknown> }).receiptPage;
  assert.equal(page.kind, 'patch_delta');
  assert.equal(page.page, '');
  assert.equal(page.patchDeltaKind, 'rebase-identical');
  assert.match(String(page.hint), /逐字一致/);
  assert.ok(receipts.some((content) => /干净 rebase/.test(content)), 'the receipt message carries the verdict so review need not read a diff');
});

test('P3: patch_delta without a collected delta returns an explicit empty state', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const created = await toolCall(fx, 'codex', 'plan', 'task_create', {
    room_id: 'r1', task_path: 'tasks/delta.md', title: 'P3', requirements: 'req',
    workspace: fx.dir, anchor_message_id: fx.anchor,
  });
  assert.equal(created.ok, true, created.text);
  const { job } = await passAndStart(fx, 'tasks/delta.md', 'first round');
  finishLinked(fx, 'tasks/delta.md', job.id, { patch: CUMULATIVE, patchChars: CUMULATIVE.length, patchTruncated: false });
  const out = await toolCall(fx, 'muse', 'execute', 'execution_get', {
    room_id: 'r1', task_path: 'tasks/delta.md', job_id: job.id, section: 'patch_delta',
  });
  assert.equal(out.ok, false);
  assert.match(out.text, /累计/);
});
