import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectApiBackend } from '../src/backends/directApi.js';
import { chooseKeepFrom } from '../src/prompt/historyPolicy.js';
import { parseRoomTargets, roomDirectlyMentions } from '../src/rooms/roomTargets.js';
import { HeuristicTokenizer } from '../src/prompt/tokenEstimate.js';
import { openDb } from '../src/platform/db.js';

const tokenizer = new HeuristicTokenizer();
assert.equal(tokenizer.estimate('你好ab'), 3);
const unitTokenizer = { estimate: (_text: string) => 5 };
const candidates = Array.from({ length: 5 }, (_, index) => ({ content: `row-${index}` }));
assert.equal(chooseKeepFrom(candidates, 2, 3, 100, unitTokenizer), 2, 'hard max keeps newest three');
assert.equal(chooseKeepFrom(candidates, 2, 5, 18, unitTokenizer), 3, 'budget applies after minimum');

const members = [
  { id: 'claude', name: 'Claude' },
  { id: 'gem', name: 'Gem' },
  { id: 'aye', name: '阿野' },
] as any[];
assert.deepEqual(parseRoomTargets(members, '@Claude @gem 来一下', {}).map((row) => row.id), ['claude', 'gem']);
assert.deepEqual(parseRoomTargets(members, '@all 集合', {}).map((row) => row.id), ['claude', 'gem', 'aye']);
assert.deepEqual(parseRoomTargets(members, '无点名', {}).map((row) => row.id), []);
assert.deepEqual(parseRoomTargets(members, '无点名', { respondAllByDefault: true }).map((row) => row.id),
  ['claude', 'gem', 'aye']);
assert.equal(roomDirectlyMentions(members[2], '@阿野 修好了'), true);
assert.equal(roomDirectlyMentions(members[2], '@aye 修好了'), true);
assert.equal(roomDirectlyMentions(members[2], '@all 修好了'), false, '@all is not a direct member mention');

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.architecture-hygiene.db');
const uploadsDir = path.join(here, '.architecture-hygiene-uploads');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
fs.rmSync(uploadsDir, { recursive: true, force: true });
fs.mkdirSync(uploadsDir, { recursive: true });
const db = openDb(dbPath);

try {
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('api-test', 'API', 'api', 'dm', '{}')").run();
  // created_at 是 SQLite 的 UTC 文本；固定下来，本轮消息的上海时间戳（+8h）才能逐字断言。
  const insert = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, created_at)
     VALUES ('api-test', ?, ?, 'text', ?, 'done', ?)`
  );
  insert.run('api-test', 'assistant', 'orphan assistant', '2026-07-26 10:50:00');
  insert.run('user', 'user', 'first', '2026-07-26 10:51:00');
  insert.run('user', 'user', 'second', '2026-07-26 10:52:00');
  insert.run('api-test', 'assistant', 'answer', '2026-07-26 10:53:00');
  const current = insert.run('user', 'user', 'persisted current', '2026-07-26 10:54:00');

  const backend = new DirectApiBackend({
    provider: 'openai-compat',
    baseUrl: 'http://127.0.0.1/unused',
    apiKey: 'test',
    model: 'test',
    maxHistoryMessages: 20,
    historyTokenBudget: 4096,
    minRecentTurns: 2,
    summaryMaxTokens: 512,
    historySummaryStrategy: 'off',
    maxTokens: 64,
    contextWindowTokens: 8192,
    turnTimeoutMs: 1000,
    db,
    uploadsDir,
    contactId: 'api-test',
    memberId: '',
    log: () => {},
  });
  const history = (backend as any).history('injected current', Number(current.lastInsertRowid));
  assert.equal(history.messages[0].role, 'user', 'history cannot start with assistant');
  // 私聊本轮用注入后的文本顶替已落库的那条，并标成带时间的本轮新消息
  // （backends/directApi/base.ts history → memory/inject.ts timestampedMessage）。
  assert.equal(history.messages.at(-1).content, '[2026-07-26 周日 18:54 CST｜本轮新消息] injected current',
    'current turn uses injected text, stamped as this turn\'s new message');
  assert(!JSON.stringify(history.messages).includes('persisted current'), 'persisted copy of the current turn is dropped');
  assert(history.messages.some((message: any) => message.role === 'user' && message.content.includes('first')),
    'adjacent user rows remain represented after merge');

  console.log('architecture hygiene smoke: ok');
} finally {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.rmSync(uploadsDir, { recursive: true, force: true });
}
