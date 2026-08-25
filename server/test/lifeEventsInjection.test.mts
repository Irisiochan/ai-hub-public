/**
 * P3 验收场景集成测试（任务方向 4）：
 * 联系人 A（claude）出现「暴雨倒灌 → 进水截图 → 断电 → 搬家」图文序列后，
 * 联系人 B（codex）的每轮自动上下文必须含最新事实、风险等级、时间、来源联系人；
 * A 自己不重复看到；lifeEvents=off 的联系人什么都看不到。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type ContactRow } from '../src/db.js';
import type { MemoryConfig } from '../src/config.js';
import { LifeEventService } from '../src/agents/lifeEvents.js';
import { MessageRepo } from '../src/agents/messageRepo.js';
import { PromptComposer, type PromptContext } from '../src/agents/promptComposer.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-inject-'));
const db = openDb(path.join(dir, 'hub.db'));

const addContact = (id: string, name: string, lifeEvents: string): ContactRow => {
  db.prepare(`INSERT INTO contacts(id,name,avatar,color,backend,kind,config)
    VALUES(?,?,'x','#000','claude-cli','dm',?)`).run(id, name, JSON.stringify({ lifeEvents }));
  return db.prepare('SELECT * FROM contacts WHERE id=?').get(id) as ContactRow;
};
const addUserMessage = (contactId: string, content: string, meta = '{}'): number => {
  const r = db.prepare(`INSERT INTO messages(contact_id,sender,role,kind,content,status,meta,origin)
    VALUES(?,'user','user','text',?,'done',?,'main')`).run(contactId, content, meta);
  return Number(r.lastInsertRowid);
};

const memory: MemoryConfig = {
  mcpUrl: null,
  repoPath: null,
  injectOnSpawn: false,
  searchPerTurn: false,
  capture: false,
  maxTurnChars: 1200,
  sessionMaxAgeHours: 24,
};
const ctxFor = (agent: ContactRow): PromptContext => ({
  agent,
  convo: agent,
  isRoom: false,
  memory,
  userName: 'User',
  nameOf: (sender) => sender,
  log: () => {},
});

try {
  const claude = addContact('claude', 'Claude', 'on');
  const codex = addContact('codex', 'Codex', 'on');
  const gem = addContact('gem', 'Gem', 'off');

  // fake 提取器按窗口内容驱动事件演进（模拟 DeepSeek 的 new/update 合约）
  const service = new LifeEventService(
    db,
    () => {},
    async (input) => {
      const hasExisting = input.activeEvents.length > 0;
      if (!hasExisting) {
        return {
          events: [{
            action: 'new' as const,
            severity: 'safety' as const,
            summary: '上海暴雨，家里一楼倒灌进水',
            note: '暴雨倒灌进水',
            confidence: 0.95,
          }],
        };
      }
      // 升级：窗口里出现断电/搬家（含图片 caption 的转写）
      assert.match(input.windowText, /图片内容：.*已倒灌进室内/, 'caption must be part of the extraction window');
      return {
        events: [{
          action: 'update' as const,
          id: input.activeEvents[0].id,
          severity: 'safety' as const,
          summary: '家里一楼进水并跳闸断电，正收拾准备临时搬离',
          note: '断电，准备搬家',
          confidence: 0.92,
        }],
      };
    },
    async () => {}
  );

  // A 会话：文字 + 截图（caption 已落 meta，模拟 S1 产物）+ 后续文字
  const m1 = addUserMessage('claude', '暴雨太大了，家里一楼倒灌进水了');
  await service.extractAfterTurn(claude, m1, '暴雨太大了，家里一楼倒灌进水了');
  const m2 = addUserMessage(
    'claude',
    '请看这张图片。',
    JSON.stringify({ captions: ['文字内容：已倒灌进室内／画面：客厅积水淹过脚踝'] })
  );
  const m3 = addUserMessage('claude', '刚跳闸断电了，我收拾东西准备搬走');
  await service.extractAfterTurn(claude, m3, '刚跳闸断电了，我收拾东西准备搬走');
  void m2;

  // B（codex）的每轮注入：最新事实 + 风险等级 + 时间 + 来源
  const composer = new PromptComposer(null, new MessageRepo(db), null, null, null, service);
  const codexTurn = await composer.composeTurn(ctxFor(codex), '用户现在什么状态？', '用户现在什么状态？', new Set());
  assert.match(codexTurn, /<CROSS_CONTACT_STATE trust="gateway">/);
  assert.match(codexTurn, /【安全·进行中】/, 'risk level must be visible');
  assert.match(codexTurn, /进水并跳闸断电，正收拾准备临时搬离/, 'latest fact, not the initial state');
  assert.doesNotMatch(codexTurn, /上海暴雨，家里一楼倒灌进水（/, 'stale initial summary must be replaced');
  assert.match(codexTurn, /\d{2}-\d{2} \d{2}:\d{2}/, 'timestamp must be visible');
  assert.match(codexTurn, /来自与Claude的对话/, 'source contact must be visible');
  assert.match(codexTurn, /不是台词/, 'anti-recitation rule must ship with the block');

  // A（claude）自己：来源剔除，不重复注入
  const chengTurn = await composer.composeTurn(ctxFor(claude), '在吗', '在吗', new Set());
  assert.doesNotMatch(chengTurn, /<CROSS_CONTACT_STATE/);

  // lifeEvents=off：完全不注入
  const gemTurn = await composer.composeTurn(ctxFor(gem), '在吗', '在吗', new Set());
  assert.doesNotMatch(gemTurn, /<CROSS_CONTACT_STATE/);

  // 群聊上下文不注入（isRoom gate）
  const roomCtx: PromptContext = { ...ctxFor(codex), isRoom: true };
  const roomTurn = await composer.composeTurn(roomCtx, '群里聊聊', '群里聊聊', new Set());
  assert.doesNotMatch(roomTurn, /<CROSS_CONTACT_STATE/);

  console.log('life events injection acceptance checks passed');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
