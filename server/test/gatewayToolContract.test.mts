import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildCameraTool } from '../src/agents/cameraTool.js';
import { buildDelegateTools } from '../src/agents/gatewayTools.js';
import { buildTaobaoTools } from '../src/agents/taobaoTools.js';
import type { CompanionHeartbeat } from '../src/agents/companionHeartbeat.js';
import { openDb } from '../src/db.js';
import { hubMcpRouter } from '../src/routes/hubMcp.js';
import type { SseHub } from '../src/sse.js';
import type { CameraSnapBroker } from '../src/workers/cameraSnap.js';
import { JobStore } from '../src/workers/jobStore.js';
import type { TaobaoBridge } from '../src/workers/taobaoBridge.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-tool-contract-'));
const db = openDb(path.join(dir, 'hub.db'));
const jobs = new JobStore(db, { broadcast() {} } as unknown as SseHub);
const delegation = {
  enabled: true, workspaces: ['C:/ai-hub'], runners: ['codex'] as ['codex'], allowShell: true,
};
db.prepare(`INSERT INTO contacts (id, name, backend, kind, config)
  VALUES ('codex', 'Codex', 'api', 'dm', ?)`).run(JSON.stringify({
  delegation, heartbeat: { enabled: true, taobao: { mode: 'full' } },
}));
db.prepare(`INSERT INTO workers (id, name, token_hash, capabilities, last_seen_at)
  VALUES ('pc', 'PC', 'test', '{"camera":true,"taobao":true}', datetime('now'))`).run();

let active = true;
let cameraCalls = 0;
const heartbeat = { isActive: () => active } as unknown as CompanionHeartbeat;
const broker = {
  request: async () => {
    cameraCalls++;
    return { ok: true, jpegBase64: 'aW1hZ2U=' };
  },
} as unknown as CameraSnapBroker;
const taobaoCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const taobao = {
  request: async (_contact: string, name: string, args: Record<string, unknown>) => {
    taobaoCalls.push({ name, args });
    return { ok: true, content: [{ type: 'text', text: '淘宝返回' }] };
  },
} as unknown as TaobaoBridge;
const tools = [
  ...buildDelegateTools(jobs, db, 'codex', delegation),
  buildCameraTool(broker, heartbeat, db, 'codex'),
  ...buildTaobaoTools(taobao, heartbeat, db, 'codex', 'full'),
];
const direct = (name: string, input: Record<string, unknown>) =>
  tools.find((tool) => tool.name === name)!.exec(input);
const app = express();
app.use(express.json());
app.use('/api', hubMcpRouter(db, jobs, {}, { broker, heartbeat, taobao }));
const server = app.listen(0, '127.0.0.1');
const client = new Client({ name: 'gateway-tool-contract', version: '1' });
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');

