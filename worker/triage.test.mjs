import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDailyCheckSummary,
  chooseRecipient,
  DELIVERY_POOL_DAILY,
  DELIVERY_POOL_TASK,
  estimateCostCny,
  isShanghaiSilentHour,
  nextTimerDelay,
  normalizeEvent,
  parseTriageJson,
  shanghaiClock,
  timerSchedule,
  TriageStore,
} from './triage-core.mjs';
import { VaultClient } from './triage-clients.mjs';

test('strict triage JSON accepts the contract and rejects invalid priority/category', () => {
  const parsed = parseTriageJson(JSON.stringify({
    actionable: true,
    category: 'calendar',
    priority: 2,
    suggestedRecipient: 'cove',
    rationale: 'deadline is near',
  }));
  assert.equal(parsed.suggestedRecipient, 'cove');
  assert.throws(() => parseTriageJson(JSON.stringify({
    ...parsed,
    priority: 4,
  })), /priority/);
  assert.throws(() => parseTriageJson(JSON.stringify({
    ...parsed,
    category: 'made-up',
  })), /category/);
});

test('events require real context and derive stable dedupe ids', () => {
  assert.throws(() => normalizeEvent({ source: 'timer' }), /real context/);
  const first = normalizeEvent({ source: 'file', summary: 'changed', payload: { path: 'a' } });
  const second = normalizeEvent({ source: 'file', summary: 'changed', payload: { path: 'a' } });
  assert.equal(first.id, second.id);
});

test('timer wakes keep at least one interval between them and never share a dedupe bucket', () => {
  const source = { id: 'quarter-hour-check', intervalMinutes: 15, jitterSeconds: 900 };
  const { intervalMs, jitterMs } = timerSchedule(source);
  assert.equal(intervalMs, 15 * 60_000);
  assert.equal(jitterMs, 900_000);

  // The first wake may land anywhere inside the jitter window; every later wake
  // must clear a full interval first.
  assert.equal(nextTimerDelay(source, { first: true, random: () => 0 }), 0);
  assert.equal(nextTimerDelay(source, { first: true, random: () => 0.999999 }), jitterMs);
  assert.equal(nextTimerDelay(source, { first: false, random: () => 0 }), intervalMs);
  assert.equal(nextTimerDelay(source, { first: false, random: () => 0.999999 }), intervalMs + jitterMs);

  // Worst case is a maximum jitter wake followed by a zero jitter wake, which
  // used to collapse to a few seconds on the old fixed-grid schedule.
  const draws = [0.999999, 0, 0.5, 0.999999, 0.25, 0];
  let now = 1_700_000_000_000;
  let previous = null;
  let previousBucket = null;
  for (const [index, draw] of draws.entries()) {
    now += nextTimerDelay(source, { first: index === 0, random: () => draw });
    if (previous !== null) assert.ok(now - previous >= intervalMs, `wake ${index} fired too early`);
    const bucket = Math.floor(now / intervalMs);
    if (previousBucket !== null) assert.notEqual(bucket, previousBucket);
    previous = now;
    previousBucket = bucket;
  }

  // A source without explicit settings still cannot go below the 15 minute floor.
  assert.ok(nextTimerDelay({ id: 'bare', intervalMinutes: 1 }, { random: () => 0 }) >= 15 * 60_000);
});

test('cost estimate uses separately configurable input and output prices', () => {
  assert.equal(estimateCostCny(
    { prompt_tokens: 1000, completion_tokens: 500 },
    { inputCnyPerMillion: 1, outputCnyPerMillion: 2 },
  ), 0.002);
});

