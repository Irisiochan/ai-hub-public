import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DELIVERY_POOL_COORDINATION,
  DELIVERY_POOL_TASK,
  executionDispatchKey,
  executionFingerprint,
  parseCoordinationTask,
  parseVerificationTask,
  shanghaiClock,
  shanghaiDateAt,
  TriageStore,
} from './triage-core.mjs';

const workerDir = path.dirname(fileURLToPath(import.meta.url));

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
    }, 10_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`triage worker exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

test('standalone worker closes the L0→L1→L2→L3 path with mocked services', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-e2e-'));
  const dispatched = [];
  const deepseek = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(body.model, 'deepseek-v4-flash');
      assert.deepEqual(body.thinking, { type: 'disabled' });
      const input = JSON.parse(body.messages[1].content);
      // backlogMaxChars: 4 truncates the open-task snapshot passed to L1.
      assert.equal(typeof input.recentBacklog, 'string');
      assert.ok(input.recentBacklog.length <= 4);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actionable: true,
              needsLocalExec: true,
              category: 'system',
              priority: 2,
              suggestedRecipient: input.event.summary.includes('non-member')
                ? 'external-engineering'
                : 'local-engineering',
              rationale: 'concrete scheduled check',
            }),
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
  });
  const hub = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/api/contacts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        contacts: [
          {
            id: 'codex',
            name: 'Codex',
            kind: 'dm',
            state: 'idle',
            config: {
              routing: {
                enabled: true,
                recipientKey: 'engineering',
                categories: ['system'],
                dailyLimit: 10,
                cooldownMinutes: 0,
              },
              delegation: { enabled: false },
            },
          },
          {
            id: 'claude',
            name: 'Claude',
            kind: 'dm',
            state: 'idle',
            config: {
              routing: {
                enabled: true,
                recipientKey: 'local-engineering',
                categories: ['system'],
                dailyLimit: 10,
                cooldownMinutes: 0,
              },
              delegation: { enabled: true },
            },
          },
          {
            id: 'aye',
            name: 'Aye',
            kind: 'dm',
            state: 'idle',
            config: {
              routing: {
                enabled: true,
                recipientKey: 'external-engineering',
                categories: ['system'],
                dailyLimit: 10,
                cooldownMinutes: 0,
              },
              delegation: { enabled: true },
            },
          },
          {
            id: 'room',
            name: '会议室',
            kind: 'room',
            state: 'idle',
            config: { members: ['claude'] },
          },
        ],
      }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      dispatched.push({ url: req.url, body: JSON.parse(raw) });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ queued: true, messageId: 101 }));
    });
  });
  // Eligible open task keeps the system-timer wake gate open so L1 still runs.
  // (Empty eligible set now short-circuits before L1 — see smoke-triage-wake-gate.)
  const eligibleSnapshot = [
    '任务快照日期：2026-08-11',
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
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'e2e-session',
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: eligibleSnapshot }] },
        }));
      }
    });
  });

  const configPath = path.join(dir, 'triage.json');
  const stateFile = path.join(dir, 'triage.db');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
    categories: ['system', 'other'],
    deepseek: {
      baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
      apiKeyEnv: 'TEST_DEEPSEEK_KEY',
      flashModel: 'deepseek-v4-flash',
      proModel: 'deepseek-v4-pro',
      backlogMaxChars: 4,
      pricing: { flash: { inputCnyPerMillion: 1, outputCnyPerMillion: 1 } },
    },
    hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
    vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp`, backlogQuery: 'triage-backlog' },
    routing: { rules: {}, fuzzyFallback: true },
    coordination: { enabled: true, roomId: 'room', tasksDir: dir, dailyLimit: 8 },
    sources: [
      {
        id: 'test-timer-member',
        type: 'timer',
        intervalMinutes: 15,
        jitterSeconds: 0,
        category: 'system',
        summary: 'Inspect one concrete member event.',
      },
      {
        id: 'test-timer-non-member',
        type: 'timer',
        intervalMinutes: 15,
        jitterSeconds: 0,
        category: 'system',
        summary: 'Inspect one concrete non-member event.',
      },
    ],
  }));

  try {
    const result = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.match(result.stdout, /"msg":"event dispatched"/);
    assert.equal(dispatched.length, 2);
    const roomDispatch = dispatched.find((item) => item.url === '/api/contacts/room/room-host/messages');
    const fallbackDispatch = dispatched.find((item) => item.url === '/api/contacts/aye/messages');
    assert.ok(roomDispatch);
    assert.ok(fallbackDispatch, JSON.stringify(dispatched));
    assert.match(roomDispatch.body.content, /后台任务 nudge/);
    assert.match(roomDispatch.body.content, /真实事件上下文/);
    assert.match(roomDispatch.body.content, /\[PASS\]/);
    assert.match(roomDispatch.body.content, /write_inbox/);
    assert.match(roomDispatch.body.content, /source=frontend-observation/);
    assert.match(roomDispatch.body.content, /不创建或更新 tasks\//);
    assert.match(roomDispatch.body.content, /delegate_to_worker/);
    assert.match(roomDispatch.body.content, /needsLocalExec=true/);
    assert.deepEqual(roomDispatch.body.targetIds, ['claude']);
    assert.equal(roomDispatch.body.reactionRounds, 0);
    assert.match(fallbackDispatch.body.content, /^【降级投递：/);
    assert.equal(fallbackDispatch.body.origin, 'main');
    assert.equal(fallbackDispatch.body.automated, true);
    assert.equal(fallbackDispatch.body.hidden, false);
    assert.equal(fallbackDispatch.body.automation.messageType, 'automation-trigger');
    assert.equal(fallbackDispatch.body.automation.eventSource, 'test-timer-non-member');
    assert.equal(fallbackDispatch.body.automation.eventCategory, 'system');
    assert.equal(fallbackDispatch.body.automation.eventPriority, 2);
    assert.ok(fallbackDispatch.body.automation.eventId);
    assert.equal(
      fallbackDispatch.body.idempotencyKey,
      `automation:${fallbackDispatch.body.automation.eventSource}:${fallbackDispatch.body.automation.eventId}`,
      'triage retries must reuse one deterministic hub message key'
    );
    const store = new TriageStore(stateFile);
    try {
      const summary = store.dailySummary();
      assert.equal(summary.statuses.find((row) => row.status === 'dispatched').count, 2);
      assert.deepEqual(summary.deliveries.map((row) => row.recipient_id).sort(), ['aye', 'claude', 'room']);
      assert.equal(summary.coordinationPoolDispatched, 2);
      // Room-routed nudges are delivered to the room, so the per-contact work quota keeps
      // its own task-pool ledger row for whoever was actually nudged.
      assert.equal(store.recipientUsage('claude', Date.now(), DELIVERY_POOL_TASK).count, 1);
      assert.equal(store.recipientUsage('aye', Date.now(), DELIVERY_POOL_TASK).count, 1);
      assert.equal(store.recipientUsage('room', Date.now(), DELIVERY_POOL_TASK).count, 0);
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS count FROM triage_deliveries WHERE executed_via = 'worker'").get().count,
        2,
      );
      assert.equal(summary.triagedCount, 2);
      assert.equal(Number.isInteger(summary.avgTriageLatencyMs), true);
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Task nudges land in the coordination room, so the delivery row is attributed to the room
// and the per-contact quota only survives through the task-pool ledger. These runs pin both
// blocking branches of chooseRecipient to real store state instead of a synthetic usageOf.
test('room-routed task nudges keep the per-contact quota and cooldown branches live', async () => {
  // Both nudges come from the same worker run, so the second one is only ever blocked by
  // what the first one actually wrote to the store — no hand-seeded delivery row.
  const runNudges = async ({ dailyLimit, cooldownMinutes, count }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-task-quota-e2e-'));
    const stateFile = path.join(dir, 'triage.db');
    const posts = [];
    const deepseek = await listen((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                actionable: true,
                needsLocalExec: false,
                category: 'system',
                priority: 2,
                suggestedRecipient: 'local-engineering',
                rationale: 'concrete scheduled check',
              }),
            },
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }));
      });
    });
    const hub = await listen((req, res) => {
      if (req.method === 'GET' && req.url === '/api/contacts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          contacts: [
            {
              id: 'claude',
              name: 'Claude',
              kind: 'dm',
              state: 'idle',
              config: {
                routing: {
                  enabled: true,
                  recipientKey: 'local-engineering',
                  categories: ['system'],
                  dailyLimit,
                  cooldownMinutes,
                },
                delegation: { enabled: true },
              },
            },
            {
              id: 'room',
              name: '会议室',
              kind: 'room',
              state: 'idle',
              config: { members: ['claude'] },
            },
          ],
        }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        posts.push({ url: req.url, body: JSON.parse(raw) });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ queued: true, messageId: 700 + posts.length }));
      });
    });
    const configPath = path.join(dir, 'triage.json');
    fs.writeFileSync(configPath, JSON.stringify({
      stateFile,
      categories: ['system', 'other'],
      deepseek: {
        baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        flashModel: 'deepseek-v4-flash',
        proModel: 'deepseek-v4-pro',
      },
      hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
      vault: { url: '' },
      routing: { rules: {}, fuzzyFallback: false },
      coordination: { enabled: true, roomId: 'room', tasksDir: dir, dailyLimit: 8 },
      outcomes: { enabled: false, intervalMinutes: 5 },
      followups: { enabled: false },
      sources: Array.from({ length: count }, (_, index) => ({
        id: `quota-timer-${index}`,
        type: 'timer',
        intervalMinutes: 15,
        jitterSeconds: 0,
        category: 'system',
        summary: `Inspect concrete member event ${index}.`,
      })),
    }));
    try {
      const result = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
      const store = new TriageStore(stateFile);
      try {
        return {
          posts,
          stdout: result.stdout,
          statuses: store.db
            .prepare('SELECT status, error FROM triage_events ORDER BY created_at ASC, id ASC')
            .all(),
          chengTaskUsage: store.recipientUsage('claude', Date.now(), DELIVERY_POOL_TASK).count,
        };
      } finally {
        store.close();
      }
    } finally {
      await Promise.all([close(deepseek), close(hub)]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const open = await runNudges({ dailyLimit: 10, cooldownMinutes: 0, count: 2 });
  assert.equal(open.posts.length, 2, 'an unused quota lets both nudges through');
  assert.deepEqual(open.posts.map((post) => post.url), [
    '/api/contacts/room/room-host/messages',
    '/api/contacts/room/room-host/messages',
  ]);
  assert.deepEqual(open.posts[0].body.targetIds, ['claude']);
  assert.deepEqual(open.statuses.map((row) => row.status), ['dispatched', 'dispatched']);
  assert.equal(open.chengTaskUsage, 2, 'a room-routed nudge must still bill the contact task pool');

  const quotaFull = await runNudges({ dailyLimit: 1, cooldownMinutes: 0, count: 2 });
  assert.equal(quotaFull.posts.length, 1, 'the second nudge must hit the exhausted daily quota');
  assert.deepEqual(quotaFull.statuses.map((row) => row.status), ['dispatched', 'retry']);
  assert.equal(quotaFull.statuses[1].error, 'all-candidates-rate-limited');
  assert.equal(quotaFull.chengTaskUsage, 1);
  assert.match(quotaFull.stdout, /"reason":"all-candidates-rate-limited"/);

  const cooling = await runNudges({ dailyLimit: 10, cooldownMinutes: 30, count: 2 });
  assert.equal(cooling.posts.length, 1, 'the second nudge must land inside the cooldown window');
  assert.deepEqual(cooling.statuses.map((row) => row.status), ['dispatched', 'retry']);
  assert.equal(cooling.statuses[1].error, 'all-candidates-rate-limited');
  assert.equal(cooling.chengTaskUsage, 1);
});

