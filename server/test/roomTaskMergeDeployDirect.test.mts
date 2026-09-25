// Room minimization (User 2026-09-21): after_merge='deploy' starts the ai-hub
// deploy script straight from a proven merge and closes on a verified deploy
// (no deploy/review seat wakes); a merge script's clean identical rebase is
// accepted for the approved candidate without a re-review.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-min-'));
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
  const taskChanges: string[] = [];
  const dispatch = {
    dispatchToModule: (roomId: string, module: string, toContact: string) => {
      wakes.push({ module, contact: toContact });
      return { status: 'posted' as const };
    },
    publishFact: (messageId: number) => { facts.push(messageId); },
    publishTaskChange: (roomId: string) => { taskChanges.push(roomId); },
  };
  const store = new RoomTaskStore(db, jobs, dispatch as never);
  return { dir, db, jobs, store, anchor, dispatch, wakes, facts, taskChanges };
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
function finishMerge(fx: ReturnType<typeof setup>, mergeJobId: string, reportHead: string, status: 'done' | 'failed' = 'done',
  extra: Record<string, unknown> = {}) {
  const { db, jobs, store } = fx;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(mergeJobId);
  const report = { ok: status === 'done', lane: 'merge', branch: 'master', head: reportHead, tests: MERGE_SUITES, ...extra };
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

function finishDeploy(fx: ReturnType<typeof setup>, deployJobId: string, status: 'done' | 'failed' = 'done',
  report: Record<string, unknown> | null = null) {
  const { db, jobs, store } = fx;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(deployJobId);
  const sha = (JSON.parse(jobs.get(deployJobId)!.options) as { frozenSha: string }).frozenSha;
  const scriptReport = report ?? { ok: true, mode: 'deploy', result: 'deployed', targetSha: sha, deployOkLine: `== deploy ok ${sha} ==`, health: 'ok' };
  const outcome = jobs.complete(jobs.get(deployJobId)!, status,
    status === 'done' ? '== deploy ok ==' : 'deploy failed', status === 'done' ? null : 'boom',
    status === 'done' ? 'delivered' : 'failed',
    boundedDeliveryMeta({
      state: status === 'done' ? 'delivered' : 'failed',
      receipt: { branch: 'master', head: H, scriptExitCode: status === 'done' ? 0 : 1, ...(status === 'done' ? { scriptReport } : {}) },
      declared: status === 'done' ? { stage: 'closed_loop' } : { stage: 'failed' },
    }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  return store.handleJobFinished(jobs.get(deployJobId)!, { finalAttempt: true, actor: 'codex' });
}

function closureJobs(fx: ReturnType<typeof setup>, taskId: string, kind: 'merge' | 'deploy') {
  return fx.store.linkedJobs(taskId).filter((job) => {
    try { return (JSON.parse(job.options) as { closureKind?: unknown }).closureKind === kind; } catch { return false; }
  });
}

function wakesOf(fx: ReturnType<typeof setup>, module: string): number {
  return fx.wakes.filter((w) => w.module === module).length;
}

function hasEvent(fx: ReturnType<typeof setup>, taskId: string, kind: string): boolean {
  return Boolean(fx.db.prepare('SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = ?').get(taskId, kind));
}

test('open merge closure asks the script for a clean auto-rebase', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { mergeJobId } = await approveFlow(fx, { afterMerge: 'deploy' });
  const options = JSON.parse(fx.jobs.get(mergeJobId)!.options) as { closureCommand: { posix: { args: string[] } } };
  assert.ok(options.closureCommand.posix.args.includes('--auto-rebase'));
});

test('after_merge=deploy: merge done starts deploy directly, verified deploy closes, no seat wakes', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await approveFlow(fx, { afterMerge: 'deploy' });
  const reviewBefore = wakesOf(fx, 'review');
  finishMerge(fx, mergeJobId, H);
  const deploys = closureJobs(fx, taskId, 'deploy');
  assert.equal(deploys.length, 1, 'deploy closure started straight from the merge');
  const options = JSON.parse(deploys[0].options) as { frozenSha: string; closureCommand: { posix: { args: string[] } } };
  assert.equal(options.frozenSha, H);
  assert.deepEqual(options.closureCommand.posix.args, ['--sha', H]);
  // The HTTP deploy script needs no SSH; ssh=true made it unclaimable on vps-dev.
  assert.deepEqual(JSON.parse(deploys[0].permissions), { write: false, shell: true, ssh: false });
  assert.equal(wakesOf(fx, 'deploy'), 0, 'deploy seat never woken');
  assert.equal(wakesOf(fx, 'review'), reviewBefore, 'review seat not woken for the merge');
  assert.ok(hasEvent(fx, taskId, 'release-auto-started'));
  finishDeploy(fx, deploys[0].id);
  const task = fx.store.getTask('r1', 'tasks/q3.md')!;
  assert.equal(task.status, 'closed');
  assert.equal(wakesOf(fx, 'review'), reviewBefore, 'review seat not woken for the deploy either');
  assert.ok(hasEvent(fx, taskId, 'auto-closed'));
  await Promise.resolve();
  assert.ok(fx.taskChanges.includes('r1'), 'closed status announces a room ledger refresh');
  const fact = fx.db.prepare("SELECT content FROM messages WHERE meta LIKE '%room-task-deploy-auto-start%'").get() as { content: string } | undefined;
  assert.ok(fact?.content.includes('【部署直接启动】'), fact?.content);
  // Replays stay quiet and never start a second deploy.
  fx.store.handleJobFinished(fx.jobs.get(mergeJobId)!, { finalAttempt: true, actor: 'codex' });
  fx.store.handleJobFinished(fx.jobs.get(deploys[0].id)!, { finalAttempt: true, actor: 'codex' });
  assert.equal(closureJobs(fx, taskId, 'deploy').length, 1);
  assert.equal(wakesOf(fx, 'review'), reviewBefore);
});

test('after_merge=deploy: failed deploy blocks and falls back to the review callback', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await approveFlow(fx, { afterMerge: 'deploy' });
  finishMerge(fx, mergeJobId, H);
  const [deploy] = closureJobs(fx, taskId, 'deploy');
  const reviewBefore = wakesOf(fx, 'review');
  finishDeploy(fx, deploy.id, 'failed');
  assert.equal(fx.store.getTask('r1', 'tasks/q3.md')!.status, 'blocked');
  assert.ok(!hasEvent(fx, taskId, 'auto-closed'));
  assert.equal(wakesOf(fx, 'review'), reviewBefore + 1, 'a failed deploy reaches the review seat');
});

