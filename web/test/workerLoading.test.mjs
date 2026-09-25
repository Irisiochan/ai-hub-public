import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkerState } from '../src/jobs/workerState.ts';

const root = path.resolve(import.meta.dirname, '..');
const panel = fs.readFileSync(path.join(root, 'src/jobs/WorkerPanel.tsx'), 'utf8');
const storeSource = fs.readFileSync(path.join(root, 'src/jobs/workerState.ts'), 'utf8');
const apiSource = fs.readFileSync(path.join(root, 'src/platform/api.ts'), 'utf8');
const hookSource = fs.readFileSync(path.join(root, 'src/jobs/useWorkerState.ts'), 'utf8');

const job = (id, status = 'running') => ({ id, status, created_at: id });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

// 慢网：请求未完成时 loading 置位、loaded 为假，成功后才翻转。
{
  const gate = deferred();
  const client = {
    async workers() { return { workers: [] }; },
    async jobs() { return gate.promise; },
    async job() { return { job: job('a'), messages: [] }; },
    async workflowProfiles() { return { active: { id: 'd' } }; },
  };
  const store = createWorkerState(client);
  assert.equal(store.getSnapshot().loaded.jobs ?? false, false, 'jobs must not read as loaded before any snapshot');
  const pending = store.refreshJobs();
  await settle();
  assert.equal(store.getSnapshot().loading.jobs, true, 'slow list request must expose loading');
  assert.equal(store.getSnapshot().loaded.jobs ?? false, false, 'slow list must not read as loaded while pending');
  gate.resolve({ jobs: [job('a')] });
  await pending;
  assert.equal(store.getSnapshot().loading.jobs, false, 'loading must clear after the snapshot lands');
  assert.equal(store.getSnapshot().loaded.jobs, true, 'first success must mark the list loaded');
  assert.equal(store.getSnapshot().jobs.length, 1, 'history jobs must survive the slow first snapshot');
}

// 失败空态：无 last-good 时失败不清 loaded、不伪装成空队列；重试成功后错误清零。
{
  const client = {
    async workers() { return { workers: [] }; },
    async jobs() { throw new Error('network down'); },
    async job() { return { job: job('a'), messages: [] }; },
    async workflowProfiles() { return { active: { id: 'd' } }; },
  };
  const store = createWorkerState(client);
  await assert.rejects(store.refreshJobs(), /network down/);
  assert.equal(store.getSnapshot().loading.jobs, false, 'failed request must clear loading');
  assert.equal(store.getSnapshot().loaded.jobs ?? false, false, 'a failed read must not mark the list loaded');
  assert.equal(store.getSnapshot().errors.jobs, 'network down');
  assert.deepEqual(store.getSnapshot().jobs, [], 'store keeps the (empty) last-good without claiming success');
  client.jobs = async () => ({ jobs: [] });
  await store.refreshJobs();
  assert.equal(store.getSnapshot().errors.jobs, '');
  assert.equal(store.getSnapshot().loaded.jobs, true, 'retry success marks loaded; only then is empty authoritative');
}

// 失败 stale：有 last-good 时失败保留历史，成功快照仍可覆盖。
{
  const client = {
    async workers() { return { workers: [] }; },
    async jobs() { return { jobs: [job('a', 'done')] }; },
    async job() { return { job: job('a'), messages: [] }; },
    async workflowProfiles() { return { active: { id: 'd' } }; },
  };
  const store = createWorkerState(client);
  await store.refreshJobs();
  client.jobs = async () => { throw new Error('gateway jitter'); };
  await assert.rejects(store.refreshJobs(), /gateway jitter/);
  assert.equal(store.getSnapshot().jobs[0].status, 'done', 'short failure must keep last-good history');
  assert.match(store.getSnapshot().errors.jobs, /jitter/);
}

