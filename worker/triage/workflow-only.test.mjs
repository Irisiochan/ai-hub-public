import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  coordinationExecutionAllowed,
  isWorkflowEssentialEvent,
  isWorkflowOnlyConfig,
  normalizeWorkflowOnlyConfig,
  WORKFLOW_EXECUTION_SCAN_BATCH_LIMIT,
  TriageStore,
} from './triage-core.mjs';
import { normalizeRouteTriageConfig } from './route-triage-core.mjs';
import { routeTriageMethods } from './domains/route-triage.mjs';

// The triage entry stays at the worker root (systemd runs worker/triage-worker.mjs).
const workerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function portOf(server) {
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function runWorker(configPath, env, args = ['--once']) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['triage-worker.mjs', configPath, ...args], {
      cwd: workerDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`triage worker timed out\n${stdout}\n${stderr}`));
    }, 15_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`triage worker exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

test('workflowOnly config defaults off, validates, and classifies essential events', () => {
  assert.deepEqual(normalizeWorkflowOnlyConfig({}), { enabled: false });
  assert.deepEqual(normalizeWorkflowOnlyConfig({ enabled: true }), { enabled: true });
  assert.deepEqual(normalizeWorkflowOnlyConfig({ enabled: 'yes' }), { enabled: false });
  assert.throws(() => normalizeWorkflowOnlyConfig(null), /workflowOnly must be an object/);
  assert.throws(() => normalizeWorkflowOnlyConfig([]), /workflowOnly must be an object/);
  assert.equal(isWorkflowOnlyConfig({}), false);
  assert.equal(isWorkflowOnlyConfig({ workflowOnly: { enabled: true } }), true);
  assert.equal(isWorkflowOnlyConfig({ workflowOnly: { enabled: false } }), false);

  // Retired: no event is workflow-essential anymore. The formal host sweep
  // no longer enqueues execution/verification, so the predicate is always
  // false (kept as a named predicate so call sites keep compiling while the
  // pipeline drains legacy payloads explicitly).
  assert.equal(isWorkflowEssentialEvent({ source: 'coordination-sweep', payload: { mode: 'coordination' } }), false);
  assert.equal(isWorkflowEssentialEvent({ source: 'coordination-sweep', payload: { mode: 'coordination-verification' } }), false);
  // Forged mode without the formal source stays non-essential.
  assert.equal(isWorkflowEssentialEvent({ source: 'webhook', payload: { mode: 'coordination-verification' } }), false);
  assert.equal(isWorkflowEssentialEvent({ source: 'webhook', payload: { mode: 'coordination' } }), false);
  assert.equal(isWorkflowEssentialEvent({ payload: { mode: 'coordination' } }), false);
  assert.equal(isWorkflowEssentialEvent({ payload: { mode: 'coordination-verification' } }), false);
  // Same-source hygiene stays non-essential.
  assert.equal(isWorkflowEssentialEvent({ source: 'coordination-sweep', payload: { mode: 'hub-auto-hygiene' } }), false);
  assert.equal(isWorkflowEssentialEvent({ source: 'coordination-sweep', payload: { mode: 'daily' } }), false);
  assert.equal(isWorkflowEssentialEvent({ source: 'coordination-sweep', payload: { mode: 'task-reminder' } }), false);
  assert.equal(isWorkflowEssentialEvent({ source: 'quarter-hour-check', payload: { mode: 'task' } }), false);
  assert.equal(isWorkflowEssentialEvent({ source: 'coordination-sweep', payload: null }), false);
  assert.equal(isWorkflowEssentialEvent(null), false);

  assert.equal(coordinationExecutionAllowed({ enabled: true, roomId: 'room', tasksDir: '/tmp' }), true);
  assert.equal(coordinationExecutionAllowed({ enabled: false, roomId: 'room', tasksDir: '/tmp' }), false);
  assert.equal(coordinationExecutionAllowed({ enabled: true, roomId: '', tasksDir: '/tmp' }), false);
  assert.ok(WORKFLOW_EXECUTION_SCAN_BATCH_LIMIT >= 1);
});

test('retired execution scan dispatches nothing with and without workflowOnly', async () => {
  for (const workflowOnly of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-workflow-quota-'));
    const tasksDir = path.join(dir, 'tasks');
    fs.mkdirSync(tasksDir);
    const stateFile = path.join(dir, 'triage.db');
    const dispatched = [];
    let deepseekCalls = 0;
    fs.writeFileSync(path.join(tasksDir, 'eligible.md'), [
      '---',
      'type: task',
      'status: open',
      'executor: codex',
      '---',
      '',
      '# Quota removal E2E',
      '',
      '## Plan（2026-09-12）',
      '',
      '- 工作区：`C:\\ai-hub-codex`：`git checkout -b quota-removed origin/master`。',
      '- 验证：npm test。',
    ].join('\n'));

    const deepseek = await listen((req, res) => {
      deepseekCalls += 1;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'formal execution must not call L1' }));
    });
    const hub = await listen((req, res) => {
      if (req.method === 'POST' && req.url === '/api/contacts/room/room-host/messages') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          dispatched.push(JSON.parse(raw));
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ messageId: 900 + dispatched.length, roundId: `round-${dispatched.length}` }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    const configPath = path.join(dir, 'triage.json');
    fs.writeFileSync(configPath, JSON.stringify({
      stateFile,
      workflowOnly: { enabled: workflowOnly },
      // Tiny daily background budgets: essential formal execution must bypass
      // BOTH the retired coordination.dailyLimit and these breakers.
      breakers: { dailyEvents: 2, dailyCostCny: 0.001 },
      categories: ['daily', 'system', 'coordination', 'other'],
      deepseek: {
        baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        flashModel: 'deepseek-v4-flash',
        proModel: 'deepseek-v4-pro',
      },
      hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
      vault: { url: '' },
      routing: { rules: {}, fuzzyFallback: false },
      proactive: { enabled: false, silentStartHour: 0, silentEndHour: 0 },
      coordination: { enabled: true, roomId: 'room', tasksDir, dailyLimit: 8, scanIntervalMinutes: 5 },
      outcomes: { enabled: false, intervalMinutes: 5 },
      followups: { enabled: false },
      taskReminders: { enabled: false },
      backlogSweep: { enabled: false },
      agenda: { enabled: false },
      routeTriage: { enabled: false },
      sources: [],
    }));

    try {
      // Populate OLD daily usage: 100 coordination-pool deliveries (well above
      // the retired 8/day cap) + daily background budgets exceeded
      // (total events + cost) before the new scan runs.
      const seed = new TriageStore(stateFile);
      try {
        for (let i = 0; i < 100; i += 1) {
          const enq = seed.enqueue({
            source: 'seed-old-usage',
            summary: `old usage ${i}`,
            dedupeKey: `old-usage-${i}`,
          });
          const claimed = seed.claim(Date.now() + i);
          assert.equal(claimed.id, enq.id);
          seed.recordDelivery(claimed.id, 'room', Date.now() + i, 'coordination', { messageId: 1000 + i });
          seed.finish(claimed.id, 'dispatched', {
            recipientId: 'room',
            triageResult: {
              actionable: true, needsLocalExec: true, category: 'coordination',
              priority: 2, suggestedRecipient: 'codex', rationale: 'seeded old usage',
            },
            costCny: 1,
          }, Date.now() + i);
        }
        assert.equal(seed.poolUsage('coordination', Date.now()).count, 100);
        const summary = seed.dailySummary();
        assert.ok(summary.total >= 2, 'breaker dailyEvents must be overused');
        assert.ok(summary.costCny >= 0.001, 'breaker dailyCostCny must be overused');
      } finally {
        seed.close();
      }

      await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
      assert.equal(deepseekCalls, 0, `workflowOnly=${workflowOnly}: retired scan must not call DS`);
      assert.equal(dispatched.length, 0, `workflowOnly=${workflowOnly}: retired scan must not dispatch even with 100 old pool rows + overused breaker budgets`);

      const check = new TriageStore(stateFile);
      try {
        // The 100 old pooled rows stay pure observability: the retired scan
        // adds nothing on top in either mode.
        assert.equal(check.poolUsage('coordination', Date.now()).count, 100);
      } finally {
        check.close();
      }
    } finally {
      await Promise.all([close(deepseek), close(hub)]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('workflowOnly suppresses queued retry/webhook/manual non-essential without DS or send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-workflow-suppress-'));
  const tasksDir = path.join(dir, 'tasks');
  fs.mkdirSync(tasksDir);
  const stateFile = path.join(dir, 'triage.db');
  const dispatched = [];
  let deepseekCalls = 0;

  const deepseek = await listen((req, res) => {
    deepseekCalls += 1;
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          actionable: true, needsLocalExec: false, category: 'other',
          priority: 2, suggestedRecipient: 'codex', rationale: 'must never be reached',
        }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
  });
  const hub = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/api/contacts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        contacts: [
          { id: 'codex', name: 'Codex', kind: 'dm', state: 'idle', config: {} },
          { id: 'room', name: 'room', kind: 'room', state: 'idle', config: { members: ['codex'] } },
        ],
      }));
      return;
    }
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        dispatched.push({ url: req.url, body: JSON.parse(raw) });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ queued: true, messageId: 1000 + dispatched.length }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  // Vault mock: returns an eligible snapshot so a non-workflowOnly system
  // timer would fail-open into L1. In workflowOnly the timers never run, so
  // this also proves startSources stays silent.
  const eligibleSnapshot = [
    '任务快照日期：2026-09-12',
    '',
    '## ⏰ 时间敏感事项',
    '- **真实工作** (`tasks/real-work.md`)（无期限，仍未完成）',
  ].join('\n');
  const vault = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'wo-session' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202); res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: message.id,
          result: { content: [{ type: 'text', text: eligibleSnapshot }] },
        }));
      }
    });
  });

  const configPath = path.join(dir, 'triage.json');
  const baseConfig = {
    stateFile,
    workflowOnly: { enabled: true },
    // Tiny budgets: nonessential must be claimed-noop BEFORE breaker (not retry).
    breakers: { dailyEvents: 2, dailyCostCny: 0.001 },
    categories: ['system', 'daily', 'idea', 'coordination', 'other', 'backlog'],
    deepseek: {
      baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
      apiKeyEnv: 'TEST_DEEPSEEK_KEY',
      flashModel: 'deepseek-v4-flash',
      proModel: 'deepseek-v4-pro',
    },
    hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
    vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp` },
    routing: { rules: {}, fuzzyFallback: true },
    proactive: { enabled: true, dailyDispatchLimit: 10, silentStartHour: 0, silentEndHour: 0, recipients: ['codex'] },
    taskReminders: { enabled: true, intervalMinutes: 45, recipient: 'codex' },
    idea: { enabled: true, roomId: 'room' },
    coordination: {
      enabled: true, roomId: 'room', tasksDir, dailyLimit: 8, scanIntervalMinutes: 5,
      hubAutoHygiene: { enabled: true, staleDays: 14 },
    },
    agenda: { enabled: true, atHour: 9, atMinute: 0 },
    routeTriage: { enabled: true, reviewer: 'aye', atHour: 9, atMinute: 10 },
    diary: { enabled: true, atHour: 2, atMinute: 30 },
    outcomes: { enabled: false, intervalMinutes: 5 },
    followups: { enabled: true },
    backlogSweep: { enabled: true },
    sources: [
      { id: 'quarter-hour-check', type: 'timer', intervalMinutes: 15, jitterSeconds: 0, category: 'system', summary: 'Review backlog.' },
      { id: 'daily-check-in', type: 'timer', mode: 'daily', intervalMinutes: 45, jitterSeconds: 0, category: 'daily', summary: 'Daily check.' },
      { id: 'daily-idea-room', type: 'timer', mode: 'idea', intervalMinutes: 1440, jitterSeconds: 0, category: 'idea', summary: 'Idea.' },
      { id: 'diary-rollup', type: 'diary-rollup' },
    ],
  };
  fs.writeFileSync(configPath, JSON.stringify(baseConfig));

  // Pre-existing queued + retry non-essential events, including one with a
  // cached actionable triageResult (must not dispatch without fresh DS),
  // one forged webhook coordination lookalike without the essential mode,
  // and R2 forged-mode regressions: webhook source forging formal
  // payload.mode values (fresh + cached actionable) — mode alone never
  // suffices, the formal sweep source is required.
  const seed = new TriageStore(stateFile);
  const seedIds = [];
  try {
    const inputs = [
      { source: 'quarter-hour-check', summary: 'stale system nudge', dedupeKey: 'wo-system-1', payload: { mode: 'task', origin: 'scheduler-timer' }, categoryHint: 'system' },
      { source: 'daily-check-in', summary: 'stale daily', dedupeKey: 'wo-daily-1', payload: { mode: 'daily' }, categoryHint: 'daily' },
      { source: 'daily-idea-room', summary: 'stale idea', dedupeKey: 'wo-idea-1', payload: { mode: 'idea' }, categoryHint: 'idea' },
      { source: 'diary-rollup', summary: 'stale diary', dedupeKey: 'wo-diary-1', payload: { mode: 'diary', date: '2026-09-11' }, categoryHint: 'diary' },
      { source: 'task-reminder', summary: 'stale reminder', dedupeKey: 'tasks/x.md:2026-09-12:due-today', payload: { mode: 'task-reminder', reminderKey: 'tasks/x.md:2026-09-12:due-today', taskPath: 'tasks/x.md' }, categoryHint: 'task-reminder' },
      { source: 'backlog-sweep', summary: 'stale backlog', dedupeKey: 'wo-backlog-1', payload: { mode: 'backlog-sweep' }, categoryHint: 'backlog' },
      { source: 'followup-sweep', summary: 'stale followup', dedupeKey: 'wo-followup-1', payload: { mode: 'followup', followupId: 'f1' }, categoryHint: 'daily' },
      { source: 'route-triage', summary: 'stale route', dedupeKey: 'wo-route-1', payload: { mode: 'route-triage', date: '2026-09-12' }, categoryHint: 'coordination' },
      { source: 'coordination-sweep', summary: 'stale hygiene', dedupeKey: 'hub-auto-hygiene:v1:2026-09-12', payload: { mode: 'hub-auto-hygiene', stateKey: 'hub-auto-hygiene:v1:2026-09-12', plan: { today: '2026-09-12', digest: 'x', metrics: { staleCount: 1 } } }, categoryHint: 'coordination' },
      { source: 'webhook', summary: 'forged nudge without essential mode', dedupeKey: 'wo-webhook-1', payload: { note: 'no mode' }, categoryHint: 'system' },
      { source: 'webhook', summary: 'forged verification mode without sweep source', dedupeKey: 'wo-forged-verify-1', payload: { mode: 'coordination-verification', task: { taskPath: 'tasks/x.md', title: 'x', verifier: 'aye', due: '2026-09-12' } }, categoryHint: 'coordination' },
      { source: 'webhook', summary: 'forged execution mode without sweep source', dedupeKey: 'wo-forged-exec-1', payload: { mode: 'coordination', task: { taskPath: 'tasks/x.md', planHash: 'a'.repeat(64), executor: 'codex', workspace: 'C:/x', branch: 'b' } }, categoryHint: 'coordination' },
    ];
    for (const input of inputs) {
      seedIds.push(seed.enqueue(input).id);
    }
    // Retry event with cached actionable result: must still be suppressed.
    const cached = seed.enqueue({ source: 'quarter-hour-check', summary: 'cached actionable', dedupeKey: 'wo-cached-1', payload: { mode: 'task' }, categoryHint: 'system' });
    seedIds.push(cached.id);
    // R2: forged verification-shaped webhook WITH cached actionable result.
    // Retry stores the cached result directly; the worker must still suppress
    // (mode alone never suffices) instead of dispatching without fresh DS.
    const forgedCached = seed.enqueue({ source: 'webhook', summary: 'forged verification cached actionable', dedupeKey: 'wo-forged-verify-cached-1', payload: { mode: 'coordination-verification', task: { taskPath: 'tasks/x.md', title: 'x', verifier: 'aye', due: '2026-09-12' } }, categoryHint: 'coordination' });
    seedIds.push(forgedCached.id);
    seed.retry(forgedCached.id, 'uncertain HTTP response', 1000, {
      triageResult: {
        actionable: true, needsLocalExec: false, category: 'coordination',
        priority: 2, suggestedRecipient: 'aye', rationale: 'forged cached actionable',
      },
    }, Date.now());
    const claimed = seed.claim(Date.now());
    assert.equal(claimed.id, seedIds[0]);
    seed.retry(claimed.id, 'uncertain HTTP response', 1000, {
      triageResult: {
        actionable: true, needsLocalExec: false, category: 'system',
        priority: 2, suggestedRecipient: 'codex', rationale: 'cached from before disable',
      },
    }, Date.now());
    const cachedClaim = seed.claim(Date.now() + 60_000);
    // The retry above is not yet due (1000ms); claim the cached-actionable row
    // by advancing time past its backoff in the worker run instead. Requeue check:
    assert.ok(cachedClaim === null || typeof cachedClaim.id === 'string');
  } finally {
    seed.close();
  }

  try {
    const result = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(deepseekCalls, 0, 'workflowOnly must never call DS (fail-on-call)');
    assert.equal(dispatched.length, 0, `workflowOnly must never proactively send, got ${JSON.stringify(dispatched)}`);
    assert.match(result.stdout, /workflow-only: timer sources disabled/);
    assert.match(result.stdout, /workflow-only suppressed non-essential event/);

    // Manual timer entrypoints must also stay quiet (no DS, no send).
    for (const args of [['--once', '--sweep'], ['--once', '--agenda'], ['--once', '--route-triage']]) {
      const beforeDs = deepseekCalls;
      const beforeSend = dispatched.length;
      await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' }, args);
      assert.equal(deepseekCalls, beforeDs, `${args.join(' ')} must not call DS`);
      assert.equal(dispatched.length, beforeSend, `${args.join(' ')} must not send`);
    }
    {
      const beforeDs = deepseekCalls;
      const beforeSend = dispatched.length;
      await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' }, ['--once', '--task-reminders']);
      assert.equal(deepseekCalls, beforeDs, '--task-reminders must not call DS in workflowOnly');
      assert.equal(dispatched.length, beforeSend, '--task-reminders must not send in workflowOnly');
    }

    // Ledger preserved: all seeded events still exist, none dispatched, none
    // erased. Due suppressed events are claimed noop BEFORE breaker (never a
    // breaker retry); a seed-time retry whose backoff has not elapsed yet may
    // still be retry with its original error and turns noop when due.
    const check = new TriageStore(stateFile);
    try {
      const rows = check.db.prepare('SELECT id, status, error FROM triage_events').all();
      assert.ok(rows.length >= seedIds.length, 'ledger must preserve all seeded events');
      for (const row of rows) {
        assert.notEqual(row.status, 'dispatched', `event ${row.id} must not dispatch in workflowOnly`);
        assert.doesNotMatch(
          String(row.error ?? ''), /breaker|daily event breaker|daily cost breaker/,
          `event ${row.id} must be suppressed before breaker, not breaker-retry`,
        );
        if (row.status === 'retry') {
          assert.match(String(row.error ?? ''), /uncertain HTTP response/,
            `premature retry row must carry its seed error, not a new dispatch attempt: ${row.id}`);
        }
      }
      const summary = check.dailySummary();
      assert.equal(summary.coordinationPoolDispatched, 0);
      assert.equal(summary.dailyPoolDispatched, 0);
    } finally {
      check.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Windows SQLite WAL release race: best-effort cleanup, never fail the test.
    }
  }
});