test('after_merge=deploy only covers ai-hub: another repo falls back to the review wake', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId, mergeJobId } = await approveFlow(fx, { afterMerge: 'deploy' });
  fx.db.prepare(`UPDATE jobs SET options = json_set(options, '$.projectTarget', json('{"repoId":"ai-dashboard"}')) WHERE id = ?`).run(implJobId);
  const reviewBefore = wakesOf(fx, 'review');
  finishMerge(fx, mergeJobId, H);
  assert.equal(closureJobs(fx, taskId, 'deploy').length, 0);
  assert.ok(hasEvent(fx, taskId, 'deploy-auto-start-fallback'));
  assert.equal(wakesOf(fx, 'review'), reviewBefore + 1);
});

test('clean identical rebase by the merge script is accepted without re-review', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await approveFlow(fx, { afterMerge: 'deploy' });
  const executeBefore = wakesOf(fx, 'execute');
  finishMerge(fx, mergeJobId, H2, 'done', { rebase: 'identical', rebasedFrom: H });
  assert.ok(hasEvent(fx, taskId, 'merge-rebased'));
  assert.ok(!hasEvent(fx, taskId, 'merge-stale'));
  const [deploy] = closureJobs(fx, taskId, 'deploy');
  assert.ok(deploy, 'deploy started for the rebased head');
  assert.equal((JSON.parse(deploy.options) as { frozenSha: string }).frozenSha, H2, 'deploys what master actually has');
  assert.equal(wakesOf(fx, 'execute'), executeBefore, 'no rebase execute round');
});

test('rebase proof must name the approved candidate', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await approveFlow(fx, { afterMerge: 'done' });
  finishMerge(fx, mergeJobId, H2, 'done', { rebase: 'identical', rebasedFrom: SHA('e') });
  assert.notEqual(fx.store.getTask('r1', 'tasks/q3.md')!.status, 'closed');
  assert.ok(!hasEvent(fx, taskId, 'auto-closed'));
});

test('after_merge=done still closes on a clean rebase, recording the merged head', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await approveFlow(fx, { afterMerge: 'done' });
  finishMerge(fx, mergeJobId, H2, 'done', { rebase: 'identical', rebasedFrom: H });
  assert.equal(fx.store.getTask('r1', 'tasks/q3.md')!.status, 'closed');
  const done = fx.db.prepare("SELECT payload FROM room_task_events WHERE task_id = ? AND kind = 'done' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { payload: string };
  assert.equal((JSON.parse(done.payload) as { sha: string }).sha, H2);
});

test('deploy done without a matching script report still wakes review', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, mergeJobId } = await approveFlow(fx, { afterMerge: 'deploy' });
  finishMerge(fx, mergeJobId, H);
  const [deploy] = closureJobs(fx, taskId, 'deploy');
  const reviewBefore = wakesOf(fx, 'review');
  finishDeploy(fx, deploy.id, 'done', { ok: true, mode: 'deploy', targetSha: H2, deployOkLine: 'x', health: 'ok' });
  assert.ok(!hasEvent(fx, taskId, 'auto-closed'));
  assert.equal(wakesOf(fx, 'review'), reviewBefore + 1);
});
