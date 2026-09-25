import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { AgentManager } from '../src/runtime/manager.js';
import { createRoomTaskDispatcher } from '../src/runtime/roomTaskDispatch.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import { taskDispatchLedgerStatus, type RoomTaskToolContext } from '../src/roomTasks/roomTaskStore.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';

function baseConfig(dir: string): any {
  return {
    dbPath: path.join(dir, 'hub.db'), uploadsDir: path.join(dir, 'uploads'), agentsDir: path.join(dir, 'agents'),
    host: '127.0.0.1', port: 3900, memory: {}, claude: {}, codex: {}, opencode: {}, grok: {},
  };
}

/** A recipient turn that runs to completion without answering its handoff must
 * flip the dispatch ledger to failed, so task_retry can wake it again instead
 * of reporting duplicate forever (2026-09-16: review seat lost its hub tools,
 * the turn "completed", the handoff sat pending behind a posted key). */
test('handoff delivery is retryable after the recipient turn ends without accept/decline', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-redeliver-'));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  const db = openDb(path.join(dir, 'hub.db'));
  const sse = { broadcast() {} } as any;
  const jobs = new JobStore(db, sse);
  for (const id of ['codex', 'muse']) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, 'api', 'dm', '{}')").run(id, id);
  }
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('rr', 'RR', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse'] }));
  const manager = new AgentManager({ db, sse, config: baseConfig(dir), jobStore: jobs, vault: null } as any);
  t.after(() => {
    try { (jobs as any).stopOutOfBandResolver?.(); } catch { /* ignore */ }
    try { (manager as any).stopAll?.(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // The recipient is woken, its round completes normally, but the model never
  // touches the ledger (no accept, no decline).
  let wakes = 0;
  let finishRound: () => void = () => {};
  (manager as any).dispatchRoomMessageTracked = () => {
    wakes += 1;
    return { targets: ['muse'], completion: new Promise<Record<string, unknown>>((resolve) => { finishRound = () => resolve({ normal: { spoke: 1 } }); }) };
  };
  const dispatcher = createRoomTaskDispatcher({ db, sse, manager });
  const open = (contactId: string, ctx: RoomTaskToolContext) => {
    const turn = beginRoomTurn(db, { roomId: ctx.roomId, contactId, moduleId: ctx.moduleId,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}), ...(ctx.handoffId ? { handoffId: ctx.handoffId } : {}) });
    const tools = buildRoomTaskTools(db, jobs, contactId, dispatcher, {}, { ...ctx, turnId: turn.turnId });
    return {
      call: async (name: string, args: Record<string, unknown>) => {
        const out = await tools.find((tool) => tool.name === name)!.exec(args);
        assert.equal(out.ok, true, `${name}: ${out.text.slice(0, 300)}`);
        return JSON.parse(out.text);
      },
      close: () => endRoomTurn(db, turn.turnId, 'test'),
    };
  };
  const anchorId = Number(db.prepare(
    "INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin) VALUES ('rr', 'user', 'user', 'text', 'User：批准 tasks/idle.md', 'done', '{}', 'main')",
  ).run().lastInsertRowid);
  const plan = open('codex', { roomId: 'rr', moduleId: 'plan' });
  await plan.call('task_create', { room_id: 'rr', task_path: 'tasks/idle.md', title: 'IDLE', requirements: '需求。', workspace: dir, anchor_message_id: anchorId });
  const sent = await plan.call('task_handoff', { room_id: 'rr', task_path: 'tasks/idle.md', actor_module: 'plan', to_module: 'execute', request: '实现。', evidence_refs: [] });
  plan.close();
  const key = `task-handoff:v1:${sent.handoff.id}`;
  assert.equal(sent.delivery.status, 'posted');
  assert.equal(wakes, 1);
  assert.equal(taskDispatchLedgerStatus(db, key), 'posted');

  // Retry while the round is still running: posted keys never double-wake.
  const early = open('codex', { roomId: 'rr', moduleId: 'plan' });
  const dup = await early.call('task_retry', { room_id: 'rr', mode: 'handoff', handoff_id: sent.handoff.id });
  early.close();
  assert.equal(dup.delivery.status, 'duplicate');
  assert.equal(wakes, 1, 'a live round is not woken twice');

  // Round ends, handoff still pending → ledger flips to failed.
  finishRound();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(taskDispatchLedgerStatus(db, key), 'failed');
  assert.equal(db.prepare('SELECT status FROM room_task_handoffs WHERE id = ?').get(sent.handoff.id).status, 'pending');

  // Explicit retry now wakes the same recipient again.
  const again = open('codex', { roomId: 'rr', moduleId: 'plan' });
  const redelivered = await again.call('task_retry', { room_id: 'rr', mode: 'handoff', handoff_id: sent.handoff.id });
  again.close();
  assert.equal(redelivered.delivery.status, 'posted');
  assert.equal(wakes, 2, 'retry after an idle round wakes the recipient');
  assert.equal(taskDispatchLedgerStatus(db, key), 'posted');

  // Control: when the recipient accepts before its round ends, the key stays posted.
  const exec = open('muse', { roomId: 'rr', moduleId: 'execute', taskId: sent.handoff.task_id, handoffId: sent.handoff.id });
  await exec.call('task_accept', { room_id: 'rr', task_path: 'tasks/idle.md' });
  exec.close();
  finishRound();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(taskDispatchLedgerStatus(db, key), 'posted', 'an answered handoff is not flipped to failed');
});