// MUST2：旧请求的 finally 不能清掉新请求的 loading。
// 第一条 job 读未结束时卸载并开始第二条读，第一条先结束后 loading 仍为 true，
// 第二条结束后才变 false，且只有新读的数据落库。
{
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const client = {
    async workers() { return { workers: [] }; },
    async jobs() { return { jobs: [] }; },
    async job() {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    },
    async workflowProfiles() { return { active: { id: 'd' } }; },
  };
  const store = createWorkerState(client);
  const closeFirst = store.watchJob('a');
  await settle();
  assert.equal(store.getSnapshot().loading['job:a'], true, 'first job read must expose loading');
  closeFirst();
  const closeSecond = store.watchJob('a');
  await settle();
  assert.equal(store.getSnapshot().loading['job:a'], true, 'second job read must expose loading');
  first.resolve({ job: job('a', 'running'), messages: [] });
  await settle();
  await settle();
  assert.equal(store.getSnapshot().loading['job:a'], true, 'stale first read must not clear the second read loading');
  second.resolve({ job: job('a', 'done'), messages: [] });
  await settle();
  await settle();
  assert.equal(store.getSnapshot().loading['job:a'], false, 'loading clears only after the current read finishes');
  assert.equal(store.getSnapshot().jobs[0].status, 'done', 'only the new read may land');
  closeSecond();
}

// MUST1：15s 超时只能包住 PC Worker 读请求。
// req 默认不启用超时；只有 workers / jobs / job 显式传入；调用方 signal 必须与超时合并。
assert.doesNotMatch(apiSource, /timeoutMs\s*=\s*API_REQUEST_TIMEOUT_MS/, 'req must not default to the 15s timeout');
assert.match(apiSource, /timeoutMs\?: number/, 'req timeout must be opt-in, not a 15000 default');
assert.match(apiSource, /timeoutMs > 0/, 'missing or zero timeout must skip the abort timer');
assert.match(apiSource, /'\/api\/workers', undefined, API_REQUEST_TIMEOUT_MS/, 'workers read must carry the explicit 15s timeout');
assert.match(apiSource, /'\/api\/jobs', undefined, API_REQUEST_TIMEOUT_MS/, 'jobs read must carry the explicit 15s timeout');
assert.match(apiSource, /jobs\/\$\{id\}`?, undefined, API_REQUEST_TIMEOUT_MS/, 'job read must carry the explicit 15s timeout');
assert.match(apiSource, /AbortSignal/, 'caller signal and timeout signal must be combined');
assert.match(apiSource, /init\?\.signal/, 'caller-provided signal must stay effective alongside the timeout');

// 面板三态：loading / empty / error 分开，失败不复用空文案，有 last-good 标陈旧并可重试。
assert.match(panel, /正在加载任务…/, 'pending list must render an explicit loading state');
assert.match(panel, /正在加载 Worker 状态…/, 'pending worker status must render an explicit loading state');
assert.match(panel, /正在加载执行过程…/, 'pending job detail must render an explicit loading state');
assert.match(panel, /任务列表加载失败/, 'failed list without last-good must render an error, not the empty copy');
assert.match(panel, /列表可能是旧数据/, 'failed list with last-good must keep data and mark it stale');
assert.match(panel, /onClick=\{retry\}/, 'error and stale states must offer one-click retry');
assert.match(panel, /showEmpty &&/, 'empty copy must be gated on a successful snapshot, never on pending/failure');
assert.doesNotMatch(panel, /\{jobs\.length === 0 && <p className="empty-note"/, 'bare jobs.length check must not render empty directly');
assert.match(panel, /aria-busy=\{jobsLoading/, 'list must expose busy state for slow networks');
assert.match(panel, /role="status"/, 'loading/stale states must be announced');
assert.match(panel, /role="alert"/, 'list error must be announced as an alert');

// 状态支撑：store 与 hook 必须暴露 loading/loaded，超时上限与慢 warn 可观测。
assert.match(storeSource, /loading: Record<string, boolean>/, 'store must track in-flight reads');
assert.match(storeSource, /loaded: Record<string, boolean>/, 'store must distinguish not-yet-loaded from empty');
assert.match(hookSource, /state\.loading\[`job:/, 'job detail hook must expose loading');
assert.match(apiSource, /API_REQUEST_TIMEOUT_MS/, 'api must define a request timeout');
assert.match(apiSource, /15000|15_000/, 'first paint must have a perceptible timeout ceiling');
assert.match(apiSource, /请求超时/, 'timeout must surface a retryable error instead of spinning forever');
assert.match(apiSource, /API_SLOW_WARN_MS/, 'slow requests must be observable');

console.log('worker loading/empty/error regression checks passed');
