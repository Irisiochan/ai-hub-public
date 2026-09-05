import assert from 'node:assert/strict';
import { createWorkerState, WORKER_RECONCILE_MS } from '../src/workerState.ts';

const job = (id, status = 'running', extra = {}) => ({ id, status, created_at: id, ...extra });
const message = (id, jobId = 'a') => ({ id, job_id: jobId, content: `log ${id}` });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const calls = { workers: 0, jobs: 0, job: 0, profiles: 0 };
  const data = {
    workers: [{ id: 'pc', status: 'online' }], jobs: [job('a')], messages: [message(1)],
    workflow: { active: { id: 'default' }, previous: null, profiles: [] },
  };
  const client = {
    async workers() { calls.workers++; return { workers: [...data.workers] }; },
    async jobs() { calls.jobs++; return { jobs: [...data.jobs] }; },
    async job(id) { calls.job++; return { job: data.jobs.find((row) => row.id === id), messages: [...data.messages] }; },
    async workflowProfiles() { calls.profiles++; return data.workflow; },
  };
  return { calls, data, client, store: createWorkerState(client) };
}

assert.ok(WORKER_RECONCILE_MS >= 60_000, 'fallback must remain low-frequency');

{
  const { store, calls } = fixture();
  await Promise.all([store.refresh(), store.refresh()]);
  assert.deepEqual(calls, { workers: 1, jobs: 1, job: 0, profiles: 1 });
  const closeThread = store.watchJob('a');
  const closePanel = store.watchJob('a');
  await settle();
  assert.equal(calls.job, 1, 'two visible viewers share one detail hydration');
  const jobs = store.getSnapshot().jobs;
  store.applyJobMessage(message(2));
  store.applyJobMessage(message(2));
  assert.deepEqual(store.getSnapshot().messages.a.map((row) => row.id), [1, 2]);
  assert.equal(store.getSnapshot().jobs, jobs, 'log events must not rerender job list subscribers');
  store.applyWorker({ id: 'pc', status: 'busy' });
  store.applyJob(job('a', 'done'));
  assert.equal(store.getSnapshot().workers[0].status, 'busy');
  assert.equal(store.getSnapshot().jobs[0].status, 'done');
  closeThread();
  assert.ok(store.getSnapshot().messages.a, 'one viewer closing must not clear the other viewer');
  closePanel();
  store.applyJobMessage(message(3));
  assert.equal(store.getSnapshot().messages.a, undefined, 'closed job logs must not accumulate in memory');
}

{
  const { store, client } = fixture();
  await store.refresh();
  const snapshot = deferred();
  client.jobs = () => snapshot.promise;
  const refresh = store.refreshJobs();
  store.applyJob(job('a', 'done'));
  store.applyJob(job('b', 'cancelled', { deleted: 1 }));
  store.applyJob(job('c', 'running'));
  snapshot.resolve({ jobs: [job('a'), job('b')] });
  await refresh;
  assert.deepEqual(store.getSnapshot().jobs.map(({ id, status }) => [id, status]), [['c', 'running'], ['a', 'done']],
    'live completion, creation and soft-hide must survive a late list snapshot');
  const workers = deferred();
  client.workers = () => workers.promise;
  const next = store.refresh();
  store.applyWorker({ id: 'pc', status: 'paused' });
  workers.resolve({ workers: [{ id: 'pc', status: 'online' }] });
  await next;
  assert.equal(store.getSnapshot().workers[0].status, 'paused');
}

{
  const { store, client } = fixture();
  const snapshot = deferred();
  client.job = () => snapshot.promise;
  const close = store.watchJob('a');
  store.applyJob(job('a', 'done'));
  store.applyJobMessage(message(2));
  snapshot.resolve({ job: job('a'), messages: [message(1), message(2)] });
  await settle();
  assert.equal(store.getSnapshot().jobs[0].status, 'done', 'a late detail snapshot must not overwrite live completion');
  assert.deepEqual(store.getSnapshot().messages.a.map((row) => row.id), [1, 2]);
  close();
}

{
  const { store, client } = fixture();
  const staleDetail = deferred();
  client.job = () => staleDetail.promise;
  const close = store.watchJob('a');
  await settle();
  client.jobs = async () => ({ jobs: [job('a', 'done', { updated_at: '2026-09-05 12:00:00' })] });
  await store.refreshJobs();
  staleDetail.resolve({ job: job('a', 'running', { updated_at: '2026-09-05 12:00:00' }), messages: [message(1)] });
  await settle();
  assert.equal(store.getSnapshot().jobs[0].status, 'done',
    'an older detail response must not overwrite a newer list snapshot even within the same timestamp second');
  close();

  const staleList = deferred();
  client.jobs = () => staleList.promise;
  const olderList = store.refreshJobs();
  client.job = async () => ({ job: job('a', 'paused'), messages: [] });
  await store.refreshJob('a');
  staleList.resolve({ jobs: [job('a', 'running')] });
  await olderList;
  assert.equal(store.getSnapshot().jobs[0].status, 'paused', 'a newer detail also wins over an older list response');
}

