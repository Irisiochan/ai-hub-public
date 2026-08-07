import type { Message } from './api';

function isEditedMeta(meta: string | undefined): boolean {
  if (!meta) return false;
  try {
    const parsed = JSON.parse(meta) as { edited?: unknown };
    return parsed?.edited === true || parsed?.edited === 1;
  } catch {
    return meta.includes('"edited"');
  }
}

/**
 * Protect streaming assistant/thinking bubbles from stale full-row snapshots
 * that would wipe already-rendered delta text.
 *
 * Must NOT block intentional replacements:
 * - user message edit + regenerate (rewrite / shorten / non-prefix change)
 * - rows marked edited in meta
 */
function shouldKeepExistingContent(existing: Message, incoming: Message): boolean {
  if (existing.id !== incoming.id) return false;
  if (existing.contact_id !== incoming.contact_id) return false;
  if (existing.kind !== incoming.kind) return false;
  // Persisted terminal rows are authoritative. A done/error/interrupted row
  // carries the server's final content, metadata and status, so it must never
  // be blocked by locally accumulated deltas.
  if (incoming.status !== 'streaming') return false;
  if (existing.kind !== 'text' && existing.kind !== 'thinking') return false;
  // User messages never stream via deltas; always take server content (edits).
  if (existing.role === 'user' || incoming.role === 'user') return false;
  // Explicit edit marker from regenerate/update path.
  if (isEditedMeta(incoming.meta)) return false;
  if (!existing.content) return false;
  if (!incoming.content) return true;
  if (existing.content === incoming.content) return false;
  return existing.content.length > incoming.content.length || !incoming.content.startsWith(existing.content);
}

export function mergeIncomingMessage(existing: Message | undefined, incoming: Message): Message {
  // A request started while the row was streaming may resolve after the SSE
  // terminal event. Do not let that stale snapshot regress a completed row.
  if (existing && existing.status !== 'streaming' && incoming.status === 'streaming') {
    return existing;
  }
  if (!existing || !shouldKeepExistingContent(existing, incoming)) return incoming;
  return {
    ...incoming,
    content: existing.content,
  };
}

function isBusyContactState(state: string | undefined): boolean {
  return state === 'busy'
    || state === 'thinking'
    || state === 'streaming'
    || state?.startsWith('tool:') === true;
}

export function shouldReconcileMessagesAfterStatus(
  previousState: string | undefined,
  nextState: string,
  messages: Message[]
): boolean {
  const reachedTerminalState = nextState === 'idle' || nextState === 'error';
  return isBusyContactState(previousState)
    && reachedTerminalState
    && messages.some((message) => message.status === 'streaming');
}

interface ReconcileRun {
  pending: boolean;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * Coalesce concurrent reconciliations per contact without losing the trailing
 * request. If terminal status arrives while an older GET is still in flight,
 * that request marks the run pending and forces one more GET after the stale
 * response settles.
 */
export function createTrailingMessageReconciler(
  loadMessages: (contactId: string) => Promise<void>
): (contactId: string) => Promise<void> {
  const active = new Map<string, ReconcileRun>();

  return (contactId: string): Promise<void> => {
    const current = active.get(contactId);
    if (current) {
      current.pending = true;
      return current.promise;
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const run: ReconcileRun = { pending: false, promise, resolve, reject };
    active.set(contactId, run);

    void (async () => {
      let failed = false;
      let failure: unknown;
      while (true) {
        run.pending = false;
        try {
          await loadMessages(contactId);
          failed = false;
          failure = undefined;
        } catch (error) {
          failed = true;
          failure = error;
        }
        if (run.pending) continue;

        // No await between the pending check and deletion: a later request
        // either joined this run above or starts a fresh run after deletion.
        active.delete(contactId);
        if (failed) run.reject(failure);
        else run.resolve();
        return;
      }
    })();

    return promise;
  };
}

export function mergeMessageRows(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const row of incoming) {
    byId.set(row.id, mergeIncomingMessage(byId.get(row.id), row));
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function appendMessageDelta(messages: Message[], messageId: number, text: string): Message[] {
  return messages.map((m) => (m.id === messageId ? { ...m, content: m.content + text } : m));
}
