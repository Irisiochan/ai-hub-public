import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
const excluded = new Set([
  'smoke-codex-quota.ts', // requires a real signed-in Codex installation
]);
const files = fs.readdirSync(scriptsDir)
  .filter((name) => /^smoke-.*\.ts$/.test(name) && !excluded.has(name))
  .sort();

for (const name of files) {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(process.execPath, [tsxCli, path.join(scriptsDir, name)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\nserver smoke suite: ok (${files.length} scripts)`);