test('SQLite queue deduplicates, recovers leases, retries, and reports metrics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-'));
  const store = new TriageStore(path.join(dir, 'triage.db'));
  try {
    const event = { source: 'test', summary: 'real payload', dedupeKey: 'same' };
    assert.equal(store.enqueue(event).inserted, true);
    assert.equal(store.enqueue(event).inserted, false);
    const claimed = store.claim(1000);
    assert.equal(claimed.status, 'processing');
    assert.equal(store.recoverStale(10, 2000), 1);
    const reclaimed = store.claim(2000);
    store.retry(reclaimed.id, 'temporary', 1000, {
      triageResult: {
        actionable: true,
        category: 'system',
        priority: 1,
        suggestedRecipient: null,
        rationale: 'cached',
      },
      costCny: 0.0002,
      triageLatencyMs: 123,
    }, 2000);
    assert.equal(store.claim(2500), null);
    const final = store.claim(3000);
    assert.equal(final.triageResult.rationale, 'cached');
    assert.equal(final.cost_cny, 0.0002);
    assert.equal(final.triage_latency_ms, 123);
    store.recordDelivery(final.id, 'cove', 3000);
    store.finish(final.id, 'dispatched', {
      recipientId: 'cove',
      triageResult: { fallbackUsed: false },
      costCny: 0.0005,
      triageLatencyMs: 123,
    }, 3000);
    assert.equal(store.recipientUsage('cove', 3000).count, 1);
    const summary = store.dailySummary(3000);
    assert.equal(summary.total, 1);
    assert.equal(summary.deliveries[0].recipient_id, 'cove');
    assert.equal(summary.triagedCount, 1);
    assert.equal(summary.avgTriageLatencyMs, 123);
    // A signal-driven shutdown and the run() finally block both close the
    // store; the second call must not throw ERR_INVALID_STATE.
    store.close();
    assert.doesNotThrow(() => store.close());
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('router prefers explicit idle target then applies daily and cooldown limits', () => {
  const contacts = [
    {
      id: 'cheng',
      name: 'Cheng',
      state: 'active',
      config: {
        routing: {
          enabled: true,
          recipientKey: 'engineering',
          categories: ['file-change'],
          dailyLimit: 10,
          cooldownMinutes: 30,
        },
      },
    },
    {
      id: 'cove',
      name: 'Cove',
      state: 'idle',
      config: {
        routing: {
          enabled: true,
          recipientKey: 'engineering-backup',
          categories: ['file-change'],
          dailyLimit: 10,
          cooldownMinutes: 30,
        },
      },
    },
  ];
  const result = {
    actionable: true,
    category: 'file-change',
    priority: 2,
    suggestedRecipient: null,
    rationale: 'change',
  };
  const routed = chooseRecipient({
    contacts,
    result,
    rules: { 'file-change': 'engineering' },
    usageOf: () => ({ count: 0, lastAt: null }),
    now: 100_000,
  });
  assert.equal(routed.contact.id, 'cove');

  const limited = chooseRecipient({
    contacts: contacts.map((contact) => ({ ...contact, state: 'idle' })),
    result,
    usageOf: () => ({ count: 10, lastAt: 99_000 }),
    now: 100_000,
  });
  assert.equal(limited.contact, null);
  assert.equal(limited.reason, 'all-candidates-rate-limited');
});

test('daily model routing ignores rules and task recipient quotas', () => {
  const contacts = [
    { id: 'cheng', name: '橙', state: 'idle', config: { routing: { enabled: true, recipientKey: 'cheng', categories: ['system'], dailyLimit: 1, cooldownMinutes: 60 } } },
    { id: 'cove', name: 'Cove', state: 'idle', config: { routing: { enabled: true, recipientKey: 'cove', categories: ['system'], dailyLimit: 1, cooldownMinutes: 60 } } },
    { id: 'aye', name: '阿野', state: 'idle', config: { routing: { enabled: true, recipientKey: 'aye', categories: ['system'], dailyLimit: 1, cooldownMinutes: 60 } } },
    { id: 'gem', name: 'Gemini', state: 'idle', config: { routing: { enabled: true, recipientKey: 'gem', categories: ['daily'], dailyLimit: 100, cooldownMinutes: 0 } } },
  ];
  const result = {
    actionable: true,
    category: 'daily',
    priority: 1,
    suggestedRecipient: 'aye',
    rationale: 'light check-in fits Grok',
  };
  const routed = chooseRecipient({
    contacts,
    result,
    rules: { daily: 'cheng' },
    // Task quota already exhausted must not block the daily pool.
    usageOf: () => ({ count: 99, lastAt: 1 }),
    allowedRecipientKeys: ['cheng', 'cove', 'aye'],
    ignoreRecipientLimits: true,
    modelOnly: true,
    now: 100_000,
  });
  assert.equal(routed.contact.id, 'aye');
  assert.equal(routed.reason, 'model-suggestion');

  const missing = chooseRecipient({
    contacts,
    result: { ...result, suggestedRecipient: null },
    rules: { daily: 'cheng' },
    allowedRecipientKeys: ['cheng', 'cove', 'aye'],
    ignoreRecipientLimits: true,
    modelOnly: true,
  });
  assert.equal(missing.contact, null);
  assert.equal(missing.reason, 'no-route');
});

test('Shanghai silent window and daily delivery pools stay separate from task quotas', () => {
  // 2026-07-25 16:30 UTC = 2026-07-26 00:30 Asia/Shanghai → silent
  assert.equal(isShanghaiSilentHour(Date.parse('2026-07-25T16:30:00Z'), 0, 9), true);
  // 2026-07-26 01:15 UTC = 09:15 Asia/Shanghai → open
  assert.equal(isShanghaiSilentHour(Date.parse('2026-07-26T01:15:00Z'), 0, 9), false);
  assert.match(buildDailyCheckSummary({ summary: 'hello' }, Date.parse('2026-07-26T01:15:00Z')), /Asia\/Shanghai/);
  assert.equal(shanghaiClock(Date.parse('2026-07-26T01:15:00Z')).hour, 9);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-pool-'));
  const store = new TriageStore(path.join(dir, 'triage.db'));
  try {
    const now = Date.parse('2026-07-26T04:00:00Z'); // 12:00 Shanghai
    store.enqueue({ source: 'task', summary: 'work item', dedupeKey: 't1' });
    store.enqueue({ source: 'daily', summary: 'care item', dedupeKey: 'd1' });
    const task = store.claim(now);
    store.recordDelivery(task.id, 'cheng', now, DELIVERY_POOL_TASK);
    store.finish(task.id, 'dispatched', { recipientId: 'cheng' }, now);
    const daily = store.claim(now + 1);
    store.recordDelivery(daily.id, 'cheng', now + 1, DELIVERY_POOL_DAILY);
    store.finish(daily.id, 'dispatched', { recipientId: 'cheng' }, now + 1);

    assert.equal(store.recipientUsage('cheng', now + 1, DELIVERY_POOL_TASK).count, 1);
    assert.equal(store.recipientUsage('cheng', now + 1, DELIVERY_POOL_DAILY).count, 1);
    // Task quota path only sees the task pool.
    assert.equal(store.recipientUsage('cheng', now + 1).count, 1);
    assert.equal(store.poolUsage(DELIVERY_POOL_DAILY, now + 1).count, 1);
    const summary = store.dailySummary(now + 1);
    assert.equal(summary.dailyPoolDispatched, 1);
    assert.equal(summary.pools.task, 1);
    assert.equal(summary.pools.daily, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('minimal streamable HTTP MCP client initializes a session and calls a vault tool', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      seen.push({ message, session: req.headers['mcp-session-id'] });
      if (message.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'session-1',
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
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: 'vault result' }] },
        })}\n\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const client = new VaultClient({ url: `http://127.0.0.1:${address.port}/mcp` });
  try {
    assert.equal(await client.call('search_vault', { query: 'triage-backlog' }), 'vault result');
    assert.equal(seen[0].message.method, 'initialize');
    assert.equal(seen[1].session, 'session-1');
    assert.equal(seen[2].message.method, 'tools/call');
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
