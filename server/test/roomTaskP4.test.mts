// P4: (2) task_get section, (3) continuation-round prompt truncation.
// P4-1 (tool schema scoped per module/governance) was stopped during
// implementation: it contradicts the tested sixteen-tools-declared
// invariant (roomTaskRuntimePath native + MCP parity). See RECEIPT.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { boundedDeliveryMeta } from '../src/jobs/receiptFields.js';
import type { SseHub } from '../src/platform/sse.js';

const SHA = (ch: string) => ch.repeat(40);
const H2 = SHA('b');

function setup(governance?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-cost-p4-'));
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
  const dispatch = { dispatchToModule: () => ({ status: 'posted' as const }) };
  return { dir, db, jobs, anchor, dispatch };
}

async function toolCall(fx: ReturnType<typeof setup>, contact: string, moduleId: string, name: string, args: Record<string, unknown>) {
  const { db, jobs, dispatch } = fx;
  const turn = beginRoomTurn(db, { roomId: 'r1', moduleId, contactId: contact });
  try {
    const tool = buildRoomTaskTools(db, jobs, contact, dispatch as never, { readVaultTask: () => null },
      { roomId: 'r1', moduleId, turnId: turn.turnId }).find((item) => item.name === name)!;
    return tool.exec(args);
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

const HOLDER_CONTACT: Record<string, string> = { plan: 'codex', execute: 'muse', review: 'aye', arbitration: 'aye', merge: 'muse', deploy: 'muse', maintenance: 'codex' };

async function passAndStart(fx: ReturnType<typeof setup>, taskPath: string, objective: string, extraStart: Record<string, unknown> = {}): Promise<string> {
  const store = new RoomTaskStore(fx.db, fx.jobs, fx.dispatch as never);
  const holder = store.getTask('r1', taskPath)!.holder_module ?? 'plan';
  const pass = await toolCall(fx, HOLDER_CONTACT[holder] ?? 'codex', holder, 'task_pass', {
    room_id: 'r1', task_path: taskPath, to_module: 'execute', note: objective,
  });
  assert.equal(pass.ok, true, pass.text);
  const started = await toolCall(fx, 'muse', 'execute', 'execution_start', {
    room_id: 'r1', task_path: taskPath, module: 'execute',
    expected_revision: store.getTask('r1', taskPath)!.revision,
    workspace: fx.dir, objective, ...extraStart,
  });
  assert.equal(started.ok, true, started.text);
  return (JSON.parse(started.text) as { job: { id: string } }).job.id;
}

function finishJob(fx: ReturnType<typeof setup>, jobId: string): void {
  const { db, jobs } = fx;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
  const meta = boundedDeliveryMeta({
    state: 'delivered',
    receipt: { branch: 'feat-p4', head: H2, tests: [{ suite: 'unit', status: 'pass' }] },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'p4' },
  });
  const outcome = jobs.complete(jobs.get(jobId)!, 'done', 'simulated done', null, 'delivered', meta);
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  new RoomTaskStore(db, jobs, null).handleJobFinished(jobs.get(jobId)!, { finalAttempt: true, actor: 'muse' });
}

test('P4-2: task_get summary skips requirements/evidence, full is unchanged', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const requirements = `REQ-HEAD-${'r'.repeat(3000)}`;
  const created = await toolCall(fx, 'codex', 'plan', 'task_create', {
    room_id: 'r1', task_path: 'tasks/p4.md', title: 'P4', requirements,
    workspace: fx.dir, anchor_message_id: fx.anchor,
  });
  assert.equal(created.ok, true, created.text);
  const full = await toolCall(fx, 'codex', 'plan', 'task_get', { room_id: 'r1', task_path: 'tasks/p4.md' });
  assert.equal(full.ok, true, full.text);
  const fullView = (JSON.parse(full.text) as { view: Record<string, unknown> }).view;
  assert.equal((fullView.task as { requirements: string }).requirements, requirements);
  assert.ok(Array.isArray(fullView.evidence));
  const summary = await toolCall(fx, 'codex', 'plan', 'task_get', { room_id: 'r1', task_path: 'tasks/p4.md', section: 'summary' });
  assert.equal(summary.ok, true, summary.text);
  const view = (JSON.parse(summary.text) as { view: Record<string, unknown> }).view;
  const task = view.task as Record<string, unknown>;
  assert.equal(task.status, 'open');
  assert.equal(typeof task.revision, 'number');
  assert.equal(task.holder_module, 'plan');
  assert.ok(!('requirements' in task), 'summary carries no requirements text');
  assert.ok(!('evidence' in view), 'summary carries no evidence');
  assert.ok(!('handoffs' in view), 'summary carries no handoffs');
  assert.ok(!('attempts' in view), 'summary carries no attempts');
  assert.ok(Array.isArray(view.events));
  assert.ok(view.cost && typeof view.cost === 'object');
  assert.ok(JSON.stringify(view).length < JSON.stringify(fullView).length);
});

test('every execution round carries the full requirements, repair rounds included', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const requirements = `REQ-HEAD-${'r'.repeat(2000)}-REQ-TAIL`;
  const created = await toolCall(fx, 'codex', 'plan', 'task_create', {
    room_id: 'r1', task_path: 'tasks/p4.md', title: 'P4', requirements,
    workspace: fx.dir, anchor_message_id: fx.anchor,
  });
  assert.equal(created.ok, true, created.text);
  const job1 = await passAndStart(fx, 'tasks/p4.md', 'first round');
  const prompt1 = fx.jobs.get(job1)!.prompt;
  assert.ok(prompt1.includes('-REQ-TAIL'), 'first round keeps the full requirements');
  finishJob(fx, job1);
  const job2 = await passAndStart(fx, 'tasks/p4.md', 'second round');
  const prompt2 = fx.jobs.get(job2)!.prompt;
  // A repair Worker has a fresh workspace and no room tools: the prompt is
  // its only copy of the acceptance criteria.
  assert.ok(prompt2.includes('-REQ-TAIL'), 'repair rounds keep the full requirements');
  finishJob(fx, job2);
  const job3 = await passAndStart(fx, 'tasks/p4.md', 'recon round', { write: false });
  const prompt3 = fx.jobs.get(job3)!.prompt;
  assert.ok(prompt3.includes('-REQ-TAIL'), 'read-only recon rounds keep the full text');
});
