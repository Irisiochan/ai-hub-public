import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrokCliBackend } from '../src/agents/grokCli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = new GrokCliBackend({
  cliPath: path.join(here, 'mock-grok.mjs'),
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
console.log('grok cli cancellation smoke: ok');
