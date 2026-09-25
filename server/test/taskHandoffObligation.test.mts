// Task handoff obligation: unit + store-level regressions (fast, no manager
// turns, no network, no CLI spawns). The two live-turn integrations live in
// roomTaskRuntimePath.test.mts (native T1/T2, MCP A/B with a stubbed Claude
// lifecycle). This file covers: post-bump wait revisions, accept-never-settles,
// MUST-6 returned-responsibility rechecks, stale reads/mutations, poison
// latch, execution_get acknowledgment quartet, waiting_owner provenance,
// old/stale/wrong-task/failed-dispatch negatives, wait validation, User
// endpoint reads, DM/no-task passthrough, and runtime init/setup failure
// paths (MUST 2/3).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { AgentManager } from '../src/runtime/manager.js';
import { AgentRuntime } from '../src/runtime/manager.js';
import type { HubLogger } from '../src/platform/logger.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import type { RoomTaskToolContext } from '../src/roomTasks/roomTaskStore.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import { createRoomTaskDispatcher } from '../src/runtime/roomTaskDispatch.js';
import {
  checkTurnObligation,
  findTaskUnsettledRecoveries,
  findUnsettledRecovery,
} from '../src/roomTasks/handoffObligation.js';
import { beginRoomTurn, endRoomTurn, isPoisoned } from '../src/roomTasks/turnAttribution.js';
import { ensureTurnSchema } from '../src/roomTasks/turnAttribution.js';
import { JobStore } from '../src/jobs/jobStore.js';
import type { SseHub } from '../src/platform/sse.js';
import { getTurn } from '../src/roomTasks/turnAttribution.js';

const sseHub = () => ({ broadcast() {} }) as unknown as SseHub;
const logger = { info() {}, warn() {}, error() {} } as unknown as HubLogger;

interface Fixture {
  dir: string;
  db: ReturnType<typeof openDb>;
  jobs: JobStore;
  manager: AgentManager;
  dispatcher: ReturnType<typeof createRoomTaskDispatcher>;
  tasksDir: string;
  anchor: (roomId: string, content: string) => number;
  cleanup: () => void;
}

