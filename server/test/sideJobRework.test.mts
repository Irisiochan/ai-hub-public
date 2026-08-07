import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../src/db.js';
import { workersRouter } from '../src/routes/workers.js';
import { SseHub } from '../src/sse.js';
import { JobStore } from '../src/workers/jobStore.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-side-rework-'));
const db = openDb(path.join(tempDir, 'test.sqlite'));
const sse = new SseHub();
const jobs = new JobStore(db, sse);
const app = express();
app.use(express.json());
app.use('/api', workersRouter(db, sse, jobs));
const server = http.createServer(app);

try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}/api/jobs`;
  const payload = {
    runner: 'codex',
    workspace: 'C:/path/to/project',
    prompt: '返工：保留原任务和本次回执',
    requestedBy: 'codex',
    originContactId: 'codex',
    originAnchorId: 42,
    idempotencyKey: 'rework-original-job-42',
    permissions: { write: true, shell: true, ssh: false },
  };

  const first = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 201);
  const created = await first.json() as Record<string, unknown>;
  assert.equal(created.requested_by, 'codex');
  assert.equal(created.origin_contact_id, 'codex');
  assert.equal(created.origin_anchor_id, 42);

  const duplicate = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'duplicate idempotency key' });

  db.prepare(
    `UPDATE jobs SET status = 'done', delivery_state = 'delivered',
     delivery_meta = ? WHERE id = ?`
  ).run(JSON.stringify({
    declared: {
      stage: 'user_decision',
      blocker: 'awaiting_exact_target_approval',
      needsUserDecision: true,
    },
  }), created.id);
  const deliveryUpdate = await fetch(`${endpoint}/${created.id}/delivery`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stage: 'closed_loop',
      summary: '人工验收完成。',
      nextOwner: '无需后续动作',
    }),
  });
  assert.equal(deliveryUpdate.status, 200);
  const updated = await deliveryUpdate.json() as any;
  assert.equal(updated.job.delivery_summary.state, 'closed_loop');
  assert.equal(updated.job.delivery_meta.declared.blocker, undefined);
  assert.equal(updated.job.delivery_meta.declared.needsUserDecision, undefined);
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
  sse.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('side worker rework HTTP idempotency checks passed');
