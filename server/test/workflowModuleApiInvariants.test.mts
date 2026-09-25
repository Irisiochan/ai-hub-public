// Independent HTTP/lineage acceptance checks owned by the root reviewer.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb, type JobRow } from '../src/platform/db.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { workflowModulesRouter } from '../src/jobs/workflowModuleRoutes.js';
import { workersRouter } from '../src/jobs/workerRoutes.js';

async function fixture(run: (ctx: {
  db: ReturnType<typeof openDb>; jobs: JobStore; base: string; token: string;
  oldJob(options?: { expired?: boolean; deploy?: boolean; active?: boolean }): JobRow;
  post(id: string, body?: unknown): Promise<Response>;
}) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-module-api-invariants-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const sse = { broadcast() {} } as never;
  const token = 'pc-fixture.test-token-local-only';
  const contacts = [['codex', 'Codex', 'codex'], ['muse', 'Sora', 'opencode-cli'], ['aye', '阿野', 'grok-cli'], ['claude', 'Claude', 'claude-cli']];
  for (const values of contacts) db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(...values);
  db.prepare(`INSERT INTO workers (id, name, token_hash, capabilities, status, accepting_jobs, last_seen_at)
    VALUES ('pc-fixture', 'test', ?, ?, 'online', 1, datetime('now'))`)
    .run(crypto.createHash('sha256').update(token).digest('hex'), JSON.stringify({ runners: ['codex', 'opencode'], workspaces: [dir], shell: true, ssh: true }));
  const jobs = new JobStore(db, sse);
  const app = express(); app.use(express.json());
  app.use('/api', workflowModulesRouter(db, sse, jobs, () => ({ 'credential:grok': { blocked: true, reason: 'quota exhausted' } })));
  app.use('/api', workersRouter(db, sse, jobs));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const post = (id: string, body: unknown = { expectedRevision: jobs.workflowModules.revision() }) => fetch(`${base}/workflow-modules/jobs/${id}/takeover`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const oldJob = ({ expired = false, deploy = false, active = false } = {}) => {
    const id = crypto.randomUUID();
    const options = { workflowStage: deploy ? 'maintenance' : 'execute', routeClass: deploy ? 'mechanical' : 'implement',
      taskPath: `tasks/${id}.md`, problemFingerprint: 'a'.repeat(64),
      model: 'gpt-6-astra', reasoning: 'high',
      ...(deploy ? { closureKind: 'deploy', frozenSha: 'b'.repeat(40), parentJobId: 'original-implementation', sourceReviewJobId: 'approved-review', dispatchSource: 'harness-auto' } : {}),
    };
    db.prepare(`INSERT INTO jobs (id, requested_by, worker_id, runner, workspace, prompt, status, ttl_at,
      idempotency_key, permissions, options, session_id, error)
      VALUES (?, 'User', 'pc-fixture', 'codex', ?, ?, ?, datetime('now', ?), ?, ?, ?, 'old-session', ?)`)
      .run(id, dir, deploy ? 'Run the already authorized HTTP deployment.' : 'Only inspect the approved code; do not edit files.',
        active ? 'running' : 'failed', expired ? '-1 minute' : '+11 minutes', id,
        JSON.stringify({ write: false, shell: true, ssh: deploy }), JSON.stringify(options), 'quota exhausted after tool use');
    return jobs.get(id)!;
  };
  try { await run({ db, jobs, base, token, oldJob, post }); }
  finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    jobs.stopOutOfBandResolver(); db.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('ai-hub-module-api-invariants-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('module view exposes usable real CLI contacts and isolates the exhausted pool', async () => fixture(async ({ base }) => {
  const response = await fetch(`${base}/workflow-modules`); assert.equal(response.status, 200);
  const body = await response.json() as any;
  const codex = body.agents.find((a: any) => a.contactId === 'codex');
  const muse = body.agents.find((a: any) => a.contactId === 'muse');
  assert.ok(codex.models.some((m: any) => m.id === 'gpt-6-astra'), 'planning module must have an actual selectable catalog entry');
  assert.equal(muse.runner, 'opencode'); assert.ok(muse.compatibleModules.includes('execute'));
  assert.equal(body.modules.find((m: any) => m.id === 'review').status, 'blocked');
  assert.equal(body.modules.find((m: any) => m.id === 'plan').status, 'idle');
}));

