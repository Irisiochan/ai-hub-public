// User 2026-09-23: room execute write rounds opt into Worker auto-commit
// (worker/auto-commit.mjs). Only the trusted execute path may stamp it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type JobRow } from '../src/platform/db.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import { JobStore } from '../src/jobs/jobStore.js';
import type { SseHub } from '../src/platform/sse.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-exec-autocommit-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const jobs = new JobStore(db, { broadcast: () => {} } as unknown as SseHub);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(id, id, backend);
  }
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('r1', 'r1', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse', 'aye'], governance: 'open' }));
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

async function passAndStart(fx: ReturnType<typeof setup>, taskPath: string, objective: string): Promise<{ job: JobRow }> {
  const store = new RoomTaskStore(fx.db, fx.jobs, fx.dispatch as never);
  const task = store.getTask('r1', taskPath)!;
  const pass = await toolCall(fx, task.holder_module === 'plan' ? 'codex' : 'muse',
    task.holder_module ?? 'plan', 'task_pass', {
    room_id: 'r1', task_path: taskPath, to_module: 'execute', note: objective,
  });
  assert.equal(pass.ok, true, pass.text);
  const started = await toolCall(fx, 'muse', 'execute', 'execution_start', {
    room_id: 'r1', task_path: taskPath, module: 'execute',
    expected_revision: store.getTask('r1', taskPath)!.revision,
    workspace: fx.dir, objective,
  });
  assert.equal(started.ok, true, started.text);
  return { job: fx.jobs.get((JSON.parse(started.text) as { job: { id: string } }).job.id)! };
}


async function createTask(fx: ReturnType<typeof setup>) {
  const created = await toolCall(fx, 'codex', 'plan', 'task_create', {
    room_id: 'r1', task_path: 'tasks/auto.md', title: 'auto', requirements: 'req',
    workspace: fx.dir, anchor_message_id: fx.anchor,
  });
  assert.equal(created.ok, true, created.text);
}

test('execute write round carries autoCommitOnPass', async () => {
  const fx = setup();
  await createTask(fx);
  const { job } = await passAndStart(fx, 'tasks/auto.md', 'implement it');
  assert.equal(JSON.parse(job.permissions).write, true);
  assert.equal((JSON.parse(job.options) as Record<string, unknown>).autoCommitOnPass, true);
  fx.db.close();
});

test('read-only execute round does not opt in', async () => {
  const fx = setup();
  await createTask(fx);
  const store = new RoomTaskStore(fx.db, fx.jobs, fx.dispatch as never);
  const pass = await toolCall(fx, 'codex', 'plan', 'task_pass', {
    room_id: 'r1', task_path: 'tasks/auto.md', to_module: 'execute', note: 'inspect',
  });
  assert.equal(pass.ok, true, pass.text);
  const started = await toolCall(fx, 'muse', 'execute', 'execution_start', {
    room_id: 'r1', task_path: 'tasks/auto.md', module: 'execute',
    expected_revision: store.getTask('r1', 'tasks/auto.md')!.revision,
    workspace: fx.dir, objective: 'inspect only', write: false,
  });
  assert.equal(started.ok, true, started.text);
  const job = fx.jobs.get((JSON.parse(started.text) as { job: { id: string } }).job.id)!;
  assert.equal(JSON.parse(job.permissions).write, false);
  assert.equal((JSON.parse(job.options) as Record<string, unknown>).autoCommitOnPass, undefined);
  fx.db.close();
});

test('untrusted creates cannot self-grant autoCommitOnPass', () => {
  const fx = setup();
  const created = fx.jobs.create({
    requestedBy: 'codex', runner: 'codex', workspace: fx.dir, prompt: 'direct delegate',
    permissions: { write: true, shell: true, ssh: false },
    options: { routeClass: 'implement', autoCommitOnPass: true },
  });
  assert.ok(!('error' in created), JSON.stringify(created));
  assert.equal((JSON.parse(created.job.options) as Record<string, unknown>).autoCommitOnPass, undefined);
  fx.db.close();
});
