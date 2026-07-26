/** Compact identity-boundary regression with synthetic public fixtures. */
import assert from 'node:assert/strict';
import { WORKFLOW_PRELOADED, buildSessionPreamble } from '../src/memory/inject.js';
import type { VaultClient } from '../src/memory/vaultClient.js';

const FAKE_CORE = [
  '---',
  'type: memory',
  '---',
  '# Shared context',
  '',
  'Agent Alpha wrote: “I handled the release.”',
  'Agent Beta prefers concise replies.',
].join('\n');

const vault = {
  async call(name: string): Promise<string> {
    if (name === 'get_core_context' || name === 'get_context') return FAKE_CORE;
    throw new Error(`unexpected ${name}`);
  },
} as unknown as VaultClient;

const alpha = await buildSessionPreamble(
  vault,
  { id: 'alpha', name: 'Agent Alpha', backend: 'api' },
  'compact'
);

assert.match(alpha, /compact-v1/);
assert.match(alpha, /当前会话身份边界/);
assert.match(alpha, /你当前是联系人「Agent Alpha」/);
assert.match(alpha, /第三人称人物，不是你/);
assert.match(alpha, /严禁把其他 AI 的经历改写成自己的第一人称经历/);
assert.equal(alpha.split('当前会话身份边界').length - 1, 1);
const guardAt = alpha.indexOf('当前会话身份边界');
const bodyAt = alpha.indexOf('Agent Alpha wrote');
assert.ok(guardAt >= 0 && bodyAt > guardAt, 'identity boundary must precede memory content');

const beta = await buildSessionPreamble(
  vault,
  { id: 'beta', name: 'Agent Beta', backend: 'api' },
  'compact'
);
assert.match(beta, /你当前是联系人「Agent Beta」/);
assert.doesNotMatch(beta.split('# 记忆库上下文')[0] ?? '', /你当前是联系人「Agent Alpha」/);
assert.match(beta, /称呼归属/);
assert.match(beta, /亲密称呼|爱称|关系角色词/);
assert.match(beta, /称呼是有方向的/);
assert.match(beta, /你 → 用户不泛化/);
assert.match(beta, /用户 → 你可按当前会话理解/);
assert.doesNotMatch(
  beta.split('# 记忆库上下文')[0] ?? '',
  /你当前是联系人「Agent Alpha」/,
  'identity guards must not bleed across contacts'
);
assert.match(WORKFLOW_PRELOADED, /<WORKFLOW_PRELOADED\|/);
assert.match(WORKFLOW_PRELOADED, /global workflow files/);
assert.doesNotMatch(WORKFLOW_PRELOADED, /\d{4}-\d{2}-\d{2}/);

console.log('identity guard smoke: ok');
