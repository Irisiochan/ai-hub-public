import assert from 'node:assert/strict';
import {
  codexAppServerArgs,
  elicitationDetail,
  isMemoryVaultApproval,
  isMemoryVaultMcpName,
  isTrustedMcpApproval,
  isTrustedMcpServerName,
} from '../src/backends/codexAppServer.js';

const plain = codexAppServerArgs();
assert.deepEqual(plain, ['app-server', '--stdio']);

const url = 'http://127.0.0.1:3900/api/hub-mcp/codex';
const args = codexAppServerArgs([{
  name: 'hub',
  url,
  enabledTools: ['delegate_to_worker', 'worker_job_status', 'worker_job_cancel', 'worker_job_update_delivery'],
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
assert.equal(values.get('mcp_servers.hub.default_tools_approval_mode'), '"approve"');
assert.deepEqual(
  JSON.parse(values.get('mcp_servers.hub.enabled_tools') ?? '[]'),
  ['delegate_to_worker', 'worker_job_status', 'worker_job_cancel', 'worker_job_update_delivery']
);
assert.throws(
  () => codexAppServerArgs([{ name: 'bad.name', url }]),
  /invalid Codex MCP server name/
);

const withVault = codexAppServerArgs([
  {
    name: 'memory_vault',
    url: 'http://127.0.0.1:8900/mcp',
    required: false,
    defaultToolsApprovalMode: 'auto',
  },
  {
    name: 'hub',
    url,
    enabledTools: ['delegate_to_worker'],
    required: true,
    defaultToolsApprovalMode: 'approve',
  },
]);
const vaultValues = new Map<string, string>();
for (let i = 0; i < withVault.length; i++) {
  if (withVault[i] !== '--config') continue;
  const [key, ...rest] = withVault[++i].split('=');
  vaultValues.set(key, rest.join('='));
}
assert.equal(vaultValues.get('mcp_servers.memory_vault.default_tools_approval_mode'), '"auto"');
assert.equal(vaultValues.get('mcp_servers.hub.default_tools_approval_mode'), '"approve"');
assert.equal(isMemoryVaultMcpName('memory_vault'), true);
assert.equal(isMemoryVaultMcpName('memory-vault'), true);
assert.equal(isMemoryVaultMcpName('hub'), false);
assert.equal(isMemoryVaultApproval('mcp/tool/requestApproval', { serverName: 'memory_vault' }), true);
assert.equal(isMemoryVaultApproval('execCommandApproval', { serverName: 'memory_vault' }), false);
assert.equal(isMemoryVaultApproval('applyPatchApproval', { tool: 'memory_vault__write_memory' }), false);
assert.equal(isTrustedMcpApproval('mcp/tool/requestApproval', { serverName: 'hub' }), true);
assert.equal(isTrustedMcpApproval('mcp/tool/requestApproval', { serverName: 'memory_vault' }), true);
assert.equal(isTrustedMcpApproval('execCommandApproval', { serverName: 'hub' }), false);
assert.equal(isTrustedMcpApproval('mcp/tool/requestApproval', { connector_name: 'Memory' }), true);

// Plan-memory repair: unrelated servers never gain approval from free-text
// keywords. Elicitation payloads carry only serverName (no tool), so a
// codex_apps prompt that mentions vault/hub in its message must still decline.
assert.equal(isTrustedMcpServerName('codex_apps'), false);
assert.equal(isTrustedMcpServerName('hub'), true);
assert.equal(isTrustedMcpServerName('memory_vault'), true);
assert.equal(isTrustedMcpServerName('memory-vault'), true);
assert.equal(isTrustedMcpApproval('mcpServer/elicitation/request', { serverName: 'codex_apps' }), false);
assert.equal(isTrustedMcpApproval('mcpServer/elicitation/request', {
  serverName: 'codex_apps', mode: 'form', message: 'allow memory_vault search? mcp__hub__delegate?',
}), false);
assert.equal(isTrustedMcpApproval('mcpServer/elicitation/request', { serverName: 'unknown-connector' }), false);
assert.equal(isTrustedMcpApproval('mcpServer/elicitation/request', { serverName: 'memory_vault' }), true);
assert.equal(isTrustedMcpApproval('mcpServer/elicitation/request', { serverName: 'hub' }), true);
assert.match(elicitationDetail({ serverName: 'codex_apps', mode: 'form', message: 'hello' }), /mode=form/);

console.log('codex hub MCP config smoke: ok');
