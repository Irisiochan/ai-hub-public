import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'docker-compose.example.yml'), 'utf8');
const expected = 'v0.6.0';

const envVersion = envExample.match(/^MEMORY_VAULT_VERSION=(\S+)$/m)?.[1];
const composeVersion = compose.match(/\$\{MEMORY_VAULT_VERSION:-([^}]+)\}/)?.[1];

assert.equal(envVersion, expected, `.env.example must pin Memory Vault ${expected}`);
assert.equal(
  composeVersion,
  expected,
  `docker-compose.example.yml default must match .env.example (${expected})`
);

console.log(`Memory Vault version pins agree: ${expected}`);
