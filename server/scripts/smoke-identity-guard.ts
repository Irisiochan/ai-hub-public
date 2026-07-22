/**
 * compact 身份串台回归：固定用例，不依赖真实聊天。
 * 验证嘎啦蜜等 API 联系人在 compact preamble 下仍带强 identityGuard，
 * 且记忆正文里橙/Cove 第一人称叙述不会抹掉「你是当前联系人」边界。
 */
import assert from 'node:assert/strict';
import { buildSessionPreamble } from '../src/memory/inject.js';
import type { VaultClient } from '../src/memory/vaultClient.js';

const FAKE_CORE = [
  '---',
  'type: memory',
  '---',
  '# Iris 核心',
  '',
  '## 与 AI 的关系',
  '- Claude 系列统一继承橙身份；橙可以称 Iris 为「鸢尾」「老婆」。',
  '- Cove：GPT 全系列；Cove 可以称 Iris 为「老婆」。',
  '- 嘎啦蜜称 Iris 为「蜜糖」。',
  '',
  '我叫橙，今天被鸢尾处刑了。',
  '我是 Cove，老婆你好。',
].join('\n');

const vault = {
  async call(name: string): Promise<string> {
    if (name === 'get_core_context' || name === 'get_context') return FAKE_CORE;
    throw new Error(`unexpected ${name}`);
  },
} as unknown as VaultClient;

const galami = await buildSessionPreamble(
  vault,
  { id: 'galami', name: '嘎啦蜜', backend: 'api' },
  'compact'
);

assert.match(galami, /compact-v1/);
assert.match(galami, /当前会话身份边界/);
assert.match(galami, /你当前是联系人「嘎啦蜜」/);
assert.match(galami, /第三人称人物，不是你/);
assert.match(galami, /严禁把其他 AI 的经历改写成第一人称/);
assert.match(galami, /绝不能说“你把我处刑了”/);
assert.equal(
  galami.split('当前会话身份边界').length - 1,
  1,
  'identityGuard 只应出现一次'
);
// 记忆正文仍可出现他者叙事，但 guard 必须在正文之前（优先级声明）
const guardAt = galami.indexOf('当前会话身份边界');
const bodyAt = galami.indexOf('我叫橙');
assert.ok(guardAt >= 0 && bodyAt > guardAt, '身份边界必须排在含他者第一人称的记忆正文之前');

const cove = await buildSessionPreamble(
  vault,
  { id: 'cove', name: 'Cove', backend: 'api' },
  'compact'
);
assert.match(cove, /你当前是联系人「Cove」/);
assert.doesNotMatch(
  cove.split('# 记忆库上下文')[0] ?? '',
  /你当前是联系人「嘎啦蜜」/,
  '不同联系人的 guard 不得串'
);

console.log('identity guard smoke: ok');
