/**
 * Smoke test: soft-hide PC worker task windows (presentation delete).
 * Run with: npx tsx scripts/smoke-job-window-delete.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../src/db.js';
import { workersRouter } from '../src/routes/workers.js';
import { JobStore } from '../src/workers/jobStore.js';

let failures = 0;
function check(label: string, condition: boolean, detail = '') {
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${condition ? '' : `  ${detail}`}`);
  if (!condition) failures++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-job-hide-'));
const db = openDb(path.join(dir, 'test.db'));
const sse = { broadcast: () => {} } as any;
const jobs = new JobStore(db, sse);
const app = express();
app.use(express.json());
app.use('/api', workersRouter(db, sse, jobs));
const listener = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => listener.once('listening', resolve));
const address = listener.address();
if (!address || typeof address === 'string') throw new Error('missing test listener address');
const base = `http://127.0.0.1:${address.port}/api`;

async function call(url: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

try {
  const doneJob = jobs.create({
    requestedBy: 'iris',
    runner: 'claude',
    workspace: dir,
    prompt: 'finished work',
    permissions: { write: true, shell: false, ssh: false },
    originContactId: 'cheng',
    originAnchorId: 1,
  });
  if ('error' in doneJob) throw new Error(doneJob.error);
  db.prepare(`UPDATE jobs SET status = 'done', result = 'ok', updated_at = datetime('now') WHERE id = ?`)
    .run(doneJob.job.id);

  const runningJob = jobs.create({
    requestedBy: 'iris',
    runner: 'claude',
    workspace: dir,
    prompt: 'still running',
    permissions: { write: true, shell: false, ssh: false },
    originContactId: 'cheng',
    originAnchorId: 2,
  });
  if ('error' in runningJob) throw new Error(runningJob.error);
  db.prepare(
    `UPDATE jobs SET status = 'running', worker_id = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(runningJob.job.id);

  const pendingJob = jobs.create({
    requestedBy: 'iris',
    runner: 'claude',
    workspace: dir,
    prompt: 'queued',
    permissions: { write: true, shell: false, ssh: false },
  });
  if ('error' in pendingJob) throw new Error(pendingJob.error);

  const listed = await call('/jobs');
  check(
    '列表含三条未隐藏任务',
    listed.status === 200 && listed.body.jobs?.length === 3,
    `status=${listed.status} n=${listed.body.jobs?.length}`
  );

  const hideDone = await call(`/jobs/${doneJob.job.id}`, {
    method: 'DELETE',
    body: JSON.stringify({}),
  });
  check('终态任务可软删', hideDone.status === 200 && hideDone.body.ok === true);
  check(
    '软删后 deleted=1 行仍在',
    (db.prepare('SELECT deleted FROM jobs WHERE id = ?').get(doneJob.job.id) as { deleted: number })
      .deleted === 1
  );
  check(
    '软删写审计日志',
    jobs.messages(doneJob.job.id).some((m: any) => String(m.content).includes('window hidden'))
  );

  const listAfterDone = await call('/jobs');
  check(
    '列表不再出现已隐藏终态任务',
    listAfterDone.body.jobs?.every((j: any) => j.id !== doneJob.job.id) === true
  );
  const getHidden = await call(`/jobs/${doneJob.job.id}`);
  check('GET 已隐藏任务 404', getHidden.status === 404);

  const hideRunningBlocked = await call(`/jobs/${runningJob.job.id}`, {
    method: 'DELETE',
    body: JSON.stringify({}),
  });
  check(
    '运行中无 force 被 409 拒绝',
    hideRunningBlocked.status === 409,
    `status=${hideRunningBlocked.status} err=${hideRunningBlocked.body.error}`
  );
  check(
    '拒绝后仍未软删',
    (db.prepare('SELECT deleted FROM jobs WHERE id = ?').get(runningJob.job.id) as { deleted: number })
      .deleted === 0
  );

  const hideRunningForce = await call(`/jobs/${runningJob.job.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ force: true }),
  });
  check('运行中 force 可隐藏窗口', hideRunningForce.status === 200 && hideRunningForce.body.ok === true);
  check(
    'force 隐藏后 status 仍为 running（后台可继续）',
    (db.prepare('SELECT status, deleted FROM jobs WHERE id = ?').get(runningJob.job.id) as {
      status: string;
      deleted: number;
    }).status === 'running' &&
      (db.prepare('SELECT deleted FROM jobs WHERE id = ?').get(runningJob.job.id) as { deleted: number })
        .deleted === 1
  );

  const hidePending = await call(`/jobs/${pendingJob.job.id}?force=true`, { method: 'DELETE' });
  check('pending force 可隐藏', hidePending.status === 200);
  const pendingRow = db.prepare('SELECT status, deleted FROM jobs WHERE id = ?').get(pendingJob.job.id) as {
    status: string;
    deleted: number;
  };
  check(
    'pending 隐藏时自动 cancelled 防认领',
    pendingRow.deleted === 1 && pendingRow.status === 'cancelled',
    `status=${pendingRow.status} deleted=${pendingRow.deleted}`
  );

  const claimAfter = await call('/worker/claim?wait=0', {
    headers: { Authorization: 'Bearer missing.token' },
  });
  check('无 token 认领仍 401（路由存活）', claimAfter.status === 401);

  const listFinal = await call('/jobs');
  check('全部隐藏后列表为空', listFinal.status === 200 && listFinal.body.jobs?.length === 0);

  // 确认消息表不受影响：jobs 软删不是 messages 删除
  db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind) VALUES ('c1','C','🤖','#888','api','dm')`
  ).run();
  db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content) VALUES ('c1','user','user','text','hello')`
  ).run();
  const msgCount = (
    db.prepare('SELECT COUNT(*) AS c FROM messages WHERE deleted = 0').get() as { c: number }
  ).c;
  check('软删 job 不触碰 messages', msgCount === 1);
} finally {
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve()))
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