function fixture(members: Array<[string, string]> = [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-handoff-obligation-'));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  const tasksDir = path.join(dir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const db = openDb(path.join(dir, 'hub.db'));
  const sse = sseHub();
  const jobs = new JobStore(db, sse);
  for (const [id, backend] of members) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')")
      .run(id, id, backend);
  }
  const ids = members.map(([id]) => `'${id}'`).join(',');
  void ids;
  const memberIds = members.map(([id]) => id);
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('rm', 'RM', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: memberIds }));
  const managerDeps: any = {
    db, sse,
    config: { memory: { capture: false, repoPath: dir }, agentsDir: dir },
    jobStore: jobs, vault: null,
  };
  const manager = new AgentManager(managerDeps);
  // No real model turns here: wakes only record, never spawn.
  (manager as any).getRoomMember = () => ({
    async runRoomTurn(_mode: string) { return 'spoke'; },
  });
  const dispatcher = createRoomTaskDispatcher({ db, sse, manager });
  const anchor = (roomId: string, content: string): number => Number((db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES (?, 'user', 'user', 'text', ?, 'done', '{}', 'main')`
  ).run(roomId, content)).lastInsertRowid);
  return {
    dir, db, jobs, manager, dispatcher, tasksDir, anchor,
    cleanup: () => {
      try { (jobs as any).stopOutOfBandResolver?.(); } catch { /* ignore */ }
      try { (manager as any).stopAll?.(); } catch { /* ignore */ }
      try { db.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface OpenTurn {
  turnId: string;
  call: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  ok: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  okJson: (name: string, args: Record<string, unknown>) => Promise<any>;
  failText: (name: string, args: Record<string, unknown>) => Promise<string>;
  close: (outcome?: string) => void;
}

function openTurn(
  fx: Fixture, contactId: string, ctx: RoomTaskToolContext,
): OpenTurn {
  const turn = beginRoomTurn(fx.db, {
    roomId: ctx.roomId,
    contactId,
    moduleId: ctx.moduleId,
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    ...(ctx.handoffId ? { handoffId: ctx.handoffId } : {}),
    ...((ctx as { callbackJobId?: string }).callbackJobId
      ? { callbackJobId: (ctx as { callbackJobId: string }).callbackJobId }
      : {}),
  });
  const bound: RoomTaskToolContext = { ...ctx, turnId: turn.turnId };
  const tools = buildRoomTaskTools(fx.db, fx.jobs, contactId, fx.dispatcher, {}, bound);
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name)!;
    assert.ok(tool, `${name} is exposed`);
    return tool.exec(args);
  };
  return {
    turnId: turn.turnId,
    call,
    ok: async (name, args) => {
      const out = await call(name, args);
      assert.equal(out.ok, true, `${name} should succeed: ${out.text.slice(0, 300)}`);
      return out;
    },
    okJson: async (name, args) => {
      const out = await call(name, args);
      assert.equal(out.ok, true, `${name} should succeed: ${out.text.slice(0, 300)}`);
      return JSON.parse(out.text);
    },
    failText: async (name, args) => {
      const out = await call(name, args);
      assert.equal(out.ok, false, `${name} should refuse`);
      return out.text;
    },
    close: (outcome = 'test') => endRoomTurn(fx.db, turn.turnId, outcome),
  };
}

const planCtx: RoomTaskToolContext = { roomId: 'rm', moduleId: 'plan' };

test('D2 auto-start and D4b baseline: no execute wake, direct repairs preserve first baseline', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/auto-start.md');
  const room = { room_id: 'rm', task_path: task.task_path };
  const store = () => new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher);
  const wakes: string[] = [];
  const realDispatch = fx.dispatcher.dispatchToModule;
  fx.dispatcher.dispatchToModule = (...args) => { wakes.push(args[1]); return realDispatch(...args); };
  const plan = openTurn(fx, 'codex', { ...planCtx, taskId: task.id });
  const args = { ...room, to_module: 'execute', request: 'Implement with tests',
    auto_start: true, expected_revision: task.revision, idempotency_key: 'auto-1' };
  const started = await plan.okJson('task_handoff', args);
  const job = fx.jobs.get(started.job.id)!;
  const options = JSON.parse(job.options);
  assert.equal(started.handoff.status, 'accepted');
  assert.equal(started.handoff.decided_by, 'codex', 'initiator, not a fabricated execute accept');
  assert.equal(started.task.owner_module, 'execute');
  assert.equal(started.task.active_handoff_id, null);
  assert.equal(options.roomTaskId, task.id);
  assert.equal(options.roomTaskHandoffId, started.handoff.id);
  assert.equal(options.handoffAutoStart, true);
  assert.equal(options.initiatedBy, 'codex');
  assert.equal(job.requested_by, 'muse', 'implementation identity follows execute, not initiator');
  assert.deepEqual(options.workflowModule.binding, JSON.parse(started.handoff.to_binding));
  assert.equal(options.workflowModule.bindingRevision, started.handoff.to_revision);
  // Workspace is a cross-host protocol path, not necessarily a path on the
  // gateway OS (Windows worker paths also pass through the Linux gateway).
  assert.equal(job.workspace.replace(/\\/g, '/'), fx.dir.replace(/\\/g, '/'));
  assert.deepEqual(wakes, []);
  const facts = fx.db.prepare("SELECT * FROM messages WHERE json_extract(meta, '$.event') = 'room-task-auto-start'").all() as any[];
  assert.equal(facts.length, 1);
  assert.equal(facts[0].sender, 'system');
  assert.equal((fx.db.prepare("SELECT COUNT(*) n FROM messages WHERE json_extract(meta, '$.event') = 'room-task-handoff'").get() as any).n, 0);
  assert.equal((fx.db.prepare("SELECT COUNT(*) n FROM room_task_turns WHERE module_id = 'execute'").get() as any).n, 0);
  const kinds = (fx.db.prepare('SELECT kind FROM room_task_events WHERE task_id = ? ORDER BY id').all(task.id) as any[]).map(row => row.kind);
  assert.deepEqual(kinds.filter(kind => ['handoff-created', 'handoff-auto-accepted', 'callback-registered', 'execution-started'].includes(kind)),
    ['handoff-created', 'handoff-auto-accepted', 'callback-registered', 'execution-started']);
  assert.equal(check(fx, plan.turnId, 'codex', 'plan').ok, true);
  const duplicate = await plan.okJson('task_handoff', args);
  assert.equal(duplicate.job.id, job.id);
  assert.equal(duplicate.delivery.status, 'duplicate');
  assert.equal((fx.db.prepare('SELECT COUNT(*) n FROM jobs').get() as any).n, 1);
  plan.close();
  const replay = openTurn(fx, 'codex', { ...planCtx, taskId: task.id });
  await replay.okJson('task_handoff', args);
  assert.equal(check(fx, replay.turnId, 'codex', 'plan').ok, false, 'historical auto-start does not settle a new turn');
  assert.match(await replay.failText('task_handoff', { ...args, objective: 'different objective' }), /参数不同/);
  replay.close();
  const finish = (id: string, head: string, status = 'done') => {
    fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(id);
    const result = fx.jobs.complete(fx.jobs.get(id)!, status, 'finished', null, 'delivered', JSON.stringify({ before: { head: id === job.id ? 'c'.repeat(40) : 'a'.repeat(40) }, receipt: {
      head, branch: 'codex/auto', diffstat: '1 file changed', changedFiles: { files: ['a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
    } }));
    assert.ok(!('error' in result));
    store().handleJobFinished(fx.jobs.get(id)!, { finalAttempt: true });
    return store().getTaskById(task.id)!;
  };
  const returned = finish(job.id, 'a'.repeat(40));
  assert.equal(returned.baseline_sha, 'c'.repeat(40));
  assert.equal(options.patchBase, undefined);
  assert.deepEqual(wakes, ['review']);
  const review = openTurn(fx, 'aye', { roomId: 'rm', moduleId: 'review', taskId: task.id, handoffId: returned.active_handoff_id! });
  await review.okJson('task_accept', room);
  const verdict = await review.okJson('review_submit', { ...room, module: 'review', candidate_job_id: job.id,
    candidate_sha: 'a'.repeat(40), verdict: 'request_changes', findings: 'M1: fix edge, pass criterion: unit test passes' });
  const repair = await review.okJson('task_handoff', { ...room, to_module: 'execute', auto_start: true,
    expected_revision: verdict.task.revision, request: 'M1: fix edge, unit test must pass', return_to_module: 'review' });
  assert.equal(repair.job.requested_by, 'muse');
  assert.equal(JSON.parse(repair.job.options).patchBase, 'c'.repeat(40));
  assert.equal(JSON.parse(repair.job.options).initiatedBy, 'aye');
  assert.equal(JSON.parse(repair.job.options).problemFingerprint, options.problemFingerprint);
  assert.equal(check(fx, review.turnId, 'aye', 'review').ok, true);
  assert.deepEqual(wakes, ['review'], 'repair start does not dispatch to execute');
  review.close();
  const repaired = finish(repair.job.id, 'b'.repeat(40));
  assert.equal(repaired.baseline_sha, 'c'.repeat(40));
  const finalReview = openTurn(fx, 'aye', { roomId: 'rm', moduleId: 'review', taskId: task.id, handoffId: repaired.active_handoff_id! });
  await finalReview.okJson('task_accept', room);
  await finalReview.okJson('review_submit', { ...room, module: 'review', candidate_job_id: repair.job.id,
    candidate_sha: 'b'.repeat(40), verdict: 'approve', findings: 'M1 passed' });
  await finalReview.okJson('task_handoff', { ...room, to_module: 'merge', request: 'Merge approved candidate', auto_start: true });
  assert.deepEqual(wakes, ['review', 'review', 'merge'], 'non-execute auto_start preserves normal handoff');
  assert.equal((fx.db.prepare('SELECT COUNT(*) n FROM jobs').get() as any).n, 2);
  finalReview.close();
});

test('D2 auto-start rolls back ownership, job, callback, evidence, fact and SSE on launch failure', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/auto-rollback.md');
  const room = { room_id: 'rm', task_path: task.task_path };
  const published: unknown[] = [];
  (fx.jobs as any).sse.broadcast = (...args: unknown[]) => published.push(args);
  const plan = openTurn(fx, 'codex', { ...planCtx, taskId: task.id });
  const args = { ...room, to_module: 'execute', request: 'Implement', auto_start: true, expected_revision: task.revision };
  const tables = ['jobs', 'job_messages', 'room_task_handoffs', 'room_task_links', 'room_task_callbacks',
    'room_task_completion_handoffs', 'room_task_evidence', 'room_task_events', 'messages'];
  const counts = () => tables.map(table => fx.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get());
  const before = counts();
  assert.match(await plan.failText('task_handoff', { ...args, expected_revision: task.revision + 1 }), /revision/);
  assert.match(await plan.failText('task_handoff', { ...args, expected_revision: undefined }), /expected_revision/);
  assert.match(await plan.failText('task_handoff', { ...args, return_to_module: 'unknown' }), /return_to_module/);
  assert.match(await plan.failText('task_handoff', { ...args, objective: '' }), /objective/);
  assert.match(await plan.failText('task_handoff', { ...args, ssh: true }), /ssh.*权限/);
  const create = fx.jobs.create.bind(fx.jobs);
  fx.jobs.create = () => ({ error: 'injected create failure' });
  assert.match(await plan.failText('task_handoff', args), /injected create failure/);
  fx.jobs.create = create;
  // Fail after jobs.create emitted its normal queue notifications. The outer
  // transaction must discard them too, not show a phantom job in the UI.
  fx.db.exec("CREATE TEMP TRIGGER fail_callback BEFORE INSERT ON room_task_callbacks BEGIN SELECT RAISE(ABORT, 'injected callback failure'); END");
  await assert.rejects(() => plan.call('task_handoff', args), /injected callback failure/);
  fx.db.exec('DROP TRIGGER fail_callback');
  assert.deepEqual(counts(), before);
  assert.deepEqual(published, []);
  assert.deepEqual(new RoomTaskStore(fx.db, fx.jobs).getTaskById(task.id), task);
  // A failed launch does not consume the idempotency key or revision.
  const success = await plan.okJson('task_handoff', args);
  assert.ok(success.job.id);
  assert.ok(published.length > 0);
  plan.close();
});

test('D2 auto-start preserves writer lease, round cap, frozen callbacks and takeover fencing', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/auto-guards.md');
  fx.db.prepare('UPDATE room_tasks SET baseline_sha = ? WHERE id = ?').run('c'.repeat(40), task.id);
  const room = { room_id: 'rm', task_path: task.task_path };
  const plan = openTurn(fx, 'codex', { ...planCtx, taskId: task.id });
  const launched = await plan.okJson('task_handoff', { ...room, to_module: 'execute', auto_start: true,
    request: 'Implement with tests', expected_revision: task.revision });
  const opts = JSON.parse(launched.job.options);
  const binding = fx.jobs.workflowModules.bindings().execute;
  assert.equal(fx.jobs.workflowModules.setBinding('execute', { ...binding, reasoning: 'max' },
    fx.jobs.workflowModules.revision(), 'User').ok, true);
  assert.equal(JSON.parse(fx.jobs.get(launched.job.id)!.options).workflowModule.binding.reasoning, binding.reasoning);
  plan.close();
  const exec = openTurn(fx, 'muse', { roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: launched.handoff.id });
  assert.match(await exec.failText('task_handoff', { ...room, to_module: 'execute', auto_start: true,
    expected_revision: launched.task.revision, request: 'Second writer' }), /在途写操作/);
  assert.equal((fx.db.prepare('SELECT COUNT(*) n FROM jobs').get() as any).n, 1);
  assert.match(await exec.failText('task_retry', { ...room, handoff_id: launched.handoff.id, mode: 'handoff' }), /旧交接|无需重发/);
  // Takeover remains an explicit owner action; no execute model wake is added.
  fx.db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(launched.job.id);
  const replacement = await exec.okJson('task_retry', { ...room, job_id: launched.job.id, mode: 'takeover' });
  assert.notEqual(replacement.job.id, launched.job.id);
  assert.equal(JSON.parse(replacement.job.options).patchBase, 'c'.repeat(40));
  assert.equal(fx.jobs.workflowModules.isFenced(launched.job.id), true);
  const cb = fx.db.prepare('SELECT return_module, return_contact, return_binding FROM room_task_callbacks WHERE job_id = ?');
  assert.deepEqual(cb.get(replacement.job.id), cb.get(launched.job.id));
  const store = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher);
  store.handleJobFinished(fx.jobs.get(launched.job.id)!, { finalAttempt: true });
  assert.equal(store.getTaskById(task.id)!.baseline_sha, 'c'.repeat(40));
  assert.equal(store.getTaskById(task.id)!.active_handoff_id, null, 'fenced original never delivers');
  assert.match(await exec.failText('task_retry', { ...room, job_id: launched.job.id, mode: 'callback' }), /已被接管废弃/);
  // A failed replacement still returns to the original captured review seat.
  const reviewBinding = fx.jobs.workflowModules.bindings().review;
  assert.equal(fx.jobs.workflowModules.setBinding('review', { ...reviewBinding, reasoning: 'medium' },
    fx.jobs.workflowModules.revision(), 'User').ok, true);
  fx.db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(replacement.job.id);
  store.handleJobFinished(fx.jobs.get(replacement.job.id)!, { finalAttempt: true });
  const returned = fx.db.prepare('SELECT * FROM room_task_handoffs WHERE id = ?')
    .get(store.getTaskById(task.id)!.active_handoff_id!) as any;
  assert.equal(returned.to_module, 'review');
  assert.equal(returned.to_contact, 'aye');
  assert.equal(JSON.parse(returned.to_binding).reasoning, reviewBinding.reasoning);
  assert.equal(opts.workflowModule.binding.contactId, 'muse');
  exec.close();

  const capped = await createTask(fx, 'tasks/auto-cap.md');
  const capTurn = openTurn(fx, 'codex', { ...planCtx, taskId: capped.task.id });
  for (let i = 0; i < 3; i++) fx.db.prepare(`INSERT INTO room_task_events (task_id, kind, actor, module)
    VALUES (?, 'execution-started', 'muse', 'execute')`).run(capped.task.id);
  assert.match(await capTurn.failText('task_handoff', { room_id: 'rm', task_path: capped.task.task_path,
    to_module: 'execute', auto_start: true, expected_revision: capped.task.revision, request: 'Fourth attempt' }), /已执行 3 轮/);
  assert.equal((fx.db.prepare('SELECT COUNT(*) n FROM room_task_links WHERE task_id = ?').get(capped.task.id) as any).n, 0);
  capTurn.close();
});

function check(
  fx: Fixture, turnId: string, contactId: string, moduleId: string, pinnedTaskId?: string,
) {
  const store = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher);
  return checkTurnObligation(fx.db, fx.jobs, store, {
    roomId: 'rm', contactId, moduleId, turnId,
    ...(pinnedTaskId ? { pinnedTaskId } : {}),
  });
}

async function createTask(fx: Fixture, taskPath: string, title = 'T'): Promise<{ task: any; anchorId: number }> {
  const t = openTurn(fx, 'codex', planCtx);
  const anchorId = fx.anchor('rm', `User：批准 ${taskPath}。`);
  const created = await t.okJson('task_create', {
    room_id: 'rm', task_path: taskPath, title,
    requirements: '原始需求全文。', workspace: fx.dir, anchor_message_id: anchorId,
  });
  t.close();
  return { task: created.task, anchorId };
}

async function startCompletionTask(fx: Fixture, taskPath: string, returnModule = 'plan') {
  const { task } = await createTask(fx, taskPath);
  const plan = openTurn(fx, 'codex', planCtx);
  const sent = await plan.okJson('task_handoff', {
    room_id: 'rm', task_path: taskPath, to_module: 'execute', request: 'Execute approved work.',
  });
  plan.close();
  const actor = sent.handoff.to_contact as string;
  const exec = openTurn(fx, actor, {
    roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: sent.handoff.id,
  });
  const accepted = await exec.okJson('task_accept', { room_id: 'rm', task_path: taskPath });
  const started = await exec.okJson('execution_start', {
    room_id: 'rm', task_path: taskPath, module: 'execute', workspace: fx.dir,
    expected_revision: accepted.task.revision, objective: 'Execute approved work.', return_to_module: returnModule,
  });
  const finish = (jobId = started.job.id) => {
    fx.db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(jobId);
    return new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher).handleJobFinished(fx.jobs.get(jobId)!, { finalAttempt: true });
  };
  return { task, exec, actor, started, finish };
}

test('registered completion hands off to a real accepting turn; fast jobs and retries settle once', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const taskPath = 'tasks/return-handoff.md';
  const { task, exec, actor, started, finish } = await startCompletionTask(fx, taskPath);
  const premature = await exec.failText('task_retry', {
    room_id: 'rm', task_path: taskPath, job_id: started.job.id, mode: 'callback',
  });
  assert.match(premature, /尚未终态/);
  assert.equal(fx.db.prepare('SELECT handoff_id FROM room_task_completion_handoffs WHERE job_id = ?')
    .get(started.job.id)!.handoff_id, null);
  finish();
  const store = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher);
  const pending = store.getTaskById(task.id)!;
  assert.equal(pending.owner_module, 'execute', 'delivery never transfers ownership by itself');
  assert.ok(pending.active_handoff_id);
  const handoff = fx.db.prepare('SELECT * FROM room_task_handoffs WHERE id = ?').get(pending.active_handoff_id) as any;
  const callback = fx.db.prepare('SELECT * FROM room_task_callbacks WHERE job_id = ?').get(started.job.id) as any;
  assert.equal(handoff.to_binding, callback.return_binding);
  assert.equal(handoff.to_permissions, callback.return_permissions);
  assert.equal(check(fx, exec.turnId, actor, 'execute').ok, true, 'fast finish fulfills launching turn obligation');
  const messageCount = (fx.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n;
  finish(); finish();
  assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n, messageCount);
  const receiver = openTurn(fx, handoff.to_contact, {
    roomId: 'rm', moduleId: 'plan', taskId: task.id, handoffId: handoff.id,
  });
  assert.match(await receiver.failText('task_handoff', {
    room_id: 'rm', task_path: taskPath, to_module: 'review', request: 'Review.',
  }), /只有负责人/);
  const accepted = await receiver.okJson('task_accept', { room_id: 'rm', handoff_id: handoff.id });
  assert.equal(accepted.task.owner_module, 'plan');
  assert.equal(check(fx, receiver.turnId, handoff.to_contact, 'plan').ok, false, 'accept is not completion');
  const onward = await receiver.okJson('task_handoff', {
    room_id: 'rm', task_path: taskPath, to_module: 'review', request: 'Review the returned evidence.',
  });
  assert.equal(onward.delivery.status, 'posted');
  assert.equal(check(fx, receiver.turnId, handoff.to_contact, 'plan').ok, true);
  assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as any).n, 1, 'no automatic next job');
  receiver.close(); exec.close();
});

test('completion handoff survives an offline recipient and redelivers the same edge', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const taskPath = 'tasks/return-offline.md';
  const { task, exec, actor, started, finish } = await startCompletionTask(fx, taskPath);
  const original = fx.manager.imageRoomMembers.bind(fx.manager);
  fx.manager.imageRoomMembers = () => [];
  finish();
  assert.equal(check(fx, exec.turnId, actor, 'execute').ok, false, 'failed delivery cannot settle');
  const first = new RoomTaskStore(fx.db, fx.jobs).getTaskById(task.id)!.active_handoff_id;
  fx.manager.imageRoomMembers = original;
  const retried = await exec.okJson('task_retry', {
    room_id: 'rm', task_path: taskPath, job_id: started.job.id, mode: 'callback',
  });
  assert.equal(retried.delivery.status, 'posted');
  finish();
  assert.equal(new RoomTaskStore(fx.db, fx.jobs).getTaskById(task.id)!.active_handoff_id, first);
  assert.equal(check(fx, exec.turnId, actor, 'execute').ok, true);
  exec.close();
});

test('a newer explicit handoff supersedes the registered completion choice', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const taskPath = 'tasks/return-superseded.md';
  const { task, exec, started, finish } = await startCompletionTask(fx, taskPath);
  const onward = await exec.okJson('task_handoff', {
    room_id: 'rm', task_path: taskPath, to_module: 'review', request: 'Explicitly changed the next recipient.',
  });
  finish();
  assert.equal(new RoomTaskStore(fx.db, fx.jobs).getTaskById(task.id)!.active_handoff_id, onward.handoff.id);
  assert.equal((fx.db.prepare('SELECT handoff_id FROM room_task_completion_handoffs WHERE job_id = ?')
    .get(started.job.id) as any).handoff_id, null, 'old completion never creates a competing handoff');
  exec.close();
});

test('same-owner completion only notifies, while takeover preserves cross-module handoff intent', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const own = await startCompletionTask(fx, 'tasks/return-self.md', 'execute');
  own.finish();
  assert.equal(new RoomTaskStore(fx.db, fx.jobs).getTaskById(own.task.id)!.active_handoff_id, null);
  own.exec.close();
  const next = await startCompletionTask(fx, 'tasks/return-takeover.md');
  fx.db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(next.started.job.id);
  const taken = await next.exec.okJson('task_retry', {
    room_id: 'rm', task_path: 'tasks/return-takeover.md', job_id: next.started.job.id, mode: 'takeover',
  });
  next.finish(next.started.job.id);
  assert.equal(new RoomTaskStore(fx.db, fx.jobs).getTaskById(next.task.id)!.active_handoff_id, null);
  next.finish(taken.job.id);
  assert.ok(new RoomTaskStore(fx.db, fx.jobs).getTaskById(next.task.id)!.active_handoff_id);
  next.exec.close();
});

test('completion preserves the frozen target and an ownership round trip invalidates old intent', async (t) => {
  const fx = fixture([['codex', 'codex'], ['cove2', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]); t.after(fx.cleanup);
  const taskPath = 'tasks/return-aba.md';
  const { task, exec, actor, started, finish } = await startCompletionTask(fx, taskPath);
  const toPlan = await exec.okJson('task_handoff', {
    room_id: 'rm', task_path: taskPath, to_module: 'plan', request: 'Reconsider before completion.',
  });
  const plan = openTurn(fx, 'codex', { roomId: 'rm', moduleId: 'plan', taskId: task.id, handoffId: toPlan.handoff.id });
  await plan.okJson('task_accept', { room_id: 'rm', handoff_id: toPlan.handoff.id });
  const back = await plan.okJson('task_handoff', {
    room_id: 'rm', task_path: taskPath, to_module: 'execute', request: 'New explicit responsibility.',
  });
  const returned = openTurn(fx, actor, { roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: back.handoff.id });
  await returned.okJson('task_accept', { room_id: 'rm', handoff_id: back.handoff.id });
  finish();
  assert.equal(new RoomTaskStore(fx.db, fx.jobs).getTaskById(task.id)!.active_handoff_id, null);
  assert.equal((fx.db.prepare('SELECT handoff_id FROM room_task_completion_handoffs WHERE job_id = ?')
    .get(started.job.id) as any).handoff_id, null, 'A-B-A cannot revive an old completion choice');
  returned.close(); plan.close(); exec.close();

  const frozen = await startCompletionTask(fx, 'tasks/return-frozen.md');
  const binding = fx.jobs.workflowModules.bindings().plan;
  assert.equal(fx.jobs.workflowModules.setBinding('plan', { ...binding, contactId: 'cove2' },
    fx.jobs.workflowModules.revision(), 'User').ok, true);
  frozen.finish();
  const handoffId = new RoomTaskStore(fx.db, fx.jobs).getTaskById(frozen.task.id)!.active_handoff_id!;
  const h = fx.db.prepare('SELECT to_contact, to_binding FROM room_task_handoffs WHERE id = ?').get(handoffId) as any;
  assert.equal(h.to_contact, 'codex');
  assert.equal(JSON.parse(h.to_binding).model, binding.model);
  const prior = openTurn(fx, 'codex', { roomId: 'rm', moduleId: 'plan', taskId: frozen.task.id, handoffId });
  assert.match(await prior.failText('task_accept', { room_id: 'rm', handoff_id: handoffId }), /角色已易主/);
  await prior.okJson('task_decline', { room_id: 'rm', handoff_id: handoffId });
  prior.close(); frozen.exec.close();
});

test('an accepted but failed handoff can explicitly resume only the current owner', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const taskPath = 'tasks/accepted-resume.md';
  const { task } = await createTask(fx, taskPath);
  const plan = openTurn(fx, 'codex', planCtx);
  const sent = await plan.okJson('task_handoff', {
    room_id: 'rm', task_path: taskPath, to_module: 'execute', request: 'Implement.',
  });
  plan.close();
  const exec = openTurn(fx, sent.handoff.to_contact, {
    roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: sent.handoff.id,
  });
  await exec.okJson('task_accept', { room_id: 'rm', handoff_id: sent.handoff.id });
  await new Promise((resolve) => setImmediate(resolve));
  fx.db.prepare("UPDATE room_task_dispatches SET status = 'failed' WHERE idempotency_key = ?")
    .run(`task-handoff:v1:${sent.handoff.id}`);
  const recovery = openTurn(fx, 'codex', planCtx);
  const resumed = await recovery.okJson('task_retry', { room_id: 'rm', handoff_id: sent.handoff.id });
  assert.equal(resumed.delivery.status, 'posted');
  assert.equal(resumed.handoff.status, 'accepted');
  assert.equal(new RoomTaskStore(fx.db, fx.jobs).getTaskById(task.id)!.owner_module, 'execute');
  assert.equal(check(fx, recovery.turnId, 'codex', 'plan').ok, true);
  const duplicate = await recovery.okJson('task_retry', { room_id: 'rm', handoff_id: sent.handoff.id });
  assert.equal(duplicate.delivery.status, 'duplicate');
  await exec.okJson('task_handoff', { room_id: 'rm', task_path: taskPath, to_module: 'plan', request: 'Return.' });
  assert.match(await recovery.failText('task_retry', { room_id: 'rm', handoff_id: sent.handoff.id }), /旧交接/);
  recovery.close(); exec.close();
});

test('long task responses preserve state and exact handoff/execution receipts', { timeout: 90_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const taskPath = 'tasks/long-requirements.md';
  const requirements = 'Long approved requirements with real acceptance criteria. '.repeat(250).trim();
  const plan = openTurn(fx, 'codex', planCtx);
  const created = await plan.okJson('task_create', {
    room_id: 'rm', task_path: taskPath, title: 'Long task', requirements,
    workspace: fx.dir, anchor_message_id: fx.anchor('rm', `User: approved ${taskPath}`),
  });
  assert.equal(created.task.requirements, requirements);
  const sent = await plan.okJson('task_handoff', {
    room_id: 'rm', task_path: taskPath, to_module: 'execute', request: 'Implement approved task.',
  });
  assert.equal(check(fx, plan.turnId, 'codex', 'plan').ok, true,
    'successful long handoff must not be misreported as unsettled');
  plan.close();
  const exec = openTurn(fx, sent.handoff.to_contact, {
    roomId: 'rm', moduleId: 'execute', taskId: created.task.id, handoffId: sent.handoff.id,
  });
  await exec.okJson('task_accept', { room_id: 'rm', task_path: taskPath });
  const view = await exec.okJson('task_get', { room_id: 'rm', task_path: taskPath });
  assert.equal(view.view.task.requirements, requirements);
  assert.equal(view.view.task.owner_module, 'execute');
  const started = await exec.okJson('execution_start', {
    room_id: 'rm', task_path: taskPath, module: 'execute',
    expected_revision: view.view.task.revision, workspace: fx.dir,
    objective: 'Implement approved task.', return_mode: 'notify', return_to_module: 'plan',
  });
  assert.ok(started.job.id);
  assert.equal(check(fx, exec.turnId, sent.handoff.to_contact, 'execute').ok, true,
    'successful long execution response must retain its exact job receipt');
  const receipt = 'paged result '.repeat(2000);
  fx.db.prepare('UPDATE jobs SET result = ? WHERE id = ?').run(receipt, started.job.id);
  const page = await exec.okJson('task_get', {
    room_id: 'rm', task_path: taskPath, receipt_job_id: started.job.id,
    receipt_offset: 12000, receipt_limit: 12000, event_limit: 1,
  });
  assert.equal(page.view.receiptPage.page, receipt.slice(12000, 24000));
  assert.equal(page.view.receiptPage.nextOffset, 24000);
  assert.equal(page.view.task.revision, started.task.revision);
  exec.close();
});

test('wait stores the post-bump revision and settles multiple tasks', { timeout: 60_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { task: a } = await createTask(fx, 'tasks/wa.md', 'WA');
  const { task: b } = await createTask(fx, 'tasks/wb.md', 'WB');
  const turn = openTurn(fx, 'codex', planCtx);
  const getA = await turn.okJson('task_get', { room_id: 'rm', task_path: 'tasks/wa.md' });
  assert.equal(getA.view.task.revision, a.revision);
  const wb = await turn.okJson('task_wait', {
    room_id: 'rm', task_path: 'tasks/wa.md', mode: 'blocked',
    reason: '外部依赖缺失导致无法继续，需要先补齐上游接口文档。',
    resume_condition: '拿到上游接口文档后继续。',
    expected_revision: a.revision,
  });
  assert.equal(wb.scope, 'task');
  const getB = await turn.okJson('task_get', { room_id: 'rm', task_path: 'tasks/wb.md' });
  const wu = await turn.okJson('task_wait', {
    room_id: 'rm', task_path: 'tasks/wb.md', mode: 'waiting_user',
    reason: '有两个可行方案，需要 User 拍板选一个再继续。',
    question: '选方案一还是方案二？',
    expected_revision: b.revision,
  });
  assert.equal(wu.scope, 'task');
  // Post-bump invariant (REVIEW_INITIAL bug 1): wait.revision matches the
  // CURRENT task revision, so a brand-new valid wait is never stale.
  const store = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher);
  const taskA = store.getTask('rm', 'tasks/wa.md')!;
  const taskB = store.getTask('rm', 'tasks/wb.md')!;
  assert.equal(taskA.status, 'blocked');
  assert.equal(taskA.revision, a.revision + 1);
  assert.equal(taskB.status, 'open', 'waiting_user keeps status');
  assert.equal(taskB.revision, b.revision + 1);
  const waitsA = store.listWaits(taskA.id);
  const waitsB = store.listWaits(taskB.id);
  assert.equal(waitsA.length, 1);
  assert.equal(waitsA[0].revision, taskA.revision);
  assert.equal(waitsA[0].turn_id, turn.turnId);
  assert.equal(waitsB[0].revision, taskB.revision);
  // task_get exposes waits (PLAN item 2).
  const viewA = await turn.okJson('task_get', { room_id: 'rm', task_path: 'tasks/wa.md' });
  assert.equal(viewA.view.waits.length, 1);
  assert.match(String(viewA.view.waits[0].reason), /上游接口/);
  assert.match(String(viewA.view.waits[0].resume_condition), /文档后继续/);
  const verdict = check(fx, turn.turnId, 'codex', 'plan');
  assert.equal(verdict.ok, true, 'both touched tasks settled separately in one turn');
  turn.close();
});

test('wait validation rejects thin reasons, missing resume, stale revisions', { timeout: 60_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { task: a } = await createTask(fx, 'tasks/wv.md', 'WV');
  const turn = openTurn(fx, 'codex', planCtx);
  assert.match(
    await turn.failText('task_wait', {
      room_id: 'rm', task_path: 'tasks/wv.md', mode: 'blocked',
      reason: '卡住了', resume_condition: '等通知。', expected_revision: a.revision,
    }),
    /实质/,
  );
  assert.match(
    await turn.failText('task_wait', {
      room_id: 'rm', task_path: 'tasks/wv.md', mode: 'blocked',
      reason: '外部依赖缺失导致无法继续，需要先补齐上游接口文档。',
      expected_revision: a.revision,
    }),
    /resume_condition/,
  );
  assert.match(
    await turn.failText('task_wait', {
      room_id: 'rm', task_path: 'tasks/wv.md', mode: 'sleeping',
      reason: '外部依赖缺失导致无法继续，需要先补齐上游接口文档。',
      resume_condition: '等通知。', expected_revision: a.revision,
    }),
    /工具参数无效|mode/,
  );
  assert.match(
    await turn.failText('task_wait', {
      room_id: 'rm', task_path: 'tasks/wv.md', mode: 'blocked',
      reason: '外部依赖缺失导致无法继续，需要先补齐上游接口文档。',
      resume_condition: '等通知后再继续。', expected_revision: a.revision + 99,
    }),
    /revision/,
  );
  turn.close();
  // Non-owner cannot register a task-level wait.
  const other = openTurn(fx, 'muse', { roomId: 'rm', moduleId: 'execute' });
  assert.match(
    await other.failText('task_wait', {
      room_id: 'rm', task_path: 'tasks/wv.md', mode: 'blocked',
      reason: '外部依赖缺失导致无法继续，需要先补齐上游接口文档。',
      resume_condition: '等通知后再继续。', expected_revision: a.revision,
    }),
    /负责人/,
  );
  other.close();
});

test('accept alone never settles; decline settles the decliner', { timeout: 60_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/ad.md', 'AD');
  const t0 = openTurn(fx, 'codex', planCtx);
  const h1 = await t0.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/ad.md', actor_module: 'plan',
    to_module: 'execute', request: '实现。', evidence_refs: [],
  });
  t0.close();
  const execPinned: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: h1.handoff.id,
  };
  const tAccept = openTurn(fx, 'muse', execPinned);
  await tAccept.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/ad.md' });
  const verdictAccept = check(fx, tAccept.turnId, 'muse', 'execute', task.id);
  assert.equal(verdictAccept.ok, false, 'accept alone never settles responsibility');
  assert.deepEqual(verdictAccept.taskIds, [task.id]);
  tAccept.close();
  // Decline path on a fresh handoff: the decliner relinquishes and passes.
  const tBack = openTurn(fx, 'muse', execPinned);
  const h2 = await tBack.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/ad.md', actor_module: 'execute',
    to_module: 'plan', request: '范围不清，退回。', evidence_refs: [],
  });
  tBack.close();
  const planPinned: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'plan', taskId: task.id, handoffId: h2.handoff.id,
  };
  const tDecline = openTurn(fx, 'codex', planPinned);
  await tDecline.okJson('task_decline', { room_id: 'rm', task_path: 'tasks/ad.md' });
  const verdictDecline = check(fx, tDecline.turnId, 'codex', 'plan', task.id);
  assert.equal(verdictDecline.ok, true, 'validated decline settles the decliner');
  tDecline.close();
});

test('MUST 6: returned responsibility defeats old handoff and decline receipts', { timeout: 60_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/rt6.md', 'RT6');
  // Turn A (plan/codex, unpinned) hands to execute. Keep A OPEN while the
  // world moves: B accepts, hands back to plan, plan accepts — all before A
  // ends. A's exact accepted+posted H1 receipt must NOT settle A afterwards.
  const tA = openTurn(fx, 'codex', planCtx);
  const h1 = await tA.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/rt6.md', actor_module: 'plan',
    to_module: 'execute', request: '实现 RT6。', evidence_refs: [],
  });
  const execPinned: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: h1.handoff.id,
  };
  const tE = openTurn(fx, 'muse', execPinned);
  await tE.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/rt6.md' });
  const h2 = await tE.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/rt6.md', actor_module: 'execute',
    to_module: 'plan', request: '返工说明已补，回 plan 定夺。', evidence_refs: [],
  });
  tE.close();
  // Sanity: the middle turn disposed via its exact H2 receipt (owner is plan
  // again, but the receipt belongs to the execute turn, not plan).
  const verdictE = check(fx, tE.turnId, 'muse', 'execute', task.id);
  assert.equal(verdictE.ok, true, 'middle turn passes on its own exact handoff');
  const planPinned: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'plan', taskId: task.id, handoffId: h2.handoff.id,
  };
  const tP = openTurn(fx, 'codex', planPinned);
  await tP.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/rt6.md' });
  tP.close();
  const verdictA = check(fx, tA.turnId, 'codex', 'plan');
  assert.equal(verdictA.ok, false, 'original turn must NOT pass its old accepted handoff after responsibility returned');
  assert.deepEqual(verdictA.taskIds, [task.id]);
  tA.close();

  // Decline-then-accept in one turn: the decline receipt is stale once the
  // same turn newly accepts responsibility.
  const { task: task2 } = await createTask(fx, 'tasks/rt6b.md', 'RT6B');
  const tA2 = openTurn(fx, 'codex', planCtx);
  const hA = await tA2.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/rt6b.md', actor_module: 'plan',
    to_module: 'review', request: '请评审。', evidence_refs: [],
  });
  tA2.close();
  const revPinned: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'review', taskId: task2.id, handoffId: hA.handoff.id,
  };
  const tR = openTurn(fx, 'aye', revPinned);
  await tR.okJson('task_decline', { room_id: 'rm', task_path: 'tasks/rt6b.md' });
  tR.close();
  // Control: right after the decline, ownership stays away, so the decline
  // receipt settles the decliner.
  const store = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher);
  const ownerAfterDecline = store.getTask('rm', 'tasks/rt6b.md')!;
  assert.equal(ownerAfterDecline.owner_contact, 'codex');
  const verdictDecline = check(fx, tR.turnId, 'aye', 'review', task2.id);
  assert.equal(verdictDecline.ok, true, 'decline settles while responsibility stays away');
  // Then responsibility newly arrives (a later review turn accepts the
  // follow-up handoff). Re-reading the SAME decline turn at the new terminal
  // state must now fail: the old receipt cannot settle a turn whose own
  // module+contact holds the task.
  const tP2 = openTurn(fx, 'codex', planCtx);
  const hB = await tP2.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/rt6b.md', actor_module: 'plan',
    to_module: 'review', request: '补充说明后再评。', evidence_refs: [],
  });
  tP2.close();
  const revPinned2: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'review', taskId: task2.id, handoffId: hB.handoff.id,
  };
  const tR2 = openTurn(fx, 'aye', revPinned2);
  await tR2.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/rt6b.md' });
  tR2.close();
  const verdictR = check(fx, tR.turnId, 'aye', 'review', task2.id);
  assert.equal(verdictR.ok, false, 'decline receipt is stale once responsibility was newly accepted');
});

test('PENDING: live incoming pending suspends old outgoing receipts', { timeout: 60_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/pr.md', 'PR');
  // A hands to B (accepted, owner moves to B), then B hands back to A
  // (pending, owner still B). A's old accepted+posted H1 receipt must NOT
  // settle A: a new receiving duty (H2) addresses A's own module+contact.
  const tA = openTurn(fx, 'codex', planCtx);
  const h1 = await tA.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/pr.md', actor_module: 'plan',
    to_module: 'execute', request: '实现 PR。', evidence_refs: [],
  });
  const execPinned: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: h1.handoff.id,
  };
  const tE = openTurn(fx, 'muse', execPinned);
  await tE.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/pr.md' });
  const h2 = await tE.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/pr.md', actor_module: 'execute',
    to_module: 'plan', request: '回 plan 定夺。', evidence_refs: [],
  });
  tE.close();
  // Control: the middle turn disposed via its own exact outgoing receipt
  // (owner is execute, edge H2 pending to the other module).
  assert.equal(check(fx, tE.turnId, 'muse', 'execute', task.id).ok, true);
  // H2 is pending to plan/codex while A is still open: A must fail despite
  // its old accepted+posted H1 receipt.
  const live = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher).getTask('rm', 'tasks/pr.md')!;
  assert.equal(live.owner_contact, 'muse');
  assert.equal(live.active_handoff_id, h2.handoff.id);
  const verdictA = check(fx, tA.turnId, 'codex', 'plan');
  assert.equal(verdictA.ok, false, 'new incoming pending suspends the old outgoing receipt');
  assert.deepEqual(verdictA.taskIds, [task.id]);
  tA.close();
  // Once A processes the exact incoming (decline), the same turn shape
  // settles: decline the live edge, responsibility stays away.
  const planPinned: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'plan', taskId: task.id, handoffId: h2.handoff.id,
  };
  const tD = openTurn(fx, 'codex', planPinned);
  await tD.okJson('task_decline', { room_id: 'rm', task_path: 'tasks/pr.md' });
  assert.equal(check(fx, tD.turnId, 'codex', 'plan', task.id).ok, true, 'declining the exact incoming settles');
  tD.close();
});

test('PENDING: decline then new incoming pending must be processed', { timeout: 60_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/pr2.md', 'PR2');
  const tA = openTurn(fx, 'codex', planCtx);
  const h1 = await tA.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/pr2.md', actor_module: 'plan',
    to_module: 'review', request: '请评审。', evidence_refs: [],
  });
  tA.close();
  const revPinned: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'review', taskId: task.id, handoffId: h1.handoff.id,
  };
  const tR = openTurn(fx, 'aye', revPinned);
  await tR.okJson('task_decline', { room_id: 'rm', task_path: 'tasks/pr2.md' });
  // Control: with ownership away and no live edge, the decline settles.
  assert.equal(check(fx, tR.turnId, 'aye', 'review', task.id).ok, true);
  // A new handoff back to review re-opens the receiving duty: the same
  // decline receipt must no longer settle.
  const tP = openTurn(fx, 'codex', planCtx);
  const h2 = await tP.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/pr2.md', actor_module: 'plan',
    to_module: 'review', request: '补充后重评。', evidence_refs: [],
  });
  tP.close();
  void h2;
  const live = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher).getTask('rm', 'tasks/pr2.md')!;
  assert.equal(live.active_handoff_id !== null, true);
  const verdictR = check(fx, tR.turnId, 'aye', 'review', task.id);
  assert.equal(verdictR.ok, false, 'decline receipt cannot settle a new incoming pending duty');
  tR.close();
});

test('stale and nonce-less native reads and mutations are rejected', { timeout: 60_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/st.md', 'ST');
  const live = openTurn(fx, 'codex', planCtx);
  const got = await live.okJson('task_get', { room_id: 'rm', task_path: 'tasks/st.md' });
  assert.equal(got.view.task.id, task.id);
  live.close();
  // Same closure after its turn ended: stale reads and mutations rejected,
  // never upgraded to any newer turn.
  const staleTools = buildRoomTaskTools(fx.db, fx.jobs, 'codex', fx.dispatcher, {}, {
    ...planCtx, turnId: live.turnId,
  } as RoomTaskToolContext);
  const staleGet = await staleTools.find((x) => x.name === 'task_get')!
    .exec({ room_id: 'rm', task_path: 'tasks/st.md' });
  assert.equal(staleGet.ok, false);
  assert.match(staleGet.text, /过期或无效|重读/);
  const staleMut = await staleTools.find((x) => x.name === 'task_handoff')!
    .exec({
      room_id: 'rm', task_path: 'tasks/st.md', actor_module: 'plan',
      to_module: 'execute', request: 'stale attempt',
    });
  assert.equal(staleMut.ok, false);
  assert.match(staleMut.text, /过期或无效/);
  // No nonce at all: reads and mutations both refused on the model channel.
  const bareTools = buildRoomTaskTools(fx.db, fx.jobs, 'codex', fx.dispatcher, {}, planCtx);
  const bareGet = await bareTools.find((x) => x.name === 'task_get')!
    .exec({ room_id: 'rm', task_path: 'tasks/st.md' });
  assert.equal(bareGet.ok, false, 'nonce-less model read is rejected');
  const bareMut = await bareTools.find((x) => x.name === 'task_handoff')!
    .exec({
      room_id: 'rm', task_path: 'tasks/st.md', actor_module: 'plan',
      to_module: 'execute', request: 'nonce-less attempt',
    });
  assert.equal(bareMut.ok, false, 'nonce-less model mutation is rejected');
});

test('User HTTP read endpoint stays usable without a turn', { timeout: 60_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/User.md', 'User');
  const store = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher, {
    toolContext: { roomId: 'rm', moduleId: 'plan' },
    irisReadEndpoint: true,
  });
  const view = store.getFull({ roomId: 'rm', taskPath: 'tasks/User.md', actorContact: 'User' });
  assert.ok(!('error' in view), 'User endpoint read works');
  assert.equal((view as any).view.task.id, task.id);
  assert.ok(Array.isArray((view as any).view.waits), 'waits exposed to UI');
});

test('DM and task-free turns are unaffected', { timeout: 60_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const turn = beginRoomTurn(fx.db, { roomId: 'rm', contactId: 'codex', moduleId: 'plan' });
  const verdict = check(fx, turn.turnId, 'codex', 'plan');
  assert.equal(verdict.ok, true, 'no related tasks means no obligation');
  endRoomTurn(fx.db, turn.turnId, 'test');
});

test('audit persistence failure latches poison and fails closed', { timeout: 60_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  // Injected audit DB failure: ethics of the trigger — it aborts ONLY
  // attribution inserts; the task mutation itself still succeeds.
  ensureTurnSchema(fx.db);
  fx.db.exec(`CREATE TRIGGER attrib_fail BEFORE INSERT ON room_task_turn_calls
    BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;`);
  try {
    const turn = openTurn(fx, 'codex', planCtx);
    const anchorId = fx.anchor('rm', 'User：批准 tasks/pz.md。');
    const created = await turn.okJson('task_create', {
      room_id: 'rm', task_path: 'tasks/pz.md', title: 'PZ',
      requirements: '原始需求全文。', workspace: fx.dir, anchor_message_id: anchorId,
    });
    assert.ok(created.task.id, 'task mutation itself succeeds');
    assert.equal(isPoisoned(turn.turnId), true, 'failed attribution latches poison');
    // Successful unpinned create + failed attribution INSERT: the guard must
    // see the related task (in-memory touched set) and fail closed — never a
    // silent empty-receipt pass.
    const verdict = check(fx, turn.turnId, 'codex', 'plan');
    assert.equal(verdict.ok, false, 'poisoned turn fails closed');
    assert.match(verdict.reason ?? '', /归属/);
    turn.close();
  } finally {
    fx.db.exec('DROP TRIGGER IF EXISTS attrib_fail');
  }
});

test('begin persistence failure throws (no silent unaudited turn)', { timeout: 60_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  fx.db.exec('DROP TABLE IF EXISTS room_task_turns');
  fx.db.exec('CREATE TABLE room_task_turns (x TEXT)');
  assert.throws(
    () => beginRoomTurn(fx.db, { roomId: 'rm', contactId: 'codex', moduleId: 'plan' }),
    /no such column|no column named/i,
    'begin throws when the audit row cannot persist',
  );
});

test('execution_get explicitly acknowledges an ongoing job', { timeout: 90_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/ack.md', 'ACK');
  const t0 = openTurn(fx, 'codex', planCtx);
  const h1 = await t0.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/ack.md', actor_module: 'plan',
    to_module: 'execute', request: '实现。', evidence_refs: [],
  });
  t0.close();
  const toContact: string = h1.handoff.to_contact;
  const execPinned: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: h1.handoff.id,
  };
  const tE = openTurn(fx, toContact, execPinned);
  await tE.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/ack.md' });
  const started = await tE.okJson('execution_start', {
    room_id: 'rm', task_path: 'tasks/ack.md', module: 'execute',
    expected_revision: (await tE.okJson('task_get', { room_id: 'rm', task_path: 'tasks/ack.md' })).view.task.revision,
    workspace: fx.dir, objective: '实现 ACK。', return_mode: 'notify', return_to_module: 'plan',
  });
  const jobId: string = started.job.id;
  tE.close();
  // Valid ack: a later turn names the exact ongoing job via execution_get.
  const tAck = openTurn(fx, toContact, { roomId: 'rm', moduleId: 'execute' });
  const read = await tAck.okJson('execution_get', {
    room_id: 'rm', task_path: 'tasks/ack.md', job_id: jobId,
  });
  assert.equal(read.job.id, jobId);
  assert.equal(check(fx, tAck.turnId, toContact, 'execute').ok, true, 'explicit ack of the active job settles');
  tAck.close();
  // Terminal job: the same ack now fails.
  fx.db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(jobId);
  const tTerm = openTurn(fx, toContact, { roomId: 'rm', moduleId: 'execute' });
  await tTerm.okJson('execution_get', { room_id: 'rm', task_path: 'tasks/ack.md', job_id: jobId });
  assert.equal(check(fx, tTerm.turnId, toContact, 'execute').ok, false, 'terminal job ack fails');
  tTerm.close();
  // Fenced job: take over via an owner turn, then ack of the old job fails.
  // (Takeover requires a failed/blocked/interrupted attempt.)
  fx.db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(jobId);
  const tTake = openTurn(fx, toContact, execPinned);
  const taken = await tTake.okJson('task_retry', {
    room_id: 'rm', task_path: 'tasks/ack.md', job_id: jobId, mode: 'takeover',
  });
  assert.ok(taken.job.id, 'takeoverReplacement exists');
  tTake.close();
  const tFenced = openTurn(fx, toContact, { roomId: 'rm', moduleId: 'execute' });
  await tFenced.okJson('execution_get', { room_id: 'rm', task_path: 'tasks/ack.md', job_id: jobId });
  assert.equal(check(fx, tFenced.turnId, toContact, 'execute').ok, false, 'fenced job ack fails');
  tFenced.close();
  // Missing callback: legacy linked job without a callback registration.
  const legacy = fx.jobs.create({
    requestedBy: toContact, runner: 'opencode', workspace: fx.dir, prompt: '旧尝试',
    permissions: { write: true, shell: true, ssh: false },
    options: { routeClass: 'implement', taskPath: 'tasks/ack.md' },
    originContactId: 'rm', originAnchorId: null,
  });
  assert.ok(!('error' in legacy));
  const linkStore = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher);
  linkStore.attachVerifiedJobs(linkStore.getTask('rm', 'tasks/ack.md')!, toContact);
  const tNoCb = openTurn(fx, toContact, { roomId: 'rm', moduleId: 'execute' });
  await tNoCb.okJson('execution_get', { room_id: 'rm', task_path: 'tasks/ack.md', job_id: (legacy as any).job.id });
  assert.equal(check(fx, tNoCb.turnId, toContact, 'execute').ok, false, 'ack without a complete callback fails');
  tNoCb.close();
  // A bare task_get list never acknowledges.
  const tList = openTurn(fx, toContact, { roomId: 'rm', moduleId: 'execute' });
  await tList.okJson('task_get', { room_id: 'rm', task_path: 'tasks/ack.md' });
  assert.equal(check(fx, tList.turnId, toContact, 'execute').ok, false, 'task_get list alone never settles');
  tList.close();
});

test('waiting_owner is scoped, verified, and grants nothing', { timeout: 90_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/cb.md', 'CB');
  const t0 = openTurn(fx, 'codex', planCtx);
  const h1 = await t0.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/cb.md', actor_module: 'plan',
    to_module: 'execute', request: '实现。', evidence_refs: [],
  });
  t0.close();
  const toContact: string = h1.handoff.to_contact;
  const execPinned: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: h1.handoff.id,
  };
  const tE = openTurn(fx, toContact, execPinned);
  await tE.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/cb.md' });
  const started = await tE.okJson('execution_start', {
    room_id: 'rm', task_path: 'tasks/cb.md', module: 'execute',
    expected_revision: (await tE.okJson('task_get', { room_id: 'rm', task_path: 'tasks/cb.md' })).view.task.revision,
    workspace: fx.dir, objective: '实现 CB。', return_mode: 'notify', return_to_module: 'plan',
  });
  const jobId: string = started.job.id;
  tE.close();
  const cbRow = fx.db.prepare('SELECT * FROM room_task_callbacks WHERE job_id = ?').get(jobId) as any;
  assert.ok(cbRow, 'explicit callback registered');
  const returnContact: string = cbRow.return_contact;
  const returnModule: string = cbRow.return_module;
  assert.notEqual(returnContact, toContact, 'callback receiver is a non-owner');
  const cbCtx: RoomTaskToolContext = {
    roomId: 'rm', moduleId: returnModule, taskId: task.id, callbackJobId: jobId,
  } as RoomTaskToolContext;
  // Happy path: verified non-owner records scoped waiting_owner.
  const tCb = openTurn(fx, returnContact, cbCtx);
  const waited = await tCb.okJson('task_wait', {
    room_id: 'rm', task_path: 'tasks/cb.md', mode: 'waiting_owner',
    reason: '执行已在途，等待该尝试的完成回调后再定下一步。',
    resume_condition: '收到该 job 的完成回调后继续。',
    expected_revision: new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher).getTask('rm', 'tasks/cb.md')!.revision,
  });
  assert.equal(waited.scope, 'callback');
  const afterWait = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher).getTask('rm', 'tasks/cb.md')!;
  assert.equal(afterWait.owner_contact, toContact, 'ownership unchanged by scoped wait');
  assert.equal(afterWait.status, 'in_progress', 'task status unchanged by scoped wait');
  assert.equal(check(fx, tCb.turnId, returnContact, returnModule, task.id).ok, true, 'scoped wait settles the callback turn');
  tCb.close();
  // Wrong contact cannot borrow the callback scope.
  const tWrongContact = openTurn(fx, toContact, {
    roomId: 'rm', moduleId: returnModule, taskId: task.id, callbackJobId: jobId,
  } as RoomTaskToolContext);
  assert.match(
    await tWrongContact.failText('task_wait', {
      room_id: 'rm', task_path: 'tasks/cb.md', mode: 'waiting_owner',
      reason: '执行已在途，等待该尝试的完成回调后再定下一步。',
      resume_condition: '收到该 job 的完成回调后继续。',
      expected_revision: afterWait.revision,
    }),
    /接收人|不一致/,
  );
  tWrongContact.close();
  // Same contact, different role (module hat) cannot bypass.
  const otherModule = returnModule === 'plan' ? 'execute' : 'plan';
  const tWrongModule = openTurn(fx, returnContact, {
    roomId: 'rm', moduleId: otherModule, taskId: task.id, callbackJobId: jobId,
  } as RoomTaskToolContext);
  assert.match(
    await tWrongModule.failText('task_wait', {
      room_id: 'rm', task_path: 'tasks/cb.md', mode: 'waiting_owner',
      reason: '执行已在途，等待该尝试的完成回调后再定下一步。',
      resume_condition: '收到该 job 的完成回调后继续。',
      expected_revision: afterWait.revision,
    }),
    /模块|接收人|不一致/,
  );
  tWrongModule.close();
  // Wrong job: the same callback registered for task A cannot justify a
  // scoped wait on task B (provenance pinned to B, callback bound to A).
  const { task: task2 } = await createTask(fx, 'tasks/cb2.md', 'CB2');
  const tWrongJob = openTurn(fx, returnContact, {
    roomId: 'rm', moduleId: returnModule, taskId: task2.id, callbackJobId: jobId,
  } as RoomTaskToolContext);
  assert.match(
    await tWrongJob.failText('task_wait', {
      room_id: 'rm', task_path: 'tasks/cb2.md', mode: 'waiting_owner',
      reason: '执行已在途，等待该尝试的完成回调后再定下一步。',
      resume_condition: '收到该 job 的完成回调后继续。',
      expected_revision: new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher).getTask('rm', 'tasks/cb2.md')!.revision,
    }),
    /不一致/,
  );
  tWrongJob.close();
  // Unpinned turn presenting a foreign callback scope cannot borrow it.
  const tBorrow = openTurn(fx, returnContact, {
    roomId: 'rm', moduleId: returnModule, callbackJobId: jobId,
  } as RoomTaskToolContext);
  assert.match(
    await tBorrow.failText('task_wait', {
      room_id: 'rm', task_path: 'tasks/cb.md', mode: 'waiting_owner',
      reason: '执行已在途，等待该尝试的完成回调后再定下一步。',
      resume_condition: '收到该 job 的完成回调后继续。',
      expected_revision: new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher).getTask('rm', 'tasks/cb.md')!.revision,
    }),
    /不一致|借用/,
  );
  tBorrow.close();
  // Terminal callback: the completion callback fires exactly when the job
  // goes terminal, so the non-owner receiver MUST be able to register a
  // scoped wait (awaiting the owner decision) — with zero global mutation.
  // This is not claiming the job is still ongoing.
  fx.db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(jobId);
  const beforeTerminal = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher).getTask('rm', 'tasks/cb.md')!;
  const tTerminalCb = openTurn(fx, returnContact, cbCtx);
  const termWaited = await tTerminalCb.okJson('task_wait', {
    room_id: 'rm', task_path: 'tasks/cb.md', mode: 'waiting_owner',
    reason: '该尝试已完成并回执，等待负责人定夺下一步。',
    resume_condition: '负责人给出下一步决定后继续。',
    expected_revision: beforeTerminal.revision,
  });
  assert.equal(termWaited.scope, 'callback');
  const afterTerminal = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher).getTask('rm', 'tasks/cb.md')!;
  assert.equal(afterTerminal.owner_contact, beforeTerminal.owner_contact, 'no owner mutation');
  assert.equal(afterTerminal.owner_module, beforeTerminal.owner_module, 'no owner mutation');
  assert.equal(afterTerminal.status, beforeTerminal.status, 'no status mutation');
  assert.equal(afterTerminal.revision, beforeTerminal.revision, 'no revision mutation');
  assert.equal(check(fx, tTerminalCb.turnId, returnContact, returnModule, task.id).ok, true, 'terminal-callback scoped wait settles');
  tTerminalCb.close();
  // Fenced callback denied (takeover needs a blocked attempt first).
  fx.db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(jobId);
  const tTake = openTurn(fx, toContact, execPinned);
  await tTake.okJson('task_retry', {
    room_id: 'rm', task_path: 'tasks/cb.md', job_id: jobId, mode: 'takeover',
  });
  tTake.close();
  const tFencedCb = openTurn(fx, returnContact, cbCtx);
  assert.match(
    await tFencedCb.failText('task_wait', {
      room_id: 'rm', task_path: 'tasks/cb.md', mode: 'waiting_owner',
      reason: '执行已在途，等待该尝试的完成回调后再定下一步。',
      resume_condition: '收到该 job 的完成回调后继续。',
      expected_revision: new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher).getTask('rm', 'tasks/cb.md')!.revision,
    }),
    /废弃|围栏|不一致/,
  );
  tFencedCb.close();
  // Owner must use task-level modes, never waiting_owner.
  const tOwnerScoped = openTurn(fx, toContact, {
    roomId: 'rm', moduleId: 'execute', taskId: task.id, callbackJobId: jobId,
  } as RoomTaskToolContext);
  const ownerScopeMsg = await tOwnerScoped.failText('task_wait', {
    room_id: 'rm', task_path: 'tasks/cb.md', mode: 'waiting_owner',
    reason: '执行已在途，等待该尝试的完成回调后再定下一步。',
    resume_condition: '收到该 job 的完成回调后继续。',
    expected_revision: new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher).getTask('rm', 'tasks/cb.md')!.revision,
  });
  assert.match(ownerScopeMsg, /负责人|回调|不一致|废弃/);
  tOwnerScoped.close();
});

test('old waits, stale revisions, wrong tasks and failed dispatches fail', { timeout: 60_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const { task: a } = await createTask(fx, 'tasks/ng1.md', 'NG1');
  const { task: b } = await createTask(fx, 'tasks/ng2.md', 'NG2');
  // Old wait: T1 waits, T2 (pinned, no new receipts) must fail.
  const t1 = openTurn(fx, 'codex', planCtx);
  const revA = (await t1.okJson('task_get', { room_id: 'rm', task_path: 'tasks/ng1.md' })).view.task.revision;
  await t1.okJson('task_wait', {
    room_id: 'rm', task_path: 'tasks/ng1.md', mode: 'waiting_user',
    reason: '需要 User 确认需求边界后再继续推进。',
    question: '边界按方案一还是方案二？',
    expected_revision: revA,
  });
  t1.close();
  const pinnedA: RoomTaskToolContext = { roomId: 'rm', moduleId: 'plan', taskId: a.id };
  const t2 = openTurn(fx, 'codex', pinnedA);
  await t2.okJson('task_get', { room_id: 'rm', task_path: 'tasks/ng1.md' });
  const oldWaitVerdict = check(fx, t2.turnId, 'codex', 'plan', a.id);
  assert.equal(oldWaitVerdict.ok, false, 'historical wait never settles a new turn');
  t2.close();
  // Separately-checked touches: settling A does not settle a merely-read B.
  const t3 = openTurn(fx, 'codex', planCtx);
  await t3.okJson('task_get', { room_id: 'rm', task_path: 'tasks/ng1.md' });
  await t3.okJson('task_get', { room_id: 'rm', task_path: 'tasks/ng2.md' });
  const revA3 = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher).getTask('rm', 'tasks/ng1.md')!.revision;
  await t3.okJson('task_wait', {
    room_id: 'rm', task_path: 'tasks/ng1.md', mode: 'waiting_user',
    reason: '需要 User 确认需求边界后再继续推进。',
    question: '边界按方案一还是方案二？',
    expected_revision: revA3,
  });
  const sepVerdict = check(fx, t3.turnId, 'codex', 'plan');
  assert.equal(sepVerdict.ok, false, 'one settled task does not carry an unsettled one');
  assert.deepEqual(sepVerdict.taskIds, [b.id], 'only the unsettled task is reported');
  t3.close();
  // Failed dispatch: with no dispatcher the handoff stays undelivered; the
  // same turn can still settle by recording a real blocker.
  const fxNoDispatch = fixture();
  t.after(fxNoDispatch.cleanup);
  const tC0 = openTurn(fxNoDispatch, 'codex', planCtx);
  const anchorC = fxNoDispatch.anchor('rm', 'User：批准 tasks/ng3.md。');
  const createdC = await tC0.okJson('task_create', {
    room_id: 'rm', task_path: 'tasks/ng3.md', title: 'NG3',
    requirements: '原始需求全文。', workspace: fxNoDispatch.dir, anchor_message_id: anchorC,
  });
  tC0.close();
  const c = createdC.task;
  const t4turn = beginRoomTurn(fxNoDispatch.db, { roomId: 'rm', contactId: 'codex', moduleId: 'plan' });
  const t4tools = buildRoomTaskTools(fxNoDispatch.db, fxNoDispatch.jobs, 'codex', null, {}, {
    roomId: 'rm', moduleId: 'plan', turnId: t4turn.turnId,
  });
  const failed = await t4tools.find((x) => x.name === 'task_handoff')!.exec({
    room_id: 'rm', task_path: 'tasks/ng3.md', actor_module: 'plan',
    to_module: 'execute', request: '实现。', evidence_refs: [],
  });
  assert.equal(failed.ok, true, 'handoff records even when delivery fails');
  const failedVerdict = check(fxNoDispatch, t4turn.turnId, 'codex', 'plan', c.id);
  assert.equal(failedVerdict.ok, false, 'failed dispatch alone never settles');
  const revC = new RoomTaskStore(fxNoDispatch.db, fxNoDispatch.jobs, fxNoDispatch.dispatcher)
    .getTask('rm', 'tasks/ng3.md')!.revision;
  const waitedC = await t4tools.find((x) => x.name === 'task_wait')!.exec({
    room_id: 'rm', task_path: 'tasks/ng3.md', mode: 'blocked',
    reason: '交接触发投递失败，需要先恢复投递通道再继续。',
    resume_condition: '投递通道恢复后重发交接。',
    expected_revision: revC,
  });
  assert.equal(waitedC.ok, true, 'blocker records in the same turn');
  assert.equal(check(fxNoDispatch, t4turn.turnId, 'codex', 'plan', c.id).ok, true, 'recorded blocker settles after failed dispatch');
  endRoomTurn(fxNoDispatch.db, t4turn.turnId, 'test');
});

function runtimeBaseConfig(dir: string): any {
  return {
    port: 3900,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.db'),
    agentsDir: path.join(dir, 'agents'),
    webDist: '',
    uploadsDir: path.join(dir, 'uploads'),
    claude: { cliPath: 'missing-binary-handoff-obligation' },
    codex: { cliPath: 'missing-binary-handoff-obligation', nativeCompact: { enabled: false } },
    grok: { cliPath: 'missing-binary-handoff-obligation' },
    opencode: { cliPath: 'missing-binary-handoff-obligation' },
    api: { turnTimeoutMs: 8000 },
    memory: {
      mcpUrl: null, repoPath: dir, injectOnSpawn: false, searchPerTurn: false,
      capture: false, maxTurnChars: 0, sessionMaxAgeHours: 0,
    },
    backup: { enabled: false, dir: '', intervalHours: 24, keep: 1 },
  };
}

async function runtimeFixture(): Promise<{
  dir: string; db: ReturnType<typeof openDb>; jobs: JobStore;
  runtime: AgentRuntime; userMsgId: number;
  cleanup: () => Promise<void>;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-handoff-runtime-'));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  const db = openDb(path.join(dir, 'hub.db'));
  const sse = sseHub();
  const jobs = new JobStore(db, sse);
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('api1', 'api1', 'api', 'dm', ?)")
    .run(JSON.stringify({
      provider: 'openai-compat',
      baseUrl: 'http://127.0.0.1:1/v1/chat/completions',
      apiKey: 'test',
      model: 'stub',
      maxTokens: 256,
      maxHistoryMessages: 10,
      historyTokenBudget: 4000,
      memory: { injectOnSpawn: false, searchPerTurn: false, capture: false },
    }));
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('rr', 'RR', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['api1'] }));
  const userMsgId = Number((db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('rr', 'user', 'user', 'text', ?, 'done', '{}', 'main')`
  ).run('User：开始。')).lastInsertRowid);
  const room = db.prepare("SELECT * FROM contacts WHERE id = 'rr'").get() as any;
  const member = db.prepare("SELECT * FROM contacts WHERE id = 'api1'").get() as any;
  const runtime = new AgentRuntime(room, member, {
    db, sse, config: runtimeBaseConfig(dir), vault: null, jobStore: jobs,
  }, { moduleId: 'plan' });
  return {
    dir, db, jobs, runtime, userMsgId,
    cleanup: async () => {
      try { await runtime.stop(); } catch { /* ignore */ }
      try { (jobs as any).stopOutOfBandResolver?.(); } catch { /* ignore */ }
      try { db.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('runtime origin init failure fails the turn visibly, never normal done', { timeout: 60_000 }, async (t) => {
  const fx = await runtimeFixture();
  t.after(fx.cleanup);
  // Break audit persistence so beginRoomTurn throws.
  fx.db.exec('DROP TABLE IF EXISTS room_task_turns');
  fx.db.exec('CREATE TABLE room_task_turns (x TEXT)');
  const outcome = await fx.runtime.runRoomTurn('normal', undefined, fx.userMsgId);
  assert.equal(outcome, 'error', 'init failure never settles normally');
  const errRow = fx.db.prepare(
    "SELECT content FROM messages WHERE contact_id = 'rr' AND kind = 'error' AND content LIKE '%初始化失败%'"
  ).get() as { content: string } | undefined;
  assert.ok(errRow, 'visible init-failure error, no silent bypass');
  const spoke = fx.db.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE contact_id = 'rr' AND sender = 'api1' AND kind = 'text'"
  ).get() as { c: number };
  assert.equal(spoke.c, 0, 'no model text on init failure');
});

test('compose failure revokes the origin nonce', { timeout: 60_000 }, async (t) => {
  const fx = await runtimeFixture();
  t.after(fx.cleanup);
  const prompts = (fx.runtime as any).prompts;
  const orig = prompts.composeTurn;
  prompts.composeTurn = async () => { throw new Error('injected compose failure'); };
  try {
    const outcome = await fx.runtime.runRoomTurn('normal', undefined, fx.userMsgId);
    assert.equal(outcome, 'error');
    const errRow = fx.db.prepare(
      "SELECT content FROM messages WHERE contact_id = 'rr' AND kind = 'error' AND content LIKE '%轮次启动失败%'"
    ).get() as { content: string } | undefined;
    assert.ok(errRow, 'compose failure surfaces visibly');
    const turnRow = fx.db.prepare(
      "SELECT turn_id, status FROM room_task_turns WHERE room_id = 'rr' AND contact_id = 'api1'"
    ).get() as { turn_id: string; status: string } | undefined;
    assert.ok(turnRow, 'origin turn was registered');
    assert.equal(turnRow!.status, 'error', 'leaked nonce revoked on compose failure');
    assert.equal(getTurn(turnRow!.turn_id), undefined, 'no active identity remains');
  } finally {
    prompts.composeTurn = orig;
  }
});

test('sendTurn throw revokes the origin nonce', { timeout: 60_000 }, async (t) => {
  const fx = await runtimeFixture();
  t.after(fx.cleanup);
  const { DirectApiBackend } = await import('../src/backends/directApi.js');
  const orig = DirectApiBackend.prototype.sendTurn;
  (DirectApiBackend.prototype as any).sendTurn = function (this: unknown) {
    throw new Error('injected sendTurn failure');
  };
  try {
    const outcome = await fx.runtime.runRoomTurn('normal', undefined, fx.userMsgId);
    assert.equal(outcome, 'error');
    const turnRow = fx.db.prepare(
      "SELECT turn_id, status FROM room_task_turns WHERE room_id = 'rr' AND contact_id = 'api1'"
    ).get() as { turn_id: string; status: string } | undefined;
    assert.ok(turnRow, 'origin turn was registered');
    assert.equal(turnRow!.status, 'error', 'leaked nonce revoked on sendTurn throw');
    assert.equal(getTurn(turnRow!.turn_id), undefined, 'no active identity remains');
  } finally {
    DirectApiBackend.prototype.sendTurn = orig;
  }
});

const CLSHA = (ch: string) => ch.repeat(40);
const CL_BASE = CLSHA('c');
const CL_H1 = CLSHA('a');
const CL_H2 = CLSHA('b');
const CL_RECEIPT = (o: {
  branch: string; head: string; beforeHead?: string; stage?: string;
  committed?: boolean; pushed?: boolean; tests?: Array<{ suite: string; status: 'pass' | 'fail' }>;
}) => JSON.stringify({
  receipt: {
    branch: o.branch,
    head: o.head,
    diffstat: '1 file changed, 10 insertions(+)',
    changedFiles: { files: ['src/a.ts'], total: 1 },
    tests: o.tests ?? [{ suite: 'unit', status: 'pass' }],
  },
  before: { head: o.beforeHead ?? CL_BASE },
  declared: {
    stage: o.stage ?? 'delivered',
    committed: o.committed ?? false,
    pushed: o.pushed ?? false,
    summary: 'simulated worker receipt',
  },
});
const CL_MERGE_SUITES = [
  'server npm run pretest', 'server npm test', 'web npm test',
  'smoke:deploy-drain', 'smoke:turn-timeouts', 'smoke:deploy-resume',
].map((suite) => ({ suite, status: 'pass' as const }));

test('real evidence chain closes the task and the closed task passes', { timeout: 120_000 }, async (t) => {
  const fx = fixture();
  t.after(fx.cleanup);
  const finish = async (jobId: string, status: 'done' | 'blocked' | 'failed', meta: string): Promise<void> => {
    fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
    const outcome = fx.jobs.complete(
      fx.jobs.get(jobId)!, status, `simulated ${status}`,
      status === 'failed' ? 'boom' : null,
      status === 'done' ? 'delivered' : status === 'blocked' ? 'blocked_unpushed' : 'failed',
      meta,
    );
    assert.ok(!('error' in outcome), `complete failed: ${JSON.stringify(outcome)}`);
    new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher)
      .handleJobFinished(fx.jobs.get(jobId)!, { finalAttempt: true });
  };
  const taskOf = (taskPath: string) =>
    new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher).getTask('rm', taskPath)!;
  const revOf = (taskPath: string): number => taskOf(taskPath).revision;

  const { task } = await createTask(fx, 'tasks/close.md', 'CLOSE');
  // Execute: handoff -> accept -> start -> done, then pin the candidate.
  const tH = openTurn(fx, 'codex', planCtx);
  const hExec = await tH.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/close.md', actor_module: 'plan',
    to_module: 'execute', request: '实现。', evidence_refs: [],
  });
  tH.close();
  const execContact: string = hExec.handoff.to_contact;
  const tX = openTurn(fx, execContact, {
    roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: hExec.handoff.id,
  });
  await tX.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/close.md' });
  await tX.ok('execution_start', {
    room_id: 'rm', task_path: 'tasks/close.md', module: 'execute',
    expected_revision: revOf('tasks/close.md'),
    workspace: fx.dir, objective: '实现 CLOSE。', return_mode: 'notify', return_to_module: 'plan',
  });
  const execJobId: string = (fx.db.prepare(
    `SELECT job_id FROM room_task_links WHERE task_id = ? ORDER BY rowid DESC LIMIT 1`
  ).get(task.id) as { job_id: string }).job_id;
  await finish(execJobId, 'done', CL_RECEIPT({ branch: 'feat-x', head: CL_H1 }));
  await tX.okJson('task_submit_evidence', {
    room_id: 'rm', task_path: 'tasks/close.md', kind: 'candidate',
    ref: execJobId, body: CL_H1, expected_revision: revOf('tasks/close.md'),
  });
  // Review: handoff -> accept -> approve.
  const hRev = await tX.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/close.md', actor_module: 'execute',
    to_module: 'review', request: '评审 H1。', evidence_refs: [execJobId],
  });
  tX.close();
  const revContact: string = hRev.handoff.to_contact;
  const tR = openTurn(fx, revContact, {
    roomId: 'rm', moduleId: 'review', taskId: task.id, handoffId: hRev.handoff.id,
  });
  await tR.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/close.md' });
  await tR.okJson('review_submit', {
    room_id: 'rm', task_path: 'tasks/close.md', module: 'review',
    candidate_job_id: execJobId, candidate_sha: CL_H1,
    verdict: 'approve', findings: 'H1 已核对，通过。', evidence_refs: [execJobId],
  });
  // Merge: handoff -> accept -> release -> done with full deploy evidence.
  const hMerge = await tR.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/close.md', actor_module: 'review',
    to_module: 'merge', request: '合并冻结版本。', evidence_refs: [],
  });
  tR.close();
  const mergeContact: string = hMerge.handoff.to_contact;
  const tM = openTurn(fx, mergeContact, {
    roomId: 'rm', moduleId: 'merge', taskId: task.id, handoffId: hMerge.handoff.id,
  });
  await tM.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/close.md' });
  await tM.ok('release_execute', {
    room_id: 'rm', task_path: 'tasks/close.md', kind: 'merge',
    return_mode: 'notify', return_to_module: 'deploy', expected_revision: revOf('tasks/close.md'),
  });
  const mergeJobId: string = (fx.db.prepare(
    `SELECT job_id FROM room_task_links WHERE task_id = ? ORDER BY rowid DESC LIMIT 1`
  ).get(task.id) as { job_id: string }).job_id;
  await finish(mergeJobId, 'done', CL_RECEIPT({
    branch: 'master', head: CL_H1, stage: 'delivered_waiting_deploy',
    committed: true, pushed: true, tests: CL_MERGE_SUITES,
  }));
  assert.equal(taskOf('tasks/close.md').status, 'in_review');
  // Deploy: handoff -> accept -> release -> done closes the task for real.
  const hDeploy = await tM.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/close.md', actor_module: 'merge',
    to_module: 'deploy', request: '上线冻结版本。', evidence_refs: [mergeJobId],
  });
  tM.close();
  const deployContact: string = hDeploy.handoff.to_contact;
  const tD = openTurn(fx, deployContact, {
    roomId: 'rm', moduleId: 'deploy', taskId: task.id, handoffId: hDeploy.handoff.id,
  });
  await tD.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/close.md' });
  await tD.ok('release_execute', {
    room_id: 'rm', task_path: 'tasks/close.md', kind: 'deploy',
    return_mode: 'notify', return_to_module: 'plan', expected_revision: revOf('tasks/close.md'),
  });
  const deployJobId: string = (fx.db.prepare(
    `SELECT job_id FROM room_task_links WHERE task_id = ? ORDER BY rowid DESC LIMIT 1`
  ).get(task.id) as { job_id: string }).job_id;
  await finish(deployJobId, 'done', CL_RECEIPT({ branch: 'master', head: CL_H1 }));
  tD.close();
  assert.equal(taskOf('tasks/close.md').status, 'closed', 'real evidence chain closes the task');
  // A later turn touching the closed task passes with no new disposition.
  // (The full view exceeds display slicing; assert ok and read state via DB.)
  const tDone = openTurn(fx, 'codex', planCtx);
  await tDone.ok('task_get', { room_id: 'rm', task_path: 'tasks/close.md' });
  assert.equal(check(fx, tDone.turnId, 'codex', 'plan').ok, true, 'genuinely closed task passes');
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ? AND kind = 'turn-unsettled'").get(task.id) as { c: number }).c,
    0,
    'no unsettled marker for a closed task',
  );
  tDone.close();
});

