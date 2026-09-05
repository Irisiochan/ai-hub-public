import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DirectApiBackend } from '../src/agents/directApi/base.js';
import { DsmlTextFilter } from '../src/agents/directApi/dsml.js';
import { OpenAiProvider } from '../src/agents/directApi/openai.js';
import type { ProviderStreamEvent } from '../src/agents/directApi/provider.js';
import type { TurnEvent } from '../src/agents/types.js';
import { openDb } from '../src/db.js';
import { loadMigrationFiles } from '../src/migrations.js';

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function writeSse(res: http.ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const payload of payloads) {
    res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
  }
  res.end();
}

function dsmlFilterHandlesProductionShape(): void {
  const filter = new DsmlTextFilter();
  const chunks = [
    '让我先看实际内容。<｜｜DS',
    'ML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="read_file">\n',
    '<｜｜DSML｜｜parameter name="path" string="true">tasks/example.md</｜｜DSML｜｜parameter>\n',
    '</｜｜DSML｜｜invoke>\n<｜｜DSML｜｜invoke name="search_vault">\n',
    '<｜｜DSML｜｜parameter name="query" string="true">旧版 &amp; archive</｜｜DSML｜｜parameter>\n',
    '</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>',
  ];
  const visible = chunks.map((chunk) => filter.push(chunk)).join('');
  const final = filter.finish();
  assert.equal(visible + final.visible, '让我先看实际内容。');
  assert.equal(final.detected, true);
  assert.deepEqual(final.calls, [
    { name: 'read_file', input: { path: 'tasks/example.md' } },
    { name: 'search_vault', input: { query: '旧版 & archive' } },
  ]);
}

