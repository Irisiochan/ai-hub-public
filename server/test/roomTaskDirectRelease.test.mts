// Q2 (cost batch 2): open-room review APPROVE starts the merge closure
// directly — no merge chat wake; gates shared with release_execute.
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

function setup(governance?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-q2-'));
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
    const result = await tool.exec({ room_id: 'r1', task_path: 'tasks/q2.md', ...args });
    assert.equal(result.ok, true, `${name}: ${result.text}`);
    return JSON.parse(result.text);
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

/** Drive a task to an approved candidate; returns the implementation job id. */
async function approveCandidate(fx: ReturnType<typeof setup>, opts: { baseline?: boolean } = {}) {
  const { dir, db, jobs, store, anchor } = fx;
  const created = await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'Q2', requirements: 'req', workspace: dir, anchor_message_id: anchor,
  });
  const taskId: string = created.task.id;
  await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', {
    to_module: 'execute', note: 'go',
  });
  const started = await call(fx, 'muse', { roomId: 'r1', moduleId: 'execute', taskId }, 'execution_start', {
    module: 'execute', expected_revision: store.getTask('r1', 'tasks/q2.md')!.revision,
    workspace: dir, objective: 'impl',
  });
  const jobId: string = started.job.id;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
  const outcome = jobs.complete(jobs.get(jobId)!, 'done', 'simulated done', null, 'delivered', boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat/q2', head: H,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
    },
    ...(opts.baseline === false ? {} : { before: { head: BASE } }),
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'q2' },
  }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  store.handleJobFinished(jobs.get(jobId)!, { finalAttempt: true, actor: 'muse' });
  const review = await call(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: jobId, candidate_sha: H,
    verdict: 'approve', findings: 'all green',
  });
  return { taskId, jobId, review };
}

function mergeJobs(fx: ReturnType<typeof setup>, taskId: string) {
  return fx.store.linkedJobs(taskId).filter((job) => {
    try { return (JSON.parse(job.options) as { closureKind?: unknown }).closureKind === 'merge'; } catch { return false; }
  });
}

function eventKinds(fx: ReturnType<typeof setup>, taskId: string): string[] {
  return (fx.db.prepare('SELECT kind FROM room_task_events WHERE task_id = ? ORDER BY id ASC').all(taskId) as Array<{ kind: string }>)
    .map((row) => row.kind);
}

test('Q2: APPROVE starts the merge closure with no merge chat wake', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, review } = await approveCandidate(fx);
  assert.ok(review.autoRelease?.jobId, `expected direct autoRelease, got ${JSON.stringify(review)}`);
  assert.equal(review.autoRelease.fallbackReason, undefined);
  const merges = mergeJobs(fx, taskId);
  assert.equal(merges.length, 1);
  const options = JSON.parse(merges[0].options) as Record<string, unknown>;
  assert.equal(options.closureKind, 'merge');
  assert.equal(options.frozenSha, H);
  assert.ok(options.closureCommand, 'merge job carries closureCommand');
  // No merge chat seat was woken (review callback wake is the only wake).
  assert.deepEqual(fx.wakes.filter((w) => w.module === 'merge'), []);
  assert.ok(fx.wakes.some((w) => w.module === 'review'), 'implementation callback still woke review');
  // Distinguishable event, existing release-started untouched (none here).
  const kinds = eventKinds(fx, taskId);
  assert.ok(kinds.includes('release-auto-started'), kinds.join(','));
  assert.ok(!kinds.includes('release-started'), kinds.join(','));
  const autoStart = fx.db.prepare("SELECT payload FROM room_task_events WHERE task_id = ? AND kind = 'release-auto-started' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { payload: string };
  assert.equal((JSON.parse(autoStart.payload) as { initiatedBy: string }).initiatedBy, 'aye');
  // System fact posted, merge seat never woken.
  const fact = fx.db.prepare("SELECT content FROM messages WHERE meta LIKE '%room-task-release-auto-start%'").get() as { content: string } | undefined;
  assert.ok(fact?.content.includes('【合入直接启动】'), fact?.content);
  assert.equal(fx.facts.length, 1);
  // Baton sits with merge, task in_review.
  const task = fx.store.getTask('r1', 'tasks/q2.md')!;
  assert.equal(task.holder_module, 'merge');
  assert.equal(task.status, 'in_review');
});

