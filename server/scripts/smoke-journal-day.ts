import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb } from '../src/db.js';
import { journalDay, journalRouter } from '../src/routes/journal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.journal-day-smoke.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });

const db = openDb(dbPath);
const app = express();
app.use(express.json());
app.use('/api', journalRouter(db));
const server = http.createServer(app);
const port = await new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
});
const base = `http://127.0.0.1:${port}/api`;

try {
  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config)
     VALUES ('claude', 'Claude', 'api', 'dm', '{}'),
            ('codex', 'Codex', 'api', 'dm', '{}'),
            ('room-1', '群聊', 'api', 'room', '{}')`
  ).run();

  const insert = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'main'), ?)`
  );

  // 上海 2026-07-24 全天：UTC 2026-07-23 16:00:00 起，到 UTC 2026-07-24 15:59:59 止。
  insert.run('claude', 'user', 'user', 'text', '前一天 23:50 的边界外消息', 'done', '{}', null, '2026-07-23 15:50:00');
  insert.run('claude', 'user', 'user', 'text', '上海 00:10，招财半夜叫', 'done', '{}', null, '2026-07-23 16:10:00');
  insert.run('claude', 'claude', 'assistant', 'text', 'Claude的回复', 'done', '{}', null, '2026-07-23 16:11:00');
  insert.run('codex', 'user', 'user', 'text', '上海 12:00，洗了两只大型犬', 'done', '{}', null, '2026-07-24 04:00:00');
  insert.run('claude', 'user', 'user', 'text', '上海 23:59 压线', 'done', '{}', null, '2026-07-24 15:59:00');
  insert.run('claude', 'user', 'user', 'text', '次日 00:01 的边界外消息', 'done', '{}', null, '2026-07-24 16:01:00');

  // 以下都必须被过滤掉。
  insert.run('claude', 'system', 'user', 'text', '⚡ AI Hub 自主事件分派', 'done', '{}', null, '2026-07-24 04:05:00');
  insert.run('claude', 'user', 'user', 'text', 'uiHidden 的触发消息', 'done', '{"uiHidden":1}', null, '2026-07-24 04:06:00');
  insert.run('claude', 'claude', 'assistant', 'text', '还在流式的半截回复', 'streaming', '{}', null, '2026-07-24 04:07:00');
  insert.run('claude', 'claude', 'thinking', 'thinking', '思考过程', 'done', '{}', null, '2026-07-24 04:08:00');
  insert.run('room-1', 'user', 'user', 'text', '群里的消息', 'done', '{}', null, '2026-07-24 04:09:00');
  insert.run('claude', 'user', 'user', 'text', '副窗里的机器流水', 'done', '{}', 'side', '2026-07-24 04:11:00');
  // 生产 id=1723：老代码把派单指令当成 User 自己发的写进主窗，元数据一片干净，
  // 只有正文能认出来。这条漏过去，日记里就会出现她根本没说过的话。
  insert.run(
    'claude', 'user', 'user', 'text',
    '⚡ AI Hub 自主事件分派\n来源：quarter-hour-check\n分类：backlog｜优先级：P2',
    'done', '{}', null, '2026-07-24 04:12:00'
  );
  insert.run(
    'claude', 'claude', 'assistant', 'text',
    '⚙ Worker 任务回执（网关自动通知，User 也看得到这条）\n交付状态：done',
    'done', '{}', null, '2026-07-24 04:13:00'
  );
  const deleted = insert.run('claude', 'user', 'user', 'text', '已删除的消息', 'done', '{}', null, '2026-07-24 04:10:00');
  db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(Number(deleted.lastInsertRowid));

  const day = journalDay(db, '2026-07-24');
  assert.deepEqual(
    day.map((m) => m.content),
    [
      '上海 00:10，招财半夜叫',
      'Claude的回复',
      '上海 12:00，洗了两只大型犬',
      '上海 23:59 压线',
    ],
    '上海日界必须按 +8 小时切，且过滤掉自动触发/隐藏/未完成/群聊/软删除/副窗/机器正文'
  );
  assert.deepEqual(
    day.map((m) => m.at),
    ['00:10', '00:11', '12:00', '23:59'],
    '时间戳必须是上海本地 HH:MM'
  );
  assert.deepEqual(
    day.map((m) => `${m.contactId}:${m.role}`),
    ['claude:user', 'claude:assistant', 'codex:user', 'claude:user'],
    '联系人与角色必须原样带出，供提取时区分 User 原话和 AI 回复'
  );
  assert.equal(day[0].contactName, 'Claude');

  // 超长正文必须截断并打标，避免一天的 transcript 撑爆 L1 上下文。
  insert.run('claude', 'user', 'user', 'text', 'x'.repeat(2600), 'done', '{}', null, '2026-07-24 05:00:00');
  const clipped = journalDay(db, '2026-07-24').find((m) => m.clipped);
  assert.ok(clipped, '超过上限的正文必须标记 clipped');
  assert.equal(clipped!.content.length, 2000);

  assert.deepEqual(
    journalDay(db, '2026-07-25').map((m) => m.content),
    ['次日 00:01 的边界外消息'],
    '跨过上海午夜的消息必须落到新的一天'
  );
  assert.deepEqual(journalDay(db, '2026-07-26'), [], '没有对话的日期必须返回空数组而不是报错');

  const ok = await fetch(`${base}/journal/day?date=2026-07-24`);
  assert.equal(ok.status, 200);
  const body = await ok.json() as { date: string; truncated: boolean; messages: unknown[] };
  assert.equal(body.date, '2026-07-24');
  assert.equal(body.messages.length, 5);
  assert.equal(body.truncated, false);

  const limited = await fetch(`${base}/journal/day?date=2026-07-24&limit=2`);
  const limitedBody = await limited.json() as { truncated: boolean; messages: unknown[] };
  assert.equal(limitedBody.messages.length, 2);
  assert.equal(limitedBody.truncated, true, '取满 limit 时必须告诉调用方结果被截断');

  for (const bad of ['', '2026-7-4', '2026-13-01', 'today', "2026-07-24' OR 1=1--"]) {
    const res = await fetch(`${base}/journal/day?date=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, `非法日期必须 400：${bad}`);
  }

  console.log('journal day smoke: ok');
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
