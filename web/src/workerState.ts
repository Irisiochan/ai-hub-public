import type { JobMessage, Worker, WorkerJob, WorkflowProfilesResponse } from './api';

type Client = {
  workers(): Promise<{ workers: Worker[] }>;
  jobs(): Promise<{ jobs: WorkerJob[] }>;
  job(id: string): Promise<{ job: WorkerJob; messages: JobMessage[] }>;
  workflowProfiles(): Promise<WorkflowProfilesResponse>;
};

export interface WorkerState {
  workers: Worker[];
  jobs: WorkerJob[];
  workflow: WorkflowProfilesResponse | null;
  messages: Record<string, JobMessage[]>;
  errors: Record<string, string>;
}

const emptyState = (): WorkerState => ({ workers: [], jobs: [], workflow: null, messages: {}, errors: {} });
export const WORKER_RECONCILE_MS = 60_000;
const JOB_LOG_LIMIT = 200; // Same latest-log window as GET /api/jobs/:id.
const logWindow = (rows: JobMessage[]) => [...new Map(rows.map((row) => [row.id, row])).values()]
  .sort((a, b) => a.id - b.id).slice(-JOB_LOG_LIMIT);

/** One cache fed by the application's existing SSE connection. REST only hydrates
 * it, reconciles recovery, and provides a low-frequency fallback. */
export function createWorkerState(client: Client) {
  let state = emptyState();
  let generation = 0;
  let revision = 0;
  let jobsSnapshotAt = 0;
  let workersSnapshotAt = 0;
  const jobVersions = new Map<string, number>();
  const workerVersions = new Map<string, number>();
  const listeners = new Set<() => void>();
  const pending = new Map<string, Promise<void>>();
  const watching = new Map<string, { count: number }>();
  let reconciliation: Promise<void> | null = null;
  let reconcileAgain = false;

  const publish = (patch: Partial<WorkerState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const sortJobs = (rows: WorkerJob[]) => rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const applyJob = (job: WorkerJob, at = ++revision) => {
    if (at < jobsSnapshotAt || (jobVersions.get(job.id) ?? 0) > at) return;
    jobVersions.set(job.id, at);
    const rows = state.jobs.filter((row) => row.id !== job.id);
    if (!job.deleted) rows.push(job);
    publish({ jobs: sortJobs(rows) });
  };
  const applyWorker = (worker: Worker) => {
    workerVersions.set(worker.id, ++revision);
    const found = state.workers.some((row) => row.id === worker.id);
    publish({ workers: found
      ? state.workers.map((row) => row.id === worker.id ? worker : row)
      : [...state.workers, worker] });
  };

  // Share in-flight requests across the room card and Worker panel. A response
  // from an old login or an already closed viewer must never repopulate its cache.
  const load = <T>(key: string, read: () => Promise<T>, apply: (data: T, at: number) => void,
    valid: () => boolean = () => true): Promise<void> => {
    const existing = pending.get(key);
    if (existing) return existing;
    const epoch = generation;
    // Reads and live events use the same clock: a late older HTTP response must
    // not overwrite a newer HTTP snapshot either (DB timestamps have only seconds).
    const at = ++revision;
    const current = () => epoch === generation && valid();
    const request = Promise.resolve().then(read).then((data) => {
      if (!current()) return;
      apply(data, at);
      if (state.errors[key]) publish({ errors: { ...state.errors, [key]: '' } });
    }).catch((error: unknown) => {
      if (current()) publish({ errors: { ...state.errors, [key]: (error as Error).message } });
      throw error;
    }).finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });
    pending.set(key, request);
    return request;
  };

  const refreshJobs = () => load('jobs', () => client.jobs(), ({ jobs }, at) => {
    if (at < jobsSnapshotAt) return;
    jobsSnapshotAt = at;
    // A live terminal/update/delete arriving during a snapshot wins over it.
    const rows = jobs.filter((job) => (jobVersions.get(job.id) ?? 0) <= at);
    for (const job of rows) jobVersions.set(job.id, at);
    rows.push(...state.jobs.filter((job) => (jobVersions.get(job.id) ?? 0) > at));
    publish({ jobs: sortJobs(rows.filter((job) => !job.deleted)) });
  });
  const refreshWorkers = () => load('workers', () => client.workers(), ({ workers }, at) => {
    if (at < workersSnapshotAt) return;
    workersSnapshotAt = at;
    const rows = workers.map((worker) => (workerVersions.get(worker.id) ?? 0) > at
      ? state.workers.find((row) => row.id === worker.id) ?? worker : worker);
    rows.push(...state.workers.filter((worker) => (workerVersions.get(worker.id) ?? 0) > at
      && !rows.some((row) => row.id === worker.id)));
    for (const worker of rows) workerVersions.set(worker.id, Math.max(at, workerVersions.get(worker.id) ?? 0));
    publish({ workers: rows });
  });
  const refreshProfiles = () => load('profiles', () => client.workflowProfiles(), (workflow) => publish({ workflow }));
  const refreshJob = (id: string) => {
    const viewer = watching.get(id);
    return load(`job:${id}`, () => client.job(id), ({ job, messages }, at) => {
      applyJob(job, at);
      if (!viewer) return;
      // Log rows are immutable; merge by id so an event delivered while REST was
      // in flight is neither lost nor duplicated when the snapshot catches up.
      publish({ messages: { ...state.messages, [id]: logWindow([...(state.messages[id] ?? []), ...messages]) } });
    }, () => !viewer || watching.get(id) === viewer);
  };
  const refresh = () => Promise.all([
    refreshWorkers(), refreshJobs(), refreshProfiles(), ...[...watching.keys()].map(refreshJob),
  ]).then(() => {});

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    applyJob,
    applyWorker,
    applyJobMessage(message: JobMessage) {
      if (!watching.has(message.job_id)) return;
      const rows = state.messages[message.job_id] ?? [];
      const next = logWindow([...rows, message]);
      publish({ messages: { ...state.messages, [message.job_id]: next } });
    },
    refresh,
    refreshJobs,
    refreshJob,
    // Used after mutations/reconnects. Finish older reads first, then take one
    // shared authoritative snapshot of the lists and every visible detail.
    reconcile() {
      if (reconciliation) {
        reconcileAgain = true;
        return reconciliation;
      }
      const epoch = generation;
      const request = Promise.allSettled([...pending.values()]).then(async () => {
        do {
          if (epoch !== generation) return;
          reconcileAgain = false;
          await refresh();
        } while (epoch === generation && reconcileAgain);
      }).finally(() => {
        if (reconciliation === request) reconciliation = null;
      });
      reconciliation = request;
      return request;
    },
    watchJob(id: string) {
      const viewer = watching.get(id) ?? { count: 0 };
      watching.set(id, viewer);
      viewer.count += 1;
      if (viewer.count === 1) void refreshJob(id).catch(() => {});
      return () => {
        if (watching.get(id) !== viewer || --viewer.count > 0) return;
        watching.delete(id);
        pending.delete(`job:${id}`);
        const messages = { ...state.messages };
        const errors = { ...state.errors };
        delete messages[id];
        delete errors[`job:${id}`];
        publish({ messages, errors });
      };
    },
    reset() {
      generation += 1;
      revision = 0;
      jobsSnapshotAt = 0;
      workersSnapshotAt = 0;
      pending.clear();
      watching.clear();
      jobVersions.clear();
      workerVersions.clear();
      reconciliation = null;
      reconcileAgain = false;
      publish(emptyState());
    },
  };
}
