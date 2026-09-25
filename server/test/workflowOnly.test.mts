// Workflow-only master boundary (server side).
//
// Covers REVIEW_R1: server workflowOnly.enabled master overrides per-contact
// memory.capture / lifeEvents=on / heartbeat.enabled; auxiliary DS
// hooks (capture, natural-language taskWriteback, life-events
// extraction) stay off in BOTH DM runtime and room manager intake; heartbeat
// start/startSession/runOnce/tick stay blocked incl. old sessions and manual
// HTTP reactivation (audit preserved); normal user chat (incl. DS-model
// backends) and required Worker receipts/outbox stay intact. Integrated test
// proves mode + overused worker daily budgets -> real scan/process/HubClient /
// messages/manager/gateway/claim with only the final model faked.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isWorkflowOnlyEnabled } from '../src/platform/config.js';
import { openDb, type ContactRow } from '../src/platform/db.js';
import { AgentManager } from '../src/runtime/manager.js';
import { AgentRuntime } from '../src/runtime/runtime.js';
import { PromptComposer, type PromptContext } from '../src/prompt/promptComposer.js';
import { MessageRepo } from '../src/messages/messageRepo.js';
import { LifeEventService, lifeEventsEnabled } from '../src/companion/lifeEvents.js';
import { CompanionHeartbeat, HeartbeatError } from '../src/heartbeat/companionHeartbeat.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { messagesRouter } from '../src/runtime/messageRoutes.js';
import { workersRouter } from '../src/jobs/workerRoutes.js';
import type { SseHub } from '../src/platform/sse.js';
import type { HubLogger } from '../src/platform/logger.js';
import { AsyncQueue, type AgentBackend, type TurnEvent } from '../src/backends/types.js';
// @ts-expect-error cross-package worker ESM for the real sweep state machine
import { coordinationMethods } from '../../worker/triage/domains/coordination.mjs';
// @ts-expect-error cross-package worker ESM for the real processOne pipeline
import { pipelineMethods } from '../../worker/triage/pipeline.mjs';
// @ts-expect-error cross-package worker ESM for the real triage ledger
import { TriageStore } from '../../worker/triage/triage-store.mjs';
// @ts-expect-error cross-package worker ESM for the real hub HTTP client
import { HubClient } from '../../worker/triage/triage-clients.mjs';
// @ts-expect-error cross-package worker ESM for the canonical sweep source
import { COORDINATION_SWEEP_SOURCE } from '../../worker/triage/triage-shared.mjs';
import { parseCoordinationTask } from '../../worker/triage/triage-core.mjs';

