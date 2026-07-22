import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  GROK_HUB_ALLOW_RULE,
  syncManagedGrokHubMcpConfig,
} from '../src/agents/grokMcpConfig.js';
import { openDb } from '../src/db.js';
import { hubMcpRouter } from '../src/routes/hubMcp.js';
import { JobStore } from '../src/workers/jobStore.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-grok-mcp-smoke-'));
const execFileAsync = promisify(execFile);
const cwd = path.join(root, 'agent');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(path.join(cwd, '.grok'), { recursive: true });
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(cwd, '.grok', 'config.toml'), '[ui]\ntheme = "dark"\n', 'utf-8');

const db = openDb(path.join(root, 'hub.db'));
const jobs = new JobStore(db, { broadcast: () => {} } as any);
const token = 'grok-smoke-token-not-real';
db.prepare(
  `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
   VALUES ('grok-build', 'Grok Build', '⚡', '#334155', 'grok-cli', 'dm', ?, 0)`
).run(JSON.stringify({ delegation: { enabled: true, workspaces: [workspace] } }));

const app = express();
app.use(express.json());
app.use('/api', hubMcpRouter(db, jobs, token));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;

try {
  const templateUrl = `http://127.0.0.1:\${HUB_PORT:-3900}/api/hub-mcp/grok-build`;
  const configFile = syncManagedGrokHubMcpConfig(cwd, templateUrl);
  assert.ok(configFile);
  syncManagedGrokHubMcpConfig(cwd, templateUrl);

  const toml = fs.readFileSync(configFile, 'utf-8');
  assert.match(toml, /^\[ui\]$/m, 'existing Grok project settings must survive');
  assert.equal((toml.match(/^\[mcp_servers\.hub\]$/gm) ?? []).length, 1);
  assert.match(toml, /\$\{HUB_PORT:-3900\}/);
  assert.match(toml, /Bearer \$\{HUB_MCP_TOKEN\}/);
  assert.equal(toml.includes(token), false, 'the managed config must not persist the token');
  assert.equal(GROK_HUB_ALLOW_RULE, 'MCPTool(hub__*)');

  const env: Record<string, string> = {
    HUB_PORT: String(port),
    HUB_MCP_TOKEN: token,
  };

  try {
    const doctor = await execFileAsync('grok', ['mcp', 'doctor', 'hub', '--json'], {
      cwd,
      env: { ...process.env, ...env, GROK_FOLDER_TRUST: '0' },
      encoding: 'utf-8',
      timeout: 15_000,
    });
    const diagnostic = `${doctor.stdout ?? ''}\n${doctor.stderr ?? ''}`;
    const report = JSON.parse(doctor.stdout) as {
      servers?: Array<{ name?: string; healthy?: boolean; checks?: Array<{ label?: string; passed?: boolean }> }>;
    };
    const hub = report.servers?.find((server) => server.name === 'hub');
    assert.equal(hub?.healthy, true, diagnostic);
    assert.equal(
      hub?.checks?.some((check) => check.passed && /3 tools discovered/i.test(check.label ?? '')),
      true,
      diagnostic
    );
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      console.log('real Grok CLI not installed; protocol registration check continues');
    } else {
      assert.fail(`${error?.stdout ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? error}`);
    }
  }

  const expand = (value: string) => value.replace(
    /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g,
    (_match, key: string, fallback: string | undefined) => env[key] ?? fallback ?? ''
  );
  const rawUrl = toml.match(/^url = "([^"]+)"$/m)?.[1];
  const rawAuthorization = toml.match(/Authorization = "([^"]+)"/)?.[1];
  assert.ok(rawUrl && rawAuthorization);

  const client = new Client({ name: 'grok-config-smoke', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(expand(rawUrl)), {
    requestInit: { headers: { Authorization: expand(rawAuthorization) } },
  }));
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ['delegate_to_worker', 'worker_job_cancel', 'worker_job_status']
  );
  await client.close();

  syncManagedGrokHubMcpConfig(cwd);
  const disabled = fs.readFileSync(configFile, 'utf-8');
  assert.match(disabled, /^\[ui\]$/m);
  assert.doesNotMatch(disabled, /mcp_servers\.hub|HUB_MCP_TOKEN/);
  console.log('grok project Hub MCP registration smoke: ok');
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
