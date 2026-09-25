// Model-driven room workflow end-to-end (approved PLAN.md scope).
//
// Real gateway/native+MCP handler integration with the durable task ledger
// and a worker simulator (direct JobStore claim/complete + durable outbox
// drain). Covers: create/import with anchor+workspace binding, same-task
// read across owners vs cross-room denial, handoff -> real manager wake with
// the frozen captured turn -> accept -> execution_start (revision guard,
// single write lease, approved workspace) -> completion callback to the
// explicitly chosen owner -> review handoff -> independent review ->
// merge/deploy release -> evidence closes the task. Plus refusal paths:
// forged scope, self-review, changed candidate, unauthorized publish,
// plan-hat deploy, DM without authority, two-room same-contact isolation,
// rebound snapshots, cancel/unlock, idempotent retries, concurrent
// accept/write, stale revision, offline recipient, crash/restart replay, and
// zero automatic jobs/handoffs on completion alone.
//
// Real pieces only: JobStore, RoomTaskStore, AgentManager
// dispatchRoomMessageTracked (model backend stubbed like
// planDispatchHandoff), hub MCP router over HTTP, native GatewayTools.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb, type JobRow } from '../src/platform/db.js';
import { AgentManager } from '../src/runtime/manager.js';
import type { HubLogger } from '../src/platform/logger.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { createRoomTaskDispatcher } from '../src/runtime/roomTaskDispatch.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import type { RoomTaskToolContext } from '../src/roomTasks/roomTaskStore.js';
import { hubMcpBearerToken } from '../src/platform/middleware/hubMcpAuth.js';
import { hubMcpRouter } from '../src/tools/hubMcpRoutes.js';
import { attachWorkerCompletion } from '../src/server.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { boundedDeliveryMeta } from '../src/jobs/receiptFields.js';
import type { SseHub } from '../src/platform/sse.js';

const HUB_TOKEN = 'room-task-e2e-token';
const SHA = (ch: string) => ch.repeat(40);
const H1 = SHA('a');
const H2 = SHA('b');
const BASE = SHA('c');

const RECEIPT = (o: {
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
  before: { head: o.beforeHead ?? BASE },
  declared: {
    stage: o.stage ?? 'delivered',
    committed: o.committed ?? false,
    pushed: o.pushed ?? false,
    summary: 'simulated worker receipt',
  },
});

const MERGE_SUITES = [
  'server npm run pretest', 'server npm test', 'web npm test',
  'smoke:deploy-drain', 'smoke:turn-timeouts', 'smoke:deploy-resume',
].map((suite) => ({ suite, status: 'pass' as const }));

