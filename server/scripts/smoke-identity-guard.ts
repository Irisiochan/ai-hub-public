/**
 * compact 身份串台回归：固定用例，不依赖真实聊天。
 * 验证示例助手等 API 联系人在 compact preamble 下仍带强 identityGuard，
 * 且记忆正文里Claude/Codex 第一人称叙述不会抹掉「你是当前联系人」边界。
 */
import assert from 'node:assert/strict';
import { PromptComposer } from '../src/agents/promptComposer.js';
import { WORKFLOW_PRELOADED, buildSessionPreamble } from '../src/memory/inject.js';
import type { VaultClient } from '../src/memory/vaultClient.js';

const FAKE_CORE = [
  '---',
  'type: memory',
  '---',
  '# User 核心',
  '',
  '## 与 AI 的关系',
  '- Claude 系列统一继承Claude身份；Claude可以称 User 为「用户」「老婆」。',
  '- Codex：GPT 全系列；Codex 可以称 User 为「老婆」。',
  '- 示例助手称 User 为「蜜糖」。',
  '',
  '我叫Claude，今天被用户处刑了。',
  '我是 Codex，老婆你好。',
].join('\n');

const vault = {
  async call(name: string): Promise<string> {
    if (name === 'get_core_context' || name === 'get_context') return FAKE_CORE;
    throw new Error(`unexpected ${name}`);
  },
} as unknown as VaultClient;

const galami = await buildSessionPreamble(
  vault,
  { id: 'galami', name: '示例助手', backend: 'api' },
  'compact',
  { nsfwCraft: 'always' }
);

assert.match(galami, /compact-v2/);
assert.match(galami, /当前会话身份边界/);
assert.match(galami, /你当前是联系人「示例助手」/);
assert.match(galami, /第三人称资料/);
assert.match(galami, /禁止改写成“我\/我们”/);
assert.equal(
  galami.split('当前会话身份边界').length - 1,
  1,
  'identityGuard 只应出现一次'
);
// 记忆正文仍可出现他者叙事，但 guard 必须在正文之前（优先级声明）。
// 注意：guard 自身也会出现「我叫Claude/我是 Codex」字样作反例，不能用它当正文锚点。
const guardAt = galami.indexOf('当前会话身份边界');
const bodyAt = galami.indexOf('今天被用户处刑了');
assert.ok(guardAt >= 0 && bodyAt > guardAt, '身份边界必须排在含他者第一人称的记忆正文之前');

// 关系角色/称呼归属：记忆里只写了「Claude称 User 为老婆」，没写「User 称Claude为老公」，
// 于是"老公"这类高频称呼没有归属定义，一到顺话语境就被甩给对方（2026-07 实际踩坑）。
// guard 必须给出对任意称呼、任意联系人都成立的方向性规则。
assert.match(galami, /称呼归属有方向/);
assert.match(galami, /亲密称呼|爱称|关系角色词/);
assert.match(galami, /明确写明「示例助手」可用的称呼/);
assert.doesNotMatch(
  galami.split('# 记忆库上下文')[0] ?? '',
  /老公|蜜糖/,
  'guard 只能写通用称呼规则，不得点名具体称呼做一次性补丁'
);

// 两个方向必须分开写死：AI → User 不泛化（专属称呼仍是专属），User → AI 泛化。
// 2026-07-26 踩坑：Codex 读到「User 称Claude：老公」后判定该词不属于自己，拒领 User
// 对它本人说的话并做身份声明——身份隔离过度触发到了关系角色称呼上。
assert.match(galami, /不泛化/);
assert.match(galami, /泛化/);
assert.match(galami, /就是在叫当前对话对象/);
assert.match(galami, /拒领|纠正|声明别的身份/);
assert.match(galami, /接住称呼不改变你的身份/);
const guardBlock = galami.split('# NSFW 书写工艺')[0] ?? '';
assert.ok(
  guardBlock.indexOf('你 → User 不泛化') < guardBlock.indexOf('User → 你泛化'),
  '两个方向的规则都要在，且先立"你→User 不泛化"再放宽反方向'
);

