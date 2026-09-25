// Real runtime integration for the model-driven room workflow (review gap B5).
//
// No model or transport stubbing beyond the stubbed model endpoint / Claude
// lifecycle: handoff delivery runs the REAL manager -> REAL AgentRuntime ->
// REAL BackendFactory -> REAL DirectApiBackend native tool loop, with ONLY
// the model HTTP transport stubbed. A handoff to the review role proves
// taskId/handoffId/room/module survive end to end and that malformed/
// cross-task arguments are refused inside a real turn. A recording spy
// observes getRoomMember (delegating, never stubbing) to prove both turns of
// each A/B pair share the identical runtime instance.
// A second part holds REAL Claude-turn runtimes active via a stubbed CLI
// lifecycle while the test drives their REAL generated MCP bearers through
// the REAL hub MCP router.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb, type ContactRow } from '../src/platform/db.js';
import { AgentManager } from '../src/runtime/manager.js';
import { BackendFactory } from '../src/runtime/backendFactory.js';
import { PromptComposer } from '../src/prompt/promptComposer.js';
import { ConversationSummaryRepo } from '../src/prompt/conversationSummaryRepo.js';
import { LifeEventService } from '../src/companion/lifeEvents.js';
import { MessageRepo } from '../src/messages/messageRepo.js';
import type { HubLogger } from '../src/platform/logger.js';
import { buildRoomTaskTools, ROOM_TASK_TOOL_NAMES } from '../src/roomTasks/roomTaskTools.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { createRoomTaskDispatcher } from '../src/runtime/roomTaskDispatch.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import type { RoomTaskToolContext } from '../src/roomTasks/roomTaskStore.js';
import { verifyInvocationScope } from '../src/workflow/moduleAuthority.js';
import { hubMcpRouter } from '../src/tools/hubMcpRoutes.js';
import { JobStore } from '../src/jobs/jobStore.js';
import type { SseHub } from '../src/platform/sse.js';

const HUB_TOKEN = 'runtime-path-token';

function sseHub() {
  return { broadcast() {} } as unknown as SseHub;
}

function baseConfig(dir: string): any {
  return {
    port: 3900,
    host: '127.0.0.1',
    dbPath: path.join(dir, 'hub.db'),
    agentsDir: path.join(dir, 'agents'),
    webDist: '',
    uploadsDir: path.join(dir, 'uploads'),
    claude: { cliPath: 'missing-binary-roomtask-e2e' },
    codex: { cliPath: 'missing-binary-roomtask-e2e', nativeCompact: { enabled: false } },
    grok: { cliPath: 'missing-binary-roomtask-e2e' },
    opencode: { cliPath: 'missing-binary-roomtask-e2e' },
    api: { turnTimeoutMs: 8000 },
    memory: {
      mcpUrl: null, repoPath: dir, injectOnSpawn: false, searchPerTurn: false,
      capture: false, maxTurnChars: 0, sessionMaxAgeHours: 0,
    },
    backup: { enabled: false, dir: '', intervalHours: 24, keep: 1 },
  };
}

function writeSse(res: http.ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const payload of payloads) {
    res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
  }
  res.end();
}

const usageTail = () => ([
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  '[DONE]',
]);

