import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TriageStore } from './triage-core.mjs';

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

function runWorker(configPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['triage-worker.mjs', configPath, '--once'], {
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
      assert.equal(JSON.parse(body.messages[1].content).recentBacklog, 'no e');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actionable: true,
              category: 'system',
              priority: 2,
              suggestedRecipient: 'engineering',
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
        contacts: [{
          id: 'beta',
          name: 'Agent Beta',
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
          },
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
          result: { content: [{ type: 'text', text: 'no existing triage backlog' }] },
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
    routing: { rules: { system: 'engineering' }, fuzzyFallback: true },
    sources: [{
      id: 'test-timer',
      type: 'timer',
      intervalMinutes: 15,
      jitterSeconds: 0,
      category: 'system',
      summary: 'Inspect one concrete mocked event.',
    }],
  }));

  try {
    const result = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.match(result.stdout, /"msg":"event dispatched"/);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].url, '/api/contacts/beta/messages');
    assert.match(dispatched[0].body.content, /真实事件上下文/);
    const store = new TriageStore(stateFile);
    try {
      const summary = store.dailySummary();
      assert.equal(summary.statuses.find((row) => row.status === 'dispatched').count, 1);
      assert.equal(summary.deliveries[0].recipient_id, 'beta');
      assert.equal(summary.triagedCount, 1);
      assert.equal(Number.isInteger(summary.avgTriageLatencyMs), true);
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('daily path uses real context, a guaranteed slot, and a companion-specific prompt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-daily-e2e-'));
  const dispatched = [];
  const deepseek = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const user = JSON.parse(body.messages[1].content);
      assert.equal(user.mode, 'daily');
      assert.equal(user.recentBacklog, undefined);
      assert.match(body.messages[0].content, /guaranteed daily slot/);
      assert.match(user.proactiveContext.openTaskSnapshot, /today task/);
      assert.equal(user.proactiveContext.recentConversations[0].recipient, 'beta');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actionable: true,
              category: 'daily',
              priority: 1,
              suggestedRecipient: 'beta',
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
          id: 'beta',
          name: 'Agent Beta',
          kind: 'dm',
          state: 'idle',
          last_at: '2026-07-26 13:00:00',
          last_content: '最近在聊今天的安排。',
          config: { routing: { enabled: true, recipientKey: 'beta', categories: ['system'] } },
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
        assert.equal(message.params.name, 'get_task_context');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: 'today task: have lunch and rest' }] },
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
      recipients: ['beta'],
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
    assert.equal(dispatched[0].url, '/api/contacts/beta/messages');
    assert.match(dispatched[0].body.content, /直接用你自己的自然语气/);
    assert.doesNotMatch(dispatched[0].body.content, /真实事件上下文/);
    const store = new TriageStore(stateFile);
    try {
      const summary = store.dailySummary();
      assert.equal(summary.dailyPoolDispatched, 1);
      assert.equal(summary.dailyChecks, 1);
      assert.equal(summary.dailyNoops, 0);
      assert.ok(summary.lastDailyDeliveryAt);
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('idea path hosts a tracked room round, observes PASS, summarizes, and uses its own pool', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-idea-e2e-'));
  const hostPosts = [];
  let deepseekCalls = 0;
  const deepseek = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(body.model, 'deepseek-v4-pro');
      deepseekCalls++;
      const isSummary = body.messages[0].content.includes('closing a private multi-AI room discussion');
      const content = isSummary
        ? { summary: '收尾：大家从体验与工程两侧给出了不同答案，真正的分歧在于便利和自主性的边界。' }
        : {
          topic: '如果 AI 可以替你永久忘掉一种日常摩擦，你会选哪一种，代价又是什么？',
          category: 'daily-life',
          targetIds: ['alpha', 'beta'],
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
    { id: 'room', name: '会议室', kind: 'room', state: 'idle', config: { members: ['alpha', 'beta'] } },
    { id: 'alpha', name: 'Agent Alpha', kind: 'dm', state: 'idle', config: {} },
    { id: 'beta', name: 'Agent Beta', kind: 'dm', state: 'idle', config: {} },
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
          { id: 11, sender: 'alpha', kind: 'text', status: 'done', content: '我想删掉反复确认同一件小事。' },
          { id: 12, sender: 'beta', kind: 'text', status: 'done', content: '我更在意保留选择权，便利不能替代自主。' },
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
    proactive: {
      silentStartHour: 0,
      silentEndHour: 0,
      recipients: ['beta'],
    },
    idea: {
      enabled: true,
      roomId: 'room',
      dailyDispatchLimit: 1,
      reactionRounds: 3,
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
    assert.deepEqual(hostPosts[0].targetIds, ['alpha', 'beta']);
    assert.equal(hostPosts[0].reactionRounds, 3);
    assert.equal(hostPosts[0].hostName, 'DS 主持');
    assert.equal(hostPosts[1].trigger, false);
    assert.match(hostPosts[1].content, /收尾/);
    const store = new TriageStore(stateFile);
    try {
      const summary = store.dailySummary();
      assert.equal(summary.ideaPoolDispatched, 1);
      assert.equal(summary.dailyPoolDispatched, 0);
      assert.equal(summary.ideaChecks, 1);
      assert.ok(summary.lastIdeaDeliveryAt);
      assert.deepEqual(store.recentIdeaTopics(12), [{
        topic: '如果 AI 可以替你永久忘掉一种日常摩擦，你会选哪一种，代价又是什么？',
        category: 'daily-life',
      }]);
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
