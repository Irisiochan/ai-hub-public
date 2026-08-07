import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const compose = fs.readFileSync(path.join(root, 'docker-compose.example.yml'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

assert.equal(
  fs.existsSync(path.join(root, 'memory-vault')),
  false,
  'ai-hub must not carry an embedded memory-vault source tree',
);
assert.match(
  compose,
  /github\.com\/Irisiochan\/memory-vault\.git#\$\{MEMORY_VAULT_VERSION:-v0\.6\.0\}/,
  'Compose must pin the released external Memory Vault version',
);
assert.doesNotMatch(
  compose,
  /context:\s*\.\/memory-vault/,
  'Compose must not build a repository-local Memory Vault copy',
);
assert.doesNotMatch(
  readme,
  /\]\(memory-vault\/README\.md\)|`memory-vault\/`\s*只存/,
  'README must not document an embedded Memory Vault source tree',
);

console.log('memory vault repository boundary smoke: ok');
