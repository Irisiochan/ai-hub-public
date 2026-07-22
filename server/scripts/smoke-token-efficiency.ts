import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DirectApiBackend,
  estimateTokens,
  TOOL_RESULT_MAX_CHARS,
} from '../src/agents/directApi.js';
import { touchConversationSummary } from '../src/agents/conversationSummary.js';
import { openDb, invalidateConversationSummary } from '../src/db.js';
import { buildSessionPreamble } from '../src/memory/inject.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.token-efficiency-smoke.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });

/** 与 manager.ts / ContactConfig 对齐的 API 默认（未显式配置时）。 */
const API_DEFAULT_HISTORY_TOKEN_BUDGET = 8000;
const API_DEFAULT_MEMORY_PREAMBLE_MODE = 'compact' as const;

assert.equal(API_DEFAULT_HISTORY_TOKEN_BUDGET, 8000, 'API 默认 historyTokenBudget 应为 8000');
assert.equal(API_DEFAULT_MEMORY_PREAMBLE_MODE, 'compact', 'API 默认 memoryPreambleMode 应为 compact');
assert.ok(
  TOOL_RESULT_MAX_CHARS >= 4000 && TOOL_RESULT_MAX_CHARS <= 6000,
  `TOOL_RESULT_MAX_CHARS 应在 4k–6k，当前 ${TOOL_RESULT_MAX_CHARS}`
);