test('takeover requires an explicit configuration revision', async () => fixture(async ({ oldJob, post }) => {
  const old = oldJob(); const response = await post(old.id, {});
  assert.equal(response.status, 400, 'an omitted revision must not silently use a changed binding');
}));

test('manual job creation follows current module binding without retaining the legacy profile model', async () => fixture(async ({ jobs, base, oldJob }) => {
  const old = oldJob();
  const changed = jobs.workflowModules.setBinding('execute', { contactId: 'codex', runner: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  assert.equal(changed.ok, true);
  const response = await fetch(`${base}/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: old.workspace, prompt: 'Implement a separately authorized task.', stage: 'execute', permissions: { write: true, shell: true, ssh: false } }),
  });
  assert.equal(response.status, 201);
  const result = await response.json() as any;
  const created = jobs.get(result.id)!;
  assert.equal(created.runner, 'codex');
  assert.equal(JSON.parse(created.options).model, 'gpt-5.6-sol');
  assert.equal(JSON.parse(created.options).workflowModule.binding.model, 'gpt-5.6-sol');
}));

test('expired task cannot gain a fresh day of budget through takeover', async () => fixture(async ({ oldJob, post }) => {
  const old = oldJob({ expired: true }); const response = await post(old.id);
  assert.equal(response.status, 409, 'takeover does not extend original task TTL');
}));

test('takeover inherits the remaining TTL, authorization, fresh session and original immutable payload', async () => fixture(async ({ jobs, oldJob, post }) => {
  const old = oldJob();
  const bind = jobs.workflowModules.setBinding('execute', { contactId: 'codex', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  assert.equal(bind.ok, true);
  const response = await post(old.id); assert.equal(response.status, 201);
  const body = await response.json() as any; const next = jobs.get(body.job.id)!;
  assert.ok(next.ttl_at && old.ttl_at && next.ttl_at <= old.ttl_at, 'remaining TTL may narrow but must not expand');
  assert.equal(JSON.parse(next.permissions).write, false, 'replacement cannot gain write permission from its module');
  assert.equal(next.session_id, null); assert.equal(next.workspace, old.workspace);
  assert.equal(JSON.parse(next.options).taskPath, JSON.parse(old.options).taskPath);
  assert.equal(JSON.parse(next.options).problemFingerprint, JSON.parse(old.options).problemFingerprint);
  assert.equal(jobs.get(old.id)!.options, old.options);
  assert.equal(jobs.get(old.id)!.permissions, old.permissions);
}));

test('quota error after a deployment started is not proof that no deployment side effects occurred', async () => fixture(async ({ oldJob, post }) => {
  const old = oldJob({ deploy: true }); const response = await post(old.id);
  assert.equal(response.status, 409, 'a quota/lease/auth string must never authorize blind replay of an uncertain deployment');
}));

test('active attempt cannot race a replacement', async () => fixture(async ({ oldJob, post }) => {
  const old = oldJob({ active: true }); const response = await post(old.id); assert.equal(response.status, 409);
}));

test('duplicate takeover resolves one replacement and rejects late worker events and completions', async () => fixture(async ({ jobs, base, token, oldJob, post }) => {
  const old = oldJob();
  jobs.workflowModules.setBinding('execute', { contactId: 'codex', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  const responses = await Promise.all([post(old.id), post(old.id)]);
  const bodies = await Promise.all(responses.map((r) => r.json())) as any[];
  assert.ok(responses.every((r) => r.ok), JSON.stringify(bodies));
  assert.equal(bodies[0].job.id, bodies[1].job.id);
  for (const action of ['events', 'complete']) {
    const response = await fetch(`${base}/worker/jobs/${old.id}/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(action === 'events' ? { kind: 'session', meta: { sessionId: 'late-session' } } : { status: 'done', result: 'late old completion' }),
    });
    assert.equal(response.status, 409, `old ${action} callback is fenced`);
  }
  assert.equal(jobs.get(old.id)!.session_id, 'old-session');
  assert.equal(jobs.get(old.id)!.status, 'failed');
}));
