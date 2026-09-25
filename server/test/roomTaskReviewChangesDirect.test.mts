// R1 (cost batch 3): open-room review REQUEST_CHANGES starts the repair
// Worker directly — no execute chat wake; gate/failure fall back to the
// classic wake with no phantom job. Strict rooms keep the manual path.
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
const BASE = SHA('c');

const FINDINGS = 'MUST-1 修复空指针；通过条件：单测覆盖该分支且全绿';

function setup(governance?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-r1-'));
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
    const result = await tool.exec({ room_id: 'r1', task_path: 'tasks/r1.md', ...args });
    assert.equal(result.ok, true, `${name}: ${result.text}`);
    return JSON.parse(result.text);
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

/** Drive an open task to a finished implementation candidate; returns task + impl job ids. */
async function finishImpl(fx: ReturnType<typeof setup>) {
  const { dir, db, jobs, store, anchor } = fx;
  const created = await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'R1', requirements: 'req', workspace: dir, anchor_message_id: anchor,
  });
  const taskId: string = created.task.id;
  await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', { to_module: 'execute', note: 'go' });
  const started = await call(fx, 'muse', { roomId: 'r1', moduleId: 'execute', taskId }, 'execution_start', {
    module: 'execute', expected_revision: store.getTask('r1', 'tasks/r1.md')!.revision,
    workspace: dir, objective: 'impl',
  });
  const implJobId: string = started.job.id;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(implJobId);
  const outcome = jobs.complete(jobs.get(implJobId)!, 'done', 'simulated done', null, 'delivered', boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat/r1', head: H,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'r1' },
  }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  store.handleJobFinished(jobs.get(implJobId)!, { finalAttempt: true, actor: 'muse' });
  return { taskId, implJobId };
}

function repairJobs(fx: ReturnType<typeof setup>, taskId: string, candidateId: string) {
  return fx.store.linkedJobs(taskId).filter((job) => {
    try {
      const options = JSON.parse(job.options) as { closureKind?: unknown; roomTaskReturn?: unknown };
      return !options.closureKind && options.roomTaskReturn === 'review' && job.id !== candidateId;
    } catch { return false; }
  });
}

function eventKinds(fx: ReturnType<typeof setup>, taskId: string): string[] {
  return (fx.db.prepare('SELECT kind FROM room_task_events WHERE task_id = ? ORDER BY id ASC').all(taskId) as Array<{ kind: string }>)
    .map((row) => row.kind);
}

test('R1: REQUEST_CHANGES starts the repair Worker with no execute wake', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx);
  const wakesBefore = fx.wakes.filter((w) => w.module === 'execute').length;
  const review = await call(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: implJobId, candidate_sha: H,
    verdict: 'request_changes', findings: FINDINGS,
  });
  assert.equal(review.autoPass?.toModule, 'execute');
  assert.ok(review.autoPass?.jobId, `expected direct repair job, got ${JSON.stringify(review.autoPass)}`);
  assert.equal(review.autoPass.fallbackReason, undefined);
  const repairs = repairJobs(fx, taskId, implJobId);
  assert.equal(repairs.length, 1, 'exactly one repair job started');
  const job = fx.jobs.get(repairs[0].id)!;
  const options = JSON.parse(job.options) as Record<string, unknown>;
  assert.equal(options.patchSince, H, 'repair round carries patchSince');
  assert.match(job.prompt, /按评审 MUST 项返修/, 'objective carries the fixed preamble');
  assert.match(job.prompt, new RegExp(FINDINGS.slice(0, 12)), 'objective carries the findings verbatim');
  assert.match(job.prompt, /return_to=review/, 'repair returns to review');
  assert.equal(fx.wakes.filter((w) => w.module === 'execute').length, wakesBefore, 'no execute chat wake');
  const kinds = eventKinds(fx, taskId);
  assert.ok(kinds.includes('review-changes-requested'), kinds.join(','));
  assert.ok(kinds.includes('review-changes-auto-started'), kinds.join(','));
  assert.ok(!kinds.includes('review-changes-auto-start-fallback'), kinds.join(','));
  const fact = fx.db.prepare("SELECT content FROM messages WHERE meta LIKE '%room-task-review-changes-auto-start%'").get() as { content: string } | undefined;
  assert.ok(fact?.content.includes('【返修直接启动】'), fact?.content);
  const task = fx.store.getTask('r1', 'tasks/r1.md')!;
  assert.equal(task.holder_module, 'execute');
  assert.equal(task.review_status, 'changes_requested');
});

