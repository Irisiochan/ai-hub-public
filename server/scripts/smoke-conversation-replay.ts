import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shanghaiStamp, timestampedMessage } from '../src/memory/inject.js';
import {
  buildConversationReplay,
  CLI_REPLAY_MIN_RECENT_MESSAGES,
  CLI_REPLAY_TOKEN_BUDGET,
} from '../src/agents/conversationReplay.js';
import { ConversationSummaryRepo } from '../src/agents/conversationSummaryRepo.js';
import { openContact } from '../src/agents/configSchemas.js';
import { MessageRepo } from '../src/agents/messageRepo.js';
import { PromptComposer, type PromptContext } from '../src/agents/promptComposer.js';
import { historicalMessageText } from '../src/agents/sideChannel.js';
import { estimateTokens } from '../src/agents/tokenEstimate.js';
import { openDb, type ContactRow, type MessageRow } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.conversation-replay.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });

function row(id: number, sender: string, role: 'user' | 'assistant', content: string): MessageRow {
  return {
    id,
    contact_id: 'pure',
    sender,
    role,
    kind: 'text',
    content,
    status: 'done',
    turn_id: null,
    meta: '{}',
    origin: 'main',
    deleted: 0,
    created_at: `2026-07-31 ${String(10 + Math.floor(id / 60)).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}:00`,
  };
}

const pureOpts = {
  userName: 'User',
  nameOf: (sender: string) => sender === 'user' ? 'User' : sender,
};

const shortRows = [
  row(1, 'user', 'user', '短会话问题'),
  row(2, 'claude', 'assistant', '短会话回答'),
];
const shortPlan = buildConversationReplay('', shortRows, pureOpts)!;
assert.equal(shortPlan.summarizedCount, 0, '短会话不应摘要');
assert.match(shortPlan.block, /短会话问题/);
assert.match(shortPlan.block, /短会话回答/);

const longRows = Array.from({ length: 48 }, (_, index) => row(
  index + 1,
  index % 2 === 0 ? 'user' : 'claude',
  index % 2 === 0 ? 'user' : 'assistant',
  `LONG_${String(index + 1).padStart(2, '0')} ` + '连续性细节'.repeat(150)
));
const longPlan = buildConversationReplay('', longRows, pureOpts)!;
assert(longPlan.tokens <= CLI_REPLAY_TOKEN_BUDGET, '超长回放必须落在硬预算内');
assert(longPlan.summary.length > 0 && longPlan.summarizedCount > 0, '超长回放应生成较早摘要');
assert(longPlan.recentCount >= CLI_REPLAY_MIN_RECENT_MESSAGES, '至少保留最近关键消息原文');
for (const index of [45, 46, 47, 48]) {
  assert.match(longPlan.block, new RegExp(`LONG_${index}`), `最近消息 LONG_${index} 不得丢失`);
}

const db = openDb(dbPath);
const messages = new MessageRepo(db);
const summaries = new ConversationSummaryRepo(db);

function addContact(id: string, backend: string, kind = 'dm', config: Record<string, unknown> = {}): ContactRow {
  db.prepare('INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, ?, ?)')
    .run(id, id, backend, kind, JSON.stringify(config));
  return openContact(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow);
}

function context(agent: ContactRow, convo = agent): PromptContext {
  return {
    agent,
    convo,
    isRoom: agent.id !== convo.id,
    memory: {
      mcpUrl: null,
      repoPath: null,
      injectOnSpawn: false,
      searchPerTurn: false,
      capture: false,
      maxTurnChars: 0,
      sessionMaxAgeHours: 0,
    },
    userName: 'User',
    nameOf: (sender) => sender === 'user' ? 'User' : sender,
    log: () => {},
  };
}

