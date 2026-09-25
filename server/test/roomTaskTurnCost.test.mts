// Q1 (cost batch 2): chat-seat turn usage attributed into task_get cost.turns.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import { beginRoomTurn, endRoomTurn, recordTurnCall, setTurnMessageId } from '../src/roomTasks/turnAttribution.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import { JobStore } from '../src/jobs/jobStore.js';
import type { SseHub } from '../src/platform/sse.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-cost-q1-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const jobs = new JobStore(db, { broadcast: () => {} } as unknown as SseHub);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(id, id, backend);
  }
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('r1', 'r1', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse', 'aye'], governance: 'open' }));
  db.prepare("INSERT OR IGNORE INTO workers (id, name, token_hash, capabilities, status, accepting_jobs) VALUES ('w1', 'w1', 'x', ?, 'online', 1)")
    .run(JSON.stringify({ workspaces: [dir] }));
  const anchor = Number(db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
    VALUES ('r1', 'user', 'user', 'text', 'ok', 'done', '{}', 'main')`).run().lastInsertRowid);
  const dispatch = { dispatchToModule: () => ({ status: 'posted' as const }) };
  return { dir, db, jobs, anchor, dispatch };
}

/**
 * Create a task through the store directly (no tool wrapper, so no
 * turn-call rows): the creation turn stays unattributed and counts below
 * come only from the chatTurn() rows each test sets up.
 */
function createTask(fx: ReturnType<typeof setup>, taskPath: string): void {
  const { db, jobs, anchor, dir } = fx;
  const turn = beginRoomTurn(db, { roomId: 'r1', moduleId: 'plan', contactId: 'codex' });
  try {
    const store = new RoomTaskStore(db, jobs, null, {
      toolContext: { roomId: 'r1', moduleId: 'plan', turnId: turn.turnId },
    });
    const created = store.createTask({
      roomId: 'r1', taskPath, title: 'Q1', requirements: 'req',
      workspace: dir, anchorMessageId: anchor, actorContact: 'codex',
    });
    assert.ok(!('error' in created), JSON.stringify(created));
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

/** Post a final assistant message carrying runner usage; returns the message id. */
function postAssistant(fx: ReturnType<typeof setup>, contact: string, usage: Record<string, number>): number {
  const id = Number(fx.db.prepare(`INSERT INTO messages
    (contact_id, sender, role, kind, content, status, meta, origin)
    VALUES (?, ?, 'assistant', 'text', ?, 'done', ?, 'main')`).run(
    contact, contact, 'final text',
    JSON.stringify({ usage: { input: usage.input, output: usage.output, cacheCreation: usage.creation, cacheRead: usage.read } }),
  ).lastInsertRowid);
  const row = fx.db.prepare('SELECT input_tokens, output_tokens, cache_creation, cache_read FROM message_usage WHERE message_id = ?').get(id) as
    { input_tokens: number; output_tokens: number; cache_creation: number; cache_read: number } | undefined;
  assert.ok(row, 'message_usage trigger must record the assistant message');
  assert.deepEqual([row.input_tokens, row.output_tokens, row.cache_creation, row.cache_read],
    [usage.input, usage.output, usage.creation, usage.read]);
  return id;
}

/** Simulate one settled chat-seat turn: optional pin, optional ok-touches, optional final message. */
function chatTurn(fx: ReturnType<typeof setup>, opts: {
  contact: string; module: string; taskId?: string;
  touches?: Array<{ taskId: string; ok: boolean }>;
  usage?: Record<string, number>;
}): string {
  const turn = beginRoomTurn(fx.db, {
    roomId: 'r1', contactId: opts.contact, moduleId: opts.module,
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
  });
  for (const touch of opts.touches ?? []) {
    recordTurnCall(fx.db, turn.turnId, {
      roomId: 'r1', contactId: opts.contact, moduleId: opts.module,
      tool: 'task_get', taskId: touch.taskId, ok: touch.ok,
    });
  }
  if (opts.usage) {
    setTurnMessageId(fx.db, turn.turnId, postAssistant(fx, opts.contact, opts.usage));
  }
  endRoomTurn(fx.db, turn.turnId, 'settled');
  return turn.turnId;
}

function turnsOf(fx: ReturnType<typeof setup>, taskPath: string): Record<string, any> {
  return new RoomTaskStore(fx.db, fx.jobs, null).taskCost(`r1::${taskPath}`).turns as Record<string, any>;
}

test('Q1: pinned turn is attributed even with no tool calls', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  createTask(fx, 'tasks/alpha.md');
  createTask(fx, 'tasks/beta.md');
  chatTurn(fx, { contact: 'aye', module: 'review', taskId: 'r1::tasks/alpha.md', usage: { input: 100, output: 20, creation: 5, read: 50 } });
  assert.deepEqual(turnsOf(fx, 'tasks/alpha.md'), {
    count: 1,
    byModule: { review: { count: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheCreationTokens: 5 } },
    tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheCreationTokens: 5 },
  });
  assert.deepEqual(turnsOf(fx, 'tasks/beta.md'), {
    count: 0,
    byModule: {},
    tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  });
});

test('Q1: unpinned single-touch turn is attributed; multi/zero/failed touches are not', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  createTask(fx, 'tasks/alpha.md');
  createTask(fx, 'tasks/beta.md');
  chatTurn(fx, { contact: 'codex', module: 'plan', touches: [{ taskId: 'r1::tasks/beta.md', ok: true }], usage: { input: 10, output: 2, creation: 0, read: 3 } });
  chatTurn(fx, {
    contact: 'codex', module: 'plan',
    touches: [{ taskId: 'r1::tasks/alpha.md', ok: true }, { taskId: 'r1::tasks/beta.md', ok: true }],
    usage: { input: 999, output: 999, creation: 999, read: 999 },
  });
  chatTurn(fx, { contact: 'codex', module: 'plan', usage: { input: 999, output: 999, creation: 999, read: 999 } });
  chatTurn(fx, { contact: 'codex', module: 'plan', touches: [{ taskId: 'r1::tasks/alpha.md', ok: false }], usage: { input: 999, output: 999, creation: 999, read: 999 } });
  const beta = turnsOf(fx, 'tasks/beta.md');
  assert.equal(beta.count, 1);
  assert.deepEqual(beta.tokens, { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 0 });
  assert.equal(turnsOf(fx, 'tasks/alpha.md').count, 0);
});

test('Q1: same contact across modules splits by module, never averaged or duplicated', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  createTask(fx, 'tasks/alpha.md');
  chatTurn(fx, { contact: 'codex', module: 'plan', taskId: 'r1::tasks/alpha.md', usage: { input: 100, output: 10, creation: 0, read: 0 } });
  chatTurn(fx, { contact: 'codex', module: 'merge', taskId: 'r1::tasks/alpha.md', usage: { input: 7, output: 8, creation: 1, read: 2 } });
  const alpha = turnsOf(fx, 'tasks/alpha.md');
  assert.equal(alpha.count, 2);
  assert.deepEqual(alpha.byModule.plan, { count: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 });
  assert.deepEqual(alpha.byModule.merge, { count: 1, inputTokens: 7, outputTokens: 8, cacheReadTokens: 2, cacheCreationTokens: 1 });
  assert.deepEqual(alpha.tokens, { inputTokens: 107, outputTokens: 18, cacheReadTokens: 2, cacheCreationTokens: 1 });
});

test('Q1: old rows without message_id and deleted usage rows do not break the summary', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  createTask(fx, 'tasks/alpha.md');
  const msgId = postAssistant(fx, 'aye', { input: 40, output: 4, creation: 0, read: 1 });
  const withUsage = beginRoomTurn(fx.db, { roomId: 'r1', contactId: 'aye', moduleId: 'review', taskId: 'r1::tasks/alpha.md' });
  setTurnMessageId(fx.db, withUsage.turnId, msgId);
  endRoomTurn(fx.db, withUsage.turnId, 'settled');
  // Old turn row with no message_id (never linked to a message).
  const legacy = beginRoomTurn(fx.db, { roomId: 'r1', contactId: 'aye', moduleId: 'review', taskId: 'r1::tasks/alpha.md' });
  endRoomTurn(fx.db, legacy.turnId, 'settled');
  // Usage row deleted via message CASCADE: the turn still counts, tokens drop, nothing throws.
  fx.db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
  const left = fx.db.prepare('SELECT COUNT(*) AS c FROM message_usage WHERE message_id = ?').get(msgId) as { c: number };
  assert.equal(left.c, 0);
  const store = new RoomTaskStore(fx.db, fx.jobs, null);
  const cost = store.taskCost('r1::tasks/alpha.md');
  const turns = cost.turns as Record<string, any>;
  assert.equal(turns.count, 2);
  assert.deepEqual(turns.tokens, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
  // task_get (full + section=summary) carries the same turns object.
  const turn = beginRoomTurn(fx.db, { roomId: 'r1', moduleId: 'plan', contactId: 'codex' });
  try {
    const tools = buildRoomTaskTools(fx.db, fx.jobs, 'codex', fx.dispatch as never, { readVaultTask: () => null },
      { roomId: 'r1', moduleId: 'plan', turnId: turn.turnId });
    const summary = await tools.find((item) => item.name === 'task_get')!
      .exec({ room_id: 'r1', task_path: 'tasks/alpha.md', section: 'summary' });
    assert.equal(summary.ok, true, summary.text);
    const summaryTurns = (JSON.parse(summary.text).view.cost.turns ?? {}) as { count?: number };
    assert.ok((summaryTurns.count ?? 0) >= 2, 'section=summary carries turns');
    const full = await tools.find((item) => item.name === 'task_get')!
      .exec({ room_id: 'r1', task_path: 'tasks/alpha.md' });
    assert.equal(full.ok, true, full.text);
    assert.ok(JSON.parse(full.text).view.cost.turns, 'full task_get carries turns');
  } finally {
    endRoomTurn(fx.db, turn.turnId, 'test');
  }
});
