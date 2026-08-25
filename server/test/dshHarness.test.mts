import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DshHarnessBackend } from '../src/agents/dshHarness.js';
import type { TurnEvent } from '../src/agents/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-dsh-harness-'));
const home = path.join(root, 'home');
const workspace = path.join(home, 'jingwan-workspace');
let sessionId = '';
let prompted = false;
const calls: Array<{ method: string; payload: any }> = [];

const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  calls.push({ method: request.method, payload: request.payload });
  let value: unknown;
  switch (request.method) {
    case 'session.list':
      value = { items: sessionId ? [{ sessionId, running: false }] : [] };
      break;
    case 'session.create':
      sessionId = request.payload.sessionId;
      value = { sessionId, agentPreset: 'standard' };
      break;
    case 'session.selectModel':
      value = { selected: request.payload };
      break;
    case 'session.prompt':
      prompted = true;
      value = { accepted: true };
      break;
    case 'session.history':
      value = {
        events: prompted ? [
          { event: { type: 'user/message', seq: 0, time: 1, data: {} } },
          { event: { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [{ type: 'text', text: '鲸晚 harness 正常' }] } } } },
          { event: { type: 'turn/end', seq: 2, time: 3, data: { reason: 'complete' } } },
        ] : [],
        hasMore: false,
      };
      break;
    case 'session.cancel':
      value = { accepted: true };
      break;
    default:
      res.writeHead(404).end();
      return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'client-response', rpcId: request.rpcId, result: { ok: true, value } }));
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');

const backend = new DshHarnessBackend({
  command: 'must-not-spawn',
  home,
  workspace,
  port: address.port,
  model: 'deepseek-v4-pro',
  apiKey: 'test-key',
  baseUrl: 'https://api.deepseek.com/v1/chat/completions',
  systemPrompt: '你是鲸晚。',
  turnTimeoutMs: 5000,
  log: () => {},
});

try {
  await backend.start(null);
  const events: TurnEvent[] = [];
  for await (const event of backend.sendTurn({ text: '你好' }).events) events.push(event);
  assert.match(sessionId, /^aihub-/);
  assert.deepEqual(events, [
    { type: 'session', sessionId },
    { type: 'done', finalText: '鲸晚 harness 正常' },
  ]);
  assert.equal(calls.find((call) => call.method === 'session.create')?.payload.cwd, workspace);
  assert.deepEqual(calls.find((call) => call.method === 'session.selectModel')?.payload, {
    sessionId,
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
  });
  assert.equal(calls.find((call) => call.method === 'session.prompt')?.payload.clientTimeZone, 'Asia/Shanghai');
  assert.match(fs.readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8'), /autonomous-workspace/);
  assert.equal(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), '你是鲸晚。\n');
} finally {
  await backend.stop();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('dshHarness tests passed');