async function providerStripsDsmlAndKeepsFinishReason(): Promise<void> {
  const server = http.createServer((_req, res) => writeSse(res, [
    { choices: [{ delta: { content: '先查<｜｜DS' } }] },
    {
      choices: [{
        delta: {
          content: 'ML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="read_file">\n<｜｜DSML｜｜parameter name="path" string="true">tasks/x.md</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>',
          tool_calls: [{ index: 0, id: 'standard-1', function: { name: 'read_file', arguments: '{"path":"tasks/x.md"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 30 } },
    '[DONE]',
  ]));
  try {
    const baseUrl = await listen(server);
    const provider = new OpenAiProvider({
      baseUrl,
      apiKey: 'test',
      model: 'test',
      maxTokens: 8192,
      promptCache: 'auto',
    });
    const conversation = provider.createConversation([{ role: 'user', content: 'go' }], { static: '', summary: '' });
    const events: ProviderStreamEvent[] = [];
    for await (const event of provider.stream(conversation, {
      definitions: [{ name: 'read_file', description: 'read', schema: { type: 'object' } }],
      allowCalls: true,
    }, new AbortController().signal)) events.push(event);
    assert.equal(
      events.filter((event) => event.type === 'delta').map((event: any) => event.text).join(''),
      '先查'
    );
    assert.ok(!JSON.stringify(events).includes('DSML'));
    const round = events.find((event) => event.type === 'round');
    assert.ok(round && round.type === 'round');
    assert.equal(round.result.text, '先查');
    assert.equal(round.result.calls.length, 1, 'structured and DSML duplicate calls must collapse');
    assert.deepEqual(round.result.calls[0], { id: 'standard-1', name: 'read_file', input: { path: 'tasks/x.md' } });
    assert.equal(round.result.usage.finishReason, 'tool_calls');
  } finally {
    await close(server);
  }
}

/** 中转若在每个 SSE chunk 重复塞同一份 usage，旧实现 += 会把本轮吹到百万级。 */
async function providerUsageLastWriteNotSumAcrossChunks(): Promise<void> {
  const promptTokens = 12_000;
  const completionTokens = 36_800;
  const repeated = Array.from({ length: 120 }, () => ({
    choices: [{ delta: { content: 'x' } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  }));
  const server = http.createServer((_req, res) => writeSse(res, [
    ...repeated,
    {
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        prompt_tokens_details: { cached_tokens: 400 },
      },
    },
    '[DONE]',
  ]));
  try {
    const baseUrl = await listen(server);
    const provider = new OpenAiProvider({
      baseUrl,
      apiKey: 'test',
      model: 'deepseek-ai/DeepSeek-V3.2',
      maxTokens: 8192,
      promptCache: 'auto',
    });
    const conversation = provider.createConversation(
      [{ role: 'user', content: '写一段' }],
      { static: '', summary: '' }
    );
    const events: ProviderStreamEvent[] = [];
    for await (const event of provider.stream(
      conversation,
      { definitions: [], allowCalls: false },
      new AbortController().signal
    )) events.push(event);
    const round = events.find((event) => event.type === 'round');
    assert.ok(round && round.type === 'round');
    assert.equal(round.result.usage.input, promptTokens, 'must not sum repeated prompt_tokens');
    assert.equal(round.result.usage.output, completionTokens, 'must not sum repeated completion_tokens');
    assert.equal(round.result.usage.cacheRead, 400, 'cache takes last non-null value');
    // 旧 bug：120 次重复 ≈ 1.4M input；这里确保仍是单份。
    assert.ok((round.result.usage.input ?? 0) < promptTokens * 2);
  } finally {
    await close(server);
  }
}

function outputBackend(
  provider: 'openai-compat' | 'gemini',
  baseUrl: string,
  db: ReturnType<typeof openDb>,
  dir: string,
  contactId: string,
): DirectApiBackend {
  return new DirectApiBackend({
    provider,
    baseUrl,
    apiKey: 'test',
    model: 'test',
    maxHistoryMessages: 10,
    historyTokenBudget: 2048,
    minRecentTurns: 1,
    summaryMaxTokens: 256,
    historySummaryStrategy: 'off',
    maxTokens: 8192,
    contextWindowTokens: 20_000,
    turnTimeoutMs: 5000,
    db,
    uploadsDir: path.join(dir, 'uploads'),
    contactId,
    log: () => {},
  });
}

async function collectTurn(
  backend: DirectApiBackend,
  text: string,
  userMessageId: number,
  extra: { emptyVisibleText?: string } = {},
): Promise<TurnEvent[]> {
  await backend.start(null);
  const handle = backend.sendTurn({ text, userMessageId, ...extra });
  const events: TurnEvent[] = [];
  for await (const event of handle.events) events.push(event);
  return events;
}

async function thinkingOnlyBecomesVisibleError(): Promise<void> {
  const server = http.createServer((_req, res) => writeSse(res, [
    { choices: [{ delta: { reasoning_content: 'long private plan' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 8192 } },
    '[DONE]',
  ]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-output-reliability-'));
  const db = openDb(path.join(dir, 'hub.sqlite'));
  try {
    const baseUrl = await listen(server);
    db.prepare(
      `INSERT INTO contacts (id, name, backend, kind, config)
       VALUES ('thinking-only', 'thinking-only', 'api', 'dm', '{}')`
    ).run();
    const user = db.prepare(
      `INSERT INTO messages (contact_id, sender, role, kind, content, status)
       VALUES ('thinking-only', 'user', 'user', 'text', 'answer me', 'done')`
    ).run();
    const events = await collectTurn(
      outputBackend('openai-compat', baseUrl, db, dir, 'thinking-only'),
      'answer me',
      Number(user.lastInsertRowid),
    );
    assert.ok(events.some((event) => event.type === 'thinking'));
    assert.ok(!events.some((event) => event.type === 'done'));
    const error = events.find((event) => event.type === 'error');
    assert.ok(error && error.type === 'error');
    assert.match(error.message, /没有可显示的正文.*输出预算已耗尽/);
  } finally {
    await close(server);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function geminiThoughtOnlyIsVisibleErrorUnlessHeartbeat(): Promise<void> {
  const thoughtOnly = {
    candidates: [{
      content: { role: 'model', parts: [{ text: '先看看要不要说话', thought: true }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 0, thoughtsTokenCount: 20 },
  };
  const server = http.createServer((_req, res) => writeSse(res, [thoughtOnly]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-output-reliability-'));
  const db = openDb(path.join(dir, 'hub.sqlite'));
  try {
    const address = await listen(server);
    const baseUrl = `${address}/v1beta/models/{model}:streamGenerateContent?alt=sse`;
    db.prepare(
      `INSERT INTO contacts (id, name, backend, kind, config)
       VALUES ('gemini-silent', 'gemini-silent', 'api', 'dm', '{}')`
    ).run();
    const user = db.prepare(
      `INSERT INTO messages (contact_id, sender, role, kind, content, status)
       VALUES ('gemini-silent', 'system', 'user', 'text', '[心跳] tick', 'done')`
    ).run();
    const userMessageId = Number(user.lastInsertRowid);
    const chatEvents = await collectTurn(
      outputBackend('gemini', baseUrl, db, dir, 'gemini-silent'),
      '[心跳] tick',
      userMessageId,
    );
    const chatError = chatEvents.find((event) => event.type === 'error');
    assert.ok(chatError && chatError.type === 'error');
    assert.match(chatError.message, /没有可显示的正文/);
    assert.doesNotMatch(chatError.message, /输出预算已耗尽/);
    assert.ok(!chatEvents.some((event) => event.type === 'done'));

    const heartbeatEvents = await collectTurn(
      outputBackend('gemini', baseUrl, db, dir, 'gemini-silent'),
      '[心跳] tick',
      userMessageId,
      { emptyVisibleText: 'HEARTBEAT_OK' },
    );
    assert.ok(heartbeatEvents.some((event) => event.type === 'thinking'));
    const done = heartbeatEvents.find((event) => event.type === 'done');
    assert.ok(done && done.type === 'done');
    assert.equal(done.finalText, 'HEARTBEAT_OK');
    assert.ok(!heartbeatEvents.some((event) => event.type === 'error'));
  } finally {
    await close(server);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function heartbeatEmptyStillErrorsWhenBudgetExhausted(): Promise<void> {
  const server = http.createServer((_req, res) => writeSse(res, [
    { choices: [{ delta: { reasoning_content: 'still thinking' } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 8192 } },
    '[DONE]',
  ]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-output-reliability-'));
  const db = openDb(path.join(dir, 'hub.sqlite'));
  try {
    const baseUrl = await listen(server);
    db.prepare(
      `INSERT INTO contacts (id, name, backend, kind, config)
       VALUES ('heartbeat-length', 'heartbeat-length', 'api', 'dm', '{}')`
    ).run();
    const user = db.prepare(
      `INSERT INTO messages (contact_id, sender, role, kind, content, status)
       VALUES ('heartbeat-length', 'system', 'user', 'text', '[心跳] tick', 'done')`
    ).run();
    const events = await collectTurn(
      outputBackend('openai-compat', baseUrl, db, dir, 'heartbeat-length'),
      '[心跳] tick',
      Number(user.lastInsertRowid),
      { emptyVisibleText: 'HEARTBEAT_OK' },
    );
    const error = events.find((event) => event.type === 'error');
    assert.ok(error && error.type === 'error');
    assert.match(error.message, /没有可显示的正文.*输出预算已耗尽/);
    assert.ok(!events.some((event) => event.type === 'done'));
  } finally {
    await close(server);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function migrationRaisesOnlyLegacyBudget(): void {
  const db = new Database(':memory:');
  try {
    const migrations = loadMigrationFiles();
    for (const migration of migrations.slice(0, 19)) db.exec(migration.sql);
    const insert = db.prepare(
      `INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, 'api', 'dm', ?)`
    );
    insert.run('legacy', 'legacy', JSON.stringify({ maxTokens: 4096 }));
    insert.run('missing', 'missing', JSON.stringify({ model: 'x' }));
    insert.run('custom', 'custom', JSON.stringify({ maxTokens: 16384 }));
    db.exec(migrations[19].sql);
    const budget = (id: string) => Number(db.prepare(
      `SELECT json_extract(config, '$.maxTokens') AS value FROM contacts WHERE id = ?`
    ).get(id)?.value);
    assert.equal(budget('legacy'), 8192);
    assert.equal(budget('missing'), 8192);
    assert.equal(budget('custom'), 16384);
  } finally {
    db.close();
  }
}

dsmlFilterHandlesProductionShape();
await providerStripsDsmlAndKeepsFinishReason();
await providerUsageLastWriteNotSumAcrossChunks();
await thinkingOnlyBecomesVisibleError();
await geminiThoughtOnlyIsVisibleErrorUnlessHeartbeat();
await heartbeatEmptyStillErrorsWhenBudgetExhausted();
migrationRaisesOnlyLegacyBudget();
console.log('direct API output reliability checks passed');
