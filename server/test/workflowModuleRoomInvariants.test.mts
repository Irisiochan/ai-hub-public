// Independent pre-call routing checks: no model or external endpoint is called.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type ContactRow } from '../src/platform/db.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { AgentManager } from '../src/runtime/manager.js';
import { AgentRuntime } from '../src/runtime/runtime.js';
import { ensureWorkflowRoomReserves } from '../src/workflow/roomReserves.js';
import { isWorkflowRoomConfig } from '../src/workflow/workflowModules.js';
import { validateCapturedSnapshot } from '../src/workflow/moduleAuthority.js';

async function fixture(run: (ctx: any) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-module-room-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const sse = { broadcast() {} } as never;
  const jobs = new JobStore(db, sse);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli'], ['reserve', 'codex']]) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(id, id, backend);
  }
  const config = { memory: { capture: false }, agentsDir: dir };
  const deps: any = { db, sse, config, jobStore: jobs, vault: null };
  const manager = new AgentManager(deps);
  const calls: Array<{ member: string; context: any; mode: string }> = [];
  (manager as any).getRoomMember = (_room: any, member: ContactRow, context: any) => ({
    async runRoomTurn(mode: string) { calls.push({ member: member.id, context, mode }); return 'spoke'; },
  });
  function room(enabled = true): ContactRow {
    const id = enabled ? 'workflow' : 'social';
    db.prepare("INSERT OR IGNORE INTO contacts (id, name, backend, kind, config) VALUES (?, ?, 'room', 'room', ?)")
      .run(id, id, JSON.stringify({ workflowEnabled: enabled, members: ['codex', 'muse', 'aye', 'reserve'], reactionRounds: 1 }));
    return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow;
  }
  try { await run({ db, jobs, manager, calls, room, deps, contact: (id: string) => db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) }); }
  finally {
    await manager.stopAll(); jobs.stopOutOfBandResolver(); db.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('ai-hub-module-room-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('ordinary intake, all mentions and reaction rounds never wake reserves or unrelated modules', async () => fixture(async ({ manager, calls, room }: any) => {
  const target = room();
  for (const content of ['开始工作', '@all 看一下', '@reserve 帮忙']) {
    calls.length = 0;
    const dispatch = manager.dispatchRoomMessageTracked(target, content, { reactionRounds: 1 });
    assert.deepEqual(dispatch.targets, ['codex']);
    await dispatch.completion;
    assert.ok(calls.length > 0);
    assert.ok(calls.every((call: any) => call.member === 'codex'));
  }
}));

test('trusted host overrides still route only to the applicable module with its pinned model', async () => fixture(async ({ manager, calls, room, contact }: any) => {
  const dispatch = manager.dispatchRoomMessageTracked(room(), '@all 执行', {
    moduleId: 'execute', targetOverride: ['muse', 'aye', 'reserve'].map(contact), reactionRounds: 0,
  });
  assert.deepEqual(dispatch.targets, ['muse'], 'review binding is not authority to receive an execution round');
  await dispatch.completion;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.model, 'opencode-go/muse-spark-1.3-contributor', 'backend suffix must not discard the pinned model');
  assert.equal(calls[0].context.moduleId, 'execute');
}));

test('a blocked credential pool stops before runtime creation and leaves other modules available', async () => fixture(async ({ manager, calls, room, deps }: any) => {
  deps.workflowPoolBlocked = (runner: string) => runner === 'grok' ? 'weekly quota exhausted' : null;
  let constructed = 0;
  const original = manager.getRoomMember;
  manager.getRoomMember = (...args: any[]) => { constructed++; return original(...args); };
  const blocked = manager.dispatchRoomMessageTracked(room(), 'review', { moduleId: 'review', reactionRounds: 0 });
  await blocked.completion;
  assert.equal(constructed, 0); assert.equal(calls.length, 0);
  const plan = manager.dispatchRoomMessageTracked(room(), '继续规划', { reactionRounds: 0 });
  await plan.completion;
  assert.equal(constructed, 1); assert.equal(calls[0].member, 'codex');
}));