test('Q2: gate refusal falls back to waking the merge seat, never blocking', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  // No baseline evidence: review APPROVE passes, mergeGates refuses.
  const { taskId, review } = await approveCandidate(fx, { baseline: false });
  assert.ok(review.autoRelease?.fallbackReason, `expected fallback, got ${JSON.stringify(review)}`);
  assert.equal(mergeJobs(fx, taskId).length, 0);
  assert.deepEqual(fx.wakes.filter((w) => w.module === 'merge').length, 1);
  const kinds = eventKinds(fx, taskId);
  assert.ok(kinds.includes('release-auto-start-fallback'), kinds.join(','));
  assert.ok(!kinds.includes('release-auto-started'), kinds.join(','));
  const task = fx.store.getTask('r1', 'tasks/q2.md')!;
  assert.ok(task.status !== 'blocked', `fallback must not block, got ${task.status}`);
  assert.equal(task.holder_module, 'merge');
});

test('Q2: re-APPROVE after a failed merge job opens a fresh merge job (W0 natural-key retry)', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId } = await approveCandidate(fx);
  assert.equal(mergeJobs(fx, taskId).length, 1);
  // Let the merge job fail: its callback returns the baton to review. W0
  // (natural-key-first dedupe) keeps ONE live release per (task, kind, sha),
  // but a terminally failed row no longer pins that key: a second APPROVE of
  // the identical candidate must start a fresh merge job under a retry key
  // instead of replaying the dead row (pre-W0 behaviour).
  const mergeJob = mergeJobs(fx, taskId)[0];
  fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(mergeJob.id);
  const failed = fx.jobs.complete(fx.jobs.get(mergeJob.id)!, 'failed', 'simulated failure', 'boom', 'failed',
    boundedDeliveryMeta({ state: 'failed', receipt: {}, declared: { stage: 'failed' } }));
  assert.ok(!('error' in failed), JSON.stringify(failed));
  fx.store.handleJobFinished(fx.jobs.get(mergeJob.id)!, { finalAttempt: true, actor: 'codex' });
  const again = await call(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: fx.store.getTask('r1', 'tasks/q2.md')!.candidate_job_id, candidate_sha: H,
    verdict: 'approve', findings: 'still good',
  });
  const merges = mergeJobs(fx, taskId);
  assert.equal(merges.length, 2);
  assert.notEqual(again.autoRelease?.existing, true);
  const fresh = merges.find((job) => job.id !== mergeJob.id)!;
  assert.ok(fresh, 'a second merge job exists');
  assert.equal(again.autoRelease?.jobId, fresh.id);
  assert.equal(fresh.status, 'pending');
  // Same natural key, distinct stored idempotency keys (dead row stays put).
  const natural = `release:v1:${taskId}:merge:${H.toLowerCase()}`;
  assert.equal(fx.jobs.get(mergeJob.id)!.idempotency_key, natural);
  assert.ok(String(fresh.idempotency_key).startsWith(`${natural}:retry:`), String(fresh.idempotency_key));
  assert.equal((JSON.parse(fresh.options) as { releaseNaturalKey?: string }).releaseNaturalKey, natural);
});

test('Q2: strict rooms keep the explicit merge ritual (no direct start)', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dir, store, anchor } = fx;
  const created = await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'Q2', requirements: 'req', workspace: dir, anchor_message_id: anchor,
  });
  const taskId: string = created.task.id;
  const handoff = await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_handoff', {
    to_module: 'execute', request: 'do',
  });
  const execCtx: RoomTaskToolContext = { roomId: 'r1', moduleId: 'execute', taskId, handoffId: handoff.handoff.id };
  await call(fx, 'muse', execCtx, 'task_accept', {});
  const started = await call(fx, 'muse', execCtx, 'execution_start', {
    module: 'execute', expected_revision: store.getTask('r1', 'tasks/q2.md')!.revision,
    workspace: dir, objective: 'impl', return_mode: 'notify', return_to_module: 'plan',
  });
  const jobId: string = started.job.id;
  fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
  const outcome = fx.jobs.complete(fx.jobs.get(jobId)!, 'done', 'simulated done', null, 'delivered', boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat/q2', head: H,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'q2' },
  }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  store.handleJobFinished(fx.jobs.get(jobId)!, { finalAttempt: true });
  const toReview = await call(fx, 'muse', execCtx, 'task_handoff', { to_module: 'review', request: 'review' });
  const reviewCtx: RoomTaskToolContext = { roomId: 'r1', moduleId: 'review', taskId, handoffId: toReview.handoff.id };
  await call(fx, 'aye', reviewCtx, 'task_accept', {});
  const review = await call(fx, 'aye', reviewCtx, 'review_submit', {
    module: 'review', candidate_job_id: jobId, candidate_sha: H,
    verdict: 'approve', findings: 'looks good',
  });
  assert.equal(review.autoRelease, undefined);
  assert.equal(mergeJobs(fx, taskId).length, 0);
  assert.ok(!eventKinds(fx, taskId).includes('release-auto-started'));
});
