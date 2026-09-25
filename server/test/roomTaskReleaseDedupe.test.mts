// W0: release_execute must dedupe by the natural key
// `release:v1:<task>:<kind>:<sha>` first. A caller-supplied idempotency_key
// only scopes network retries of the same call and must never mint a second
// release for an already-published candidate. A different SHA, a different
// kind, or a failed/cancelled prior row still allows a fresh release.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import type { RoomTaskToolContext } from '../src/roomTasks/roomTaskStore.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { boundedDeliveryMeta } from '../src/jobs/receiptFields.js';
import type { SseHub } from '../src/platform/sse.js';

const SHA = (ch: string) => ch.repeat(40);
const H2 = SHA('b');
const H3 = SHA('d');
const BASE = SHA('c');

function setup(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-release-dedupe-'));
  const db = openDb(path.join(dir, 'hub.db'));
  t.after(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const sse = { broadcast: () => {} } as unknown as SseHub;
  const jobs = new JobStore(db, sse);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(id, id, backend);
  }
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-a', 'room-a', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse', 'aye'] }));
  jobs.workflowModules.setBinding('merge', { contactId: 'codex', runner: 'codex', model: 'm', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  jobs.workflowModules.setBinding('deploy', { contactId: 'codex', runner: 'codex', model: 'm', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  jobs.workflowModules.setBinding('execute', { contactId: 'muse', runner: 'opencode', model: 'm', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  jobs.workflowModules.setBinding('review', { contactId: 'aye', runner: 'grok', model: 'm', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  jobs.workflowModules.setBinding('plan', { contactId: 'codex', runner: 'codex', model: 'm', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  const anchor = Number(db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
    VALUES ('room-a', 'user', 'user', 'text', 'User: approve dedupe', 'done', '{}', 'main')`).run().lastInsertRowid);
  const dispatch: any = { dispatchToModule: () => ({ status: 'posted' as const }) };
  const store = new RoomTaskStore(db, jobs, dispatch);
  const call = async (actor: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) => {
    const turn = beginRoomTurn(db, { ...ctx, contactId: actor });
    try {
      const tool = buildRoomTaskTools(db, jobs, actor, dispatch, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
        .find((item) => item.name === name)!;
      const result = await tool.exec({ room_id: 'room-a', task_path: 'tasks/dedupe.md', ...args });
      assert.equal(result.ok, true, `${name}: ${result.text}`);
      return JSON.parse(result.text);
    } finally { endRoomTurn(db, turn.turnId, 'test'); }
  };
  const finish = (jobId: string, status: 'done' | 'failed', meta: string, resultText = `simulated ${status}`) => {
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
    const outcome = jobs.complete(jobs.get(jobId)!, status, resultText, status === 'failed' ? 'boom' : null,
      status === 'done' ? 'delivered' : 'failed', meta);
    assert.ok(!('error' in outcome), `complete failed: ${JSON.stringify(outcome)}`);
    return jobs.get(jobId)!;
  };
  const revision = () => store.getTask('room-a', 'tasks/dedupe.md')!.revision;
  return { dir, db, jobs, store, dispatch, anchor, call, finish, revision };
}

function candidateMeta(head: string) {
  return boundedDeliveryMeta({
    receipt: {
      branch: 'codex/w', head, diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 }, tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false },
  });
}

async function approveCandidate(fx: ReturnType<typeof setup>, head: string) {
  const task = fx.store.getTask('room-a', 'tasks/dedupe.md')!;
  const owner = task.owner_module;
  const handoffToExec = await fx.call(task.owner_contact, { roomId: 'room-a', moduleId: owner as any, taskId: task.id }, 'task_handoff', {
    to_module: 'execute', request: `impl ${head.slice(0, 6)}`,
  });
  const execCtx: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'execute', taskId: task.id, handoffId: handoffToExec.handoff.id };
  await fx.call('muse', execCtx, 'task_accept', {});
  const started = await fx.call('muse', execCtx, 'execution_start', {
    module: 'execute', expected_revision: fx.revision(),
    workspace: fx.dir, objective: `impl ${head.slice(0, 6)}`, return_mode: 'notify', return_to_module: 'plan',
  });
  fx.finish(started.job.id, 'done', candidateMeta(head));
  fx.store.handleJobFinished(fx.jobs.get(started.job.id)!, { finalAttempt: true });
  const toReview = await fx.call('muse', execCtx, 'task_handoff', { to_module: 'review', request: `review ${head.slice(0, 6)}` });
  const reviewCtx: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'review', taskId: task.id, handoffId: toReview.handoff.id };
  await fx.call('aye', reviewCtx, 'task_accept', {});
  await fx.call('aye', reviewCtx, 'review_submit', {
    module: 'review', candidate_job_id: started.job.id, candidate_sha: head,
    verdict: 'approve', findings: `${head.slice(0, 6)} looks good, all green`,
  });
  const toMerge = await fx.call('aye', reviewCtx, 'task_handoff', { to_module: 'merge', request: `merge ${head.slice(0, 6)}` });
  const mergeCtx: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'merge', taskId: task.id, handoffId: toMerge.handoff.id };
  await fx.call('codex', mergeCtx, 'task_accept', {});
  return mergeCtx;
}

function mergeReleases(fx: ReturnType<typeof setup>, taskId: string) {
  return (fx.db.prepare(
    `SELECT j.* FROM jobs j JOIN room_task_links l ON l.job_id = j.id
     WHERE l.task_id = ? AND json_extract(j.options, '$.closureKind') = 'merge'
     ORDER BY j.created_at ASC, j.id ASC`,
  ).all(taskId) as Array<{ id: string; status: string; idempotency_key: string; options: string }>);
}

test('release_execute natural key survives caller keys; new SHA and post-failure retry still publish', async (t) => {
  const fx = setup(t);
  const created = await fx.call('codex', { roomId: 'room-a', moduleId: 'plan' }, 'task_create', {
    title: 'dedupe', requirements: 'dedupe req', workspace: fx.dir, anchor_message_id: fx.anchor,
  });
  const taskId = created.task.id;

  // ── Same SHA, two different caller keys → one release ──
  const mergeCtx = await approveCandidate(fx, H2);
  const first = await fx.call('codex', mergeCtx, 'release_execute', {
    kind: 'merge', return_to_module: 'deploy', return_mode: 'notify',
    expected_revision: fx.revision(), idempotency_key: 'caller-key-A',
  });
  assert.ok(!first.existing, 'first release is fresh');
  const stored = JSON.parse(fx.jobs.get(first.job.id)!.options);
  assert.equal(stored.releaseNaturalKey, `release:v1:${taskId}:merge:${H2}`, 'natural key stamped on the row');
  const second = await fx.call('codex', mergeCtx, 'release_execute', {
    kind: 'merge', return_to_module: 'deploy', return_mode: 'notify',
    expected_revision: fx.revision(), idempotency_key: 'caller-key-B',
  });
  assert.equal(second.job.id, first.job.id, 'different caller key, same SHA → same release');
  assert.equal(second.existing, true);
  assert.equal(mergeReleases(fx, taskId).length, 1, 'no duplicate merge release row');
  // The published merge now really runs to done (reality: push finished), so
  // its write lease is released for the next implementation cycle.
  fx.finish(first.job.id, 'done', '{}');

  // ── Different SHA → a second release ──
  const mergeCtx2 = await approveCandidate(fx, H3);
  const third = await fx.call('codex', mergeCtx2, 'release_execute', {
    kind: 'merge', return_to_module: 'deploy', return_mode: 'notify',
    expected_revision: fx.revision(), idempotency_key: 'caller-key-C',
  });
  assert.ok(!third.existing, 'new SHA is a legitimate new publish');
  assert.notEqual(third.job.id, first.job.id);
  assert.equal(mergeReleases(fx, taskId).length, 2, 'different SHA mints a second row');

  // ── Prior row failed → same SHA may publish again ──
  fx.finish(third.job.id, 'failed', '{}');
  const fourth = await fx.call('codex', mergeCtx2, 'release_execute', {
    kind: 'merge', return_to_module: 'deploy', return_mode: 'notify',
    expected_revision: fx.revision(), idempotency_key: 'caller-key-D',
  });
  assert.ok(!fourth.existing, 'retry after failure is allowed');
  assert.notEqual(fourth.job.id, third.job.id);
  assert.equal(mergeReleases(fx, taskId).length, 3, 'retry inserts a fresh row');
});
