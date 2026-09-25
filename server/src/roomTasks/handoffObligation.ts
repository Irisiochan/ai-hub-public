import type { Db } from '../platform/index.js';
import type { JobStore } from '../jobs/index.js';
import {
  RoomTaskStore,
  findTaskUnsettledRecoveries,
  findUnsettledRecovery,
  taskDispatchLedgerStatus,
  type UnsettledRecovery,
} from './roomTaskStore.js';
import { isPoisoned, listTurnCalls, touchedTasks } from './turnAttribution.js';

export type { UnsettledRecovery };
export { findTaskUnsettledRecoveries, findUnsettledRecovery };

/**
 * End-of-turn handoff obligation (model-directed, gateway-validated).
 *
 * The gateway never picks the next stage/person: it only checks that for
 * every related unfinished task the model left a verifiable responsibility
 * disposition in THIS turn. Valid dispositions (re-read at terminal time):
 * - genuinely closed/dropped task (existing evidence gates enforced the close)
 * - current-turn task-level wait/blocker (task_wait blocked/waiting_user)
 *   or callback-scoped waiting_owner, with matching effective revision
 * - current-turn explicit handoff created by THIS turn (exact handoff id in
 *   this turn's receipts), still pending/accepted, with a posted dispatch
 * - current-turn explicit handoff redelivery (task_retry) of the exact live
 *   pending handoff with a posted/duplicate dispatch
 * - current-turn execution_start/release_execute whose exact job (from this
 *   turn's receipts) is still active with a valid unfenced explicit callback
 * - a validated decline of the pending incoming handoff (relinquishes
 *   receiving; responsibility stays with the original owner) — unless the
 *   turn itself owns the task at terminal time (decline followed by a new
 *   accept), in which case a further disposition is required
 *
 * Accepting NEVER settles: accept only acquires responsibility, the receiver
 * must thereafter execute, handoff, validly wait or really complete —
 * accept + bare final/PASS is the original bug and fails. Old handoffs,
 * idempotency-duplicate replays of older keys, failed tools/dispatches,
 * historical waits, unrelated-task evidence, stale revisions and
 * terminal/fenced job callbacks never pass. A live pending handoff edge
 * addressed to this turn suspends old outgoing/decline/retry receipts: the
 * new receiving duty must be accepted/declined (or otherwise disposed)
 * first. Missing disposition records an explicit unsettled outcome; the turn
 * must NOT settle as normal done and must NOT prune a PASS bubble.
 */

export interface ObligationInput {
  roomId: string;
  contactId: string;
  moduleId: string;
  turnId: string;
  pinnedTaskId?: string;
}

export interface ObligationRemedy {
  taskId: string;
  taskPath: string;
  code:
    | 'accepted-idle'
    | 'read-only'
    | 'evidence-only'
    | 'failed-delivery'
    | 'fenced-or-taken-over'
    | 'generic';
  hint: string;
}

export interface ObligationResult {
  ok: boolean;
  reason?: string;
  taskIds?: string[];
  taskPaths?: string[];
  remedies?: ObligationRemedy[];
}

const ACTIVE_JOB_STATUSES = new Set([
  'pending', 'claimed', 'running', 'recovering', 'pause_requested', 'cancel_requested',
]);

function taskPathOf(db: Db, taskId: string): string {
  try {
    const row = db.prepare('SELECT task_path FROM room_tasks WHERE id = ?').get(taskId) as
      | { task_path: string }
      | undefined;
    return row?.task_path ?? taskId;
  } catch {
    return taskId;
  }
}

