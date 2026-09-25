import type { ContactRow, Db, MessageRow, SseHub } from '../platform/index.js';
import type { AgentManager } from './manager.js';
import { contactConfig } from '../contacts/index.js';
import { type RoomTaskDispatcher, markTaskDispatch, taskDispatchLedgerStatus } from '../roomTasks/index.js';

/**
 * Gateway-side delivery for the task ledger. Posts a plain tool-fact message
 * (sender='system', never a fake room-host bubble) and wakes ONLY the
 * captured recipient through the normal tracked room dispatch, propagating
 * the durable wake reference ({taskId, handoffId} or {taskId, callbackJobId})
 * so the turn runs under the FROZEN snapshot — never a live re-resolution.
 * Retries always target the SAME captured recipient. Ordinary model text
 * cannot forge this: the manager re-verifies the durable row server-side.
 *
 * No double-wake: outcomes persist in room_task_dispatches keyed by the
 * idempotency key. A posted key returns duplicate WITHOUT waking again;
 * only failed deliveries may retry. Decided (accepted/declined/superseded)
 * handoff references are refused, never reported posted.
 *
 * Queue acceptance is not model acceptance: the ledger marks posted when the
 * recipient turn is queued, then watches the round completion — a provider
 * failure flips the row back to failed so an explicit task_retry can
 * redeliver. No automatic next stage is ever selected here.
 */
