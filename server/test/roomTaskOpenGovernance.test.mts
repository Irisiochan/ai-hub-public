// O1+O2: open-governance switch, ledger fields, task_pass/block/done.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { RoomTaskStore, taskDispatchLedgerStatus, markTaskDispatch } from '../src/roomTasks/roomTaskStore.js';
import { createRoomTaskDispatcher } from '../src/runtime/roomTaskDispatch.js';
import { AgentManager } from '../src/runtime/manager.js';
import { isOpenGovernance, parseRoomGovernance } from '../src/workflow/workflowModules.js';
import { JobStore } from '../src/jobs/jobStore.js';
import type { SseHub } from '../src/platform/sse.js';

function setup(governance?: string, extraConfig?: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-open-o1-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const jobs = new JobStore(db, { broadcast: () => {} } as unknown as SseHub);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(id, id, backend);
  }
  const cfg: Record<string, unknown> = { workflowEnabled: true, members: ['codex', 'muse', 'aye'], ...(extraConfig ?? {}) };
  if (governance !== undefined) cfg.governance = governance;
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('r1', 'r1', 'room', 'room', ?)")
    .run(JSON.stringify(cfg));
  const anchor = Number(db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
    VALUES ('r1', 'user', 'user', 'text', 'ok', 'done', '{}', 'main')`).run().lastInsertRowid);
  const store = new RoomTaskStore(db, jobs, null);
  return { dir, db, jobs, store, anchor };
}

test('O1: governance defaults to strict, open opt-in only', () => {
  assert.equal(parseRoomGovernance({}), 'strict');
  assert.equal(parseRoomGovernance({ governance: 'open' }), 'open');
  assert.equal(parseRoomGovernance({ governance: 'weird' }), 'strict');
  assert.equal(isOpenGovernance({ governance: 'open' }), true);
  assert.equal(isOpenGovernance({}), false);
});

test('O1: strict room reports strict, open room reports open', async (t) => {
  const a = setup();
  t.after(() => { a.db.close(); fs.rmSync(a.dir, { recursive: true, force: true }); });
  assert.equal(a.store.getRoomGovernance('r1'), 'strict');
  assert.equal(a.store.isOpenGovernance('r1'), false);
  const b = setup('open');
  t.after(() => { b.db.close(); fs.rmSync(b.dir, { recursive: true, force: true }); });
  assert.equal(b.store.getRoomGovernance('r1'), 'open');
  assert.equal(b.store.isOpenGovernance('r1'), true);
});

test('O1: new ledger columns exist with defaults, holder mirrors owner', async (t) => {
  const { dir, db, jobs, anchor } = setup('open');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO workers (id, name, token_hash, capabilities, status, accepting_jobs) VALUES ('w1', 'w1', 'x', ?, 'online', 1)")
    .run(JSON.stringify({ workspaces: [dir] }));
  const dispatch = { dispatchToModule: () => ({ status: 'posted' as const }) };
  const ctx = { roomId: 'r1', moduleId: 'plan' } as const;
  const turn = beginRoomTurn(db, { ...ctx, contactId: 'codex' });
  try {
    const tool = buildRoomTaskTools(db, jobs, 'codex', dispatch, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === 'task_create')!;
    const result = await tool.exec({ room_id: 'r1', task_path: 'tasks/o1.md', title: 'O1', requirements: 'req', workspace: dir, anchor_message_id: anchor });
    assert.equal(result.ok, true, result.text);
    const created = JSON.parse(result.text) as { task: Record<string, unknown> };
    assert.equal(created.task.holder_module, 'plan');
    assert.equal(created.task.next_module, null);
    assert.equal(created.task.wake_count, 0);
    assert.equal(created.task.wake_count_date, null);
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
});

async function createTask(fx: ReturnType<typeof setup>, taskPath = 'tasks/o2.md') {
  const { db, jobs, anchor, dir } = fx;
  db.prepare("INSERT OR IGNORE INTO workers (id, name, token_hash, capabilities, status, accepting_jobs) VALUES ('w1', 'w1', 'x', ?, 'online', 1)")
    .run(JSON.stringify({ workspaces: [dir] }));
  const wakes: string[] = [];
  const dispatch = {
    dispatchToModule: (_room: string, module: string) => {
      wakes.push(module);
      return { status: 'posted' as const };
    },
  };
  const ctx = { roomId: 'r1', moduleId: 'plan' } as const;
  const turn = beginRoomTurn(db, { ...ctx, contactId: 'codex' });
  try {
    const tool = buildRoomTaskTools(db, jobs, 'codex', dispatch, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === 'task_create')!;
    const result = await tool.exec({ room_id: 'r1', task_path: taskPath, title: 'O2', requirements: 'req', workspace: dir, anchor_message_id: anchor });
    assert.equal(result.ok, true, result.text);
    return { dispatch, wakes };
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

async function passAs(fx: ReturnType<typeof setup>, dispatch: unknown, moduleId: string, contactId: string, toModule: string, allowed = true, taskPath = 'tasks/o2.md') {
  const { db, jobs } = fx;
  const ctx = { roomId: 'r1', moduleId } as const;
  const turn = beginRoomTurn(db, { ...ctx, contactId });
  try {
    const tool = buildRoomTaskTools(db, jobs, contactId, dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === 'task_pass')!;
    const result = await tool.exec({ room_id: 'r1', task_path: taskPath, to_module: toModule, note: `pass to ${toModule}` });
    assert.equal(result.ok, allowed, result.text);
    return result;
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

test('O2: task_pass moves holder without accept, wakes live binding', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch, wakes } = await createTask(fx);
  const result = await passAs(fx, dispatch, 'plan', 'codex', 'execute');
  const body = JSON.parse(result.text) as { task: { holder_module: string; owner_module: string; owner_contact: string }; queued: boolean };
  assert.equal(body.task.holder_module, 'execute');
  assert.equal(body.task.owner_module, 'execute');
  assert.equal(body.task.owner_contact, 'muse');
  assert.equal(body.queued, false);
  assert.deepEqual(wakes, ['execute']);
});

test('O2: task_pass refused in strict rooms', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await createTask(fx);
  const dispatch = { dispatchToModule: () => ({ status: 'posted' as const }) };
  const result = await passAs(fx, dispatch, 'plan', 'codex', 'execute', false);
  assert.match(result.text, /仅在 open/);
});

test('O2: soft lease — any seat can take the baton, no 403', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch } = await createTask(fx);
  await passAs(fx, dispatch, 'plan', 'codex', 'execute');
  // review seat (aye) takes it directly without holding it first.
  const result = await passAs(fx, dispatch, 'execute', 'muse', 'review');
  const body = JSON.parse(result.text) as { task: { holder_module: string } };
  assert.equal(body.task.holder_module, 'review');
});

test('O2: autoPassUnfinished returns baton to plan', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch } = await createTask(fx);
  await passAs(fx, dispatch, 'plan', 'codex', 'execute');
  const store = new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  const taskId = 'r1::tasks/o2.md';
  const done = store.autoPassUnfinished(taskId, 'muse', 'execute', 'last text summary');
  assert.ok(done);
  assert.equal(done.task.holder_module, 'plan');
  const events = fx.db.prepare("SELECT kind FROM room_task_events WHERE task_id = ? ORDER BY id DESC LIMIT 2").all(taskId) as Array<{ kind: string }>;
  assert.ok(events.some((e) => e.kind === 'auto-pass'));
});

test('O2: execution_start works after task_pass without accept', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch } = await createTask(fx);
  await passAs(fx, dispatch, 'plan', 'codex', 'execute');
  const store = new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  const task = store.getTask('r1', 'tasks/o2.md')!;
  const ctx = { roomId: 'r1', moduleId: 'execute' } as const;
  const turn = beginRoomTurn(fx.db, { ...ctx, contactId: 'muse' });
  try {
    const tool = buildRoomTaskTools(fx.db, fx.jobs, 'muse', dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === 'execution_start')!;
    const result = await tool.exec({
      room_id: 'r1', task_path: 'tasks/o2.md', module: 'execute',
      expected_revision: task.revision, workspace: fx.dir, objective: 'implement it',
    });
    assert.equal(result.ok, true, result.text);
  } finally {
    endRoomTurn(fx.db, turn.turnId, 'test');
  }
});

test('O3: expired turn still reads in open rooms, refused in strict', async (t) => {
  const openFx = setup('open');
  t.after(() => { openFx.db.close(); fs.rmSync(openFx.dir, { recursive: true, force: true }); });
  await createTask(openFx, 'tasks/o3.md');
  const strictFx = setup();
  t.after(() => { strictFx.db.close(); fs.rmSync(strictFx.dir, { recursive: true, force: true }); });
  await createTask(strictFx, 'tasks/o3.md');
  // Begin + end a turn so its nonce is stale, then reuse the stale turnId.
  const staleOpen = beginRoomTurn(openFx.db, { roomId: 'r1', moduleId: 'plan', contactId: 'codex' });
  endRoomTurn(openFx.db, staleOpen.turnId, 'test');
  const openTool = buildRoomTaskTools(openFx.db, openFx.jobs, 'codex', null, { readVaultTask: () => null },
    { roomId: 'r1', moduleId: 'plan', turnId: staleOpen.turnId }).find((i) => i.name === 'task_get')!;
  const openRes = await openTool.exec({ room_id: 'r1', task_path: 'tasks/o3.md' });
  assert.equal(openRes.ok, true, openRes.text);
  const staleStrict = beginRoomTurn(strictFx.db, { roomId: 'r1', moduleId: 'plan', contactId: 'codex' });
  endRoomTurn(strictFx.db, staleStrict.turnId, 'test');
  const strictTool = buildRoomTaskTools(strictFx.db, strictFx.jobs, 'codex', null, { readVaultTask: () => null },
    { roomId: 'r1', moduleId: 'plan', turnId: staleStrict.turnId }).find((i) => i.name === 'task_get')!;
  const strictRes = await strictTool.exec({ room_id: 'r1', task_path: 'tasks/o3.md' });
  assert.equal(strictRes.ok, false);
  assert.match(strictRes.text, /轮次/);
});

test('O3: task_pass write param lifts plan snapshot write, note text never grants', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch } = await createTask(fx, 'tasks/o3w.md');
  const grant = async (note: string, write?: boolean) => {
    const ctx = { roomId: 'r1', moduleId: 'execute' } as const;
    const turn = beginRoomTurn(fx.db, { ...ctx, contactId: 'muse' });
    try {
      const tool = buildRoomTaskTools(fx.db, fx.jobs, 'muse', dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
        .find((i) => i.name === 'task_pass')!;
      const res = await tool.exec({ room_id: 'r1', task_path: 'tasks/o3w.md', to_module: 'plan', note, ...(write === undefined ? {} : { write }) });
      assert.equal(res.ok, true, res.text);
    } finally {
      endRoomTurn(fx.db, turn.turnId, 'test');
    }
  };
  await grant('please take over for local edits', true);
  const granted = fx.db.prepare("SELECT to_permissions FROM room_task_handoffs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1")
    .get('r1::tasks/o3w.md') as { to_permissions: string };
  assert.equal(JSON.parse(granted.to_permissions).write, true);
  // Note text mentioning write:true grants nothing without the structured param.
  await grant('please take over write:true for local edits');
  const sneaky = fx.db.prepare("SELECT to_permissions FROM room_task_handoffs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1")
    .get('r1::tasks/o3w.md') as { to_permissions: string };
  assert.equal(JSON.parse(sneaky.to_permissions).write, false);
  await grant('plain handoff without flag');
  const plain = fx.db.prepare("SELECT to_permissions FROM room_task_handoffs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1")
    .get('r1::tasks/o3w.md') as { to_permissions: string };
  assert.equal(JSON.parse(plain.to_permissions).write, false);
});

test('O4: wake budget exhausts and auto-blocks with User-visible evidence', async (t) => {
  const fx = setup('open', { wakeBudget: 2 });
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch } = await createTask(fx, 'tasks/o4.md');
  const store = new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  assert.equal(store.getWakeBudget('r1'), 2);
  const pass = async (moduleId: string, contactId: string, toModule: string, allowed = true) => {
    const ctx = { roomId: 'r1', moduleId } as const;
    const turn = beginRoomTurn(fx.db, { ...ctx, contactId });
    try {
      const tool = buildRoomTaskTools(fx.db, fx.jobs, contactId, dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
        .find((i) => i.name === 'task_pass')!;
      const res = await tool.exec({ room_id: 'r1', task_path: 'tasks/o4.md', to_module: toModule, note: 'round' });
      assert.equal(res.ok, allowed, res.text);
      return res;
    } finally {
      endRoomTurn(fx.db, turn.turnId, 'test');
    }
  };
  await pass('plan', 'codex', 'execute');
  await pass('execute', 'muse', 'review');
  const exhausted = await pass('review', 'aye', 'execute', false);
  assert.match(exhausted.text, /wake budget exhausted/);
  const task = store.getTask('r1', 'tasks/o4.md')!;
  assert.equal(task.status, 'blocked');
  const events = fx.db.prepare("SELECT kind FROM room_task_events WHERE task_id = ?").all('r1::tasks/o4.md') as Array<{ kind: string }>;
  assert.ok(events.some((e) => e.kind === 'wake-budget-exhausted'));
  const notes = fx.db.prepare("SELECT body FROM room_task_evidence WHERE task_id = ? AND kind = 'note'").all('r1::tasks/o4.md') as Array<{ body: string }>;
  assert.ok(notes.some((n) => n.body.includes('wake budget exhausted')));
});

test('O4: default budget is 40 and wake counts accumulate per day', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await createTask(fx, 'tasks/o4b.md');
  const store = new RoomTaskStore(fx.db, fx.jobs, null);
  assert.equal(store.getWakeBudget('r1'), 40);
  assert.equal(store.countWakeOrBlock('r1::tasks/o4b.md', 'codex', 'test'), true);
  const task = store.getTask('r1', 'tasks/o4b.md')!;
  assert.equal(task.wake_count, 1);
  assert.equal(task.wake_count_date, RoomTaskStore.wakeDayBucket());
});

test('O5: stale merge report auto-passes back to execute with rebase note', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch } = await createTask(fx, 'tasks/o5.md');
  await passAs(fx, dispatch, 'plan', 'codex', 'merge', true, 'tasks/o5.md');
  const store = new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  const masterSha = 'c'.repeat(40);
  const staleJob = {
    id: 'merge-stale-1', requested_by: 'codex', status: 'failed',
    options: JSON.stringify({ closureKind: 'merge', roomTaskId: 'r1::tasks/o5.md' }),
    result: JSON.stringify({ ok: false, lane: 'merge', stale: true, masterSha, frozen: 'a'.repeat(40) }),
    error: null,
  } as unknown as Parameters<RoomTaskStore['autoPassMergeStale']>[1];
  assert.equal(store.autoPassMergeStale('r1::tasks/o5.md', staleJob, 'codex'), true);
  const task = store.getTask('r1', 'tasks/o5.md')!;
  assert.equal(task.holder_module, 'execute');
  const events = fx.db.prepare("SELECT kind FROM room_task_events WHERE task_id = ?").all('r1::tasks/o5.md') as Array<{ kind: string }>;
  assert.ok(events.some((e) => e.kind === 'merge-stale'));
  const pass = fx.db.prepare("SELECT payload FROM room_task_events WHERE task_id = ? AND kind = 'pass' ORDER BY rowid DESC LIMIT 1").get('r1::tasks/o5.md') as { payload: string };
  assert.match(pass.payload, new RegExp(masterSha.slice(0, 12)));
});

test('O5: stale merge report is ignored in strict rooms', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await createTask(fx, 'tasks/o5s.md');
  const store = new RoomTaskStore(fx.db, fx.jobs, null);
  const staleJob = {
    id: 'merge-stale-2', requested_by: 'codex', status: 'failed',
    options: JSON.stringify({ closureKind: 'merge', roomTaskId: 'r1::tasks/o5s.md' }),
    result: JSON.stringify({ ok: false, stale: true, masterSha: 'd'.repeat(40) }),
    error: null,
  } as unknown as Parameters<RoomTaskStore['autoPassMergeStale']>[1];
  assert.equal(store.autoPassMergeStale('r1::tasks/o5s.md', staleJob, 'codex'), false);
  assert.equal(store.getTask('r1', 'tasks/o5s.md')!.holder_module, 'plan');
});

async function callToolAs(
  fx: ReturnType<typeof setup>,
  contactId: string,
  moduleId: string,
  name: string,
  args: Record<string, unknown>,
  taskPath = 'tasks/ritual.md',
) {
  const { db, jobs } = fx;
  const turn = beginRoomTurn(db, { roomId: 'r1', moduleId, contactId });
  try {
    const tool = buildRoomTaskTools(db, jobs, contactId, null, { readVaultTask: () => null },
      { roomId: 'r1', moduleId, turnId: turn.turnId }).find((i) => i.name === name)!;
    return await tool.exec({ room_id: 'r1', task_path: taskPath, ...args });
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

test('open: strict rituals short-circuit to task_pass, never owner 403', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await createTask(fx, 'tasks/ritual.md');
  // A non-holder calling the retired ritual gets a 410 pointer, not a 403.
  const handoff = await callToolAs(fx, 'aye', 'review', 'task_handoff', { to_module: 'execute', request: 'do it' });
  assert.equal(handoff.ok, false, handoff.text);
  assert.match(handoff.text, /task_pass/);
  assert.doesNotMatch(handoff.text, /只有负责人/);
  const accept = await callToolAs(fx, 'muse', 'execute', 'task_accept', {});
  assert.equal(accept.ok, false, accept.text);
  assert.match(accept.text, /task_pass/);
  assert.doesNotMatch(accept.text, /点名|应答.*身份/);
  const decline = await callToolAs(fx, 'muse', 'execute', 'task_decline', {});
  assert.equal(decline.ok, false, decline.text);
  assert.match(decline.text, /task_pass/);
  // The baton never moved and no handoff row was created by the attempts.
  assert.equal(fx.store.getTask('r1', 'tasks/ritual.md')!.holder_module, 'plan');
  const rows = fx.db.prepare("SELECT COUNT(*) AS c FROM room_task_handoffs WHERE task_id = ?").get('r1::tasks/ritual.md') as { c: number };
  assert.equal(rows.c, 0);
});

test('strict: owner-only handoff 403 is unchanged', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await createTask(fx, 'tasks/ritual.md');
  const res = await callToolAs(fx, 'aye', 'review', 'task_handoff', { to_module: 'execute', request: 'do it' });
  assert.equal(res.ok, false, res.text);
  assert.match(res.text, /只有负责人/);
});

test('SHOULD-a: mention wakes count against the task budget in open rooms', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await createTask(fx, 'tasks/mention.md');
  const store = new RoomTaskStore(fx.db, fx.jobs, null);
  assert.equal(store.countMentionWake('r1', 'tasks/mention.md', 'User', 'execute'), true);
  assert.equal(store.getTask('r1', 'tasks/mention.md')!.wake_count, 1);
  // Unknown task paths are a no-op, never a throw.
  assert.equal(store.countMentionWake('r1', 'tasks/nope.md', 'User', 'execute'), true);
});

test('SHOULD-a: mention wakes do not count in strict rooms', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await createTask(fx, 'tasks/mention.md');
  const store = new RoomTaskStore(fx.db, fx.jobs, null);
  assert.equal(store.countMentionWake('r1', 'tasks/mention.md', 'User', 'execute'), true);
  assert.equal(store.getTask('r1', 'tasks/mention.md')!.wake_count, 0);
});

test('SHOULD-a2: @ direct wake without path counts against the held task budget', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await createTask(fx, 'tasks/held.md');
  await passAs(fx, { dispatchToModule: () => ({ status: 'posted' as const }) }, 'plan', 'codex', 'execute', true, 'tasks/held.md');
  const store = new RoomTaskStore(fx.db, fx.jobs, null);
  assert.equal(store.getTask('r1', 'tasks/held.md')!.holder_module, 'execute');
  // Held-task query surfaces the baton holder's open tasks.
  assert.deepEqual(store.openTasksHeldBy('r1', 'execute').map((row) => row.task_path), ['tasks/held.md']);
  assert.deepEqual(store.openTasksHeldBy('r1', 'plan').map((row) => row.task_path), []);
  // Pure colloquial @ wake with no task path still counts once.
  // (task_pass above already counted one wake; assert relative increments.)
  const manager = new AgentManager({ db: fx.db, jobStore: fx.jobs } as any);
  const before = store.getTask('r1', 'tasks/held.md')!.wake_count;
  (manager as any).countOpenDirectWake('r1', '@muse 继续', 'execute');
  assert.equal(store.getTask('r1', 'tasks/held.md')!.wake_count, before + 1);
  // Path + holder referencing the same task counts only once.
  (manager as any).countOpenDirectWake('r1', '@muse 看下 tasks/held.md', 'execute');
  assert.equal(store.getTask('r1', 'tasks/held.md')!.wake_count, before + 2);
});

test('SHOULD-a2: @ wake does not count tasks held by another module', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await createTask(fx, 'tasks/planhold.md');
  const store = new RoomTaskStore(fx.db, fx.jobs, null);
  assert.equal(store.getTask('r1', 'tasks/planhold.md')!.holder_module, 'plan');
  const manager = new AgentManager({ db: fx.db, jobStore: fx.jobs } as any);
  (manager as any).countOpenDirectWake('r1', '@muse 继续', 'execute');
  assert.equal(store.getTask('r1', 'tasks/planhold.md')!.wake_count, 0);
  // ...but the legacy explicit-path reference still counts.
  (manager as any).countOpenDirectWake('r1', '@muse 看下 tasks/planhold.md', 'execute');
  assert.equal(store.getTask('r1', 'tasks/planhold.md')!.wake_count, 1);
});

test('SHOULD-a2: openTasksHeldBy skips closed/dropped and falls back to owner', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await createTask(fx, 'tasks/gone.md');
  const store = new RoomTaskStore(fx.db, fx.jobs, null);
  fx.db.prepare("UPDATE room_tasks SET status = 'closed' WHERE id = ?").run('r1::tasks/gone.md');
  assert.deepEqual(store.openTasksHeldBy('r1', 'plan'), []);
  fx.db.prepare("UPDATE room_tasks SET status = 'dropped' WHERE id = ?").run('r1::tasks/gone.md');
  assert.deepEqual(store.openTasksHeldBy('r1', 'plan'), []);
  fx.db.prepare("UPDATE room_tasks SET status = 'open', holder_module = NULL WHERE id = ?").run('r1::tasks/gone.md');
  assert.deepEqual(store.openTasksHeldBy('r1', 'plan').map((row) => row.task_path), ['tasks/gone.md']);
});

// Deploy gate vs O5 worktree-safe merges (cc462645 class): the harness
// receipt branch stays on the working candidate branch because
// merge-close-job.ps1 never checks out master. The push proof is the merge
// script success report in the job result (emitted only after push +
// ls-remote verification). Old-style rows finished on master keep passing
// via the harness branch; rows with neither proof are still refused.
const O5_SHA = (ch: string) => ch.repeat(40);
const O5_H2 = O5_SHA('b');
const O5_BASE = O5_SHA('c');
const O5_MERGE_SUITES = [
  'server npm run pretest', 'server npm test', 'web npm test',
  'smoke:deploy-drain', 'smoke:turn-timeouts', 'smoke:deploy-resume',
].map((suite) => ({ suite, status: 'pass' as const }));

function o5ReceiptMeta(o: {
  branch: string; head: string; stage?: string;
  committed?: boolean; pushed?: boolean; tests?: Array<{ suite: string; status: 'pass' | 'fail' }>;
}) {
  return JSON.stringify({
    receipt: {
      branch: o.branch,
      head: o.head,
      diffstat: '2 files changed, 20 insertions(+)',
      changedFiles: { files: ['src/x.ts', 'src/y.ts'], total: 2 },
      tests: o.tests ?? [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: O5_BASE },
    declared: {
      stage: o.stage ?? 'delivered',
      committed: o.committed ?? false,
      pushed: o.pushed ?? false,
      summary: 'simulated o5 receipt',
    },
  });
}

function o5MergeScriptJson(head: string) {
  return JSON.stringify({
    ok: true, lane: 'merge', branch: 'master', head,
    baselineSha: O5_SHA('d'), claimedBaselineSha: O5_BASE,
    targetBranch: 'master', frozen: head,
    tests: O5_MERGE_SUITES,
  });
}

async function driveO5MergeToDeployRelease(
  fx: ReturnType<typeof setup>,
  dispatch: unknown,
  taskPath: string,
  mergeResultText: string,
) {
  const store = () => new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  await passAs(fx, dispatch, 'plan', 'codex', 'execute', true, taskPath);
  // Implement round on the working branch.
  let task = store().getTask('r1', taskPath)!;
  const execRes = await callToolAs(fx, 'muse', 'execute', 'execution_start', {
    module: 'execute', expected_revision: task.revision, workspace: fx.dir,
    objective: 'implement o5 gate proof', return_mode: 'notify', return_to_module: 'review',
  }, taskPath);
  assert.equal(execRes.ok, true, execRes.text);
  const execJobId = (JSON.parse(execRes.text) as { job: { id: string } }).job.id;
  fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(execJobId);
  const execDone = fx.jobs.complete(fx.jobs.get(execJobId)!, 'done', 'simulated done', null,
    'delivered', o5ReceiptMeta({ branch: 'wip-o5', head: O5_H2 }));
  assert.ok(!('error' in execDone), JSON.stringify(execDone));
  await passAs(fx, dispatch, 'execute', 'muse', 'review', true, taskPath);
  // Independent review APPROVE auto-passes to merge in open rooms.
  const reviewRes = await callToolAs(fx, 'aye', 'review', 'review_submit', {
    module: 'review', candidate_job_id: execJobId, candidate_sha: O5_H2,
    verdict: 'approve', findings: 'o5 gate proof approved', evidence_refs: [execJobId],
  }, taskPath);
  assert.equal(reviewRes.ok, true, reviewRes.text);
  task = store().getTask('r1', taskPath)!;
  assert.equal(task.holder_module, 'merge');
  assert.equal(task.owner_contact, 'codex');
  // Explicit merge release, then finish it O5-style: harness receipt branch
  // is the working branch, push proof lives in the result text.
  const mergeRes = await callToolAs(fx, 'codex', 'merge', 'release_execute', {
    kind: 'merge', return_mode: 'notify', return_to_module: 'deploy',
    expected_revision: task.revision,
  }, taskPath);
  assert.equal(mergeRes.ok, true, mergeRes.text);
  const mergeJobId = (JSON.parse(mergeRes.text) as { job: { id: string } }).job.id;
  fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(mergeJobId);
  const mergeDone = fx.jobs.complete(fx.jobs.get(mergeJobId)!, 'done', mergeResultText, null,
    'delivered', o5ReceiptMeta({
      branch: 'wip-o5', head: O5_H2, stage: 'delivered_waiting_deploy',
      committed: true, pushed: true, tests: O5_MERGE_SUITES,
    }));
  assert.ok(!('error' in mergeDone), JSON.stringify(mergeDone));
  await passAs(fx, dispatch, 'merge', 'codex', 'deploy', true, taskPath);
  task = store().getTask('r1', taskPath)!;
  return callToolAs(fx, 'codex', 'deploy', 'release_execute', {
    kind: 'deploy', return_mode: 'notify', return_to_module: 'plan',
    expected_revision: task.revision,
  }, taskPath);
}

test('deploy gate: O5 merge (working-branch receipt + script push proof) releases deploy', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch } = await createTask(fx, 'tasks/o5deploy.md');
  const res = await driveO5MergeToDeployRelease(fx, dispatch, 'tasks/o5deploy.md', [
    o5MergeScriptJson(O5_H2),
    JSON.stringify({ delivery: {
      committed: true, pushed: true, stage: 'delivered_waiting_deploy',
      summary: 'merge pushed frozen', nextOwner: 'harness-deploy',
    } }),
  ].join('\n'));
  assert.equal(res.ok, true, res.text);
  assert.match(res.text, /room-deploy-job\.ps1/);
});

test('deploy gate: merge with neither master receipt branch nor script proof is still refused', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch } = await createTask(fx, 'tasks/o5deploy-neg.md');
  const res = await driveO5MergeToDeployRelease(fx, dispatch, 'tasks/o5deploy-neg.md',
    JSON.stringify({ delivery: {
      committed: true, pushed: true, stage: 'delivered_waiting_deploy', summary: 'no script proof',
    } }));
  assert.equal(res.ok, false, res.text);
  assert.match(res.text, /合并回执缺/);
  assert.match(res.text, /git ls-remote origin refs\/heads\/master/);
});

// Open-mode callback baton (2026-09-17 first live run): a Worker job that
// finishes with a registered return_to must hand holder/owner to the return
// module and leave its completion handoff accepted, so the woken review turn
// can review_submit directly. A self task_pass that supersedes the pinned
// handoff must not strand the verdict either.
test('open: job completion callback moves the baton to return module and review_submit works on the pinned handoff', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const taskPath = 'tasks/cb.md';
  const { dispatch, wakes } = await createTask(fx, taskPath);
  await passAs(fx, dispatch, 'plan', 'codex', 'execute', true, taskPath);
  const store = () => new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  let task = store().getTask('r1', taskPath)!;
  const ctx = { roomId: 'r1', moduleId: 'execute' } as const;
  const turn = beginRoomTurn(fx.db, { ...ctx, contactId: 'muse' });
  let jobId = '';
  try {
    const tool = buildRoomTaskTools(fx.db, fx.jobs, 'muse', dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === 'execution_start')!;
    const result = await tool.exec({
      room_id: 'r1', task_path: taskPath, module: 'execute',
      expected_revision: task.revision, workspace: fx.dir, objective: 'implement', return_to_module: 'review',
    });
    assert.equal(result.ok, true, result.text);
    jobId = (JSON.parse(result.text) as { job: { id: string } }).job.id;
  } finally {
    endRoomTurn(fx.db, turn.turnId, 'test');
  }
  fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
  const done = fx.jobs.complete(fx.jobs.get(jobId)!, 'done', 'simulated done', null,
    'delivered', o5ReceiptMeta({ branch: 'wip-cb', head: O5_H2 }));
  assert.ok(!('error' in done), JSON.stringify(done));
  wakes.length = 0;
  const handled = store().handleJobFinished(fx.jobs.get(jobId)!, { finalAttempt: true, actor: 'muse' });
  assert.equal(handled.handled, true);
  task = store().getTask('r1', taskPath)!;
  assert.equal(task.holder_module, 'review', 'callback hands the baton to the return module');
  assert.equal(task.owner_module, 'review');
  assert.equal(task.owner_contact, 'aye');
  assert.equal(task.active_handoff_id, null);
  assert.deepEqual(wakes, ['review'], 'the return module is woken exactly once');
  const handoff = fx.db.prepare(
    "SELECT id, status, to_module, to_contact FROM room_task_handoffs WHERE idempotency_key = ?",
  ).get(`completion-handoff:v1:${jobId}`) as { id: string; status: string; to_module: string; to_contact: string };
  assert.equal(handoff.status, 'accepted');
  assert.equal(handoff.to_module, 'review');
  assert.equal(handoff.to_contact, 'aye');
  const events = fx.db.prepare("SELECT kind FROM room_task_events WHERE task_id = ? ORDER BY id").all(task.id) as Array<{ kind: string }>;
  assert.ok(events.some((e) => e.kind === 'callback-pass'));

  // The woken review turn carries the pinned handoff and submits directly.
  const rctx = { roomId: 'r1', moduleId: 'review', taskId: task.id, handoffId: handoff.id } as const;
  const rturn = beginRoomTurn(fx.db, { roomId: 'r1', moduleId: 'review', contactId: 'aye', taskId: task.id, handoffId: handoff.id });
  try {
    const tools = buildRoomTaskTools(fx.db, fx.jobs, 'aye', dispatch as never, { readVaultTask: () => null }, { ...rctx, turnId: rturn.turnId });
    // Even a redundant self task_pass (which supersedes pending rows) must not strand the verdict.
    const pass = await tools.find((item) => item.name === 'task_pass')!.exec({ room_id: 'r1', task_path: taskPath, to_module: 'review', note: 'self pass' });
    assert.equal(pass.ok, true, pass.text);
    const verdict = await tools.find((item) => item.name === 'review_submit')!.exec({
      room_id: 'r1', task_path: taskPath, module: 'review', candidate_job_id: jobId, candidate_sha: O5_H2,
      verdict: 'request_changes', findings: 'needs exit codes', evidence_refs: [jobId],
    });
    assert.equal(verdict.ok, true, verdict.text);
  } finally {
    endRoomTurn(fx.db, rturn.turnId, 'test');
  }
  task = store().getTask('r1', taskPath)!;
  assert.equal(task.review_status, 'changes_requested');
  assert.equal(task.holder_module, 'execute', 'REQUEST_CHANGES auto-passes to execute');
});

test('open: a second job under the same baton still wakes the return module after its sibling moved the baton', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const taskPath = 'tasks/sibling.md';
  const { dispatch, wakes } = await createTask(fx, taskPath);
  await passAs(fx, dispatch, 'plan', 'codex', 'execute', true, taskPath);
  const store = () => new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  const ctx = { roomId: 'r1', moduleId: 'execute' } as const;
  const turn = beginRoomTurn(fx.db, { ...ctx, contactId: 'muse' });
  const jobIds: string[] = [];
  try {
    const tool = buildRoomTaskTools(fx.db, fx.jobs, 'muse', dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === 'execution_start')!;
    // 2026-09-19: a read-only round started by mistake, then the intended writable one.
    for (const write of [false, true]) {
      const result = await tool.exec({
        room_id: 'r1', task_path: taskPath, module: 'execute',
        expected_revision: store().getTask('r1', taskPath)!.revision, workspace: fx.dir,
        objective: write ? 'rerun the checks' : 'collect evidence', return_to_module: 'review', write, shell: true,
      });
      assert.equal(result.ok, true, result.text);
      jobIds.push((JSON.parse(result.text) as { job: { id: string } }).job.id);
    }
  } finally {
    endRoomTurn(fx.db, turn.turnId, 'test');
  }
  const finish = (jobId: string) => {
    fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
    const done = fx.jobs.complete(fx.jobs.get(jobId)!, 'done', 'simulated done', null,
      'delivered', o5ReceiptMeta({ branch: 'wip-sibling', head: O5_H2 }));
    assert.ok(!('error' in done), JSON.stringify(done));
    return store().handleJobFinished(fx.jobs.get(jobId)!, { finalAttempt: false, actor: 'muse' });
  };
  wakes.length = 0;
  assert.equal(finish(jobIds[0]).handled, true);
  assert.equal(store().getTask('r1', taskPath)!.holder_module, 'review');
  // The reviewer is now waiting for the second receipt; it must arrive.
  assert.equal(finish(jobIds[1]).handled, true);
  assert.deepEqual(wakes, ['review', 'review']);
  const task = store().getTask('r1', taskPath)!;
  assert.equal(task.holder_module, 'review', 'the receipt does not move the baton again');
  const delivered = fx.db.prepare(`SELECT json_extract(payload, '$.jobId') AS jobId FROM room_task_events
    WHERE task_id = ? AND kind = 'callback-delivered' ORDER BY id`).all(task.id) as Array<{ jobId: string }>;
  assert.deepEqual(delivered.map((row) => row.jobId), jobIds);
});

test('open: a completion callback refused because the baton went elsewhere leaves one ledger trace', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const taskPath = 'tasks/refused.md';
  const { dispatch, wakes } = await createTask(fx, taskPath);
  await passAs(fx, dispatch, 'plan', 'codex', 'execute', true, taskPath);
  const store = () => new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  const ctx = { roomId: 'r1', moduleId: 'execute' } as const;
  const turn = beginRoomTurn(fx.db, { ...ctx, contactId: 'muse' });
  const jobIds: string[] = [];
  try {
    const tool = buildRoomTaskTools(fx.db, fx.jobs, 'muse', dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === 'execution_start')!;
    for (const write of [false, true]) {
      const result = await tool.exec({
        room_id: 'r1', task_path: taskPath, module: 'execute',
        expected_revision: store().getTask('r1', taskPath)!.revision, workspace: fx.dir,
        objective: 'round', return_to_module: 'review', write, shell: true,
      });
      assert.equal(result.ok, true, result.text);
      jobIds.push((JSON.parse(result.text) as { job: { id: string } }).job.id);
    }
  } finally {
    endRoomTurn(fx.db, turn.turnId, 'test');
  }
  const finish = (jobId: string) => {
    fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
    fx.jobs.complete(fx.jobs.get(jobId)!, 'done', 'simulated done', null,
      'delivered', o5ReceiptMeta({ branch: 'wip-refused', head: O5_H2 }));
    return () => store().handleJobFinished(fx.jobs.get(jobId)!, { finalAttempt: false, actor: 'muse' });
  };
  finish(jobIds[0])();
  // Review hands the task on before the second job lands: the baton is no longer at review.
  fx.db.prepare("UPDATE room_tasks SET holder_module = 'plan', owner_module = 'plan', owner_contact = 'codex' WHERE room_id = 'r1' AND task_path = ?").run(taskPath);
  wakes.length = 0;
  const late = finish(jobIds[1]);
  assert.throws(late);
  assert.throws(late, 'retries keep failing the same way');
  assert.deepEqual(wakes, []);
  const task = store().getTask('r1', taskPath)!;
  const failed = fx.db.prepare(`SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ? AND kind = 'callback-failed'
    AND json_extract(payload, '$.jobId') = ?`).get(task.id, jobIds[1]) as { c: number };
  assert.equal(failed.c, 1, 'one visible trace, not one per retry');
});

test('strict: job completion callback leaves the baton with execute (accept still required)', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const taskPath = 'tasks/cb-strict.md';
  const { dispatch } = await createTask(fx, taskPath);
  const handoff = await callToolAs(fx, 'codex', 'plan', 'task_handoff', { to_module: 'execute', request: 'do it' }, taskPath);
  assert.equal(handoff.ok, true, handoff.text);
  const accept = await callToolAs(fx, 'muse', 'execute', 'task_accept', {}, taskPath);
  assert.equal(accept.ok, true, accept.text);
  const store = () => new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  const task = store().getTask('r1', taskPath)!;
  const start = await callToolAs(fx, 'muse', 'execute', 'execution_start', {
    module: 'execute', expected_revision: task.revision, workspace: fx.dir, objective: 'implement', return_to_module: 'review',
  }, taskPath);
  assert.equal(start.ok, true, start.text);
  const jobId = (JSON.parse(start.text) as { job: { id: string } }).job.id;
  fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
  fx.jobs.complete(fx.jobs.get(jobId)!, 'done', 'simulated done', null, 'delivered', o5ReceiptMeta({ branch: 'wip', head: O5_H2 }));
  store().handleJobFinished(fx.jobs.get(jobId)!, { finalAttempt: true, actor: 'muse' });
  const after = store().getTask('r1', taskPath)!;
  assert.equal(after.owner_module, 'execute', 'strict rooms keep the accept ritual');
  const row = fx.db.prepare("SELECT status FROM room_task_handoffs WHERE idempotency_key = ?").get(`completion-handoff:v1:${jobId}`) as { status: string };
  assert.equal(row.status, 'pending');
});

// ── WP-B B1: turn-end auto-pass must really wake the recipient ──────────
// Production (room cmrhxny03, 2026-09-17): pass-delivered + ledger posted,
// but the plan seat started no round for minutes. These tests pin the
// recovery loop: deferred delivery, handoff-key mirroring for task_retry,
// and posted→failed flips when the recipient turn never starts.

async function setupB1Task(fx: ReturnType<typeof setup>, taskPath = 'tasks/b1.md') {
  const { dispatch } = await createTask(fx, taskPath);
  await passAs(fx, dispatch, 'plan', 'codex', 'execute', true, taskPath);
  return { dispatch };
}

test('B1: autoPassUnfinished defers delivery until flushDeferredPass', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await setupB1Task(fx);
  const wakes: Array<{ module: string; contact: string }> = [];
  const dispatch = {
    dispatchToModule: (_room: string, module: string, contact: string) => {
      wakes.push({ module, contact });
      return { status: 'posted' as const };
    },
  };
  const store = new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  const taskId = 'r1::tasks/b1.md';
  const done = store.autoPassUnfinished(taskId, 'muse', 'execute', 'last text summary', { deferDelivery: true });
  assert.ok(done, 'baton still moves under deferral');
  assert.equal(done.task.holder_module, 'plan');
  assert.deepEqual(wakes, [], 'no wake leaves while the initiator turn is finalizing');
  const delivered = fx.db.prepare("SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ? AND kind = 'auto-pass-delivered'").get(taskId) as { c: number };
  assert.equal(delivered.c, 0, 'delivery event fires at flush, not at baton move');
  const flushed = store.flushDeferredPass();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].status, 'posted');
  assert.deepEqual(wakes, [{ module: 'plan', contact: 'codex' }]);
  const events = fx.db.prepare("SELECT kind, payload FROM room_task_events WHERE task_id = ? AND kind LIKE 'auto-pass%' ORDER BY id").all(taskId) as Array<{ kind: string; payload: string }>;
  assert.ok(events.some((e) => e.kind === 'auto-pass'), 'baton-move marker still logged');
  const deliveredEv = events.find((e) => e.kind === 'auto-pass-delivered');
  assert.ok(deliveredEv, 'flush logs auto-pass-delivered');
  assert.match(deliveredEv.payload, /"source":"auto-pass"/);
});

test('B1: auto-pass delivery mirrors the handoff ledger key for task_retry', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await setupB1Task(fx);
  const dispatch = { dispatchToModule: () => ({ status: 'posted' as const }) };
  const store = new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  const taskId = 'r1::tasks/b1.md';
  assert.ok(store.autoPassUnfinished(taskId, 'muse', 'execute', 'summary'));
  const pass = fx.db.prepare(
    "SELECT id FROM room_task_handoffs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
  ).get(taskId) as { id: string };
  assert.ok(pass?.id, 'auto-pass leaves an accepted pass row');
  assert.equal(
    taskDispatchLedgerStatus(fx.db, `task-handoff:v1:${pass.id}`),
    'posted',
    'pass delivery mirrors the durable handoff key',
  );
});

test('B1: task_retry redelivers a never-started auto-pass to the same recipient', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await setupB1Task(fx);
  const wakes: Array<{ module: string; contact: string }> = [];
  const dispatch = {
    dispatchToModule: (_room: string, module: string, contact: string) => {
      wakes.push({ module, contact });
      return { status: 'posted' as const };
    },
  };
  const store = new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  const taskId = 'r1::tasks/b1.md';
  assert.ok(store.autoPassUnfinished(taskId, 'muse', 'execute', 'summary'));
  wakes.length = 0;
  const pass = fx.db.prepare(
    "SELECT id FROM room_task_handoffs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
  ).get(taskId) as { id: string };
  // Simulate the B1 never-started flip: posted but the recipient round ran nothing.
  const afterPass = store.getTask('r1', 'tasks/b1.md')!;
  const passKey = `task-pass:v1:${taskId}:${afterPass.revision}`;
  markTaskDispatch(fx.db, passKey, 'handoff', 'failed', null, 'codex', 'recipient turn never started; explicit retry available');
  markTaskDispatch(fx.db, `task-handoff:v1:${pass.id}`, 'handoff', 'failed', null, 'codex', 'recipient turn never started; explicit retry available');
  const turn = beginRoomTurn(fx.db, { roomId: 'r1', moduleId: 'plan', contactId: 'codex' });
  try {
    const tool = buildRoomTaskTools(fx.db, fx.jobs, 'codex', dispatch as never, { readVaultTask: () => null },
      { roomId: 'r1', moduleId: 'plan', turnId: turn.turnId }).find((i) => i.name === 'task_retry')!;
    const res = await tool.exec({ room_id: 'r1', handoff_id: pass.id });
    assert.equal(res.ok, true, res.text);
  } finally {
    endRoomTurn(fx.db, turn.turnId, 'test');
  }
  assert.deepEqual(wakes, [{ module: 'plan', contact: 'codex' }], 'retry wakes the same captured recipient');
  assert.equal(store.getTask('r1', 'tasks/b1.md')!.holder_module, 'plan', 'retry never moves the baton');
});

test('B1: silent completion flips a posted pass dispatch to failed, spoke keeps posted', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-b1-flip-'));
  const db = openDb(path.join(dir, 'hub.db'));
  t.after(() => { try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); });
  const sse = { broadcast: () => {} } as unknown as import('../src/platform/sse.js').SseHub;
  const jobs = new JobStore(db, sse);
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('codex', 'codex', 'codex', 'dm', '{}')").run();
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('r9', 'r9', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, governance: 'open', members: ['codex'] }));
  const completions = new Map<string, Promise<unknown>>();
  const stubManager = {
    imageRoomMembers: () => [{ id: 'codex', name: 'codex' }],
    dispatchRoomMessageTracked: (_r: unknown, content: string) => {
      const silent = String(content).includes('silent-recipient');
      const completion = Promise.resolve(
        silent
          ? { normal: { spoke: 0, passed: 0, silent: 1, error: 0 }, reactions: [] }
          : { normal: { spoke: 1, passed: 0, silent: 0, error: 0 }, reactions: [] },
      );
      completions.set(String(content), completion);
      return { targets: ['codex'], completion };
    },
  };
  const dispatcher = createRoomTaskDispatcher({ db, sse, manager: stubManager as never });
  const lost = dispatcher.dispatchToModule('r9', 'plan', 'codex', 'silent-recipient [task-pass]', 'task-pass:v1:lost:9', { taskId: 'lost' });
  assert.equal(lost.status, 'posted');
  await completions.get('silent-recipient [task-pass]')!;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(taskDispatchLedgerStatus(db, 'task-pass:v1:lost:9'), 'failed', 'never-started round flips to failed');
  const detail = (db.prepare('SELECT detail FROM room_task_dispatches WHERE idempotency_key = ?').get('task-pass:v1:lost:9') as { detail: string }).detail;
  assert.match(detail, /recipient turn never started/);
  const kept = dispatcher.dispatchToModule('r9', 'plan', 'codex', 'live-recipient [task-pass]', 'task-pass:v1:kept:9', { taskId: 'kept' });
  assert.equal(kept.status, 'posted');
  await completions.get('live-recipient [task-pass]')!;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(taskDispatchLedgerStatus(db, 'task-pass:v1:kept:9'), 'posted', 'a started round stays posted');
});

async function passAutoStartAs(fx: ReturnType<typeof setup>, dispatch: unknown, moduleId: string, contactId: string, args: Record<string, unknown>, allowed = true, taskPath = 'tasks/o2.md') {
  const { db, jobs } = fx;
  const ctx = { roomId: 'r1', moduleId } as const;
  const turn = beginRoomTurn(db, { ...ctx, contactId });
  try {
    const tool = buildRoomTaskTools(db, jobs, contactId, dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === 'task_pass')!;
    const result = await tool.exec({ room_id: 'r1', task_path: taskPath, ...args });
    assert.equal(result.ok, allowed, result.text);
    return result;
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

test('P2: task_pass auto_start builds a job with no execute chat wake', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch, wakes } = await createTask(fx);
  const store = new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  const rev = store.getTask('r1', 'tasks/o2.md')!.revision;
  const result = await passAutoStartAs(fx, dispatch, 'plan', 'codex', {
    to_module: 'execute', note: 'implement it', auto_start: true, expected_revision: rev, objective: 'implement it',
  });
  const body = JSON.parse(result.text) as {
    task: { holder_module: string; owner_contact: string };
    job: { id: string }; delivery: { status: string }; queued: boolean;
  };
  assert.equal(body.task.holder_module, 'execute');
  assert.equal(body.task.owner_contact, 'muse');
  assert.equal(body.queued, false);
  assert.ok(body.job.id, 'auto_start returns the started job');
  assert.equal(body.delivery.status, 'posted');
  assert.deepEqual(wakes, [], 'no execute chat seat is woken');
  const job = fx.jobs.get(body.job.id)!;
  const options = JSON.parse(job.options) as Record<string, unknown>;
  assert.equal((options.roomTaskHandoffId as string) && typeof options.roomTaskHandoffId, 'string');
  assert.equal(Boolean(options.handoffAutoStart), true);
  const accepted = fx.db.prepare("SELECT payload FROM room_task_events WHERE task_id = ? AND kind = 'pass-auto-accepted'").get('r1::tasks/o2.md') as { payload: string };
  assert.ok(accepted, 'pass-auto-accepted event is recorded');
  assert.equal((JSON.parse(accepted.payload) as { toContact: string }).toContact, 'muse');
});

test('P2: task_pass auto_start retries with the same key start no second job', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch } = await createTask(fx);
  const store = new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  const rev = store.getTask('r1', 'tasks/o2.md')!.revision;
  const args = { to_module: 'execute', note: 'implement it', auto_start: true, expected_revision: rev, objective: 'implement it' };
  const first = JSON.parse((await passAutoStartAs(fx, dispatch, 'plan', 'codex', args)).text) as { job: { id: string } };
  const second = JSON.parse((await passAutoStartAs(fx, dispatch, 'plan', 'codex', args)).text) as {
    job: { id: string }; delivery: { status: string };
  };
  assert.equal(second.job.id, first.job.id, 'retry returns the same job');
  assert.equal(second.delivery.status, 'duplicate');
  const count = (fx.db.prepare('SELECT COUNT(*) AS c FROM room_task_links WHERE task_id = ?').get('r1::tasks/o2.md') as { c: number }).c;
  assert.equal(count, 1, 'no second job is linked');
});

test('P2: task_pass auto_start is refused after three rounds without review', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch } = await createTask(fx);
  for (let i = 0; i < 3; i += 1) {
    fx.db.prepare("INSERT INTO room_task_events (task_id, kind, actor, module, payload) VALUES (?, 'execution-started', 'muse', 'execute', ?)")
      .run('r1::tasks/o2.md', JSON.stringify({ jobId: `job-${i}` }));
  }
  const store = new RoomTaskStore(fx.db, fx.jobs, dispatch as never);
  const rev = store.getTask('r1', 'tasks/o2.md')!.revision;
  const result = await passAutoStartAs(fx, dispatch, 'plan', 'codex', {
    to_module: 'execute', note: 'one more round', auto_start: true, expected_revision: rev, objective: 'again',
  }, false);
  assert.match(result.text, /3 轮/);
});

test('P2: task_pass auto_start to a non-execute module is rejected', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch } = await createTask(fx);
  const result = await passAutoStartAs(fx, dispatch, 'plan', 'codex', {
    to_module: 'review', note: 'look', auto_start: true, expected_revision: 1,
  }, false);
  assert.match(result.text, /仅 to_module=execute/);
});

test('P2: task_pass auto_start requires expected_revision', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { dispatch } = await createTask(fx);
  const result = await passAutoStartAs(fx, dispatch, 'plan', 'codex', {
    to_module: 'execute', note: 'implement it', auto_start: true, objective: 'implement it',
  }, false);
  assert.match(result.text, /expected_revision/);
});