test('workflowOnly pauses idea-diary vault outbox without deleting pending rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-workflow-outbox-'));
  const stateFile = path.join(dir, 'triage.db');
  const store = new TriageStore(stateFile);
  const event = store.enqueue({ source: 'daily-idea-room', summary: 'idea', dedupeKey: 'wo-outbox-event' });
  const claimed = store.claim(Date.now());
  assert.equal(claimed.id, event.id);
  store.completeIdea(claimed.id, {
    roomId: 'room',
    triageResult: {
      actionable: true, category: 'idea', priority: 1, suggestedRecipient: 'room',
      rationale: 'seeded', stage: 'completed', topic: 't', ideaCategory: 'work',
      summary: 's', summaryMessageId: 9,
    },
    vaultWrite: {
      id: 'idea-diary:paused-test',
      dedupeKey: 'idea:paused:9',
      payload: { slug: 'idea-paused', title: 'paused', content: 'x', tags: [], source: 'test' },
    },
  }, Date.now());
  store.close();

  // Simulate processVaultOutboxOne with workflowOnly on: must not claim/write.
  const { pipelineMethods } = await import('./pipeline.mjs');
  let vaultWrites = 0;
  const fake = {
    config: { workflowOnly: { enabled: true } },
    store: new TriageStore(stateFile),
    vault: { enabled: true, writeDiary: async () => { vaultWrites += 1; } },
  };
  try {
    const worked = await pipelineMethods.processVaultOutboxOne.call(fake);
    assert.equal(worked, false);
    assert.equal(vaultWrites, 0);
    const check = new TriageStore(stateFile);
    try {
      const row = check.db.prepare("SELECT status FROM triage_vault_outbox WHERE id = 'idea-diary:paused-test'").get();
      assert.equal(row.status, 'pending');
    } finally {
      check.close();
    }
  } finally {
    fake.store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('workflowOnly blocks route triage stats direct dispatch even when enabled', async () => {
  // R2: maybePostRouteTriageStats lacked its own guard; resolve-path fencing
  // is not sufficient for direct calls.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-workflow-route-stats-'));
  const store = new TriageStore(path.join(dir, 'triage.db'));
  try {
    store.insertRouteSuggestions([{
      path: 'tasks/stats-demo.md', kind: 'task', suggestDate: '2026-09-12',
      stage: 'execute', recipient: 'codex', reason: 'stats guard regression',
      eventId: null, messageId: 1,
    }], Date.now());
    let hubCalls = 0;
    const coordination = { roomId: 'room', hostName: 'DS 主持', tasksDir: dir };
    const fake = {
      config: {
        workflowOnly: { enabled: true },
        coordination,
        proactive: { recipients: ['codex'], silentStartHour: 0, silentEndHour: 0 },
        // 2026-09-12 is a Saturday; force the weekly stats weekday to match.
        routeTriage: { enabled: true, roomId: 'room', reviewer: 'aye', statsWeekday: 6 },
      },
      store,
      hub: { dispatchRoomHost: async () => { hubCalls += 1; return { messageId: 1 }; } },
      routeTriageConfig() { return normalizeRouteTriageConfig(this.config.routeTriage, this.config.coordination); },
    };
    const result = await routeTriageMethods.maybePostRouteTriageStats.call(
      fake, Date.parse('2026-09-12T04:00:00Z'));
    assert.equal(result, false);
    assert.equal(hubCalls, 0, 'stats digest must not dispatch in workflowOnly');
    assert.equal(store.getSourceState('route-triage-stats:v1:2026-09-12'), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('retired scan stays silent with old usage and active timers configured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-workflow-essential-'));
  const tasksDir = path.join(dir, 'tasks');
  fs.mkdirSync(tasksDir);
  const stateFile = path.join(dir, 'triage.db');
  const dispatched = [];
  let deepseekCalls = 0;
  const today = new Date(Date.now() + 8 * 60 * 60_000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(tasksDir, 'plan-task.md'), [
    '---',
    'type: task',
    'status: open',
    'executor: codex',
    '---',
    '',
    '# Essential plan',
    '',
    '## Plan（2026-09-12）',
    '',
    '- 工作区：`C:\\ai-hub-codex`：`git checkout -b workflow-essential origin/master`。',
    '- 验证：npm test。',
  ].join('\n'));
  fs.writeFileSync(path.join(tasksDir, 'verify-task.md'), [
    '---',
    'type: task',
    'status: open',
    'verifier: aye',
    `due: ${today}`,
    '---',
    '',
    '# Essential verification',
    '',
    '## 验收标准',
    '- 逐条取证。',
  ].join('\n'));

  const deepseek = await listen((req, res) => {
    deepseekCalls += 1;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'essential path must not call L1' }));
  });
  const hub = await listen((req, res) => {
    if (req.method === 'POST' && req.url === '/api/contacts/room/room-host/messages') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        dispatched.push(JSON.parse(raw));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messageId: 600 + dispatched.length, roundId: `round-${dispatched.length}` }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  const configPath = path.join(dir, 'triage.json');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
    workflowOnly: { enabled: true },
    breakers: { dailyEvents: 2, dailyCostCny: 0.001 },
    categories: ['daily', 'system', 'coordination', 'other'],
    deepseek: {
      baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
      apiKeyEnv: 'TEST_DEEPSEEK_KEY',
      flashModel: 'deepseek-v4-flash',
      proModel: 'deepseek-v4-pro',
    },
    hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
    vault: { url: '' },
    routing: { rules: {}, fuzzyFallback: false },
    proactive: { enabled: true, dailyDispatchLimit: 10, silentStartHour: 0, silentEndHour: 0, recipients: ['codex'] },
    coordination: { enabled: true, roomId: 'room', tasksDir, dailyLimit: 8, scanIntervalMinutes: 5 },
    outcomes: { enabled: false, intervalMinutes: 5 },
    followups: { enabled: false },
    taskReminders: { enabled: false },
    backlogSweep: { enabled: false },
    agenda: { enabled: false },
    routeTriage: { enabled: false },
    sources: [
      { id: 'quarter-hour-check', type: 'timer', intervalMinutes: 15, jitterSeconds: 0, category: 'system', summary: 'Should stay silent in workflowOnly.' },
    ],
  }));

  try {
    const seed = new TriageStore(stateFile);
    try {
      for (let i = 0; i < 8; i += 1) {
        const enq = seed.enqueue({ source: 'seed', summary: `old ${i}`, dedupeKey: `old-${i}` });
        const claimed = seed.claim(Date.now() + i);
        seed.recordDelivery(claimed.id, 'room', Date.now() + i, 'coordination', { messageId: 2000 + i });
        seed.finish(claimed.id, 'dispatched', {
          recipientId: 'room',
          triageResult: { actionable: true, category: 'coordination', priority: 1, suggestedRecipient: null, rationale: 'old' },
          costCny: 1,
        }, Date.now() + i);
        assert.equal(enq.inserted, true);
      }
    } finally {
      seed.close();
    }

    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(deepseekCalls, 0);
    assert.equal(dispatched.length, 0, `retired scan dispatches neither execution nor verification, got ${JSON.stringify(dispatched.map((d) => d.coordination))}`);
  } finally {
    await Promise.all([close(deepseek), close(hub)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
