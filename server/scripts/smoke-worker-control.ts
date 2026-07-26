/**
 * Smoke test: PC Worker manual pause/resume and per-boot auto reset.
 * Run with: npx tsx scripts/smoke-worker-control.ts
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-worker-control-'));
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
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `${response.status}`);
  return body;
}

try {
  const paired = await call('/workers', {
    method: 'POST', body: JSON.stringify({ id: 'my-pc', name: 'My PC' }),
  });
  const auth = { Authorization: `Bearer ${paired.token}` };
  const capabilities = {
    runners: ['codex'],
    workspaces: [dir],
    shell: true,
    ssh: false,
    maxConcurrent: 2,
    protocolVersion: 2,
  };

  let connected = await call('/worker/connect', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ bootId: 'boot-a', capabilities }),
  });
  check('首次开机自动接单', connected.worker.acceptingJobs === true && connected.worker.status === 'online');

  let controlled = await call('/workers/my-pc/control', {
    method: 'POST', body: JSON.stringify({ enabled: false }),
  });
  check('手动关闭进入暂停', controlled.acceptingJobs === false && controlled.status === 'paused');

  connected = await call('/worker/connect', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ bootId: 'boot-a', capabilities }),
  });
  check('同次开机重连仍暂停', connected.worker.acceptingJobs === false && connected.worker.status === 'paused');

  const created = jobs.create({
    requestedBy: 'user', runner: 'codex', workspace: dir, prompt: 'smoke',
    permissions: { write: true, shell: true },
  });
  if ('error' in created) throw new Error(created.error);
  const pausedClaim = await call('/worker/claim?wait=0', { headers: auth });
  check('暂停时不认领任务', pausedClaim.job === null && pausedClaim.acceptingJobs === false);
  check('暂停任务仍在队列', jobs.get(created.job.id)?.status === 'pending');

  connected = await call('/worker/connect', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ bootId: 'boot-b', capabilities }),
  });
  check('新开机自动恢复接单', connected.worker.acceptingJobs === true && connected.worker.status === 'online');

  const resumedClaim = await call('/worker/claim?wait=0', { headers: auth });
  check('恢复后可以认领原任务', resumedClaim.job?.id === created.job.id && resumedClaim.acceptingJobs === true);
  check(
    'claim 下发 protocol v2 与服务端交付契约',
    resumedClaim.protocolVersion === 2
      && typeof resumedClaim.deliveryContract === 'string'
      && resumedClaim.deliveryContract.includes('standalone JSON line')
  );

  await call(`/worker/jobs/${created.job.id}/start`, {
    method: 'POST', headers: auth, body: '{}',
  });
  await call(`/worker/jobs/${created.job.id}/complete`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      status: 'blocked',
      result: 'commit 尚未推送',
      delivery: { state: 'blocked_unpushed', head: 'abc1234', ahead: 1, dirtyFiles: [] },
    }),
  });
  const candidates = await call('/worker/reconcile', { headers: auth });
  check(
    '交付阻塞任务进入自动回写候选',
    candidates.jobs.length === 1 && candidates.jobs[0].id === created.job.id
  );

  let weakEvidenceRejected = false;
  try {
    await call(`/worker/jobs/${created.job.id}/reconcile`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        head: 'def5678',
        evidence: { dirty: false, ahead: 1, ancestorIncluded: true },
      }),
    });
  } catch {
    weakEvidenceRejected = true;
  }
  check('未推送证据不能回写完成', weakEvidenceRejected && jobs.get(created.job.id)?.status === 'blocked');

  let mismatchedEvidenceRejected = false;
  try {
    await call(`/worker/jobs/${created.job.id}/reconcile`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        head: 'def5678',
        evidence: {
          dirty: false,
          ahead: 0,
          ancestorIncluded: true,
          blockedHead: 'wrong123',
        },
      }),
    });
  } catch {
    mismatchedEvidenceRejected = true;
  }
  check('不匹配原交付的证据不能回写完成', mismatchedEvidenceRejected);

  const reconciled = await call(`/worker/jobs/${created.job.id}/reconcile`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      head: 'def5678',
      evidence: {
        dirty: false,
        ahead: 0,
        ancestorIncluded: true,
        blockedHead: 'abc1234',
      },
    }),
  });
  check('可信 Git 证据自动回写 done', reconciled.status === 'done' && jobs.get(created.job.id)?.status === 'done');
  check(
    '自动回写留下审计消息',
    jobs.messages(created.job.id).some((message) => message.content.includes('外部续接已自动确认完成'))
  );

  const staleCreated = jobs.create({
    requestedBy: 'user', runner: 'codex', workspace: dir, prompt: 'stale fallback smoke',
    permissions: { write: true, shell: true },
  });
  if ('error' in staleCreated) throw new Error(staleCreated.error);
  const staleClaim = await call('/worker/claim?wait=0', { headers: auth });
  check('自愈测试任务已认领', staleClaim.job?.id === staleCreated.job.id);
  await call(`/worker/jobs/${staleCreated.job.id}/start`, {
    method: 'POST', headers: auth, body: '{}',
  });
  await call(`/worker/jobs/${staleCreated.job.id}/complete`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      status: 'blocked',
      result: '本地变化等待托管同步',
      delivery: { state: 'blocked_local_changes', head: 'aaa1234', ahead: 0, dirtyFiles: ['session.json'] },
    }),
  });

  let freshFallbackRejected = false;
  try {
    await call(`/worker/jobs/${staleCreated.job.id}/reconcile`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        head: 'bbb5678',
        evidence: {
          dirty: false,
          ahead: 0,
          ancestorIncluded: false,
          staleFallback: true,
          blockedHead: 'aaa1234',
        },
      }),
    });
  } catch {
    freshFallbackRejected = true;
  }
  check('未满 10 分钟不能走 clean timeout 自愈', freshFallbackRejected);

  db.prepare("UPDATE jobs SET updated_at = datetime('now', '-11 minutes') WHERE id = ?")
    .run(staleCreated.job.id);
  const staleReconciled = await call(`/worker/jobs/${staleCreated.job.id}/reconcile`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      head: 'bbb5678',
      evidence: {
        dirty: false,
        ahead: 0,
        ancestorIncluded: false,
        staleFallback: true,
        blockedHead: 'aaa1234',
      },
    }),
  });
  const staleDelivery = JSON.parse(jobs.get(staleCreated.job.id)?.delivery_meta ?? '{}');
  check(
    '满 10 分钟后 clean + ahead=0 可自愈',
    staleReconciled.status === 'done'
      && jobs.get(staleCreated.job.id)?.status === 'done'
      && staleDelivery.reconciliation?.mode === 'clean-timeout-fallback'
  );

  const workspaceA = path.join(dir, 'workspace-a');
  const workspaceB = path.join(dir, 'workspace-b');
  fs.mkdirSync(workspaceA);
  fs.mkdirSync(workspaceB);
  const parallelA = jobs.create({
    requestedBy: 'user', runner: 'codex', workspace: workspaceA, prompt: 'parallel a',
    priority: 10, permissions: { write: true, shell: true, ssh: false },
  });
  const sameWorkspace = jobs.create({
    requestedBy: 'user', runner: 'codex', workspace: workspaceA, prompt: 'parallel same workspace',
    priority: 9, permissions: { write: true, shell: true, ssh: false },
  });
  const parallelB = jobs.create({
    requestedBy: 'user', runner: 'codex', workspace: workspaceB, prompt: 'parallel b',
    priority: 8, permissions: { write: true, shell: true, ssh: false },
  });
  if ('error' in parallelA || 'error' in sameWorkspace || 'error' in parallelB) {
    throw new Error('parallel smoke setup failed');
  }
  const claimA = await call('/worker/claim?wait=0', { headers: auth });
  const claimB = await call('/worker/claim?wait=0', { headers: auth });
  const claimAtCapacity = await call('/worker/claim?wait=0', { headers: auth });
  check('并发第一单按优先级认领', claimA.job?.id === parallelA.job.id);
  check('同 workspace 被锁时可认领另一 workspace', claimB.job?.id === parallelB.job.id);
  check('达到 maxConcurrent 后不再认领', claimAtCapacity.job === null);
  check('同 workspace 第二单保持 pending', jobs.get(sameWorkspace.job.id)?.status === 'pending');

  for (const activeJob of [parallelA.job, parallelB.job]) {
    await call(`/worker/jobs/${activeJob.id}/start`, {
      method: 'POST', headers: auth, body: '{}',
    });
  }
  await call(`/worker/jobs/${parallelA.job.id}/complete`, {
    method: 'POST', headers: auth, body: JSON.stringify({ status: 'done', result: 'a done' }),
  });
  const workerWhileBusy = (await call('/workers')).workers.find((item: any) => item.id === 'my-pc');
  check('一单完成但另一单运行时 worker 仍为 busy', workerWhileBusy?.status === 'busy');
  await call(`/worker/jobs/${parallelB.job.id}/complete`, {
    method: 'POST', headers: auth, body: JSON.stringify({ status: 'done', result: 'b done' }),
  });
  const sameWorkspaceClaim = await call('/worker/claim?wait=0', { headers: auth });
  check('workspace 锁释放后第二单可认领', sameWorkspaceClaim.job?.id === sameWorkspace.job.id);
  await call(`/worker/jobs/${sameWorkspace.job.id}/start`, {
    method: 'POST', headers: auth, body: '{}',
  });
  await call(`/worker/jobs/${sameWorkspace.job.id}/complete`, {
    method: 'POST', headers: auth, body: JSON.stringify({ status: 'done', result: 'same done' }),
  });

  const recoveryCreated = jobs.create({
    requestedBy: 'user', runner: 'codex', workspace: workspaceA, prompt: 'recover me',
    permissions: { write: true, shell: true, ssh: false },
  });
  if ('error' in recoveryCreated) throw new Error(recoveryCreated.error);
  await call('/worker/claim?wait=0', { headers: auth });
  await call(`/worker/jobs/${recoveryCreated.job.id}/start`, {
    method: 'POST', headers: auth, body: '{}',
  });
  db.prepare("UPDATE jobs SET lease_until = datetime('now', '-1 second') WHERE id = ?")
    .run(recoveryCreated.job.id);
  jobs.reap();
  check('租约失联先进入 recovering 而非立即 interrupted', jobs.get(recoveryCreated.job.id)?.status === 'recovering');
  const recovered = await call(`/worker/jobs/${recoveryCreated.job.id}/recover`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ mode: 'resume', sessionId: 'thread_123' }),
  });
  check(
    '显式恢复握手重置 running 与 session',
    recovered.status === 'running'
      && jobs.get(recoveryCreated.job.id)?.status === 'running'
      && jobs.get(recoveryCreated.job.id)?.session_id === 'thread_123'
  );
  await call(`/worker/jobs/${recoveryCreated.job.id}/complete`, {
    method: 'POST', headers: auth, body: JSON.stringify({ status: 'done', result: 'recovered' }),
  });

  const expiryCreated = jobs.create({
    requestedBy: 'user', runner: 'codex', workspace: workspaceB, prompt: 'expire recovery',
    permissions: { write: true, shell: true, ssh: false },
  });
  if ('error' in expiryCreated) throw new Error(expiryCreated.error);
  await call('/worker/claim?wait=0', { headers: auth });
  await call(`/worker/jobs/${expiryCreated.job.id}/start`, {
    method: 'POST', headers: auth, body: '{}',
  });
  db.prepare("UPDATE jobs SET lease_until = datetime('now', '-1 second') WHERE id = ?")
    .run(expiryCreated.job.id);
  jobs.reap();
  db.prepare("UPDATE jobs SET lease_until = datetime('now', '-1 second') WHERE id = ?")
    .run(expiryCreated.job.id);
  jobs.reap();
  check('恢复窗口耗尽后才进入 interrupted', jobs.get(expiryCreated.job.id)?.status === 'interrupted');
} finally {
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
