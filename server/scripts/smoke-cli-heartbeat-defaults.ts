import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BackendFactory } from '../src/agents/backendFactory.js';
import { contactConfig, openContact } from '../src/agents/configSchemas.js';
import { MessageRepo } from '../src/agents/messageRepo.js';
import { PromptComposer } from '../src/agents/promptComposer.js';
import type { HubConfig } from '../src/config.js';
import { openDb, type ContactRow } from '../src/db.js';
import { loadMigrationFiles } from '../src/migrations.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-cli-heartbeat-'));
const agentsDir = path.join(root, 'agents');
const dbPath = path.join(root, 'data', 'hub.db');
fs.mkdirSync(agentsDir, { recursive: true });
const db = openDb(dbPath);
const previousHubToken = process.env.HUB_TOKEN;
const previousHome = process.env.HOME;
process.env.HUB_TOKEN = 'smoke-only-hub-token';
process.env.HOME = path.join(root, 'grok-home');
fs.mkdirSync(path.join(process.env.HOME, '.grok'), { recursive: true });

function verifyExistingContactsMigration(): void {
  const legacyPath = path.join(root, 'legacy-contacts.db');
  const legacyDb = new Database(legacyPath);
  try {
    const migrations = loadMigrationFiles();
    const cutoff = migrations.findIndex((migration) => migration.name.startsWith('0030_'));
    if (cutoff < 0) throw new Error('missing 0030_cli_heartbeat_defaults');
    for (const migration of migrations.slice(0, cutoff)) legacyDb.exec(migration.sql);
    legacyDb.pragma(`user_version = ${cutoff}`);
    const insertLegacy = legacyDb.prepare(
      'INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, ?, ?)'
    );
    insertLegacy.run('claude-existing', 'Claude', 'claude-cli', 'dm', '{}');
    insertLegacy.run('grok-existing', 'Grok', 'grok-cli', 'dm', '{"heartbeat":{"enabled":false}}');
    insertLegacy.run('api-existing', 'API', 'api', 'dm', '{"heartbeat":{"enabled":false}}');
  } finally {
    legacyDb.close();
  }

  const upgraded = openDb(legacyPath);
  try {
    const stored = (id: string) => JSON.parse((upgraded.prepare(
      'SELECT config FROM contacts WHERE id = ?'
    ).get(id) as { config: string }).config);
    assert.equal(stored('claude-existing').heartbeat.enabled, true, 'migration enables existing CLI without a heartbeat field');
    assert.equal(stored('grok-existing').heartbeat.enabled, true, 'migration enables existing CLI persisted by the old false default');
    assert.equal(stored('api-existing').heartbeat.enabled, true, 'migration enables existing API contacts');
  } finally {
    upgraded.close();
  }
}

const config = {
  host: '127.0.0.1',
  port: 3900,
  dbPath,
  agentsDir,
  claude: { cliPath: 'claude', turnTimeoutMs: 1000 },
  codex: { cliPath: 'codex', turnTimeoutMs: 1000, nativeCompact: { enabled: false } },
  grok: { cliPath: 'grok', turnTimeoutMs: 1000 },
  opencode: { cliPath: 'opencode', turnTimeoutMs: 1000 },
  memory: { mcpUrl: null },
} as unknown as HubConfig;

function insert(id: string, backend: ContactRow['backend'], stored: Record<string, unknown> = {}): ContactRow {
  fs.mkdirSync(path.join(agentsDir, id), { recursive: true });
  db.prepare(
    'INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, ?, ?)'
  ).run(id, id, backend, 'dm', JSON.stringify({ cwd: id, ...stored }));
  return openContact(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow);
}

const contacts = {
  claude: insert('claude-default', 'claude-cli'),
  codex: insert('codex-default', 'codex'),
  grok: insert('grok-default', 'grok-cli'),
  grokBlocked: insert('grok-blocked', 'grok-cli'),
  opencode: insert('opencode-default', 'opencode-cli'),
  api: insert('api-default', 'api', { provider: 'openai-compat', apiKey: 'smoke', model: 'smoke' }),
  off: insert('codex-off', 'codex', { heartbeat: { enabled: false } }),
};
fs.writeFileSync(
  path.join(agentsDir, contacts.opencode.id, 'opencode.json'),
  JSON.stringify({ $schema: 'https://opencode.ai/config.json', autoupdate: false }),
  'utf-8',
);

const factory = new BackendFactory({
  db,
  config,
  vault: null,
  jobStore: null,
  broker: {} as any,
  heartbeat: {} as any,
  prompts: new PromptComposer(null, new MessageRepo(db), agentsDir),
});

const buildLogs: string[] = [];

