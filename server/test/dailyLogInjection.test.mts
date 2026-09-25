/**
 * D1 刀1 验收：同日 daily log 动态注入（网关 per-turn，DM only）。
 *
 * 结构参考 lifeEventsInjection.test.mts：直接搭库 + fake vault + PromptComposer，
 * 顶层断言，失败即非零退出。
 *
 * 覆盖：
 * 1. 夹具复现 2026-08-21：diary 有"新工作第一天…四点半到家"，DM turn 注入含该事实，
 *    并明确禁止再问已记录内容。
 * 2. composeStart 输出不含 diary 正文（静态 preamble 可缓存）。
 * 3. isRoom=true 不注入。
 * 4. 无文件或 Vault 故障不炸、静默省略，不生成"当天尚无记录"。
 * 6. 今天/昨天、<10:00、1200 字裁剪、45s hit/miss cache。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type ContactRow } from '../src/platform/db.js';
import type { MemoryConfig } from '../src/platform/config.js';
import { MessageRepo } from '../src/messages/messageRepo.js';
import { PromptComposer, type PromptContext } from '../src/prompt/promptComposer.js';
import {
  addDiaryDays,
  clearSameDayDiaryCache,
  diaryPathFor,
  formatDiaryBlock,
  getSameDayDiaryBlock,
  shanghaiDiaryDay,
  stripDiaryFrontmatter,
  trimDiaryBudget,
  SAME_DAY_DIARY_MAX_CHARS,
  SAME_DAY_DIARY_TTL_MS,
} from '../src/memory/sameDayDiary.js';

// 2026-08-21 15:00 上海 = 2026-08-21T07:00:00Z（下午档，只带今天）。
const AFTERNOON = Date.parse('2026-08-21T07:00:00Z');
// 2026-08-21 08:30 上海 = 2026-08-21T00:30:00Z（凌晨档，今天+昨天）。
const EARLY_MORNING = Date.parse('2026-08-21T00:30:00Z');

const DIARY_0821 = [
  '---',
  'type: diary',
  'date: 2026-08-21',
  '---',
  '',
  '# 2026-08-21',
  '',
  '- 09:00 新工作第一天，到公司报到。',
  '- 16:30 四点半到家，路上买了菜。',
].join('\n');

const DIARY_0820 = [
  '# 2026-08-20',
  '',
  '- 昨天的流水：加班到很晚才睡。',
].join('\n');

class FakeVault {
  calls: string[] = [];
  constructor(private files: Record<string, string>, private faulty = false) {}
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    if (name === 'get_core_context' || name === 'get_context') {
      return '# compact facts\n- identity.name: User';
    }
    if (name === 'search_vault') return '没有找到相关内容。';
    assert.equal(name, 'read_file');
    const target = String(args.path ?? '');
    this.calls.push(target);
    if (this.faulty) throw new Error('vault unavailable');
    const hit = this.files[target];
    if (hit === undefined) throw new Error(`read_file: ${target} not found`);
    return hit;
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-log-inject-'));
const db = openDb(path.join(dir, 'hub.db'));
db.prepare(`INSERT INTO contacts(id,name,avatar,color,backend,kind,config)
  VALUES('codex','Codex','x','#000','claude-cli','dm','{}')`).run();
const agent = db.prepare('SELECT * FROM contacts WHERE id=?').get('codex') as ContactRow;

const memory: MemoryConfig = {
  mcpUrl: null,
  repoPath: null,
  injectOnSpawn: false,
  searchPerTurn: false,
  capture: false,
  maxTurnChars: 1200,
  sessionMaxAgeHours: 24,
};
const ctxFor = (isRoom: boolean): PromptContext => ({
  agent,
  convo: agent,
  isRoom,
  memory,
  userName: 'User',
  nameOf: (sender) => sender,
  log: () => {},
});

const realNow = Date.now;

try {
  // --- 单元：日期/路径/frontmatter/预算 ---
  assert.deepEqual(shanghaiDiaryDay(AFTERNOON), { date: '2026-08-21', hour: 15 });
  assert.deepEqual(shanghaiDiaryDay(EARLY_MORNING), { date: '2026-08-21', hour: 8 });
  assert.equal(addDiaryDays('2026-08-21', -1), '2026-08-20');
  assert.equal(diaryPathFor('2026-08-21'), 'diary/2026-08-21.md');
  assert.equal(stripDiaryFrontmatter(DIARY_0821).includes('type: diary'), false);
  assert.match(stripDiaryFrontmatter(DIARY_0821), /新工作第一天/);
  // 正文里的 --- 不得被误剥。
  assert.match(stripDiaryFrontmatter('正文第一行\n---\n正文第二行'), /正文第二行/);

  const earliest = `最早的句子${'x'.repeat(1300)}`;
  const latest = '最新的句子：四点半到家';
  const trimmed = trimDiaryBudget(`${earliest}\n${latest}`, '昨天的流水', SAME_DAY_DIARY_MAX_CHARS);
  assert.equal(trimmed.yesterday, '', '今天超预算时昨天不占额度');
  assert.ok(trimmed.today.length <= SAME_DAY_DIARY_MAX_CHARS);
  assert.match(trimmed.today, /最新的句子/, '砍最早留最新');
  assert.doesNotMatch(trimmed.today, /最早的句子/);
  const shared = trimDiaryBudget('今天三字', '昨天内容', 10);
  assert.deepEqual(shared, { today: '今天三字', yesterday: '昨天内容'.slice(-6) });

  const wrapped = formatDiaryBlock('2026-08-21', '今天正文', null, '');
  assert.match(wrapped, /<SAME_DAY_DIARY trust="gateway">/);
  assert.match(wrapped, /禁止再问已答内容/);

  // --- 集成 1：2026-08-21 下午档，DM turn 含当天事实 + 禁止再问 ---
  clearSameDayDiaryCache();
  Date.now = () => AFTERNOON;
  const vault = new FakeVault({ 'diary/2026-08-21.md': DIARY_0821, 'diary/2026-08-20.md': DIARY_0820 });
  const composer = new PromptComposer(vault as any, new MessageRepo(db), null, null, null, null);
  const turn = await composer.composeTurn(ctxFor(false), '今天过得怎么样？', '今天过得怎么样？', new Set());
  assert.match(turn, /新工作第一天/, 'DM turn 必须含当天 diary 事实');
  assert.match(turn, /四点半到家/);
  assert.match(turn, /禁止再问已答内容/, '必须明确禁止再问已记录内容');
  assert.match(turn, /<SAME_DAY_DIARY trust="gateway">/);
  assert.doesNotMatch(turn, /type: diary/, 'frontmatter 不得漏进注入块');
  assert.doesNotMatch(turn, /昨天的流水/, '下午档不带昨天');
  assert.deepEqual(vault.calls, ['diary/2026-08-21.md'], '下午档只读今天');

  // --- 集成 2：composeStart 不含 diary 正文 ---
  const start = await composer.composeStart(ctxFor(false), 'resume-token');
  assert.doesNotMatch(start.preamble, /新工作第一天/);
  assert.doesNotMatch(start.preamble, /四点半到家/);
  assert.doesNotMatch(start.preamble, /SAME_DAY_DIARY/);

  // --- 集成 3：群聊不注入 ---
  clearSameDayDiaryCache();
  const roomTurn = await composer.composeTurn(ctxFor(true), '群里聊聊', '群里聊聊', new Set());
  assert.doesNotMatch(roomTurn, /SAME_DAY_DIARY/);
  assert.doesNotMatch(roomTurn, /新工作第一天/);

  // --- 集成 4：凌晨档（<10:00）今天+昨天共享预算 ---
  clearSameDayDiaryCache();
  Date.now = () => EARLY_MORNING;
  const earlyVault = new FakeVault({ 'diary/2026-08-21.md': DIARY_0821, 'diary/2026-08-20.md': DIARY_0820 });
  const earlyBlock = await getSameDayDiaryBlock(earlyVault as any, { now: EARLY_MORNING });
  assert.match(earlyBlock, /新工作第一天/);
  assert.match(earlyBlock, /昨天的流水/, '凌晨档带上昨天');
  assert.deepEqual(earlyVault.calls, ['diary/2026-08-21.md', 'diary/2026-08-20.md']);

  // --- 集成 5：今天缺失时回落到昨天（下午档也带昨天） ---
  clearSameDayDiaryCache();
  const missingVault = new FakeVault({ 'diary/2026-08-20.md': DIARY_0820 });
  const fallback = await getSameDayDiaryBlock(missingVault as any, { now: AFTERNOON });
  assert.match(fallback, /昨天的流水/, '今天缺失时带昨天');
  assert.deepEqual(missingVault.calls, ['diary/2026-08-21.md', 'diary/2026-08-20.md']);

  // --- 集成 6：两天都缺失 → 空串，不生成"当天尚无记录" ---
  clearSameDayDiaryCache();
  const emptyVault = new FakeVault({});
  assert.equal(await getSameDayDiaryBlock(emptyVault as any, { now: AFTERNOON }), '');
  const emptyComposer = new PromptComposer(emptyVault as any, new MessageRepo(db), null, null, null, null);
  const emptyTurn = await emptyComposer.composeTurn(ctxFor(false), '在吗', '在吗', new Set());
  assert.doesNotMatch(emptyTurn, /SAME_DAY_DIARY/);
  assert.doesNotMatch(emptyTurn, /尚无记录/);

  // --- 集成 7：Vault 故障静默省略，不炸 ---
  clearSameDayDiaryCache();
  const faultyVault = new FakeVault({}, true);
  assert.equal(await getSameDayDiaryBlock(faultyVault as any, { now: AFTERNOON }), '');
  const faultyComposer = new PromptComposer(faultyVault as any, new MessageRepo(db), null, null, null, null);
  const faultyTurn = await faultyComposer.composeTurn(ctxFor(false), '在吗', '在吗', new Set());
  assert.doesNotMatch(faultyTurn, /SAME_DAY_DIARY/);

  // --- 集成 8：vault=null 不注入 ---
  clearSameDayDiaryCache();
  const naked = new PromptComposer(null, new MessageRepo(db), null, null, null, null);
  const nakedTurn = await naked.composeTurn(ctxFor(false), '在吗', '在吗', new Set());
  assert.doesNotMatch(nakedTurn, /SAME_DAY_DIARY/);
  assert.equal(await getSameDayDiaryBlock(null, { now: AFTERNOON }), '');

  // --- 集成 9：45s hit 缓存 ---
  clearSameDayDiaryCache();
  Date.now = () => AFTERNOON;
  const cachedVault = new FakeVault({ 'diary/2026-08-21.md': DIARY_0821 });
  const first = await getSameDayDiaryBlock(cachedVault as any, { now: AFTERNOON });
  assert.match(first, /新工作第一天/);
  assert.equal(cachedVault.calls.length, 1);
  const second = await getSameDayDiaryBlock(cachedVault as any, { now: AFTERNOON + 10_000 });
  assert.equal(second, first);
  assert.equal(cachedVault.calls.length, 1, '45s 内 hit 不再读 vault');
  const third = await getSameDayDiaryBlock(cachedVault as any, { now: AFTERNOON + SAME_DAY_DIARY_TTL_MS + 1000 });
  assert.equal(third, first);
  assert.equal(cachedVault.calls.length, 2, 'TTL 过期后重新读取');

  // --- 集成 10：45s miss 缓存（缺失也缓存，不雪崩） ---
  clearSameDayDiaryCache();
  const missVault = new FakeVault({});
  assert.equal(await getSameDayDiaryBlock(missVault as any, { now: AFTERNOON }), '');
  assert.equal(await getSameDayDiaryBlock(missVault as any, { now: AFTERNOON + 10_000 }), '');
  assert.equal(missVault.calls.length, 2, 'miss 只缓存一次读取组合（今天+昨天各一次）');

  console.log('daily log injection acceptance checks passed');
} finally {
  Date.now = realNow;
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