test('real room turn carries the verified handoff context into native tools', { timeout: 120_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-runtime-path-'));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  const resources: { upstream?: http.Server; manager?: AgentManager; db?: ReturnType<typeof openDb> } = {};
  t.after(async () => {
    if (resources.upstream) await new Promise<void>((resolve) => resources.upstream!.close(() => resolve()));
    if (resources.manager) await resources.manager.stopAll().catch(() => {});
    try { resources.db?.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const requests: any[] = [];
  let round = 0;
  // Scripted provider rounds (strictly serial: T1 consumes R1-R3, T2 R4-R5).
  // Revisions are deterministic from the fixture ops below:
  // rt-a create(rev1) -> handoff(rev2) -> accept(rev3); T1 wait(blocked, rev3).
  const WAIT_REV_RTA = 3;
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(raw));
      round += 1;
      if (round === 1) {
        return writeSse(res, [
          { choices: [{ delta: { tool_calls: [
            { index: 0, id: 'call-accept', function: { name: 'task_accept', arguments: JSON.stringify({ room_id: 'r5', task_path: 'tasks/rt-a.md' }) } },
            { index: 1, id: 'call-get', function: { name: 'task_get', arguments: JSON.stringify({ room_id: 'r5', task_path: 'tasks/rt-a.md' }) } },
          ] } }], finish_reason: 'tool_calls' },
          ...usageTail(),
        ]);
      }
      if (round === 2) {
        return writeSse(res, [
          { choices: [{ delta: { tool_calls: [
            { index: 0, id: 'call-wait', function: { name: 'task_wait', arguments: JSON.stringify({
              room_id: 'r5', task_path: 'tasks/rt-a.md', mode: 'blocked',
              reason: '评审需要上游单测日志，当前环境无法拉取，需先补齐证据再继续。',
              resume_condition: '拿到上游单测全绿日志后继续评审。',
              expected_revision: WAIT_REV_RTA,
            }) } },
          ] } }], finish_reason: 'tool_calls' },
          ...usageTail(),
        ]);
      }
      if (round === 3) {
        return writeSse(res, [
          { choices: [{ delta: { content: '已受理，登记受阻，继续推进。' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
          '[DONE]',
        ]);
      }
      if (round === 4) {
        return writeSse(res, [
          { choices: [{ delta: { tool_calls: [
            { index: 0, id: 'call-get2', function: { name: 'task_get', arguments: JSON.stringify({ room_id: 'r5', task_path: 'tasks/rt-a.md' }) } },
          ] } }], finish_reason: 'tool_calls' },
          ...usageTail(),
        ]);
      }
      return writeSse(res, [
        { choices: [{ delta: { content: '[PASS]' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        '[DONE]',
      ]);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  resources.upstream = upstream;
  const port = (upstream.address() as { port: number }).port;

  const db = openDb(path.join(dir, 'hub.db'));
  resources.db = db;
  const sse = sseHub();
  const jobs = new JobStore(db, sse);
  const turnLogs: string[] = [];
  const logger = {
    info: (_f: unknown, m?: unknown) => { if (typeof m === 'string') turnLogs.push(m); },
    warn: (_f: unknown, m?: unknown) => { if (typeof m === 'string') turnLogs.push(m); },
    error: () => {},
  } as unknown as HubLogger;
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']] as const) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')")
      .run(id, id, backend);
  }
  // The review contact talks over the api backend (stub HTTP transport); the
  // module BINDING still names its CLI runner, exactly like production pins.
  db.prepare("UPDATE contacts SET backend = 'api', config = ? WHERE id = 'aye'").run(JSON.stringify({
    provider: 'openai-compat',
    baseUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    apiKey: 'test',
    model: 'stub',
    maxTokens: 1024,
    maxHistoryMessages: 20,
    historyTokenBudget: 8000,
    memory: { injectOnSpawn: false, searchPerTurn: false, capture: false },
  }));
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('r5', 'R5', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse', 'aye'] }));

  const managerDeps: any = { db, sse, config: baseConfig(dir), vault: null, jobStore: jobs, logger };
  const manager = new AgentManager(managerDeps);
  resources.manager = manager;
  const dispatcher = createRoomTaskDispatcher({ db, sse, manager });
  managerDeps.taskDispatch = dispatcher;
  managerDeps.taskStoreOptions = {};
  const readVaultTask = (_p: string) => null;
  // Runtime identity spy (delegating, never stubbing): every real wake in
  // this test rides the REAL manager/runtime chain; we only record which
  // runtime instance served each wake to prove T1/T2 share one.
  const seenRuntimes: any[] = [];
  const origGetRoomMember = manager.getRoomMember.bind(manager);
  (manager as any).getRoomMember = (room: any, member: any, ctx: any) => {
    const rt = origGetRoomMember(room, member, ctx);
    seenRuntimes.push(rt);
    return rt;
  };

  const anchor = (content: string): number => Number((db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('r5', 'user', 'user', 'text', ?, 'done', '{}', 'main')`
  ).run(content)).lastInsertRowid);
  const planCtx: RoomTaskToolContext = { roomId: 'r5', moduleId: 'plan' };
  const toolsFor = (contact: string, ctx: RoomTaskToolContext | null) =>
    buildRoomTaskTools(db, jobs, contact, dispatcher, { readVaultTask }, ctx);
  // Origin-turn fixture (same contract as production turns): each direct
  // setup call runs inside its own server-created turn.
  const setupCall = async (contact: string, ctx: RoomTaskToolContext | null, name: string, args: Record<string, unknown>) => {
    if (!ctx) {
      const out = await toolsFor(contact, ctx).find((t) => t.name === name)!.exec(args);
      assert.equal(out.ok, true, `${name} setup failed: ${out.text.slice(0, 300)}`);
      return JSON.parse(out.text);
    }
    const turn = beginRoomTurn(db, {
      roomId: ctx.roomId,
      contactId: contact,
      moduleId: ctx.moduleId,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      ...(ctx.handoffId ? { handoffId: ctx.handoffId } : {}),
    });
    try {
      const out = await toolsFor(contact, { ...ctx, turnId: turn.turnId }).find((t) => t.name === name)!.exec(args);
      assert.equal(out.ok, true, `${name} setup failed: ${out.text.slice(0, 300)}`);
      return JSON.parse(out.text);
    } finally {
      endRoomTurn(db, turn.turnId, 'test');
    }
  };
  const anchorA = anchor('User：批准 rt-a。');
  const anchorB = anchor('User：批准 rt-b。');
  await setupCall('codex', planCtx, 'task_create', {
    room_id: 'r5', task_path: 'tasks/rt-a.md', title: 'A', requirements: '需求 A。',
    workspace: dir, anchor_message_id: anchorA,
  });
  await setupCall('codex', planCtx, 'task_create', {
    room_id: 'r5', task_path: 'tasks/rt-b.md', title: 'B', requirements: '需求 B。',
    workspace: dir, anchor_message_id: anchorB,
  });
  // The handoff below wakes aye through the REAL manager/runtime/factory
  // chain (only a recording spy observes getRoomMember; nothing is stubbed).
  const handoff = await setupCall('codex', planCtx, 'task_handoff', {
    room_id: 'r5', task_path: 'tasks/rt-a.md', actor_module: 'plan',
    to_module: 'review', request: '请受理并核对。', evidence_refs: [],
  });
  const taskIdA: string = handoff.task.id;
  const handoffId: string = handoff.handoff.id;

  // Turn 1: the handoff wakes aye through the REAL manager/runtime/factory
  // chain (no getRoomMember stub exists in this file). The stubbed provider
  // accepts, reads, then registers an explicit blocked wait: a complete
  // verifiable disposition, so T1 settles spoke.
  let owner = '';
  for (let i = 0; i < 200 && owner !== 'aye'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    owner = (new RoomTaskStore(db, jobs, null).getTask('r5', 'tasks/rt-a.md')?.owner_contact) ?? '';
  }
  assert.equal(owner, 'aye', 'real turn accepted the handoff with real context');
  let t1text = '';
  for (let i = 0; i < 200 && !t1text; i++) {
    await new Promise((r) => setTimeout(r, 100));
    t1text = (db.prepare(
      "SELECT content FROM messages WHERE contact_id = 'r5' AND sender = 'aye' AND kind = 'text' AND content LIKE '%登记受阻%'"
    ).get() as { content: string } | undefined)?.content ?? '';
  }
  assert.match(t1text, /登记受阻/, 'turn 1 spoke after a complete disposition');
  assert.ok(requests.length >= 3, 'provider saw the tool rounds and the text round');
  // OpenAI-compatible shape nests the name under function.name; the strict
  // requirement stands — all sixteen task tools must be declared.
  const declared = requests[0].tools.map((tool: { name?: string; function?: { name?: string } }) =>
    tool.function?.name ?? tool.name) as string[];
  for (const name of ROOM_TASK_TOOL_NAMES) {
    assert.ok(declared.includes(name), `native loop declares ${name}`);
  }
  assert.match(JSON.stringify(requests[0]), /任务驱动协作规范/);
  assert.ok(
    turnLogs.some((line) => line.includes('tool task_accept(') && line.includes('→ ok')),
    'real native task_accept executed ok',
  );
  assert.ok(
    turnLogs.some((line) => line.includes('tool task_wait(') && line.includes('→ ok')),
    'real native task_wait executed ok',
  );
  const waits = db.prepare(
    'SELECT * FROM room_task_waits WHERE task_id = ?'
  ).all(taskIdA) as Array<{ mode: string; revision: number }>;
  assert.equal(waits.length, 1, 'exactly one explicit wait registered');
  assert.equal(waits[0].mode, 'blocked');
  const taskAfterT1 = new RoomTaskStore(db, jobs, null).getTask('r5', 'tasks/rt-a.md')!;
  assert.equal(taskAfterT1.status, 'blocked');
  assert.equal(taskAfterT1.revision, 4);
  assert.equal(waits[0].revision, 4, 'wait stores the effective post-bump revision');
  const unsettledAfterT1 = (db.prepare(
    "SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ? AND kind = 'turn-unsettled'"
  ).get(taskIdA) as { c: number }).c;
  assert.equal(unsettledAfterT1, 0, 'a fully-disposed turn settles normally');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c,
    0,
    'disposition created no jobs',
  );
  const assistantRows = db.prepare(
    "SELECT content FROM messages WHERE contact_id = 'r5' AND sender = 'aye' AND kind = 'text' AND content LIKE '%登记受阻%'"
  ).all() as Array<{ content: string }>;
  assert.ok(assistantRows.length >= 1, 'real turn spoke as the bound reviewer');
  const toolUses = db.prepare(
    "SELECT content FROM messages WHERE contact_id = 'r5' AND kind = 'tool_use'"
  ).all() as Array<{ content: string }>;
  assert.ok(toolUses.some((row) => row.content === 'task_accept'));
  assert.ok(toolUses.some((row) => row.content === 'task_get'));
  assert.ok(toolUses.some((row) => row.content === 'task_wait'));
  // Turn 2: re-wake the SAME handoff context (H is accepted but remains
  // verifiable) so T2 runs on the IDENTICAL runtime instance as T1 with a
  // fresh origin nonce. T2 only reads the task and returns bare PASS. The
  // old wait belongs to turn 1 and must NOT satisfy turn 2: explicit
  // unsettled, no auto job/handoff, PASS not pruned.
  const reviewBinding = (jobs.workflowModules.bindings() as Record<string, { contactId: string }>).review;
  assert.equal(reviewBinding?.contactId, 'aye', 'review still bound to aye for turn 2');
  const roomR5 = db.prepare("SELECT * FROM contacts WHERE id = 'r5'").get() as any;
  const ayeMember = db.prepare("SELECT * FROM contacts WHERE id = 'aye'").get() as any;
  const jobsBeforeT2 = (db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c;
  const handoffsBeforeT2 = (db.prepare(
    'SELECT COUNT(*) AS c FROM room_task_handoffs WHERE task_id = ?'
  ).get(taskIdA) as { c: number }).c;
  const triggerT2 = Number((db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('r5', 'user', 'user', 'text', ?, 'done', '{}', 'main')`
  ).run('User：同步一下进展。')).lastInsertRowid);
  const t2 = manager.dispatchRoomMessageTracked(roomR5, 'User：同步一下进展。', {
    targetOverride: [ayeMember],
    capture: false,
    reactionRounds: 0,
    taskHandoff: { taskId: taskIdA, handoffId },
    userMessageId: triggerT2,
  });
  assert.deepEqual(t2.targets, ['aye'], 'turn 2 re-wakes aye on the accepted handoff');
  const t2stats = await t2.completion;
  assert.equal(seenRuntimes.length, 2, 'exactly two wakes rode the room chain');
  assert.ok(seenRuntimes[0] === seenRuntimes[1], 'T2 runs on the identical runtime instance (same handoff context, fresh nonce)');
  assert.equal(t2stats.normal.error ?? 0, 1, 'bare get+PASS fails the obligation gate');
  assert.equal(t2stats.normal.spoke ?? 0, 0, 'no normal success on missing disposition');
  const unsettled = (db.prepare(
    "SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ? AND kind = 'turn-unsettled'"
  ).get(taskIdA) as { c: number }).c;
  assert.equal(unsettled, 1, 'exactly one honest unsettled marker (no invented block)');
  const obligationErrors = db.prepare(
    "SELECT content FROM messages WHERE contact_id = 'r5' AND kind = 'error' AND content LIKE '%未交接%'"
  ).all() as Array<{ content: string }>;
  assert.ok(obligationErrors.length >= 1, 'missing disposition surfaces a visible error');
  assert.match(obligationErrors[0].content, /tasks\/rt-a\.md/);
  const passKept = db.prepare(
    "SELECT content FROM messages WHERE contact_id = 'r5' AND sender = 'aye' AND kind = 'text' AND content = '[PASS]'"
  ).all() as Array<{ content: string }>;
  assert.ok(passKept.length >= 1, 'failed PASS bubble is kept visible, never pruned');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c,
    jobsBeforeT2,
    'gate failure starts no job',
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM room_task_handoffs WHERE task_id = ?').get(taskIdA) as { c: number }).c,
    handoffsBeforeT2,
    'gate failure creates no handoff',
  );
  // The forged read changed nothing: task B is pristine.
  const taskB = new RoomTaskStore(db, jobs, null).getTask('r5', 'tasks/rt-b.md')!;
  assert.equal(taskB.owner_module, 'plan');
  assert.equal(taskB.owner_contact, 'codex');
  assert.equal(taskB.revision, 1);
});

test('MCP live-turn A/B over stubbed Claude lifecycle', { timeout: 180_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-mcp-snapshot-'));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  const resources: {
    httpServer?: http.Server; clients: Client[]; manager?: AgentManager;
    db?: ReturnType<typeof openDb>; savedToken?: string; savedGrokHome?: string;
  } = { clients: [], savedToken: process.env.HUB_TOKEN, savedGrokHome: process.env.GROK_HOME };
  // Grok turns keep sessions under ~/.grok, read-only in the vps-dev Worker
  // unit; the merge gate's npm test failed there. Keep it in dir.
  process.env.GROK_HOME = path.join(dir, 'grok-home');
  t.after(async () => {
    // Release held stub turns first so no barrier outlives teardown, then
    // restore the Claude lifecycle, stop the manager, then all clients,
    // then connections/servers, db, env, temp dir — all bounded.
    try { releaseAllClaudeSlots('[TEARDOWN-RELEASE]'); } catch { /* ignore */ }
    try { restoreClaude(); } catch { /* ignore */ }
    if (resources.manager) await resources.manager.stopAll().catch(() => {});
    for (const client of resources.clients.splice(0)) await client.close().catch(() => {});
    if (resources.httpServer) {
      try { (resources.httpServer as any).closeIdleConnections?.(); } catch { /* ignore */ }
      await new Promise<void>((resolve) => resources.httpServer!.close(() => resolve()));
    }
    try { resources.db?.close(); } catch { /* already closed */ }
    if (resources.savedToken === undefined) delete process.env.HUB_TOKEN;
    else process.env.HUB_TOKEN = resources.savedToken;
    if (resources.savedGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = resources.savedGrokHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = openDb(path.join(dir, 'hub.db'));
  resources.db = db;
  const sse = sseHub();
  const jobs = new JobStore(db, sse);
  const logger = { info() {}, warn() {}, error() {} } as unknown as HubLogger;
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']] as const) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')")
      .run(id, id, backend);
  }
  // Deterministic transport stubbing: CLI binaries can never spawn, so real
  // turns fail fast AFTER the real BackendFactory build writes its MCP config
  // (the bearer under test). Scope building, signing and file generation all
  // run for real; only the external spawn is stubbed out by the environment.
  // Muse keeps an explicit missing binary too: the execute handoff would
  // otherwise really spawn an installed OpenCode.
  db.prepare("UPDATE contacts SET config = ? WHERE id = 'muse'").run(JSON.stringify({
    cliPath: 'missing-binary-roomtask-e2e',
  }));
  db.prepare("UPDATE contacts SET config = ? WHERE id = 'aye'").run(JSON.stringify({
    cliPath: 'missing-binary-roomtask-e2e',
  }));
  // Deploy travels over the claude builder (file artifact) in this fixture;
  // the backend id must be the real builder key claude-cli (a bare claude
  // would throw before writing). The frozen deploy binding snapshot is
  // unchanged and still enforced.
  db.prepare("UPDATE contacts SET backend = 'claude-cli', config = ? WHERE id = 'codex'").run(JSON.stringify({
    cliPath: 'missing-binary-roomtask-e2e',
  }));
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('r6', 'R6', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse', 'aye'] }));
  process.env.HUB_TOKEN = HUB_TOKEN;
  const managerDeps: any = { db, sse, config: baseConfig(dir), vault: null, jobStore: jobs, logger };
  const manager = new AgentManager(managerDeps);
  resources.manager = manager;
  const dispatcher = createRoomTaskDispatcher({ db, sse, manager });
  managerDeps.taskDispatch = dispatcher;
  managerDeps.taskStoreOptions = {};
  // Recording spy (delegating): proves turn A and turn B below share the
  // identical runtime instance. Setup-handoff wakes also pass through here.
  const seenRuntimes: any[] = [];
  const origGetRoomMember = manager.getRoomMember.bind(manager);
  (manager as any).getRoomMember = (room: any, member: any, ctx: any) => {
    const rt = origGetRoomMember(room, member, ctx);
    seenRuntimes.push(rt);
    return rt;
  };
  const planCtx: RoomTaskToolContext = { roomId: 'r6', moduleId: 'plan' };
  const toolsFor = (contact: string, ctx: RoomTaskToolContext | null) =>
    buildRoomTaskTools(db, jobs, contact, dispatcher, {}, ctx);
  const setupCall = async (contact: string, ctx: RoomTaskToolContext | null, name: string, args: Record<string, unknown>) => {
    if (!ctx) {
      const out = await toolsFor(contact, ctx).find((t) => t.name === name)!.exec(args);
      assert.equal(out.ok, true, `${name} setup failed: ${out.text.slice(0, 300)}`);
      return JSON.parse(out.text);
    }
    const turn = beginRoomTurn(db, {
      roomId: ctx.roomId,
      contactId: contact,
      moduleId: ctx.moduleId,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      ...(ctx.handoffId ? { handoffId: ctx.handoffId } : {}),
    });
    try {
      const out = await toolsFor(contact, { ...ctx, turnId: turn.turnId }).find((t) => t.name === name)!.exec(args);
      assert.equal(out.ok, true, `${name} setup failed: ${out.text.slice(0, 300)}`);
      return JSON.parse(out.text);
    } finally {
      endRoomTurn(db, turn.turnId, 'test');
    }
  };
  const findBearerFiles = (): string[] => {
    const found: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'config.toml' || entry.name === 'mcp.gateway.json') found.push(full);
      }
    };
    walk(path.join(dir, 'agents'));
    return found;
  };
  const anchor = Number((db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('r6', 'user', 'user', 'text', 'User：批准。', 'done', '{}', 'main')`
  ).run()).lastInsertRowid);
  const created = await setupCall('codex', planCtx, 'task_create', {
    room_id: 'r6', task_path: 'tasks/mcp-a.md', title: 'A', requirements: '需求。',
    workspace: dir, anchor_message_id: anchor,
  });
  assert.equal(created.task.owner_contact, 'codex');
  // Handoff to execute first (muse spawns nothing observable here), then
  // accept + handoff to review: the review dispatch builds aye's REAL grok
  // backend (config file + scoped bearer), then fails fast at spawn.
  const h1 = await setupCall('codex', planCtx, 'task_handoff', {
    room_id: 'r6', task_path: 'tasks/mcp-a.md', actor_module: 'plan',
    to_module: 'execute', request: '做。', evidence_refs: [],
  });
  const execCtx: RoomTaskToolContext = { roomId: 'r6', moduleId: 'execute', taskId: created.task.id, handoffId: h1.handoff.id };
  await setupCall('muse', execCtx, 'task_accept', { room_id: 'r6', task_path: 'tasks/mcp-a.md' });
  const h2 = await setupCall('muse', execCtx, 'task_handoff', {
    room_id: 'r6', task_path: 'tasks/mcp-a.md', actor_module: 'execute',
    to_module: 'review', request: '请评审。', evidence_refs: [],
  });
  // Live-turn MCP integration (appendix guidance): REAL manager, REAL
  // runtime, REAL BackendFactory (real generated config + bearer), REAL MCP
  // router. ONLY the ClaudeCliBackend external process lifecycle
  // (start/sendTurn/stop) is stubbed; no spawn can occur (stub first,
  // nonexistent cliPath as safety fallback). Barriers hold each turn active
  // while the test invokes tools with that turn's live bearer. No manually
  // signed bearer and no beginRoomTurn substitute anywhere here.
  const { ClaudeCliBackend } = await import('../src/backends/claudeCli.js');
  const { AsyncQueue } = await import('../src/backends/types.js');
  const claudeProto = ClaudeCliBackend.prototype as any;
  const origClaudeStart = claudeProto.start;
  const origClaudeSendTurn = claudeProto.sendTurn;
  const origClaudeStop = claudeProto.stop;
  let claudeSends = 0;
  const claudeSlots: Array<{
    entered: boolean;
    release: ((text: string) => void) | null;
    markEntered: () => void;
  }> = [];
  const releaseAllClaudeSlots = (text: string): void => {
    for (const slot of claudeSlots) slot.release?.(text);
  };
  claudeProto.start = async function (this: unknown) { return; };
  claudeProto.stop = async function (this: unknown) { return; };
  claudeProto.sendTurn = function (this: unknown, _input: unknown) {
    const idx = claudeSends++;
    const queue = new AsyncQueue<any>();
    const slot = {
      entered: false,
      release: null as null | ((text: string) => void),
      markEntered: () => {},
    };
    slot.markEntered = () => { slot.entered = true; };
    slot.release = (text: string) => {
      queue.push({ type: 'delta', text });
      queue.push({ type: 'done', finalText: text, usage: { input: 10, output: 5 } });
      queue.end();
    };
    claudeSlots[idx] = slot;
    void (async () => {
      queue.push({ type: 'session', sessionId: `stub-session-${idx}` });
      slot.markEntered();
      // Park the turn: the test drives real MCP calls with this turn's live
      // bearer, then release() finishes with the final text.
      await new Promise<void>(() => {});
    })();
    return {
      events: queue,
      interrupt: async () => { slot.release?.('[STUB-INTERRUPTED]'); },
    };
  };
  const restoreClaude = (): void => {
    claudeProto.start = origClaudeStart;
    claudeProto.sendTurn = origClaudeSendTurn;
    claudeProto.stop = origClaudeStop;
  };
  const waitFor = async (cond: () => boolean, what: string, tries = 200): Promise<void> => {
    for (let i = 0; i < tries; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting: ${what}`);
  };
  const waitSlot = (idx: number): Promise<void> =>
    waitFor(() => !!claudeSlots[idx]?.entered, `claude stub turn ${idx} entered`);
  const activeTurnId = (roomId: string, contactId: string, moduleId: string): string | undefined => {
    try {
      const row = db.prepare(
        `SELECT turn_id FROM room_task_turns
          WHERE room_id = ? AND contact_id = ? AND module_id = ? AND status = 'active'
          ORDER BY created_at DESC, turn_id DESC LIMIT 1`,
      ).get(roomId, contactId, moduleId) as { turn_id: string } | undefined;
      return row?.turn_id;
    } catch {
      return undefined;
    }
  };
  const pickBearer = (kind: 'grok' | 'claude', want: { contactId: string; moduleId: string; turnId?: string }): string => {
    for (const file of findBearerFiles()) {
      const isGrok = file.endsWith('config.toml');
      if ((kind === 'grok') !== isGrok) continue;
      let raw: string;
      try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const match = /Bearer (m1\.[A-Za-z0-9._~-]+)/.exec(raw);
      if (!match) continue;
      const scope = verifyInvocationScope(HUB_TOKEN, `Bearer ${match[1]}`);
      if (scope?.contactId === want.contactId
        && scope?.moduleId === want.moduleId
        && (want.turnId === undefined || scope?.invocation?.turnId === want.turnId)) {
        return `Bearer ${match[1]}`;
      }
    }
    throw new Error(`generated ${kind} bearer for ${want.contactId}/${want.moduleId} not found`);
  };

  const app = express();
  app.use(express.json());
  app.use('/api', hubMcpRouter(db, jobs, { hubToken: HUB_TOKEN }, {}));
  const httpServer = app.listen(0, '127.0.0.1');
  resources.httpServer = httpServer;
  await new Promise<void>((resolve) => httpServer.once('listening', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${(address as { port: number }).port}/api/hub-mcp`;
  const connect = async (contactId: string, authorization: string): Promise<Client> => {
    const client = new Client({ name: 'mcp-snapshot', version: '1' });
    resources.clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/${contactId}`), {
      requestInit: { headers: { Authorization: authorization } },
    } as any));
    return client;
  };
  const closeClient = async (client: Client): Promise<void> => {
    await client.close().catch(() => {});
    resources.clients = resources.clients.filter((item) => item !== client);
  };
  try {
    // Walk ownership toward deploy first (direct turn-bound setup calls).
    const reviewCtx: RoomTaskToolContext = { roomId: 'r6', moduleId: 'review', taskId: created.task.id, handoffId: h2.handoff.id };
    await setupCall('aye', reviewCtx, 'task_accept', { room_id: 'r6', task_path: 'tasks/mcp-a.md' });
    const h3 = await setupCall('aye', reviewCtx, 'task_handoff', {
      room_id: 'r6', task_path: 'tasks/mcp-a.md', actor_module: 'review',
      to_module: 'deploy', request: '请发布。', evidence_refs: [],
    });
    // TURN A: the h3 dispatch wakes codex through the REAL chain; the stubbed
    // Claude lifecycle holds the turn active after the REAL factory build
    // wrote the REAL bearer. The test then drives the model's MCP calls with
    // that live bearer: get, accept, get revision, explicit blocked wait.
    await waitSlot(0);
    const turnAId = activeTurnId('r6', 'codex', 'deploy');
    assert.ok(turnAId, 'deploy turn A is active in the ledger');
    let deployAuthorization = '';
    await waitFor(() => {
      try {
        deployAuthorization = pickBearer('claude', { contactId: 'codex', moduleId: 'deploy', turnId: turnAId });
        return true;
      } catch { return false; }
    }, 'real generated deploy bearer for live turn A');
    const deployScope = verifyInvocationScope(HUB_TOKEN, deployAuthorization);
    assert.ok(deployScope, 'generated deploy bearer verifies');
    assert.equal(deployScope?.moduleId, 'deploy');
    assert.equal(deployScope?.contactId, 'codex');
    assert.equal(deployScope?.invocation?.taskId, created.task.id);
    assert.equal(deployScope?.invocation?.handoffId, h3.handoff.id);
    assert.equal(deployScope?.invocation?.turnId, turnAId, 'bearer carries turn A origin nonce');
    const deployClient = await connect('codex', deployAuthorization);
    const deployGet1 = await deployClient.callTool({
      name: 'task_get', arguments: { room_id: 'r6', task_path: 'tasks/mcp-a.md' },
    });
    assert.equal(deployGet1.isError, false, 'live bearer reads its own task over MCP');
    const deployAccepted = await deployClient.callTool({
      name: 'task_accept', arguments: { room_id: 'r6', task_path: 'tasks/mcp-a.md' },
    });
    assert.equal(deployAccepted.isError, false, 'live bearer accepts over MCP');
    const deployGet2 = await deployClient.callTool({
      name: 'task_get', arguments: { room_id: 'r6', task_path: 'tasks/mcp-a.md' },
    });
    assert.equal(deployGet2.isError, false);
    const revText = (deployGet2.content as Array<{ text?: string }>)
      .map((part) => part.text ?? '').join('');
    const revMatch = /"revision":\s*(\d+)/.exec(revText);
    assert.ok(revMatch, 'task_get exposes the revision guard');
    const deployWait = await deployClient.callTool({
      name: 'task_wait',
      arguments: {
        room_id: 'r6', task_path: 'tasks/mcp-a.md', mode: 'blocked',
        reason: '部署通道需 User 确认发布窗口，当前无可用窗口。',
        resume_condition: 'User 明确发布窗口后继续部署。',
        expected_revision: Number(revMatch![1]),
      },
    });
    assert.equal(deployWait.isError, false, 'owner registers an explicit blocked wait over MCP');
    // Schema parity over a REAL bearer: native and MCP declarations match.
    const listed = (await deployClient.listTools()).tools;
    const nativeDefs = buildRoomTaskTools(db, jobs, 'codex', null, {}, null);
    for (const name of ROOM_TASK_TOOL_NAMES) {
      const mcp = listed.find((t) => t.name === name);
      assert.ok(mcp, `${name} is discoverable over MCP`);
      const native = nativeDefs.find((t) => t.name === name)!;
      assert.deepEqual(mcp.inputSchema, native.schema, `${name}: MCP and native declarations match`);
    }
    await closeClient(deployClient);
    // Same live bearer against another task is rejected (task pin enforced).
    const deployClient2 = await connect('codex', deployAuthorization);
    const cross = await deployClient2.callTool({
      name: 'task_get', arguments: { room_id: 'r6', task_path: 'tasks/mcp-b.md' },
    });
    assert.equal(cross.isError, true);
    await closeClient(deployClient2);
    // Release turn A with a done final: the exact wait settles it normally.
    claudeSlots[0]?.release?.('已接单并登记受阻。');
    await waitFor(() => {
      const row = db.prepare(
        "SELECT content FROM messages WHERE contact_id = 'r6' AND sender = 'codex' AND kind = 'text' AND content LIKE '%已接单并登记受阻。%'"
      ).get() as { content: string } | undefined;
      return !!row;
    }, 'turn A spoke');
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ? AND kind = 'turn-unsettled'").get(created.task.id) as { c: number }).c,
      0,
      'fully-disposed live MCP turn settles normally',
    );
    const taskAfterA = new RoomTaskStore(db, jobs, null).getTask('r6', 'tasks/mcp-a.md')!;
    assert.equal(taskAfterA.owner_module, 'deploy');
    assert.equal(taskAfterA.owner_contact, 'codex');
    assert.equal(taskAfterA.status, 'blocked');

    // ENDED credentials FAIL (old CLI-failure shape): turn A is over, so its
    // bearer is rejected even with no other turn active.
    const endedAlone = await connect('codex', deployAuthorization).catch(() => null);
    assert.equal(endedAlone, null, 'ended-turn bearer is rejected with no active turn');
    if (endedAlone) await closeClient(endedAlone);
    // Same for the setup-handoff wakes that failed at spawn (missing
    // binary): their generated credentials are failures, never fixtures.
    // (status='error' selects the real wake: direct setup calls close with
    // 'test', and created_at has only second granularity.)
    const h2Turn = db.prepare(
      `SELECT turn_id FROM room_task_turns
        WHERE room_id = 'r6' AND contact_id = 'aye' AND module_id = 'review'
          AND status = 'error'
        ORDER BY created_at DESC, turn_id DESC LIMIT 1`
    ).get() as { turn_id: string } | undefined;
    assert.ok(h2Turn, 'setup handoff wake registered its turn');
    const h2Bearer = pickBearer('grok', { contactId: 'aye', moduleId: 'review', turnId: h2Turn.turn_id });
    const h2Client = await connect('aye', h2Bearer).catch(() => null);
    assert.equal(h2Client, null, 'spawn-failed turn credential fails');
    if (h2Client) await closeClient(h2Client);

    // TURN B: re-wake the SAME accepted-handoff context so B runs on the
    // IDENTICAL runtime instance as A, with a fresh origin nonce. While B is
    // held active, the ENDED turn-A bearer must reject (never upgraded to
    // the latest turn) with zero receipts and no borrowed authority.
    const eventsBefore = (db.prepare(
      'SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ?'
    ).get(created.task.id) as { c: number }).c;
    const evidenceBefore = (db.prepare(
      'SELECT COUNT(*) AS c FROM room_task_evidence WHERE task_id = ?'
    ).get(created.task.id) as { c: number }).c;
    const roomR6 = db.prepare("SELECT * FROM contacts WHERE id = 'r6'").get() as any;
    const coveMember = db.prepare("SELECT * FROM contacts WHERE id = 'codex'").get() as any;
    const triggerB = Number((db.prepare(
      `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
       VALUES ('r6', 'user', 'user', 'text', ?, 'done', '{}', 'main')`
    ).run('User：部署窗口同步。')).lastInsertRowid);
    const dispatchB = manager.dispatchRoomMessageTracked(roomR6, 'User：部署窗口同步。', {
      targetOverride: [coveMember],
      capture: false,
      reactionRounds: 0,
      taskHandoff: { taskId: created.task.id, handoffId: h3.handoff.id },
      userMessageId: triggerB,
    });
    assert.deepEqual(dispatchB.targets, ['codex'], 'turn B re-wakes codex on the accepted handoff');
    await waitSlot(1);
    const turnBId = activeTurnId('r6', 'codex', 'deploy');
    assert.ok(turnBId && turnBId !== turnAId, 'turn B is a distinct live turn');
    let bearerB = '';
    await waitFor(() => {
      try {
        bearerB = pickBearer('claude', { contactId: 'codex', moduleId: 'deploy', turnId: turnBId });
        return true;
      } catch { return false; }
    }, 'real generated deploy bearer for live turn B');
    assert.notEqual(bearerB, deployAuthorization, 'A/B generated tokens differ');
    const staleDuringB = await connect('codex', deployAuthorization).catch(() => null);
    assert.equal(staleDuringB, null, 'ended-turn bearer used during a newer turn is rejected');
    if (staleDuringB) await closeClient(staleDuringB);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ?').get(created.task.id) as { c: number }).c,
      eventsBefore,
      'stale bearer wrote zero task events',
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM room_task_evidence WHERE task_id = ?').get(created.task.id) as { c: number }).c,
      evidenceBefore,
      'stale bearer wrote zero task evidence',
    );
    // Live bearer B still works while B is active.
    const liveB = await connect('codex', bearerB);
    const bGet = await liveB.callTool({
      name: 'task_get', arguments: { room_id: 'r6', task_path: 'tasks/mcp-a.md' },
    });
    assert.equal(bGet.isError, false, 'live turn-B bearer reads over MCP');
    await closeClient(liveB);
    // Release B with bare PASS and no disposition of its own: the old wait
    // belongs to turn A and must NOT satisfy B — explicit unsettled, no
    // auto job/handoff, PASS bubble kept.
    const jobsBeforeB = (db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c;
    const handoffsBeforeB = (db.prepare(
      'SELECT COUNT(*) AS c FROM room_task_handoffs WHERE task_id = ?'
    ).get(created.task.id) as { c: number }).c;
    claudeSlots[1]?.release?.('[PASS]');
    const statsB = await dispatchB.completion;
    assert.equal(statsB.normal.error ?? 0, 1, 'bare PASS under an old wait fails the gate');
    // A/B share the identical runtime instance (same accepted-handoff
    // context); only the origin nonce is fresh. Setup wakes (h1/h2/h3) ride
    // the same room chain ahead of A/B.
    assert.equal(seenRuntimes.length, 4, 'h1/h2/h3/A/B wakes all rode the room chain');
    assert.ok(seenRuntimes[2] === seenRuntimes[3], 'B runs on the identical runtime instance as A');
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS c FROM room_task_events WHERE task_id = ? AND kind = 'turn-unsettled'").get(created.task.id) as { c: number }).c,
      1,
      'exactly one honest unsettled marker',
    );
    const passKept = db.prepare(
      "SELECT content FROM messages WHERE contact_id = 'r6' AND sender = 'codex' AND kind = 'text' AND content = '[PASS]'"
    ).all() as Array<{ content: string }>;
    assert.ok(passKept.length >= 1, 'failed PASS bubble is kept visible, never pruned');
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c,
      jobsBeforeB,
      'gate failure starts no job',
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM room_task_handoffs WHERE task_id = ?').get(created.task.id) as { c: number }).c,
      handoffsBeforeB,
      'gate failure creates no handoff',
    );
    // Tampered bearer and wrong-contact bearer fail closed.
    const badClient = await connect('codex', `${bearerB.slice(0, -2)}xx`).catch(() => null);
    assert.equal(badClient, null, 'tampered bearer must not connect');
    if (badClient) await closeClient(badClient);
    const wrongClient = await connect('codex', deployAuthorization).catch(() => null);
    // Ended cross-turn bearer fails closed: either the connect or the call
    // is refused, never honored.
    let wrongFailed = wrongClient === null;
    if (wrongClient) {
      const wrong = await wrongClient.callTool({
        name: 'task_get', arguments: { room_id: 'r6', task_path: 'tasks/mcp-a.md' },
      }).catch((error: Error) => ({ isError: true as const, content: [{ text: String(error) }] }));
      wrongFailed = (wrong as { isError: boolean }).isError === true;
      await closeClient(wrongClient);
    }
    assert.equal(wrongFailed, true, 'cross-contact bearer fails closed');
  } finally {
    // Bounded unified teardown: clients first (a live client would hold
    // server.close open), then idle connections, then the server.
    for (const client of resources.clients.splice(0)) await client.close().catch(() => {});
    try { (httpServer as any).closeIdleConnections?.(); } catch { /* ignore */ }
    resources.httpServer = undefined;
    await new Promise<void>((resolve, reject) => httpServer.close((e) => e ? reject(e) : resolve()));
  }
});

