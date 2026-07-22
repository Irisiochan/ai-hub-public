import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCodexAppServerError } from '../src/agents/codexAppServer.js';
import { classifyUpstreamHttpError, DirectApiBackend } from '../src/agents/directApi.js';
import { openDb } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.errors-smoke.db');
const uploadsDir = path.join(here, '.errors-smoke-uploads');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
fs.rmSync(uploadsDir, { recursive: true, force: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const requests: any[] = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '群聊正常' } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })}\n\n`);
    res.end();
  });
});
const port = await new Promise<number>((resolve) =>
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
);

const db = openDb(dbPath);
try {
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room', 'AI群', 'room', 'room', '{}')`).run();
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('member-a', 'Member A', 'api', 'dm', '{}')`).run();
  const add = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status) VALUES ('room', ?, ?, 'text', ?, 'done')`
  );
  add.run('user', 'user', '@Member A 看一下');
  add.run('member-a', 'assistant', '   ');
  add.run('user', 'user', '@Member A 再看一下');

  const backend = new DirectApiBackend({
    provider: 'anthropic',
    baseUrl: `http://127.0.0.1:${port}/v1/messages`,
    apiKey: 'test',
    model: 'claude-compatible',
    maxHistoryMessages: 20,
    historyTokenBudget: 4096,
    minRecentTurns: 1,
    summaryMaxTokens: 256,
    historySummaryStrategy: 'extractive',
    maxTokens: 64,
    turnTimeoutMs: 5000,
    db,
    uploadsDir,
    contactId: 'room',
    memberId: 'member-a',
    log: () => {},
    roomMode: { selfId: 'member-a', nameOf: (sender) => sender === 'user' ? 'User' : 'Member A' },
  });
  await backend.start(null);
  const events = [];
  for await (const event of backend.sendTurn({ text: '（群里有新消息，见对话历史。）' }).events) events.push(event);
  assert(events.some((event) => event.type === 'done'), '群聊 API 回合应完成');
  const sentMessages = requests[0].messages as Array<{ role: string; content: unknown }>;
  assert.equal(
    sentMessages.some((message) => message.role === 'assistant' && String(message.content).trim() === ''),
    false,
    '群聊历史不应把空 assistant 消息发给上游'
  );

  assert.equal(
    classifyUpstreamHttpError(
      'openai-compat',
      'gpt-5.6-sol',
      503,
      JSON.stringify({ error: { message: 'Selected model is at capacity. Please try a different model.' } })
    ).category,
    'capacity'
  );
  assert.equal(
    classifyUpstreamHttpError(
      'openai-compat',
      'gpt-5.6-sol',
      429,
      JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } })
    ).category,
    'rate_limit'
  );
  assert.equal(
    classifyUpstreamHttpError(
      'openai-compat',
      'gpt-5.6-sol',
      400,
      JSON.stringify({ error: { code: 'model_not_found', message: 'model does not exist' } })
    ).category,
    'model_unavailable'
  );
  assert.equal(
    classifyUpstreamHttpError(
      'openai-compat',
      'gpt-5.6-sol',
      429,
      JSON.stringify({ error: { code: 'insufficient_quota', message: 'Billing quota exhausted' } })
    ).category,
    'quota',
    'insufficient_quota must stay quota even when transported as HTTP 429'
  );

  assert.equal(
    classifyCodexAppServerError({ message: 'Selected model is at capacity. Please try a different model.', code: -32000 }).category,
    'capacity'
  );
  assert.equal(
    classifyCodexAppServerError({ message: 'Rate limit exceeded', code: 429 }).category,
    'rate_limit'
  );
  assert.equal(
    classifyCodexAppServerError({ message: 'Selected model is not available for this account' }).category,
    'model_unavailable'
  );

  console.log('error classification smoke: ok');
} finally {
  db.close();
  server.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.rmSync(uploadsDir, { recursive: true, force: true });
}