export function checkTurnObligation(
  db: Db,
  jobs: JobStore | null,
  store: RoomTaskStore,
  input: ObligationInput,
): ObligationResult {
  // Poisoned turns (attribution/audit persistence failed) fail closed:
  // their receipts are unrecorded, so no disposition can be verified.
  if (isPoisoned(input.turnId)) {
    return {
      ok: false,
      reason: '责任归属记录失败（审计持久化异常）；本轮不得按正常完成结算，按当前轮次重做显式交接/等待。',
      taskIds: [],
      taskPaths: [],
    };
  }
  let calls: ReturnType<typeof listTurnCalls>;
  try {
    calls = listTurnCalls(db, input.turnId);
  } catch (error) {
    // Attribution unreadable: fail closed, never silently pass as no receipts.
    return {
      ok: false,
      reason: `责任归属读取失败（${error instanceof Error ? error.message : String(error)}）；本轮不得按正常完成结算。`,
      taskIds: [],
      taskPaths: [],
    };
  }
  const touched = new Map<string, { okTools: Set<string> }>();
  for (const call of calls) {
    if (!call.task_id || call.ok !== 1) continue;
    // Only same-room touches count; cross-room attempts always fail server-side
    // and are never recorded ok, but filter defensively.
    let entry = touched.get(call.task_id);
    if (!entry) {
      entry = { okTools: new Set() };
      touched.set(call.task_id, entry);
    }
    entry.okTools.add(call.tool);
  }
  const related = new Set<string>();
  if (input.pinnedTaskId) related.add(input.pinnedTaskId);
  for (const taskId of touched.keys()) related.add(taskId);
  // Trusted in-memory touched set widens the related set when audit
  // persistence diverged; it can only add tasks, never grant a pass.
  for (const taskId of touchedTasks(input.turnId)) related.add(taskId);
  if (related.size === 0) return { ok: true };

  const failures: string[] = [];
  const failurePaths: string[] = [];

  for (const taskId of related) {
    let task: ReturnType<RoomTaskStore['getTaskById']>;
    try {
      task = store.getTaskById(taskId);
    } catch {
      task = undefined;
    }
    if (!task) {
      // Task row vanished (should not happen); unrelated/failed evidence.
      failures.push(taskId);
      failurePaths.push(taskId);
      continue;
    }
    if (task.room_id !== input.roomId) {
      failures.push(taskId);
      failurePaths.push(task.task_path);
      continue;
    }
    if (task.status === 'closed' || task.status === 'dropped') {
      // Genuinely closed: existing evidence gates enforced the close path.
      // Dropped is also terminal (explicit model/user decision elsewhere).
      continue;
    }
    if (checkOneTask(db, jobs, store, taskId, task, input, calls)) continue;
    failures.push(taskId);
    failurePaths.push(task.task_path);
  }

  if (failures.length === 0) return { ok: true };
  const remedies: ObligationRemedy[] = failures.map((taskId, idx) =>
    remedyForFailedTask(db, jobs, taskId, failurePaths[idx] ?? taskId, calls),
  );
  const specific = remedies
    .map((remedy) => `${remedy.taskPath}：${remedy.hint}`)
    .join('；');
  return {
    ok: false,
    reason:
      `未交接：${failurePaths.join('、')} 在本轮没有可验证的责任去向；` +
      `继续真实执行、显式 task_handoff 并投递成功、登记 task_wait（blocked/waiting_user，回调轮次 waiting_owner）、` +
      `或 decline 不再承接；accept 只是接下责任，还须执行/交接/等待。有待处理的点名交接须先 accept/decline，不得只报 done 或静默 PASS。` +
      (specific ? `补办指引（用当前合法轮次重做，不复用已结束 nonce；网关仅校验，不代选阶段/联系人）：${specific}` : ''),
    taskIds: failures,
    taskPaths: failurePaths,
    remedies,
  };
}

/**
 * One-time bounded remedy hint for a genuinely missing disposition.
 * Model-driven only: the gateway never auto-selects the next stage/contact,
 * never reuses an ended nonce, and never duplicates dispatch. The hint
 * rereads the current owner/handoff/active-job picture so the next turn can
 *补办 exactly once with the current legal turn + permissions:
 * - active valid execution exists → confirm continued waiting (explicit
 *   execution_get ack or callback-scoped waiting_owner), do NOT restart.
 * - no valid execution → handoff / wait / decline per the real state.
 * Responsibility already moved away must not be越权补办; failures stay
 * explicit pending, never an infinite auto-retry.
 */
