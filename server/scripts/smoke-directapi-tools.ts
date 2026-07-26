/**
 * Smoke test: DirectApiBackend tool loop against mock SSE servers.
 * Round 1 returns a tool call, round 2 (after tool_result is fed back)
 * returns text. Verifies openai-compat, anthropic, and native Gemini protocols.
 * Not shipped to production — run with: npx tsx scripts/smoke-directapi-tools.ts
 */
import http from 'node:http';
import { DirectApiBackend } from '../src/agents/directApi.js';
import { AnthropicProvider } from '../src/agents/directApi/anthropic.js';
import { GeminiProvider } from '../src/agents/directApi/gemini.js';
import { OpenAiProvider } from '../src/agents/directApi/openai.js';

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
    return `【假档案】${name} 查到的内容：ai-hub 是用户的多 AI 群聊网关。`;
  },
} as any;

async function runTurn(
  backend: DirectApiBackend,
  label: string,
  expectTool: string,
  assertUsage?: (usage: any) => void
) {
  const events: any[] = [];
  for await (const ev of backend.sendTurn({ text: '给我讲讲 ai-hub 架构' }).events) {
    events.push(ev);
  }
  const kinds = events.map((e) => e.type);
  const done = events.find((e) => e.type === 'done');
  const toolUse = events.find((e) => e.type === 'tool_use');
  const toolResult = events.find((e) => e.type === 'tool_result');
  let ok =
    toolUse?.name === expectTool &&
    toolResult?.ok === true &&
    typeof done?.finalText === 'string' &&
    done.finalText.includes('翻完档案了') &&
    !kinds.includes('error');
  if (ok && assertUsage) {
    try {
      assertUsage(done.usage);
    } catch (e: any) {
      console.log(`[${label}] usage assert failed: ${e.message}`);
      ok = false;
    }
  }
  console.log(`[${label}] ${ok ? 'PASS' : 'FAIL'}  events=${kinds.join(',')}`);
  if (!ok) {
    console.log(JSON.stringify(events, null, 2));
    process.exitCode = 1;
  }
}

// ---------- openai-compat mock ----------
let openaiHits = 0;
const openaiSrv = http.createServer((req, res) => {
  if (req.url !== '/v1beta/openai/chat/completions') {
    res.writeHead(404).end(`unexpected path: ${req.url}`);
    return;
  }
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
            { delta: { tool_calls: [{ index: 0, function: { arguments: 'ries/user-profile.md"}' } }] }, finish_reason: 'tool_calls' },
          ],
        },
        {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 11 },
          },
        },
      ]);
    } else {
      const toolMsg = parsed.messages.find((m: any) => m.role === 'tool');
      if (!toolMsg?.content?.includes('假档案')) throw new Error('tool result not fed back');
      sse(res, [
        { choices: [{ delta: { content: '翻完档案了：ai-hub 是网关架构。' } }] },
        { usage: { prompt_tokens: 200, completion_tokens: 30, prompt_cache_hit_tokens: 15 } },
      ]);
    }
  });
});