test('structured receipts survive long payloads: turn_calls keep exact handoff/job ids', { timeout: 60_000 }, async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const taskPath = 'tasks/structured-receipt.md';
  const requirements = 'Structured credential requirement. '.repeat(300).trim();
  const plan = openTurn(fx, 'codex', planCtx);
  const created = await plan.okJson('task_create', {
    room_id: 'rm', task_path: taskPath, title: 'Structured', requirements,
    workspace: fx.dir, anchor_message_id: fx.anchor('rm', `User: approved ${taskPath}`),
  });
  const sent = await plan.okJson('task_handoff', {
    room_id: 'rm', task_path: taskPath, to_module: 'execute', request: 'Implement.',
  });
  const planCalls = fx.db.prepare(
    `SELECT tool, detail FROM room_task_turn_calls WHERE turn_id = ? AND ok = 1 ORDER BY id ASC`,
  ).all(plan.turnId) as Array<{ tool: string; detail: string }>;
  const handoffCall = planCalls.find((row) => row.tool === 'task_handoff');
  assert.ok(handoffCall, 'handoff call is audited');
  assert.match(handoffCall.detail, new RegExp(`handoff=${sent.handoff.id}`), 'exact handoff id survives long payloads');
  assert.match(handoffCall.detail, /dispatch=(posted|duplicate)/, 'dispatch status survives');
  assert.equal(check(fx, plan.turnId, 'codex', 'plan').ok, true);
  plan.close();
  const exec = openTurn(fx, sent.handoff.to_contact, {
    roomId: 'rm', moduleId: 'execute', taskId: created.task.id, handoffId: sent.handoff.id,
  });
  await exec.okJson('task_accept', { room_id: 'rm', task_path: taskPath });
  const view = await exec.okJson('task_get', { room_id: 'rm', task_path: taskPath });
  const started = await exec.okJson('execution_start', {
    room_id: 'rm', task_path: taskPath, module: 'execute',
    expected_revision: view.view.task.revision, workspace: fx.dir,
    objective: 'Implement structured.', return_mode: 'notify', return_to_module: 'plan',
  });
  const execCalls = fx.db.prepare(
    `SELECT tool, detail FROM room_task_turn_calls WHERE turn_id = ? AND ok = 1 ORDER BY id ASC`,
  ).all(exec.turnId) as Array<{ tool: string; detail: string }>;
  const startCall = execCalls.find((row) => row.tool === 'execution_start');
  assert.ok(startCall, 'execution_start is audited');
  assert.match(startCall.detail, new RegExp(`job=${started.job.id}`), 'exact job id survives long payloads');
  assert.equal(check(fx, exec.turnId, sent.handoff.to_contact, 'execute').ok, true);
  exec.close();
});

