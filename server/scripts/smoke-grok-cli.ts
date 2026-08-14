import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrokCliBackend } from '../src/agents/grokCli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mockCliPath = path.join(here, 'mock-grok.mjs');

const models = await GrokCliBackend.listModels({
  cliPath: mockCliPath,
  cwd: process.cwd(),
  log: () => {},
});
assert.deepEqual(
  models.map(({ id, isDefault }) => ({ id, isDefault: !!isDefault })),
  [
    { id: 'grok-4.6', isDefault: true },
    { id: 'grok-4.5', isDefault: false },
  ],
  'grok models 运行时目录必须保留当前默认和全部可用模型'
);

const backend = new GrokCliBackend({
  cliPath: mockCliPath,
  cwd: process.cwd(),
  turnTimeoutMs: 5000,
  log: () => {},
});

async function turn(text: string) {
  const events = [];
  for await (const event of backend.sendTurn({ text }).events) events.push(event);
  return events;
}

await backend.start(null);

const cancelled = await turn('cancel');
assert(cancelled.some((event) => event.type === 'delta'), '取消前的半截流式文本仍应可见');
assert(
  cancelled.some(
    (event) =>
      event.type === 'error' &&
      event.message.includes('stop_reason=cancelled') &&
      event.message.includes('半成品')
  ),
  'cancelled 必须成为明确错误'
);
assert(!cancelled.some((event) => event.type === 'done'), 'cancelled 不能伪装成 done');

const completed = await turn('complete');
const done = completed.find((event) => event.type === 'done');
assert(done?.type === 'done' && done.finalText === '完整结论。', '下一轮应 resume 并正常完成');

await backend.stop();

/** 用 mock 回显 argv，断言权限相关 flag 真的到了命令行——漏传是静默失败，
 *  生产里只表现为「阿野说完计划就没了」（stop_reason=cancelled）。 */
async function argvOf(opts: {
  model?: string;
  allowRules?: string[];
  disallowedTools?: string[];
  alwaysApprove?: boolean;
}) {
  const cli = new GrokCliBackend({
    cliPath: mockCliPath,
    cwd: process.cwd(),
    turnTimeoutMs: 5000,
    log: () => {},
    ...opts,
  });
  await cli.start(null);
  const events = [];
  for await (const event of cli.sendTurn({ text: 'flags' }).events) events.push(event);
  await cli.stop();
  const done = events.find((event) => event.type === 'done');
  assert(done?.type === 'done', 'flags 轮应正常完成');
  return JSON.parse(done.finalText) as string[];
}

const argv = await argvOf({
  allowRules: ['MCPTool(memory-vault__*)'],
  disallowedTools: ['search_replace', 'run_terminal_command'],
  alwaysApprove: true,
});
assert(argv.includes('--always-approve'), 'alwaysApprove 必须传成 --always-approve');
assert(
  argv[argv.indexOf('--disallowed-tools') + 1] === 'search_replace,run_terminal_command',
  '危险工具仍必须整个摘掉——always-approve 只在剩下的面上生效'
);
assert(
  argv[argv.indexOf('--allow') + 1] === 'MCPTool(memory-vault__*)',
  'MCP 规则用 server__tool 形式；mcp__ 前缀写法 grok 永不匹配'
);

const plain = await argvOf({});
assert(!plain.includes('--always-approve'), '没开时不得偷偷带上 --always-approve');
assert(!plain.includes('-m') && !plain.includes('--model'), '默认模型不得传 model flag');

const selectedModel = await argvOf({ model: 'grok-4.6' });
const modelFlag = Math.max(selectedModel.indexOf('-m'), selectedModel.indexOf('--model'));
assert.equal(selectedModel[modelFlag + 1], 'grok-4.6', '选定模型必须真正透传给 Grok CLI');

// tool_call / tool_call_update → 与 claude-cli 同构的 tool_use / tool_result 事件
const withTools = new GrokCliBackend({
  cliPath: path.join(here, 'mock-grok.mjs'),
  cwd: process.cwd(),
  turnTimeoutMs: 5000,
  log: () => {},
});
await withTools.start(null);
const toolEvents = [];
for await (const event of withTools.sendTurn({ text: 'tools' }).events) toolEvents.push(event);
const use = toolEvents.find((event) => event.type === 'tool_use');
assert(use?.type === 'tool_use' && use.name === 'search_tool', 'toolName 必须进 tool_use 事件');
assert(use.inputSummary.includes('write_memory'), '入参摘要应保留可读线索');
const result = toolEvents.find((event) => event.type === 'tool_result');
assert(result?.type === 'tool_result' && result.name === 'search_tool' && result.ok, 'toolCallId 应映射回工具名');

// 工具卡住 + 整轮 cancelled：错误消息要点名是哪个工具
const stuckEvents = [];
for await (const event of withTools.sendTurn({ text: 'stuck' }).events) stuckEvents.push(event);
assert(
  stuckEvents.some(
    (event) => event.type === 'error' && event.message.includes('卡在工具 search_tool')
  ),
  'cancelled 时必须点名未完成的工具'
);
await withTools.stop();

console.log('grok cli cancellation smoke: ok');