// ---------- anthropic mock ----------
let anthropicHits = 0;
const anthropicSrv = http.createServer((req, res) => {
  if (req.url !== '/custom/anthropic/messages') {
    res.writeHead(404).end(`unexpected path: ${req.url}`);
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    anthropicHits++;
    const breakpointCount = (JSON.stringify(parsed).match(/"cache_control"/g) ?? []).length;
    const expectedBreakpoints = anthropicHits === 1 ? 1 : 2;
    if (breakpointCount !== expectedBreakpoints) {
      throw new Error(`expected ${expectedBreakpoints} Anthropic cache breakpoints, got ${breakpointCount}`);
    }
    if ((JSON.stringify(parsed).match(/"ttl":"1h"/g) ?? []).length !== expectedBreakpoints) {
      throw new Error('every Anthropic cache breakpoint must use 1h TTL');
    }
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

// ---------- native Gemini mock ----------
let geminiHits = 0;
const signedFunctionPart = {
  functionCall: {
    name: 'read_file',
    args: { path: 'memories/user-profile.md' },
    id: 'gemini-fc-1',
  },
  thoughtSignature: 'opaque-signature-must-survive',
};
const geminiSrv = http.createServer((req, res) => {
  if (req.url !== '/v1beta/models/mock-model:streamGenerateContent?alt=sse') {
    res.writeHead(404).end(`unexpected path: ${req.url}`);
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    geminiHits++;
    if (req.headers['x-goog-api-key'] !== 'test-key') throw new Error('Gemini API key header missing');
    if (geminiHits === 1) {
      if (!parsed.tools?.[0]?.functionDeclarations?.length) {
        throw new Error('Gemini function declarations missing');
      }
      if (parsed.contents?.[0]?.role !== 'user') throw new Error('Gemini contents role mapping is wrong');
      sse(res, [
        {
          candidates: [{
            content: { role: 'model', parts: [signedFunctionPart] },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 12 },
        },
      ]);
    } else {
      const modelTurn = parsed.contents?.[parsed.contents.length - 2];
      const toolTurn = parsed.contents?.[parsed.contents.length - 1];
      if (JSON.stringify(modelTurn?.parts?.[0]) !== JSON.stringify(signedFunctionPart)) {
        throw new Error('Gemini signed functionCall Part was not preserved exactly');
      }
      const response = toolTurn?.parts?.[0]?.functionResponse;
      if (response?.id !== 'gemini-fc-1' || !response?.response?.output?.includes('假档案')) {
        throw new Error('Gemini functionResponse did not preserve id/result');
      }
      sse(res, [
        {
          candidates: [{
            content: { role: 'model', parts: [{ text: '翻完档案了：Gemini 原生回环完成。' }] },
            finishReason: 'STOP',
          }],
          usageMetadata: {
            promptTokenCount: 180,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 5,
            cachedContentTokenCount: 7,
          },
        },
        {
          candidates: [{
            content: { role: 'model', parts: [{ text: '', thoughtSignature: 'final-signature' }] },
            finishReason: 'STOP',
          }],
          usageMetadata: {
            promptTokenCount: 180,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 5,
            cachedContentTokenCount: 7,
          },
        },
      ]);
    }
  });
});

const [oPort, aPort, gPort] = await Promise.all(
  [openaiSrv, anthropicSrv, geminiSrv].map(
    (srv) =>
      new Promise<number>((resolve) => srv.listen(0, '127.0.0.1', () => resolve((srv.address() as any).port)))
  )
);

const smokeLogs: string[] = [];
const common = {
  apiKey: 'test-key',
  model: 'mock-model',
  maxHistoryMessages: 10,
  historyTokenBudget: 8_000,
  minRecentTurns: 2,
  summaryMaxTokens: 1_000,
  historySummaryStrategy: 'off' as const,
  maxTokens: 1000,
  turnTimeoutMs: 10_000,
  db: fakeDb,
  uploadsDir: process.cwd(),
  contactId: 'c1',
  log: (m: string) => {
    smokeLogs.push(m);
    console.log(`  log: ${m}`);
  },
  vault: fakeVault,
};

const openaiBackend = new DirectApiBackend({
  ...common,
  provider: 'openai-compat',
  baseUrl: `http://127.0.0.1:${oPort}/v1beta/openai/chat/completions`,
});
await openaiBackend.start(null);
await runTurn(openaiBackend, 'openai-compat', 'read_file', (usage) => {
  if (usage?.cacheRead !== 26) {
    throw new Error(
      `expected cacheRead=26 from standard cached_tokens + prompt_cache_hit_tokens, got ${usage?.cacheRead}`
    );
  }
});

const anthropicBackend = new DirectApiBackend({
  ...common,
  provider: 'anthropic',
  baseUrl: `http://127.0.0.1:${aPort}/custom/anthropic/messages`,
});
await anthropicBackend.start(null);
await runTurn(anthropicBackend, 'anthropic', 'search_vault');

const geminiBackend = new DirectApiBackend({
  ...common,
  provider: 'gemini',
  baseUrl: `http://127.0.0.1:${gPort}/v1beta/models/{model}:streamGenerateContent?alt=sse`,
});
await geminiBackend.start(null);
// Gemini：本轮 input 取最终轮 180，而非 90+180=270；output/cache 口径见 smoke-token-efficiency
await runTurn(geminiBackend, 'gemini', 'read_file', (usage) => {
  if (usage?.input !== 180) throw new Error(`expected display input=180, got ${usage?.input}`);
  if (usage?.inputRoundsSum !== 270) throw new Error(`expected roundsSum=270, got ${usage?.inputRoundsSum}`);
  if (usage?.output !== 37) throw new Error(`expected output=37 (12+25), got ${usage?.output}`);
  if (usage?.cacheRead !== 7) throw new Error(`expected final-round cacheRead=7, got ${usage?.cacheRead}`);
  if (usage?.providerRounds !== 2) throw new Error(`expected providerRounds=2, got ${usage?.providerRounds}`);
});
if (!smokeLogs.some((line) => line.includes(
  'gemini usageMetadata={"promptTokenCount":180,"candidatesTokenCount":20,"thoughtsTokenCount":5,"cachedContentTokenCount":7}'
))) {
  throw new Error('expected complete Gemini usageMetadata diagnostic log');
}

const disabledConfig = {
  baseUrl: 'https://example.invalid',
  apiKey: 'unused',
  model: 'unused',
  maxTokens: 1,
  promptCache: 'off' as const,
};
for (const provider of [
  new OpenAiProvider(disabledConfig),
  new GeminiProvider(disabledConfig),
  new AnthropicProvider(disabledConfig),
]) {
  const usage = provider.createUsage();
  provider.mergeUsage(usage, { input: 1, output: 1, cacheRead: 9, cacheCreation: 3 });
  if ('cacheRead' in usage || 'cacheCreation' in usage) {
    throw new Error(`${provider.constructor.name} must hide cache usage when promptCache=off`);
  }
}

console.log(`vault calls: ${JSON.stringify(fakeVault.calls)}`);
openaiSrv.close();
anthropicSrv.close();
geminiSrv.close();