test('missing disposition returns a specific bounded remedy hint', { timeout: 60_000 }, async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/remedy.md', 'REMEDY');
  const t0 = openTurn(fx, 'codex', planCtx);
  const h1 = await t0.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/remedy.md', actor_module: 'plan',
    to_module: 'execute', request: '实现。', evidence_refs: [],
  });
  t0.close();
  const execPinned: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: h1.handoff.id,
  };
  // Accept-only: specific accepted-idle hint, still fails, one-time补办 stays model-driven.
  const tAccept = openTurn(fx, 'muse', execPinned);
  await tAccept.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/remedy.md' });
  const verdictAccept = check(fx, tAccept.turnId, 'muse', 'execute', task.id);
  assert.equal(verdictAccept.ok, false);
  assert.ok(verdictAccept.remedies?.[0], 'remedy is attached');
  assert.equal(verdictAccept.remedies?.[0].code, 'accepted-idle');
  assert.match(verdictAccept.remedies?.[0].hint ?? '', /已接受交接，但未执行或登记等待/);
  assert.match(verdictAccept.reason ?? '', /补办指引/);
  assert.match(verdictAccept.reason ?? '', /当前合法轮次/);
  tAccept.close();
  // Read-only: specific read-only hint.
  const tRead = openTurn(fx, 'muse', { roomId: 'rm', moduleId: 'execute', taskId: task.id });
  await tRead.okJson('task_get', { room_id: 'rm', task_path: 'tasks/remedy.md' });
  const verdictRead = check(fx, tRead.turnId, 'muse', 'execute', task.id);
  assert.equal(verdictRead.ok, false);
  assert.equal(verdictRead.remedies?.[0].code, 'read-only');
  tRead.close();
  // Evidence-only: specific evidence-only hint.
  const tEv = openTurn(fx, 'muse', { roomId: 'rm', moduleId: 'execute', taskId: task.id });
  await tEv.okJson('task_submit_evidence', {
    room_id: 'rm', task_path: 'tasks/remedy.md', kind: 'note', body: '仅证据，无责任去向。',
  });
  const verdictEv = check(fx, tEv.turnId, 'muse', 'execute', task.id);
  assert.equal(verdictEv.ok, false);
  assert.equal(verdictEv.remedies?.[0].code, 'evidence-only');
  tEv.close();
  void h1;
});

