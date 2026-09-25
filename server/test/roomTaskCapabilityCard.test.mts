// 能力卡（capability card）受理对照：worker 心跳上报 capabilityCard 后，
// execute auto_start / execution_start / 直启返修 / sequence 直启在选定
// Worker 后对照卡片拒绝；卡缺失（旧 worker）视为通过。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { openDb } from '../src/platform/db.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import type { RoomTaskToolContext } from '../src/roomTasks/roomTaskStore.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { boundedDeliveryMeta } from '../src/jobs/receiptFields.js';
import { workersRouter } from '../src/jobs/workerRoutes.js';
import type { SseHub } from '../src/platform/sse.js';

const SHA = (ch: string) => ch.repeat(40);
const A = SHA('a');
const BASE = SHA('c');
const MERGE_SUITES = [
  'server npm run pretest', 'server npm test', 'web npm test',
  'smoke:deploy-drain', 'smoke:turn-timeouts', 'smoke:deploy-resume',
].map((suite) => ({ suite, status: 'pass' as const }));

const SEQ2 = [
  { label: 'W0', objective: '做 W0：地基接口' },
  { label: 'W1', objective: '做 W1：上层装配' },
];

const goodCard = () => ({
  runners: { opencode: { ok: true, checkedAt: new Date().toISOString() } },
  workspaceWritable: true,
  npmCacheWritable: true,
  configVisible: true,
});

