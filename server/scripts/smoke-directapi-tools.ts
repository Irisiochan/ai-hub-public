/**
 * Smoke test: DirectApiBackend tool loop against mock SSE servers.
 * Round 1 returns a tool call, round 2 (after tool_result is fed back)
 * returns text. Verifies both openai-compat and anthropic protocols.
 * Not shipped to production — run with: npx tsx scripts/smoke-directapi-tools.ts
 */
import http from 'node:http';
import { DirectApiBackend } from '../src/agents/directApi.js';

function sse(res: http.ServerResponse, events: unknown[], done = true) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (done) res.write('data: [DONE]\n\n');
  res.end();
}

const fakeDb = {
  prepare: () => ({ all: () => [], get: () => undefined, run: () => ({}) }),
} as any;

const fakeVault = {
  calls: [] as { name: string; args: any }[],
  async call(name: string, args: any) {
    this.calls.push({ name, args });
    return `【假档案】${name} 查到的内容：ai-hub 是 User 的多 AI 群聊网关。`;
  },
} as any;

async function runTurn(backend: DirectApiBackend, label: string, expectTool: string) {
  const events: any[] = [];
  for await (const ev of backend.sendTurn({ text: '给我讲讲 ai-hub 架构' }).events) {
    events.push(ev);
  }
  const kinds = events.map((e) => e.type);
  const done = events.find((e) => e.type === 'done');
  const toolUse = events.find((e) => e.type === 'tool_use');
  const toolResult = events.find((e) => e.type === 'tool_result');
  const ok =
    toolUse?.name === expectTool &&
    toolResult?.ok === true &&
    typeof done?.finalText === 'string' &&
    done.finalText.includes('翻完档案了') &&
    !kinds.includes('error');
  console.log(`[${label}] ${ok ? 'PASS' : 'FAIL'}  events=${kinds.join(',')}`);
  if (!ok) {
    console.log(JSON.stringify(events, null, 2));
    process.exitCode = 1;
  }
}

// ---------- openai-compat mock ----------
let openaiHits = 0;
const openaiSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    openaiHits++;
    if (openaiHits === 1) {
      if (!parsed.tools?.length) throw new Error('tools not declared');
      sse(res, [
        { choices: [{ delta: { reasoning_content: '我先翻两个文件——' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"memo' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: 'ries/User-core.md"}' } }] }, finish_reason: 'tool_calls' },
          ],
        },
        { usage: { prompt_tokens: 100, completion_tokens: 20 } },
      ]);
    } else {
      const toolMsg = parsed.messages.find((m: any) => m.role === 'tool');
      if (!toolMsg?.content?.includes('假档案')) throw new Error('tool result not fed back');
      sse(res, [
        { choices: [{ delta: { content: '翻完档案了：ai-hub 是网关架构。' } }] },
        { usage: { prompt_tokens: 200, completion_tokens: 30 } },
      ]);
    }
  });
});

// ---------- anthropic mock ----------
let anthropicHits = 0;
const anthropicSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    anthropicHits++;
    if (anthropicHits === 1) {
      if (!parsed.tools?.length) throw new Error('tools not declared');
      sse(
        res,
        [
          { type: 'message_start', message: { usage: { input_tokens: 100 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '等我翻下档案。' } },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'search_vault' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"ai-hub' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ' 架构"}' } },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 25 } },
        ],
        false
      );
    } else {
      const lastUser = parsed.messages[parsed.messages.length - 1];
      const fedBack = JSON.stringify(lastUser.content).includes('假档案');
      if (!fedBack) throw new Error('tool_result not fed back');
      if (parsed.tool_choice?.type === 'none' && anthropicHits === 2) {
        // 第二轮还没到强制收口，应该还是 auto
        throw new Error('tool_choice should still be auto on round 2');
      }
      sse(
        res,
        [
          { type: 'message_start', message: { usage: { input_tokens: 220 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '翻完档案了：网关代执行工具。' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 18 } },
        ],
        false
      );
    }
  });
});

const [oPort, aPort] = await Promise.all(
  [openaiSrv, anthropicSrv].map(
    (srv) =>
      new Promise<number>((resolve) => srv.listen(0, '127.0.0.1', () => resolve((srv.address() as any).port)))
  )
);

const common = {
  apiKey: 'test-key',
  model: 'mock-model',
  maxHistoryMessages: 10,
  maxTokens: 1000,
  turnTimeoutMs: 10_000,
  db: fakeDb,
  uploadsDir: process.cwd(),
  contactId: 'c1',
  log: (m: string) => console.log(`  log: ${m}`),
  vault: fakeVault,
};

const openaiBackend = new DirectApiBackend({ ...common, provider: 'openai-compat', baseUrl: `http://127.0.0.1:${oPort}` });
await openaiBackend.start(null);
await runTurn(openaiBackend, 'openai-compat', 'read_file');

const anthropicBackend = new DirectApiBackend({ ...common, provider: 'anthropic', baseUrl: `http://127.0.0.1:${aPort}` });
await anthropicBackend.start(null);
await runTurn(anthropicBackend, 'anthropic', 'search_vault');

console.log(`vault calls: ${JSON.stringify(fakeVault.calls)}`);
openaiSrv.close();
anthropicSrv.close();
