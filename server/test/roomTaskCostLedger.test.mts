// P1: per-attempt cost ledger — attempt-finished payload fields + task cost summary.
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
import { boundedDeliveryMeta } from '../src/jobs/receiptFields.js';
import type { SseHub } from '../src/platform/sse.js';

const SHA = (ch: string) => ch.repeat(40);
const H1 = SHA('a');
const BASE = SHA('c');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-cost-p1-'));
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
    const result = await tool.exec(args);
    assert.equal(result.ok, true, result.text);
    return JSON.parse(result.text);
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

async function createTask(fx: ReturnType<typeof setup>, taskPath: string) {
  return toolCall(fx, 'codex', 'plan', 'task_create', {
    room_id: 'r1', task_path: taskPath, title: 'P1', requirements: 'req',
    workspace: fx.dir, anchor_message_id: fx.anchor,
  });
}

/** Simulate one finished worker attempt linked to the task. */
function finishAttempt(fx: ReturnType<typeof setup>, taskPath: string, opts: {
  usage?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  legacyOptions?: boolean;
}): JobRow {
  const { db, jobs } = fx;
  const created = jobs.create({
    requestedBy: 'muse',
    runner: 'opencode',
    workspace: fx.dir,
    prompt: `implement ${taskPath}`,
    permissions: { write: true, shell: true, ssh: false },
    options: { routeClass: 'implement', taskPath },
    originContactId: 'r1',
    originAnchorId: fx.anchor,
  });
  assert.ok(!('error' in created), JSON.stringify(created));
  const taskId = `r1::${taskPath}`;
  const options = opts.legacyOptions ? { roomTaskId: taskId } : { ...JSON.parse(created.job.options), roomTaskId: taskId };
  db.prepare('UPDATE jobs SET options = ? WHERE id = ?').run(JSON.stringify(options), created.job.id);
  db.prepare('INSERT OR IGNORE INTO room_task_links (job_id, task_id, room_id, attached_by) VALUES (?, ?, ?, ?)').run(
    created.job.id, taskId, 'r1', 'muse',
  );
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(created.job.id);
  const meta = boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat-p1',
      head: H1,
      diffstat: '1 file changed, 10 insertions(+)',
      changedFiles: { files: ['src/a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
      ...(opts.usage ? { usage: opts.usage } : {}),
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'p1' },
  });
  const outcome = jobs.complete(jobs.get(created.job.id)!, 'done', 'simulated done', null, 'delivered', meta);
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  // complete() stamps updated_at=now; pin deterministic timestamps afterwards
  // so durationMs is exact (created 10:00:00 → updated 10:02:30 = 150_000ms).
  db.prepare('UPDATE jobs SET created_at = ?, updated_at = ? WHERE id = ?').run(
    opts.createdAt ?? '2026-09-18 10:00:00',
    opts.updatedAt ?? '2026-09-18 10:02:30',
    created.job.id,
  );
  // No dispatcher: completion callbacks fail closed, the ledger write is what matters here.
  new RoomTaskStore(db, jobs, null).handleJobFinished(jobs.get(created.job.id)!, { finalAttempt: true, actor: 'muse' });
  return jobs.get(created.job.id)!;
}

function attemptFinishedPayload(fx: ReturnType<typeof setup>, taskId: string): Record<string, unknown> {
  const row = fx.db.prepare(
    "SELECT payload FROM room_task_events WHERE task_id = ? AND kind = 'attempt-finished' ORDER BY id DESC LIMIT 1",
  ).get(taskId) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

test('P1: attempt-finished payload carries duration/binding/usage', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await createTask(fx, 'tasks/cost.md');
  const job = finishAttempt(fx, 'tasks/cost.md', {
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50 },
  });
  const payload = attemptFinishedPayload(fx, 'r1::tasks/cost.md');
  assert.equal(payload.jobId, job.id);
  assert.equal(payload.durationMs, 150_000);
  assert.equal(payload.moduleId, 'execute');
  assert.equal(payload.runner, 'opencode');
  assert.equal(typeof payload.model, 'string');
  assert.equal(typeof payload.reasoning, 'string');
  assert.deepEqual(payload.usage, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50 });
});

test('P1: task_get cost summarizes attempts/duration/tokens/wakes', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await createTask(fx, 'tasks/cost.md');
  finishAttempt(fx, 'tasks/cost.md', { usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50 } });
  finishAttempt(fx, 'tasks/cost.md', {
    usage: { inputTokens: 500, outputTokens: 100 },
    createdAt: '2026-09-18 11:00:00',
    updatedAt: '2026-09-18 11:01:00',
  });
  const view = await toolCall(fx, 'codex', 'plan', 'task_get', { room_id: 'r1', task_path: 'tasks/cost.md' });
  const { turns, ...rest } = view.view.cost as Record<string, unknown>;
  assert.deepEqual(rest, {
    attempts: 2,
    durationMs: 210_000,
    tokens: { inputTokens: 1500, outputTokens: 300, cacheReadTokens: 50 },
    wakes: 0,
  });
  // Q1: tool turns attribute as message-less counts. Only the create turn is
  // visible here: the current task_get turn's own call row lands after exec.
  assert.deepEqual(turns, {
    count: 1,
    byModule: { plan: { count: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } },
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  });
  assert.equal(view.view.attempts.length, 2);
  assert.equal(view.view.attempts[0].durationMs, 150_000);
  assert.equal(view.view.attempts[0].moduleId, 'execute');
  assert.deepEqual(view.view.attempts[0].usage, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50 });
});

test('P1: legacy rows without usage/binding do not break the ledger', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  await createTask(fx, 'tasks/legacy.md');
  // An old-style attempt-finished event without the new fields.
  fx.db.prepare(
    'INSERT INTO room_task_events (task_id, kind, actor, module, payload) VALUES (?, ?, ?, ?, ?)',
  ).run('r1::tasks/legacy.md', 'attempt-finished', 'muse', 'execute', JSON.stringify({ jobId: 'old-job', status: 'done' }));
  finishAttempt(fx, 'tasks/legacy.md', { legacyOptions: true });
  const payload = attemptFinishedPayload(fx, 'r1::tasks/legacy.md');
  assert.equal(payload.moduleId, null);
  assert.equal(payload.model, null);
  assert.equal(payload.reasoning, null);
  assert.equal(payload.usage, null);
  const view = await toolCall(fx, 'codex', 'plan', 'task_get', { room_id: 'r1', task_path: 'tasks/legacy.md' });
  const { turns, ...rest } = view.view.cost as Record<string, unknown>;
  assert.deepEqual(rest, { attempts: 1, durationMs: 150_000, wakes: 0 });
  assert.ok(!('tokens' in rest));
  // Q1: tool turns attribute as message-less counts; legacy attempts add nothing.
  // Only the create turn is visible: the current task_get turn lands after exec.
  assert.deepEqual(turns, {
    count: 1,
    byModule: { plan: { count: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 } },
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  });
});
