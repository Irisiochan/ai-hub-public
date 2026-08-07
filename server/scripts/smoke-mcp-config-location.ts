/**
 * Smoke test: 网关生成的 mcp.gateway.json 必须落在可写的运行时目录，不能落进代码检出。
 * M1.5 之后 systemd 用 ProtectSystem=strict 把 /opt/ai-hub 挂只读，只有 data 目录和
 * /var/lib/ai-hub 可写；写进 server/agents/<id>/ 会以 EROFS 打挂整个后端启动。
 * Run with: npx tsx scripts/smoke-mcp-config-location.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackendFactory } from '../src/agents/backendFactory.js';
import { MessageRepo } from '../src/agents/messageRepo.js';
import { PromptComposer } from '../src/agents/promptComposer.js';
import type { HubConfig } from '../src/config.js';
import { openDb, type ContactRow } from '../src/db.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-mcpcfg-'));
const agentsDir = path.join(root, 'checkout', 'server', 'agents'); // 只读检出的位置
const dataDir = path.join(root, 'data'); // ReadWritePaths 里的可写目录
fs.mkdirSync(path.join(agentsDir, 'claude'), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'hub.db');
const db = openDb(dbPath);
db.prepare('INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, ?, ?)').run(
  'claude', 'Claude', 'claude-cli', 'dm', JSON.stringify({ cwd: 'claude' })
);
const agent = db.prepare('SELECT * FROM contacts WHERE id = ?').get('claude') as ContactRow;

const config = {
  host: '127.0.0.1',
  port: 3900,
  dbPath,
  agentsDir,
  claude: { cliPath: 'claude', turnTimeoutMs: 1000 },
  memory: { mcpUrl: 'http://127.0.0.1:8900/mcp' },
} as unknown as HubConfig;

const factory = new BackendFactory({
  db,
  config,
  vault: {} as any, // 只用于开关 memory MCP，不发请求
  jobStore: null,
  prompts: new PromptComposer(null, new MessageRepo(db), agentsDir),
});

await factory.build({
  agent,
  convo: agent,
  isRoom: false,
  memory: {
    mcpUrl: config.memory.mcpUrl, repoPath: null, injectOnSpawn: true,
    searchPerTurn: false, capture: false, maxTurnChars: 800, sessionMaxAgeHours: 12,
  },
  userName: 'User',
  nameOf: (sender: string) => sender,
  log: () => {},
  memberId: '',
  resumeToken: null,
});

const generated = path.join(dataDir, 'agents', 'claude', 'mcp.gateway.json');
assert.ok(fs.existsSync(generated), `生成的 mcp 配置应落在 data 目录：${generated}`);
assert.ok(
  !fs.existsSync(path.join(agentsDir, 'claude', 'mcp.gateway.json')),
  '不得写进代码检出的 agents 目录——那里在生产上是只读挂载'
);
assert.ok(
  JSON.parse(fs.readFileSync(generated, 'utf-8')).mcpServers['memory-vault'],
  '生成内容仍应包含 memory-vault server'
);

// Windows 上 sqlite 句柄没关就删目录会 EPERM；清理是尽力而为，别因此判失败。
db.close();
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {}
console.log('mcp config location smoke: ok');
