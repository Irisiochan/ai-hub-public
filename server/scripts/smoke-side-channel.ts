import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactSummaryText } from '../src/agents/conversationSummary.js';
import { DirectApiBackend } from '../src/agents/directApi.js';
import { historicalMessageText } from '../src/agents/sideChannel.js';
import { frameAutomatedTurn, replyTriggerMeta } from '../src/agents/messageSource.js';
import { openDb, type MessageRow } from '../src/db.js';
import { messagesRouter } from '../src/routes/messages.js';
import { SseHub } from '../src/sse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.side-channel.db');
const uploadsDir = path.join(here, '.side-channel-uploads');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
fs.rmSync(uploadsDir, { recursive: true, force: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const db = openDb(dbPath);
const sse = new SseHub();
const queued: number[] = [];
const manager = {
  get: () => ({ enqueue: ({ userMessageId }: { userMessageId: number }) => {
    queued.push(userMessageId);
    return 'queued';
  } }),
} as any;
const app = express();
app.use(express.json());
app.use('/api/contacts', messagesRouter(db, sse, manager, uploadsDir));
const listener = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => listener.once('listening', resolve));
const address = listener.address();
assert(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}/api/contacts/codex/messages`;

async function post(body: Record<string, unknown>): Promise<Response> {
  return fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

try {
  db.prepare(
    "INSERT INTO contacts (id, name, backend, kind, config) VALUES ('codex', 'Codex', 'api', 'dm', '{}')"
  ).run();

  assert.equal((await post({ content: 'User 手打' })).status, 202);
  const triageContent = [
    '⚡ AI Hub 自主事件分派',
    '来源：quarter-hour-check',
    '分类：backlog｜优先级：P2',
    '判断：需要检查',
    '',
    `真实事件上下文：${'绝不应进入历史原文'.repeat(1000)}`,
  ].join('\n');
  assert.equal((await post({
    content: triageContent,
    automation: {
      messageType: 'background-event',
      eventSource: 'quarter-hour-check',
      eventId: 'quarter-hour-check:test-event',
      eventCategory: 'backlog',
      eventPriority: 2,
    },
  })).status, 202);
  assert.equal((await post({
    content: '[后台事件] 自主事件分派 · 来源 legacy-quarter-hour · backlog',
  })).status, 202, 'legacy producers are classified server-side instead of impersonating User');
  assert.equal((await post({
    content: '这是 daily 内部触发指令\n分诊理由：自然问候',
    origin: 'main',
    automated: true,
    hidden: true,
    automation: {
      messageType: 'proactive-trigger',
      eventSource: 'daily-check-in',
      eventId: 'daily-check-in:test-event',
      eventCategory: 'daily',
    },
  })).status, 202);
  assert.equal((await post({ content: 'bad', origin: 'elsewhere' })).status, 400);

  const main = await (await fetch(`${base}?origin=main`)).json() as { messages: MessageRow[] };
  const side = await (await fetch(`${base}?origin=side`)).json() as { messages: MessageRow[]; readState: null };
  assert.deepEqual(main.messages.map((row) => row.content), ['User 手打']);
  assert.equal(side.messages.length, 2);
  assert.equal(side.messages[0].sender, 'system', 'triage source marker must not impersonate User');
  assert.equal(side.messages[0].origin, 'side');
  assert.equal(side.readState, null, 'side remains queryable for audit but has no UI unread state');
  assert.equal(queued.length, 4, 'background and hidden daily triggers still reach the runtime');

  const explicitMeta = JSON.parse(side.messages[0].meta);
  const legacyMeta = JSON.parse(side.messages[1].meta);
  assert.equal(explicitMeta.messageType, 'background-event');
  assert.equal(explicitMeta.eventSource, 'quarter-hour-check');
  assert.equal(explicitMeta.eventId, 'quarter-hour-check:test-event');
  assert.equal(legacyMeta.messageType, 'background-event');
  assert.equal(legacyMeta.eventSource, 'legacy-quarter-hour');
  assert.equal(side.messages[1].sender, 'system');

  const hidden = db.prepare(
    "SELECT * FROM messages WHERE json_extract(meta, '$.uiHidden') = 1"
  ).get() as MessageRow;
  assert.equal(hidden.origin, 'main');
  assert.equal(hidden.sender, 'system');
  const hiddenMeta = JSON.parse(hidden.meta);
  assert.equal(hiddenMeta.messageType, 'proactive-trigger');
  assert.equal(hiddenMeta.eventSource, 'daily-check-in');
  const framed = frameAutomatedTurn(side.messages[0].meta, triageContent);
  assert.match(framed, /AI_HUB_EVENT_META.*quarter-hour-check/);
  assert.match(framed, /不是 User 的手动发言/);

  const sideReplyId = Number(db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, origin, meta)
     VALUES ('codex', 'codex', 'assistant', 'text', ?, 'done', 'side', ?)`
  ).run('后台处理完成。' + '回复细节'.repeat(300), JSON.stringify({
    trigger: replyTriggerMeta(side.messages[0].id, side.messages[0].meta),
  })).lastInsertRowid);
  const sideReply = db.prepare('SELECT * FROM messages WHERE id = ?').get(sideReplyId) as MessageRow;
  const replyMeta = JSON.parse(sideReply.meta);
  assert.equal(replyMeta.trigger.messageType, 'background-event');
  assert.equal(replyMeta.trigger.eventSource, 'quarter-hour-check');
  assert.match(historicalMessageText(side.messages[0]), /quarter-hour-check/);
  assert.doesNotMatch(historicalMessageText(side.messages[0]), /绝不应进入历史原文/);
  assert.ok(historicalMessageText(sideReply).length < 240);
  const dailyReply = {
    sender: 'codex', role: 'assistant', content: '今天也来陪你说句话。', origin: 'main',
    meta: JSON.stringify({
      trigger: replyTriggerMeta(hidden.id, hidden.meta),
    }),
  } as Pick<MessageRow, 'sender' | 'role' | 'content' | 'origin' | 'meta'>;
  assert.equal(
    historicalMessageText(dailyReply), '今天也来陪你说句话。',
    'proactive assistant replies retain their real conversation content'
  );

  const summary = compactSummaryText('', [side.messages[0], sideReply], {
    summaryMaxTokens: 1000,
    historyTokenBudget: 4000,
  });
  assert.match(summary, /网关：\[后台事件\]/);
  assert.doesNotMatch(summary, /User：\[后台事件\]/);

  const backend = new DirectApiBackend({
    provider: 'openai-compat', baseUrl: 'http://127.0.0.1/unused', apiKey: 'test', model: 'test',
    maxHistoryMessages: 20, historyTokenBudget: 10_000, minRecentTurns: 2,
    summaryMaxTokens: 1000, historySummaryStrategy: 'off', maxTokens: 64,
    contextWindowTokens: 32_000, turnTimeoutMs: 1000, db, uploadsDir,
    contactId: 'codex', memberId: '', log: () => {},
  });
  const history = (backend as any).history('现在继续聊');
  const liveHistory = (backend as any).history(framed, side.messages[0].id);
  const liveTurn = liveHistory.messages.at(-1);
  assert.equal(liveTurn.role, 'user', 'provider trigger role remains user-compatible');
  assert.match(String(liveTurn.content), /AI_HUB_EVENT_META.*quarter-hour-check/);
  const serialized = history.messages.map((message: any) => String(message.content)).join('\n');
  assert.match(serialized, /\[后台事件\]/);
  assert.doesNotMatch(serialized, /绝不应进入历史原文/);

  console.log('side audit compatibility smoke: ok');
} finally {
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  sse.close();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.rmSync(uploadsDir, { recursive: true, force: true });
}
