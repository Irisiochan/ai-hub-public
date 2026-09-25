// Migration from the retired host dispatch chain to the model-driven task
// ledger. The old chain (Plan sweep -> room-host execution dispatch ->
// marker-gated delegate_to_worker) is retired: the sweep enqueues nothing,
// scoped delegates get the migration pointer, and legacy blocked attempts
// continue explicitly via task_import + handoff/accept/execution_start
// without rewriting their old failure. The full replacement flow lives in
// roomTaskModelDriven.test.mts; this file pins the retirement boundary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { buildDelegateTools } from '../src/jobs/delegateTools.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import type { RoomTaskToolContext } from '../src/roomTasks/roomTaskStore.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import { JobStore } from '../src/jobs/jobStore.js';
import type { SseHub } from '../src/platform/sse.js';
// @ts-expect-error cross-package worker ESM for the real retired sweep
import { coordinationMethods } from '../../worker/triage/domains/coordination.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-plan-dispatch-handoff-'));
  const tasksDir = path.join(dir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const db = openDb(path.join(dir, 'hub.db'));
  const sse = { broadcast() {} } as unknown as SseHub;
  const jobs = new JobStore(db, sse);
  for (const [id, backend] of [
    ['codex', 'codex'],
    ['muse', 'opencode-cli'],
    ['aye', 'grok-cli'],
  ] as const) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')")
      .run(id, id, backend);
  }
  const roomConfig = JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse', 'aye'] });
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-handoff', '交接房', 'room', 'room', ?)")
    .run(roomConfig);
  const anchor = Number((db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('room-handoff', 'user', 'user', 'text', 'User：批准继续。', 'done', '{}', 'main')`
  ).run()).lastInsertRowid);
  return { dir, tasksDir, db, sse, jobs, anchor };
}

function teardown(ctx: ReturnType<typeof fixture>) {
  ctx.jobs.stopOutOfBandResolver();
  ctx.db.close();
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

test('retired sweep enqueues nothing and retires every queued coordination payload', async () => {
  const ctx = fixture();
  try {
    const worker: any = {
      ...coordinationMethods,
      config: {
        coordination: { enabled: true, roomId: 'room-handoff', tasksDir: ctx.tasksDir, scanIntervalMinutes: 5 },
      },
      store: {
        getSourceState: () => null,
        poolUsage: () => ({ count: 0 }),
        finish: (id: string, outcome: string) => {},
      },
      coordinationPolicy: () => ({ poolFull: false, remaining: 8 }),
      scanHubAutoHygieneIfDue: async () => false,
      nextCoordinationPollAt: 0,
      enqueue: () => { throw new Error('retired sweep must never enqueue'); },
    };
    assert.equal(await worker.scanCoordinationIfDue(Date.now()), false);
    // Queued legacy payloads drain as noop without model wake or Hub sends.
    const finished: string[] = [];
    worker.store = {
      finish: (id: string, outcome: string) => { finished.push(`${id}:${outcome}`); },
    };
    await worker.processCoordination({ id: 'evt-1', payload: { mode: 'coordination', task: { taskPath: 'tasks/old.md' } } });
    await worker.processVerification({ id: 'evt-2', payload: { mode: 'coordination-verification', task: {} } });
    assert.deepEqual(finished, ['evt-1:noop', 'evt-2:noop']);
  } finally {
    teardown(ctx);
  }
});

test('scoped delegate_to_worker is retired in favor of execution_start', async () => {
  const ctx = fixture();
  try {
    const scope: any = {
      allow: true,
      routeClasses: ['implement', 'fix'],
      invocation: {
        moduleId: 'execute',
        binding: { contactId: 'muse', runner: 'opencode', model: 'x', reasoning: 'high' },
        revision: 1,
        permissions: { write: true, shell: true, ssh: false },
        taskPath: 'tasks/legacy.md',
        workspace: ctx.dir,
      },
    };
    const tool = buildDelegateTools(ctx.jobs, ctx.db, 'muse', { workspaces: [ctx.dir] } as any, 'room-handoff', undefined, scope)
      .find((entry) => entry.name === 'delegate_to_worker')!;
    const result = await tool.exec({ route_class: 'implement', workspace: ctx.dir, prompt: 'anything' } as never);
    assert.equal(result.ok, false);
    assert.match(result.text, /execution_start/);
    assert.equal((ctx.db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c, 0);
  } finally {
    teardown(ctx);
  }
});

test('legacy blocked attempt continues explicitly via import without rewriting its failure', async () => {
  const ctx = fixture();
  try {
    // A legacy attempt stuck at the old waiting_review gate.
    const legacy = ctx.jobs.create({
      requestedBy: 'muse', runner: 'opencode', workspace: ctx.dir, prompt: '旧链路留下的实现',
      permissions: { write: true, shell: true, ssh: false },
      options: { routeClass: 'implement', taskPath: 'tasks/legacy-continue.md' },
      originContactId: 'room-handoff', originAnchorId: ctx.anchor,
    });
    assert.ok(!('error' in legacy));
    ctx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(legacy.job.id);
    const done = ctx.jobs.complete(ctx.jobs.get(legacy.job.id)!, 'blocked', 'stuck at old gate', null,
      'blocked_unpushed', JSON.stringify({ declared: { stage: 'waiting_review' } }));
    assert.ok(!('error' in done));

    const planCtx: RoomTaskToolContext = { roomId: 'room-handoff', moduleId: 'plan' };
    const toolsFor = (contact: string, toolCtx: RoomTaskToolContext | null) =>
      buildRoomTaskTools(ctx.db, ctx.jobs, contact, null, {}, toolCtx);
    // Origin-turn fixture: direct calls run inside a server-created turn so
    // the store's exact-nonce gate validates, like production turns.
    const call = async (contact: string, toolCtx: RoomTaskToolContext | null, name: string, args: Record<string, unknown>) => {
      if (!toolCtx) {
        const out = await toolsFor(contact, toolCtx).find((t) => t.name === name)!.exec(args);
        assert.equal(out.ok, true, `${name} failed: ${out.text.slice(0, 300)}`);
        return JSON.parse(out.text);
      }
      const { beginRoomTurn, endRoomTurn } = await import('../src/roomTasks/turnAttribution.js');
      const turn = beginRoomTurn(ctx.db, {
        roomId: toolCtx.roomId,
        contactId: contact,
        moduleId: toolCtx.moduleId,
        ...(toolCtx.taskId ? { taskId: toolCtx.taskId } : {}),
        ...(toolCtx.handoffId ? { handoffId: toolCtx.handoffId } : {}),
      });
      try {
        const out = await toolsFor(contact, { ...toolCtx, turnId: turn.turnId }).find((t) => t.name === name)!.exec(args);
        assert.equal(out.ok, true, `${name} failed: ${out.text.slice(0, 300)}`);
        return JSON.parse(out.text);
      } finally {
        endRoomTurn(ctx.db, turn.turnId, 'test');
      }
    };
    const imported = await call('codex', planCtx, 'task_import', {
      room_id: 'room-handoff', task_path: 'tasks/legacy-continue.md',
      requirements: '旧任务需求（Vault 读不到时由调用方提供）。',
      anchor_message_id: ctx.anchor,
    });
    assert.deepEqual(imported.attached, [legacy.job.id]);
    // The old failure row is preserved verbatim.
    const preserved = ctx.jobs.get(legacy.job.id)!;
    assert.equal(preserved.status, 'blocked');
    assert.equal(preserved.delivery_state, 'blocked_unpushed');
    // Explicit continuation: plan -> execute handoff, accept, execution_start.
    const handoff = await call('codex', planCtx, 'task_handoff', {
      room_id: 'room-handoff', task_path: 'tasks/legacy-continue.md', actor_module: 'plan',
      to_module: 'execute', request: '从旧尝试继续', evidence_refs: [legacy.job.id],
    });
    const execCtx: RoomTaskToolContext = {
      roomId: 'room-handoff', moduleId: 'execute', taskId: imported.task.id, handoffId: handoff.handoff.id,
    };
    const accepted = await call('muse', execCtx, 'task_accept', {
      room_id: 'room-handoff', task_path: 'tasks/legacy-continue.md',
    });
    const started = await call('muse', execCtx, 'execution_start', {
      room_id: 'room-handoff', task_path: 'tasks/legacy-continue.md', module: 'execute',
      expected_revision: accepted.task.revision, workspace: ctx.dir,
      objective: '继续完成', return_to_module: 'plan',
    });
    assert.ok(started.job.id !== legacy.job.id);
    const store = new RoomTaskStore(ctx.db, ctx.jobs, null);
    assert.ok(store.linkedJobs(imported.task.id).some((job) => job.id === started.job.id));
    console.log('plan dispatch migration tests: ok');
  } finally {
    teardown(ctx);
  }
});
