import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../src/platform/db.js';
import { sessionAuth } from '../src/platform/middleware/auth.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { workflowModulesRouter } from '../src/jobs/workflowModuleRoutes.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';

const targets = { 'ai-hub': {
  repoId: 'ai-hub', platform: 'linux' as const, workerId: 'vps-dev',
  workspace: '/srv/ai-dev/jobs', runners: ['codex', 'opencode'], shell: true, ssh: false,
} };

test('User Worker default is validated, saved, and overrides model workspace only for new tasks', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-worker-target-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const sse = { broadcast() {} } as never;
  const jobs = new JobStore(db, sse);
  db.prepare("INSERT INTO contacts (id,name,backend,kind,config) VALUES ('codex','codex','codex','dm','{}')").run();
  db.prepare("INSERT INTO contacts (id,name,backend,kind,config) VALUES ('room','room','room','room',?)")
    .run(JSON.stringify({ workflowEnabled: true, governance: 'open', members: ['codex'] }));
  db.prepare("INSERT INTO workers (id,name,token_hash,capabilities) VALUES ('pc-User','PC','test',?)")
    .run(JSON.stringify({ workspaces: ['C:/path/to/project'], runners: ['codex'], shell: true }));
  db.prepare("INSERT INTO workers (id,name,token_hash,capabilities) VALUES ('vps-dev','VPS','test',?)")
    .run(JSON.stringify({ workspaces: ['/srv/ai-dev/jobs'], runners: ['codex', 'opencode'], shell: true }));
  const app = express(); app.use(express.json()); app.use(sessionAuth('test-secret')!);
  app.use('/api', workflowModulesRouter(db, sse, jobs, () => ({}), targets));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    jobs.stopOutOfBandResolver(); db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const login = await fetch(`${base}/api/session`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-secret' }) })
    .then(res => res.json()) as { sessionToken: string };
  const patch = (target: unknown, revision = jobs.workflowModules.revision(), authorized = true) =>
    fetch(`${base}/api/workflow-modules/worker-target`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${login.sessionToken}` } : {}) },
      body: JSON.stringify({ expectedRevision: revision, target }) });

  assert.equal((await patch({ workerId: 'pc-User', workspace: 'C:/path/to/project' }, undefined, false)).status, 401);
  assert.equal((await patch({ workerId: 'vps-dev', workspace: '/srv/ai-dev/other', repoId: 'ai-hub' })).status, 400);
  const saved = await patch({ workerId: 'vps-dev', workspace: '/srv/ai-dev/jobs', repoId: 'ai-hub' });
  assert.equal(saved.status, 200, await saved.clone().text());
  const revision = (await saved.json() as { revision: number }).revision;
  assert.equal((await patch({ workerId: 'pc-User', workspace: 'C:/path/to/project' }, revision - 1)).status, 409);

  const anchor = Number(db.prepare(`INSERT INTO messages (contact_id,sender,role,kind,content,status,meta,origin)
    VALUES ('room','user','user','text','User approved the task','done','{}','main')`).run().lastInsertRowid);
  const store = new RoomTaskStore(db, jobs, null, { projectTargets: targets,
    toolContext: { roomId: 'room', moduleId: 'plan' } });
  const created = store.createTask({ roomId: 'room', taskPath: 'tasks/operator-choice.md', title: 'choice',
    requirements: 'Implement the approved change.', workspace: 'C:/path/to/project',
    anchorMessageId: anchor, actorContact: 'codex', baselineSha: 'a'.repeat(40) });
  assert.ok(!('error' in created), 'model create should accept the operator-selected target');
  if ('error' in created) return;
  assert.equal(created.task.approved_workspace, '/srv/ai-dev/jobs/operator-choice');
  const event = db.prepare("SELECT payload FROM room_task_events WHERE task_id = ? AND kind = 'created'")
    .get(created.task.id) as { payload: string };
  assert.equal(JSON.parse(event.payload).workspaceSource, 'User-worker-default');

  const switched = await patch({ workerId: 'pc-User', workspace: 'C:/path/to/project' }, revision);
  assert.equal(switched.status, 200, await switched.clone().text());
  assert.equal(store.getTask('room', 'tasks/operator-choice.md')?.approved_workspace,
    '/srv/ai-dev/jobs/operator-choice', 'saved default must not move existing tasks');
  const next = store.createTask({ roomId: 'room', taskPath: 'tasks/next-choice.md', title: 'next',
    requirements: 'Inspect the approved change.', workspace: '/srv/ai-dev/jobs/next-choice',
    anchorMessageId: anchor, actorContact: 'codex' });
  assert.ok(!('error' in next));
  if (!('error' in next)) assert.equal(next.task.approved_workspace, 'C:/path/to/project');
});