test('unsettled recovery is display-only: later valid handoff recovers, unrelated work does not', { timeout: 60_000 }, async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/recover.md', 'RECOVER');
  const other = await createTask(fx, 'tasks/recover-other.md', 'OTHER');
  void other;
  const t0 = openTurn(fx, 'codex', planCtx);
  const h1 = await t0.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/recover.md', actor_module: 'plan',
    to_module: 'execute', request: '实现。', evidence_refs: [],
  });
  t0.close();
  // Failed turn: accept-only, then record an honest unsettled marker (kept forever).
  const failed = openTurn(fx, 'muse', {
    roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: h1.handoff.id,
  });
  await failed.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/recover.md' });
  assert.equal(check(fx, failed.turnId, 'muse', 'execute', task.id).ok, false);
  const store = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher);
  const { recordUnsettled } = await import('../src/roomTasks/handoffObligation.js');
  recordUnsettled(store, task.id, 'muse', { turnId: failed.turnId, reason: 'test unsettled' }, 'execute');
  const before = findUnsettledRecovery(fx.db, fx.jobs, task.id, failed.turnId);
  assert.equal(before.recovered, false, 'no later handling yet: stays red');
  failed.close();
  // Unrelated-task activity must not clear the alarm.
  const unrelated = openTurn(fx, 'codex', planCtx);
  await unrelated.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/recover-other.md', actor_module: 'plan',
    to_module: 'execute', request: '无关任务。', evidence_refs: [],
  });
  unrelated.close();
  assert.equal(findUnsettledRecovery(fx.db, fx.jobs, task.id, failed.turnId).recovered, false);
  // Subsequent valid handling on the same task + chain recovers the display.
  const remedy = openTurn(fx, 'muse', { roomId: 'rm', moduleId: 'execute', taskId: task.id });
  const onward = await remedy.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/recover.md', actor_module: 'execute',
    to_module: 'plan', request: '回 plan 定夺。', evidence_refs: [],
  });
  void onward;
  remedy.close();
  const after = findUnsettledRecovery(fx.db, fx.jobs, task.id, failed.turnId);
  assert.equal(after.recovered, true, 'later posted handoff recovers the display');
  assert.match(after.summary ?? '', /后续已恢复/);
  assert.ok(after.evidence[0]?.eventId, 'recovery evidence is traceable');
  // Original audit is preserved, never rewritten to settled.
  const unsettledCount = (fx.db.prepare(
    "SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ? AND kind = 'turn-unsettled'",
  ).get(task.id) as { c: number }).c;
  assert.equal(unsettledCount, 1, 'original failure audit is kept');
  const batch = findTaskUnsettledRecoveries(fx.db, fx.jobs, task.id);
  assert.equal(batch.length, 1);
  assert.equal(batch[0].recovered, true);
  // getFull exposes the same recovery for the UI without touching history.
  const viewer = openTurn(fx, 'codex', planCtx);
  const full = await viewer.okJson('task_get', { room_id: 'rm', task_path: 'tasks/recover.md' });
  const recoveries = (full.view as { unsettledRecoveries?: Array<{ turnId: string; recovered: boolean }> }).unsettledRecoveries ?? [];
  assert.equal(recoveries.find((entry) => entry.turnId === failed.turnId)?.recovered, true);
  viewer.close();
});