function setup(governance = 'open') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-cap-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const jobs = new JobStore(db, { broadcast: () => {} } as unknown as SseHub);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(id, id, backend);
  }
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('r1', 'r1', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse', 'aye'], governance }));
  // execute 绑定（muse）固定到 Worker w-cap：受理对照的“选定 Worker”。
  db.prepare("UPDATE contacts SET config = ? WHERE id = 'muse'")
    .run(JSON.stringify({ delegation: { enabled: true, workspaces: [dir], workerId: 'w-cap' } }));
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

function upsertWorker(fx: ReturnType<typeof setup>, id: string, capabilities: Record<string, unknown>) {
  fx.db.prepare(
    `INSERT INTO workers (id, name, token_hash, capabilities, status, accepting_jobs, last_seen_at)
     VALUES (?, ?, 'test', ?, 'online', 1, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET capabilities = excluded.capabilities, last_seen_at = datetime('now')`,
  ).run(id, id, JSON.stringify(capabilities));
}

const workerCaps = (card: unknown) => ({
  runners: ['opencode'],
  workspaces: ['/tmp'],
  shell: true,
  ...(card === undefined ? {} : { capabilityCard: card }),
});

async function call(fx: ReturnType<typeof setup>, taskPath: string, actor: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) {
  const { db, jobs, dispatch } = fx;
  const turn = beginRoomTurn(db, { ...ctx, contactId: actor });
  try {
    const tool = buildRoomTaskTools(db, jobs, actor, dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === name)!;
    const result = await tool.exec({ room_id: 'r1', task_path: taskPath, ...args });
    assert.equal(result.ok, true, `${name}: ${result.text}`);
    return JSON.parse(result.text);
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

async function failCall(fx: ReturnType<typeof setup>, taskPath: string, actor: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) {
  const { db, jobs, dispatch } = fx;
  const turn = beginRoomTurn(db, { ...ctx, contactId: actor });
  try {
    const tool = buildRoomTaskTools(db, jobs, actor, dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === name)!;
    const result = await tool.exec({ room_id: 'r1', task_path: taskPath, ...args });
    assert.equal(result.ok, false, `${name} should fail`);
    return result.text;
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

async function createTask(fx: ReturnType<typeof setup>, taskPath: string) {
  const created = await call(fx, taskPath, 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'CAP', requirements: 'req', workspace: fx.dir, anchor_message_id: fx.anchor,
  });
  return created.task.id as string;
}

async function autoStartExecute(fx: ReturnType<typeof setup>, taskPath: string, taskId: string) {
  return call(fx, taskPath, 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', {
    to_module: 'execute', note: '直启执行', auto_start: true,
    expected_revision: fx.store.getTask('r1', taskPath)!.revision,
  });
}

async function failAutoStart(fx: ReturnType<typeof setup>, taskPath: string, taskId: string) {
  return failCall(fx, taskPath, 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', {
    to_module: 'execute', note: '直启执行', auto_start: true,
    expected_revision: fx.store.getTask('r1', taskPath)!.revision,
  });
}

function rejectEvent(fx: ReturnType<typeof setup>, taskId: string) {
  const row = fx.db.prepare("SELECT payload FROM room_task_events WHERE task_id = ? AND kind = 'capability-reject' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as Record<string, unknown> : null;
}

function rejectFact(fx: ReturnType<typeof setup>, taskId: string) {
  return fx.db.prepare("SELECT content FROM messages WHERE contact_id = 'r1' AND meta LIKE '%room-task-capability-reject%' ORDER BY id DESC LIMIT 1")
    .get() as { content: string } | undefined;
}

test('T1 心跳含 capabilityCard 四个字段（connect 上报 → /api/workers 透出）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-cap-t1-'));
  const db = openDb(path.join(dir, 'hub.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const jobs = new JobStore(db, { broadcast: () => {} } as unknown as SseHub);
  const token = 'w-cap.t1-secret';
  db.prepare(`INSERT INTO workers (id, name, token_hash, capabilities, status, accepting_jobs, last_seen_at)
    VALUES ('w-cap', 'w', ?, '{}', 'offline', 1, NULL)`)
    .run(crypto.createHash('sha256').update(token).digest('hex'));
  const app = express();
  app.use(express.json());
  app.use('/api', workersRouter(db, { broadcast: () => {} } as unknown as SseHub, jobs));
  const listener: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('missing test listener address');
  const card = goodCard();
  const connect = await fetch(`http://127.0.0.1:${address.port}/api/worker/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      capabilities: { runners: ['opencode'], workspaces: [dir], shell: true, capabilityCard: card },
      bootId: 't1',
    }),
  });
  assert.equal(connect.status, 200, await connect.clone().text());
  const listed = await (await fetch(`http://127.0.0.1:${address.port}/api/workers`)).json() as {
    workers: Array<{ id: string; capabilities: { capabilityCard?: Record<string, unknown> } }>;
  };
  const worker = listed.workers.find((item) => item.id === 'w-cap');
  assert.ok(worker, 'worker listed');
  const reported = worker!.capabilities.capabilityCard;
  assert.ok(reported, 'heartbeat carries capabilityCard');
  for (const field of ['runners', 'workspaceWritable', 'npmCacheWritable', 'configVisible']) {
    assert.ok(Object.hasOwn(reported!, field), `capabilityCard has ${field}`);
  }
  assert.deepEqual(reported!['runners'], card.runners);
});

test('T2 runner 探测失败时受理拒绝：事件 kind=capability-reject 且原因行格式匹配', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  upsertWorker(fx, 'w-cap', workerCaps({
    ...goodCard(),
    runners: { opencode: { ok: false, checkedAt: new Date().toISOString(), error: 'opencode --version failed' } },
  }));
  const taskId = await createTask(fx, 'tasks/cap-t2.md');
  const text = await failAutoStart(fx, 'tasks/cap-t2.md', taskId);
  assert.match(text, /^capability-reject: w-cap runner=opencode /);
  const event = rejectEvent(fx, taskId);
  assert.ok(event, '记 capability-reject 事件');
  assert.equal(event!['workerId'], 'w-cap');
  assert.equal(event!['field'], 'runner');
  assert.match(String(event!['reasonLine']), /^capability-reject: w-cap runner=opencode /);
  const fact = rejectFact(fx, taskId);
  assert.ok(fact?.content.includes('【能力卡拒绝】'), fact?.content);
  assert.ok(fact?.content.includes('capability-reject: w-cap runner=opencode '), fact?.content);
  assert.equal(fx.store.linkedJobs(taskId).length, 0, '拒绝只拒不建 job');
});

test('T3 workspaceWritable=false 且需要写时拒绝', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  upsertWorker(fx, 'w-cap', workerCaps({ ...goodCard(), workspaceWritable: false }));
  const taskId = await createTask(fx, 'tasks/cap-t3.md');
  const text = await failAutoStart(fx, 'tasks/cap-t3.md', taskId);
  assert.match(text, /^capability-reject: w-cap workspaceWritable=false /);
  assert.ok(rejectEvent(fx, taskId), '记 capability-reject 事件');
  assert.ok(rejectFact(fx, taskId)?.content.includes('capability-reject: w-cap workspaceWritable=false '));
  assert.equal(fx.store.linkedJobs(taskId).length, 0, '拒绝只拒不建 job');
});