test('model-driven room workflow end to end', { timeout: 300_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-room-task-e2e-'));
  const resources: { httpServer?: import('node:http').Server; manager?: AgentManager; db?: ReturnType<typeof openDb> } = {};
  t.after(async () => {
    if (resources.httpServer) {
      await new Promise<void>((resolve) => resources.httpServer!.close(() => resolve()));
    }
    if (resources.manager) await resources.manager.stopAll().catch(() => {});
    try { resources.db?.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const tasksDir = path.join(dir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const uploadsDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const db = openDb(path.join(dir, 'hub.db'));
  resources.db = db;
  const broadcasts: unknown[] = [];
  const sse = { broadcast: (_e: string, v: unknown) => broadcasts.push(v) } as unknown as SseHub;
  const jobs = new JobStore(db, sse);
  const audits: Array<Record<string, unknown>> = [];
  const logger = {
    warn(f: Record<string, unknown>) { audits.push(f); },
    info() {}, error() {},
  } as unknown as HubLogger;

  for (const [id, name, backend] of [
    ['codex', 'Codex', 'codex'],
    ['cove2', 'Cove2', 'codex'],
    ['muse', 'Muse', 'opencode-cli'],
    ['muse2', 'Muse2', 'opencode-cli'],
    ['aye', '阿野', 'grok-cli'],
    ['claude', 'Claude', 'claude-cli'],
  ] as const) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')")
      .run(id, name, backend);
  }
  db.prepare("UPDATE contacts SET config = ? WHERE id = 'codex'").run(JSON.stringify({
    delegation: { enabled: true, workspaces: [dir], runners: ['codex'], allowShell: true },
  }));
  const roomConfig = JSON.stringify({ workflowEnabled: true, members: ['codex', 'cove2', 'muse', 'muse2', 'aye'] });
  for (const roomId of ['room-a', 'room-b']) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, 'room', 'room', ?)")
      .run(roomId, roomId, roomConfig);
  }
  const anchor = (roomId: string, content: string): number => Number((db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES (?, 'user', 'user', 'text', ?, 'done', '{}', 'main')`
  ).run(roomId, content)).lastInsertRowid);

  // REAL manager: routing, handoff verification and wake filtering are
  // production code. Only the model backend is stubbed (no CLI spawns); the
  // captured turn context is recorded for assertions.
  const managerDeps: any = {
    db, sse,
    config: { memory: { capture: false, repoPath: dir }, agentsDir: dir },
    jobStore: jobs, vault: null,
  };
  const manager = new AgentManager(managerDeps);
  resources.manager = manager;
  const wakeCalls: Array<{ member: string; context: any }> = [];
  let failTurns = false;
  // hold.active 时轮次唤醒后挂起，模拟部署重启时仍在途的模块轮次。
  const hold: { active: boolean; release: ((outcome: string) => void) | null } = { active: false, release: null };
  (manager as any).getRoomMember = (_room: any, member: any, context: any) => ({
    async runRoomTurn(_mode: string) {
      if (failTurns) throw new Error('simulated provider failure');
      wakeCalls.push({ member: member.id, context });
      if (hold.active) return new Promise<string>((release) => { hold.release = release; });
      return 'spoke';
    },
  });
  const origImage = manager.imageRoomMembers.bind(manager);
  let membersOverride: Array<{ id: string }> | null = null;
  (manager as any).imageRoomMembers = (room: any) =>
    membersOverride ?? origImage(room);

  const dispatcher = createRoomTaskDispatcher({ db, sse, manager });
  const store = new RoomTaskStore(db, jobs, dispatcher);
  const readVaultTask = (taskPath: string): string | null => {
    try {
      return fs.readFileSync(path.join(tasksDir, taskPath.slice('tasks/'.length)), 'utf8');
    } catch { return null; }
  };
  attachWorkerCompletion({
    db, jobStore: jobs, manager, logger, sse, vault: null,
    config: { memory: { repoPath: dir } },
  } as any);

  const toolsFor = (contactId: string, ctx: RoomTaskToolContext | null) =>
    buildRoomTaskTools(db, jobs, contactId, dispatcher, { readVaultTask }, ctx);
  // Origin-turn fixture: every direct tool call runs inside its own
  // server-created turn (begin/end around the call) so the store's
  // origin-turn gate validates a live exact nonce, exactly like production
  // turns. Calls with ctx null keep no authority (DM refusal paths).
  const call = async (
    contactId: string, ctx: RoomTaskToolContext | null, name: string, args: Record<string, unknown>,
  ) => {
    if (!ctx) {
      const tool = toolsFor(contactId, ctx).find((t) => t.name === name)!;
      assert.ok(tool, `${name} is exposed to models`);
      return tool.exec(args);
    }
    const turn = beginRoomTurn(db, {
      roomId: ctx.roomId,
      contactId,
      moduleId: ctx.moduleId,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      ...(ctx.handoffId ? { handoffId: ctx.handoffId } : {}),
      ...((ctx as { callbackJobId?: string }).callbackJobId
        ? { callbackJobId: (ctx as { callbackJobId: string }).callbackJobId }
        : {}),
    });
    try {
      const bound: RoomTaskToolContext = { ...ctx, turnId: turn.turnId };
      const tool = toolsFor(contactId, bound).find((t) => t.name === name)!;
      assert.ok(tool, `${name} is exposed to models`);
      return await tool.exec(args);
    } finally {
      endRoomTurn(db, turn.turnId, 'test');
    }
  };
  const okJson = async (
    contactId: string, ctx: RoomTaskToolContext | null, name: string, args: Record<string, unknown>,
  ): Promise<any> => {
    const out = await call(contactId, ctx, name, args);
    assert.equal(out.ok, true, `${name} should succeed: ${out.text.slice(0, 400)}`);
    return JSON.parse(out.text);
  };
  const failCall = async (
    contactId: string, ctx: RoomTaskToolContext | null, name: string, args: Record<string, unknown>,
  ): Promise<string> => {
    const out = await call(contactId, ctx, name, args);
    assert.equal(out.ok, false, `${name} should refuse`);
    return out.text;
  };

  const planA: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'plan' };
  const execA: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'execute' };
  const reviewA: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'review' };
  const mergeA: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'merge' };
  const deployA: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'deploy' };
  const jobCount = () => (db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c;
  const roomHostCount = () => (db.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE sender = 'room-host'").get() as { c: number }).c;
  const drainAll = async (jobId: string): Promise<void> => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const outbox = db.prepare(
        "SELECT status, next_attempt_at FROM job_outbox WHERE job_id = ? AND kind = 'finished'"
      ).get(jobId) as { status: string; next_attempt_at: number } | undefined;
      if (!outbox || outbox.status !== 'pending') break;
      await jobs.drainOutboxOnce(Math.max(Date.now(), outbox.next_attempt_at + 1));
    }
  };
  const finishJob = async (job: JobRow, status: 'done' | 'blocked' | 'failed', meta: string): Promise<JobRow> => {
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(job.id);
    const outcome = jobs.complete(jobs.get(job.id)!, status, `simulated ${status}`, status === 'failed' ? 'boom' : null,
      status === 'done' ? 'delivered' : status === 'blocked' ? 'blocked_unpushed' : 'failed', meta);
    assert.ok(!('error' in outcome), `complete failed: ${JSON.stringify(outcome)}`);
    await drainAll(job.id);
    return jobs.get(job.id)!;
  };
  const taskOf = (roomId: string, taskPath: string) =>
    new RoomTaskStore(db, jobs, null).getTask(roomId, taskPath)!;

  // ── 1. import: legacy blocked job attaches under the same room only ──
  fs.writeFileSync(path.join(tasksDir, 'model-demo.md'), '# Demo\n\n批准的需求正文（Vault 可信源）。\n');
  const anchorImport = anchor('room-a', 'User：把 model-demo 接管进任务账本，继续做。');
  const legacy = jobs.create({
    requestedBy: 'muse', runner: 'opencode', workspace: dir, prompt: '旧自动链路留下的执行',
    permissions: { write: true, shell: true, ssh: false },
    options: { routeClass: 'implement', taskPath: 'tasks/model-demo.md' },
    originContactId: 'room-a', originAnchorId: anchorImport,
  });
  assert.ok(!('error' in legacy));
  const legacyDm = jobs.create({
    requestedBy: 'muse', runner: 'opencode', workspace: dir, prompt: '私聊旧任务，同 taskPath 也不许混入',
    permissions: { write: true, shell: true, ssh: false },
    options: { routeClass: 'implement', taskPath: 'tasks/model-demo.md' },
    originContactId: 'muse', originAnchorId: null,
  });
  assert.ok(!('error' in legacyDm));
  // Same taskPath job from ANOTHER room must never attach.
  const legacyOtherRoom = jobs.create({
    requestedBy: 'muse', runner: 'opencode', workspace: dir, prompt: '隔壁房旧任务',
    permissions: { write: true, shell: true, ssh: false },
    options: { routeClass: 'implement', taskPath: 'tasks/model-demo.md' },
    originContactId: 'room-b', originAnchorId: null,
  });
  assert.ok(!('error' in legacyOtherRoom));
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(legacy.job.id);
  jobs.complete(jobs.get(legacy.job.id)!, 'blocked', 'wall blocked', null, 'blocked_unpushed', RECEIPT({
    branch: 'legacy-wip', head: SHA('d'),
  }));

  const imported = await okJson('codex', planA, 'task_import', {
    room_id: 'room-a', task_path: 'tasks/model-demo.md',
    requirements: '模型编造的需求（必须被 Vault 原文覆盖）',
    anchor_message_id: anchorImport,
  });
  assert.equal(imported.created, true);
  assert.deepEqual(imported.attached, [legacy.job.id], 'only the server-verified same-room job attaches');
  assert.match(imported.task.requirements, /批准的需求正文/, 'Vault trusted source wins over model text');

  // Same-task participant read: execute owner reads the plan-side legacy job.
  const legacyRead = await okJson('muse', execA, 'task_get', {
    room_id: 'room-a', task_path: 'tasks/model-demo.md',
    receipt_job_id: legacy.job.id, receipt_limit: 100,
  });
  assert.ok(legacyRead.view.attempts.some((a: any) => a.id === legacy.job.id));
  assert.equal(legacyRead.view.receiptPage.jobId, legacy.job.id);
  // Cross-room denial for the same contact in both rooms.
  const anchorB = anchor('room-b', 'User：room-b 无关批准。');
  const crossDenied = await failCall('codex', { roomId: 'room-b', moduleId: 'plan' }, 'task_get', {
    room_id: 'room-a', task_path: 'tasks/model-demo.md',
  });
  assert.match(crossDenied, /只授权房间 room-b/);
  const importB = await okJson('codex', { roomId: 'room-b', moduleId: 'plan' }, 'task_import', {
    room_id: 'room-b', task_path: 'tasks/model-demo.md', workspace: dir, anchor_message_id: anchorB,
  });
  // Only room-b's own verified job attaches here; room-a's and DM jobs with
  // the same taskPath stay out despite the identical path string.
  assert.deepEqual(importB.attached, [legacyOtherRoom.job.id]);

  // ── 2. create -> handoff -> real scoped wake (frozen snapshot) ──
  const anchorLive = anchor('room-a', 'User：批准做 model-live，按任务账本走。');
  const roomHostBefore = roomHostCount();
  const jobsBefore = jobCount();
  const created = await okJson('codex', planA, 'task_create', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', title: 'live 登记',
    requirements: '原始需求全文：修好 Grok 解析并补测试。',
    workspace: dir, anchor_message_id: anchorLive,
  });
  assert.equal(created.task.owner_module, 'plan');
  assert.equal(created.task.owner_contact, 'codex');
  assert.equal(created.task.approved_workspace, dir);
  const rev0 = created.task.revision;

  // No-anchor creation is refused: model text alone grants nothing.
  const noAnchor = await failCall('codex', planA, 'task_create', {
    room_id: 'room-a', task_path: 'tasks/model-nope.md', title: 'x',
    requirements: 'y', workspace: dir, anchor_message_id: 999999,
  });
  assert.match(noAnchor, /anchor/);
  // DM turns carry no room authority even for member contacts.
  const dmDenied = await failCall('codex', null, 'task_get', {
    room_id: 'room-a', task_path: 'tasks/model-live.md',
  });
  assert.match(dmDenied, /模块轮次授权/);

  const handoff = await okJson('codex', planA, 'task_handoff', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', actor_module: 'plan',
    to_module: 'execute', request: '实现需求并跑测试', evidence_refs: [],
  });
  assert.equal(handoff.delivery.status, 'posted');
  assert.equal(handoff.handoff.to_contact, 'muse');
  assert.ok(handoff.handoff.to_binding, 'frozen binding snapshot is stored');
  // Real manager wake, correctly scoped to the captured recipient/turn.
  assert.equal(wakeCalls.length, 1);
  assert.equal(wakeCalls[0].member, 'muse');
  assert.equal(wakeCalls[0].context.moduleId, 'execute');
  assert.equal(wakeCalls[0].context.taskId, handoff.task.id);
  assert.equal(wakeCalls[0].context.handoffId, handoff.handoff.id);
  assert.equal(roomHostCount(), roomHostBefore, 'no fake room-host bubbles');
  assert.equal(jobCount(), jobsBefore, 'handoff creates no model job');
  const handoffTaskId: string = handoff.task.id;
  const handoffId: string = handoff.handoff.id;

  // Idempotent retry: duplicate, no second wake, no second job.
  const retryDup = await okJson('codex', planA, 'task_retry', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', mode: 'handoff',
  });
  assert.equal(retryDup.delivery.status, 'duplicate');
  assert.equal(wakeCalls.length, 1, 'posted keys never wake twice');

  // Wrong recipient cannot accept; owner-only handoff enforced.
  const wrongAccept = await failCall('aye', { roomId: 'room-a', moduleId: 'execute' }, 'task_accept', {
    room_id: 'room-a', task_path: 'tasks/model-live.md',
  });
  assert.match(wrongAccept, /点名/);
  const execCtxPinned: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'execute', taskId: handoffTaskId, handoffId };
  const accepted = await okJson('muse', execCtxPinned, 'task_accept', {
    room_id: 'room-a', task_path: 'tasks/model-live.md',
  });
  assert.equal(accepted.task.owner_module, 'execute');
  const doubleAccept = await failCall('muse', execCtxPinned, 'task_accept', {
    room_id: 'room-a', task_path: 'tasks/model-live.md',
  });
  assert.match(doubleAccept, /没有待处理|已被并发|已 accepted/);

  // ── 3. execution_start: guards + lease + callback registration ──
  const staleRev = await failCall('muse', execCtxPinned, 'execution_start', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'execute',
    expected_revision: rev0, workspace: dir, objective: 'stale',
    return_mode: 'notify', return_to_module: 'plan',
  });
  assert.match(staleRev, /revision/);
  const badWs = await failCall('muse', execCtxPinned, 'execution_start', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'execute',
    expected_revision: accepted.task.revision, workspace: '/elsewhere',
    objective: 'drift', return_mode: 'notify', return_to_module: 'plan',
  });
  assert.match(badWs, /批准工作区/);
  const planHat = await failCall('codex', planA, 'execution_start', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'execute',
    expected_revision: accepted.task.revision, workspace: dir,
    objective: 'plan hat overreach', return_mode: 'notify', return_to_module: 'plan',
  });
  assert.match(planHat, /负责人|本轮次/);

  const started = await okJson('muse', execCtxPinned, 'execution_start', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'execute',
    expected_revision: accepted.task.revision, workspace: dir,
    objective: '实现需求并跑测试', return_mode: 'notify', return_to_module: 'plan',
  });
  const execJobId: string = started.job.id;
  assert.equal(started.job.runner, 'opencode', 'runner follows the captured execute binding');
  // Single active write lease.
  const secondWrite = await failCall('muse', execCtxPinned, 'execution_start', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'execute',
    expected_revision: started.task.revision, workspace: dir,
    objective: 'second writer', return_mode: 'notify', return_to_module: 'plan',
  });
  assert.match(secondWrite, /在途写操作/);
  // Explicit read-only request may run alongside.
  const readOnly = await okJson('muse', execCtxPinned, 'execution_start', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'execute',
    expected_revision: started.task.revision, workspace: dir,
    objective: '只读巡检', return_mode: 'notify', return_to_module: 'plan', write: false,
  });
  const readOnlyJobId: string = readOnly.job.id;

  // ── 4. completion: fold once, callback only, zero new jobs ──
  // Completion alone never selects a candidate: the owner pins repairs
  // explicitly (M5). The ledger folds evidence + status and notifies only
  // the registered return callback.
  const jobsAtFinish = jobCount();
  await finishJob(jobs.get(execJobId)!, 'done', RECEIPT({ branch: 'feat-x', head: H1 }));
  assert.equal(jobCount(), jobsAtFinish, 'completion alone creates zero jobs/handoffs');
  const afterFinish = taskOf('room-a', 'tasks/model-live.md');
  assert.equal(afterFinish.candidate_sha, null, 'completion must not auto-select a candidate');
  assert.equal(afterFinish.status, 'in_progress');
  const callbackWake = wakeCalls[wakeCalls.length - 1];
  assert.equal(callbackWake.member, 'codex', 'callback goes to the explicitly chosen return owner');
  assert.match(JSON.stringify(callbackWake), /plan/);
  // Crash/restart replay: fold is idempotent before any mutation.
  const evidenceBefore = (db.prepare(
    "SELECT COUNT(*) AS c FROM room_task_evidence WHERE task_id = ?").get(handoffTaskId) as { c: number }).c;
  new RoomTaskStore(db, jobs, dispatcher).handleJobFinished(jobs.get(execJobId)!, { finalAttempt: true });
  const evidenceAfter = (db.prepare(
    "SELECT COUNT(*) AS c FROM room_task_evidence WHERE task_id = ?").get(handoffTaskId) as { c: number }).c;
  assert.equal(evidenceAfter, evidenceBefore, 'replay must not duplicate evidence');
  const deliveredCount = (db.prepare(
    "SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ? AND kind = 'callback-delivered' AND json_extract(payload, '$.jobId') = ?"
  ).get(handoffTaskId, execJobId) as { c: number }).c;
  assert.equal(deliveredCount, 1);

  // Offline recipient: failed delivery stays pending and retryable.
  membersOverride = [];
  await finishJob(jobs.get(readOnlyJobId)!, 'done', RECEIPT({ branch: 'feat-ro', head: SHA('e') }));
  const offlineEvents = db.prepare(
    "SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ? AND kind = 'callback-failed'"
  ).get(handoffTaskId) as { c: number };
  assert.ok(offlineEvents.c >= 1, 'outage surfaces pending/failed blocker');
  membersOverride = null;
  const redelivered = await okJson('muse', execCtxPinned, 'task_retry', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', job_id: readOnlyJobId, mode: 'callback',
  });
  assert.ok(['posted', 'duplicate'].includes(redelivered.delivery.status));
  const redeliveredAgain = await okJson('muse', execCtxPinned, 'task_retry', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', job_id: readOnlyJobId, mode: 'callback',
  });
  assert.equal(redeliveredAgain.delivery.status, 'duplicate', 'delivered callbacks never re-wake');

  // ── 5. review handoff -> REQUEST_CHANGES on A (M5: A rejected) ──
  const toReview = await okJson('muse', execCtxPinned, 'task_handoff', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', actor_module: 'execute',
    to_module: 'review', request: '独立评审候选 H1', evidence_refs: [execJobId],
  });
  const reviewHandoffId: string = toReview.handoff.id;
  const reviewCtxPinned: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'review', taskId: handoffTaskId, handoffId: reviewHandoffId };
  await okJson('aye', reviewCtxPinned, 'task_accept', {
    room_id: 'room-a', task_path: 'tasks/model-live.md',
  });

  // Self-review negative: implementer (aye, DM-created but server-verified
  // same-room job) cannot review their own attempt.
  const selfImpl = jobs.create({
    requestedBy: 'aye', runner: 'grok', workspace: dir, prompt: 'aye 自己做的实现',
    permissions: { write: true, shell: true, ssh: false },
    options: { routeClass: 'implement', taskPath: 'tasks/model-live.md' },
    originContactId: 'room-a', originAnchorId: anchorLive,
  });
  assert.ok(!('error' in selfImpl));
  await finishJob(selfImpl.job, 'done', RECEIPT({ branch: 'self-wip', head: SHA('f') }));
  store.attachVerifiedJobs(taskOf('room-a', 'tasks/model-live.md'), 'aye');
  const selfReview = await failCall('aye', reviewCtxPinned, 'review_submit', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'review',
    candidate_job_id: selfImpl.job.id, candidate_sha: SHA('f'),
    verdict: 'approve', findings: 'self approve',
  });
  assert.match(selfReview, /自己执行/);

  // Empty-tests approve negative + dangling ref negative.
  const noTestsImpl = jobs.create({
    requestedBy: 'muse', runner: 'opencode', workspace: dir, prompt: '无测试证据的实现',
    permissions: { write: true, shell: true, ssh: false },
    options: { routeClass: 'implement', taskPath: 'tasks/model-live.md' },
    originContactId: 'room-a', originAnchorId: anchorLive,
  });
  assert.ok(!('error' in noTestsImpl));
  const NO_TESTS_HEAD = SHA('9');
  await finishJob(noTestsImpl.job, 'done', JSON.stringify({
    receipt: { branch: 'notests', head: NO_TESTS_HEAD, diffstat: 'x', changedFiles: { files: ['a.ts'], total: 1 } },
    before: { head: BASE }, declared: { stage: 'delivered', summary: 'no tests' },
  }));
  store.attachVerifiedJobs(taskOf('room-a', 'tasks/model-live.md'), 'muse');
  const emptyTests = await failCall('aye', reviewCtxPinned, 'review_submit', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'review',
    candidate_job_id: noTestsImpl.job.id, candidate_sha: NO_TESTS_HEAD,
    verdict: 'approve', evidence_refs: [noTestsImpl.job.id],
  });
  assert.match(emptyTests, /测试/);
  const dangling = await failCall('aye', reviewCtxPinned, 'review_submit', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'review',
    candidate_job_id: execJobId, candidate_sha: H1,
    verdict: 'approve', evidence_refs: ['no-such-job'],
  });
  assert.match(dangling, /不存在于本任务/);

  const rejected = await okJson('aye', reviewCtxPinned, 'review_submit', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'review',
    candidate_job_id: execJobId, candidate_sha: H1,
    verdict: 'request_changes', findings: 'M1: 边界条件未处理，通过条件：补越界单测并全绿。',
    evidence_refs: [execJobId],
  });
  assert.equal(rejected.task.review_status, 'changes_requested');
  assert.equal(rejected.task.candidate_sha, H1, 'review verdict pins the reviewed candidate');
  assert.ok(rejected.evidenceId > 0, 'review evidence has its own id, never the candidate job');

  // ── 6. explicit fix B -> explicit candidate submission (M5) ──
  // Completion of the repair does NOT auto-pin: the owner submits B
  // explicitly (revision-guarded), which invalidates the old verdict.
  const backToExec = await okJson('aye', reviewCtxPinned, 'task_handoff', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', actor_module: 'review',
    to_module: 'execute', request: '返工：补边界条件', evidence_refs: [],
  });
  const execCtx2: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'execute', taskId: handoffTaskId, handoffId: backToExec.handoff.id };
  const execAccepted2 = await okJson('muse', execCtx2, 'task_accept', {
    room_id: 'room-a', task_path: 'tasks/model-live.md',
  });
  const exec2 = await okJson('muse', execCtx2, 'execution_start', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'execute',
    expected_revision: execAccepted2.task.revision, workspace: dir,
    objective: '返工实现', return_mode: 'notify', return_to_module: 'review',
  });
  await finishJob(jobs.get(exec2.job.id)!, 'done', RECEIPT({ branch: 'feat-x2', head: H2 }));
  const afterB = taskOf('room-a', 'tasks/model-live.md');
  assert.equal(afterB.candidate_sha, H1, 'repair completion must not replace the pinned candidate');
  assert.equal(afterB.review_status, 'changes_requested', 'old verdict stands until B is submitted');

  const noRevSubmit = await failCall('muse', execCtx2, 'task_submit_evidence', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', kind: 'candidate',
    ref: exec2.job.id, body: H2,
  });
  assert.match(noRevSubmit, /expected_revision/);
  const staleSubmit = await failCall('muse', execCtx2, 'task_submit_evidence', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', kind: 'candidate',
    ref: exec2.job.id, body: H2, expected_revision: afterB.revision - 1,
  });
  assert.match(staleSubmit, /revision/);
  const submitB = await okJson('muse', execCtx2, 'task_submit_evidence', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', kind: 'candidate',
    ref: exec2.job.id, body: H2, expected_revision: afterB.revision,
  });
  assert.ok(submitB.evidenceId > 0);
  const afterSubmit = taskOf('room-a', 'tasks/model-live.md');
  assert.equal(afterSubmit.candidate_sha, H2, 'explicit submission promotes B');
  assert.equal(afterSubmit.review_status, null, 'pinning B invalidates the old verdict');
  // Without approval, release is refused.
  const noApprovalMerge = await failCall('codex', mergeA, 'release_execute', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', kind: 'merge',
    return_mode: 'notify', return_to_module: 'deploy', expected_revision: afterSubmit.revision,
  });
  assert.match(noApprovalMerge, /负责人|批准/);

  const toReview2 = await okJson('muse', execCtx2, 'task_handoff', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', actor_module: 'execute',
    to_module: 'review', request: '复审 H2', evidence_refs: [exec2.job.id],
  });
  const reviewCtx2: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'review', taskId: handoffTaskId, handoffId: toReview2.handoff.id };
  await okJson('aye', reviewCtx2, 'task_accept', {
    room_id: 'room-a', task_path: 'tasks/model-live.md',
  });
  const approvedB = await okJson('aye', reviewCtx2, 'review_submit', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'review',
    candidate_job_id: exec2.job.id, candidate_sha: H2,
    verdict: 'approve', findings: 'H2 已核对，通过。', evidence_refs: [exec2.job.id],
  });
  assert.equal(approvedB.task.review_status, 'approved');

  // Unauthorized publish + plan-hat deploy negatives (owner is review/aye).
  const unpub = await failCall('aye', reviewCtx2, 'release_execute', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', kind: 'merge',
    return_mode: 'notify', return_to_module: 'deploy', expected_revision: approvedB.task.revision,
  });
  assert.match(unpub, /本轮次|负责人|绑定者/);
  const planHatDeploy = await failCall('codex', planA, 'release_execute', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', kind: 'deploy',
    return_mode: 'notify', return_to_module: 'plan', expected_revision: approvedB.task.revision,
  });
  assert.match(planHatDeploy, /本轮次|负责人/);

  // ── 7. competing writer blocks release; idempotent repeat; close ──
  // Start a competing writer while the task is approved, then prove the
  // release lease refuses the overlap (M7).
  const toExecW = await okJson('aye', reviewCtx2, 'task_handoff', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', actor_module: 'review',
    to_module: 'execute', request: '并行打磨', evidence_refs: [],
  });
  const execCtxW: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'execute', taskId: handoffTaskId, handoffId: toExecW.handoff.id };
  const execWAccepted = await okJson('muse', execCtxW, 'task_accept', {
    room_id: 'room-a', task_path: 'tasks/model-live.md',
  });
  const execW = await okJson('muse', execCtxW, 'execution_start', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'execute',
    expected_revision: execWAccepted.task.revision, workspace: dir,
    objective: '并行打磨（保持在途）', return_mode: 'notify', return_to_module: 'review',
  });
  const toReviewW = await okJson('muse', execCtxW, 'task_handoff', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', actor_module: 'execute',
    to_module: 'review', request: 'W 在途也要能走评审', evidence_refs: [exec2.job.id],
  });
  const reviewCtxW: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'review', taskId: handoffTaskId, handoffId: toReviewW.handoff.id };
  await okJson('aye', reviewCtxW, 'task_accept', {
    room_id: 'room-a', task_path: 'tasks/model-live.md',
  });
  const approvedW = await okJson('aye', reviewCtxW, 'review_submit', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', module: 'review',
    candidate_job_id: exec2.job.id, candidate_sha: H2,
    verdict: 'approve', findings: 'H2 复核通过。', evidence_refs: [exec2.job.id],
  });
  const toMerge = await okJson('aye', reviewCtxW, 'task_handoff', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', actor_module: 'review',
    to_module: 'merge', request: '合并冻结版本', evidence_refs: [],
  });
  const mergeCtxPinned: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'merge', taskId: handoffTaskId, handoffId: toMerge.handoff.id };
  const mergeAccepted = await okJson('codex', mergeCtxPinned, 'task_accept', {
    room_id: 'room-a', task_path: 'tasks/model-live.md',
  });
  const leaseBlocked = await failCall('codex', mergeCtxPinned, 'release_execute', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', kind: 'merge',
    return_mode: 'notify', return_to_module: 'deploy', expected_revision: mergeAccepted.task.revision,
  });
  assert.match(leaseBlocked, /在途写操作/);
  // Free the lease, then release idempotently.
  await finishJob(jobs.get(execW.job.id)!, 'failed', RECEIPT({ branch: 'wip-w', head: SHA('d') }));
  const releaseRev = taskOf('room-a', 'tasks/model-live.md').revision;
  const merged = await okJson('codex', mergeCtxPinned, 'release_execute', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', kind: 'merge',
    return_mode: 'notify', return_to_module: 'deploy', expected_revision: releaseRev,
    idempotency_key: 'release-e2e-merge-1',
  });
  const mergeJobId: string = merged.job.id;
  const mergeJob = jobs.get(mergeJobId)!;
  assert.match(mergeJob.prompt, /merge-close-job\.ps1/, 'release starts real authorized execution');
  assert.match(mergeJob.prompt, /explicit release merge/);
  // Baseline fix MUST 2: the merge command carries its own complete
  // -ReleaseEvidence (Worker runs it verbatim, never rebuilds it).
  assert.match(mergeJob.prompt, /-ReleaseEvidence '/, 'merge command carries its own release evidence');
  for (const fragment of [
    `"roomId":"room-a"`,
    `"taskPath":"tasks/model-live.md"`,
    `"candidateSha":"${H2.toLowerCase()}"`,
    `"reviewStatus":"approved"`,
    `"reviewEvidenceId":`,
  ]) {
    assert.ok(mergeJob.prompt.includes(fragment), `merge command evidence includes ${fragment}`);
  }
  const mergedAgain = await okJson('codex', mergeCtxPinned, 'release_execute', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', kind: 'merge',
    return_mode: 'notify', return_to_module: 'deploy', expected_revision: releaseRev,
    idempotency_key: 'release-e2e-merge-1',
  });
  assert.equal(mergedAgain.job.id, mergeJobId, 'repeated release returns the same job');
  assert.equal(mergedAgain.existing, true);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE idempotency_key = ?").get('release-e2e-merge-1') as { c: number }).c,
    1, 'no duplicate release job',
  );
  await finishJob(mergeJob, 'done', RECEIPT({
    branch: 'master', head: H2, stage: 'delivered_waiting_deploy', committed: true, pushed: true,
    tests: MERGE_SUITES,
  }));
  assert.equal(taskOf('room-a', 'tasks/model-live.md').status, 'in_review');
  // Late non-candidate done while in_review holds state (no revert).
  const lateInReview = jobs.create({
    requestedBy: 'muse', runner: 'opencode', workspace: dir, prompt: '评审期间迟到的实现',
    permissions: { write: true, shell: true, ssh: false },
    options: { routeClass: 'implement', taskPath: 'tasks/model-live.md' },
    originContactId: 'room-a', originAnchorId: anchorLive,
  });
  assert.ok(!('error' in lateInReview));
  store.attachVerifiedJobs(taskOf('room-a', 'tasks/model-live.md'), 'muse');
  await finishJob(lateInReview.job, 'done', RECEIPT({ branch: 'late-ir', head: SHA('8') }));
  assert.equal(taskOf('room-a', 'tasks/model-live.md').candidate_sha, H2);
  assert.equal(taskOf('room-a', 'tasks/model-live.md').status, 'in_review');
  assert.equal(taskOf('room-a', 'tasks/model-live.md').review_status, 'approved');

  const toDeploy = await okJson('codex', mergeCtxPinned, 'task_handoff', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', actor_module: 'merge',
    to_module: 'deploy', request: '上线冻结版本', evidence_refs: [mergeJobId],
  });
  const deployCtxPinned: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'deploy', taskId: handoffTaskId, handoffId: toDeploy.handoff.id };
  const deployAccepted = await okJson('codex', deployCtxPinned, 'task_accept', {
    room_id: 'room-a', task_path: 'tasks/model-live.md',
  });
  // M6: plan-hat takeover is refused even though codex owns the deploy role.
  const hatTakeover = await failCall('codex', planA, 'task_retry', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', job_id: mergeJobId, mode: 'takeover',
  });
  assert.match(hatTakeover, /本轮次|模块身份/);
  const deployed = await okJson('codex', deployCtxPinned, 'release_execute', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', kind: 'deploy',
    return_mode: 'notify', return_to_module: 'plan', expected_revision: deployAccepted.task.revision,
  });
  const deployJobId: string = deployed.job.id;
  assert.match(jobs.get(deployJobId)!.prompt, /room-deploy-job\.ps1/);
  await finishJob(jobs.get(deployJobId)!, 'done', RECEIPT({ branch: 'master', head: H2 }));
  const closed = taskOf('room-a', 'tasks/model-live.md');
  assert.equal(closed.status, 'closed', 'evidence closes the task');
  assert.equal(roomHostCount(), roomHostBefore, 'still zero host bubbles end to end');

  // Old A finishes late (first record now): it must not revert B's approval.
  // After merge the task is in_review: a late non-candidate done holds state.
  const lateImpl = jobs.create({
    requestedBy: 'muse', runner: 'opencode', workspace: dir, prompt: '迟到的旧实现',
    permissions: { write: true, shell: true, ssh: false },
    options: { routeClass: 'implement', taskPath: 'tasks/model-live.md' },
    originContactId: 'room-a', originAnchorId: anchorLive,
  });
  assert.ok(!('error' in lateImpl));
  store.attachVerifiedJobs(taskOf('room-a', 'tasks/model-live.md'), 'muse');
  await finishJob(lateImpl.job, 'done', RECEIPT({ branch: 'late', head: SHA('8') }));
  assert.equal(taskOf('room-a', 'tasks/model-live.md').candidate_sha, H2);
  assert.equal(taskOf('room-a', 'tasks/model-live.md').status, 'closed');
  new RoomTaskStore(db, jobs, dispatcher).handleJobFinished(jobs.get(execJobId)!, { finalAttempt: true });
  assert.equal(taskOf('room-a', 'tasks/model-live.md').candidate_sha, H2, 'old A callback cannot revert');
  assert.equal(taskOf('room-a', 'tasks/model-live.md').status, 'closed');

  // Forged cross-task job reference is rejected.
  const forged = await failCall('muse', execA, 'execution_get', {
    room_id: 'room-a', task_path: 'tasks/model-live.md', job_id: legacyDm.job.id,
  });
  assert.match(forged, /不属于本任务/);

  // ── M4. callback pinned to the frozen registration across rebind ──
  const anchorCb = anchor('room-a', 'User：批准 model-callback。');
  const cbCreated = await okJson('codex', planA, 'task_create', {
    room_id: 'room-a', task_path: 'tasks/model-callback.md', title: 'callback pin',
    requirements: '回调 pin 需求', workspace: dir, anchor_message_id: anchorCb,
  });
  const cbTaskId: string = cbCreated.task.id;
  const cbHandoff = await okJson('codex', planA, 'task_handoff', {
    room_id: 'room-a', task_path: 'tasks/model-callback.md', actor_module: 'plan',
    to_module: 'execute', request: '做', evidence_refs: [],
  });
  const cbExecCtx: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'execute', taskId: cbTaskId, handoffId: cbHandoff.handoff.id };
  const cbAccepted = await okJson('muse', cbExecCtx, 'task_accept', {
    room_id: 'room-a', task_path: 'tasks/model-callback.md',
  });
  const cbExec = await okJson('muse', cbExecCtx, 'execution_start', {
    room_id: 'room-a', task_path: 'tasks/model-callback.md', module: 'execute',
    expected_revision: cbAccepted.task.revision, workspace: dir,
    objective: '做', return_mode: 'notify', return_to_module: 'plan',
  });
  // Rebind plan BEFORE completion: the callback must still reach the
  // registered snapshot (codex), never the live reroute (cove2).
  const planModel = jobs.workflowModules.bindings().plan.model;
  const planRebind = jobs.workflowModules.setBinding('plan', {
    contactId: 'cove2', runner: 'codex', model: planModel, reasoning: 'high',
  }, jobs.workflowModules.revision(), 'User');
  assert.equal(planRebind.ok, true);
  const wakesBeforeCb = wakeCalls.length;
  await finishJob(jobs.get(cbExec.job.id)!, 'done', RECEIPT({ branch: 'cb', head: SHA('7') }));
  const cbWake = wakeCalls[wakeCalls.length - 1];
  assert.equal(cbWake.member, 'codex', 'callback follows the frozen registration across rebind');
  assert.equal(cbWake.context.moduleId, 'plan');
  assert.equal(cbWake.context.taskId, cbTaskId);
  // Restart: fresh store + fresh dispatcher still deliver nothing twice.
  const freshDispatcher = createRoomTaskDispatcher({ db, sse, manager });
  new RoomTaskStore(db, jobs, freshDispatcher).handleJobFinished(jobs.get(cbExec.job.id)!, { finalAttempt: true });
  assert.equal(wakeCalls.length, wakesBeforeCb + 1, 'restart replay must not re-wake a delivered callback');
  const planRestore = jobs.workflowModules.setBinding('plan', {
    contactId: 'codex', runner: 'codex', model: planModel, reasoning: 'high',
  }, jobs.workflowModules.revision(), 'User');
  assert.equal(planRestore.ok, true);

  // ── 8. rebound binding: old snapshot invalid, explicit cancel unlocks ──
  const anchorRebind = anchor('room-a', 'User：批准 model-rebind。');
  const rebindCreated = await okJson('codex', planA, 'task_create', {
    room_id: 'room-a', task_path: 'tasks/model-rebind.md', title: 'rebind',
    requirements: 'rebind 需求', workspace: dir, anchor_message_id: anchorRebind,
  });
  const rebindTaskId: string = rebindCreated.task.id;
  const rebindHandoff = await okJson('codex', planA, 'task_handoff', {
    room_id: 'room-a', task_path: 'tasks/model-rebind.md', actor_module: 'plan',
    to_module: 'execute', request: '做', evidence_refs: [],
  });
  const execModel = jobs.workflowModules.bindings().execute.model;
  const rebound = jobs.workflowModules.setBinding('execute', {
    contactId: 'muse2', runner: 'opencode', model: execModel, reasoning: 'high',
  }, jobs.workflowModules.revision(), 'User');
  assert.equal(rebound.ok, true);
  const staleAccept = await failCall('muse', {
    roomId: 'room-a', moduleId: 'execute', taskId: rebindTaskId, handoffId: rebindHandoff.handoff.id,
  }, 'task_accept', { room_id: 'room-a', task_path: 'tasks/model-rebind.md' });
  assert.match(staleAccept, /易主|失效/);
  // No deadlock: the owner cancels explicitly, then re-hands off.
  await okJson('codex', planA, 'task_retry', {
    room_id: 'room-a', task_path: 'tasks/model-rebind.md', mode: 'cancel-handoff',
  });
  const rebindHandoff2 = await okJson('codex', planA, 'task_handoff', {
    room_id: 'room-a', task_path: 'tasks/model-rebind.md', actor_module: 'plan',
    to_module: 'execute', request: '做（新绑定）', evidence_refs: [],
  });
  assert.equal(rebindHandoff2.handoff.to_contact, 'muse2');
  await okJson('muse2', {
    roomId: 'room-a', moduleId: 'execute', taskId: rebindTaskId, handoffId: rebindHandoff2.handoff.id,
  }, 'task_accept', { room_id: 'room-a', task_path: 'tasks/model-rebind.md' });

  // Decline keeps ownership with the requester.
  const toReviewRb = await okJson('muse2', {
    roomId: 'room-a', moduleId: 'execute', taskId: rebindTaskId,
  }, 'task_handoff', {
    room_id: 'room-a', task_path: 'tasks/model-rebind.md', actor_module: 'execute',
    to_module: 'review', request: '请评审', evidence_refs: [],
  });
  await okJson('aye', {
    roomId: 'room-a', moduleId: 'review', taskId: rebindTaskId, handoffId: toReviewRb.handoff.id,
  }, 'task_decline', { room_id: 'room-a', task_path: 'tasks/model-rebind.md' });
  assert.equal(taskOf('room-a', 'tasks/model-rebind.md').owner_module, 'execute');

  // ── M3. async provider failure flips delivery back to retryable ──
  const rbExecCtxM3: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'execute', taskId: rebindTaskId };
  failTurns = true;
  const m3handoff = await okJson('muse2', rbExecCtxM3, 'task_handoff', {
    room_id: 'room-a', task_path: 'tasks/model-rebind.md', actor_module: 'execute',
    to_module: 'review', request: '请评审（会失败一次）', evidence_refs: [],
  });
  assert.equal(m3handoff.delivery.status, 'posted', 'queue acceptance is recorded');
  let ledgerFailed = false;
  for (let i = 0; i < 100 && !ledgerFailed; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const row = db.prepare(
      'SELECT status FROM room_task_dispatches WHERE idempotency_key = ?'
    ).get(`task-handoff:v1:${m3handoff.handoff.id}`) as { status: string } | undefined;
    ledgerFailed = row?.status === 'failed';
  }
  assert.equal(ledgerFailed, true, 'round failure must flip delivery to failed, not stuck posted');
  failTurns = false;
  const wakesBeforeM3Retry = wakeCalls.length;
  hold.active = true;
  const m3retry = await okJson('muse2', rbExecCtxM3, 'task_retry', {
    room_id: 'room-a', task_path: 'tasks/model-rebind.md',
    handoff_id: m3handoff.handoff.id, mode: 'handoff',
  });
  assert.equal(m3retry.delivery.status, 'posted');
  assert.equal(wakeCalls.length, wakesBeforeM3Retry + 1, 'explicit retry redelivers to the same recipient');
  assert.equal(wakeCalls[wakeCalls.length - 1].member, 'aye');

  // ── M4. 部署重启打断在途的账本派单：durable 快照 → 不翻 failed → 启动恢复续跑一次 ──
  const m3LedgerKey = `task-handoff:v1:${m3handoff.handoff.id}`;
  const m3FactId = Number((db.prepare(
    'SELECT message_id FROM room_task_dispatches WHERE idempotency_key = ?'
  ).get(m3LedgerKey) as { message_id: number }).message_id);
  const factMeta = () => JSON.parse(
    (db.prepare('SELECT meta FROM messages WHERE id = ?').get(m3FactId) as { meta: string }).meta
  );
  for (let i = 0; i < 40 && !hold.release; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(hold.release, 'retried turn is in flight');
  const live = factMeta();
  assert.equal(live.roomDispatch.status, 'dispatching');
  assert.equal(live.roomDispatch.dispatchClass, 'live');
  assert.deepEqual(live.roomDispatch.taskHandoff, { taskId: rebindTaskId, handoffId: m3handoff.handoff.id });
  assert.deepEqual(live.roomDispatch.targetIds, ['aye']);

  await manager.stopAll('deploy-restart');
  const interruptedFact = factMeta();
  assert.equal(interruptedFact.roomDispatch.status, 'error');
  assert.equal(interruptedFact.roomDispatch.interruptionReason, 'deploy-restart');
  assert.equal(interruptedFact.roomHost, undefined, 'ledger facts never grow a room-host block');
  // 真实运行时会插这条打断气泡并带 replaySourceMessageId；这里 runtime 被桩掉，手动补上。
  const bubbleId = Number(db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('room-a', 'aye', 'system', 'error', '部署重启中断', 'done', ?, 'main')`
  ).run(JSON.stringify({ interruptionReason: 'deploy-restart', replaySourceMessageId: m3FactId })).lastInsertRowid);

  hold.active = false;
  hold.release!('error');
  hold.release = null;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(
    (db.prepare('SELECT status FROM room_task_dispatches WHERE idempotency_key = ?').get(m3LedgerKey) as { status: string }).status,
    'posted',
    'deploy-interrupted rounds must not flip to failed: durable resume owns the wake',
  );

  const wakesBeforeResume = wakeCalls.length;
  assert.equal(manager.recoverDeferredRoomDispatches(), 1, 'deploy-interrupted ledger delivery resumes');
  for (let i = 0; i < 100 && wakeCalls.length < wakesBeforeResume + 1; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(wakeCalls.length, wakesBeforeResume + 1);
  assert.equal(wakeCalls[wakeCalls.length - 1].member, 'aye');
  assert.equal(wakeCalls[wakeCalls.length - 1].context.moduleId, 'review');
  assert.equal(wakeCalls[wakeCalls.length - 1].context.handoffId, m3handoff.handoff.id);
  const bubble = db.prepare('SELECT content, meta FROM messages WHERE id = ?').get(bubbleId) as { content: string; meta: string };
  assert.equal(bubble.content, '部署重启中断，已排队续跑');
  assert.equal(JSON.parse(bubble.meta).resumeQueued, true);
  for (let i = 0; i < 40 && factMeta().roomDispatch.status !== 'done'; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(factMeta().roomDispatch.status, 'done');
  assert.equal(manager.recoverDeferredRoomDispatches(), 0, 'a finished resume never replays again');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(wakeCalls.length, wakesBeforeResume + 1);

  // ── M2. recovery skips legacy host rows, replays verified task refs ──
  const legacyHostId = Number((db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('room-a', 'room-host', 'user', 'text', '旧 nudge', 'done', ?, 'main')`
  ).run(JSON.stringify({
    roomHost: { targets: ['muse'] },
    roomDispatch: { status: 'deferred', targetIds: ['muse'], dispatchClass: 'drain' },
  })).lastInsertRowid));
  db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
     VALUES ('room-a', 'system', 'user', 'text', '任务交接事实', 'done', ?, 'main', ?)`
  ).run(JSON.stringify({
    event: 'room-task-handoff',
    roomDispatch: {
      status: 'deferred', targetIds: ['aye'], reactionRounds: 0, dispatchClass: 'drain',
      taskHandoff: { taskId: rebindTaskId, handoffId: m3handoff.handoff.id },
    },
  }), 'task-handoff:v1:recovery-probe');
  const wakesBeforeRecovery = wakeCalls.length;
  const recovered = manager.recoverDeferredRoomDispatches();
  assert.ok(recovered >= 1, 'verified task ref recovers');
  for (let i = 0; i < 100 && wakeCalls.length < wakesBeforeRecovery + 1; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(wakeCalls.length, wakesBeforeRecovery + 1);
  assert.equal(wakeCalls[wakeCalls.length - 1].member, 'aye');
  assert.equal(wakeCalls[wakeCalls.length - 1].context.moduleId, 'review');
  const legacyState = JSON.parse(
    (db.prepare('SELECT meta FROM messages WHERE id = ?').get(legacyHostId) as { meta: string }).meta
  );
  assert.equal(legacyState.roomDispatch.status, 'error');
  assert.match(legacyState.roomDispatch.error, /never replays/);

  // ── 9. explicit takeover fences the stale attempt ──
  const rbExecCtx: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'execute', taskId: rebindTaskId };
  // Owner is execute/muse2 via the accepted rebind handoff; start execution
  // against that durable authorization (no new handoff needed).
  const failExec = await okJson('muse2', {
    roomId: 'room-a', moduleId: 'execute', taskId: rebindTaskId, handoffId: rebindHandoff2.handoff.id,
  }, 'execution_start', {
    room_id: 'room-a', task_path: 'tasks/model-rebind.md', module: 'execute',
    expected_revision: taskOf('room-a', 'tasks/model-rebind.md').revision, workspace: dir,
    objective: '会失败的尝试', return_mode: 'notify', return_to_module: 'plan',
  });
  await finishJob(jobs.get(failExec.job.id)!, 'failed', RECEIPT({ branch: 'wip', head: SHA('d') }));
  assert.equal(taskOf('room-a', 'tasks/model-rebind.md').status, 'blocked');
  const taken = await okJson('muse2', rbExecCtx, 'task_retry', {
    room_id: 'room-a', task_path: 'tasks/model-rebind.md', job_id: failExec.job.id, mode: 'takeover',
  });
  assert.ok(taken.job.id !== failExec.job.id);
  const lateComplete = jobs.complete(jobs.get(failExec.job.id)!, 'done', 'late', null, 'delivered', '{}');
  assert.ok('error' in lateComplete && /fenced/.test(lateComplete.error), 'stale callbacks are rejected');

  // Fence: old callback paths are dead after takeover.
  const oldRetry = await failCall('muse2', rbExecCtx, 'task_retry', {
    room_id: 'room-a', task_path: 'tasks/model-rebind.md', job_id: failExec.job.id, mode: 'callback',
  });
  assert.match(oldRetry, /废弃/);
  // Deferred recovery carrying the old callback ref is refused, not woken.
  const oldCbMsgId = Number((db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('room-a', 'system', 'user', 'text', '旧回调事实', 'done', ?, 'main')`
  ).run(JSON.stringify({
    event: 'room-task-handoff',
    roomDispatch: {
      status: 'deferred', targetIds: ['codex'], reactionRounds: 0, dispatchClass: 'drain',
      taskCallback: { taskId: rebindTaskId, jobId: failExec.job.id },
    },
  })).lastInsertRowid));
  const coveWakesBefore = wakeCalls.filter((w) => w.member === 'codex').length;
  manager.recoverDeferredRoomDispatches();
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    wakeCalls.filter((w) => w.member === 'codex').length, coveWakesBefore,
    'fenced callback recovery must not wake',
  );
  const oldCbState = JSON.parse(
    (db.prepare('SELECT meta FROM messages WHERE id = ?').get(oldCbMsgId) as { meta: string }).meta
  );
  assert.equal(oldCbState.roomDispatch.status, 'error');
  // Replacement job inherited the callback: completes exactly once to plan.
  const wakesBeforeNew = wakeCalls.length;
  await finishJob(jobs.get(taken.job.id)!, 'done', RECEIPT({ branch: 'takeover-wip', head: SHA('e') }));
  assert.equal(wakeCalls.length, wakesBeforeNew + 1, 'inherited callback delivers once');
  assert.equal(wakeCalls[wakeCalls.length - 1].member, 'codex');

  // ── 10. MCP: DM credential gets no room task capabilities ──
  // (Schema parity + turn-context binding over MCP are covered with
  // factory-captured bearers in roomTaskRuntimePath.test.mts; here only the
  // real DM credential path is exercised.)
  const app = express();
  app.use(express.json());
  app.use('/api', hubMcpRouter(db, jobs, { hubToken: HUB_TOKEN }, {
    taskDispatch: dispatcher, taskStoreOptions: { readVaultTask },
  }));
  const httpServer = app.listen(0, '127.0.0.1');
  resources.httpServer = httpServer;
  await new Promise<void>((resolve) => httpServer.once('listening', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const mcpUrl = `http://127.0.0.1:${(address as { port: number }).port}/api/hub-mcp/codex`;
  try {
    // DM bearer: member contact, but no room authority at all.
    const dmClient = new Client({ name: 'room-task-e2e-dm', version: '1' });
    await dmClient.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${hubMcpBearerToken(HUB_TOKEN, 'codex')}` } },
    } as any));
    const dmGet = await dmClient.callTool({
      name: 'task_get', arguments: { room_id: 'room-a', task_path: 'tasks/model-live.md' },
    });
    assert.equal(dmGet.isError, true, 'DM gets no room task capabilities via membership alone');
    assert.match((dmGet.content as Array<{ text: string }>)[0].text, /模块轮次授权/);
    await dmClient.close();
  } finally {
    await new Promise<void>((resolve, reject) => httpServer.close((e) => e ? reject(e) : resolve()));
  }

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── WP-B B2: execution_get patch pagination / per-file fetch ──────────
// A 3-file patch longer than one page must page continuously by offset,
// filter to a single file by patch_file, and report an empty end page for
// out-of-range offsets. Default (no paging args) behavior is unchanged.
test('B2: execution_get section=patch paginates and filters by file', { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-b2-patch-'));
  const db = openDb(path.join(dir, 'hub.db'));
  t.after(() => { try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); });
  const sse = { broadcast: () => {} } as unknown as SseHub;
  const jobs = new JobStore(db, sse);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']] as const) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(id, id, backend);
  }
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-p', 'room-p', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, governance: 'open', members: ['codex', 'muse', 'aye'] }));
  const anchorId = Number(db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('room-p', 'user', 'user', 'text', 'User：批准做 patch 分页', 'done', '{}', 'main')`,
  ).run().lastInsertRowid);
  const dispatch = { dispatchToModule: () => ({ status: 'posted' as const }) };
  const call = async (contactId: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) => {
    const turn = beginRoomTurn(db, {
      roomId: ctx.roomId, contactId, moduleId: ctx.moduleId,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      ...(ctx.handoffId ? { handoffId: ctx.handoffId } : {}),
    });
    try {
      const tool = buildRoomTaskTools(db, jobs, contactId, dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
        .find((item) => item.name === name)!;
      return await tool.exec(args);
    } finally {
      endRoomTurn(db, turn.turnId, 'test');
    }
  };
  const room = { room_id: 'room-p', task_path: 'tasks/patch-page.md' };
  const created = await call('codex', { roomId: 'room-p', moduleId: 'plan' }, 'task_create', {
    ...room, title: 'patch page', requirements: 'req', workspace: dir, anchor_message_id: anchorId,
  });
  assert.equal(created.ok, true, created.text);
  const pass = await call('codex', { roomId: 'room-p', moduleId: 'plan' }, 'task_pass', {
    ...room, to_module: 'execute', note: 'do it',
  });
  assert.equal(pass.ok, true, pass.text);
  const task = new RoomTaskStore(db, jobs, null).getTask('room-p', 'tasks/patch-page.md')!;
  const started = await call('muse', { roomId: 'room-p', moduleId: 'execute' }, 'execution_start', {
    ...room, module: 'execute', expected_revision: task.revision, workspace: dir,
    objective: 'implement for patch paging', return_to_module: 'review',
  });
  assert.equal(started.ok, true, started.text);
  const jobId = (JSON.parse(started.text) as { job: { id: string } }).job.id;
  const fileBlock = (file: string, marker: string, lines: number): string => [
    `diff --git a/${file} b/${file}`,
    'index 1111111..2222222 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${lines} +1,${lines + 1} @@`,
    ...Array.from({ length: lines }, (_, i) => `+${marker}-line-${i}-${'x'.repeat(20)}`),
  ].join('\n');
  const patch = [
    fileBlock('src/a.ts', 'AAA', 40),
    fileBlock('src/b.ts', 'BBB', 40),
    fileBlock('src/c.ts', 'CCC', 40),
  ].join('\n');
  assert.ok(patch.length > 2000, `fixture patch must span pages (got ${patch.length})`);
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
  const meta = boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'wip-patch', head: 'd'.repeat(40), diffstat: '3 files changed',
      changedFiles: { files: ['src/a.ts', 'src/b.ts', 'src/c.ts'], total: 3 },
      tests: [{ suite: 'unit', status: 'pass' }],
      patch, patchChars: patch.length, patchTruncated: false,
    },
    declared: { committed: false, pushed: false, stage: 'delivered' },
  });
  const done = jobs.complete(jobs.get(jobId)!, 'done', 'simulated done', null, 'delivered', meta);
  assert.ok(!('error' in done), JSON.stringify(done));
  const plan = { roomId: 'room-p', moduleId: 'plan' } as const;
  const get = async (args: Record<string, unknown>) => {
    const out = await call('codex', plan, 'execution_get', { ...room, job_id: jobId, section: 'patch', ...args });
    assert.equal(out.ok, true, `${JSON.stringify(args)} should succeed: ${out.text.slice(0, 300)}`);
    return JSON.parse(out.text) as { receiptPage: Record<string, unknown> };
  };
  const p1 = (await get({ patch_limit: 1000 })).receiptPage;
  assert.equal(p1.kind, 'patch');
  assert.deepEqual(p1.patchFiles, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.equal(p1.patchTotalChars, patch.length);
  assert.equal(p1.patchNextOffset, 1000);
  assert.equal(p1.patchAtEnd, false);
  assert.equal(p1.page, patch.slice(0, 1000));
  const p2 = (await get({ patch_offset: p1.patchNextOffset, patch_limit: 1000 })).receiptPage;
  assert.equal(p2.page, patch.slice(1000, 2000));
  assert.equal(p2.patchNextOffset, 2000);
  assert.equal(p2.patchAtEnd, (2000 >= patch.length));
  assert.equal(String(p1.page) + String(p2.page), patch.slice(0, 2000), 'pages are continuous');
  const onlyB = (await get({ patch_file: 'src/b.ts' })).receiptPage;
  assert.ok(String(onlyB.page).includes('BBB-line-0'), 'file filter returns that file block');
  assert.ok(!String(onlyB.page).includes('AAA-line-0'), 'file filter excludes other files');
  assert.ok(!String(onlyB.page).includes('CCC-line-0'), 'file filter excludes other files');
  assert.deepEqual(onlyB.patchFiles, ['src/a.ts', 'src/b.ts', 'src/c.ts'], 'file list still covers the whole patch');
  assert.equal(onlyB.patchAtEnd, true);
  const pastEnd = (await get({ patch_offset: patch.length + 500 })).receiptPage;
  assert.equal(pastEnd.page, '');
  assert.equal(pastEnd.patchAtEnd, true);
  assert.equal(pastEnd.atEnd, true);
  const def = (await get({})).receiptPage;
  assert.equal(def.page, patch, 'no-arg call still returns the whole stored patch');
  assert.equal(def.atEnd, true);
  assert.equal(def.patchAtEnd, true);
});
