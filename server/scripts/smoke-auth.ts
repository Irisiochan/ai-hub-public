import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { desktopSessionAuth, isSelfAuthenticatedInternalPath } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { hubMcpRouter } from '../src/routes/hubMcp.js';
import { JobStore } from '../src/workers/jobStore.js';

assert.equal(isSelfAuthenticatedInternalPath('/api/worker/connect'), true);
assert.equal(isSelfAuthenticatedInternalPath('/api/hub-mcp/contact'), true);
for (const value of [
  '/api/workers',
  '/api/worker-evil',
  '/api/worker/../workers',
  '/api/worker/unknown',
  '/api/hub-mcp-evil',
  '/api/hub-mcp',
  '/api/hub-mcp/contact/extra',
]) {
  assert.equal(isSelfAuthenticatedInternalPath(value), false, `${value} must not bypass session auth`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-auth-smoke-'));
const db = openDb(path.join(dir, 'test.db'));
const jobs = new JobStore(db, { broadcast: () => {} } as any);
db.prepare(
  `INSERT INTO contacts (id, name, backend, kind, config) VALUES ('contact', 'Contact', 'codex', 'dm', '{}')`
).run();

const app = express();
app.use(express.json());
app.use(desktopSessionAuth('session-secret'));
app.all('/api/workers', (_req, res) => res.json({ ok: true }));
app.all('/api/worker/connect', (_req, res) => res.status(418).json({ deviceRoute: true }));
app.all('/api/worker-evil', (_req, res) => res.json({ unsafe: true }));
app.all('/api/hub-mcp-evil', (_req, res) => res.json({ unsafe: true }));
app.use('/api', hubMcpRouter(db, jobs, 'mcp-secret'));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;
const url = (pathname: string) => `http://127.0.0.1:${port}${pathname}`;

try {
  assert.equal((await fetch(url('/api/workers'))).status, 401);
  assert.equal((await fetch(url('/api/workers'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(url('/api/worker/connect'), { method: 'POST' })).status, 418);
  assert.equal((await fetch(url('/api/worker-evil'))).status, 401);
  assert.equal((await fetch(url('/api/hub-mcp-evil'))).status, 401);

  const bootstrap = await fetch(url('/api/workers?token=session-secret'));
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  assert.equal((await fetch(url('/api/workers'), { headers: { cookie } })).status, 200);

  const endpoint = url('/api/hub-mcp/contact');
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer mcp-secret', 'content-type': 'application/json' }, body: '{}' })).status, 403);

  const closed = express();
  closed.use('/api', hubMcpRouter(db, jobs, ''));
  const closedServer = closed.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => closedServer.once('listening', resolve));
  const closedPort = (closedServer.address() as { port: number }).port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${closedPort}/api/hub-mcp/contact`, { method: 'POST' })).status, 503);
  } finally {
    await new Promise<void>((resolve, reject) => closedServer.close((error) => error ? reject(error) : resolve()));
  }
  console.log('desktop and hub MCP auth smoke: ok');
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
