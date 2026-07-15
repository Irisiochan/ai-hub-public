import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectApiBackend, estimateTokens } from '../src/agents/directApi.js';
import { openDb, invalidateConversationSummary } from '../src/db.js';
import { buildSessionPreamble } from '../src/memory/inject.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.token-efficiency-smoke.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });

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

  invalidateConversationSummary(db, 'test-api');
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM conversation_summaries WHERE contact_id = 'test-api'`).get().n,
    0,
    '编辑/删除后的摘要必须失效'
  );

  const calls: string[] = [];
  const compact = await buildSessionPreamble(
    {
      call: async (name: string, args?: Record<string, unknown>) => {
        calls.push(`${name}:${String(args?.path ?? '')}`);
        return `---\ntitle: test\n---\n# 核心\n${'稳定事实'.repeat(1000)}`;
      },
    } as any,
    { id: 'test-api', name: '测试联系人', backend: 'api' },
    'compact'
  );
  assert(!calls.some((c) => c.startsWith('get_context:')), 'compact 不应调用完整 get_context');
  assert(calls.filter((c) => c.startsWith('read_file:')).length === 2, 'compact 应只读两份核心文件');
  assert(compact.includes('compact-v1'), 'compact 前缀应携带可辨识版本');

  console.log('token efficiency smoke: ok');
} finally {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
