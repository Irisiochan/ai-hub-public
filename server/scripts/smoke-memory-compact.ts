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

console.log('compact memory smoke: ok');
