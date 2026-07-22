import assert from 'node:assert/strict';
import { buildSessionPreamble } from '../src/memory/inject.js';
import type { VaultClient } from '../src/memory/vaultClient.js';


const requested: string[] = [];
const vault = {
  async call(name: string): Promise<string> {
    requested.push(name);
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
assert.match(preamble, /Configured core/);
assert.match(preamble, /Configured interaction styles/);
assert.match(preamble, /当前会话身份边界/);
assert.equal(
  preamble.split('当前会话身份边界').length - 1,
  1,
  'compact identityGuard should appear once'
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

console.log('compact memory smoke: ok');
