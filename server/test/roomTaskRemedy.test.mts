// Bounded automatic remedy for failed handoff obligations (scheme item 3).
//
// Fast store-level regressions (dedup, eligibility, chain-breaker) plus two
// REAL AgentRuntime integrations with a scripted in-process backend (no
// network, no CLI spawns): T1 fails bare -> exactly one remedy turn R runs
// with a fresh nonce (R settles via an explicit handoff), and a bare R never
// chains a third turn. The scripted backend performs REAL tool calls through
// the REAL RoomTaskStore/dispatcher so receipts, ledger and the obligation
// gate are all production code; only the model transport is scripted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { AgentManager } from '../src/runtime/manager.js';
import { AgentRuntime } from '../src/runtime/runtime.js';
import type { RoomModuleContext } from '../src/runtime/runtime.js';
import type { AgentBackend, TurnEvent } from '../src/backends/types.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import type { RoomTaskToolContext } from '../src/roomTasks/roomTaskStore.js';
import {
  RoomTaskStore,
  ensureRemedySchema,
  isRemedyTurn,
  markRemedyTurn,
  tryClaimRemedy,
} from '../src/roomTasks/roomTaskStore.js';
import { remedyEligibility } from '../src/roomTasks/handoffObligation.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { createRoomTaskDispatcher } from '../src/runtime/roomTaskDispatch.js';
import { JobStore } from '../src/jobs/jobStore.js';
import type { SseHub } from '../src/platform/sse.js';

const sseHub = () => ({ broadcast() {} }) as unknown as SseHub;

function baseConfig(dir: string): any {
  return {
    port: 3900,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.db'),
    agentsDir: path.join(dir, 'agents'),
    webDist: '',
    uploadsDir: path.join(dir, 'uploads'),
    claude: { cliPath: 'missing-binary-remedy-e2e' },
    codex: { cliPath: 'missing-binary-remedy-e2e', nativeCompact: { enabled: false } },
    grok: { cliPath: 'missing-binary-remedy-e2e' },
    opencode: { cliPath: 'missing-binary-remedy-e2e' },
    api: { turnTimeoutMs: 8000 },
    memory: {
      mcpUrl: null, repoPath: dir, injectOnSpawn: false, searchPerTurn: false,
      capture: false, maxTurnChars: 0, sessionMaxAgeHours: 0,
    },
    backup: { enabled: false, dir: '', intervalHours: 24, keep: 1 },
  };
}

interface Fixture {
  dir: string;
  db: ReturnType<typeof openDb>;
  jobs: JobStore;
  manager: AgentManager;
  dispatcher: ReturnType<typeof createRoomTaskDispatcher>;
  anchor: (roomId: string, content: string) => number;
  cleanup: () => void;
}

function fixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-remedy-'));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  const db = openDb(path.join(dir, 'hub.db'));
  const sse = sseHub();
  const jobs = new JobStore(db, sse);
  for (const [id, backend] of [['codex', 'api'], ['muse', 'api']] as const) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')")
      .run(id, id, backend);
  }
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('rr', 'RR', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse'] }));
  const managerDeps: any = {
    db, sse,
    config: baseConfig(dir),
    jobStore: jobs, vault: null,
  };
  const manager = new AgentManager(managerDeps);
  // No real model turns through the manager: task delivery is faked posted.
  (manager as any).dispatchRoomMessageTracked = (_room: any, _content: string, _options: any) => ({
    targets: ['muse'],
    completion: Promise.resolve({}),
  });
  const dispatcher = createRoomTaskDispatcher({ db, sse, manager });
  const anchor = (roomId: string, content: string): number => Number((db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES (?, 'user', 'user', 'text', ?, 'done', '{}', 'main')`
  ).run(roomId, content)).lastInsertRowid);
  return {
    dir, db, jobs, manager, dispatcher, anchor,
    cleanup: () => {
      try { (jobs as any).stopOutOfBandResolver?.(); } catch { /* ignore */ }
      try { (manager as any).stopAll?.(); } catch { /* ignore */ }
      try { db.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const planCtx: RoomTaskToolContext = { roomId: 'rr', moduleId: 'plan' };

function openTurn(fx: Fixture, contactId: string, ctx: RoomTaskToolContext) {
  const turn = beginRoomTurn(fx.db, {
    roomId: ctx.roomId,
    contactId,
    moduleId: ctx.moduleId,
    ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
    ...(ctx.handoffId ? { handoffId: ctx.handoffId } : {}),
  });
  const bound: RoomTaskToolContext = { ...ctx, turnId: turn.turnId };
  const tools = buildRoomTaskTools(fx.db, fx.jobs, contactId, fx.dispatcher, {}, bound);
  return {
    turnId: turn.turnId,
    okJson: async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((entry) => entry.name === name)!;
      assert.ok(tool, `${name} is exposed`);
      const out = await tool.exec(args);
      assert.equal(out.ok, true, `${name} should succeed: ${out.text.slice(0, 300)}`);
      return JSON.parse(out.text);
    },
    close: (outcome = 'test') => endRoomTurn(fx.db, turn.turnId, outcome),
  };
}

async function createTask(fx: Fixture, taskPath: string) {
  const t = openTurn(fx, 'codex', planCtx);
  const anchorId = fx.anchor('rr', `User：批准 ${taskPath}。`);
  const created = await t.okJson('task_create', {
    room_id: 'rr', task_path: taskPath, title: 'REMEDY',
    requirements: '原始需求全文：补办回归。', workspace: fx.dir, anchor_message_id: anchorId,
  });
  t.close();
  return created.task as { id: string };
}

test('remedy claims are persistent and at most once per failed turn', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  ensureRemedySchema(fx.db);
  const first = tryClaimRemedy(fx.db, {
    failedTurnId: 'turn-a', taskId: 'task-a', roomId: 'rr', contactId: 'codex', moduleId: 'plan',
  });
  assert.equal(first.claimed, true, 'first claim wins');
  assert.equal(tryClaimRemedy(fx.db, {
    failedTurnId: 'turn-a', taskId: 'task-a', roomId: 'rr', contactId: 'codex', moduleId: 'plan',
  }).claimed, false, 'second claim for the same failed turn is blocked');
  assert.equal(tryClaimRemedy(fx.db, {
    failedTurnId: 'turn-a', taskId: 'task-b', roomId: 'rr', contactId: 'codex', moduleId: 'plan',
  }).claimed, true, 'a different task claims independently');
  assert.equal(tryClaimRemedy(fx.db, {
    failedTurnId: 'turn-b', taskId: 'task-a', roomId: 'rr', contactId: 'codex', moduleId: 'plan',
  }).claimed, true, 'a different failed turn claims independently');
  assert.equal(isRemedyTurn(fx.db, 'remedy-1'), false);
  markRemedyTurn(fx.db, 'remedy-1', 'turn-a', 'task-a');
  assert.equal(isRemedyTurn(fx.db, 'remedy-1'), true, 'remedy turns are marked');
  assert.equal(isRemedyTurn(fx.db, 'turn-a'), false, 'failed turns are not remedy turns');
});

test('remedy eligibility rereads the live responsibility chain', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const task = await createTask(fx, 'tasks/elig.md');
  assert.deepEqual(
    remedyEligibility(fx.db, fx.jobs, task.id, 'plan', 'codex'),
    { eligible: true, reason: '仍是负责人' },
  );
  // Move responsibility away: handoff + accept to execute.
  const t0 = openTurn(fx, 'codex', planCtx);
  const sent = await t0.okJson('task_handoff', {
    room_id: 'rr', task_path: 'tasks/elig.md', actor_module: 'plan',
    to_module: 'execute', request: '实现。', evidence_refs: [],
  });
  t0.close();
  const exec = openTurn(fx, sent.handoff.to_contact, {
    roomId: 'rr', moduleId: 'execute', taskId: task.id, handoffId: sent.handoff.id,
  });
  await exec.okJson('task_accept', { room_id: 'rr', task_path: 'tasks/elig.md' });
  exec.close();
  const moved = remedyEligibility(fx.db, fx.jobs, task.id, 'plan', 'codex');
  assert.equal(moved.eligible, false, 'moved responsibility must not be越权补办');
  assert.match(moved.reason, /转移/);
  // A pending edge back to plan re-opens the receiving duty.
  const back = openTurn(fx, sent.handoff.to_contact, { roomId: 'rr', moduleId: 'execute', taskId: task.id });
  const h2 = await back.okJson('task_handoff', {
    room_id: 'rr', task_path: 'tasks/elig.md', actor_module: 'execute',
    to_module: 'plan', request: '回 plan 定夺。', evidence_refs: [],
  });
  back.close();
  void h2;
  assert.equal(remedyEligibility(fx.db, fx.jobs, task.id, 'plan', 'codex').eligible, true);
  // Closed tasks never remedy.
  fx.db.prepare("UPDATE room_tasks SET status = 'closed' WHERE id = ?").run(task.id);
  assert.equal(remedyEligibility(fx.db, fx.jobs, task.id, 'plan', 'codex').eligible, false);
});

type ScriptedAction = 'bare' | 'handoff';

function scriptedBackendFactory(
  fx: Fixture,
  runtime: AgentRuntime,
  moduleCtx: RoomModuleContext,
  task: { id: string; task_path: string },
  script: ScriptedAction[],
  rounds: { count: number },
): { build(): Promise<AgentBackend> } {
  return {
    build: async () => ({
      kind: 'api',
      alive: () => true,
      start: async () => {},
      stop: async () => {},
      interrupt: async () => {},
      sendTurn: () => {
        const round = rounds.count;
        rounds.count += 1;
        const events = (async function* (): AsyncGenerator<TurnEvent> {
          if (script[round] === 'handoff') {
            const originTurnId = (runtime as any).originTurnId as string | null;
            assert.ok(originTurnId, 'remedy turn carries a fresh legal nonce');
            const tools = buildRoomTaskTools(fx.db, fx.jobs, 'codex', fx.dispatcher, {}, {
              roomId: 'rr', moduleId: moduleCtx.moduleId!, taskId: task.id, turnId: originTurnId,
            });
            const tool = tools.find((entry) => entry.name === 'task_handoff')!;
            const store = new RoomTaskStore(fx.db, fx.jobs, fx.dispatcher);
            const current = store.getTaskById(task.id)!;
            const out = await tool.exec({
              room_id: 'rr', task_path: task.task_path, actor_module: moduleCtx.moduleId!,
              to_module: current.owner_module === 'plan' ? 'execute' : 'plan',
              request: '补办：按真实状态显式交接。',
            });
            assert.equal(out.ok, true, `remedy handoff must succeed: ${out.text.slice(0, 300)}`);
          }
          yield { type: 'done', finalText: script[round] === 'handoff' ? '已显式交接' : 'done', usage: { input: 1, output: 1 } };
        })();
        return { events, interrupt: async () => {} };
      },
    }) as unknown as AgentBackend,
  };
}

async function waitForRounds(rounds: { count: number }, expected: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (rounds.count < expected) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${expected} provider rounds (got ${rounds.count})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function roomRow(fx: Fixture) {
  return fx.db.prepare("SELECT * FROM contacts WHERE id = 'rr'").get() as any;
}

function memberRow(fx: Fixture, id: string) {
  return fx.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as any;
}

function makeRuntime(fx: Fixture, moduleCtx: RoomModuleContext): AgentRuntime {
  const config = baseConfig(fx.dir);
  const runtime = new AgentRuntime(roomRow(fx), memberRow(fx, 'codex'), {
    db: fx.db,
    sse: sseHub(),
    config,
    vault: null,
    jobStore: fx.jobs,
    taskDispatch: fx.dispatcher,
    taskStoreOptions: {},
  } as any, moduleCtx);
  return runtime;
}

test('failed turn auto-wakes exactly one remedy turn that settles', { timeout: 60_000 }, async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const task = await createTask(fx, 'tasks/auto-remedy.md');
  const taskRef = { id: task.id, task_path: 'tasks/auto-remedy.md' };
  const triggerId = fx.anchor('rr', 'User：开始补办验证。');
  const moduleCtx: RoomModuleContext = { moduleId: 'plan', taskId: task.id };
  const runtime = makeRuntime(fx, moduleCtx);
  const rounds = { count: 0 };
  (runtime as any).backendFactory = scriptedBackendFactory(fx, runtime, moduleCtx, taskRef, ['bare', 'handoff'], rounds);
  const outcome = await runtime.runRoomTurn('normal', undefined, triggerId);
  assert.equal(outcome, 'error', 'bare T1 fails the obligation');
  await waitForRounds(rounds, 2);
  // Exactly one remedy fact, one claim, fresh nonce, settled remedy turn.
  const facts = fx.db.prepare(
    "SELECT * FROM messages WHERE contact_id = 'rr' AND idempotency_key LIKE 'task-remedy:v1:%'",
  ).all() as Array<{ id: number; meta: string }>;
  assert.equal(facts.length, 1, 'exactly one remedy wake, never duplicated');
  const remedyMeta = JSON.parse(facts[0].meta) as { failedTurnId: string; taskIds: string[] };
  assert.deepEqual(remedyMeta.taskIds, [task.id]);
  const claims = fx.db.prepare('SELECT * FROM room_task_remedies').all() as Array<{
    failed_turn_id: string; task_id: string; remedy_turn_id: string | null;
  }>;
  assert.equal(claims.length, 1);
  assert.equal(claims[0].failed_turn_id, remedyMeta.failedTurnId);
  assert.ok(claims[0].remedy_turn_id, 'remedy turn is linked');
  const turns = fx.db.prepare(
    "SELECT turn_id, status FROM room_task_turns WHERE turn_id IN (?, ?)",
  ).all(claims[0].failed_turn_id, claims[0].remedy_turn_id) as Array<{ turn_id: string; status: string }>;
  const byId = new Map(turns.map((row) => [row.turn_id, row.status]));
  assert.equal(byId.get(claims[0].failed_turn_id), 'unsettled', 'original failure audit is kept');
  assert.equal(byId.get(claims[0].remedy_turn_id!), 'settled', 'remedy turn settles via its explicit handoff');
  assert.notEqual(claims[0].remedy_turn_id!, claims[0].failed_turn_id, 'remedy uses a fresh nonce');
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ? AND kind = 'turn-unsettled'").get(task.id) as { c: number }).c,
    1,
    'no extra unsettled markers',
  );
  const handoffs = fx.db.prepare('SELECT * FROM room_task_handoffs WHERE task_id = ?').all(task.id) as Array<unknown>;
  assert.equal(handoffs.length, 1, 'remedy creates no duplicate dispatch');
  await runtime.stopAll?.().catch(() => {});
  await runtime.stop().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(rounds.count, 2, 'no further automatic turns');
});

test('remedy turn failure never chains a third turn', { timeout: 60_000 }, async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const task = await createTask(fx, 'tasks/auto-remedy-nochain.md');
  const taskRef = { id: task.id, task_path: 'tasks/auto-remedy-nochain.md' };
  const triggerId = fx.anchor('rr', 'User：开始补办不连锁验证。');
  const moduleCtx: RoomModuleContext = { moduleId: 'plan', taskId: task.id };
  const runtime = makeRuntime(fx, moduleCtx);
  const rounds = { count: 0 };
  (runtime as any).backendFactory = scriptedBackendFactory(fx, runtime, moduleCtx, taskRef, ['bare', 'bare'], rounds);
  const outcome = await runtime.runRoomTurn('normal', undefined, triggerId);
  assert.equal(outcome, 'error');
  await waitForRounds(rounds, 2);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(rounds.count, 2, 'a failing remedy never schedules another remedy');
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ? AND kind = 'turn-unsettled'").get(task.id) as { c: number }).c,
    2,
    'both failures stay explicit',
  );
  const claims = fx.db.prepare('SELECT * FROM room_task_remedies').all() as Array<{
    failed_turn_id: string; remedy_turn_id: string | null;
  }>;
  assert.equal(claims.length, 1, 'only the first failure claims a remedy');
  assert.ok(claims[0].remedy_turn_id, 'remedy turn is still linked for the chain-breaker');
  assert.equal(isRemedyTurn(fx.db, claims[0].remedy_turn_id!), true);
  await runtime.stop().catch(() => {});
});
