import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb, type Db } from '../src/db.js';
import { vaultTasksRouter } from '../src/routes/vaultTasks.js';

async function listen(db: Db, tasksDir: string | null) {
  const app = express();
  app.use(express.json());
  app.use('/api/vault', vaultTasksRouter({ db, tasksDir }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    endpoint: `http://127.0.0.1:${address.port}/api/vault/task-status`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    ),
  };
}

function writeTask(tasksDir: string, slug: string, status = 'open'): void {
  fs.writeFileSync(
    path.join(tasksDir, `${slug}.md`),
    `---\ntype: task\nstatus: ${status}\n---\n\n# ${slug}\n`,
    'utf8',
  );
}

function body(pathValue: string, note = '真实验收通过'): string {
  return JSON.stringify({ path: pathValue, status: 'done', note });
}

function insertJob(db: Db, id: string, status: string, taskPath: string): void {
  db.prepare(
    `INSERT INTO jobs (
       id, runner, workspace, prompt, status, idempotency_key, permissions, options
     ) VALUES (?, 'codex', 'C:/ai-hub-codex', 'fixture', ?, ?, '{}', ?)`
  ).run(id, status, `fixture:${id}`, JSON.stringify({ taskPath }));
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-vault-tasks-'));
const tasksDir = path.join(tempDir, 'tasks');
fs.mkdirSync(tasksDir);
const db = openDb(path.join(tempDir, 'hub.db'));
const fixture = await listen(db, tasksDir);

try {
  writeTask(tasksDir, 'demo');
  const response = await fetch(fixture.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body('tasks/demo.md'),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    path: 'tasks/demo.md',
    status: 'done',
    queued: true,
  });
  assert.deepEqual(
    db.prepare('SELECT task_id, source_path, status, version FROM work_items WHERE task_id = ?')
      .get('demo'),
    { task_id: 'demo', source_path: 'tasks/demo.md', status: 'done', version: 2 },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM task_events WHERE task_id = ? AND kind = 'status_transitioned'")
      .get('demo').count,
    1,
  );
  const outbox = db.prepare('SELECT status, payload FROM task_outbox WHERE task_id = ?').get('demo') as {
    status: string;
    payload: string;
  };
  assert.equal(outbox.status, 'pending');
  assert.deepEqual(JSON.parse(outbox.payload), {
    eventId: JSON.parse(outbox.payload).eventId,
    expectedSourceVersion: 1,
    nextStatus: 'done',
    path: 'tasks/demo.md',
    note: '真实验收通过',
    source: 'User',
    taskId: 'demo',
    taskVersion: 2,
  });

  const duplicate = await fetch(fixture.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body('tasks/demo.md'),
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json() as { alreadyDone?: boolean }).alreadyDone, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?').get('demo').count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_outbox WHERE task_id = ?').get('demo').count, 1);

  const tail = await fetch(fixture.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body('tasks/worker-tail-demo.md', '不要误关尾巴'),
  });
  assert.equal(tail.status, 409);

  writeTask(tasksDir, 'closed', 'done');
  const closed = await fetch(fixture.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body('tasks/closed.md'),
  });
  assert.equal(closed.status, 200);
  assert.equal((await closed.json() as { alreadyDone?: boolean }).alreadyDone, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_outbox WHERE task_id = ?').get('closed').count, 0);

  const archived = await fetch(fixture.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body('tasks/archived.md'),
  });
  assert.equal(archived.status, 200);
  assert.equal((await archived.json() as { alreadyDone?: boolean }).alreadyDone, true);

  writeTask(tasksDir, 'live-job');
  insertJob(db, 'live-job-id', 'running', 'tasks/live-job.md');
  const guarded = await fetch(fixture.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body('tasks/live-job.md'),
  });
  assert.equal(guarded.status, 409);
  assert.match((await guarded.json() as { error: string }).error, /先处理该 job/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM work_items WHERE task_id = ?').get('live-job').count, 0);

  writeTask(tasksDir, 'terminal-job');
  insertJob(db, 'terminal-job-id', 'done', 'tasks/terminal-job.md');
  const allowed = await fetch(fixture.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body('tasks/terminal-job.md'),
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json() as { queued?: boolean }).queued, true);

  const unconfigured = await listen(db, null);
  try {
    const unavailable = await fetch(unconfigured.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body('tasks/demo.md'),
    });
    assert.equal(unavailable.status, 503);
    assert.match((await unavailable.json() as { error: string }).error, /MEMORY_VAULT_REPO/);
  } finally {
    await unconfigured.close();
  }

  console.log('vault task status HTTP checks passed');
} finally {
  await fixture.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
