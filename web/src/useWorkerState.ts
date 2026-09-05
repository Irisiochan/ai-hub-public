import { useEffect, useSyncExternalStore } from 'react';
import { api, type JobMessage } from './api';
import { createWorkerState, type WorkerState } from './workerState';

export const workerState = createWorkerState(api);
const emptyMessages: JobMessage[] = [];

/** Select stable slices so execution logs do not rerender the chat or job list. */
export function useWorkerState<T>(select: (state: WorkerState) => T): T {
  return useSyncExternalStore(workerState.subscribe, () => select(workerState.getSnapshot()));
}

export function useJobMessages(id: string | null) {
  useEffect(() => id ? workerState.watchJob(id) : undefined, [id]);
  const messages = useWorkerState((state) => id ? state.messages[id] ?? emptyMessages : emptyMessages);
  const error = useWorkerState((state) => id ? state.errors[`job:${id}`] ?? '' : '');
  return { messages, error };
}

export function refreshWorkerJobs(): void {
  void workerState.reconcile().catch(() => {});
}
