import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { DeployReceiptPoller } from '../src/workers/deployReceipt.js';
import { JobStore } from '../src/workers/jobStore.js';

test('a deploy receipt promotes jobs whose delivered commit is an ancestor', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-deploy-receipt-'));
  const repo = path.join(dir, 'repo');
  const receiptFile = path.join(dir, 'deploy-receipt.json');
  fs.mkdirSync(repo);
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'a'], { cwd: repo });
  const deliveredHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  execFileSync('git', ['add', 'b.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'b'], { cwd: repo });
  const deployedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

  const db = openDb(path.join(dir, 'test.db'));
  const store = new JobStore(db, { broadcast: () => {} } as any);
  const created = store.create({
    requestedBy: 'codex',
    runner: 'codex',
    workspace: repo,
    prompt: 'ship it',
    permissions: { write: true, shell: true, ssh: false },
  });
  assert.ok('job' in created);
  db.prepare(
    `UPDATE jobs SET status = 'done', delivery_state = 'delivered', delivery_meta = ? WHERE id = ?`
  ).run(JSON.stringify({ state: 'delivered', changed: true, head: deliveredHead, ahead: 0 }), created.job.id);

  fs.writeFileSync(receiptFile, JSON.stringify({
    deployId: 'deploy-test',
    commit: deployedCommit,
    deployedAt: '2026-08-01T08:00:00.000Z',
    reachableCommits: [deployedCommit, deliveredHead],
  }));
  const events: Record<string, unknown>[] = [];
  const poller = new DeployReceiptPoller(store, (_message, meta) => events.push(meta ?? {}), receiptFile);
  const promoted = await poller.poll();
  assert.deepEqual(promoted, [created.job.id]);
  const updated = store.get(created.job.id)!;
  const meta = JSON.parse(updated.delivery_meta ?? '{}');
  assert.equal(meta.declared.stage, 'online_waiting_validation');
  assert.equal(meta.deployment.commit, deployedCommit);
  assert.equal(meta.deployment.source, 'one-click-deploy');
  assert.ok(events.some((event) => Array.isArray(event.promoted)));

  assert.deepEqual(await poller.poll(), [], 'same receipt is idempotent within a process');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
