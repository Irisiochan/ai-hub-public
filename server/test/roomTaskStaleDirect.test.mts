// Q4 (cost batch 2): merge-stale auto-pass starts the rebase Worker
// directly — no execute chat wake.
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
const MASTER = SHA('e');

function setup(governance?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-q4-'));
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
    const result = await tool.exec({ room_id: 'r1', task_path: 'tasks/q4.md', ...args });
    assert.equal(result.ok, true, `${name}: ${result.text}`);
    return JSON.parse(result.text);
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

/** Drive an open task to a Q2-started merge job; returns task + merge job ids. */
async function startMerge(fx: ReturnType<typeof setup>) {
  const { dir, db, jobs, store, anchor } = fx;
  const created = await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'Q4', requirements: 'req', workspace: dir, anchor_message_id: anchor,
  });
  const taskId: string = created.task.id;
  await call(fx, 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', { to_module: 'execute', note: 'go' });
  const started = await call(fx, 'muse', { roomId: 'r1', moduleId: 'execute', taskId }, 'execution_start', {
    module: 'execute', expected_revision: store.getTask('r1', 'tasks/q4.md')!.revision,
    workspace: dir, objective: 'impl',
  });
  const implJobId: string = started.job.id;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(implJobId);
  const outcome = jobs.complete(jobs.get(implJobId)!, 'done', 'simulated done', null, 'delivered', boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat/q4', head: H,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'q4' },
  }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  store.handleJobFinished(jobs.get(implJobId)!, { finalAttempt: true, actor: 'muse' });
  await call(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: implJobId, candidate_sha: H,
    verdict: 'approve', findings: 'all green',
  });
  const merges = store.linkedJobs(taskId).filter((job) => {
    try { return (JSON.parse(job.options) as { closureKind?: unknown }).closureKind === 'merge'; } catch { return false; }
  });
  assert.equal(merges.length, 1);
  return { taskId, implJobId, mergeJobId: merges[0].id };
}

/** Finish the merge job with a machine-readable stale report. */
function finishStale(fx: ReturnType<typeof setup>, mergeJobId: string) {
  const { db, jobs, store } = fx;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(mergeJobId);
  const stale = { ok: false, lane: 'merge', stale: true, masterSha: MASTER, frozen: H };
  const outcome = jobs.complete(jobs.get(mergeJobId)!, 'failed', `log\n${JSON.stringify(stale)}\n`, 'stale', 'failed',
    boundedDeliveryMeta({ state: 'failed', receipt: {}, declared: { stage: 'failed' } }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  return store.handleJobFinished(jobs.get(mergeJobId)!, { finalAttempt: true, actor: 'codex' });
}

function executeJobs(fx: ReturnType<typeof setup>, taskId: string) {
  const candidate = fx.store.getTaskById(taskId)?.candidate_job_id;
  return fx.store.linkedJobs(taskId).filter((job) => {
    try {
      const options = JSON.parse(job.options) as { closureKind?: unknown; roomTaskReturn?: unknown };
      return !options.closureKind && options.roomTaskReturn === 'review' && job.id !== candidate;
    } catch { return false; }
  });
}

test('Q4: stale merge starts the rebase Worker with no execute wake', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await startMerge(fx);
  const wakesBefore = fx.wakes.filter((w) => w.module === 'execute').length;
  finishStale(fx, mergeJobId);
  const rebase = executeJobs(fx, taskId);
  assert.equal(rebase.length, 1, 'exactly one rebase job started');
  const job = fx.jobs.get(rebase[0].id)!;
  const options = JSON.parse(job.options) as Record<string, unknown>;
  assert.equal(options.patchSince, H, 'rebase round carries patchSince for the 44c1730 delta path');
  assert.match(job.prompt, new RegExp(MASTER.slice(0, 12)), 'objective names the rebase target');
  assert.match(job.prompt, /force-with-lease/, 'objective carries the conflict boundary');
  assert.match(job.prompt, /不得自行解冲突后直接送合入/, 'objective forbids silent conflict resolution');
  assert.equal(fx.wakes.filter((w) => w.module === 'execute').length, wakesBefore, 'no execute chat wake');
  const kinds = (fx.db.prepare('SELECT kind FROM room_task_events WHERE task_id = ? ORDER BY id ASC').all(taskId) as Array<{ kind: string }>)
    .map((row) => row.kind);
  assert.ok(kinds.includes('merge-stale'), kinds.join(','));
  assert.ok(kinds.includes('merge-stale-auto-started'), kinds.join(','));
  assert.ok(!kinds.includes('merge-stale-auto-start-fallback'), kinds.join(','));
  const fact = fx.db.prepare("SELECT content FROM messages WHERE meta LIKE '%room-task-merge-stale-auto-start%'").get() as { content: string } | undefined;
  assert.ok(fact?.content.includes('【rebase 直接启动】'), fact?.content);
  const task = fx.store.getTask('r1', 'tasks/q4.md')!;
  assert.equal(task.holder_module, 'execute');
  assert.equal(task.status, 'in_progress');
});

test('Q4: tripped three-round gate still blocks', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await startMerge(fx);
  // Three execute rounds since the APPROVE verdict: the gate must trip.
  // (Seeded ledger rows; the counting itself is covered by the passTask suite.)
  for (let i = 0; i < 3; i += 1) {
    fx.db.prepare("INSERT INTO room_task_events (task_id, kind, actor, module, payload) VALUES (?, 'execution-started', 'muse', 'execute', ?)")
      .run(taskId, JSON.stringify({ jobId: `seed-${i}` }));
  }
  finishStale(fx, mergeJobId);
  const task = fx.store.getTask('r1', 'tasks/q4.md')!;
  assert.equal(task.status, 'blocked');
  const kinds = (fx.db.prepare('SELECT kind FROM room_task_events WHERE task_id = ? ORDER BY id ASC').all(taskId) as Array<{ kind: string }>)
    .map((row) => row.kind);
  assert.ok(kinds.includes('merge-stale-blocked'), kinds.join(','));
  assert.ok(!kinds.includes('merge-stale-auto-started'), kinds.join(','));
  assert.equal(executeJobs(fx, taskId).length, 0);
});

test('Q4: direct-start failure records fallback and starts no phantom job', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await startMerge(fx);
  // Decouple the execute contact: no frozen snapshot is available.
  fx.db.prepare("UPDATE contacts SET enabled = 0 WHERE id = 'muse'").run();
  finishStale(fx, mergeJobId);
  const kinds = (fx.db.prepare('SELECT kind FROM room_task_events WHERE task_id = ? ORDER BY id ASC').all(taskId) as Array<{ kind: string }>)
    .map((row) => row.kind);
  assert.ok(kinds.includes('merge-stale'), kinds.join(','));
  assert.ok(kinds.includes('merge-stale-auto-start-fallback'), kinds.join(','));
  assert.ok(!kinds.includes('merge-stale-auto-started'), kinds.join(','));
  assert.equal(executeJobs(fx, taskId).length, 0, 'no direct rebase job');
  const task = fx.store.getTask('r1', 'tasks/q4.md')!;
  assert.ok(task.status !== 'closed', task.status);
});