// NSFW 工艺 compact：不依赖 search_vault，full/compact 均常驻；静态、与联系人无关。
// 与 vault nsfw-writing-rules 2026-08-09 工艺重写同向：动作单元密度、闭环、阶段、禁注水。
assert.match(galami, /NSFW 书写工艺（网关 compact/);
assert.match(galami, /感官密度/);
assert.match(galami, /关键动作单元/);
assert.match(galami, /动作闭环/);
assert.match(galami, /双向描写/);
assert.match(galami, /绝不隐晦/);
assert.match(galami, /禁同义复述|循环注水/);
assert.equal(
  galami.split('NSFW 书写工艺（网关 compact').length - 1,
  1,
  'nsfwCraftCompact 只应出现一次'
);
const nsfwAt = galami.indexOf('NSFW 书写工艺（网关 compact');
assert.ok(nsfwAt > guardAt && nsfwAt < bodyAt, 'NSFW compact 应在 identityGuard 之后、记忆正文之前');

const codex = await buildSessionPreamble(
  vault,
  { id: 'codex', name: 'Codex', backend: 'api' },
  'compact',
  { nsfwCraft: 'always' }
);
assert.match(codex, /你当前是联系人「Codex」/);
assert.match(codex, /明确写明「Codex」可用的称呼/);
assert.doesNotMatch(
  codex.split('# 记忆库上下文')[0] ?? '',
  /你当前是联系人「示例助手」/,
  '不同联系人的 guard 不得串'
);

// --- WORKFLOW_PRELOADED：与 vault 解耦，composeStart 无条件注入 ---
// 触发条件必须可自证（标记在不在），不能是"这是不是新会话"——grok-cli 每轮新进程，
// 那个状态每轮为真，于是会话中途去 read_file 全局工作流，流程性自语漏给 User。
assert.match(WORKFLOW_PRELOADED, /<WORKFLOW_PRELOADED\|/);
assert.match(WORKFLOW_PRELOADED, /global-agent-workflow\.md/);
assert.match(WORKFLOW_PRELOADED, /不要用“这是不是新会话”判断/);
assert.doesNotMatch(
  WORKFLOW_PRELOADED,
  /新会话开始|新会话第一轮|新会话先/,
  '预载标记不得再用模型无法自证的"新会话"当触发条件'
);
// 静态块：prompt-cache 前缀稳定性依赖它不带时间戳/联系人名
assert.doesNotMatch(WORKFLOW_PRELOADED, /\d{4}-\d{2}-\d{2}/);

const row = (id: string, name: string, backend: string) =>
  ({ id, name, avatar: '', color: '', backend, kind: 'dm', config: '{}', sort_order: 0, enabled: 1, created_at: '' }) as any;
const agent = row('aye', '阿野', 'grok-cli');
// vault=null → 记忆前缀为空，标记仍必须在（记忆库离线也要压住重读冲动）
const composer = new PromptComposer(null, null as any);
const started = await composer.composeStart(
  {
    agent,
    convo: agent,
    isRoom: false,
    memory: { injectOnSpawn: true } as any,
    userName: 'User',
    nameOf: (s: string) => s,
    log: () => {},
  },
  'resume-token' // 非空：跳过存档回放，只看网关自己的层
);
assert.match(started.preamble, /<WORKFLOW_PRELOADED\|/, 'composeStart 必须注入工作流预载标记');
assert.equal(
  started.preamble.split('<WORKFLOW_PRELOADED|').length - 1,
  1,
  '工作流预载标记只应出现一次'
);
assert.ok(
  started.preamble.startsWith('<WORKFLOW_PRELOADED|'),
  '标记应排在前缀最前，且为静态文本以保住 prompt-cache 前缀'
);

console.log('identity guard smoke: ok');