test('bounded remedy: stale nonce cannot补办, fresh turn can once without duplicating work', { timeout: 60_000 }, async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/bounded.md', 'BOUNDED');
  const t0 = openTurn(fx, 'codex', planCtx);
  const h1 = await t0.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/bounded.md', actor_module: 'plan',
    to_module: 'execute', request: '实现。', evidence_refs: [],
  });
  t0.close();
  const execPinned: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: h1.handoff.id,
  };
  const failed = openTurn(fx, 'muse', execPinned);
  await failed.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/bounded.md' });
  assert.equal(check(fx, failed.turnId, 'muse', 'execute', task.id).ok, false);
  failed.close();
  // Stale closure after its turn ended: never upgraded, never writes.
  const staleTools = buildRoomTaskTools(fx.db, fx.jobs, 'muse', fx.dispatcher, {}, {
    ...execPinned, turnId: failed.turnId,
  } as RoomTaskToolContext);
  const stale = await staleTools.find((entry) => entry.name === 'task_handoff')!
    .exec({ room_id: 'rm', task_path: 'tasks/bounded.md', actor_module: 'execute', to_module: 'plan', request: 'stale补办' });
  assert.equal(stale.ok, false);
  assert.match(stale.text, /过期或无效/);
  // Fresh legal turn补办 once: exact handoff, no duplicate worker, no越权, no loop.
  const jobsBefore = (fx.db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c;
  const remedy = openTurn(fx, 'muse', { roomId: 'rm', moduleId: 'execute', taskId: task.id });
  const onward = await remedy.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/bounded.md', actor_module: 'execute',
    to_module: 'plan', request: '补办：回 plan 定夺。', evidence_refs: [],
  });
  assert.equal(onward.delivery.status, 'posted');
  assert.equal(check(fx, remedy.turnId, 'muse', 'execute', task.id).ok, true, 'fresh-turn补办 settles once');
  remedy.close();
  assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c, jobsBefore, '补办 creates no worker');
});

