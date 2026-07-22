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
const token = 'smoke-hub-token';
const ws = path.join(dir, 'repo');
fs.mkdirSync(ws);

db.prepare(
  `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
   VALUES ('assistant', 'Assistant', '🤖', '#64748b', 'claude-cli', 'dm', ?, 0)`
).run(JSON.stringify({ delegation: { enabled: true, workspaces: [ws], allowShell: true } }));
db.prepare(
  `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
   VALUES ('nodelegate', 'N', '❌', '#888', 'api', 'dm', '{}', 1)`
).run();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api', hubMcpRouter(db, store, token));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = (server.address() as any).port;

const endpoint = `http://127.0.0.1:${port}/api/hub-mcp/assistant`;
check('缺少 token 被拒', (await fetch(endpoint, { method: 'POST' })).status === 401);
check('错误 token 被拒', (await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status === 401);

// 1. delegation 开着的联系人：list + call
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
);
const tools = await client.listTools();
check('工具清单 3 件套', tools.tools.map((t) => t.name).sort().join(',') === 'delegate_to_worker,worker_job_cancel,worker_job_status');

const bad: any = await client.callTool({
  name: 'delegate_to_worker',
  arguments: { runner: 'claude', workspace: '/etc', prompt: 'x' },
});
check('越界调用 isError', bad.isError === true && String(bad.content?.[0]?.text).includes('白名单'));

const good: any = await client.callTool({
  name: 'delegate_to_worker',
  arguments: { runner: 'claude', workspace: ws, prompt: '把 README 错别字修了并 commit' },
});
const text = String(good.content?.[0]?.text ?? '');
check('派单成功', !good.isError && text.includes('pending'), text);
const jobId = text.match(/任务 ([0-9a-f-]{36})/)?.[1];
check('job 落库且 requested_by=assistant', !!jobId && (db.prepare('SELECT requested_by FROM jobs WHERE id = ?').get(jobId) as any)?.requested_by === 'assistant');
await client.close();

// 2. 没开 delegation 的联系人被 403
let refused = false;
const c2 = new Client({ name: 'smoke2', version: '0.0.1' });
try {
  await c2.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/hub-mcp/nodelegate`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
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