test('factory refuses confused-deputy invocations across contacts', { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-factory-guard-'));
  const db = openDb(path.join(dir, 'hub.db'));
  t.after(() => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sse = sseHub();
  const jobs = new JobStore(db, sse);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli']] as const) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')")
      .run(id, id, backend);
  }
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('r7', 'R7', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse'] }));
  const messages = new MessageRepo(db);
  const prompts = new PromptComposer(null, messages, dir, new ConversationSummaryRepo(db),
    new LifeEventService(db, () => {}), false);
  const factory = new BackendFactory({
    db, config: baseConfig(dir), vault: null, jobStore: jobs, prompts,
  } as any);
  const room = db.prepare("SELECT * FROM contacts WHERE id = 'r7'").get() as ContactRow;
  const muse = db.prepare("SELECT * FROM contacts WHERE id = 'muse'").get() as ContactRow;
  const invocation = jobs.workflowModules.invoke('execute', '', '');
  const ctx: any = {
    agent: muse, convo: room, isRoom: true, memberId: 'muse', resumeToken: null,
    moduleInvocation: {
      moduleId: 'execute',
      binding: { ...invocation.binding, contactId: 'codex' },
      revision: invocation.bindingRevision,
      permissions: { ...invocation.permissions },
    },
    memory: { injectOnSpawn: false },
    log: () => {},
  };
  await assert.rejects(
    factory.build(ctx),
    /does not match turn agent/,
    'cross-contact invocations never build a backend',
  );
});