test('stale waits and superseded handoffs never read as recovery', { timeout: 60_000 }, async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/rec-stale.md', 'RECSTALE');
  const storeOf = () => new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher);
  // Failed turn: read-only, then an honest unsettled marker.
  const failed = openTurn(fx, 'codex', planCtx);
  await failed.okJson('task_get', { room_id: 'rm', task_path: 'tasks/rec-stale.md' });
  assert.equal(check(fx, failed.turnId, 'codex', 'plan', task.id).ok, false);
  const { recordUnsettled } = await import('../src/roomTasks/handoffObligation.js');
  recordUnsettled(storeOf(), task.id, 'codex', { turnId: failed.turnId, reason: 'test unsettled' }, 'plan');
  assert.equal(findUnsettledRecovery(fx.db, fx.jobs, task.id, failed.turnId).recovered, false);
  failed.close();
  // Unrelated-task waits must not clear this task's alarm.
  const other = await createTask(fx, 'tasks/rec-stale-other.md', 'OTHER');
  void other;
  const otherWait = openTurn(fx, 'codex', planCtx);
  const otherRev = storeOf().getTask('rm', 'tasks/rec-stale-other.md')!.revision;
  await otherWait.okJson('task_wait', {
    room_id: 'rm', task_path: 'tasks/rec-stale-other.md', mode: 'waiting_user',
    reason: '需要 User 确认另一任务的边界后再继续推进。',
    question: '另一任务边界按方案一还是方案二？',
    expected_revision: otherRev,
  });
  otherWait.close();
  assert.equal(
    findUnsettledRecovery(fx.db, fx.jobs, task.id, failed.turnId).recovered,
    false,
    'cross-task waits never recover this task',
  );
  // Subsequent exact wait recovers (positive control: numeric waitId path).
  const waiter = openTurn(fx, 'codex', planCtx);
  const rev = storeOf().getTask('rm', 'tasks/rec-stale.md')!.revision;
  await waiter.okJson('task_wait', {
    room_id: 'rm', task_path: 'tasks/rec-stale.md', mode: 'blocked',
    reason: '外部依赖缺失导致无法继续，需要先补齐上游接口文档。',
    resume_condition: '拿到上游接口文档后继续。',
    expected_revision: rev,
  });
  waiter.close();
  assert.equal(findUnsettledRecovery(fx.db, fx.jobs, task.id, failed.turnId).recovered, true);
  // A later handoff bumps the revision (the wait goes stale) and is then
  // cancelled (superseded): no live disposition remains → unrecovered.
  const churn = openTurn(fx, 'codex', planCtx);
  const handoff = await churn.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/rec-stale.md', actor_module: 'plan',
    to_module: 'execute', request: 'Bump the revision, then cancel.',
  });
  await churn.okJson('task_retry', {
    room_id: 'rm', handoff_id: handoff.handoff.id, mode: 'cancel-handoff',
  });
  churn.close();
  assert.equal(
    findUnsettledRecovery(fx.db, fx.jobs, task.id, failed.turnId).recovered,
    false,
    'stale wait + superseded handoff never count as recovery',
  );
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ? AND kind = 'turn-unsettled'").get(task.id) as { c: number }).c,
    1,
    'original failure audit is kept',
  );
});

