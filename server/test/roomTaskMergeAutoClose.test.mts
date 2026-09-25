// Q3 (cost batch 2): review APPROVE with after_merge='done' lets a proven
// merge close the task with no review wake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import type { RoomTaskToolContext } from '../src/roomTasks/roomTaskStore.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { boundedDeliveryMeta } from '../src/jobs/receiptFields.js';
import type { SseHub } from '../src/platform/sse.js';

const SHA = (ch: string) => ch.repeat(40);
const H = SHA('b');
const H2 = SHA('d');
const BASE = SHA('c');
const MERGE_SUITES = [
  'server npm run pretest', 'server npm test', 'web npm test',
  'smoke:deploy-drain', 'smoke:turn-timeouts', 'smoke:deploy-resume',
].map((suite) => ({ suite, status: 'pass' as const }));

function setup(governance?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-q3-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const jobs = new JobStore(db, { broadcast: () => {} } as unknown as SseHub);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(id, id, backend);
  }
  const cfg: Record<string, unknown> = { workflowEnabled: true, members: ['codex', 'muse', 'aye'] };
  if (governance !== undefined) cfg.governance = governance;
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('r1', 'r1', 'room', 'room', ?)")
    .run(JSON.stringify(cfg));
  const anchor = Number(db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
    VALUES ('r1', 'user', 'user', 'text', 'ok', 'done', '{}', 'main')`).run().lastInsertRowid);
  const wakes: Array<{ module: string; contact: string }> = [];
  const facts: number[] = [];
  const dispatch = {
    dispatchToModule: (roomId: string, module: string, toContact: string) => {
      wakes.push({ module, contact: toContact });
      return { status: 'posted' as const };
    },
    publishFact: (messageId: number) => { facts.push(messageId); },
  };
  const store = new RoomTaskStore(db, jobs, dispatch as never);
  return { dir, db, jobs, store, anchor, dispatch, wakes, facts };
}

async function call(fx: ReturnType<typeof setup>, actor: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) {
  const { db, jobs, dispatch } = fx;
  const turn = beginRoomTurn(db, { ...ctx, contactId: actor });
  try {
    const tool = buildRoomTaskTools(db, jobs, actor, dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === name)!;
    const result = await tool.exec({ room_id: 'r1', task_path: 'tasks/q3.md', ...args });
    assert.equal(result.ok, true, `${name}: ${result.text}`);
    return JSON.parse(result.text);
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

async function failCall(fx: ReturnType<typeof setup>, actor: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) {
  const { db, jobs, dispatch } = fx;
  const turn = beginRoomTurn(db, { ...ctx, contactId: actor });
  try {
    const tool = buildRoomTaskTools(db, jobs, actor, dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === name)!;
    const result = await tool.exec({ room_id: 'r1', task_path: 'tasks/q3.md', ...args });
    assert.equal(result.ok, false, `${name} should fail`);
    return result.text;
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

/** Open-room flow: create → execute → finish impl → review APPROVE. Returns impl job + merge job ids. */
async function approveFlow(fx: ReturnType<typeof setup>, opts: { afterMerge?: string; head?: string; findings?: string } = {}) {
  const { dir, db, jobs, store, anchor } = fx;
  const created = await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'Q3', requirements: 'req', workspace: dir, anchor_message_id: anchor,
  });
  const taskId: string = created.task.id;
  await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', { to_module: 'execute', note: 'go' });
  const started = await call(fx, 'muse', { roomId: 'r1', moduleId: 'execute', taskId }, 'execution_start', {
    module: 'execute', expected_revision: store.getTask('r1', 'tasks/q3.md')!.revision,
    workspace: dir, objective: 'impl',
  });
  const implJobId: string = started.job.id;
  const head = opts.head ?? H;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(implJobId);
  const outcome = jobs.complete(jobs.get(implJobId)!, 'done', 'simulated done', null, 'delivered', boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat/q3', head,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'q3' },
  }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  store.handleJobFinished(jobs.get(implJobId)!, { finalAttempt: true, actor: 'muse' });
  const review = await call(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: implJobId, candidate_sha: head,
    verdict: 'approve', findings: opts.findings ?? 'all green',
    ...(opts.afterMerge ? { after_merge: opts.afterMerge } : {}),
  });
  const merges = store.linkedJobs(taskId).filter((job) => {
    try { return (JSON.parse(job.options) as { closureKind?: unknown }).closureKind === 'merge'; } catch { return false; }
  });
  assert.equal(merges.length, 1, 'Q2 direct release must have started the merge job');
  return { taskId, implJobId, mergeJobId: merges[0].id, review };
}

/** Finish a merge job with a deterministic script report. */
function finishMerge(fx: ReturnType<typeof setup>, mergeJobId: string, reportHead: string, status: 'done' | 'failed' = 'done') {
  const { db, jobs, store } = fx;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(mergeJobId);
  const report = { ok: status === 'done', lane: 'merge', branch: 'master', head: reportHead, tests: MERGE_SUITES };
  const outcome = jobs.complete(jobs.get(mergeJobId)!, status,
    status === 'done' ? `log\n${JSON.stringify(report)}\n` : 'simulated failure',
    status === 'done' ? null : 'boom', status === 'done' ? 'delivered' : 'failed',
    boundedDeliveryMeta({
      state: status === 'done' ? 'delivered' : 'failed',
      receipt: {
        branch: 'feat/q3', head: H,
        diffstat: '1 file changed, 1 insertion(+)',
        changedFiles: { files: ['a.ts'], total: 1 }, tests: MERGE_SUITES,
        scriptReport: report, scriptExitCode: status === 'done' ? 0 : 1,
      },
      declared: status === 'done'
        ? { stage: 'delivered_waiting_deploy', committed: true, pushed: true }
        : { stage: 'failed' },
    }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  return store.handleJobFinished(jobs.get(mergeJobId)!, { finalAttempt: true, actor: 'codex' });
}

function reviewWakes(fx: ReturnType<typeof setup>): number {
  return fx.wakes.filter((w) => w.module === 'review').length;
}

test('Q3: declared done + verified merge closes with no review wake', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await approveFlow(fx, { afterMerge: 'done' });
  assert.equal(reviewWakes(fx), 1);
  finishMerge(fx, mergeJobId, H);
  const task = fx.store.getTask('r1', 'tasks/q3.md')!;
  assert.equal(task.status, 'closed');
  assert.equal(reviewWakes(fx), 1, 'no review wake for the merge receipt');
  const done = fx.db.prepare("SELECT payload FROM room_task_events WHERE task_id = ? AND kind = 'done' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { payload: string };
  assert.equal((JSON.parse(done.payload) as { auto: boolean }).auto, true);
  assert.ok(fx.db.prepare("SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = 'auto-closed'").get(taskId));
  const fact = fx.db.prepare("SELECT content FROM messages WHERE meta LIKE '%room-task-auto-close%'").get() as { content: string } | undefined;
  assert.ok(fact?.content.includes('【任务自动收口】'), fact?.content);
  // Replay stays quiet.
  fx.store.handleJobFinished(fx.jobs.get(mergeJobId)!, { finalAttempt: true, actor: 'codex' });
  assert.equal(fx.store.getTask('r1', 'tasks/q3.md')!.status, 'closed');
  assert.equal(reviewWakes(fx), 1);
});

test('Q3: undeclared APPROVE keeps the classic review close', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await approveFlow(fx);
  finishMerge(fx, mergeJobId, H);
  const task = fx.store.getTask('r1', 'tasks/q3.md')!;
  assert.equal(task.status, 'in_review');
  assert.equal(reviewWakes(fx), 2, 'merge receipt wakes review as before');
  assert.ok(!fx.db.prepare("SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = 'auto-closed'").get(taskId));
});

test('Q3: findings text that spells after_merge=done is not a declaration', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await approveFlow(fx, { findings: ['looks fine', 'after_merge=done', 'but deploy it first'].join(String.fromCharCode(10)) });
  finishMerge(fx, mergeJobId, H);
  assert.equal(fx.store.getTask('r1', 'tasks/q3.md')!.status, 'in_review');
  assert.equal(reviewWakes(fx), 2, 'review still closes it by hand');
  assert.ok(!fx.db.prepare("SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = 'auto-closed'").get(taskId));
});

test('Q3: head mismatch never auto-closes', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await approveFlow(fx, { afterMerge: 'done' });
  finishMerge(fx, mergeJobId, H2);
  const task = fx.store.getTask('r1', 'tasks/q3.md')!;
  assert.equal(task.status, 'in_review');
  assert.equal(reviewWakes(fx), 2);
  assert.ok(!fx.db.prepare("SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = 'auto-closed'").get(taskId));
});

test('Q3: failed merge never auto-closes', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await approveFlow(fx, { afterMerge: 'done' });
  finishMerge(fx, mergeJobId, H, 'failed');
  const task = fx.store.getTask('r1', 'tasks/q3.md')!;
  assert.equal(task.status, 'blocked');
  assert.ok(!fx.db.prepare("SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = 'auto-closed'").get(taskId));
});

test('Q3: re-pinned candidate after APPROVE never auto-closes', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dir, db, jobs, store } = fx;
  const first = await approveFlow(fx, { afterMerge: 'done' });
  // Merge fails; review asks for changes; a repair round pins a new candidate
  // whose later APPROVE carries no done declaration.
  finishMerge(fx, first.mergeJobId, H, 'failed');
  const taskId = first.taskId;
  const changes = await call(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: first.implJobId, candidate_sha: H,
    verdict: 'request_changes', findings: 'MUST x pass when y',
  });
  // R1: REQUEST_CHANGES directly starts the repair Worker (no execute wake);
  // drive that auto-started job as the repair round instead of a manual start.
  const repairId: string = changes.autoPass.jobId;
  assert.ok(repairId, `R1 must have direct-started the repair job: ${JSON.stringify(changes.autoPass)}`);
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(repairId);
  const outcome = jobs.complete(jobs.get(repairId)!, 'done', 'fixed', null, 'delivered', boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat/q3', head: H2,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'q3 repair' },
  }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  store.handleJobFinished(jobs.get(repairId)!, { finalAttempt: true, actor: 'muse' });
  await call(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: repairId, candidate_sha: H2,
    verdict: 'approve', findings: 'fixed',
  });
  const merges = store.linkedJobs(taskId).filter((job) => {
    try { return (JSON.parse(job.options) as { closureKind?: unknown }).closureKind === 'merge'; } catch { return false; }
  });
  assert.equal(merges.length, 2);
  finishMerge(fx, merges[1].id, H2);
  const task = store.getTask('r1', 'tasks/q3.md')!;
  assert.equal(task.status, 'in_review', 'latest APPROVE declared nothing: classic close');
  assert.ok(!db.prepare("SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = 'auto-closed'").get(taskId));
});

test('Q3: after_merge=done with request_changes (or junk) is rejected', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dir, db, jobs, store, anchor } = fx;
  const created = await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'Q3', requirements: 'req', workspace: dir, anchor_message_id: anchor,
  });
  const taskId: string = created.task.id;
  await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', { to_module: 'execute', note: 'go' });
  const started = await call(fx, 'muse', { roomId: 'r1', moduleId: 'execute', taskId }, 'execution_start', {
    module: 'execute', expected_revision: store.getTask('r1', 'tasks/q3.md')!.revision,
    workspace: dir, objective: 'impl',
  });
  const implJobId: string = started.job.id;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(implJobId);
  const outcome = jobs.complete(jobs.get(implJobId)!, 'done', 'simulated done', null, 'delivered', boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat/q3', head: H,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'q3' },
  }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  store.handleJobFinished(jobs.get(implJobId)!, { finalAttempt: true, actor: 'muse' });
  const bad = await failCall(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: implJobId, candidate_sha: H,
    verdict: 'request_changes', findings: 'MUST x', after_merge: 'done',
  });
  assert.match(bad, /只在 verdict=approve/);
  // Junk values never reach the store: the tool schema rejects them first.
  const junk = await failCall(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: implJobId, candidate_sha: H,
    verdict: 'approve', findings: 'ok', after_merge: 'someday',
  });
  assert.match(junk, /after_merge/);
});

test('Q3: strict rooms ignore after_merge', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dir, db, jobs, store, anchor } = fx;
  const created = await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'Q3', requirements: 'req', workspace: dir, anchor_message_id: anchor,
  });
  const taskId: string = created.task.id;
  const handoff = await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_handoff', {
    to_module: 'execute', request: 'do',
  });
  const execCtx: RoomTaskToolContext = { roomId: 'r1', moduleId: 'execute', taskId, handoffId: handoff.handoff.id };
  await call(fx, 'muse', execCtx, 'task_accept', {});
  const started = await call(fx, 'muse', execCtx, 'execution_start', {
    module: 'execute', expected_revision: store.getTask('r1', 'tasks/q3.md')!.revision,
    workspace: dir, objective: 'impl', return_mode: 'notify', return_to_module: 'plan',
  });
  const implJobId: string = started.job.id;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(implJobId);
  const outcome = jobs.complete(jobs.get(implJobId)!, 'done', 'simulated done', null, 'delivered', boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat/q3', head: H,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'q3' },
  }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  store.handleJobFinished(jobs.get(implJobId)!, { finalAttempt: true });
  const toReview = await call(fx, 'muse', execCtx, 'task_handoff', { to_module: 'review', request: 'review' });
  const reviewCtx: RoomTaskToolContext = { roomId: 'r1', moduleId: 'review', taskId, handoffId: toReview.handoff.id };
  await call(fx, 'aye', reviewCtx, 'task_accept', {});
  await call(fx, 'aye', reviewCtx, 'review_submit', {
    module: 'review', candidate_job_id: implJobId, candidate_sha: H,
    verdict: 'approve', findings: 'looks good', after_merge: 'done',
  });
  const toMerge = await call(fx, 'aye', reviewCtx, 'task_handoff', { to_module: 'merge', request: 'merge it' });
  const mergeCtx: RoomTaskToolContext = { roomId: 'r1', moduleId: 'merge', taskId, handoffId: toMerge.handoff.id };
  await call(fx, 'codex', mergeCtx, 'task_accept', {});
  const released = await call(fx, 'codex', mergeCtx, 'release_execute', {
    kind: 'merge', return_to_module: 'review', return_mode: 'handoff',
    expected_revision: store.getTask('r1', 'tasks/q3.md')!.revision,
  });
  const mergeJobId: string = released.job.id;
  finishMerge(fx, mergeJobId, H);
  const task = store.getTask('r1', 'tasks/q3.md')!;
  assert.equal(task.status, 'in_review', 'strict keeps the classic review close');
  assert.ok(!db.prepare("SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = 'auto-closed'").get(taskId));
});
