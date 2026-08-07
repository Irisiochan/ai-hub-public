import assert from 'node:assert/strict';
import { buildSessionPreamble } from '../src/memory/inject.js';
import type { VaultClient } from '../src/memory/vaultClient.js';


const requested: string[] = [];
const requestedArgs: Record<string, unknown>[] = [];
const vault = {
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    requested.push(name);
    requestedArgs.push(args);
    if (name === 'get_core_context') {
      return '---\ntype: memory\n---\n# Configured core\n\n# Configured interaction styles';
    }
    throw new Error(`unexpected compact tool: ${name}`);
  },
} as unknown as VaultClient;

const preamble = await buildSessionPreamble(
  vault,
  { id: 'compact-test', name: 'Example', backend: 'api' },
  'compact'
);

assert.deepEqual(requested, ['get_core_context']);
// vault 的默认 source 可能随迁移改变；网关必须显式钉住 compact facts，
// 否则 session 前缀会无声换形并失去预算边界。
assert.deepEqual(
  requestedArgs,
  [{ source: 'compact' }],
  'compact 必须显式传 source，不能依赖 vault 默认值'
);
assert.match(preamble, /Configured core/);
assert.match(preamble, /Configured interaction styles/);
assert.match(preamble, /当前会话身份边界/);
assert.equal(
  preamble.split('当前会话身份边界').length - 1,
  1,
  'compact identityGuard should appear once'
);
assert.match(preamble, /NSFW 书写工艺（网关 compact/);
assert.equal(
  preamble.split('NSFW 书写工艺（网关 compact').length - 1,
  1,
  'nsfwCraftCompact should appear once'
);

// full path: single identityGuard (no head+tail duplicate)
const fullRequested: string[] = [];
const fullVault = {
  async call(name: string): Promise<string> {
    fullRequested.push(name);
    if (name === 'get_context') return '# full body';
    throw new Error(`unexpected full tool: ${name}`);
  },
} as unknown as VaultClient;
const full = await buildSessionPreamble(
  fullVault,
  { id: 'full-test', name: 'Gem', backend: 'api' },
  'full'
);
assert.deepEqual(fullRequested, ['get_context']);
assert.equal(full.split('当前会话身份边界').length - 1, 1, 'full identityGuard must not be duplicated');
assert.equal(
  full.split('NSFW 书写工艺（网关 compact').length - 1,
  1,
  'full nsfwCraftCompact must not be duplicated'
);

console.log('compact memory smoke: ok');
