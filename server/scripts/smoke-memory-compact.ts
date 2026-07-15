import assert from 'node:assert/strict';
import { buildSessionPreamble } from '../src/memory/inject.js';
import type { VaultClient } from '../src/memory/vaultClient.js';


const requested: string[] = [];
const vault = {
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    assert.equal(name, 'read_file');
    const path = String(args.path);
    requested.push(path);
    if (path === 'memories/owner-core.md') return '---\ntype: memory\n---\n# Owner core';
    if (path === 'memories/owner-ai-interaction-styles.md') {
      return '---\ntype: memory\n---\n# Interaction styles';
    }
    throw new Error(`unexpected compact path: ${path}`);
  },
} as unknown as VaultClient;

const preamble = await buildSessionPreamble(
  vault,
  { id: 'compact-test', name: 'Example', backend: 'api' },
  'compact'
);

assert.deepEqual(requested, [
  'memories/owner-core.md',
  'memories/owner-ai-interaction-styles.md',
]);
assert.match(preamble, /Owner core/);
assert.match(preamble, /Interaction styles/);

console.log('compact memory smoke: ok');