test('outcome collector closes message, task completion, and linked-tail evidence paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-outcome-e2e-'));
  const stateFile = path.join(dir, 'triage.db');
  const store = new TriageStore(stateFile);
  const seededAt = Date.now() - 10_000;
  const seed = (dedupeKey, recipientId, messageId, taskPath = null) => {
    store.enqueue({ source: 'outcome-test', summary: dedupeKey, dedupeKey });
    const event = store.claim(seededAt + messageId);
    store.finish(event.id, 'dispatched', {
      recipientId,
      triageResult: {
        actionable: true,
        category: taskPath ? 'backlog' : 'daily',
        priority: 1,
        suggestedRecipient: recipientId,
        rationale: 'outcome integration fixture',
        taskPath,
      },
    }, seededAt + messageId);
    store.recordDelivery(
      event.id,
      recipientId,
      seededAt + messageId,
      taskPath ? 'task' : 'daily',
      { messageId, taskPath },
    );
    return event;
  };
  seed('engaged-event', 'codex', 100);
  const acceptedEvent = seed('accepted-event', 'claude', 200, 'tasks/accepted.md');
  const reworkedEvent = seed('reworked-event', 'aye', 300, 'tasks/reworked.md');
  store.setSourceState('backlog-dispatch-claims:v1', JSON.stringify({
    'tasks/accepted.md': { eventId: acceptedEvent.id, claimedAt: seededAt },
    'tasks/reworked.md': { eventId: reworkedEvent.id, claimedAt: seededAt },
  }));
  store.close();

  const hubRequests = [];
  const hub = await listen((req, res) => {
    hubRequests.push(req.url);
    const messages = req.url.startsWith('/api/contacts/codex/messages?')
      ? [{
        id: 101,
        sender: 'user',
        role: 'user',
        status: 'done',
        content: '我看到了',
        created_at: '2026-07-29 10:00:00',
        meta: '{}',
      }]
      : req.url.startsWith('/api/contacts/claude/messages?')
        ? [{
          id: 201,
          sender: 'assistant',
          role: 'assistant',
          status: 'done',
          content: '已更新并归档：tasks/accepted.md → done；_archive/retired/accepted.md',
          created_at: '2026-07-29 10:01:00',
          meta: '{}',
        }]
      : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages }));
  });
  const taskSnapshot = [
    '任务快照日期：2026-07-29（Asia/Shanghai）',
    '## ⏰ 时间敏感事项',
    '- **重做尾巴** (`tasks/worker-tail-job-1.md`)（无期限，仍未完成）',
  ].join('\n');
  const vault = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'outcome-session',
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else {
        const text = message.params.name === 'get_task_context'
          ? taskSnapshot
          : 'Worker job from tasks/reworked.md';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text }] },
        }));
      }
    });
  });
  const configPath = path.join(dir, 'triage.json');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
    hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
    vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp` },
    outcomes: { enabled: true, intervalMinutes: 5, maxAgeDays: 365, batchSize: 10 },
    sources: [],
  }));

  try {
    await runWorker(configPath, {});
    const result = new TriageStore(stateFile);
    try {
      const summary = result.outcomeSummary();
      assert.equal(summary.total, 3);
      assert.equal(summary.labels.engaged, 1);
      assert.equal(summary.labels.accepted, 1);
      assert.equal(summary.labels.reworked, 1);
      assert.equal(summary.labels.unknown, 0);
      assert.equal(summary.knownRatio, 1);
      assert.equal(summary.strongCount, 2);
      const claims = JSON.parse(result.getSourceState('backlog-dispatch-claims:v1'));
      assert.equal(claims['tasks/accepted.md'].eventId, acceptedEvent.id);
      assert.equal(claims['tasks/reworked.md'], undefined);
    } finally {
      result.close();
    }
    assert.ok(hubRequests.some((url) => url.includes('after=100') && url.includes('origin=all')));
    assert.ok(hubRequests.some((url) => url.includes('after=200') && url.includes('origin=all')));
    assert.ok(hubRequests.some((url) => url.includes('after=300') && url.includes('origin=all')));
  } finally {
    await Promise.all([close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backlog claim suppresses repeats, then exact rejected outcome releases the task path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-claim-e2e-'));
  const dispatched = [];
  let deepseekCalls = 0;
  const deepseek = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      deepseekCalls++;
      const user = JSON.parse(JSON.parse(raw).messages[1].content);
      assert.match(user.recentBacklog, /tasks\/real-work\.md/);
      assert.doesNotMatch(user.recentBacklog, /worker-tail/);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actionable: true,
              needsLocalExec: false,
              category: 'backlog',
              priority: 2,
              suggestedRecipient: 'codex',
              rationale: 'one exact unclaimed task',
              taskPath: 'tasks/real-work.md',
            }),
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
  });
  const hub = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/api/contacts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        contacts: [{
          id: 'codex',
          name: 'Codex',
          kind: 'dm',
          state: 'idle',
          config: {
            routing: {
              enabled: true,
              recipientKey: 'codex',
              categories: ['backlog'],
              dailyLimit: 10,
              cooldownMinutes: 0,
            },
          },
        }],
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/contacts/codex/messages?')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        messages: [{
          id: 150,
          sender: 'user',
          role: 'user',
          status: 'done',
          content: '不要再派这种任务了',
          created_at: '2026-07-30 09:00:00',
          meta: '{}',
        }],
      }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      dispatched.push(JSON.parse(raw));
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ queued: true, messageId: 100 + dispatched.length }));
    });
  });
  const taskSnapshot = [
    '任务快照日期：2026-07-28（Asia/Shanghai）',
    '## ⏰ 时间敏感事项',
    '- **真正要做的工作** (`tasks/real-work.md`)（无期限，仍未完成）',
    '- **已有 Worker 尾巴** (`tasks/worker-tail-old-job.md`)（无期限，仍未完成）',
  ].join('\n');
  const vault = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'claim-session',
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else {
        assert.ok(['get_task_context', 'read_file'].includes(message.params.name));
        const text = message.params.name === 'get_task_context'
          ? taskSnapshot
          : 'unrelated existing worker tail';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text }] },
        }));
      }
    });
  });

  const configPath = path.join(dir, 'triage.json');
  const stateFile = path.join(dir, 'triage.db');
  const config = {
    stateFile,
    categories: ['backlog', 'other'],
    deepseek: {
      baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
      apiKeyEnv: 'TEST_DEEPSEEK_KEY',
      flashModel: 'deepseek-v4-flash',
      proModel: 'deepseek-v4-pro',
    },
    hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
    vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp` },
    routing: { rules: { backlog: 'codex' }, fuzzyFallback: true },
    outcomes: { enabled: false, intervalMinutes: 5, maxAgeDays: 365, batchSize: 10 },
    sources: [{
      id: 'backlog-sweep-1',
      type: 'timer',
      intervalMinutes: 15,
      jitterSeconds: 0,
      category: 'backlog',
      summary: 'Review current open tasks.',
    }],
  };
  fs.writeFileSync(configPath, JSON.stringify(config));

  try {
    const first = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.match(first.stdout, /"msg":"event dispatched"/);
    assert.equal(deepseekCalls, 1);
    assert.equal(dispatched.length, 1);
    assert.match(dispatched[0].content, /账本任务：tasks\/real-work\.md/);

    config.sources[0].id = 'backlog-sweep-2';
    fs.writeFileSync(configPath, JSON.stringify(config));
    const second = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.match(second.stdout, /"msg":"backlog sweep suppressed before L1"/);
    assert.equal(deepseekCalls, 1);
    assert.equal(dispatched.length, 1);

    config.outcomes.enabled = true;
    config.sources[0].id = 'backlog-sweep-3';
    fs.writeFileSync(configPath, JSON.stringify(config));
    const third = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.match(third.stdout, /"msg":"event dispatched"/);
    assert.equal(deepseekCalls, 2);
    assert.equal(dispatched.length, 2);

    const store = new TriageStore(stateFile);
    try {
      const claims = JSON.parse(store.getSourceState('backlog-dispatch-claims:v1'));
      assert.equal(typeof claims['tasks/real-work.md'].claimedAt, 'number');
      assert.equal(store.outcomeSummary().labels.rejected, 1);
      assert.equal(store.outcomeSummary().byExecutedVia.contact.labels.rejected, 1);
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordination sweep dispatches each Plan hash once and ignores tasks without executor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-coordination-e2e-'));
  const tasksDir = path.join(dir, 'tasks');
  fs.mkdirSync(tasksDir);
  const stateFile = path.join(dir, 'triage.db');
  const dispatched = [];
  let deepseekCalls = 0;
  const taskBody = (validation, executor = 'codex') => [
    '---',
    'type: task',
    'status: open',
    ...(executor ? [`executor: ${executor}`] : []),
    '---',
    '',
    '# Coordination E2E',
    '',
    '## Plan（Claude，2026-08-06）',
    '',
    '- 执行者：`C:\\ai-hub-codex`：`git checkout -b coordination-e2e origin/master`。',
    `- 验证：${validation}`,
  ].join('\n');
  fs.writeFileSync(path.join(tasksDir, 'eligible.md'), taskBody('npm test'));
  fs.writeFileSync(path.join(tasksDir, 'no-executor.md'), taskBody('npm test', ''));

  const deepseek = await listen((req, res) => {
    deepseekCalls += 1;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'coordination must not call L1' }));
  });
  const hub = await listen((req, res) => {
    if (req.method === 'POST' && req.url === '/api/contacts/room/room-host/messages') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        dispatched.push(JSON.parse(raw));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messageId: 500 + dispatched.length, roundId: `round-${dispatched.length}` }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  const configPath = path.join(dir, 'triage.json');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
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
    proactive: {
      enabled: true,
      dailyDispatchLimit: 10,
      minDailyDispatches: 0,
      forceAfterHour: 23,
      minimumGapMinutes: 180,
      silentStartHour: 0,
      silentEndHour: 0,
      recipients: ['codex'],
    },
    coordination: {
      enabled: true,
      roomId: 'room',
      tasksDir,
      dailyLimit: 8,
      scanIntervalMinutes: 5,
    },
    outcomes: { enabled: false, intervalMinutes: 5 },
    followups: { enabled: false },
    sources: [],
  }));

  try {
    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(deepseekCalls, 0);
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].targetIds, ['codex']);
    assert.equal(dispatched[0].reactionRounds, 0);
    assert.match(dispatched[0].content, /任务文件：tasks\/eligible\.md/);
    assert.match(dispatched[0].content, /delegate_to_worker\.prompt 必须逐字/);
    assert.match(dispatched[0].content, /\[AI_HUB_COORDINATION_V2\]/);
    assert.doesNotMatch(dispatched[0].content, /no-executor/);
    const firstPlan = parseCoordinationTask(
      fs.readFileSync(path.join(tasksDir, 'eligible.md'), 'utf8'),
      { taskPath: 'tasks/eligible.md' },
    );
    assert.match(dispatched[0].content, new RegExp(`fingerprint=${executionFingerprint(firstPlan)}`));
    assert.equal(dispatched[0].idempotencyKey, executionDispatchKey(firstPlan));
    assert.deepEqual(dispatched[0].coordination, {
      kind: 'execution',
      taskPath: firstPlan.taskPath,
      branch: firstPlan.branch,
      workspace: firstPlan.workspace,
      planHash: firstPlan.planHash,
      executor: firstPlan.executor,
    });

    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(dispatched.length, 1, 'same fingerprint must not dispatch twice');

    fs.writeFileSync(path.join(tasksDir, 'eligible.md'), taskBody('npm test && npm run build'));
    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(dispatched.length, 2, 'a revised Plan hash may dispatch once more');

    // Plan 与 due 不变、仅改派 executor：v1 语义永远不再触发，v2 必须重派
    fs.writeFileSync(path.join(tasksDir, 'eligible.md'), taskBody('npm test && npm run build', 'aye'));
    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(dispatched.length, 3, 'reassigned executor with the same Plan must dispatch once more');
    assert.deepEqual(dispatched[2].targetIds, ['aye']);
    assert.equal(dispatched[2].coordination.planHash, dispatched[1].coordination.planHash);
    assert.notEqual(dispatched[2].idempotencyKey, dispatched[1].idempotencyKey);

    const store = new TriageStore(stateFile);
    try {
      assert.equal(store.dailySummary().coordinationPoolDispatched, 3);
      assert.equal(store.dailySummary().coordinationExecutionDispatched, 3);
      assert.equal(store.dailySummary().coordinationVerificationDispatched, 0);
      assert.equal(store.dailySummary().ideaPoolDispatched, 0);
      const state = JSON.parse(store.getSourceState('coordination:v1'));
      const latest = parseCoordinationTask(
        fs.readFileSync(path.join(tasksDir, 'eligible.md'), 'utf8'),
        { taskPath: 'tasks/eligible.md' },
      );
      assert.equal(state['tasks/eligible.md'], executionFingerprint(latest));
      assert.equal(state['tasks/no-executor.md'], undefined);
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub-auto hygiene posts one capture-free daily digest, stays quiet on empty sets, and is inert when disabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-hub-auto-hygiene-e2e-'));
  const dispatched = [];
  let listInboxCalls = 0;
  let inboxText = '';
  const hub = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/contacts/room/room-host/messages') {
        dispatched.push(JSON.parse(raw));
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messageId: 700 + dispatched.length }));
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  const vault = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'hygiene-session',
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else {
        assert.equal(message.params.name, 'list_inbox');
        listInboxCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: inboxText }] },
        }));
      }
    });
  });
  const configPath = path.join(dir, 'triage.json');
  const staleDate = shanghaiDateAt(Date.now(), 20);
  const freshDate = shanghaiDateAt(Date.now(), 13);
  const today = shanghaiDateAt();
  const writeConfig = (stateFile, enabled) => fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
    categories: ['coordination', 'other'],
    hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
    vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp` },
    routing: { rules: {}, fuzzyFallback: false },
    proactive: {
      enabled: false,
      silentStartHour: 0,
      silentEndHour: 0,
    },
    coordination: {
      enabled: true,
      roomId: 'room',
      tasksDir: dir,
      dailyLimit: 8,
      scanIntervalMinutes: 5,
      hubAutoHygiene: { enabled, staleDays: 14 },
    },
    taskReminders: { enabled: false },
    outcomes: { enabled: false },
    followups: { enabled: false },
    backlogSweep: { enabled: false },
    sources: [],
  }));

  try {
    const staleStateFile = path.join(dir, 'stale.db');
    inboxText = [
      '- **旧承诺** (`inbox/' + staleDate + '_old-task.md`)  [hub-auto, 承诺与待办]',
      '- **新偏好** (`inbox/' + freshDate + '_fresh.md`)  [hub-auto, 偏好]',
    ].join('\n');
    writeConfig(staleStateFile, true);
    await runWorker(configPath, {});
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].trigger, false);
    assert.equal(dispatched[0].reactionRounds, 0);
    assert.equal(dispatched[0].capture, false);
    assert.equal(dispatched[0].idempotencyKey, `hub-auto-hygiene:v1:${today}`);
    assert.match(dispatched[0].content, new RegExp(staleDate));
    assert.doesNotMatch(dispatched[0].content, new RegExp(freshDate));
    assert.match(dispatched[0].content, /hub-auto 存量 2｜超期 1｜最老 20 天/);
    await runWorker(configPath, {});
    assert.equal(dispatched.length, 1, 'same Shanghai day must not dispatch twice');
    assert.equal(listInboxCalls, 1, 'settled daily state must skip a second list_inbox call');
    const staleStore = new TriageStore(staleStateFile);
    try {
      const state = JSON.parse(staleStore.getSourceState(`hub-auto-hygiene:v1:${today}`));
      assert.equal(state.status, 'dispatched');
      assert.equal(staleStore.poolUsage(DELIVERY_POOL_COORDINATION).count, 1);
    } finally {
      staleStore.close();
    }

    const quietStateFile = path.join(dir, 'quiet.db');
    inboxText = '- **新偏好** (`inbox/' + freshDate + '_fresh.md`)  [hub-auto, 偏好]';
    writeConfig(quietStateFile, true);
    await runWorker(configPath, {});
    assert.equal(dispatched.length, 1, 'empty stale set must not post or consume the pool');
    assert.equal(listInboxCalls, 2);
    await runWorker(configPath, {});
    assert.equal(listInboxCalls, 2, 'quiet daily state must also be idempotent');
    const quietStore = new TriageStore(quietStateFile);
    try {
      const state = JSON.parse(quietStore.getSourceState(`hub-auto-hygiene:v1:${today}`));
      assert.equal(state.status, 'quiet');
      assert.equal(quietStore.poolUsage(DELIVERY_POOL_COORDINATION).count, 0);
    } finally {
      quietStore.close();
    }

    const disabledStateFile = path.join(dir, 'disabled.db');
    inboxText = '- **旧承诺** (`inbox/' + staleDate + '_old-task.md`)  [hub-auto, 承诺与待办]';
    writeConfig(disabledStateFile, false);
    await runWorker(configPath, {});
    assert.equal(listInboxCalls, 2, 'enabled=false must not call list_inbox');
    assert.equal(dispatched.length, 1, 'enabled=false must not post');
  } finally {
    await Promise.all([close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordination verification dispatches due open tasks once per due date in the shared pool', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-verification-e2e-'));
  const tasksDir = path.join(dir, 'tasks');
  fs.mkdirSync(tasksDir);
  const stateFile = path.join(dir, 'triage.db');
  const dispatched = [];
  let deepseekCalls = 0;
  const today = shanghaiClock().date;
  const offsetDate = (days) => new Date(
    Date.parse(`${today}T00:00:00Z`) + days * 24 * 60 * 60_000,
  ).toISOString().slice(0, 10);
  const yesterday = offsetDate(-1);
  const tomorrow = offsetDate(1);
  const taskBody = ({ due, verifier = 'aye', status = 'open', title = 'Verification E2E' }) => [
    '---',
    'type: task',
    `status: ${status}`,
    ...(verifier ? [`verifier: ${verifier}`] : []),
    `due: ${due}`,
    '---',
    '',
    `# ${title}`,
    '',
    '## 验收标准',
    '- 逐条取证。',
  ].join('\n');
  fs.writeFileSync(path.join(tasksDir, 'eligible.md'), taskBody({ due: yesterday }));
  fs.writeFileSync(path.join(tasksDir, 'future.md'), taskBody({ due: tomorrow }));
  fs.writeFileSync(path.join(tasksDir, 'no-verifier.md'), taskBody({ due: today, verifier: '' }));
  fs.writeFileSync(path.join(tasksDir, 'closed.md'), taskBody({ due: today, status: 'done' }));

  const deepseek = await listen((req, res) => {
    deepseekCalls += 1;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'verification must not call L1' }));
  });
  const hub = await listen((req, res) => {
    if (req.method === 'POST' && req.url === '/api/contacts/room/room-host/messages') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        dispatched.push(JSON.parse(raw));
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messageId: 700 + dispatched.length, roundId: `round-${dispatched.length}` }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  const configPath = path.join(dir, 'triage.json');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
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
    proactive: {
      enabled: true,
      dailyDispatchLimit: 10,
      minDailyDispatches: 0,
      forceAfterHour: 23,
      minimumGapMinutes: 180,
      silentStartHour: 0,
      silentEndHour: 0,
      recipients: ['codex'],
    },
    coordination: {
      enabled: true,
      roomId: 'room',
      tasksDir,
      dailyLimit: 8,
      scanIntervalMinutes: 5,
    },
    outcomes: { enabled: false, intervalMinutes: 5 },
    followups: { enabled: false },
    sources: [],
  }));

  try {
    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(deepseekCalls, 0);
    assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].targetIds, ['aye']);
    assert.equal(dispatched[0].reactionRounds, 0);
    assert.equal(dispatched[0].idempotencyKey, `verification:v2:tasks/eligible.md:${yesterday}:aye`);
    assert.deepEqual(dispatched[0].coordination, {
      kind: 'verification',
      taskPath: 'tasks/eligible.md',
      due: yesterday,
      verifier: 'aye',
    });
    assert.match(dispatched[0].content, /本单只读：不改代码，不部署/);
    assert.match(dispatched[0].content, /验收结论 PASS\/FAIL\/样本不足 \+ tasks\/eligible\.md/);
    assert.match(dispatched[0].content, /不得将任务置 done，不得改期，不得作废/);
    assert.doesNotMatch(dispatched[0].content, /future|no-verifier|closed|delegate_to_worker/);

    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(dispatched.length, 1, 'same task and due date must not dispatch twice');

    fs.writeFileSync(path.join(tasksDir, 'eligible.md'), taskBody({ due: today }));
    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(dispatched.length, 2, 'a changed due date may dispatch once more when due');
    assert.equal(dispatched[1].idempotencyKey, `verification:v2:tasks/eligible.md:${today}:aye`);

    // due 不变、仅改派 verifier：v1 key（不含 verifier）永远不再触发，v2 必须重派
    fs.writeFileSync(path.join(tasksDir, 'eligible.md'), taskBody({ due: today, verifier: 'codex' }));
    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(dispatched.length, 3, 'reassigned verifier with the same due date must dispatch once more');
    assert.deepEqual(dispatched[2].targetIds, ['codex']);
    assert.equal(dispatched[2].idempotencyKey, `verification:v2:tasks/eligible.md:${today}:codex`);

    const store = new TriageStore(stateFile);
    try {
      const summary = store.dailySummary();
      assert.equal(summary.coordinationPoolDispatched, 3);
      assert.equal(summary.coordinationExecutionDispatched, 0);
      assert.equal(summary.coordinationVerificationDispatched, 3);
      assert.notEqual(store.getSourceState(`verification:v2:tasks/eligible.md:${yesterday}:aye`), null);
      assert.notEqual(store.getSourceState(`verification:v2:tasks/eligible.md:${today}:aye`), null);
      assert.notEqual(store.getSourceState(`verification:v2:tasks/eligible.md:${today}:codex`), null);
      assert.equal(store.getSourceState(`verification:v2:tasks/future.md:${tomorrow}:aye`), null);
      assert.equal(store.getSourceState(`verification:v2:tasks/no-verifier.md:${today}:`), null);
      assert.equal(store.getSourceState(`verification:v2:tasks/closed.md:${today}:aye`), null);
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pre-dispatch revalidation supersedes stale events and legacy v1 state migrates without re-dispatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-coordination-revalidate-e2e-'));
  const tasksDir = path.join(dir, 'tasks');
  fs.mkdirSync(tasksDir);
  const stateFile = path.join(dir, 'triage.db');
  const dispatched = [];
  const today = shanghaiClock().date;
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 24 * 60 * 60_000)
    .toISOString().slice(0, 10);
  const execBody = (executor, status = 'open') => [
    '---',
    'type: task',
    `status: ${status}`,
    `executor: ${executor}`,
    '---',
    '',
    '# Revalidation E2E',
    '',
    '## Plan（Claude，2026-08-06）',
    '',
    '- 工作区：`C:\\ai-hub-codex`：`git checkout -b revalidate-e2e origin/master`。',
    '- 验证：npm test。',
  ].join('\n');
  const verifBody = (verifier) => [
    '---',
    'type: task',
    'status: open',
    `verifier: ${verifier}`,
    `due: ${yesterday}`,
    '---',
    '',
    '# Verification Revalidation E2E',
    '',
    '## 验收标准',
    '- 逐条取证。',
  ].join('\n');

  // enqueue 时的旧语义
  fs.writeFileSync(path.join(tasksDir, 'reassigned.md'), execBody('codex'));
  fs.writeFileSync(path.join(tasksDir, 'closed.md'), execBody('codex'));
  fs.writeFileSync(path.join(tasksDir, 'legacy.md'), execBody('codex'));
  fs.writeFileSync(path.join(tasksDir, 'verif-legacy.md'), verifBody('aye'));
  fs.writeFileSync(path.join(tasksDir, 'verif-stale.md'), verifBody('aye'));
  const parseExec = (name) => parseCoordinationTask(
    fs.readFileSync(path.join(tasksDir, name), 'utf8'),
    { taskPath: `tasks/${name}` },
  );
  const parseVerif = (name) => parseVerificationTask(
    fs.readFileSync(path.join(tasksDir, name), 'utf8'),
    { taskPath: `tasks/${name}` },
  );
  const staleReassigned = parseExec('reassigned.md');
  const staleClosed = parseExec('closed.md');
  const legacyPlan = parseExec('legacy.md');
  const staleVerif = parseVerif('verif-stale.md');

  const seedStore = new TriageStore(stateFile);
  try {
    // 模拟 enqueue→process 间隙：event 已入队，任务文件随后被改写
    seedStore.enqueue({
      source: 'coordination-sweep',
      categoryHint: 'coordination',
      summary: `stale execution dispatch: ${staleReassigned.taskPath}`,
      dedupeKey: executionDispatchKey(staleReassigned),
      payload: { mode: 'coordination', task: staleReassigned },
    });
    seedStore.enqueue({
      source: 'coordination-sweep',
      categoryHint: 'coordination',
      summary: `stale execution dispatch: ${staleClosed.taskPath}`,
      dedupeKey: executionDispatchKey(staleClosed),
      payload: { mode: 'coordination', task: staleClosed },
    });
    seedStore.enqueue({
      source: 'coordination-sweep',
      categoryHint: 'coordination',
      summary: `stale verification dispatch: ${staleVerif.taskPath}`,
      dedupeKey: `verification:v2:${staleVerif.taskPath}:${staleVerif.due}:${staleVerif.verifier}`,
      payload: { mode: 'coordination-verification', task: staleVerif },
    });
    // legacy v1 状态：execution 存 planHash，verification 只按 due 记 key
    seedStore.setSourceState('coordination:v1', JSON.stringify({
      'tasks/legacy.md': legacyPlan.planHash,
    }));
    seedStore.setSourceState(`verification:v1:tasks/verif-legacy.md:${yesterday}`, JSON.stringify({
      taskPath: 'tasks/verif-legacy.md',
      due: yesterday,
      verifier: 'aye',
      dispatchedAt: Date.now(),
    }));
  } finally {
    seedStore.close();
  }

  // 入队之后的现实：改派、关闭
  fs.writeFileSync(path.join(tasksDir, 'reassigned.md'), execBody('aye'));
  fs.writeFileSync(path.join(tasksDir, 'closed.md'), execBody('codex', 'done'));
  fs.writeFileSync(path.join(tasksDir, 'verif-stale.md'), verifBody('codex'));

  const deepseek = await listen((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'coordination must not call L1' }));
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
    proactive: {
      enabled: true,
      dailyDispatchLimit: 10,
      minDailyDispatches: 0,
      forceAfterHour: 23,
      minimumGapMinutes: 180,
      silentStartHour: 0,
      silentEndHour: 0,
      recipients: ['codex'],
    },
    coordination: {
      enabled: true,
      roomId: 'room',
      tasksDir,
      dailyLimit: 8,
      scanIntervalMinutes: 5,
    },
    outcomes: { enabled: false, intervalMinutes: 5 },
    followups: { enabled: false },
    sources: [],
  }));

  try {
    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    const currentReassigned = parseExec('reassigned.md');
    const execDispatches = dispatched.filter((entry) => entry.idempotencyKey.startsWith('coordination:'));
    const verifDispatches = dispatched.filter((entry) => entry.idempotencyKey.startsWith('verification:'));
    // 改派后的 reassigned.md 只按当前语义派一次；closed.md 的旧 event 必须整体收口
    assert.equal(execDispatches.length, 1, 'only the current execution semantics may dispatch');
    assert.deepEqual(execDispatches[0].targetIds, ['aye']);
    assert.equal(execDispatches[0].idempotencyKey, executionDispatchKey(currentReassigned));
    assert.doesNotMatch(execDispatches[0].content, /closed\.md|legacy\.md/);
    // verifier 改派后的 verif-stale.md 同理；verif-legacy.md 靠 v1 状态迁移保持安静
    assert.equal(verifDispatches.length, 1, 'only the current verification semantics may dispatch');
    assert.deepEqual(verifDispatches[0].targetIds, ['codex']);
    assert.equal(
      verifDispatches[0].idempotencyKey,
      `verification:v2:tasks/verif-stale.md:${yesterday}:codex`,
    );

    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(dispatched.length, 2, 'settled state must stay quiet on rerun');

    // legacy execution state 迁移后，改派 executor 仍必须重新触发
    fs.writeFileSync(path.join(tasksDir, 'legacy.md'), execBody('aye'));
    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(dispatched.length, 3, 'legacy-migrated task must re-dispatch on executor change');
    assert.deepEqual(dispatched[2].targetIds, ['aye']);
    assert.match(dispatched[2].content, /tasks\/legacy\.md/);

    const store = new TriageStore(stateFile);
    try {
      const state = JSON.parse(store.getSourceState('coordination:v1'));
      assert.equal(state['tasks/reassigned.md'], executionFingerprint(currentReassigned));
      assert.equal(state['tasks/legacy.md'], executionFingerprint(parseExec('legacy.md')));
      assert.equal(state['tasks/closed.md'], undefined, 'closed task must not be marked dispatched');
      assert.notEqual(
        store.getSourceState(`verification:v2:tasks/verif-legacy.md:${yesterday}:aye`),
        null,
        'legacy verification state must migrate to the v2 key',
      );
      assert.notEqual(
        store.getSourceState(`verification:v2:tasks/verif-stale.md:${yesterday}:codex`),
        null,
      );
      assert.equal(
        store.getSourceState(`verification:v2:tasks/verif-stale.md:${yesterday}:aye`),
        null,
        'the superseded verifier must never be marked dispatched',
      );
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('crash between remote dispatch and local settle replays into exactly one visible dispatch and one ledger row', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-coordination-replay-e2e-'));
  const tasksDir = path.join(dir, 'tasks');
  fs.mkdirSync(tasksDir);
  const stateFile = path.join(dir, 'triage.db');
  const posts = [];
  const messageIdByKey = new Map();
  fs.writeFileSync(path.join(tasksDir, 'replay.md'), [
    '---',
    'type: task',
    'status: open',
    'executor: codex',
    '---',
    '',
    '# Replay E2E',
    '',
    '## Plan（Claude，2026-08-06）',
    '',
    '- 工作区：`C:\\ai-hub-codex`：`git checkout -b replay-e2e origin/master`。',
    '- 验证：npm test。',
  ].join('\n'));

  const deepseek = await listen((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'coordination must not call L1' }));
  });
  // 远端幂等：同 idempotencyKey 重发返回同一 messageId（对齐 room-host 端点语义）
  const hub = await listen((req, res) => {
    if (req.method === 'POST' && req.url === '/api/contacts/room/room-host/messages') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        posts.push(body);
        if (!messageIdByKey.has(body.idempotencyKey)) {
          messageIdByKey.set(body.idempotencyKey, 800 + messageIdByKey.size);
        }
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          messageId: messageIdByKey.get(body.idempotencyKey),
          roundId: `round-${posts.length}`,
        }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  const configPath = path.join(dir, 'triage.json');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
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
    proactive: {
      enabled: true,
      dailyDispatchLimit: 10,
      minDailyDispatches: 0,
      forceAfterHour: 23,
      minimumGapMinutes: 180,
      silentStartHour: 0,
      silentEndHour: 0,
      recipients: ['codex'],
    },
    coordination: {
      enabled: true,
      roomId: 'room',
      tasksDir,
      dailyLimit: 8,
      scanIntervalMinutes: 5,
    },
    outcomes: { enabled: false, intervalMinutes: 5 },
    followups: { enabled: false },
    sources: [],
  }));

  try {
    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(posts.length, 1);

    // 崩溃注入：远端已收到派单，本地 settle（state/delivery/终态）整体未落。
    const crashed = new TriageStore(stateFile);
    let eventId = '';
    try {
      const row = crashed.db.prepare(
        "SELECT id FROM triage_events WHERE source = 'coordination-sweep'",
      ).get();
      eventId = row.id;
      crashed.db.prepare(
        "UPDATE triage_events SET status = 'queued', next_attempt_at = 0, triage_result = NULL, recipient_id = NULL WHERE id = ?",
      ).run(eventId);
      crashed.db.prepare('DELETE FROM triage_outcomes WHERE event_id = ?').run(eventId);
      crashed.db.prepare('DELETE FROM triage_deliveries WHERE event_id = ?').run(eventId);
      crashed.db.prepare("DELETE FROM triage_source_state WHERE key = 'coordination:v1'").run();
    } finally {
      crashed.close();
    }

    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(posts.length, 2, 'replay must resend with the same idempotency key');
    assert.equal(posts[0].idempotencyKey, posts[1].idempotencyKey);
    assert.equal(messageIdByKey.size, 1, 'the room must see exactly one visible dispatch');

    await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(posts.length, 2, 'settled state must stay quiet afterwards');

    const store = new TriageStore(stateFile);
    try {
      const plan = parseCoordinationTask(
        fs.readFileSync(path.join(tasksDir, 'replay.md'), 'utf8'),
        { taskPath: 'tasks/replay.md' },
      );
      const state = JSON.parse(store.getSourceState('coordination:v1'));
      assert.equal(state['tasks/replay.md'], executionFingerprint(plan));
      assert.equal(store.poolUsage(DELIVERY_POOL_COORDINATION).count, 1, '重放不得二次计池');
      const deliveries = store.db.prepare(
        'SELECT * FROM triage_deliveries WHERE event_id = ?',
      ).all(eventId);
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].message_id, 800);
      assert.equal(
        store.db.prepare('SELECT status FROM triage_events WHERE id = ?').get(eventId).status,
        'dispatched',
      );
      assert.equal(store.dailySummary().coordinationExecutionDispatched, 1);
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('daily path uses real context, a guaranteed slot, and a companion-specific prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-daily-e2e-'));
  const dispatched = [];
  const today = shanghaiClock().date;
  const anchorYear = String(Number(today.slice(0, 4)) - 5);
  const birthdayFact = {
    date: `${anchorYear}-${today.slice(5)}`,
    recurring: 'yearly',
    label: 'User 生日',
  };
  const factsText = [
    '找到 1 条 facts：',
    '',
    `- **identity.birthday** (\`identity.birthday--test\`, active, pinned): ${JSON.stringify(birthdayFact)}`,
  ].join('\n');
  const vaultCalls = [];
  const deepseek = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const user = JSON.parse(body.messages[1].content);
      assert.equal(user.mode, 'daily');
      assert.equal(user.recentBacklog, undefined);
      assert.match(body.messages[0].content, /guaranteed daily slot|marked date event/i);
      assert.match(user.proactiveContext.openTaskSnapshot, /today task/);
      assert.equal(user.proactiveContext.recentConversations[0].recipient, 'codex');
      assert.ok(Array.isArray(user.proactiveContext.todayDateEvents));
      assert.equal(user.proactiveContext.todayDateEvents.length, 1);
      assert.equal(user.proactiveContext.todayDateEvents[0].label, 'User 生日');
      assert.equal(user.proactiveContext.todayDateEvents[0].yearsSince, 5);
      assert.match(user.event.summary, /TODAY IS A MARKED DATE/);
      assert.match(user.event.summary, /User 生日/);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actionable: true,
              needsLocalExec: false,
              category: 'daily',
              priority: 1,
              suggestedRecipient: 'codex',
              rationale: 'a light check-in fits now',
            }),
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
  });
  const hub = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/api/contacts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        contacts: [{
          id: 'codex',
          name: 'Codex',
          kind: 'dm',
          state: 'idle',
          last_at: '2026-07-26 13:00:00',
          last_content: '最近在聊今天的安排。',
          config: { routing: { enabled: true, recipientKey: 'codex', categories: ['system'] } },
        }],
      }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      dispatched.push({ url: req.url, body: JSON.parse(raw) });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ queued: true }));
    });
  });
  const vault = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'daily-session',
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else {
        vaultCalls.push(message.params?.name);
        const name = message.params.name;
        assert.ok(name === 'get_task_context' || name === 'get_facts', `unexpected vault tool ${name}`);
        const text = name === 'get_facts' ? factsText : 'today task: have lunch and rest';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text }] },
        }));
      }
    });
  });

  const configPath = path.join(dir, 'triage.json');
  const stateFile = path.join(dir, 'triage.db');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
    categories: ['daily', 'system', 'other'],
    deepseek: {
      baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
      apiKeyEnv: 'TEST_DEEPSEEK_KEY',
      flashModel: 'deepseek-v4-flash',
      proModel: 'deepseek-v4-pro',
    },
    hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
    vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp` },
    routing: { rules: {}, fuzzyFallback: true },
    proactive: {
      enabled: true,
      dailyDispatchLimit: 10,
      minDailyDispatches: 1,
      forceAfterHour: 0,
      minimumGapMinutes: 180,
      silentStartHour: 0,
      silentEndHour: 0,
      recipients: ['codex'],
    },
    sources: [{
      id: 'daily-check-in',
      type: 'timer',
      mode: 'daily',
      intervalMinutes: 45,
      jitterSeconds: 0,
      category: 'daily',
      summary: 'Check in naturally.',
    }],
  }));

  try {
    const result = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.match(result.stdout, /"pool":"daily"/);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].url, '/api/contacts/codex/messages');
    assert.match(dispatched[0].body.content, /直接用你自己的自然语气/);
    // Companion prompt must carry the date-event hard block — L1 context alone is not enough.
    assert.match(dispatched[0].body.content, /【必须围绕的日子】/);
    assert.match(dispatched[0].body.content, /User 生日/);
    assert.match(dispatched[0].body.content, /禁止泛问吃饭/);
    assert.doesNotMatch(dispatched[0].body.content, /真实事件上下文/);
    assert.equal(dispatched[0].body.origin, 'main');
    assert.equal(dispatched[0].body.automated, true);
    assert.equal(dispatched[0].body.hidden, true);
    assert.equal(dispatched[0].body.automation.messageType, 'proactive-trigger');
    assert.equal(dispatched[0].body.automation.eventSource, 'daily-check-in');
    assert.equal(dispatched[0].body.automation.eventCategory, 'daily');
    assert.ok(dispatched[0].body.automation.eventId);
    const store = new TriageStore(stateFile);
    try {
      const summary = store.dailySummary();
      assert.equal(summary.dailyPoolDispatched, 1);
      assert.equal(summary.dailyChecks, 1);
      assert.equal(summary.dailyNoops, 0);
      assert.ok(summary.lastDailyDeliveryAt);
      const claims = JSON.parse(store.getSourceState('date-event-claims:v1') ?? '{}');
      assert.ok(claims[`identity.birthday:${today}`]);
      assert.ok(vaultCalls.includes('get_facts'));
      assert.ok(vaultCalls.includes('get_task_context'));
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('followup cancels when User messages before due, and fires once when she does not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-followup-e2e-'));
  const stateFile = path.join(dir, 'triage.db');
  const now = Date.now();

  // Case A: user already replied → cancel, zero dispatch.
  {
    const store = new TriageStore(stateFile);
    store.insertFollowup({
      id: 'fu-cancel',
      contactId: 'claude',
      messageId: 10,
      activity: '洗澡',
      expectedMinutes: 20,
      dueAt: now - 60_000,
      recipientKey: 'claude',
      now: now - 30 * 60_000,
    });
    store.close();

    const dispatched = [];
    const deepseek = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ intent: 'none' }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
    const hub = await listen((req, res) => {
      if (req.method === 'GET' && req.url === '/api/contacts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          contacts: [{
            id: 'claude',
            name: 'Claude',
            kind: 'dm',
            state: 'idle',
            config: { routing: { enabled: true, recipientKey: 'claude', categories: ['daily'] } },
          }],
        }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/api/contacts/claude/messages')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // User already came back after the absence anchor.
        res.end(JSON.stringify({
          messages: [{
            id: 11,
            sender: 'user',
            role: 'user',
            status: 'done',
            content: '洗完啦',
          }],
        }));
        return;
      }
      if (req.method === 'POST') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          dispatched.push(JSON.parse(raw));
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ queued: true }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    const configPath = path.join(dir, 'cancel.json');
    fs.writeFileSync(configPath, JSON.stringify({
      stateFile,
      categories: ['daily', 'system', 'other'],
      deepseek: {
        baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        flashModel: 'deepseek-v4-flash',
        proModel: 'deepseek-v4-pro',
      },
      hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
      vault: { url: '' },
      routing: { rules: {}, fuzzyFallback: false },
      proactive: {
        enabled: true,
        dailyDispatchLimit: 10,
        minDailyDispatches: 0,
        forceAfterHour: 23,
        minimumGapMinutes: 180,
        silentStartHour: 0,
        silentEndHour: 0,
        recipients: ['claude'],
      },
      outcomes: { enabled: false, intervalMinutes: 5 },
      followups: {
        enabled: true,
        minExpectedMinutes: 5,
        maxExpectedMinutes: 180,
        defaultExpectedMinutes: 20,
        expireAfterMinutes: 180,
        scanLimit: 40,
      },
      sources: [],
    }));

    try {
      await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
      assert.equal(dispatched.length, 0);
      const after = new TriageStore(stateFile);
      try {
        assert.equal(after.getFollowup('fu-cancel').status, 'cancelled');
        assert.equal(after.getFollowup('fu-cancel').cancel_reason, 'user-replied');
      } finally {
        after.close();
      }
    } finally {
      await Promise.all([close(deepseek), close(hub)]);
    }
  }

  // Case B: no user reply → fire once with followup hard block in companion prompt.
  {
    const fireDb = path.join(dir, 'fire.db');
    const store = new TriageStore(fireDb);
    store.insertFollowup({
      id: 'fu-fire',
      contactId: 'claude',
      messageId: 20,
      activity: '洗澡',
      returnCommitment: '验收 toy',
      expectedMinutes: 15,
      dueAt: now - 60_000,
      recipientKey: 'claude',
      now: now - 20 * 60_000,
    });
    store.close();

    const dispatched = [];
    const deepseek = await listen((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ intent: 'none' }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
    const hub = await listen((req, res) => {
      if (req.method === 'GET' && req.url === '/api/contacts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          contacts: [{
            id: 'claude',
            name: 'Claude',
            kind: 'dm',
            state: 'idle',
            config: { routing: { enabled: true, recipientKey: 'claude', categories: ['daily'] } },
          }],
        }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/api/contacts/claude/messages')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages: [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/contacts/claude/messages') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          dispatched.push(JSON.parse(raw));
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ queued: true, messageId: 99 }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    const configPath = path.join(dir, 'fire.json');
    fs.writeFileSync(configPath, JSON.stringify({
      stateFile: fireDb,
      categories: ['daily', 'system', 'other'],
      deepseek: {
        baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        flashModel: 'deepseek-v4-flash',
        proModel: 'deepseek-v4-pro',
      },
      hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
      vault: { url: '' },
      routing: { rules: {}, fuzzyFallback: false },
      proactive: {
        enabled: true,
        dailyDispatchLimit: 10,
        minDailyDispatches: 0,
        forceAfterHour: 23,
        minimumGapMinutes: 180,
        silentStartHour: 0,
        silentEndHour: 0,
        recipients: ['claude'],
      },
      outcomes: { enabled: false, intervalMinutes: 5 },
      followups: { enabled: true, expireAfterMinutes: 180, scanLimit: 40 },
      sources: [],
    }));

    try {
      const result = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
      assert.match(result.stdout, /followup queued for dispatch|event dispatched/);
      assert.equal(dispatched.length, 1);
      assert.match(dispatched[0].content, /【跟进】/);
      assert.match(dispatched[0].content, /洗澡/);
      assert.match(dispatched[0].content, /验收 toy/);
      assert.equal(dispatched[0].automation.messageType, 'proactive-trigger');
      assert.equal(dispatched[0].automation.eventSource, 'followup-sweep');
      const after = new TriageStore(fireDb);
      try {
        assert.equal(after.getFollowup('fu-fire').status, 'dispatched');
      } finally {
        after.close();
      }
    } finally {
      await Promise.all([close(deepseek), close(hub)]);
    }
  }

  // Case C: an expired evening commitment is injected into the next daily check
  // without sending the private commitment through external L1 triage.
  {
    const fallbackDb = path.join(dir, 'fallback.db');
    const store = new TriageStore(fallbackDb);
    store.insertFollowup({
      id: 'fu-fallback',
      contactId: 'claude',
      messageId: 30,
      activity: '玩鸣潮',
      returnCommitment: '验收 toy',
      expectedMinutes: 120,
      dueAt: now - 4 * 60 * 60_000,
      recipientKey: 'claude',
      now: now - 6 * 60 * 60_000,
    });
    store.updateFollowupStatus('fu-fallback', 'expired', {
      cancelReason: 'max-age',
      now: now - 60_000,
    });
    store.close();

    let deepseekCalls = 0;
    const dispatched = [];
    const deepseek = await listen((req, res) => {
      deepseekCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          actionable: true,
          needsLocalExec: false,
          category: 'daily',
          priority: 1,
          suggestedRecipient: 'claude',
          rationale: 'unexpected fallback L1 call',
        }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
    const hub = await listen((req, res) => {
      if (req.method === 'GET' && req.url === '/api/contacts') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          contacts: [{
            id: 'claude',
            name: 'Claude',
            kind: 'dm',
            state: 'idle',
            config: { routing: { enabled: true, recipientKey: 'claude', categories: ['daily'] } },
          }],
        }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/api/contacts/claude/messages')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages: [] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/contacts/claude/messages') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          dispatched.push(JSON.parse(raw));
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ queued: true, messageId: 100 }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    const configPath = path.join(dir, 'fallback.json');
    fs.writeFileSync(configPath, JSON.stringify({
      stateFile: fallbackDb,
      categories: ['daily', 'system', 'other'],
      deepseek: {
        baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        flashModel: 'deepseek-v4-flash',
        proModel: 'deepseek-v4-pro',
      },
      hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
      vault: { url: '' },
      routing: { rules: {}, fuzzyFallback: false },
      proactive: {
        enabled: true,
        dailyDispatchLimit: 10,
        minDailyDispatches: 0,
        forceAfterHour: 23,
        minimumGapMinutes: 180,
        silentStartHour: 0,
        silentEndHour: 0,
        recipients: ['claude'],
      },
      outcomes: { enabled: false, intervalMinutes: 5 },
      followups: { enabled: true, expireAfterMinutes: 360, scanLimit: 40 },
      sources: [{
        id: 'daily-check-in',
        type: 'timer',
        mode: 'daily',
        intervalMinutes: 45,
        jitterSeconds: 0,
        category: 'daily',
        summary: 'Check in naturally.',
      }],
    }));

    try {
      await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
      assert.equal(deepseekCalls, 0);
      assert.equal(dispatched.length, 1);
      assert.match(dispatched[0].content, /【昨晚没接上的事】/);
      assert.match(dispatched[0].content, /玩鸣潮/);
      assert.match(dispatched[0].content, /验收 toy/);
      const after = new TriageStore(fallbackDb);
      try {
        assert.ok(after.getFollowup('fu-fallback').fallback_reminded_at);
      } finally {
        after.close();
      }
    } finally {
      await Promise.all([close(deepseek), close(hub)]);
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('task reminder scan routes once per stage and re-emits after a due-date change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-task-reminder-e2e-'));
  const dispatched = [];
  let snapshot = [
    '任务快照日期：2026-08-01（Asia/Shanghai）',
    '',
    '## ⏰ 时间敏感事项',
    '',
    '- ⚠ **过期任务** (`tasks/overdue.md`) 已过期 2 天——主动问问 User 完成了没',
    '- 🔔 **今天任务** (`tasks/today.md`) 今天到期',
    '- **临期任务** (`tasks/upcoming.md`) 还有 5 天（2026-08-06 星期四）',
    '- **无期限任务** (`tasks/no-due.md`)（无期限，仍未完成）',
    '- **已完成任务** (`tasks/done.md`) 今天到期 done',
  ].join('\n');
  const hub = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/api/contacts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        contacts: [{ id: 'claude', name: 'Claude', kind: 'dm', state: 'idle', config: {} }],
      }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      dispatched.push({ url: req.url, body: JSON.parse(raw) });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ queued: true, messageId: 300 + dispatched.length }));
    });
  });
  const vault = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': `reminder-${Date.now()}`,
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else {
        assert.equal(message.params.name, 'get_task_context');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: snapshot }] },
        }));
      }
    });
  });
  const configPath = path.join(dir, 'triage.json');
  const stateFile = path.join(dir, 'triage.db');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
    pollMs: 25,
    categories: ['daily', 'system', 'other'],
    deepseek: {
      baseUrl: 'http://127.0.0.1:9',
      apiKeyEnv: 'TEST_DEEPSEEK_KEY',
      flashModel: 'deepseek-v4-flash',
      proModel: 'deepseek-v4-pro',
    },
    hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
    vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp` },
    routing: { rules: {}, fuzzyFallback: false },
    proactive: {
      enabled: true,
      dailyDispatchLimit: 10,
      minDailyDispatches: 0,
      forceAfterHour: 18,
      minimumGapMinutes: 180,
      silentStartHour: 0,
      silentEndHour: 0,
      recipients: ['claude'],
    },
    taskReminders: {
      enabled: true,
      intervalMinutes: 45,
      jitterSeconds: 0,
      recipient: 'claude',
    },
    outcomes: { enabled: false },
    sources: [],
  }));

  try {
    const first = await runWorker(
      configPath,
      { TEST_DEEPSEEK_KEY: 'test-only' },
      ['--once', '--task-reminders'],
    );
    assert.match(first.stdout, /"candidates":2,"queued":2/);
    assert.equal(dispatched.length, 2);
    assert.ok(dispatched.every((item) => item.url === '/api/contacts/claude/messages'));
    assert.ok(dispatched.every((item) => item.body.origin === 'main' && item.body.hidden === true));
    assert.ok(dispatched.every((item) => item.body.automation.messageType === 'proactive-trigger'));
    assert.ok(dispatched.every((item) => item.body.automation.eventSource === 'task-reminder'));
    assert.ok(dispatched.every((item) => /只保留三项：一句结论、一个下一步、是否需要 User 操作/.test(item.body.content)));
    const firstKeys = dispatched.map((item) => item.body.idempotencyKey);
    assert.equal(new Set(firstKeys).size, 2);

    const repeated = await runWorker(
      configPath,
      { TEST_DEEPSEEK_KEY: 'test-only' },
      ['--once', '--task-reminders'],
    );
    assert.match(repeated.stdout, /"candidates":2,"queued":0/);
    assert.equal(dispatched.length, 2);

    const shadow = await runWorker(
      configPath,
      { TEST_DEEPSEEK_KEY: 'test-only' },
      ['--reminder-shadow'],
    );
    assert.match(shadow.stdout, /"task reminder shadow complete"/);
    assert.match(shadow.stdout, /"candidates":2,"queued":0/);
    assert.equal(dispatched.length, 2);

    snapshot = snapshot.replace(
      '已过期 2 天——主动问问 User 完成了没',
      '已过期 4 天——主动问问 User 完成了没',
    );
    const changed = await runWorker(
      configPath,
      { TEST_DEEPSEEK_KEY: 'test-only' },
      ['--once', '--task-reminders'],
    );
    assert.match(changed.stdout, /"candidates":2,"queued":1/);
    assert.equal(dispatched.length, 3);
    assert.match(dispatched[2].body.content, /2026-07-28/);
  } finally {
    await Promise.all([close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('task reminders split room and main routes, skip same-day verification, and fall back on unreadable files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-task-reminder-routing-e2e-'));
  const tasksDir = path.join(dir, 'tasks');
  fs.mkdirSync(tasksDir);
  const task = (extra) => ['---', 'status: open', ...extra, '---', '', '# Reminder task'].join('\n');
  fs.writeFileSync(path.join(tasksDir, 'executor.md'), task(['executor: codex']));
  fs.writeFileSync(path.join(tasksDir, 'tagged.md'), task(['tags:', '- engineering']));
  fs.writeFileSync(path.join(tasksDir, 'verify-today.md'), task(['verifier: aye']));
  fs.writeFileSync(path.join(tasksDir, 'verify-overdue.md'), task(['verifier: aye']));
  fs.writeFileSync(path.join(tasksDir, 'life.md'), task(['tags: [生活, 租房]']));

  const snapshot = [
    '任务快照日期：2026-08-01（Asia/Shanghai）',
    '- ⚠ **执行任务** (`tasks/executor.md`) 已过期 2 天——主动问问 User 完成了没',
    '- 🔔 **标签任务** (`tasks/tagged.md`) 今天到期',
    '- 🔔 **今日验收** (`tasks/verify-today.md`) 今天到期',
    '- ⚠ **过期验收** (`tasks/verify-overdue.md`) 已过期 1 天——主动问问 User 完成了没',
    '- 🔔 **生活任务** (`tasks/life.md`) 今天到期',
    '- ⚠ **不可读任务** (`tasks/missing.md`) 已过期 3 天——主动问问 User 完成了没',
  ].join('\n');
  const dispatched = [];
  const hub = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/api/contacts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ contacts: [{ id: 'claude', name: 'Claude', kind: 'dm', state: 'idle', config: {} }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      dispatched.push({ url: req.url, body: JSON.parse(raw) });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messageId: 700 + dispatched.length }));
    });
  });
  const vault = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': `routing-${Date.now()}` });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else {
        assert.equal(message.params.name, 'get_task_context');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: snapshot }] },
        }));
      }
    });
  });
  const configPath = path.join(dir, 'triage.json');
  const stateFile = path.join(dir, 'triage.db');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
    pollMs: 25,
    categories: ['daily', 'system', 'coordination', 'other'],
    deepseek: {
      baseUrl: 'http://127.0.0.1:9',
      apiKeyEnv: 'TEST_DEEPSEEK_KEY',
      flashModel: 'deepseek-v4-flash',
      proModel: 'deepseek-v4-pro',
    },
    hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
    vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp` },
    routing: { rules: {}, fuzzyFallback: false },
    proactive: {
      enabled: true,
      dailyDispatchLimit: 10,
      minDailyDispatches: 0,
      forceAfterHour: 18,
      minimumGapMinutes: 0,
      silentStartHour: 0,
      silentEndHour: 0,
      recipients: ['claude'],
    },
    taskReminders: { enabled: true, intervalMinutes: 45, jitterSeconds: 0, recipient: 'claude' },
    coordination: {
      enabled: true,
      roomId: 'room',
      tasksDir,
      reminderRoomTags: ['engineering'],
      dailyLimit: 8,
      scanIntervalMinutes: 5,
    },
    outcomes: { enabled: false },
    sources: [],
  }));
  const before = new TriageStore(stateFile);
  before.setSourceState('verification:v1:tasks/verify-today.md:2026-08-01', JSON.stringify({ dispatchedAt: 1 }));
  before.close();

  try {
    const first = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' }, ['--once', '--task-reminders']);
    assert.match(first.stdout, /"candidates":6,"queued":5,"verificationSkipped":1/);
    assert.match(first.stdout, /task reminder route read failed; falling back to main/);
    const roomPosts = dispatched.filter((item) => item.url === '/api/contacts/room/room-host/messages');
    const mainPosts = dispatched.filter((item) => item.url === '/api/contacts/claude/messages');
    assert.equal(roomPosts.length, 3);
    assert.equal(mainPosts.length, 2);
    assert.ok(roomPosts.every((item) => item.body.trigger === false && item.body.reactionRounds === 0));
    assert.ok(roomPosts.every((item) => item.body.idempotencyKey.startsWith('reminder:v1:tasks/')));
    assert.ok(mainPosts.every((item) => item.body.origin === 'main'));

    const repeat = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' }, ['--once', '--task-reminders']);
    assert.match(repeat.stdout, /"candidates":6,"queued":0,"verificationSkipped":1/);
    assert.equal(dispatched.length, 5);

    const after = new TriageStore(stateFile);
    try {
      const summary = after.dailySummary();
      assert.equal(summary.coordinationPoolDispatched, 3);
      assert.equal(summary.coordinationReminderDispatched, 3);
      assert.equal(summary.dailyPoolDispatched, 2);
    } finally {
      after.close();
    }
  } finally {
    await Promise.all([close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idea path hosts a tracked room round, observes PASS, summarizes, and uses its own pool', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-idea-e2e-'));
  const hostPosts = [];
  const vaultCalls = [];
  let deepseekCalls = 0;
  const deepseek = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(body.model, 'deepseek-v4-flash');
      deepseekCalls++;
      const isSummary = body.messages[0].content.includes('closing a private multi-AI room discussion');
      const content = isSummary
        ? { summary: '收尾：大家从体验与工程两侧给出了不同答案，真正的分歧在于便利和自主性的边界。' }
        : {
          topic: '如果 AI 可以替你永久忘掉一种日常摩擦，你会选哪一种，代价又是什么？',
          category: 'daily-life',
          targetIds: ['claude', 'codex'],
          rationale: '近期没有同类生活取舍话题',
        };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 120, completion_tokens: 40 },
      }));
    });
  });
  const contacts = [
    { id: 'room', name: '会议室', kind: 'room', state: 'idle', config: { members: ['claude', 'codex'] } },
    { id: 'claude', name: 'Claude', kind: 'dm', state: 'idle', config: {} },
    { id: 'codex', name: 'Codex', kind: 'dm', state: 'idle', config: {} },
  ];
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/contacts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ contacts }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/contacts/room/room-rounds/round-1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        messageId: 10,
        roundId: 'round-1',
        status: 'done',
        lastMessageId: 12,
        outcome: {
          normal: { spoke: 1, passed: 1, silent: 0, error: 0 },
          reactions: [{ spoke: 0, passed: 2, silent: 0, error: 0 }],
        },
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/contacts/room/messages') {
      assert.equal(url.searchParams.get('after'), '10');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        messages: [
          { id: 11, sender: 'claude', kind: 'text', status: 'done', content: '我想删掉反复确认同一件小事。' },
          { id: 12, sender: 'codex', kind: 'text', status: 'done', content: '我更在意保留选择权，便利不能替代自主。' },
        ],
      }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      hostPosts.push(body);
      res.writeHead(body.trigger === false ? 201 : 202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body.trigger === false
        ? { messageId: 20, roundId: 'summary', status: 'done', targets: [] }
        : { messageId: 10, roundId: 'round-1', status: 'running', targets: body.targetIds }));
    });
  });

  const vault = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'idea-diary-session',
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else {
        vaultCalls.push(message.params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: 'diary/mock.md' }] },
        }));
      }
    });
  });

  const configPath = path.join(dir, 'triage.json');
  const stateFile = path.join(dir, 'triage.db');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
    categories: ['idea', 'other'],
    deepseek: {
      baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
      apiKeyEnv: 'TEST_DEEPSEEK_KEY',
      flashModel: 'deepseek-v4-flash',
      proModel: 'deepseek-v4-pro',
    },
    hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
    vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp` },
    proactive: {
      silentStartHour: 0,
      silentEndHour: 0,
      recipients: ['codex'],
    },
    idea: {
      enabled: true,
      roomId: 'room',
      dailyDispatchLimit: 1,
      reactionRounds: 2,
      roundPollMs: 100,
      roundTimeoutMs: 10_000,
    },
    sources: [{
      id: 'daily-idea-room',
      type: 'timer',
      mode: 'idea',
      intervalMinutes: 1440,
      jitterSeconds: 0,
      category: 'idea',
      summary: 'Host one novel discussion.',
    }],
  }));

  try {
    const result = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.match(result.stdout, /"msg":"idea discussion completed"/);
    assert.equal(deepseekCalls, 2);
    assert.equal(hostPosts.length, 2);
    assert.deepEqual(hostPosts[0].targetIds, ['claude', 'codex']);
    assert.equal(hostPosts[0].reactionRounds, 2);
    assert.equal(hostPosts[0].hostName, 'DS 主持');
    assert.equal(hostPosts[1].trigger, false);
    assert.match(hostPosts[1].content, /收尾/);
    assert.equal(vaultCalls.length, 1);
    assert.equal(vaultCalls[0].name, 'write_diary');
    const diary = vaultCalls[0].arguments;
    assert.match(diary.slug, /^idea-\d{4}-\d{2}-\d{2}-[a-f0-9]{16}$/);
    assert.match(diary.title, /^Idea 讨论：/);
    assert.deepEqual(diary.tags.slice(0, 3), ['日记', 'ai-hub', 'idea-discussion']);
    assert.equal(diary.source, 'ai-hub-triage');
    assert.match(diary.content, /日常摩擦/);
    assert.match(diary.content, /主题分类/);
    assert.match(diary.content, /收尾：大家/);
    assert.match(diary.content, /完整对话位置/);
    assert.doesNotMatch(diary.content, /我想删掉反复确认同一件小事/);
    const store = new TriageStore(stateFile);
    try {
      const summary = store.dailySummary();
      assert.equal(summary.ideaPoolDispatched, 1);
      assert.equal(summary.dailyPoolDispatched, 0);
      assert.equal(summary.ideaChecks, 1);
      assert.equal(summary.ideaDiaryPending, 0);
      assert.equal(summary.ideaDiariesWritten, 1);
      assert.equal(summary.ideaDiaryLastError, null);
      assert.ok(summary.lastIdeaDeliveryAt);
      assert.deepEqual(store.recentIdeaTopics(12), [{
        topic: '如果 AI 可以替你永久忘掉一种日常摩擦，你会选哪一种，代价又是什么？',
        category: 'daily-life',
      }]);
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