try {
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/api/hub-mcp/codex`),
  ));
  const listed = (await client.listTools()).tools;
  assert.equal(listed.length, 27, 'all four job tools, camera, and 22 Taobao tools are registered');
  for (const tool of tools) {
    const mcp = listed.find((entry) => entry.name === tool.name)!;
    assert.ok(mcp, `${tool.name} is available to CLI contacts`);
    assert.equal(mcp.description, tool.description);
    assert.deepEqual(mcp.inputSchema, tool.schema, `${tool.name}: API and MCP declarations match exactly`);
    assert.equal(tool.schema.additionalProperties, false, `${tool.name}: undeclared fields are rejected`);
  }
  const delegateSchema = tools[0].schema;
  assert.deepEqual(delegateSchema.required, ['route_class', 'workspace', 'prompt']);
  const properties = delegateSchema.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.runner.enum, ['codex'], 'both declarations respect the contact runner allowlist');
  assert.equal(properties.problem_fingerprint.pattern, '^[a-fA-F0-9]{64}$');
  assert.ok(new RegExp(String(properties.problem_fingerprint.pattern)).test('A'.repeat(64)),
    'the advertised JSON pattern also accepts uppercase SHA-256 values');

  const baseDispatch = { route_class: 'implement', workspace: 'C:/ai-hub', prompt: '检查项目' };
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['delegate_to_worker', { workspace: 'C:/ai-hub', prompt: '缺少 route_class' }],
    ['delegate_to_worker', { ...baseDispatch, runner: 'grok', runner_override_reason: 'test' }],
    ['delegate_to_worker', { ...baseDispatch, problem_fingerprint: 'bad' }],
    ['delegate_to_worker', { ...baseDispatch, shell: 'true' }],
    ['delegate_to_worker', { ...baseDispatch, permissions: { ssh: true } }],
    ['worker_job_cancel', { job_id: 42 }],
    ['worker_job_update_delivery', { job_id: 'missing', stage: 'invented' }],
    ['camera_snap', { reason: 42 }],
    ['camera_snap', { path: 'C:/private' }],
    ['taobao_navigate', {}],
    ['taobao_navigate', { page: null }],
    ['taobao_scroll_page', { direction: 'sideways' }],
    ['taobao_get_current_tab', { sourceApp: 'spoofed' }],
    ...[-1, 0.5, '0'].map((result_offset): [string, Record<string, unknown>] =>
      ['worker_job_status', { job_id: 'missing', result_offset }]),
    ...[0, 12001, 1.5, '4000'].map((result_limit): [string, Record<string, unknown>] =>
      ['worker_job_status', { job_id: 'missing', result_limit }]),
  ];
  for (const [name, args] of invalid) {
    const api = await direct(name, args);
    assert.equal(api.ok, false, `${name}: invalid API arguments fail`);
    assert.match(api.text, /工具参数无效/);
    const mcp = await client.callTool({ name, arguments: args });
    assert.equal(mcp.isError, true, `${name}: invalid MCP arguments fail`);
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n, 0);
  assert.equal(cameraCalls, 0, 'invalid inputs never capture an image');
  assert.deepEqual(taobaoCalls, [], 'invalid inputs never reach the desktop bridge');

  // Valid requests keep their results, including images and gateway-injected arguments.
  const camera = await direct('camera_snap', { reason: '看看' });
  const mcpCamera = await client.callTool({ name: 'camera_snap', arguments: { reason: '看看' } });
  assert.equal(camera.ok, true);
  assert.deepEqual(mcpCamera.content, [
    { type: 'text', text: camera.text },
    { type: 'image', ...camera.image },
  ]);
  assert.equal((await direct('taobao_navigate', { page: 'home' })).ok, true);
  assert.equal((await client.callTool({ name: 'taobao_navigate', arguments: { page: 'home' } })).isError, false);
  assert.deepEqual(taobaoCalls, Array.from({ length: 2 }, () => ({
    name: 'navigate', args: { page: 'home', sourceApp: 'ai-hub' },
  })));

  // Schema validation does not replace authorization or heartbeat gates.
  for (const args of [
    { ...baseDispatch, workspace: 'C:/outside' },
    { ...baseDispatch, ssh: true, problem_fingerprint: 'A'.repeat(64) },
  ]) {
    const api = await direct('delegate_to_worker', args);
    const mcp = await client.callTool({ name: 'delegate_to_worker', arguments: args });
    assert.equal(api.ok, false);
    assert.equal(mcp.isError, true);
    assert.deepEqual(mcp.content, [{ type: 'text', text: api.text }]);
    assert.doesNotMatch(api.text, /工具参数无效/);
  }
  active = false;
  for (const name of ['camera_snap', 'taobao_get_current_tab']) {
    const api = await direct(name, {});
    const mcp = await client.callTool({ name, arguments: {} });
    assert.equal(api.ok, false);
    assert.match(api.text, /心跳窗口未激活/);
    assert.deepEqual(mcp.content, [{ type: 'text', text: api.text }]);
    assert.equal(mcp.isError, true);
  }
  assert.equal(cameraCalls, 2);
  assert.equal(taobaoCalls.length, 2);
  console.log('gateway tool API/MCP contract tests: ok');
} finally {
  await client.close();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