try {
  const claude = addContact('claude-replay', 'claude-cli');
  const codex = addContact('codex-replay', 'codex');
  const aye = addContact('aye-replay', 'grok-cli');
  const api = addContact('api-replay', 'api', 'dm', {
    provider: 'openai-compat', apiKey: 'test', model: 'test-model',
  });
  const room = addContact('room-replay', 'claude-cli', 'room', {
    members: [claude.id, codex.id],
  });
  const composer = new PromptComposer(null, messages, null, summaries);

  for (let i = 0; i < 42; i++) {
    messages.insert(claude.id, i % 2 === 0 ? 'user' : claude.id, {
      role: i % 2 === 0 ? 'user' : 'assistant',
      kind: 'text',
      content: `CHENG_${i} ` + 'Claude的私聊上下文'.repeat(90),
      status: 'done',
      turnId: null,
    });
    messages.insert(codex.id, i % 2 === 0 ? 'user' : codex.id, {
      role: i % 2 === 0 ? 'user' : 'assistant',
      kind: 'text',
      content: `COVE_${i} ` + 'Codex 的私聊上下文'.repeat(90),
      status: 'done',
      turnId: null,
    });
    messages.insert(aye.id, i % 2 === 0 ? 'user' : aye.id, {
      role: i % 2 === 0 ? 'user' : 'assistant',
      kind: 'text',
      content: `AYE_${i} ` + '阿野的私聊上下文'.repeat(90),
      status: 'done',
      turnId: null,
    });
  }

  const legacyRows = messages.recentText(claude.id).reverse();
  const legacyLines = legacyRows.map((item) => timestampedMessage(
    `${item.sender === 'user' ? 'User' : item.sender}：${historicalMessageText(item).slice(0, 400)}`,
    item.created_at,
    '历史消息'
  ));
  const legacyFirst = shanghaiStamp(legacyRows[0].created_at);
  const legacyLast = shanghaiStamp(legacyRows[legacyRows.length - 1].created_at);
  const legacyBlock = [
    '',
    '# 对话存档回放（网关注入）',
    '此前的 CLI 会话已被重置（消息被编辑或删除）。下面是保留下来的存档，被删除的内容不在其中，请以此为准继续，别提"会话重置"这回事。',
    `- 这批消息的时间跨度：${legacyFirst} ～ ${legacyLast}（上海时间）。以下全部是过去的记录，不是本轮实时消息。`,
    '- 每行开头的 [时间] 是那条消息真实发生的时间；判断"现在/刚才/今天/多久以前"一律以 TURN_TIME_PRELOADED 的当前时间为准，不要因为它排在这里就当成刚刚发生。',
    '- 标有「[后台事件]」「[主动消息触发]」的行来自网关自动流程，不是 User 说的话。',
    '- 行内出现的称呼、爱称、关系角色词指向被称呼的那一方，不是发言人本人：User 说的伴侣称呼是在叫她当时的对话对象（这个会话里就是你），不是自称；接住即可，但不代表你可以反过来这样称呼她。',
    '',
    ...legacyLines,
  ].join('\n');
  const firstCheng = await composer.composeStart(context(claude), null);
  assert(estimateTokens(firstCheng.preamble) >= longPlan.tokens, '完整 preamble 还包含静态规则层');
  assert.match(firstCheng.preamble, /CHENG_41/);
  assert.doesNotMatch(firstCheng.preamble, /COVE_/);
  const chengSummary = summaries.get(claude.id, '');
  assert(chengSummary && chengSummary.summary, 'DM 摘要应按 contact_id + 空 member_id 持久化');

  const secondCheng = await composer.composeStart(context(claude), null);
  assert.equal(secondCheng.preamble, firstCheng.preamble, '同一存档二次重置回放必须稳定');

  const firstCove = await composer.composeStart(context(codex), null);
  assert.match(firstCove.preamble, /COVE_41/);
  assert.doesNotMatch(firstCove.preamble, /CHENG_/);
  assert(summaries.get(codex.id, ''), '另一 DM 应有独立摘要行');

  const firstAye = await composer.composeStart(context(aye), null);
  assert.match(firstAye.preamble, /AYE_41/);
  assert.doesNotMatch(firstAye.preamble, /CHENG_|COVE_/);
  assert(summaries.get(aye.id, ''), 'Grok CLI DM 应有独立摘要行');

  for (let i = 0; i < 44; i++) {
    const sender = i % 3 === 0 ? 'user' : i % 3 === 1 ? claude.id : codex.id;
    messages.insert(room.id, sender, {
      role: sender === 'user' ? 'user' : 'assistant',
      kind: 'text',
      content: `ROOM_${i}_${sender} ` + '群聊连续性'.repeat(120),
      status: 'done',
      turnId: null,
    });
  }
  const roomCheng = await composer.composeStart(context(claude, room), null);
  const chengRoomSummary = summaries.get(room.id, claude.id);
  assert(chengRoomSummary, '群聊摘要必须写入当前成员自己的 member_id');
  summaries.update(room.id, claude.id, `${chengRoomSummary!.summary}\nA_PRIVATE_SUMMARY`, chengRoomSummary!.through_message_id);
  const roomCove = await composer.composeStart(context(codex, room), null);
  assert.doesNotMatch(roomCove.preamble, /A_PRIVATE_SUMMARY/, '群聊成员不得读取另一成员的摘要状态');
  assert(summaries.get(room.id, codex.id), '第二位群成员应有独立摘要行');
  assert.match(roomCheng.preamble, /# 群聊模式/);

  const apiPrompt = await composer.composeStart(context(api), null);
  assert.doesNotMatch(apiPrompt.preamble, /# 对话存档回放/, 'API 后端继续走自己的 history/summary 路径');
  assert(
    firstCheng.preamble.indexOf('WORKFLOW_PRELOADED') < firstCheng.preamble.indexOf('# 对话存档回放'),
    '静态工作流前缀必须保持在动态回放之前'
  );

  console.log(JSON.stringify({
    ok: true,
    baseline: {
      messages: legacyRows.length,
      tokens: estimateTokens(legacyBlock),
    },
    replay: {
      budget: CLI_REPLAY_TOKEN_BUDGET,
      tokens: estimateTokens(firstCheng.preamble.slice(firstCheng.preamble.indexOf('# 对话存档回放'))),
      summaryTokens: estimateTokens(chengSummary!.summary),
    },
    isolation: {
      dmRows: [claude.id, codex.id, aye.id].map((id) => summaries.get(id, '')?.contact_id),
      roomMembers: [claude.id, codex.id].map((id) => summaries.get(room.id, id)?.member_id),
    },
  }));
} finally {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