test('fenced callback waits never read as recovery', { timeout: 90_000 }, async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const { task } = await createTask(fx, 'tasks/rec-fence.md', 'RECFENCE');
  // Force the first handoff delivery to fail so no live posted handoff can
  // mask the wait branch under test.
  const originalImage = fx.manager.imageRoomMembers.bind(fx.manager);
  fx.manager.imageRoomMembers = () => [];
  const t0 = openTurn(fx, 'codex', planCtx);
  const h1 = await t0.okJson('task_handoff', {
    room_id: 'rm', task_path: 'tasks/rec-fence.md', actor_module: 'plan',
    to_module: 'execute', request: '实现。', evidence_refs: [],
  });
  t0.close();
  fx.manager.imageRoomMembers = originalImage;
  assert.equal(
    (fx.db.prepare('SELECT status FROM room_task_dispatches WHERE idempotency_key = ?')
      .get(`task-handoff:v1:${h1.handoff.id}`) as { status: string }).status,
    'failed',
    'premise: the handoff delivery failed, isolating the wait branch',
  );
  const execContact: string = h1.handoff.to_contact;
  const execPinned: RoomTaskToolContext = {
    roomId: 'rm', moduleId: 'execute', taskId: task.id, handoffId: h1.handoff.id,
  };
  // Failed turn: accept-only.
  const failed = openTurn(fx, execContact, execPinned);
  await failed.okJson('task_accept', { room_id: 'rm', task_path: 'tasks/rec-fence.md' });
  assert.equal(check(fx, failed.turnId, execContact, 'execute', task.id).ok, false);
  const storeOf = () => new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher);
  const { recordUnsettled } = await import('../src/roomTasks/handoffObligation.js');
  recordUnsettled(storeOf(), task.id, execContact, { turnId: failed.turnId, reason: 'test unsettled' }, 'execute');
  assert.equal(findUnsettledRecovery(fx.db, fx.jobs, task.id, failed.turnId).recovered, false);
  failed.close();
  // Execute with a callback to plan, then a scoped wait → recovered.
  const exec = openTurn(fx, execContact, { roomId: 'rm', moduleId: 'execute', taskId: task.id });
  const view = await exec.okJson('task_get', { room_id: 'rm', task_path: 'tasks/rec-fence.md' });
  const started = await exec.okJson('execution_start', {
    room_id: 'rm', task_path: 'tasks/rec-fence.md', module: 'execute',
    expected_revision: view.view.task.revision, workspace: fx.dir,
    objective: '实现 RECFENCE。', return_mode: 'notify', return_to_module: 'plan',
  });
  const jobId: string = started.job.id;
  exec.close();
  const cbRow = fx.db.prepare('SELECT * FROM room_task_callbacks WHERE job_id = ?').get(jobId) as any;
  assert.ok(cbRow, 'explicit callback registered');
  const cbTurn = openTurn(fx, cbRow.return_contact, {
    roomId: 'rm', moduleId: cbRow.return_module, taskId: task.id, callbackJobId: jobId,
  } as RoomTaskToolContext);
  await cbTurn.okJson('task_wait', {
    room_id: 'rm', task_path: 'tasks/rec-fence.md', mode: 'waiting_owner',
    reason: '执行已在途，等待该尝试的完成回调后再定下一步。',
    resume_condition: '收到该 job 的完成回调后继续。',
    expected_revision: storeOf().getTask('rm', 'tasks/rec-fence.md')!.revision,
  });
  cbTurn.close();
  assert.equal(
    findUnsettledRecovery(fx.db, fx.jobs, task.id, failed.turnId).recovered,
    true,
    'live scoped wait recovers',
  );
  // Takeover fences the callback attempt → the scoped wait must stop counting.
  fx.db.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run(jobId);
  const take = openTurn(fx, execContact, { roomId: 'rm', moduleId: 'execute', taskId: task.id });
  await take.okJson('task_retry', {
    room_id: 'rm', task_path: 'tasks/rec-fence.md', job_id: jobId, mode: 'takeover',
  });
  take.close();
  assert.equal(
    findUnsettledRecovery(fx.db, fx.jobs, task.id, failed.turnId).recovered,
    false,
    'fenced callback wait never counts as recovery',
  );
});
