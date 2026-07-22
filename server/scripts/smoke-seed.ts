import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HubConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seedIfEmpty } from '../src/seed.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-seed-smoke-'));
const config: HubConfig = {
  port: 3900,
  host: '127.0.0.1',
  dbPath: path.join(root, 'hub.db'),
  agentsDir: path.join(root, 'agents'),
  webDist: path.join(root, 'web'),
  uploadsDir: path.join(root, 'uploads'),
  claude: { cliPath: 'claude', turnTimeoutMs: 1000 },
  codex: { cliPath: 'codex', turnTimeoutMs: 1000 },
  grok: { cliPath: 'grok', turnTimeoutMs: 1000 },
  memory: {
    mcpUrl: null, repoPath: null, injectOnSpawn: true, searchPerTurn: true,
    capture: true, maxTurnChars: 1200, sessionMaxAgeHours: 12,
  },
  backup: { enabled: false, dir: path.join(root, 'backups'), intervalHours: 24, keep: 1 },
  purge: { enabled: false, messagesRetentionDays: 14, jobsRetentionDays: 30, intervalHours: 24, batchSize: 100 },
};

const db = openDb(config.dbPath);
try {
  seedIfEmpty(db, config);
  seedIfEmpty(db, config);
  const contacts = db.prepare('SELECT * FROM contacts ORDER BY sort_order').all() as Array<{ id: string; name: string; backend: string; config: string }>;
  assert.deepEqual(
    contacts.map(({ id, name, backend }) => ({ id, name, backend })),
    [
      { id: 'claude-code', name: 'Claude Code', backend: 'claude-cli' },
      { id: 'codex', name: 'Codex', backend: 'codex' },
      { id: 'grok-build', name: 'Grok Build', backend: 'grok-cli' },
    ]
  );
  const files = fs.readdirSync(config.agentsDir, { recursive: true })
    .map(String)
    .filter((name) => fs.statSync(path.join(config.agentsDir, name)).isFile());
  assert.deepEqual(files, [path.join('claude-code', 'CLAUDE.md')]);
  const publicSeed = [...contacts.map((contact) => contact.config), ...files.map((name) => fs.readFileSync(path.join(config.agentsDir, name), 'utf8'))].join('\n');
  assert.doesNotMatch(publicSeed, /Iris|鸢尾|橙|Cove|阿野|memory_all|obsidian_note/i);
  for (const id of ['claude-code', 'codex', 'grok-build']) {
    assert.equal(fs.existsSync(path.join(config.agentsDir, id, 'mcp.json')), false);
  }
  console.log('public seed smoke: ok');
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