function remedyForFailedTask(
  db: Db,
  jobs: JobStore | null,
  taskId: string,
  taskPath: string,
  calls: ReturnType<typeof listTurnCalls>,
): ObligationRemedy {
  const tools = new Set(
    calls.filter((call) => call.task_id === taskId && call.ok === 1).map((call) => call.tool),
  );
  const has = (...names: string[]) => names.some((name) => tools.has(name));
  // Active valid execution picture (reread live, not from receipts alone).
  let hasActiveExecution = false;
  try {
    if (jobs) {
      const links = db.prepare(
        'SELECT job_id FROM room_task_links WHERE task_id = ?',
      ).all(taskId) as Array<{ job_id: string }>;
      for (const link of links) {
        let job: ReturnType<JobStore['get']> | undefined;
        try {
          job = jobs.get(link.job_id);
        } catch {
          continue;
        }
        if (!job || !ACTIVE_JOB_STATUSES.has(job.status)) continue;
        try {
          if (jobs.workflowModules.isFenced(job.id)) continue;
        } catch {
          continue;
        }
        try {
          const cb = db.prepare(
            'SELECT 1 FROM room_task_callbacks WHERE job_id = ? AND task_id = ?',
          ).get(job.id, taskId);
          if (cb) {
            hasActiveExecution = true;
            break;
          }
        } catch {
          // ignore, treat as no valid execution
        }
      }
    }
  } catch {
    // ignore, fall through to generic guidance
  }
  if (hasActiveExecution) {
    return {
      taskId,
      taskPath,
      code: 'generic',
      hint: '已有在途有效执行，确认继续等待（execution_get 显式确认或回调轮次 waiting_owner），不重复启动 Worker、不重复派单',
    };
  }
  if (has('task_accept') && !has('task_handoff', 'execution_start', 'release_execute', 'task_wait', 'task_decline', 'task_retry')) {
    return {
      taskId,
      taskPath,
      code: 'accepted-idle',
      hint: '已接受交接，但未执行或登记等待；用当前合法轮次继续真实执行、显式 task_handoff 并投递成功，或登记 task_wait',
    };
  }
  if ((has('task_get', 'execution_get') && !has('task_handoff', 'execution_start', 'release_execute', 'task_wait', 'task_decline', 'task_accept', 'task_retry', 'task_submit_evidence', 'review_submit'))) {
    return {
      taskId,
      taskPath,
      code: 'read-only',
      hint: '本轮仅只读任务/回执，未留下责任去向；按真实状态交接、等待或拒绝承接',
    };
  }
  if ((has('task_submit_evidence', 'review_submit') && !has('task_handoff', 'execution_start', 'release_execute', 'task_wait', 'task_decline', 'task_retry'))) {
    return {
      taskId,
      taskPath,
      code: 'evidence-only',
      hint: '仅提交证据/评审，缺少责任去向；仍须显式交接、执行、等待或拒绝承接',
    };
  }
  if (has('task_handoff', 'task_retry')) {
    return {
      taskId,
      taskPath,
      code: 'failed-delivery',
      hint: '交接投递未成功或已失效；用 task_retry 向同一接收人重发，不改归属或阶段，不重复派单',
    };
  }
  if (has('execution_start', 'release_execute')) {
    return {
      taskId,
      taskPath,
      code: 'fenced-or-taken-over',
      hint: '执行尝试未形成有效在途责任（可能终态/被接管/fenced）；跟进当前在途尝试，不重复启动 Worker',
    };
  }
  return {
    taskId,
    taskPath,
    code: 'generic',
    hint: '按真实状态交接、等待或拒绝承接；责任已转移时不得越权补办',
  };
}

export interface RemedyEligibility {
  eligible: boolean;
  reason: string;
}

