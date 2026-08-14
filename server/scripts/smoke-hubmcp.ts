/**
 * Smoke test: /api/hub-mcp/:contactId with a real MCP client over
 * streamable HTTP — the same path claude CLI takes via --mcp-config.
 * Run with: npx tsx scripts/smoke-hubmcp.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from '../src/db.js';
import { hubMcpRouter } from '../src/routes/hubMcp.js';
import { JobStore } from '../src/workers/jobStore.js';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-mcp-smoke-'));
const db = openDb(path.join(dir, 'test.db'));
const store = new JobStore(db, { broadcast: () => {} } as any);
const ws = path.join(dir, 'repo');
fs.mkdirSync(ws);

db.prepare(
  `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
   VALUES ('claude', 'Claude', '🍊', '#f80', 'claude-cli', 'dm', ?, 0)`
).run(JSON.stringify({
  delegation: { enabled: true, workspaces: [ws], allowShell: true, allowSsh: true },
}));
db.prepare(
  `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
   VALUES ('nodelegate', 'N', '❌', '#888', 'api', 'dm', '{}', 1)`
).run();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', hubMcpRouter(db, store));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = (server.address() as any).port;

// 1. delegation 开着的联系人：list + call
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/hub-mcp/claude`))
);
const tools = await client.listTools();
check('工具清单 4 件套', tools.tools.map((t) => t.name).sort().join(',') === 'delegate_to_worker,worker_job_cancel,worker_job_status,worker_job_update_delivery');
const delegateSchema: any = tools.tools.find((tool) => tool.name === 'delegate_to_worker')?.inputSchema;
check('Hub MCP 委派 schema 暴露 ssh 参数', delegateSchema?.properties?.ssh?.type === 'boolean');
check('Hub MCP 委派 schema 暴露 write 参数', delegateSchema?.properties?.write?.type === 'boolean');
check('Hub MCP 委派 schema 要求 route_class', delegateSchema?.required?.includes('route_class'));
check('Hub MCP 委派 schema 的 runner 可选', !delegateSchema?.required?.includes('runner'));

const bad: any = await client.callTool({
  name: 'delegate_to_worker',
  arguments: { route_class: 'implement', workspace: '/etc', prompt: 'x' },
});
check('越界调用 isError', bad.isError === true && String(bad.content?.[0]?.text).includes('白名单'));

const good: any = await client.callTool({
  name: 'delegate_to_worker',
  arguments: {
    route_class: 'implement',
    workspace: ws,
    prompt: '把 README 错别字修了并 commit，然后部署到测试 VPS',
    ssh: true,
  },
});
const text = String(good.content?.[0]?.text ?? '');
check('派单成功', !good.isError && text.includes('pending'), text);
const jobId = text.match(/任务 ([0-9a-f-]{36})/)?.[1];
check('job 落库且 requested_by=claude', !!jobId && (db.prepare('SELECT requested_by FROM jobs WHERE id = ?').get(jobId) as any)?.requested_by === 'claude');
check(
  'Hub MCP ssh=true 写入持久 job',
  !!jobId && JSON.parse((db.prepare('SELECT permissions FROM jobs WHERE id = ?').get(jobId) as any)?.permissions || '{}').ssh === true,
);
await client.close();

// 2. 没开 delegation 的联系人被 403
let refused = false;
const c2 = new Client({ name: 'smoke2', version: '0.0.1' });
try {
  await c2.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/hub-mcp/nodelegate`))
  );
} catch {
  refused = true;
} finally {
  await c2.close().catch(() => {});
}
check('未开启委派的联系人被拒', refused);

await new Promise<void>((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});
db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
