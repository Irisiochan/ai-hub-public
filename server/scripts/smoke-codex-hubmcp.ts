import assert from 'node:assert/strict';
import { codexAppServerArgs } from '../src/agents/codexAppServer.js';

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

console.log('codex hub MCP config smoke: ok');