const db = openDb(dbPath);
try {
  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config)
     VALUES ('test-api', 'Test API', 'api', 'dm', '{}')`
  ).run();
  const insert = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status)
     VALUES ('test-api', ?, ?, 'text', ?, 'done')`
  );
  for (let i = 0; i < 24; i++) {
    const assistant = i % 2 === 1;
    insert.run(assistant ? 'test-api' : 'user', assistant ? 'assistant' : 'user', `${i}号消息 ${'长内容'.repeat(180)}`);
  }

  const backend = new DirectApiBackend({
    provider: 'openai-compat',
    baseUrl: 'https://example.invalid',
    apiKey: 'unused',
    model: 'unused',
    systemPrompt: 'persona\nMEMORY',
    memoryPreamble: 'MEMORY',
    maxHistoryMessages: 60,
    historyTokenBudget: 2048,
    minRecentTurns: 2,
    summaryMaxTokens: 256,
    historySummaryStrategy: 'extractive',
    maxTokens: 128,
    turnTimeoutMs: 1000,
    db,
    uploadsDir: path.join(here, '.token-efficiency-uploads'),
    contactId: 'test-api',
    log: () => {},
  });

  const built = (backend as any).history('本轮最新消息');
  const saved = db.prepare(
    `SELECT summary, through_message_id FROM conversation_summaries
     WHERE contact_id = 'test-api' AND member_id = ''`
  ).get() as { summary: string; through_message_id: number } | undefined;
  assert(saved && saved.through_message_id > 0, '超预算后应持久化滚动摘要');
  assert(built.summarySystem.includes('对话滚动摘要'), '摘要应作为独立 system 块返回');
  assert(built.messages.at(-1)?.content === '本轮最新消息', '当前用户文本必须使用注入后的参数版本');
  assert(built.messages.length <= 60, '原文消息必须遵守硬上限');
  assert(estimateTokens(saved.summary) <= 280, '摘要应接近配置预算');

  // --- 局部摘要重建：近期原文区变更 → kept；覆盖区删除 → rebuilt 且不含被删内容 ---
  const throughBefore = saved.through_message_id;
  const keptTouch = touchConversationSummary(db, 'test-api', '', throughBefore + 1, {
    summaryMaxTokens: 256,
    historyTokenBudget: 2048,
  });
  assert.equal(keptTouch.action, 'kept', '只改 through 之后的消息应保留摘要');
  assert.equal(
    (db.prepare(`SELECT through_message_id FROM conversation_summaries WHERE contact_id='test-api'`).get() as any)
      .through_message_id,
    throughBefore,
    'kept 时 through 不变'
  );

  const coveredId = Math.max(1, throughBefore - 1);
  const doomedContent = (
    db.prepare(`SELECT content FROM messages WHERE id = ?`).get(coveredId) as { content: string }
  ).content;
  db.prepare(`UPDATE messages SET deleted = 1 WHERE id = ?`).run(coveredId);
  const rebuilt = touchConversationSummary(db, 'test-api', '', coveredId, {
    summaryMaxTokens: 256,
    historyTokenBudget: 2048,
  });
  assert.equal(rebuilt.action, 'rebuilt', '摘要覆盖区内删除应局部重建');
  const afterRebuild = db
    .prepare(`SELECT summary, through_message_id FROM conversation_summaries WHERE contact_id = 'test-api'`)
    .get() as { summary: string; through_message_id: number };
  assert.ok(afterRebuild.summary.length > 0, '重建后仍有摘要');
  assert.ok(
    !afterRebuild.summary.includes(doomedContent.slice(0, 40)),
    '重建摘要不得残留已删除消息正文'
  );

  // 会话重置路径：affectedFromId=0 仍整份清除
  invalidateConversationSummary(db, 'test-api');
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM conversation_summaries WHERE contact_id = 'test-api'`).get().n,
    0,
    '整份 invalidate 后摘要必须清空'
  );

  // --- 上下文预留：开启 contextWindow 后原文预算应更紧（更早进入摘要）---
  for (let i = 0; i < 12; i++) {
    insert.run(i % 2 === 1 ? 'test-api' : 'user', i % 2 === 1 ? 'assistant' : 'user', `${i}预留 ${'块'.repeat(120)}`);
  }
  const loose = new DirectApiBackend({
    provider: 'openai-compat',
    baseUrl: 'https://example.invalid',
    apiKey: 'unused',
    model: 'unused',
    maxHistoryMessages: 60,
    historyTokenBudget: 4000,
    minRecentTurns: 2,
    summaryMaxTokens: 400,
    historySummaryStrategy: 'extractive',
    maxTokens: 128,
    contextWindowTokens: 0,
    turnTimeoutMs: 1000,
    db,
    uploadsDir: path.join(here, '.token-efficiency-uploads'),
    contactId: 'test-api',
    log: () => {},
  });
  const tight = new DirectApiBackend({
    provider: 'openai-compat',
    baseUrl: 'https://example.invalid',
    apiKey: 'unused',
    model: 'unused',
    systemPrompt: 'S'.repeat(8000),
    maxHistoryMessages: 60,
    historyTokenBudget: 4000,
    minRecentTurns: 2,
    summaryMaxTokens: 400,
    historySummaryStrategy: 'extractive',
    maxTokens: 2048,
    contextWindowTokens: 12_000,
    turnTimeoutMs: 1000,
    db,
    uploadsDir: path.join(here, '.token-efficiency-uploads'),
    contactId: 'test-api',
    log: () => {},
    vault: { call: async () => 'x' } as any,
  });
  const looseH = (loose as any).history('loose-latest');
  // 清掉 loose 可能写的摘要，让 tight 从同样消息集起步
  invalidateConversationSummary(db, 'test-api');
  const tightH = (tight as any).history('tight-latest');
  assert.ok(
    tightH.historyTokens <= looseH.historyTokens + 50,
    `有 context 预留时历史原文不应更肥：tight=${tightH.historyTokens} loose=${looseH.historyTokens}`
  );

  // --- compact preamble ---
  const compactCalls: string[] = [];
  const compact = await buildSessionPreamble(
    {
      call: async (name: string, args?: Record<string, unknown>) => {
        compactCalls.push(`${name}:${String(args?.path ?? '')}`);
        return `---\ntitle: test\n---\n# 核心\n${'稳定事实'.repeat(1000)}`;
      },
    } as any,
    { id: 'test-api', name: '测试联系人', backend: 'api' },
    'compact'
  );
  assert(!compactCalls.some((c) => c.startsWith('get_context:')), 'compact 不应调用完整 get_context');
  assert(
    compactCalls.some((c) => c.startsWith('get_core_context:')),
    'compact 应调用 get_core_context'
  );
  assert(compact.includes('compact-v1'), 'compact 前缀应携带可辨识版本');
  assert(compact.includes('当前会话身份边界'), 'compact 必须保留 identityGuard');
  const compactGuardHits = compact.split('当前会话身份边界').length - 1;
  assert.equal(compactGuardHits, 1, 'compact 的 identityGuard 应只出现一次');

  // --- full preamble：identityGuard 不得双份 ---
  const full = await buildSessionPreamble(
    {
      call: async (name: string) => {
        if (name === 'get_context') return '# FULL_CTX\n' + '大段记忆'.repeat(50);
        throw new Error(`unexpected ${name}`);
      },
    } as any,
    { id: 'gem', name: 'Gem', backend: 'api' },
    'full'
  );
  assert(full.includes('full-v1'), 'full 前缀应携带可辨识版本');
  assert(full.includes('FULL_CTX'), 'full 应注入 get_context 结果');
  const fullGuardHits = full.split('当前会话身份边界').length - 1;
  assert.equal(fullGuardHits, 1, 'full 的 identityGuard 不得重复注入');

  // --- tool result 截断 ---
  const longText = 'X'.repeat(TOOL_RESULT_MAX_CHARS + 2500);
  let truncatedOut = '';
  const truncBackend = new DirectApiBackend({
    provider: 'openai-compat',
    baseUrl: 'https://example.invalid',
    apiKey: 'unused',
    model: 'unused',
    maxHistoryMessages: 10,
    historyTokenBudget: API_DEFAULT_HISTORY_TOKEN_BUDGET,
    minRecentTurns: 2,
    summaryMaxTokens: 1000,
    historySummaryStrategy: 'off',
    maxTokens: 128,
    turnTimeoutMs: 1000,
    db,
    uploadsDir: path.join(here, '.token-efficiency-uploads'),
    contactId: 'test-api',
    log: () => {},
    vault: {
      call: async () => longText,
    } as any,
  });
  const queue = {
    push: () => {},
  } as any;
  const toolOut = await (truncBackend as any).execTool('read_file', { path: 'x.md' }, queue);
  truncatedOut = toolOut.text;
  assert.equal(toolOut.ok, true);
  assert.equal(
    truncatedOut.length,
    TOOL_RESULT_MAX_CHARS,
    `工具结果应截断到 ${TOOL_RESULT_MAX_CHARS} 字符`
  );

  // --- Gemini 多工具轮 usage：input 用最终轮，inputRoundsSum 为各轮累加 ---
  let geminiHits = 0;
  const geminiSrv = http.createServer((req, res) => {
    if (!req.url?.includes('streamGenerateContent')) {
      res.writeHead(404).end();
      return;
    }
    geminiHits++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (geminiHits === 1) {
      res.write(
        `data: ${JSON.stringify({
          candidates: [{
            content: {
              role: 'model',
              parts: [{
                functionCall: { name: 'read_file', args: { path: 'a.md' }, id: 'fc1' },
                thoughtSignature: 'sig-1',
              }],
            },
            finishReason: 'STOP',
          }],
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 40, cachedContentTokenCount: 100 },
        })}\n\n`
      );
    } else {
      res.write(
        `data: ${JSON.stringify({
          candidates: [{
            content: { role: 'model', parts: [{ text: '查完了。' }] },
            finishReason: 'STOP',
          }],
          usageMetadata: {
            promptTokenCount: 1800,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 5,
            cachedContentTokenCount: 200,
          },
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: 1800,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 5,
            cachedContentTokenCount: 200,
          },
        })}\n\n`
      );
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const gPort = await new Promise<number>((resolve) => {
    geminiSrv.listen(0, '127.0.0.1', () => resolve((geminiSrv.address() as any).port));
  });
  try {
    const gemLogs: string[] = [];
    const gemBackend = new DirectApiBackend({
      provider: 'gemini',
      baseUrl: `http://127.0.0.1:${gPort}/v1beta/models/{model}:streamGenerateContent?alt=sse`,
      apiKey: 'k',
      model: 'mock',
      maxHistoryMessages: 10,
      historyTokenBudget: API_DEFAULT_HISTORY_TOKEN_BUDGET,
      minRecentTurns: 2,
      summaryMaxTokens: 1000,
      historySummaryStrategy: 'off',
      maxTokens: 256,
      turnTimeoutMs: 10_000,
      db,
      uploadsDir: path.join(here, '.token-efficiency-uploads'),
      contactId: 'test-api',
      log: (m) => gemLogs.push(m),
      vault: {
        call: async () => '短结果',
      } as any,
    });
    await gemBackend.start(null);
    const events: any[] = [];
    for await (const ev of gemBackend.sendTurn({ text: '查一下' }).events) events.push(ev);
    const done = events.find((e) => e.type === 'done');
    assert(done?.usage, 'Gemini turn 应上报 usage');
    // 旧口径：1000+1800=2800 虚高；展示口径应取最终轮 1800
    assert.equal(done.usage.input, 1800, '本轮 input 应为最终轮 promptTokenCount');
    assert.equal(done.usage.inputRoundsSum, 2800, 'inputRoundsSum 应为各轮 prompt 累加');
    assert.equal(done.usage.output, 65, 'output 仍按轮累加（40 + 25）');
    assert.equal(done.usage.cacheRead, 200, 'cacheRead 取最终轮');
    assert.equal(done.usage.providerRounds, 2, '应记录两趟上游请求');
    assert(
      gemLogs.some((l) => l.includes('display.input=1800') && l.includes('roundsSum=2800')),
      '日志应区分 display.input 与 roundsSum'
    );
    // 明确禁止旧行为
    assert.notEqual(done.usage.input, 2800, '不得把各轮 prompt 简单相加当本轮 input');
  } finally {
    geminiSrv.close();
  }

  console.log('token efficiency smoke: ok');
} finally {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
