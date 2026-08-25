import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { buildDelegateTools } from '../src/agents/gatewayTools.js';
import { openDb } from '../src/db.js';
import { workersRouter } from '../src/routes/workers.js';
import { JobStore } from '../src/workers/jobStore.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-runner-availability-'));
const db = openDb(path.join(dir, 'test.db'));
const sse = { broadcast: () => {} } as any;
const store = new JobStore(db, sse);
let listener: Server | null = null;

try {
  db.prepare(
    `INSERT INTO workers
     (id, name, token_hash, capabilities, status, accepting_jobs, last_seen_at)
     VALUES ('pc-User', 'User PC', 'test', ?, 'online', 1, datetime('now'))`
  ).run(JSON.stringify({ runners: ['codex', 'grok'], workspaces: [dir], shell: true }));

  const unavailable = store.create({
    requestedBy: 'User',
    runner: 'claude',
    workspace: dir,
    prompt: 'runner unavailable at creation',
    permissions: { write: false, shell: false, ssh: false },
  });
  if ('error' in unavailable) throw new Error(unavailable.error);
  assert.equal(unavailable.job.status, 'pending');
  assert.match(unavailable.queueWarning ?? '', /没有在线且接单中的 Worker.*runner=claude/);
  assert.equal(
    (store.messages(unavailable.job.id) as { content: string }[])
      .filter((message) => message.content.includes('runner=claude')).length,
    1,
  );

  store.signalUnservablePendingJobs();
  store.signalUnservablePendingJobs();
  assert.equal(
    (store.messages(unavailable.job.id) as { content: string }[])
      .filter((message) => message.content.includes('runner=claude')).length,
    1,
    'availability warning must be durable and deduplicated',
  );

  const supported = store.create({
    requestedBy: 'User',
    runner: 'codex',
    workspace: dir,
    prompt: 'supported runner',
    permissions: { write: false, shell: true, ssh: false },
  });
  if ('error' in supported) throw new Error(supported.error);
  assert.equal(supported.queueWarning, undefined);

  db.prepare('UPDATE workers SET capabilities = ? WHERE id = ?')
    .run(JSON.stringify({ runners: ['codex', 'claude'], workspaces: [dir], shell: true }), 'pc-User');
  const removedLater = store.create({
    requestedBy: 'User',
    runner: 'claude',
    workspace: dir,
    prompt: 'runner removed after creation',
    permissions: { write: false, shell: false, ssh: false },
  });
  if ('error' in removedLater) throw new Error(removedLater.error);
  assert.equal(removedLater.queueWarning, undefined);

  db.prepare('UPDATE workers SET capabilities = ? WHERE id = ?')
    .run(JSON.stringify({ runners: ['codex', 'grok'], workspaces: [dir], shell: true }), 'pc-User');
  store.signalUnservablePendingJobs();
  assert.match(
    String((store.messages(removedLater.job.id) as { content: string }[]).at(-1)?.content),
    /runner=claude/,
    'dynamic capability removal must annotate an existing pending job',
  );

  db.prepare("INSERT INTO contacts (id, name, backend) VALUES ('aye', 'Aye', 'api')").run();
  const delegate = buildDelegateTools(store, db, 'aye', {
    enabled: true,
    workspaces: [dir],
    allowShell: true,
    maxOpenJobs: 20,
  }).find((tool) => tool.name === 'delegate_to_worker')!;
  const response = await delegate.exec({
    route_class: 'review',
    runner: 'claude',
    runner_override_reason: 'runner availability regression',
    workspace: dir,
    prompt: 'surface queue warning to the delegating agent',
    write: false,
  });
  assert.equal(response.ok, true);
  assert.match(response.text, /⚠ 当前没有在线且接单中的 Worker.*runner=claude/);

  const app = express();
  app.use(express.json());
  app.use('/api', workersRouter(db, sse, store));
  listener = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener!.once('listening', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('missing test listener address');
  const createdResponse = await fetch(`http://127.0.0.1:${address.port}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runner: 'claude',
      workspace: dir,
      prompt: 'surface queue warning to HTTP caller',
      permissions: { write: false, shell: false, ssh: false },
    }),
  });
  assert.equal(createdResponse.status, 201);
  const createdBody = await createdResponse.json() as { id: string; queue_warning?: string };
  assert.match(createdBody.queue_warning ?? '', /runner=claude/);
  const detailResponse = await fetch(`http://127.0.0.1:${address.port}/api/jobs/${createdBody.id}`);
  const detail = await detailResponse.json() as { messages: { content: string }[] };
  assert.equal(
    detail.messages.filter((message) => message.content.includes('runner=claude')).length,
    1,
  );

  console.log('runner availability: PASS');
} finally {
  if (listener) await new Promise<void>((resolve) => listener!.close(() => resolve()));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
