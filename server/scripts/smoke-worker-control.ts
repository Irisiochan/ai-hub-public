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
    method: 'POST', body: JSON.stringify({ id: 'my-pc', name: 'User PC' }),
  });
  const auth = { Authorization: `Bearer ${paired.token}` };
  const capabilities = { runners: ['codex'], workspaces: [dir], shell: true, ssh: false };

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
    requestedBy: 'User', runner: 'codex', workspace: dir, prompt: 'smoke',
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
} finally {
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
