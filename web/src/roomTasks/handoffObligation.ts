/** Pure helpers for handoff-obligation chat alerts (UI unit-tested, no React). */

export const ROOM_TASKS_OPEN_EVENT = 'room-tasks:open';

export interface HandoffObligationRef {
  taskIds: string[];
  failedTurnId?: string;
}

/** Parse the gateway-written handoff-obligation error meta; null when unrelated. */
export function parseHandoffObligationMeta(meta: string): HandoffObligationRef | null {
  try {
    const parsed = JSON.parse(meta) as {
      handoffObligation?: unknown;
      taskIds?: unknown;
      failedTurnId?: unknown;
    };
    if (!parsed || parsed.handoffObligation !== true) return null;
    if (!Array.isArray(parsed.taskIds)) return null;
    const taskIds = parsed.taskIds.filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (taskIds.length === 0) return null;
    const failedTurnId =
      typeof parsed.failedTurnId === 'string' && parsed.failedTurnId.length > 0
        ? parsed.failedTurnId
        : undefined;
    return { taskIds, ...(failedTurnId ? { failedTurnId } : {}) };
  } catch {
    return null;
  }
}

export interface UnsettledRecoveryLike {
  turnId: string;
  recovered: boolean;
  evidence?: Array<{ eventId: number; kind: string }>;
}

/**
 * Match the recovery entry for the failed turn that raised the chat alert.
 *
 * Exact-turn matching only: without a reliable failedTurnId there is no safe
 * association (timestamps and ordering are not proof), so old messages that
 * predate the field stay UNCONFIRMED instead of borrowing another failed
 * turn's recovery on the same task. Never match arbitrarily.
 */
export function matchRecovery(
  recoveries: readonly UnsettledRecoveryLike[] | undefined,
  failedTurnId: string | undefined,
): UnsettledRecoveryLike | undefined {
  if (!recoveries || recoveries.length === 0) return undefined;
  if (!failedTurnId) return undefined;
  return recoveries.find((entry) => entry.turnId === failedTurnId);
}

export function recoveryEvidenceText(
  evidence: ReadonlyArray<{ eventId: number; kind: string }> | undefined,
): string {
  if (!evidence || evidence.length === 0) return '';
  return evidence.map((entry) => `${entry.kind}#${entry.eventId}`).join('、');
}

export type TaskRecoveryState = 'recovered' | 'pending' | 'unknown';

export interface TaskRecoveryItem {
  taskId: string;
  taskPath: string;
  state: TaskRecoveryState;
  evidence: string;
}

export interface RecoverySummary {
  recovered: boolean;
  recoveredCount: number;
  total: number;
}

/**
 * Whole-box verdict: EVERY associated failed task must carry a confirmed
 * recovery for the alert's turn. One pending/unknown task keeps the
 * unresolved alarm; per-item details are rendered alongside.
 */
export function summarizeRecovery(items: ReadonlyArray<TaskRecoveryItem>): RecoverySummary {
  const total = items.length;
  const recoveredCount = items.filter((item) => item.state === 'recovered').length;
  return { recovered: total > 0 && recoveredCount === total, recoveredCount, total };
}

/** First task still needing attention (pending/unknown), if any. */
export function firstUnresolvedTask(
  items: ReadonlyArray<TaskRecoveryItem>,
): TaskRecoveryItem | undefined {
  return items.find((item) => item.state !== 'recovered');
}

/** Real details entry: asks the room task panel to open and reveal the task. */
export function openRoomTaskDetail(roomId: string, taskId: string): void {
  window.dispatchEvent(
    new CustomEvent(ROOM_TASKS_OPEN_EVENT, { detail: { roomId, taskId } }),
  );
}

export interface RecoveryWatcher {
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
}

/**
 * Mount-lifetime recovery watcher: loads the per-task recovery snapshot,
 * notifies on every load, and keeps polling while ANY task is unconfirmed.
 * Polling stops as soon as the whole box confirms (or on stop()). A manual
 * refresh() always reloads once regardless of state.
 */
export function createRecoveryWatcher(options: {
  load: () => Promise<ReadonlyArray<TaskRecoveryItem>>;
  intervalMs: number;
  onUpdate: (snapshot: { items: TaskRecoveryItem[]; summary: RecoverySummary }) => void;
}): RecoveryWatcher {
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastSummary: RecoverySummary | null = null;
  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const notify = (items: TaskRecoveryItem[]) => {
    const summary = summarizeRecovery(items);
    lastSummary = summary;
    options.onUpdate({ items, summary });
  };
  const schedule = () => {
    clearTimer();
    if (!running) return;
    if (lastSummary && lastSummary.recovered) return;
    timer = setTimeout(() => {
      void refresh().then(() => {
        schedule();
      });
    }, Math.max(options.intervalMs, 0));
  };
  const refresh = async (): Promise<void> => {
    let items: TaskRecoveryItem[];
    try {
      items = [...(await options.load())];
    } catch {
      // Load failure keeps the previous alarm; report an empty snapshot so
      // the box stays unresolved instead of flipping on missing data.
      notify([]);
      return;
    }
    notify(items);
  };
  return {
    start: () => {
      if (running) return;
      running = true;
      void refresh().then(() => {
        schedule();
      });
    },
    stop: () => {
      running = false;
      clearTimer();
    },
    refresh: async () => {
      await refresh();
      schedule();
    },
  };
}
