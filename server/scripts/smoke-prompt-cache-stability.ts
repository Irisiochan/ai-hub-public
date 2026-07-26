/**
 * Prompt-cache contract smoke: two Anthropic turns from the same contact must
 * keep the static system/tools prefixes byte-stable while moving the history
 * breakpoint. Also verifies 1h TTL, four breakpoints, no legacy beta header,
 * and promptCache=off removing all markers.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { AnthropicProvider } from '../src/agents/directApi/anthropic.js';
import type { HistoryMessage, ProviderTools } from '../src/agents/directApi/provider.js';

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
  console.log('prompt cache stability smoke: ok');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
