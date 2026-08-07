/**
 * Prompt-cache contract smoke: two Anthropic turns from the same contact must
 * keep the static system/tools prefixes byte-stable while moving the history
 * breakpoint. Also verifies 1h TTL, four breakpoints, no legacy beta header,
 * and promptCache=off removing all markers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DirectApiBackend } from '../src/agents/directApi.js';
import { AnthropicProvider } from '../src/agents/directApi/anthropic.js';
import type { HistoryMessage, ProviderTools } from '../src/agents/directApi/provider.js';
import { openDb } from '../src/db.js';

const requests: Array<{ body: any; headers: http.IncomingHttpHeaders }> = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    requests.push({ body: JSON.parse(raw), headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":1,"cache_read_input_tokens":3}}}\n\n');
    res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n');
    res.end();
  });
});
const port = await new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
});

const config = {
  baseUrl: `http://127.0.0.1:${port}/v1/messages`,
  apiKey: 'test-key',
  model: 'claude-test',
  maxTokens: 32,
  promptCache: 'auto' as const,
};
const tools: ProviderTools = {
  allowCalls: true,
  definitions: [
    { name: 'search_vault', description: 'search', schema: { type: 'object' } },
    { name: 'read_file', description: 'read', schema: { type: 'object' } },
  ],
};
const system = {
  static: 'persona + compact memory preamble',
  summary: '# rolling summary\nolder facts',
};
const baseHistory: HistoryMessage[] = [
  { role: 'user', content: 'first question' },
  { role: 'assistant', content: 'first answer' },
];

async function request(messages: HistoryMessage[], mode: 'auto' | 'off') {
  const logs: string[] = [];
  const provider = new AnthropicProvider({ ...config, promptCache: mode }, (line) => logs.push(line));
  let conversation = provider.createConversation(messages, system);
  conversation = provider.applyCacheBreakpoints(conversation, tools, { mode, ttl: '1h' });
  const usage = provider.createUsage();
  for await (const event of provider.stream(conversation, tools, new AbortController().signal)) {
    if (event.type === 'round') provider.mergeUsage(usage, event.result.usage);
  }
  logs.push(provider.usageLog?.(usage) ?? '');
  return logs;
}

try {
  const firstLogs = await request([...baseHistory, { role: 'user', content: 'turn one' }], 'auto');
  const secondLogs = await request([...baseHistory, { role: 'user', content: 'turn two' }], 'auto');
  await request([...baseHistory, { role: 'user', content: 'off turn' }], 'off');

  assert.equal(requests.length, 3);
  const [first, second, off] = requests.map((entry) => entry.body);
  assert.deepEqual(first.system[0], second.system[0], 'static system block must remain byte-stable');
  assert.equal(JSON.stringify(first.tools), JSON.stringify(second.tools), 'tools JSON must remain byte-stable');

  const markers = (value: unknown) => (JSON.stringify(value).match(/"cache_control"/g) ?? []).length;
  assert.equal(markers(first), 4, 'auto request must contain four Anthropic breakpoints');
  assert.equal(markers(second), 4, 'second auto request must retain four Anthropic breakpoints');
  assert.equal(markers(off), 0, 'promptCache=off must remove every Anthropic breakpoint');
  assert.equal((JSON.stringify(first).match(/"ttl":"1h"/g) ?? []).length, 4, 'all breakpoints use 1h TTL');
  assert.equal(requests[0].headers['anthropic-beta'], undefined, 'legacy cache beta header must not be sent');
  assert(firstLogs.includes('provider=anthropic breakpoints=4 hit=3 write=1'));
  assert(secondLogs.includes('provider=anthropic breakpoints=4 hit=3 write=1'));

  const roomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-room-cache-'));
  const roomDb = openDb(path.join(roomDir, 'hub.db'));
  try {
    roomDb.prepare(`
      INSERT INTO contacts (id, name, backend, kind, config)
      VALUES ('room-cache', '缓存群', 'room', 'room', '{}'),
             ('gem-cache', 'Gem', 'api', 'dm', '{}'),
             ('codex-cache', 'Codex', 'api', 'dm', '{}')
    `).run();
    const insert = roomDb.prepare(`
      INSERT INTO messages (contact_id, sender, role, kind, content, status, created_at)
      VALUES ('room-cache', ?, ?, 'text', ?, 'done', ?)
    `);
    insert.run('user', 'user', '群聊起点', '2026-08-05 07:00:00');
    const codex = insert.run('codex-cache', 'assistant', '上一位成员接话', '2026-08-05 07:00:10');
    const user = insert.run('user', 'user', 'User 本轮补充', '2026-08-05 07:00:20');
    const backend = new DirectApiBackend({
      provider: 'openai-compat',
      baseUrl: 'https://example.invalid',
      apiKey: 'unused',
      model: 'unused',
      maxHistoryMessages: 60,
      historyTokenBudget: 24_000,
      minRecentTurns: 2,
      summaryMaxTokens: 2_000,
      historySummaryStrategy: 'off',
      maxTokens: 128,
      turnTimeoutMs: 1_000,
      db: roomDb,
      uploadsDir: roomDir,
      contactId: 'room-cache',
      memberId: 'gem-cache',
      log: () => {},
      roomMode: {
        selfId: 'gem-cache',
        nameOf: (sender) => ({ user: 'User', 'codex-cache': 'Codex', 'gem-cache': 'Gem' })[sender] ?? sender,
      },
    });
    const firstRoom = (backend as any).history(
      'window one', undefined, [Number(codex.lastInsertRowid), Number(user.lastInsertRowid)]
    );
    const secondRoom = (backend as any).history(
      'window two', undefined, [Number(user.lastInsertRowid)]
    );
    const firstRows = firstRoom.messages.slice(0, -1);
    const secondRows = secondRoom.messages.slice(0, -1);
    assert.deepEqual(
      firstRows,
      secondRows,
      'adjacent room turns must serialize every existing history item byte-stably'
    );
    assert.doesNotMatch(JSON.stringify(firstRows), /本轮新消息/);
    assert.match(JSON.stringify(firstRows), /历史消息/);
  } finally {
    roomDb.close();
    fs.rmSync(roomDir, { recursive: true, force: true });
  }
  console.log('prompt cache stability smoke: ok');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
