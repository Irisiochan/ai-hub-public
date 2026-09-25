import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../src/platform/db.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { buildDelegateTools } from '../src/jobs/delegateTools.js';
import { executionFingerprint } from '../src/jobs/coordinationKeys.js';
import { signInvocationScope } from '../src/workflow/moduleAuthority.js';
import { hubMcpRouter } from '../src/tools/hubMcpRoutes.js';

async function fixture(run: (ctx: any) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-module-authority-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const jobs = new JobStore(db, { broadcast() {} } as any);
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('reserve', 'Reserve', 'codex', 'dm', '{}')").run();
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room', 'Room', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['reserve'] }));
  const binding = { contactId: 'reserve', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' };
  jobs.workflowModules.setBinding('execute', binding as any, jobs.workflowModules.revision(), 'User');
  const taskPath = 'tasks/module-authority.md'; const planHash = 'a'.repeat(64);
  const bind = { taskPath, planHash, executor: 'reserve', workspace: dir, branch: 'module-authority' };
  const fingerprint = executionFingerprint(bind);
  const invocation = { moduleId: 'execute', binding, revision: jobs.workflowModules.revision(), permissions: { write: true, shell: true, ssh: false }, taskPath, workspace: dir };
  db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
    VALUES ('room', 'room-host', 'user', 'text', 'Approved dispatch', 'done', ?, 'main', ?)`)
    .run(JSON.stringify({ roomHost: { coordination: { kind: 'execution', ...bind }, workflowModule: {
      moduleId: 'execute', policyVersion: 1, bindingRevision: invocation.revision, binding,
    } } }), `coordination:v2:${taskPath}:${fingerprint}`);
  const prompt = `[AI_HUB_COORDINATION_V2]\ntaskPath=${taskPath}\nplanHash=${planHash}\nfingerprint=${fingerprint}\nPerform the approved task.`;
  const scope = { allow: true, routeClasses: ['implement', 'fix'], invocation };
  try { await run({ db, jobs, dir, scope, prompt, invocation }); }
  finally {
    jobs.stopOutOfBandResolver(); db.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('ai-hub-module-authority-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('module turns no longer dispatch via delegate_to_worker; the tool points at execution_start', async () => fixture(async ({ db, jobs, dir, scope, prompt }: any) => {
  const delegate = buildDelegateTools(jobs, db, 'reserve', {}, 'room', undefined, scope).find((tool) => tool.name === 'delegate_to_worker')!;
  const result = await delegate.exec({ route_class: 'implement', workspace: dir, prompt, write: true, shell: true });
  assert.equal(result.ok, false);
  assert.match(result.text, /execution_start/, 'scoped callers get the migration pointer, not a marker gate');
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c, 0);
}));

test('a module delegate requires a trusted task dispatch', async () => fixture(async ({ db, jobs, dir, scope }: any) => {
  const cfg = { enabled: true, workspaces: [dir], allowShell: true };
  const delegate = buildDelegateTools(jobs, db, 'reserve', cfg, 'room', undefined, scope).find((tool) => tool.name === 'delegate_to_worker')!;
  assert.equal((await delegate.exec({ route_class: 'implement', workspace: dir, prompt: 'No approved dispatch', shell: true })).ok, false);
}));

test('a module delegate cannot dispatch from a turn; quality streaks never gate dispatch', async () => fixture(async ({ db, jobs, dir, scope, prompt, invocation }: any) => {
  const cfg = { enabled: true, workspaces: [dir], allowShell: true };
  const delegate = buildDelegateTools(jobs, db, 'reserve', cfg, 'room', undefined, scope).find((tool) => tool.name === 'delegate_to_worker')!;
  const fingerprint = jobs.workflowModules.fingerprintFor(invocation.taskPath, prompt);
  for (let index = 0; index < 5; index++) jobs.workflowModules.record({ id: `bad-${index}` }, { moduleId: 'execute', taskPath: invocation.taskPath, problemFingerprint: fingerprint }, { quality: 'inadequate' });
  const result = await delegate.exec({ route_class: 'implement', workspace: dir, prompt, shell: true,
    problem_fingerprint: fingerprint, runner_override_reason: 'I would like to continue anyway' });
  assert.equal(result.ok, false, 'a model-authored override reason is not User approval');
}));

test('signed module MCP access is enabled by the module even when personal delegation is disabled', async () => fixture(async ({ db, jobs, invocation }: any) => {
  db.prepare("UPDATE contacts SET config = ? WHERE id = 'reserve'").run(JSON.stringify({ delegation: { enabled: false }, heartbeat: { enabled: false } }));
  const hubToken = 'test-module-secret';
  const app = express(); app.use(express.json()); app.use('/api', hubMcpRouter(db, jobs, { hubToken }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as any;
  try {
    const token = signInvocationScope(hubToken, { contactId: 'reserve', roomId: 'room', moduleId: 'execute', revision: invocation.revision });
    const response = await fetch(`http://127.0.0.1:${address.port}/api/hub-mcp/reserve`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'module-test', version: '1' } } }) });
    assert.equal(response.status, 200, await response.text());
    const listed = await fetch(`http://127.0.0.1:${address.port}/api/hub-mcp/reserve`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
    assert.equal(listed.status, 200);
    const text = await listed.text();
    assert.match(text, /worker_job_status/, 'the module MCP keeps scoped reads');
    assert.match(text, /task_get/, 'the module MCP exposes the task ledger');
    assert.match(text, /task_handoff/, 'the module MCP exposes explicit handoff');
    assert.match(text, /execution_start/, 'the module MCP exposes execution start');
    assert.doesNotMatch(text, /"name":"delegate_to_worker"/, 'marker dispatch is gone from module scope');
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}));