test('R1: tripped three-round gate falls back to the classic wake', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx);
  // Three execute rounds since the previous review verdict: the gate trips.
  for (let i = 0; i < 3; i += 1) {
    fx.db.prepare("INSERT INTO room_task_events (task_id, kind, actor, module, payload) VALUES (?, 'execution-started', 'muse', 'execute', ?)")
      .run(taskId, JSON.stringify({ jobId: `seed-${i}` }));
  }
  const wakesBefore = fx.wakes.filter((w) => w.module === 'execute').length;
  const review = await call(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: implJobId, candidate_sha: H,
    verdict: 'request_changes', findings: FINDINGS,
  });
  assert.ok(review.autoPass?.fallbackReason, `expected gate fallback, got ${JSON.stringify(review.autoPass)}`);
  assert.equal(review.autoPass?.jobId, undefined, 'no direct repair job on a tripped gate');
  assert.equal(repairJobs(fx, taskId, implJobId).length, 0);
  assert.ok(fx.wakes.filter((w) => w.module === 'execute').length > wakesBefore, 'classic execute wake posted');
  const kinds = eventKinds(fx, taskId);
  assert.ok(kinds.includes('review-changes-auto-start-fallback'), kinds.join(','));
  assert.ok(!kinds.includes('review-changes-auto-started'), kinds.join(','));
});

test('R1: direct-start failure records fallback and starts no phantom job', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx);
  // Decouple the execute contact: no frozen snapshot is available.
  fx.db.prepare("UPDATE contacts SET enabled = 0 WHERE id = 'muse'").run();
  const review = await call(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: implJobId, candidate_sha: H,
    verdict: 'request_changes', findings: FINDINGS,
  });
  assert.ok(review.autoPass?.fallbackReason ?? true, JSON.stringify(review.autoPass));
  assert.equal(review.autoPass?.jobId, undefined, 'no direct repair job on failure');
  const kinds = eventKinds(fx, taskId);
  assert.ok(kinds.includes('review-changes-auto-start-fallback') || kinds.includes('auto-pass-failed'), kinds.join(','));
  assert.ok(!kinds.includes('review-changes-auto-started'), kinds.join(','));
  assert.equal(repairJobs(fx, taskId, implJobId).length, 0, 'no phantom repair job');
});

test('R1: strict rooms keep the manual execute wake', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dir, db, jobs, store, anchor } = fx;
  // Strict ritual: task_create → handoff/accept → execution → handoff/accept.
  const created = await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'R1', requirements: 'req', workspace: dir, anchor_message_id: anchor,
  });
  const taskId: string = created.task.id;
  const h1 = await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_handoff', {
    actor_module: 'plan', to_module: 'execute', request: 'impl', evidence_refs: [],
  });
  const execCtx: RoomTaskToolContext = { roomId: 'r1', moduleId: 'execute', taskId, handoffId: h1.handoff.id };
  await call(fx, 'muse', execCtx, 'task_accept', {});
  const started = await call(fx, 'muse', execCtx, 'execution_start', {
    module: 'execute', expected_revision: store.getTask('r1', 'tasks/r1.md')!.revision,
    workspace: dir, objective: 'impl', return_to_module: 'plan', return_mode: 'notify',
  });
  const implJobId: string = started.job.id;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(implJobId);
  const outcome = jobs.complete(jobs.get(implJobId)!, 'done', 'simulated done', null, 'delivered', boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat/r1', head: H,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'r1' },
  }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  store.handleJobFinished(jobs.get(implJobId)!, { finalAttempt: true, actor: 'muse' });
  const h2 = await call(fx, 'muse', execCtx, 'task_handoff', {
    actor_module: 'execute', to_module: 'review', request: 'review H', evidence_refs: [implJobId],
  });
  const reviewCtx: RoomTaskToolContext = { roomId: 'r1', moduleId: 'review', taskId, handoffId: h2.handoff.id };
  await call(fx, 'aye', reviewCtx, 'task_accept', {});
  const wakesBefore = fx.wakes.length;
  const review = await call(fx, 'aye', reviewCtx, 'review_submit', {
    module: 'review', candidate_job_id: implJobId, candidate_sha: H,
    verdict: 'request_changes', findings: FINDINGS,
  });
  assert.equal(review.autoPass, undefined, 'strict rooms do not auto-pass');
  assert.equal(repairJobs(fx, taskId, implJobId).length, 0, 'no direct repair job in strict rooms');
  assert.equal(fx.wakes.length, wakesBefore, 'no wake either: the reviewer hands off explicitly');
  const kinds = eventKinds(fx, taskId);
  assert.ok(!kinds.includes('review-changes-auto-started'), kinds.join(','));
  assert.ok(!kinds.includes('review-changes-auto-start-fallback'), kinds.join(','));
});
