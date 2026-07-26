import assert from 'node:assert/strict';
import { codexAppServerArgs } from '../src/agents/codexAppServer.js';
import { managedHubMcpConfig } from '../src/agents/backendFactory.js';

const plain = codexAppServerArgs();
assert.deepEqual(plain, ['app-server', '--stdio']);

const url = 'http://127.0.0.1:3900/api/hub-mcp/codex';
const args = codexAppServerArgs([{
  name: 'hub',
  url,
  bearerTokenEnvVar: 'HUB_MCP_TOKEN',
  enabledTools: ['delegate_to_worker', 'worker_job_status', 'worker_job_cancel'],
  required: true,
  defaultToolsApprovalMode: 'approve',
}]);

const values = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--config') continue;
  const [key, ...rest] = args[++i].split('=');
  values.set(key, rest.join('='));
}

assert.equal(values.get('mcp_servers.hub.url'), JSON.stringify(url));
assert.equal(values.get('mcp_servers.hub.enabled'), 'true');
assert.equal(values.get('mcp_servers.hub.required'), 'true');
assert.equal(values.get('mcp_servers.hub.bearer_token_env_var'), '"HUB_MCP_TOKEN"');
assert.equal(values.get('mcp_servers.hub.default_tools_approval_mode'), '"approve"');
assert.deepEqual(
  JSON.parse(values.get('mcp_servers.hub.enabled_tools') ?? '[]'),
  ['delegate_to_worker', 'worker_job_status', 'worker_job_cancel']
);
assert.throws(
  () => codexAppServerArgs([{ name: 'bad.name', url }]),
  /invalid Codex MCP server name/
);
assert.throws(
  () => codexAppServerArgs([{ name: 'hub', url, bearerTokenEnvVar: 'bad-name' }]),
  /invalid Codex MCP bearer token env var/
);
assert.equal(args.join(' ').includes(process.env.HUB_MCP_TOKEN ?? 'not-a-real-secret'), false);

const claudeConfig = JSON.stringify(managedHubMcpConfig(url));
assert.match(claudeConfig, /Bearer \$\{HUB_MCP_TOKEN\}/);
assert.equal(claudeConfig.includes(process.env.HUB_MCP_TOKEN ?? 'not-a-real-secret'), false);

console.log('codex hub MCP config smoke: ok');