test('a binding hot swap is captured for new intake while the queued attempt retains its snapshot', async () => fixture(async ({ manager, calls, jobs, room }: any) => {
  const target = room();
  const old = manager.dispatchRoomMessageTracked(target, '@all', { reactionRounds: 0 });
  const changed = jobs.workflowModules.setBinding('plan', { contactId: 'reserve', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  assert.equal(changed.ok, true);
  const next = manager.dispatchRoomMessageTracked(target, '@all', { reactionRounds: 0 });
  await Promise.all([old.completion, next.completion]);
  assert.deepEqual(old.targets, ['codex']); assert.deepEqual(next.targets, ['reserve']);
  assert.ok(calls.some((call: any) => call.member === 'codex' && call.context.bindingRevision < changed.revision));
  assert.ok(calls.some((call: any) => call.member === 'reserve' && call.context.bindingRevision === changed.revision));
}));

test('explicit opt-out preserves social room all-mention behavior', async () => fixture(async ({ manager, room }: any) => {
  const dispatch = manager.dispatchRoomMessageTracked(room(false), '@all', { reactionRounds: 0 });
  assert.deepEqual([...dispatch.targets].sort(), ['aye', 'codex', 'muse', 'reserve']);
  await dispatch.completion;
}));

test('explicit workflow opt-out wins over retained legacy coordination config', () => {
  assert.equal(isWorkflowRoomConfig({ workflowEnabled: false, coordination: { orchestrator: 'codex' } }), false);
});

test('reserve bootstrap recognizes actual CLI backend ids and leaves social membership alone', async () => fixture(async ({ db, room }: any) => {
  const target = room(); const social = room(false);
  db.prepare('UPDATE contacts SET config = ? WHERE id = ?').run(JSON.stringify({ workflowEnabled: true, members: ['codex'] }), target.id);
  const beforeSocial = db.prepare('SELECT config FROM contacts WHERE id = ?').get(social.id).config;
  ensureWorkflowRoomReserves(db);
  const config = JSON.parse(db.prepare('SELECT config FROM contacts WHERE id = ?').get(target.id).config);
  assert.deepEqual(config.members.sort(), ['aye', 'codex', 'muse', 'reserve']);
  assert.equal(db.prepare('SELECT config FROM contacts WHERE id = ?').get(social.id).config, beforeSocial);
  ensureWorkflowRoomReserves(db);
  assert.deepEqual(JSON.parse(db.prepare('SELECT config FROM contacts WHERE id = ?').get(target.id).config).members.sort(), ['aye', 'codex', 'muse', 'reserve']);
}));

test('a changed module binding cannot resume the previous persistent model session', async () => fixture(async ({ db, jobs, room, contact }: any) => {
  const deps = { db, jobStore: jobs, vault: null, sse: { broadcast() {} }, config: { agentsDir: os.tmpdir(), memory: {} } } as any;
  const first = new AgentRuntime(room(), contact('codex'), deps, { moduleId: 'plan', model: 'gpt-6-astra', reasoning: 'high', bindingRevision: 1 });
  const changed = new AgentRuntime(room(), contact('codex'), deps, { moduleId: 'plan', model: 'gpt-5.6-sol', reasoning: 'high', bindingRevision: 2 });
  const review = new AgentRuntime(room(), contact('codex'), deps, { moduleId: 'review', model: 'gpt-6-astra', reasoning: 'high', bindingRevision: 1 });
  assert.notEqual((first as any).memberId, (changed as any).memberId, 'resume persistence must isolate binding revisions, not just in-memory runtimes');
  assert.notEqual((first as any).memberId, (review as any).memberId, 'different module permissions never share a session');
}));

test('persisted drain authority retains revision, task and narrowed permissions after a binding change', async () => fixture(async ({ manager, jobs, room, db }: any) => {
  const target = room();
  const original = jobs.workflowModules.invoke('execute', 'tasks/old-task.md', 'C:/trusted');
  const durable = {
    moduleId: original.moduleId, binding: original.binding, revision: original.bindingRevision,
    permissions: { write: false, shell: true, ssh: false },
    taskPath: 'tasks/old-task.md', workspace: 'C:/trusted',
  };
  const changed = jobs.workflowModules.setBinding('execute', { contactId: 'reserve', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  assert.equal(changed.ok, true);
  const message = db.prepare("INSERT INTO messages (contact_id, sender, role, content, meta) VALUES (?, 'room-host', 'system', 'resume', ?)")
    .run(target.id, JSON.stringify({ roomHost: { workflowModule: durable } }));
  const recovered = manager.resolveWorkflowModule(target, Number(message.lastInsertRowid));
  assert.equal(recovered.binding.contactId, 'muse');
  assert.equal(recovered.revision, durable.revision);
  assert.equal(recovered.taskPath, durable.taskPath);
  assert.equal(recovered.workspace, durable.workspace);
  assert.deepEqual(recovered.permissions, durable.permissions);
  assert.deepEqual(validateCapturedSnapshot({ ...durable, bindingRevision: durable.revision }), validateCapturedSnapshot(durable));
}));

test('a pool that becomes blocked after scheduling is rechecked before the actual CLI call', async () => fixture(async ({ manager, jobs, room, contact, deps, calls }: any) => {
  const target = room();
  const captured = manager.resolveWorkflowModule(target, undefined, 'review');
  assert.ok(captured);
  deps.workflowPoolBlocked = (runner: string) => runner === 'grok' ? 'weekly quota exhausted' : null;
  const result = await manager.runRoomRound(target, [contact('aye')], { workflowModule: captured, reactionRounds: 1 });
  assert.equal(calls.length, 0);
  assert.deepEqual(result.reactions, []);
  assert.equal(Object.values(result.normal).reduce((sum: number, value: any) => sum + value, 0), 0);
}));