function dsCounter() {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        should_capture: true, shouldCapture: true, candidate: true,
        action: 'progress', task_query: '验收', taskQuery: '验收',
        confidence: 0.99, category: 'other', subject: 'x',
        valence: 0.5, arousal: 0.4, reason: 'must-never-fire',
        events: [],
      }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
  });
  return {
    server,
    calls: () => calls,
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      return `http://127.0.0.1:${address.port}`;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function withDsEnv(baseUrl: string, run: () => Promise<void>): Promise<void> {
  const previousBase = process.env.DEEPSEEK_API_BASE_URL;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousModel = process.env.DEEPSEEK_CAPTURE_MODEL;
  process.env.DEEPSEEK_API_BASE_URL = `${baseUrl}/chat/completions`;
  process.env.DEEPSEEK_API_KEY = 'workflow-only-test-key';
  process.env.DEEPSEEK_CAPTURE_MODEL = 'deepseek-v4-flash';
  return run().finally(() => {
    if (previousBase === undefined) delete process.env.DEEPSEEK_API_BASE_URL;
    else process.env.DEEPSEEK_API_BASE_URL = previousBase;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.DEEPSEEK_CAPTURE_MODEL;
    else process.env.DEEPSEEK_CAPTURE_MODEL = previousModel;
  });
}

test('workflowOnly config master defaults off and overrides contact flags', () => {
  assert.equal(isWorkflowOnlyEnabled(undefined), false);
  assert.equal(isWorkflowOnlyEnabled(null), false);
  assert.equal(isWorkflowOnlyEnabled({}), false);
  assert.equal(isWorkflowOnlyEnabled({ workflowOnly: { enabled: false } }), false);
  assert.equal(isWorkflowOnlyEnabled({ workflowOnly: { enabled: true } }), true);
});

test('prompt blocks stay off in workflowOnly despite contact opt-ins', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-wo-prompt-'));
  const db = openDb(path.join(dir, 'hub.db'));
  try {
    db.prepare("INSERT INTO contacts(id,name,backend,kind,config) VALUES ('claude','Claude','claude-cli','dm',?)")
      .run(JSON.stringify({ affect: 'on', lifeEvents: 'on', memory: { capture: true } }));
    db.prepare("INSERT INTO contacts(id,name,backend,kind,config) VALUES ('codex','Codex','claude-cli','dm',?)")
      .run(JSON.stringify({ affect: 'on', lifeEvents: 'on' }));
    const claude = db.prepare('SELECT * FROM contacts WHERE id=?').get('claude') as ContactRow;
    const codex = db.prepare('SELECT * FROM contacts WHERE id=?').get('codex') as ContactRow;
    assert.equal(lifeEventsEnabled(claude), true);

    const life = new LifeEventService(db, () => {});
    // codex sees claude-sourced safety event; claude himself is source-filtered.
    life.repo.insert({
      severity: 'safety', summary: '家里一楼进水并跳闸断电', note: '断电',
      sourceContactId: 'claude', now: new Date(),
    });

    const memory: any = {
      mcpUrl: null, repoPath: null, injectOnSpawn: false, searchPerTurn: false,
      capture: true, maxTurnChars: 1200, sessionMaxAgeHours: 12,
    };
    const ctxFor = (agent: ContactRow) => ({
      agent, convo: agent, isRoom: false, memory,
      userName: 'User', nameOf: (sender: string) => sender, log: () => {},
    }) as PromptContext;

    const open = new PromptComposer(null, new MessageRepo(db), null, null, life, false);
    const openTurn = await open.composeTurn(ctxFor(codex), '在吗', '在吗', new Set());
    assert.match(openTurn, /CROSS_CONTACT_STATE/, 'contact opt-in must inject life events when master off');

    const closed = new PromptComposer(null, new MessageRepo(db), null, null, life, true);
    const closedTurn = await closed.composeTurn(ctxFor(codex), '在吗', '在吗', new Set());
    assert.doesNotMatch(closedTurn, /CROSS_CONTACT_STATE/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DM turn with overrides chats normally and fires zero auxiliary DS/vault writes', async () => {
  const ds = dsCounter();
  const baseUrl = await ds.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-wo-dm-'));
  const uploadsDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const db = openDb(path.join(dir, 'hub.db'));
  let vaultCalls = 0;
  try {
    db.prepare("INSERT INTO contacts(id,name,backend,kind,config) VALUES ('claude','Claude','api','dm',?)")
      .run(JSON.stringify({
        provider: 'openai-compat', apiKey: 'test', model: 'test-model',
        affect: 'on', lifeEvents: 'on',
        memory: { injectOnSpawn: false, searchPerTurn: false, capture: true },
        heartbeat: { enabled: true },
      }));
    const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get('claude') as ContactRow;
    assert.equal(lifeEventsEnabled(contact), true);

    const userMessageId = Number(db.prepare(
      "INSERT INTO messages(contact_id,sender,role,kind,content,status,meta,origin) VALUES ('claude','user','user','text',?,'done','{}','main')"
    ).run('项目 Alpha 的验收要过几天再做，记一下').lastInsertRowid);

    const config: any = {
      port: 3900, host: '127.0.0.1', dbPath: path.join(dir, 'hub.db'),
      agentsDir: dir, webDist: '', uploadsDir, releasesDir: dir,
      claude: { cliPath: 'claude' },
      codex: { cliPath: 'codex' },
      grok: { cliPath: 'grok' },
      opencode: { cliPath: 'opencode' },
      api: { turnTimeoutMs: 5000 },
      memory: {
        mcpUrl: null, repoPath: null, injectOnSpawn: false, searchPerTurn: false,
        capture: true, maxTurnChars: 1200, sessionMaxAgeHours: 12,
      },
      backup: { enabled: false, dir, intervalHours: 24, keep: 1 },
      purge: { enabled: false, messagesRetentionDays: 14, jobsRetentionDays: 30, intervalHours: 24, batchSize: 100 },
      workflowOnly: { enabled: true },
    };
    // Explicit-chat vault reads (same-day diary) stay allowed; ancillary
    // capture/writeback paths (write_inbox, task search/reads) must not fire.
    const vault: any = {
      call: async (name: string, args: any) => {
        if (name === 'read_file' && String(args?.path ?? '').startsWith('diary/')) return '';
        vaultCalls += 1;
        throw new Error(`vault.call must not fire in workflowOnly: ${name}`);
      },
      write: async () => { vaultCalls += 1; throw new Error('vault.write must not fire in workflowOnly'); },
    };
    const backend: AgentBackend = {
      kind: 'api',
      alive: () => true,
      start: async () => {},
      stop: async () => {},
      sendTurn: () => {
        const events = new AsyncQueue<TurnEvent>();
        events.push({ type: 'delta', text: '收到，按你说的办' });
        events.push({ type: 'done', finalText: '收到，按你说的办' });
        events.end();
        return { events, interrupt: async () => {} };
      },
    };
    const runtime = new AgentRuntime(contact, contact, {
      db, sse: { broadcast() {} } as unknown as SseHub,
      config, vault, jobStore: null,
    });
    (runtime as any).backend = backend;
    await withDsEnv(baseUrl, async () => {
      const tracked = runtime.enqueueTracked({ userMessageId, text: '项目 Alpha 的验收要过几天再做，记一下' });
      assert.equal(tracked.status, 'queued');
      const result = await tracked.completion;
      assert.equal(result.outcome, 'done');
      assert.equal(result.text, '收到，按你说的办', 'explicit user chat must still work');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(ds.calls(), 0, 'capture/writeback/affect/life-events DS must not fire');
      assert.equal(vaultCalls, 0, 'vault capture/writeback must not fire');
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE contact_id='claude' AND sender='room-host'").get() as { c: number }).c,
        0,
      );
    });
    // No auxiliary ledger rows from this turn.
    assert.equal((db.prepare("SELECT COUNT(*) AS c FROM task_writebacks").get() as { c: number }).c, 0);
  } finally {
    await ds.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('room intake with overrides stays quiet while room function is preserved', async () => {
  const ds = dsCounter();
  const baseUrl = await ds.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-wo-room-'));
  const db = openDb(path.join(dir, 'hub.db'));
  let vaultCalls = 0;
  try {
    db.prepare("INSERT INTO contacts(id,name,backend,kind,config) VALUES ('codex','Codex','claude-cli','dm','{}')").run();
    db.prepare("INSERT INTO contacts(id,name,backend,kind,config) VALUES ('room-wo','工作房','room','room',?)")
      .run(JSON.stringify({ members: ['codex'], memory: { capture: true } }));
    const room = db.prepare('SELECT * FROM contacts WHERE id=?').get('room-wo') as ContactRow;
    const config: any = {
      memory: { capture: true }, agentsDir: dir, workflowOnly: { enabled: true },
    };
    const vault: any = {
      call: async () => { vaultCalls += 1; throw new Error('room vault.call must not fire'); },
      write: async () => { vaultCalls += 1; throw new Error('room vault.write must not fire'); },
    };
    const manager = new AgentManager({
      db, sse: { broadcast() {} } as unknown as SseHub, config, vault,
      jobStore: null, logger: { info() {}, warn() {}, error() {} } as unknown as HubLogger,
    });
    (manager as any).getRoomMember = () => ({
      async runRoomTurn() { return 'spoke'; },
    });
    const userMessageId = Number(db.prepare(
      "INSERT INTO messages(contact_id,sender,role,kind,content,status,meta,origin) VALUES ('room-wo','user','user','text',?,'done','{}','main')"
    ).run('项目 Alpha 进展顺利，记一下').lastInsertRowid);
    await withDsEnv(baseUrl, async () => {
      const result = manager.dispatchRoomMessageTracked(room, '项目 Alpha 进展顺利，记一下', { userMessageId });
      assert.ok(Array.isArray(result.targets), 'room routing must still resolve');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(ds.calls(), 0);
      assert.equal(vaultCalls, 0);
    });
  } finally {
    await ds.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('heartbeat old session and manual entry stay blocked with audit preserved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-wo-heartbeat-'));
  const db = openDb(path.join(dir, 'hub.db'));
  try {
    db.prepare("INSERT INTO contacts(id,name,backend,kind,config) VALUES ('gem','Gem','api','dm',?)")
      .run(JSON.stringify({ heartbeat: { enabled: true } }));
    db.prepare("INSERT INTO contacts(id,name,backend,kind,config) VALUES ('codex','Codex','api','dm',?)")
      .run(JSON.stringify({ heartbeat: { enabled: true } }));
    let state = 'idle';
    let ticks = 0;
    const rt = {
      recoverHeartbeatError() { state = 'idle'; return true; },
      enqueueTracked() {
        ticks += 1;
        return { status: 'queued', completion: Promise.resolve({ outcome: 'done' as const, text: 'HEARTBEAT_OK' }) };
      },
    };
    const config: any = { uploadsDir: dir, workflowOnly: { enabled: false } };
    const heartbeat = new CompanionHeartbeat({
      db, manager: { statusOf: () => ({ state }), get: () => rt } as any,
      sse: { broadcast() {} } as any, broker: {} as any, config, random: () => 0,
    });
    heartbeat.startSession('gem', null);
    const session = db.prepare('SELECT id FROM heartbeat_sessions WHERE contact_id=? AND stopped_at IS NULL').get('gem') as { id: string };
    assert.ok(session?.id, 'old session must exist before the mode flips');
    // Flip the master live (OT: production requires restart; the guard reads live config).
    config.workflowOnly.enabled = true;
    db.prepare("UPDATE heartbeat_sessions SET last_tick_at='2020-01-01T00:00:00Z' WHERE id=?").run(session.id);
    await heartbeat.runOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ticks, 0, 'old session must not tick in workflowOnly');
    assert.throws(() => heartbeat.startSession('codex', 30), HeartbeatError);
    try {
      heartbeat.startSession('codex', 30);
      assert.fail('manual reactivation must throw');
    } catch (error) {
      assert.match((error as Error).message, /workflow-only/);
    }
    heartbeat.start();
    assert.equal((heartbeat as any).timer, null, 'restart must not arm the ticker');
    const preserved = db.prepare('SELECT id, stopped_at FROM heartbeat_sessions WHERE id=?').get(session.id) as any;
    assert.equal(preserved.id, session.id, 'session audit history must be preserved');
    assert.equal(preserved.stopped_at, null);
    assert.equal(heartbeat.status('gem').active, true, 'status must still report the parked session');
    heartbeat.stop();
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integrated workflowOnly + overused budgets: real scan/process/HubClient/manager/gateway/claim', async () => {
  const ds = dsCounter();
  const dsBase = await ds.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-wo-handoff-'));
  const tasksDir = path.join(dir, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  const uploadsDir = path.join(dir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const db = openDb(path.join(dir, 'hub.db'));
  const sse = { broadcast() {} } as unknown as SseHub;
  const jobs = new JobStore(db, sse);
  const logger = { warn() {}, info() {}, error() {} } as unknown as HubLogger;
  const WORKER_TOKEN = 'wo-handoff.secret-local-only';

  for (const [id, name, backend] of [
    ['codex', 'Codex', 'codex'],
    ['sora', 'Sora', 'opencode-cli'],
    ['aye', '阿野', 'grok-cli'],
    ['claude', 'Claude', 'claude-cli'],
  ] as const) {
    const overrides = id === 'claude'
      ? { affect: 'on', lifeEvents: 'on', memory: { capture: true }, heartbeat: { enabled: true } }
      : {};
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', ?)")
      .run(id, name, backend, JSON.stringify(overrides));
  }
  const roomConfig = JSON.stringify({
    workflowEnabled: true,
    members: ['codex', 'sora', 'aye'],
    coordination: { enabled: true },
    memory: { capture: true },
  });
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-wo-handoff', '交接房', 'room', 'room', ?)")
    .run(roomConfig);
  db.prepare(`INSERT INTO workers (id, name, token_hash, capabilities, status, accepting_jobs, last_seen_at)
    VALUES ('wo-handoff', 'test', ?, ?, 'online', 1, datetime('now'))`)
    .run(
      crypto.createHash('sha256').update(WORKER_TOKEN).digest('hex'),
      JSON.stringify({ runners: ['codex', 'opencode'], workspaces: [dir], shell: true, ssh: false }),
    );
  const bound = jobs.workflowModules.setBinding('execute', {
    contactId: 'sora', runner: 'opencode',
    model: 'opencode-go/muse-spark-1.3-contributor', reasoning: 'high',
  }, jobs.workflowModules.revision(), 'User');
  assert.equal(bound.ok, true);

  const managerDeps: any = {
    db, sse,
    config: {
      memory: { capture: true }, agentsDir: dir, workflowOnly: { enabled: true },
    },
    jobStore: jobs,
    vault: {
      call: async () => { throw new Error('integrated vault.call must not fire'); },
      write: async () => { throw new Error('integrated vault.write must not fire'); },
    },
  };
  const manager = new AgentManager(managerDeps);
  const wakeCalls: Array<{ member: string; context: any }> = [];
  (manager as any).getRoomMember = (_room: any, member: any, context: any) => ({
    async runRoomTurn(_mode: string) {
      wakeCalls.push({ member: member.id, context });
      return 'spoke';
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/contacts', messagesRouter(db, sse, manager, uploadsDir, undefined, jobs));
  app.use('/api', workersRouter(db, sse, jobs));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  const hub = new HubClient({ baseUrl: origin, timeoutMs: 15000 });
  const triage = new TriageStore(path.join(dir, 'triage.db'));
  const worker: any = {
    config: {
      workflowOnly: { enabled: true },
      breakers: { dailyEvents: 2, dailyCostCny: 0.001 },
      coordination: {
        enabled: true, roomId: 'room-wo-handoff', hostName: 'DS 主持',
        tasksDir, dailyLimit: 8, scanIntervalMinutes: 5,
        hubAutoHygiene: { enabled: false },
      },
    },
    store: triage,
    hub: {
      dispatchRoomHost: async (roomId: string, input: any) => hub.dispatchRoomHost(roomId, input),
    },
    vault: { enabled: false },
    nextCoordinationPollAt: 0,
    enqueue(event: any) { return this.store.enqueue(event); },
    // Fail-on-call worker DS: the deterministic execution branch must never
    // reach L1. Only the final model work (stubbed getRoomMember above) is faked.
    deepseek: {
      triage: async () => { throw new Error('worker DS triage must not fire on essential path'); },
      fuzzyRoute: async () => { throw new Error('worker DS fuzzyRoute must not fire on essential path'); },
    },
    ...coordinationMethods,
    ...pipelineMethods,
  };

  // Overused daily background budgets: tiny breakers + seeded cost/events.
  {
    const seed = triage;
    for (let i = 0; i < 5; i += 1) {
      const enq = seed.enqueue({ source: 'seed-overuse', summary: `old ${i}`, dedupeKey: `wo-overuse-${i}` });
      const claimed = seed.claim(Date.now() + i);
      assert.equal(claimed.id, enq.id);
      seed.finish(claimed.id, 'dispatched', {
        recipientId: 'room-wo-handoff',
        triageResult: {
          actionable: true, needsLocalExec: true, category: 'coordination',
          priority: 2, suggestedRecipient: 'sora', rationale: 'seeded overuse',
        },
        costCny: 1,
      }, Date.now() + i);
    }
    const summary = seed.dailySummary();
    assert.ok(summary.total >= 2, 'dailyEvents must be overused');
    assert.ok(summary.costCny >= 0.001, 'dailyCostCny must be overused');
  }

  const raw = [
    '---', 'type: task', 'status: open', 'source: codex', '---', '',
    '# WorkflowOnly 集成派单', '',
    'User 已批准走工作流；Plan 经 vault 任务工具写成 dispatch-ready。', '',
    '## Plan（Codex，2026-09-12）', '',
    '### 目标', '- 集成验证。', '',
    '### 执行者与工作区',
    '- executor: sora',
    `- 工作区：\`${dir}\`：\`git checkout -b wo-handoff origin/master\`。`,
    '- 验证：npm test。',
  ].join('\n');
  fs.writeFileSync(path.join(tasksDir, 'wo-task.md'), raw);
  const parsed = parseCoordinationTask(raw, { taskPath: 'tasks/wo-task.md' });
  assert.ok(parsed && parsed.executor === 'sora');

  try {
    await withDsEnv(dsBase, async () => {
      // Retired scan: nothing enqueues despite overused budgets being
      // irrelevant now; a manually queued legacy payload drains as noop
      // through the REAL processOne pipeline without Hub sends or DS.
      worker.nextCoordinationPollAt = 0;
      const before = (triage.db.prepare('SELECT COUNT(*) AS c FROM triage_events').get() as { c: number }).c;
      await worker.scanCoordinationIfDue(Date.now());
      const after = (triage.db.prepare('SELECT COUNT(*) AS c FROM triage_events').get() as { c: number }).c;
      assert.equal(after, before, 'retired scan enqueues nothing');
      const legacy = triage.enqueue({
        source: COORDINATION_SWEEP_SOURCE,
        categoryHint: 'coordination',
        summary: 'legacy stranded payload',
        dedupeKey: 'wo-legacy-payload',
        payload: { mode: 'coordination', task: { taskPath: 'tasks/wo-task.md' } },
      });
      const worked = await worker.processOne();
      assert.equal(worked, true, 'real processOne must claim and drain the legacy event');
      const status = (triage.db.prepare('SELECT status FROM triage_events WHERE id=?').get(legacy.id) as any).status;
      assert.equal(status, 'noop', 'legacy payloads drain as noop');
      assert.equal(ds.calls(), 0, 'server auxiliary DS must not fire for retired payloads');
      assert.equal(wakeCalls.length, 0, 'no host wakes under workflowOnly retirement');

      // Explicit ledger continuation still works: import + handoff + accept
      // + execution_start, then claim the approved job over HTTP.
      const { buildRoomTaskTools } = await import('../src/roomTasks/roomTaskTools.js');
      const anchor = Number((db.prepare(
        `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
         VALUES ('room-wo-handoff', 'user', 'user', 'text', 'User：批准继续。', 'done', '{}', 'main')`
      ).run()).lastInsertRowid);
      const planCtx = { roomId: 'room-wo-handoff', moduleId: 'plan' } as const;
      const toolsFor = (contact: string, ctx: any) =>
        buildRoomTaskTools(db, jobs, contact, null, {}, ctx);
      // Origin-turn fixture: direct calls run inside a server-created turn.
      const call = async (contact: string, ctx: any, name: string, args: Record<string, unknown>) => {
        const { beginRoomTurn, endRoomTurn } = await import('../src/roomTasks/turnAttribution.js');
        const turn = beginRoomTurn(db, {
          roomId: ctx.roomId,
          contactId: contact,
          moduleId: ctx.moduleId,
          ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
          ...(ctx.handoffId ? { handoffId: ctx.handoffId } : {}),
        });
        try {
          const out = await toolsFor(contact, { ...ctx, turnId: turn.turnId }).find((t: any) => t.name === name)!.exec(args);
          assert.equal(out.ok, true, `${name} failed: ${out.text.slice(0, 300)}`);
          return JSON.parse(out.text);
        } finally {
          endRoomTurn(db, turn.turnId, 'test');
        }
      };
      const created = await call('codex', planCtx, 'task_create', {
        room_id: 'room-wo-handoff', task_path: 'tasks/wo-task.md', title: 'WO 继续',
        requirements: '集成验证需求。', workspace: dir, anchor_message_id: anchor,
      });
      const handoff = await call('codex', planCtx, 'task_handoff', {
        room_id: 'room-wo-handoff', task_path: 'tasks/wo-task.md', actor_module: 'plan',
        to_module: 'execute', request: '实现并验证', evidence_refs: [],
      });
      const execCtx = { roomId: 'room-wo-handoff', moduleId: 'execute', taskId: created.task.id, handoffId: handoff.handoff.id };
      const accepted = await call('sora', execCtx, 'task_accept', {
        room_id: 'room-wo-handoff', task_path: 'tasks/wo-task.md',
      });
      const started = await call('sora', execCtx, 'execution_start', {
        room_id: 'room-wo-handoff', task_path: 'tasks/wo-task.md', module: 'execute',
        expected_revision: accepted.task.revision, workspace: dir,
        objective: '集成验证', return_to_module: 'plan',
      });
      assert.equal((db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c, 1);
      const claimed = await (await fetch(`${origin}/api/worker/claim`, {
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
      })).json() as any;
      assert.ok(claimed.job?.id, 'Worker must claim the approved job');
      assert.equal(claimed.job.id, started.job.id);
      assert.equal(parsed.taskPath, 'tasks/wo-task.md');
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await manager.stopAll();
    jobs.stopOutOfBandResolver();
    triage.close();
    db.close();
    await ds.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
