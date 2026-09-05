import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-config-test-'));
const configPath = path.join(tempDir, 'config.json');
const previousHubConfig = process.env.HUB_CONFIG;
const previousHubDataDir = process.env.HUB_DATA_DIR;

try {
  fs.writeFileSync(configPath, JSON.stringify({
    claude: { turnTimeoutMs: 300_000 },
  }));
  process.env.HUB_CONFIG = configPath;
  process.env.HUB_DATA_DIR = tempDir;

  const config = loadConfig();
  assert.deepEqual(
    {
      idleTimeoutMs: config.claude.turnIdleTimeoutMs,
      hardTimeoutMs: config.claude.turnHardTimeoutMs,
    },
    { idleTimeoutMs: 120_000, hardTimeoutMs: 900_000 },
  );
  assert.equal(config.opencode.turnIdleTimeoutMs, 300_000);
  assert.equal(config.opencode.turnHardTimeoutMs, 900_000);
} finally {
  if (previousHubConfig === undefined) delete process.env.HUB_CONFIG;
  else process.env.HUB_CONFIG = previousHubConfig;
  if (previousHubDataDir === undefined) delete process.env.HUB_DATA_DIR;
  else process.env.HUB_DATA_DIR = previousHubDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('config tests: ok');
