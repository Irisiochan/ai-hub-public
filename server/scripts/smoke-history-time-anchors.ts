import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compactSummaryText,
  SUMMARY_FORMAT_MARKER,
} from '../src/agents/conversationSummary.js';
import { DirectApiBackend } from '../src/agents/directApi.js';
import { openDb, type MessageRow } from '../src/db.js';
import { shanghaiStamp } from '../src/memory/inject.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.history-time-anchors.db');
const uploadsDir = path.join(here, '.history-time-anchors-uploads');

for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
fs.rmSync(uploadsDir, { recursive: true, force: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const db = openDb(dbPath);
const backendOpts = {
  provider: 'openai-compat' as const,
  baseUrl: 'https://example.invalid',
  apiKey: 'unused',
  model: 'unused',
  maxHistoryMessages: 60,
  historyTokenBudget: 16_000,
  minRecentTurns: 2,
  summaryMaxTokens: 2_000,
  historySummaryStrategy: 'off' as const,
  maxTokens: 128,
  turnTimeoutMs: 1_000,
  db,
  uploadsDir,
  log: () => {},
};

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      !!part && typeof part === 'object' && (part as { type?: string }).type === 'text'
    )
    .map((part) => part.text)
    .join('');
}

try {
  assert.equal(
    shanghaiStamp('2025-12-31 16:30:00'),
    '2026-01-01 周四 00:30 CST',
    '上海时间锚点必须包含换算后的完整年份'
  );

  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config)
     VALUES ('room-time', '时间群', 'api', 'room', '{}'),
            ('gamma-time', 'Agent Gamma', 'api', 'dm', '{}'),
            ('dm-time', '私聊', 'api', 'dm', '{}')`
  ).run();

  const insertRoom = db.prepare(
    `INSERT INTO messages
       (contact_id, sender, role, kind, content, status, created_at)
     VALUES ('room-time', ?, ?, 'text', ?, 'done', ?)`
  );
  insertRoom.run('user', 'user', '红油头发旧话题', '2026-07-23 04:59:08');
  const oldRoomReply = insertRoom.run(
    'gamma-time',
    'assistant',
    '旧回复里的今晚',
    '2026-07-23 05:00:00'
  );
  const currentRoom = insertRoom.run(
    'user',
    'user',
    '今天只讨论动物会说什么',
    '2026-07-26 10:34:56'
  );
  const currentRoom2 = insertRoom.run(
    'user',
    'user',
    '第二条本轮消息',
    '2026-07-26 10:35:00'
  );
  const currentRoom3 = insertRoom.run(
    'user',
    'user',
    '第三条本轮消息',
    '2026-07-26 10:35:04'
  );
  db.prepare(
    `INSERT INTO conversation_summaries
       (contact_id, member_id, summary, through_message_id, version)
     VALUES ('room-time', 'gamma-time', '- 07-23 User：红油头发旧话题', ?, 1)`
  ).run(Number(oldRoomReply.lastInsertRowid));

  const roomBackend = new DirectApiBackend({
    ...backendOpts,
    maxHistoryMessages: 2,
    contactId: 'room-time',
    memberId: 'gamma-time',
    roomMode: {
      selfId: 'gamma-time',
      nameOf: (sender) => sender === 'user' ? 'User' : 'Agent Gamma',
    },
  });
  const roomHistory = (roomBackend as any).history(
    '只处理标有「本轮新消息」的内容',
    undefined,
    [
      Number(currentRoom.lastInsertRowid),
      Number(currentRoom2.lastInsertRowid),
      Number(currentRoom3.lastInsertRowid),
    ]
  );
  const roomText = [
    roomHistory.summarySystem,
    ...roomHistory.messages.map((message: any) => contentText(message.content)),
  ].join('\n');

  assert.match(
    roomText,
    /\[2026-07-23 周四 12:59 CST｜历史摘要\] User：红油头发旧话题/,
    'API 群聊旧摘要必须重建为带完整绝对时间的历史摘要'
  );
  assert.match(
    roomText,
    /"sender_type":"user","occurred_at":"2026-07-26 周日 18:34 CST","temporal":"本轮新消息","content":"今天只讨论动物会说什么"/,
    'API 群聊本轮精确消息 ID 必须在引用数据中标为 User 的本轮新消息'
  );
  assert.doesNotMatch(
    roomText,
    /\[2026-07-23 周四 13:00 CST｜本轮新消息\]/,
    '旧回复不得因位于近期窗口而被误标为本轮'
  );
  assert.equal(
    roomText.split('"temporal":"本轮新消息"').length - 1,
    3,
    '本轮群消息数超过 maxHistoryMessages 时仍必须完整保留在原文窗口'
  );
  const upgradedSummary = db.prepare(
    `SELECT summary FROM conversation_summaries
     WHERE contact_id = 'room-time' AND member_id = 'gamma-time'`
  ).get() as { summary: string };
  assert.ok(
    upgradedSummary.summary.startsWith(SUMMARY_FORMAT_MARKER),
    '线上遗留的旧格式摘要必须在首次读取时自动重建为带时间锚点的新版本'
  );

  const insertDm = db.prepare(
    `INSERT INTO messages
       (contact_id, sender, role, kind, content, status, created_at)
     VALUES ('dm-time', ?, ?, 'text', ?, 'done', ?)`
  );
  insertDm.run('user', 'user', '两天前的问题', '2026-07-24 01:57:29');
  insertDm.run('dm-time', 'assistant', '两天前的回答', '2026-07-24 01:58:00');
  const currentDm = insertDm.run('user', 'user', '现在的新问题', '2026-07-26 10:54:29');
  const dmBackend = new DirectApiBackend({
    ...backendOpts,
    contactId: 'dm-time',
    memberId: '',
  });
  const currentDmText =
    '现在的新问题\n\n<TURN_TIME_PRELOADED>\n上海时间：2026-07-26 周日 18:54:29 CST\n</TURN_TIME_PRELOADED>';
  const dmHistory = (dmBackend as any).history(
    currentDmText,
    Number(currentDm.lastInsertRowid)
  );
  const dmTexts = dmHistory.messages.map((message: any) => contentText(message.content));

  assert.match(
    dmTexts.join('\n'),
    /\[2026-07-24 周五 09:57 CST｜历史消息\] 两天前的问题/,
    'API 私聊旧消息也必须带完整时间与历史标签'
  );
  assert.equal(
    dmTexts.at(-1),
    currentDmText,
    'API 私聊当前用户消息必须保留注入后的当前时间版本，不能误标为历史'
  );

  const summaryRow = db.prepare(
    `SELECT * FROM messages WHERE contact_id = 'room-time' ORDER BY id LIMIT 1`
  ).get() as MessageRow;
  const summary = compactSummaryText('', [summaryRow], {
    summaryMaxTokens: 2_000,
    historyTokenBudget: 16_000,
    nameOf: () => 'User',
  });
  assert.match(
    summary,
    /\[2026-07-23 周四 12:59 CST｜历史摘要\] User：红油头发旧话题/,
    '滚动摘要必须保留完整年份并明确标为历史摘要'
  );
  assert.ok(summary.startsWith(SUMMARY_FORMAT_MARKER), '新摘要必须携带可识别的格式版本');

  console.log('history time anchors smoke: ok');
} finally {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.rmSync(uploadsDir, { recursive: true, force: true });
}