/**
 * Pre-remedy reread: owner, live handoff edge and callback registration are
 * re-read live before any automatic remedy wake. The wake only re-invokes the
 * ORIGINAL module/contact with a fresh nonce; every later operation still
 * passes the normal validators (owner / revision / nonce / fenced /
 * single-write-lease / dispatch idempotency), so a moved responsibility can
 * never be越权补办 — at worst the remedy turn is refused with a clear reason.
 */
export function remedyEligibility(
  db: Db,
  jobs: JobStore | null,
  taskId: string,
  moduleId: string,
  contactId: string,
  callbackJobId?: string,
): RemedyEligibility {
  try {
    const task = db.prepare(
      `SELECT status, owner_module, owner_contact, active_handoff_id
         FROM room_tasks WHERE id = ?`,
    ).get(taskId) as
      | { status: string; owner_module: string; owner_contact: string; active_handoff_id: string | null }
      | undefined;
    if (!task) return { eligible: false, reason: '任务已不在账本' };
    if (task.status === 'closed' || task.status === 'dropped') {
      return { eligible: false, reason: `任务已${task.status}，无需补办` };
    }
    if (task.owner_module === moduleId && task.owner_contact === contactId) {
      return { eligible: true, reason: '仍是负责人' };
    }
    if (task.active_handoff_id) {
      try {
        const live = db.prepare(
          'SELECT status, to_module, to_contact FROM room_task_handoffs WHERE id = ? AND task_id = ?',
        ).get(task.active_handoff_id, taskId) as
          | { status: string; to_module: string; to_contact: string }
          | undefined;
        if (live && live.status === 'pending'
          && live.to_module === moduleId && live.to_contact === contactId) {
          return { eligible: true, reason: '有新的点名交接待应答' };
        }
      } catch {
        // fall through
      }
    }
    if (callbackJobId && jobs) {
      try {
        const cb = db.prepare(
          `SELECT task_id, return_module, return_contact FROM room_task_callbacks
             WHERE job_id = ?`,
        ).get(callbackJobId) as
          | { task_id: string; return_module: string; return_contact: string }
          | undefined;
        if (cb && cb.task_id === taskId
          && cb.return_module === moduleId && cb.return_contact === contactId) {
          let fenced = true;
          try {
            fenced = jobs.workflowModules.isFenced(callbackJobId);
          } catch {
            fenced = true;
          }
          if (!fenced && jobs.get(callbackJobId)) {
            return { eligible: true, reason: '回调等待仍有效' };
          }
        }
      } catch {
        // fall through
      }
    }
    return { eligible: false, reason: '责任已转移，不得越权补办' };
  } catch {
    return { eligible: false, reason: '责任链读取失败，暂不自动补办' };
  }
}