export function createRoomTaskDispatcher(deps: {
  db: Db;
  sse: SseHub;
  manager: AgentManager;
}): RoomTaskDispatcher {
  const ledgerStatus = (key: string): string | null => taskDispatchLedgerStatus(deps.db, key);

  const markDispatch = (
    key: string,
    kind: string,
    status: 'posted' | 'failed',
    messageId: number | null,
    target: string,
    detail: string,
  ): void => {
    markTaskDispatch(deps.db, key, kind, status, messageId, target, detail);
  };

  /**
   * B1: pass wakes ride the pass key, but task_retry reads the durable
   * handoff key. Mark both so a never-started auto-pass stays explicitly
   * retryable to the same captured recipient. Real handoff dispatches
   * already use the handoff key, so the mirror is a no-op for them.
   */
  const handoffMirrorKey = (key: string, ref?: { handoffId?: string }): string | null =>
    ref?.handoffId && key !== `task-handoff:v1:${ref.handoffId}`
      ? `task-handoff:v1:${ref.handoffId}`
      : null;
  const markBoth = (
    key: string,
    kind: string,
    status: 'posted' | 'failed',
    messageId: number | null,
    target: string,
    detail: string,
    ref?: { handoffId?: string },
  ): void => {
    markDispatch(key, kind, status, messageId, target, detail);
    const mirror = handoffMirrorKey(key, ref);
    if (mirror) markTaskDispatch(deps.db, mirror, kind, status, messageId, target, detail);
  };

  return {
    publishTaskChange(roomId) {
      deps.sse.broadcast('room-task', { roomId });
    },
    publishFact(messageId) {
      const row = deps.db.prepare("SELECT * FROM messages WHERE id = ? AND sender = 'system'")
        .get(messageId) as MessageRow | undefined;
      if (row) deps.sse.broadcast('message', row);
    },
    dispatchToModule(roomId, moduleId, toContact, content, idempotencyKey, ref) {
      const kind = ref?.callbackJobId ? 'callback' : 'handoff';
      // Decided references are never (re-)delivered: a declined/superseded
      // handoff cannot be reported posted. Callback refs must resolve to a
      // registered explicit callback.
      if (ref?.handoffId) {
        try {
          const row = deps.db.prepare(
            'SELECT task_id, status FROM room_task_handoffs WHERE id = ?',
          ).get(ref.handoffId) as { task_id: string; status: string } | undefined;
          if (!row || row.task_id !== ref.taskId) {
            return { status: 'failed', reason: 'handoff reference does not resolve to this task' };
          }
          if (row.status !== 'pending' && row.status !== 'accepted') {
            return { status: 'failed', reason: `handoff is ${row.status}; delivery refused` };
          }
        } catch (error) {
          return { status: 'failed', reason: `handoff lookup failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      if (ref?.callbackJobId) {
        try {
          const row = deps.db.prepare(
            'SELECT task_id FROM room_task_callbacks WHERE job_id = ?',
          ).get(ref.callbackJobId) as { task_id: string } | undefined;
          if (!row || row.task_id !== ref.taskId) {
            return { status: 'failed', reason: 'callback reference does not resolve to a registered explicit callback' };
          }
        } catch (error) {
          return { status: 'failed', reason: `callback lookup failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      // Posted keys never wake again. Failed keys may retry.
      if (ledgerStatus(idempotencyKey) === 'posted') {
        let messageId: number | undefined;
        try {
          const posted = deps.db.prepare(
            'SELECT message_id FROM room_task_dispatches WHERE idempotency_key = ?',
          ).get(idempotencyKey) as { message_id: number | null } | undefined;
          if (posted?.message_id) messageId = Number(posted.message_id);
        } catch { /* ignore */ }
        return { status: 'duplicate', ...(messageId ? { messageId } : {}) };
      }
      const room = deps.db.prepare(
        "SELECT * FROM contacts WHERE id = ? AND kind = 'room' AND enabled = 1",
      ).get(roomId) as ContactRow | undefined;
      if (!room) {
        markBoth(idempotencyKey, kind, 'failed', null, toContact, `room ${roomId} unavailable`, ref);
        return { status: 'failed', reason: `room ${roomId} unavailable` };
      }
      let members: string[] = [];
      try {
        const cfg = contactConfig(room) as unknown as { members?: unknown };
        members = Array.isArray(cfg.members)
          ? cfg.members.filter((item): item is string => typeof item === 'string')
          : [];
      } catch { members = []; }
      if (!members.includes(toContact)) {
        markBoth(idempotencyKey, kind, 'failed', null, toContact, `${toContact} is not a member of room ${roomId}`, ref);
        return { status: 'failed', reason: `${toContact} is not a member of room ${roomId}` };
      }
      const target = deps.manager.imageRoomMembers(room).find((member) => member.id === toContact);
      if (!target) {
        markBoth(idempotencyKey, kind, 'failed', null, toContact, `${toContact} is not an available room member`, ref);
        return { status: 'failed', reason: `${toContact} is not an available room member` };
      }
      // Find-or-create the fact message by idempotency key (a prior failed
      // attempt may have recorded the fact but not the wake).
      let messageId: number;
      try {
        const existing = deps.db.prepare(
          'SELECT id FROM messages WHERE contact_id = ? AND idempotency_key = ? ORDER BY id DESC LIMIT 1',
        ).get(roomId, idempotencyKey) as { id: number } | undefined;
        if (existing) {
          messageId = Number(existing.id);
        } else {
          const meta = JSON.stringify({
            event: 'room-task-handoff',
            moduleId,
            target: toContact,
            taskId: ref?.taskId,
            ...(ref?.handoffId ? { handoffId: ref.handoffId } : {}),
            ...(ref?.callbackJobId ? { callbackJobId: ref.callbackJobId } : {}),
          });
          const result = deps.db.prepare(
            `INSERT INTO messages
              (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
             VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main', ?)`,
          ).run(roomId, content, meta, idempotencyKey);
          messageId = Number(result.lastInsertRowid);
          const row = deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow;
          deps.sse.broadcast('message', row);
        }
      } catch (error) {
        markBoth(idempotencyKey, kind, 'failed', null, toContact, `fact persist failed: ${error instanceof Error ? error.message : String(error)}`, ref);
        return { status: 'failed', reason: `fact persist failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      // Wake the SAME captured recipient and inspect the outcome: an empty
      // target set (pool block, unbound, forged) is a retryable failure, not
      // a delivery. Deferred (deploy drain) stays durable and recovers.
      let outcome: { targets: string[]; deferred?: boolean; completion: Promise<unknown> };
      try {
        outcome = deps.manager.dispatchRoomMessageTracked(room, content, {
          targetOverride: [target],
          capture: false,
          reactionRounds: 0,
          moduleId,
          ...(ref?.handoffId ? { taskHandoff: { taskId: ref.taskId, handoffId: ref.handoffId } } : {}),
          ...(ref?.callbackJobId ? { taskCallback: { taskId: ref.taskId, jobId: ref.callbackJobId } } : {}),
          userMessageId: messageId,
        }) as { targets: string[]; deferred?: boolean; completion: Promise<unknown> };
      } catch (error) {
        markBoth(idempotencyKey, kind, 'failed', messageId, toContact, `wake threw: ${error instanceof Error ? error.message : String(error)}`, ref);
        return { status: 'failed', reason: `wake failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!outcome.targets.includes(toContact)) {
        markBoth(idempotencyKey, kind, 'failed', messageId, toContact,
          `recipient not woken (targets: ${outcome.targets.join(',') || 'none'})${outcome.deferred ? '; deferred' : ''}`, ref);
        return { status: 'failed', reason: `recipient ${toContact} was not woken; retry via task_retry` };
      }
      markBoth(idempotencyKey, kind, 'posted', messageId, toContact, outcome.deferred ? 'deferred; durable recovery owns the wake' : 'woken', ref);
      if (!outcome.deferred) {
        // Async provider failure flips the row back to failed so an explicit
        // retry can redeliver. No automatic next stage is ever selected here.
        const key = idempotencyKey;
        // 部署重启打断的轮次由 manager 的 durable 续跑接管：这里再翻成 failed，
        // 就会给显式 task_retry 留一个和自动续跑重复唤醒的口子。
        const deployInterrupted = (): boolean => {
          try {
            const row = deps.db.prepare('SELECT meta FROM messages WHERE id = ?').get(messageId) as { meta: string } | undefined;
            return JSON.parse(row?.meta || '{}')?.roomDispatch?.interruptionReason === 'deploy-restart';
          } catch {
            return false;
          }
        };
        // A recipient turn that ran to completion but never answered the
        // handoff (tools unreachable, model wandered, obligation gate failed)
        // leaves the handoff pending behind a posted key, so task_retry would
        // report duplicate forever. Treat it as a failed delivery so an
        // explicit retry can wake the same recipient again.
        const handoffStillPending = (): boolean => {
          if (!ref?.handoffId) return false;
          try {
            const row = deps.db.prepare('SELECT status FROM room_task_handoffs WHERE id = ?')
              .get(ref.handoffId) as { status: string } | undefined;
            return row?.status === 'pending';
          } catch {
            return false;
          }
        };
        // B1: silent-only (or empty) normal stats mean the recipient runtime
        // settled without any model content — buildRoomDelivery found nothing
        // to run, so the just-inserted fact never reached a turn. Spoke,
        // passed, and error all prove a turn really started.
        const recipientNeverStarted = (stats: unknown): boolean => {
          if (!stats || typeof stats !== 'object') return false;
          const normal = (stats as { normal?: Record<string, number> }).normal;
          if (!normal || typeof normal !== 'object') return false;
          return Number(normal.spoke ?? 0) === 0
            && Number(normal.passed ?? 0) === 0
            && Number(normal.error ?? 0) === 0;
        };
        void (outcome.completion as Promise<{ normal?: Record<string, number> }>).then(
          (stats) => {
            if (deployInterrupted()) return;
            if (stats && typeof stats === 'object' && Number(stats.normal?.error ?? 0) > 0) {
              markBoth(key, kind, 'failed', messageId, toContact, 'round completed with model error; explicit retry available', ref);
            } else if (handoffStillPending()) {
              markBoth(key, kind, 'failed', messageId, toContact, 'recipient turn ended without accept/decline; explicit retry available', ref);
            } else if (recipientNeverStarted(stats)) {
              // B1: the wake was queued (targets non-empty, ledger posted)
              // but the recipient round ran no content at all — the fact
              // never reached a model (silent delivery). Flip both keys so
              // an explicit task_retry can redeliver to the same recipient
              // instead of reporting duplicate forever.
              markBoth(key, kind, 'failed', messageId, toContact, 'recipient turn never started; explicit retry available', ref);
            }
          },
          () => {
            if (deployInterrupted()) return;
            markBoth(key, kind, 'failed', messageId, toContact, 'round threw; explicit retry available', ref);
          },
        );
      }
      return { status: 'posted', messageId };
    },
  };
}