test('T4 卡缺失（旧 worker）视为通过', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  upsertWorker(fx, 'w-cap', workerCaps(undefined));
  const taskId = await createTask(fx, 'tasks/cap-t4.md');
  const passed = await autoStartExecute(fx, 'tasks/cap-t4.md', taskId);
  assert.ok(passed.job?.id, `旧 worker 无卡应放行，got ${JSON.stringify(passed)}`);
  assert.equal(rejectEvent(fx, taskId), null, '通过时不记 capability-reject');
});

test('T5 sequence 直启被拒回退唤醒 review（不建下一块 job）', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  upsertWorker(fx, 'w-cap', workerCaps(goodCard()));
  const created = await call(fx, 'tasks/cap-t5.md', 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'CAP5', requirements: 'req', workspace: fx.dir, anchor_message_id: fx.anchor,
  });
  const taskId: string = created.task.id;
  const passed = await call(fx, 'tasks/cap-t5.md', 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', {
    to_module: 'execute', note: '首块直启', auto_start: true,
    expected_revision: fx.store.getTask('r1', 'tasks/cap-t5.md')!.revision,
    sequence: SEQ2,
  });
  const jobId = passed.job.id as string;
  // 首块执行终态。
  fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
  const done = fx.jobs.complete(fx.jobs.get(jobId)!, 'done', 'simulated done', null, 'delivered', boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat/cap', head: A,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'cap' },
  }));
  assert.ok(!('error' in done), JSON.stringify(done));
  fx.store.handleJobFinished(fx.jobs.get(jobId)!, { finalAttempt: true, actor: 'muse' });
  // 评审 APPROVE → merge 直启。
  await call(fx, 'tasks/cap-t5.md', 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: jobId, candidate_sha: A, verdict: 'approve', findings: 'all green',
  });
  const mergeId = fx.store.linkedJobs(taskId).filter((job) => {
    try { return (JSON.parse(job.options) as { closureKind?: unknown }).closureKind === 'merge'; } catch { return false; }
  })[0].id;
  // 合入完成前能力卡变坏：下一块直启必须被拒。
  upsertWorker(fx, 'w-cap', workerCaps({
    ...goodCard(),
    runners: { opencode: { ok: false, checkedAt: new Date().toISOString(), error: 'gone' } },
  }));
  fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(mergeId);
  const report = { ok: true, lane: 'merge', branch: 'master', head: A, tests: MERGE_SUITES };
  const merged = fx.jobs.complete(fx.jobs.get(mergeId)!, 'done', `log\n${JSON.stringify(report)}\n`, null, 'delivered',
    boundedDeliveryMeta({
      state: 'delivered',
      receipt: {
        branch: 'feat/cap', head: A,
        diffstat: '1 file changed, 1 insertion(+)',
        changedFiles: { files: ['a.ts'], total: 1 }, tests: MERGE_SUITES,
        scriptReport: report, scriptExitCode: 0,
      },
      declared: { stage: 'delivered_waiting_deploy', committed: true, pushed: true },
    }));
  assert.ok(!('error' in merged), JSON.stringify(merged));
  const reviewWakesBefore = fx.wakes.filter((w) => w.module === 'review').length;
  fx.store.handleJobFinished(fx.jobs.get(mergeId)!, { finalAttempt: true, actor: 'codex' });
  const freshExecute = fx.store.linkedJobs(taskId).filter((job) => {
    if (job.id === jobId) return false;
    try { return !(JSON.parse(job.options) as { closureKind?: unknown }).closureKind; } catch { return false; }
  });
  assert.equal(freshExecute.length, 0, '被拒后不得直启下一块 execute job');
  const event = rejectEvent(fx, taskId);
  assert.ok(event, '记 capability-reject 事件');
  assert.match(String(event!['reasonLine']), /^capability-reject: w-cap runner=opencode /);
  const fallback = fx.db.prepare("SELECT payload FROM room_task_events WHERE task_id = ? AND kind = 'sequence-next-fallback' ORDER BY id DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  assert.ok(fallback, '走现有直启失败回退路径（sequence-next-fallback）');
  assert.ok(
    fx.wakes.filter((w) => w.module === 'review').length > reviewWakesBefore,
    '回退唤醒 review 席',
  );
});

test('configVisible=false 时受理拒绝（能力卡对照）', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  upsertWorker(fx, 'w-cap', workerCaps({ ...goodCard(), configVisible: false }));
  const taskId = await createTask(fx, 'tasks/cap-cfg.md');
  const text = await failAutoStart(fx, 'tasks/cap-cfg.md', taskId);
  assert.match(text, /^capability-reject: w-cap configVisible=false /);
  assert.ok(rejectEvent(fx, taskId), '记 capability-reject 事件');
});