function checkOneTask(
  db: Db,
  jobs: JobStore | null,
  store: RoomTaskStore,
  taskId: string,
  task: NonNullable<ReturnType<RoomTaskStore['getTaskById']>>,
  input: ObligationInput,
  calls: ReturnType<typeof listTurnCalls>,
): boolean {
  // 1. Current-turn wait/blocker with matching revision.
  try {
    const waits = db.prepare(
      `SELECT * FROM room_task_waits WHERE task_id = ? AND turn_id = ? ORDER BY id ASC`,
    ).all(taskId, input.turnId) as Array<{
      mode: string; revision: number; scope: string; callback_job_id: string | null;
    }>;
    for (const wait of waits) {
      if (!['blocked', 'waiting_user', 'waiting_owner'].includes(wait.mode)) continue;
      // Stale revision: the task moved after the wait was recorded.
      if (wait.revision !== task.revision) continue;
      if (wait.scope === 'callback') {
        // Scoped waits count only for the callback they were registered for,
        // and only when that callback is still live and unfenced.
        const cbJob = wait.callback_job_id;
        if (!cbJob || !jobs) continue;
        try {
          if (jobs.workflowModules.isFenced(cbJob)) continue;
        } catch {
          continue;
        }
        const cb = db.prepare(
          'SELECT * FROM room_task_callbacks WHERE job_id = ?',
        ).get(cbJob) as
          | { task_id: string; return_module: string; return_contact: string }
          | undefined;
        if (!cb || cb.task_id !== taskId) continue;
        if (cb.return_module !== input.moduleId || cb.return_contact !== input.contactId) continue;
        return true;
      }
      return true;
    }
  } catch {
    // no waits table yet
  }

  const okToolsForTask = calls
    .filter((call) => call.task_id === taskId && call.ok === 1)
    .map((call) => call.tool);

  // New incoming pending responsibility (REVIEW_PENDING): when the task's
  // live edge is a pending handoff addressed to THIS turn, old outgoing /
  // decline / retry receipts cannot settle the new receiving duty — the
  // turn must accept/decline the exact incoming (or otherwise dispose; a
  // current valid wait still counts via its own branch above). Outgoing
  // pending edges to other modules are unaffected. A pending edge this turn
  // itself created (e.g. a self-handoff still awaiting its own accept) does
  // not trigger the skip.
  let incomingPendingToSelf = false;
  try {
    if (task.active_handoff_id) {
      const live = db.prepare(
        `SELECT * FROM room_task_handoffs WHERE id = ?`,
      ).get(task.active_handoff_id) as
        | { id: string; task_id: string; status: string; to_module: string; to_contact: string }
        | undefined;
      if (live && live.task_id === taskId && live.status === 'pending'
        && live.to_module === input.moduleId && live.to_contact === input.contactId) {
        const ownEdge = db.prepare(
          `SELECT 1 FROM room_task_events
            WHERE task_id = ? AND kind = 'handoff-created'
              AND json_extract(payload, '$.handoffId') = ?
              AND json_extract(payload, '$.turnId') = ? LIMIT 1`,
        ).get(taskId, live.id, input.turnId);
        if (!ownEdge) incomingPendingToSelf = true;
      }
    }
  } catch {
    // Attribution unreadable here: fail closed for the receipt branches
    // below (waits/closed above already had their own say).
    incomingPendingToSelf = true;
  }

  // Final responsibility recheck (MUST 6): receipts below never settle when
  // responsibility demonstrably sits with this turn again at terminal time.
  // A decline relinquishes receiving, and a handoff moves responsibility
  // out — but if a later accept brought ownership back to this turn's own
  // module+contact (e.g. A->B then B->A accepted before A ends, or decline
  // followed by a new accept in the same turn), the old receipt is stale and
  // the turn must leave a FURTHER disposition.
  const selfOwned =
    task.owner_module === input.moduleId && task.owner_contact === input.contactId;

  // 2. A validated decline of the pending incoming handoff relinquishes
  // receiving (responsibility stays with the original owner). It settles
  // this turn only when the turn does NOT own the task at terminal time,
  // and only when no NEWER incoming pending edge addresses this turn (a
  // later handoff back to us re-opens the receiving duty).
  if (okToolsForTask.includes('task_decline') && !incomingPendingToSelf) {
    if (!selfOwned) return true;
  }

  // 3. Current-turn explicit handoff, identified EXACTLY: the handoff id in
  // this turn's own receipts must still be pending/accepted with a posted
  // (non-failed) dispatch. No fallback to "any recent pending handoff":
  // idempotency-duplicate replays of older keys and historical handoffs
  // cannot settle a new turn. A newer incoming pending edge to this turn
  // likewise suspends old outgoing receipts until the receiving duty is
  // processed.
  const handoffIdsThisTurn = new Set<string>();
  for (const call of calls) {
    if (call.task_id !== taskId || call.ok !== 1 || call.tool !== 'task_handoff') continue;
    const match = /handoff=([0-9a-f-]{1,100})/i.exec(call.detail);
    if (match?.[1]) handoffIdsThisTurn.add(match[1]);
  }
  if (handoffIdsThisTurn.size > 0 && !incomingPendingToSelf) {
    try {
      for (const handoffId of handoffIdsThisTurn) {
        const handoff = db.prepare(
          `SELECT * FROM room_task_handoffs WHERE id = ? AND task_id = ?`,
        ).get(handoffId, taskId) as { id: string; status: string } | undefined;
        if (!handoff) continue;
        // The handoff must have been created by THIS turn (origin nonce in
        // the persisted creation event), not merely referenced by it.
        const createdThisTurn = db.prepare(
          `SELECT 1 FROM room_task_events
            WHERE task_id = ? AND kind = 'handoff-created'
              AND json_extract(payload, '$.handoffId') = ?
              AND json_extract(payload, '$.turnId') = ? LIMIT 1`,
        ).get(taskId, handoff.id, input.turnId);
        if (!createdThisTurn) continue;
        if (!['pending', 'accepted'].includes(handoff.status)) continue;
        // Responsibility must not have returned to this turn: an accepted
        // handoff whose owner is this turn again (accepted back), or any
        // live edge other than this handoff, means the turn holds the task
        // and needs a further disposition.
        if (selfOwned && (handoff.status === 'accepted' || task.active_handoff_id !== handoff.id)) continue;
        const ledger = taskDispatchLedgerStatus(db, `task-handoff:v1:${handoff.id}`);
        if (ledger === 'failed' || ledger === null) continue;
        return true;
      }
    } catch {
      // fall through
    }
  }

  // 3b. Current-turn explicit handoff redelivery (task_retry) of the exact
  // live pending handoff, with a posted/duplicate dispatch. Validates exact
  // live responsibility; failed redeliveries never pass. Suspended while a
  // newer incoming pending edge addresses this turn, like created handoffs.
  for (const call of calls) {
    if (incomingPendingToSelf) break;
    if (call.task_id !== taskId || call.ok !== 1 || call.tool !== 'task_retry') continue;
    const handoffMatch = /handoff=([0-9a-f-]{1,100})/i.exec(call.detail);
    const dispatchMatch = /dispatch=(posted|duplicate|failed)/.exec(call.detail);
    const handoffId = handoffMatch?.[1];
    if (!handoffId || !dispatchMatch || dispatchMatch[1] === 'failed') continue;
    try {
      const handoff = db.prepare(
        `SELECT * FROM room_task_handoffs WHERE id = ? AND task_id = ?`,
      ).get(handoffId, taskId) as { id: string; status: string } | undefined;
      if (!handoff || !['pending', 'accepted'].includes(handoff.status)) continue;
      // Same returned-responsibility recheck as created handoffs: a retry
      // receipt cannot settle a turn that holds the task again.
      if (selfOwned && (handoff.status === 'accepted' || task.active_handoff_id !== handoff.id)) continue;
      const ledger = taskDispatchLedgerStatus(db, `task-handoff:v1:${handoff.id}`);
      if (ledger === 'failed' || ledger === null) continue;
      return true;
    } catch {
      // fall through to next receipt
    }
  }

  // 4. Current-turn execution with an active job + valid unfenced callback.
  // Exact receipts only: job ids recorded in THIS turn's own successful
  // execution_start/release_execute calls. Historical links, older events
  // and terminal/fenced jobs never pass.
  // 4b. Explicit continuation acknowledgment: a successful execution_get in
  // THIS turn naming the exact ongoing job also settles, after revalidating
  // at terminal time that the job is still active, still linked to this
  // task, unfenced, and carrying a complete explicit callback. The owner
  // cannot start a duplicate (single write lease), so awaiting an in-flight
  // job must be acknowledged rather than re-started. A bare task_get list
  // or historical job existence never passes.
  if ((okToolsForTask.includes('execution_start')
    || okToolsForTask.includes('release_execute')
    || okToolsForTask.includes('execution_get')
    || okToolsForTask.includes('task_handoff')) && jobs) {
    const jobIdsThisTurn = new Set<string>();
    for (const call of calls) {
      if (call.task_id !== taskId || call.ok !== 1) continue;
      if (call.tool !== 'execution_start' && call.tool !== 'release_execute' && call.tool !== 'execution_get'
        && call.tool !== 'task_handoff') continue;
      const match = /job=([A-Za-z0-9_-]{1,100})/.exec(call.detail);
      if (call.tool === 'task_handoff') {
        // Auto-start has no model-dispatch receipt. Only its original turn's
        // durable auto-accept event plus exact returned job can settle it;
        // replaying an old idempotency key must not settle a fresh turn.
        const handoff = /handoff=([0-9a-f-]{1,100})/i.exec(call.detail)?.[1];
        if (!handoff || !match?.[1]) continue;
        const ownLaunch = db.prepare(`SELECT 1 FROM room_task_events e JOIN jobs j
          ON json_extract(j.options, '$.roomTaskHandoffId') = json_extract(e.payload, '$.handoffId')
          WHERE e.task_id = ? AND e.kind = 'handoff-auto-accepted'
          AND json_extract(e.payload, '$.handoffId') = ? AND json_extract(e.payload, '$.turnId') = ?
          AND j.id = ? AND json_extract(j.options, '$.handoffAutoStart') = 1 LIMIT 1`)
          .get(taskId, handoff, input.turnId, match[1]);
        if (!ownLaunch) continue;
      }
      if (match?.[1]) jobIdsThisTurn.add(match[1]);
    }
    try {
      for (const jobId of jobIdsThisTurn) {
        const job = jobs.get(jobId);
        if (!job) continue;
        try {
          if (jobs.workflowModules.isFenced(jobId)) continue;
        } catch {
          continue;
        }
        const linked = db.prepare(
          'SELECT 1 FROM room_task_links WHERE job_id = ? AND task_id = ?',
        ).get(jobId, taskId);
        if (!linked) continue;
        const cb = db.prepare(
          'SELECT * FROM room_task_callbacks WHERE job_id = ?',
        ).get(jobId) as { task_id: string } | undefined;
        if (!cb || cb.task_id !== taskId) continue;
        if (ACTIVE_JOB_STATUSES.has(job.status)) return true;
        // A fast job can finish before its launching controller turn ends.
        // Its registered return now has a real pending/accepted handoff; do
        // not fail that original turn merely because the worker was fast.
        // Later reads of an old terminal job still cannot settle a new turn.
        if (incomingPendingToSelf) continue;
        const returned = db.prepare(`SELECT h.*, c.origin_turn_id FROM room_task_completion_handoffs c
          JOIN room_task_handoffs h ON h.id = c.handoff_id
          WHERE c.job_id = ? AND c.task_id = ?`).get(jobId, taskId) as
          | { id: string; status: string; origin_turn_id: string; to_module: string; to_contact: string }
          | undefined;
        if (!returned || returned.origin_turn_id !== input.turnId) continue;
        if (returned.status === 'pending' && task.active_handoff_id !== returned.id) continue;
        if (returned.status === 'accepted' && selfOwned) continue;
        if (!['pending', 'accepted'].includes(returned.status)) continue;
        if (taskDispatchLedgerStatus(db, `task-handoff:v1:${returned.id}`) === 'posted') return true;
      }
    } catch {
      // fall through
    }
  }

  // 5. Pending incoming handoff to this turn: existence alone never passes.
  // (Handled by requiring one of the above; reaching here means the turn did
  // not accept/decline/wait for it.)
  void taskPathOf;
  return false;
}

/** Record an honest unsettled event; never fabricates a block. */
export function recordUnsettled(
  store: RoomTaskStore,
  taskId: string,
  actor: string,
  payload: { turnId: string; reason: string },
  module?: string,
): void {
  try {
    store.recordUnsettled(taskId, actor, payload, module);
  } catch {
    // best-effort
  }
}