{
  const { store, client } = fixture();
  const staleDetail = deferred();
  client.job = () => staleDetail.promise;
  const close = store.watchJob('a');
  await settle();
  client.jobs = async () => ({ jobs: [] });
  await store.refreshJobs();
  staleDetail.resolve({ job: job('a'), messages: [] });
  await settle();
  assert.deepEqual(store.getSnapshot().jobs, [], 'an older detail cannot resurrect a job absent from a newer snapshot');
  close();
}

{
  const { store, client } = fixture();
  const close = store.watchJob('a');
  await settle();
  for (let id = 2; id <= 450; id++) store.applyJobMessage(message(id));
  assert.equal(store.getSnapshot().messages.a.length, 200, 'live logs must preserve the existing 200-row window');
  assert.deepEqual(store.getSnapshot().messages.a.map((row) => row.id), Array.from({ length: 200 }, (_, i) => 251 + i));
  client.job = async () => ({ job: job('a'), messages: Array.from({ length: 251 }, (_, i) => message(200 + i)).reverse() });
  await store.refreshJob('a');
  assert.deepEqual(store.getSnapshot().messages.a.map((row) => row.id), Array.from({ length: 200 }, (_, i) => 251 + i),
    'HTTP recovery merges, deduplicates, sorts and bounds the same latest-log window');
  close();
}

{
  const { store, data, calls } = fixture();
  await store.refresh();
  const close = store.watchJob('a');
  await settle();
  data.jobs = [job('a', 'done')];
  data.messages.push(message(2));
  data.workers = [{ id: 'pc', status: 'offline' }];
  const first = store.reconcile();
  const second = store.reconcile();
  assert.equal(first, second, 'concurrent recovery callers share one authoritative reconciliation');
  await first;
  assert.equal(store.getSnapshot().jobs[0].status, 'done');
  assert.equal(store.getSnapshot().workers[0].status, 'offline');
  assert.deepEqual(store.getSnapshot().messages.a.map((row) => row.id), [1, 2], 'recovery fills missed log events');
  assert.deepEqual(calls, { workers: 2, jobs: 2, job: 2, profiles: 2 });
  close();
}

{
  const { store, client } = fixture();
  const stale = deferred();
  client.jobs = () => stale.promise;
  const initial = store.refreshJobs();
  await settle();
  const recovery = store.reconcile();
  client.jobs = async () => ({ jobs: [job('a', 'done')] });
  stale.resolve({ jobs: [job('a')] });
  await Promise.all([initial, recovery]);
  assert.equal(store.getSnapshot().jobs[0].status, 'done', 'recovery must wait for older requests then fetch fresh state');
}

{
  const { store, client } = fixture();
  await store.refresh();
  const beforeMutation = deferred();
  client.jobs = () => beforeMutation.promise;
  const first = store.reconcile();
  await settle();
  client.jobs = async () => ({ jobs: [job('a', 'done')] });
  const afterMutation = store.reconcile();
  beforeMutation.resolve({ jobs: [job('a')] });
  await Promise.all([first, afterMutation]);
  assert.equal(store.getSnapshot().jobs[0].status, 'done',
    'a mutation or reconnect during reconciliation requires one trailing snapshot');
}

{
  const { store, client } = fixture();
  await store.refresh();
  client.jobs = async () => { throw new Error('missing or invalid session token'); };
  await assert.rejects(store.refreshJobs(), /invalid session token/);
  assert.equal(store.getSnapshot().errors.jobs, 'missing or invalid session token');
  assert.equal(store.getSnapshot().jobs.length, 1, 'permission/network failures must not pretend the queue is empty');
  client.jobs = async () => ({ jobs: [] });
  await store.refreshJobs();
  assert.equal(store.getSnapshot().errors.jobs, '');
  assert.equal(store.getSnapshot().jobs.length, 0, 'a successful snapshot remains authoritative for removal');
  client.job = async () => { throw new Error('job not found'); };
  const close = store.watchJob('a');
  await settle();
  assert.equal(store.getSnapshot().errors['job:a'], 'job not found');
  close();
}

{
  const { store, client } = fixture();
  const old = deferred();
  client.job = () => old.promise;
  const close = store.watchJob('a');
  await settle();
  close();
  client.job = async () => ({ job: job('a', 'done'), messages: [message(2)] });
  const closeAgain = store.watchJob('a');
  await settle();
  old.resolve({ job: job('a'), messages: [message(1)] });
  await settle();
  assert.equal(store.getSnapshot().jobs[0].status, 'done');
  assert.deepEqual(store.getSnapshot().messages.a.map((row) => row.id), [2], 'a closed viewer cannot inject late logs after reopening');
  closeAgain();

  const stale = deferred();
  client.jobs = () => stale.promise;
  const refresh = store.refreshJobs();
  store.reset();
  stale.resolve({ jobs: [job('old-session')] });
  await refresh;
  assert.deepEqual(store.getSnapshot().jobs, [], 'sign-out/reset must invalidate outstanding reads');
}

console.log('shared worker state and recovery checks passed');
