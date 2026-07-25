import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  chooseRecipient,
  estimateCostCny,
  normalizeEvent,
  parseTriageJson,
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