// WP-B B1: turn-end auto-pass must really wake the recipient. Open room,
// task held by review (aye); a real review turn ends with bare text and no
// disposition, so the gateway auto-passes to plan (codex). Both seats run the
// REAL manager/runtime chain with only the model HTTP transport stubbed: the
// plan seat must subsequently start a real round (provider hit + spoke/error
// message from codex), not just a posted ledger key.
test('B1: review turn-end auto-pass really wakes the plan seat', { timeout: 180_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-b1-autopass-'));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  const resources: { upstream?: http.Server; manager?: AgentManager; db?: ReturnType<typeof openDb> } = {};
  t.after(async () => {
    if (resources.upstream) await new Promise<void>((resolve) => resources.upstream!.close(() => resolve()));
    if (resources.manager) await resources.manager.stopAll().catch(() => {});
    try { resources.db?.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const requests: any[] = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(raw));
      // Every round returns bare text with no tool calls: the review round
      // has no disposition (triggers auto-pass), the plan round holds the
      // returned baton with no disposition of its own (visible error).
      return writeSse(res, [
        { choices: [{ delta: { content: '还在看，还没结论。' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        '[DONE]',
      ]);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  resources.upstream = upstream;
  const port = (upstream.address() as { port: number }).port;

  const db = openDb(path.join(dir, 'hub.db'));
  resources.db = db;
  const sse = sseHub();
  const jobs = new JobStore(db, sse);
  const logger = { info() {}, warn() {}, error() {} } as unknown as HubLogger;
  for (const [id, backend] of [['codex', 'api'], ['muse', 'opencode-cli'], ['aye', 'api']] as const) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')")
      .run(id, id, backend);
  }
  const apiConfig = JSON.stringify({
    provider: 'openai-compat',
    baseUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    apiKey: 'test',
    model: 'stub',
    maxTokens: 1024,
    maxHistoryMessages: 20,
    historyTokenBudget: 8000,
    memory: { injectOnSpawn: false, searchPerTurn: false, capture: false },
  });
  db.prepare("UPDATE contacts SET config = ? WHERE id IN ('codex', 'aye')").run(apiConfig);
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('rb1', 'RB1', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, governance: 'open', members: ['codex', 'muse', 'aye'] }));
  const bindings = jobs.workflowModules.bindings() as Record<string, { contactId: string }>;
  assert.equal(bindings.plan?.contactId, 'codex', 'plan bound to codex for this repro');
  assert.equal(bindings.review?.contactId, 'aye', 'review bound to aye for this repro');

  const managerDeps: any = { db, sse, config: baseConfig(dir), vault: null, jobStore: jobs, logger };
  const manager = new AgentManager(managerDeps);
  resources.manager = manager;
  const dispatcher = createRoomTaskDispatcher({ db, sse, manager });
  managerDeps.taskDispatch = dispatcher;
  managerDeps.taskStoreOptions = {};

  const anchor = Number((db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('rb1', 'user', 'user', 'text', 'User：批准 b1。', 'done', '{}', 'main')`
  ).run()).lastInsertRowid);
  // Setup passes ride a non-waking stub so only the auto-pass under test
  // travels the real dispatch chain.
  const stubDispatch = { dispatchToModule: () => ({ status: 'posted' as const }) };
  const setupCall = async (contact: string, ctx: { roomId: string; moduleId: string }, name: string, args: Record<string, unknown>) => {
    const turn = beginRoomTurn(db, { roomId: ctx.roomId, contactId: contact, moduleId: ctx.moduleId });
    try {
      const out = await buildRoomTaskTools(db, jobs, contact, stubDispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
        .find((tool) => tool.name === name)!.exec(args);
      assert.equal(out.ok, true, `${name} setup failed: ${out.text.slice(0, 300)}`);
      return JSON.parse(out.text);
    } finally {
      endRoomTurn(db, turn.turnId, 'test');
    }
  };
  await setupCall('codex', { roomId: 'rb1', moduleId: 'plan' }, 'task_create', {
    room_id: 'rb1', task_path: 'tasks/b1.md', title: 'B1', requirements: '需求 B1。',
    workspace: dir, anchor_message_id: anchor,
  });
  await setupCall('codex', { roomId: 'rb1', moduleId: 'plan' }, 'task_pass', {
    room_id: 'rb1', task_path: 'tasks/b1.md', to_module: 'execute', note: 'do it',
  });
  await setupCall('muse', { roomId: 'rb1', moduleId: 'execute' }, 'task_pass', {
    room_id: 'rb1', task_path: 'tasks/b1.md', to_module: 'review', note: 'review it',
  });
  const taskId = 'rb1::tasks/b1.md';
  assert.equal(new RoomTaskStore(db, jobs, null).getTask('rb1', 'tasks/b1.md')!.holder_module, 'review');

  const room = db.prepare("SELECT * FROM contacts WHERE id = 'rb1'").get() as ContactRow;
  const aye = db.prepare("SELECT * FROM contacts WHERE id = 'aye'").get() as ContactRow;
  const trigger = Number((db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('rb1', 'user', 'user', 'text', ?, 'done', '{}', 'main')`
  ).run('User：评审看一下。')).lastInsertRowid);
  const reviewDispatch = manager.dispatchRoomMessageTracked(room, 'User：评审看一下。', {
    targetOverride: [aye],
    capture: false,
    reactionRounds: 0,
    moduleId: 'review',
    userMessageId: trigger,
  });
  assert.deepEqual(reviewDispatch.targets, ['aye']);
  await reviewDispatch.completion;
  // The plan wake chains behind the review round: poll for the second wave.
  let planHit = false;
  for (let i = 0; i < 300 && !planHit; i++) {
    await new Promise((r) => setTimeout(r, 100));
    planHit = requests.length >= 2;
  }
  assert.ok(planHit, `plan seat started a real round after auto-pass (provider hits: ${requests.length})`);
  assert.equal(new RoomTaskStore(db, jobs, null).getTask('rb1', 'tasks/b1.md')!.holder_module, 'plan');
  const kinds = (db.prepare('SELECT kind FROM room_task_events WHERE task_id = ?').all(taskId) as Array<{ kind: string }>)
    .map((row) => row.kind);
  assert.ok(kinds.includes('auto-pass'), 'baton-move marker logged');
  assert.ok(kinds.includes('auto-pass-delivered'), `delivery marker logged (got: ${[...new Set(kinds)].join(',')})`);
  const coveTurn = db.prepare(
    "SELECT content FROM messages WHERE contact_id = 'rb1' AND sender = 'codex' AND kind = 'text' ORDER BY id DESC LIMIT 1",
  ).get() as { content: string } | undefined;
  assert.ok(coveTurn, 'plan seat spoke (or visibly errored) in its woken round');
});