async function build(contact: ContactRow): Promise<any> {
  return factory.build({
    agent: contact,
    convo: contact,
    isRoom: false,
    memory: {
      mcpUrl: null,
      repoPath: null,
      injectOnSpawn: false,
      searchPerTurn: false,
      capture: false,
      maxTurnChars: 800,
      sessionMaxAgeHours: 12,
    },
    userName: 'User',
    nameOf: (sender: string) => sender,
    log: (message: string) => buildLogs.push(message),
    memberId: '',
    resumeToken: null,
  });
}

try {
  verifyExistingContactsMigration();
  for (const contact of [contacts.claude, contacts.codex, contacts.grok, contacts.opencode, contacts.api]) {
    assert.equal(contactConfig(contact).heartbeat.enabled, true, `${contact.backend} heartbeat defaults on`);
  }
  assert.equal(contactConfig(contacts.off).heartbeat.enabled, false, 'explicit CLI opt-out is preserved');

  const claude = await build(contacts.claude);
  assert.ok(claude.opts.allowedTools.includes('mcp__hub__camera_snap'));
  const claudeMcp = JSON.parse(fs.readFileSync(claude.opts.mcpConfig, 'utf-8'));
  assert.match(claudeMcp.mcpServers.hub.url, /\/api\/hub-mcp\/claude-default$/);
  assert.match(claude.opts.appendSystemPrompt, /camera_snap/);

  const codex = await build(contacts.codex);
  assert.deepEqual(codex.opts.mcpServers[0].enabledTools, ['camera_snap']);
  assert.match(codex.opts.developerInstructions, /camera_snap/);

  const grok = await build(contacts.grok);
  assert.ok(grok.opts.allowRules.includes('MCPTool(hub__camera_snap)'));
  assert.match(grok.opts.preamble, /camera_snap/);
  const grokConfig = fs.readFileSync(path.join(agentsDir, contacts.grok.id, '.grok', 'config.toml'), 'utf-8');
  assert.match(grokConfig, /\[mcp_servers\.hub\]/);
  assert.match(grokConfig, /\/api\/hub-mcp\/grok-default/);
  assert.match(grokConfig, /Authorization = "Bearer /);

  fs.writeFileSync(path.join(agentsDir, contacts.grokBlocked.id, '.grok'), 'blocks project config directory', 'utf-8');
  const grokUserConfigPath = path.join(process.env.HOME!, '.grok', 'config.toml');
  fs.writeFileSync(grokUserConfigPath, [
    '[mcp_servers.hub]',
    'url = "http://old-host:3900/api/hub-mcp/grok-blocked"',
    'enabled = true',
    '',
    '[mcp_servers.hub.headers]',
    'Authorization = "Bearer stale"',
    '',
  ].join('\n'), 'utf-8');
  const grokBlocked = await build(contacts.grokBlocked);
  assert.ok(grokBlocked.opts.allowRules.includes('MCPTool(hub__camera_snap)'));
  const grokUserConfig = fs.readFileSync(grokUserConfigPath, 'utf-8');
  assert.match(grokUserConfig, /url = "http:\/\/127\.0\.0\.1:3900\/api\/hub-mcp\/grok-blocked"/);
  assert.match(grokUserConfig, /Authorization = "Bearer (?!stale)[^"]+"/);
  assert.ok(buildLogs.some((line) => line.includes('grok project config unavailable (EEXIST:')));
  assert.ok(buildLogs.some((line) => line.includes('grok user config refreshed for contact=grok-blocked')));

  const api = await build(contacts.api);
  assert.ok(api.opts.extraTools?.some((tool: { name: string }) => tool.name === 'camera_snap'));
  assert.match(api.opts.systemPrompt ?? '', /camera_snap/);
  assert.ok(buildLogs.some((line) => line.includes('companion heartbeat enabled (api native camera_snap)')));

  const opencode = await build(contacts.opencode);
  assert.match(opencode.opts.preamble, /camera_snap/);
  assert.ok(opencode.opts.configPath.startsWith(path.join(path.dirname(dbPath), 'agents', contacts.opencode.id)));
  const opencodeConfig = JSON.parse(fs.readFileSync(opencode.opts.configPath, 'utf-8'));
  assert.equal(opencodeConfig.autoupdate, false, 'generated OpenCode config preserves project settings');
  assert.match(opencodeConfig.mcp.hub.url, /\/api\/hub-mcp\/opencode-default$/);
  assert.equal(opencodeConfig.mcp.hub.type, 'remote');
  assert.equal(opencodeConfig.mcp.hub.oauth, false);

  console.log('CLI heartbeat defaults smoke: ok');
} finally {
  if (previousHubToken === undefined) delete process.env.HUB_TOKEN;
  else process.env.HUB_TOKEN = previousHubToken;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
