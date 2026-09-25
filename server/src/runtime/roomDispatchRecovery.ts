import type { ContactRow, Db, HubLogger, SseHub } from '../platform/index.js';
import { normalizeRoomCoordinationDispatch } from '../rooms/index.js';
import { markTaskDispatch } from '../roomTasks/index.js';
import { isWorkflowRoomConfig, validateCapturedSnapshot } from '../workflow/index.js';
import type { RoomRoundStats, ScheduledRoomDispatchOptions } from './manager.js';

type RecoveredModule = NonNullable<ScheduledRoomDispatchOptions['workflowModule']>;

/** 续跑要回到 manager 的几处：成员名单、任务引用校验、模块解析、不可用提示、排进该群的轮次链。 */
export interface RoomDispatchRecoveryHost {
  roomMembers(room: ContactRow): ContactRow[];
  verifyTaskHandoff(
    room: ContactRow,
    ref: { taskId: string; handoffId: string },
  ): (RecoveredModule & { taskId: string; handoffId: string }) | null;
  verifyTaskCallback(
    room: ContactRow,
    ref: { taskId: string; jobId: string },
  ): (RecoveredModule & { taskId: string; callbackJobId: string }) | null;
  resolveWorkflowModule(room: ContactRow, userMessageId: number): RecoveredModule | null;
  noteWorkflowModuleUnavailable(roomId: string, triggerId: number | undefined, moduleId: string, detail: string): void;
  scheduleRoomRound(room: ContactRow, targets: ContactRow[], options: ScheduledRoomDispatchOptions): Promise<RoomRoundStats>;
}

/**
 * 会议室派发的 durable 状态（`messages.meta.roomDispatch`）与部署重启后的续跑。
 * drain 期间推迟的派发、带任务账本引用或遗留 host 协调/回执源的在途派发先落快照；`stopAll('deploy-restart')`
 * 给在途的打中断标记；启动时 `recoverDeferredRoomDispatches` 重新校验后续跑，退役的遗留
 * host/coordination 行打标记拒绝。进程内的 drain 闸门在 `roomDispatchDrain.ts`。
 */
export class RoomDispatchRecovery {
  private deployResumeClaims = new Set<number>();

  constructor(
    private readonly deps: { db: Db; sse: SseHub; logger?: HubLogger },
    private readonly host: RoomDispatchRecoveryHost,
  ) {}

  writeRoomDispatchState(messageId: number, patch: Record<string, unknown>): void {
    const row = this.deps.db.prepare('SELECT meta FROM messages WHERE id = ?').get(messageId) as
      | { meta: string }
      | undefined;
    if (!row) throw new Error(`room dispatch source message ${messageId} not found`);
    let meta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.meta || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
    } catch {}
    const prior = meta.roomDispatch && typeof meta.roomDispatch === 'object' && !Array.isArray(meta.roomDispatch)
      ? meta.roomDispatch as Record<string, unknown>
      : {};
    this.deps.db.prepare('UPDATE messages SET meta = ? WHERE id = ?')
      .run(JSON.stringify({ ...meta, roomDispatch: { ...prior, ...patch } }), messageId);
  }

  /** 部署重启可续跑的派单源：遗留 host coordination/receipt 行（恢复侧拒绝并打退役标记），
   *  或带任务账本引用的事实行（恢复侧重新校验引用后续跑）。 */
  isDeployResumableSource(messageId: number): boolean {
    const row = this.deps.db.prepare('SELECT sender, meta FROM messages WHERE id = ?').get(messageId) as
      | { sender: string; meta: string }
      | undefined;
    if (!row) return false;
    try {
      const meta = JSON.parse(row.meta || '{}') as Record<string, any>;
      const isObject = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
      if (isObject(meta.roomDispatch?.taskHandoff) || isObject(meta.roomDispatch?.taskCallback)) return true;
      return row.sender === 'room-host' && isObject(meta.roomHost)
        && (isObject(meta.roomHost.coordination) || isObject(meta.roomHost.receipt));
    } catch {
      return false;
    }
  }

  markDeployInterruptedRoomDispatch(
    messageId: number,
    dispatchSnapshot?: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (!this.isDeployResumableSource(messageId)) return null;
    const row = this.deps.db.prepare('SELECT meta FROM messages WHERE id = ?').get(messageId) as
      | { meta: string }
      | undefined;
    if (!row) return null;
    let meta: Record<string, any> = {};
    try { meta = JSON.parse(row.meta || '{}'); } catch {}
    const priorDispatch = dispatchSnapshot ?? (
      meta.roomDispatch && typeof meta.roomDispatch === 'object' && !Array.isArray(meta.roomDispatch)
        ? meta.roomDispatch as Record<string, unknown>
        : {}
    );
    if (priorDispatch.dispatchClass === 'drain') return null;
    const interruptedAt = new Date().toISOString();
    const interruptedDispatch = {
      ...priorDispatch,
      status: 'error',
      interruptionReason: 'deploy-restart',
      interruptedAt,
    };
    const next = {
      ...meta,
      roomDispatch: interruptedDispatch,
      ...(meta.roomHost ? {
        roomHost: { ...meta.roomHost, status: 'error', interruptionReason: 'deploy-restart', interruptedAt },
      } : {}),
    };
    this.deps.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(next), messageId);
    return interruptedDispatch;
  }

  finishLiveRoomDispatch(messageId: number, outcome: RoomRoundStats): void {
    const row = this.deps.db.prepare('SELECT meta FROM messages WHERE id = ?').get(messageId) as
      | { meta: string }
      | undefined;
    if (!row) return;
    let meta: Record<string, any> = {};
    try { meta = JSON.parse(row.meta || '{}'); } catch {}
    if (
      meta.roomDispatch?.status === 'error'
      && meta.roomDispatch?.interruptionReason === 'deploy-restart'
    ) return;
    this.writeRoomDispatchState(messageId, {
      status: 'done',
      completedAt: new Date().toISOString(),
      outcome,
    });
  }

  recoverDeferredRoomDispatches(): number {
    const rows = this.deps.db.prepare(
      `SELECT * FROM messages
       WHERE (
         json_extract(meta, '$.roomDispatch.status') IN ('deferred', 'dispatching')
         AND COALESCE(json_extract(meta, '$.roomDispatch.dispatchClass'), 'drain') = 'drain'
       ) OR (
         sender = 'room-host'
         AND json_extract(meta, '$.roomDispatch.status') IN ('error', 'resume-queued')
         AND json_extract(meta, '$.roomDispatch.interruptionReason') = 'deploy-restart'
         AND (
           json_type(meta, '$.roomHost.coordination') = 'object'
           OR json_type(meta, '$.roomHost.receipt') = 'object'
         )
       ) OR (
         json_extract(meta, '$.roomDispatch.status') IN ('error', 'resume-queued')
         AND json_extract(meta, '$.roomDispatch.interruptionReason') = 'deploy-restart'
         AND (
           json_type(meta, '$.roomDispatch.taskHandoff') = 'object'
           OR json_type(meta, '$.roomDispatch.taskCallback') = 'object'
         )
       )
       ORDER BY id`,
    ).all() as Array<{ id: number; contact_id: string; sender: string; content: string; meta: string }>;
    let recovered = 0;
    for (const row of rows) {
      try {
        const room = this.deps.db.prepare(
          `SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'room'`,
        ).get(row.contact_id) as ContactRow | undefined;
        if (!room) throw new Error('room is unavailable');
        const meta = JSON.parse(row.meta || '{}') as Record<string, any>;
        const deferred = meta.roomDispatch ?? {};
        // Retired automatic engine: room-host coordination/receipt replays and
        // coordination-domain drain deferrals never wake again. Mark them once
        // so restarts do not replay killed automation. Plain room dispatches
        // (generic infra) still recover below.
        // M2: legacy host SOURCE rows in workflow rooms never replay as a
        // whole — even plain nudges/review-batch rows without coordination
        // fields. Only explicitly verified NEW refs (durable taskHandoff /
        // taskCallback below) and explicit user messages recover there.
        let roomIsWorkflow = false;
        try {
          const roomCfg = JSON.parse((room as unknown as { config?: string }).config || '{}') as Record<string, unknown>;
          roomIsWorkflow = isWorkflowRoomConfig(roomCfg);
        } catch { roomIsWorkflow = false; }
        const deferredTaskRef = (deferred.taskHandoff && typeof deferred.taskHandoff === 'object' && !Array.isArray(deferred.taskHandoff)
          && typeof (deferred.taskHandoff as Record<string, unknown>).taskId === 'string'
          && typeof (deferred.taskHandoff as Record<string, unknown>).handoffId === 'string')
          ? deferred.taskHandoff as { taskId: string; handoffId: string }
          : null;
        const deferredCallbackRef = (deferred.taskCallback && typeof deferred.taskCallback === 'object' && !Array.isArray(deferred.taskCallback)
          && typeof (deferred.taskCallback as Record<string, unknown>).taskId === 'string'
          && typeof (deferred.taskCallback as Record<string, unknown>).jobId === 'string')
          ? deferred.taskCallback as { taskId: string; jobId: string }
          : null;
        if (row.sender === 'room-host' && roomIsWorkflow && !deferredTaskRef && !deferredCallbackRef) {
          this.writeRoomDispatchState(row.id, {
            status: 'error',
            completedAt: new Date().toISOString(),
            error: 'retired: legacy host source never replays in workflow rooms',
          });
          continue;
        }
        const roomHostMeta = meta.roomHost && typeof meta.roomHost === 'object' && !Array.isArray(meta.roomHost)
          ? meta.roomHost as Record<string, unknown>
          : {};
        const retiredAuto = (row.sender === 'room-host'
          && (typeof roomHostMeta.coordination === 'object' && roomHostMeta.coordination !== null
            || typeof roomHostMeta.receipt === 'object' && roomHostMeta.receipt !== null))
          || deferred.coordinationDomain === true
          || (deferred.coordination && typeof deferred.coordination === 'object');
        if (retiredAuto) {
          this.writeRoomDispatchState(row.id, {
            status: 'error',
            completedAt: new Date().toISOString(),
            error: 'retired: automatic host/coordination dispatch removed; replay refused',
          });
          continue;
        }
        const deployResume = deferred.interruptionReason === 'deploy-restart'
          && ['error', 'resume-queued'].includes(String(deferred.status));
        if (deployResume && this.deployResumeClaims.has(row.id)) continue;
        const roomHostTargets = Array.isArray(meta.roomHost?.targets) ? meta.roomHost.targets : [];
        const targetIds = Array.isArray(deferred.targetIds)
          ? deferred.targetIds.map(String)
          : roomHostTargets.map(String);
        let targets = this.host.roomMembers(room).filter((member) => targetIds.includes(member.id));
        if (targets.length === 0) throw new Error('deferred targets are unavailable');
        const coordination = normalizeRoomCoordinationDispatch(deferred.coordination);
        // Recovery replays with a proper module snapshot: the durable drain
        // state wins when valid, else resolve from the source row (captured
        // pin or current binding). Task handoffs/callbacks re-verify their
        // durable rows first, so decided/superseded refs never replay.
        // Workflow rooms filter to the applicable binding even on replay — a
        // recovery is a new turn, never a reuse of a stale authority.
        const deferredTaskHandoff = deferredTaskRef;
        let recoveredModule: ScheduledRoomDispatchOptions['workflowModule'];
        if (deferredCallbackRef) {
          const verifiedCallback = this.host.verifyTaskCallback(room, deferredCallbackRef);
          if (!verifiedCallback) {
            this.writeRoomDispatchState(row.id, {
              status: 'error',
              completedAt: new Date().toISOString(),
              error: 'recovered task callback no longer valid; replay refused',
            });
            continue;
          }
          recoveredModule = {
            moduleId: verifiedCallback.moduleId,
            binding: verifiedCallback.binding,
            revision: verifiedCallback.revision,
            permissions: verifiedCallback.permissions,
            ...(verifiedCallback.taskPath ? { taskPath: verifiedCallback.taskPath } : {}),
            ...(verifiedCallback.workspace ? { workspace: verifiedCallback.workspace } : {}),
            taskId: verifiedCallback.taskId,
            callbackJobId: verifiedCallback.callbackJobId,
          };
        } else if (deferredTaskHandoff) {
          const verified = this.host.verifyTaskHandoff(room, deferredTaskHandoff);
          if (!verified) {
            this.writeRoomDispatchState(row.id, {
              status: 'error',
              completedAt: new Date().toISOString(),
              error: 'recovered task handoff no longer pending/accepted; replay refused',
            });
            continue;
          }
          recoveredModule = {
            moduleId: verified.moduleId,
            binding: verified.binding,
            revision: verified.revision,
            permissions: verified.permissions,
            ...(verified.taskPath ? { taskPath: verified.taskPath } : {}),
            ...(verified.workspace ? { workspace: verified.workspace } : {}),
            taskId: verified.taskId,
            handoffId: verified.handoffId,
          };
        } else {
        const durableRaw = (deferred.workflowModule && typeof deferred.workflowModule === 'object' && !Array.isArray(deferred.workflowModule))
          ? deferred.workflowModule as Record<string, unknown>
          : (meta.roomHost && typeof meta.roomHost === 'object' && !Array.isArray(meta.roomHost)
            ? (meta.roomHost as Record<string, unknown>).workflowModule
            : undefined);
        const durableSnapshot = validateCapturedSnapshot(durableRaw);
        const resolved = this.host.resolveWorkflowModule(room, row.id);
        if (durableSnapshot && durableSnapshot.policyVersion === 1) {
          recoveredModule = {
            moduleId: durableSnapshot.moduleId,
            binding: { ...durableSnapshot.binding },
            revision: durableSnapshot.revision,
            permissions: durableSnapshot.permissions,
            taskPath: durableSnapshot.taskPath ?? resolved?.taskPath,
            workspace: durableSnapshot.workspace ?? resolved?.workspace,
          };
        } else if (resolved) {
          recoveredModule = {
            moduleId: resolved.moduleId,
            binding: resolved.binding,
            revision: resolved.revision,
            permissions: resolved.permissions,
            ...(resolved.taskPath ? { taskPath: resolved.taskPath } : {}),
            ...(resolved.workspace ? { workspace: resolved.workspace } : {}),
          };
        }
        } // end non-task-handoff recovery branch
        if (recoveredModule) {
          const before = targets.length;
          targets = targets.filter((member) => member.id === recoveredModule!.binding.contactId);
          if (targets.length === 0 && before > 0) {
            this.host.noteWorkflowModuleUnavailable(
              room.id, row.id, recoveredModule.moduleId,
              `recovered host target is not the bound ${recoveredModule.moduleId} contact ${recoveredModule.binding.contactId}`,
            );
            this.writeRoomDispatchState(row.id, {
              status: 'error',
              completedAt: new Date().toISOString(),
              error: 'recovered targets are not bound to the applicable workflow module',
            });
            continue;
          }
        }
        const options: ScheduledRoomDispatchOptions = {
          targetOverride: targets,
          capture: false,
          userMessageId: row.id,
          roomHostTargetIds: targetIds,
          ...(Number.isFinite(Number(deferred.reactionRounds))
            ? { reactionRounds: Number(deferred.reactionRounds) }
            : {}),
          ...(deferred.coordinationDomain === true ? { coordinationDomain: true } : {}),
          ...(coordination ? { coordination } : {}),
          ...(recoveredModule ? { workflowModule: recoveredModule } : {}),
          ...(deferredTaskHandoff ? { taskHandoff: deferredTaskHandoff } : {}),
          ...(deferredCallbackRef ? { taskCallback: deferredCallbackRef } : {}),
        };
        if (deployResume) {
          this.deployResumeClaims.add(row.id);
          this.markDeployResumeQueued(row);
        } else {
          this.writeRoomDispatchState(row.id, {
            status: 'dispatching',
            recoveredAt: new Date().toISOString(),
          });
        }
        const completion = this.host.scheduleRoomRound(room, targets, options);
        // B2: recovery replays reconcile the dispatch ledger for task refs,
        // so a post-recovery provider failure stays explicitly retryable to
        // the same captured scope/recipient instead of stuck posted.
        const recoveryLedgerKey = deferredTaskHandoff
          ? `task-handoff:v1:${deferredTaskHandoff.handoffId}`
          : deferredCallbackRef
            ? `task-callback:v1:${deferredCallbackRef.jobId}`
            : null;
        const recoveryLedgerKind = deferredTaskHandoff ? 'handoff' : 'callback';
        const recoveryTarget = recoveredModule ? recoveredModule.binding.contactId : targetIds[0] ?? '';
        if (recoveryLedgerKey) {
          const dbRef = this.deps.db;
          const keyRef = recoveryLedgerKey;
          const kindRef = recoveryLedgerKind;
          const targetRef = recoveryTarget;
          const messageRef = row.id;
          void completion.then(
            (stats) => {
              const errors = Number((stats as { normal?: Record<string, number> })?.normal?.error ?? 0);
              markTaskDispatch(dbRef, keyRef, kindRef, errors > 0 ? 'failed' : 'posted',
                messageRef, targetRef,
                errors > 0 ? 'recovery round model error; explicit retry available' : 'recovered-ok');
            },
            () => {
              markTaskDispatch(dbRef, keyRef, kindRef, 'failed', messageRef, targetRef,
                'recovery round threw; explicit retry available');
            },
          );
        }
        void completion.then(
          (outcome) => this.finishRecoveredRoomDispatch(row.id, row.sender, 'done', outcome),
          (error) => this.finishRecoveredRoomDispatch(row.id, row.sender, 'error', error),
        ).finally(() => this.deployResumeClaims.delete(row.id));
        recovered++;
      } catch (error) {
        this.deployResumeClaims.delete(row.id);
        this.deps.logger?.error(
          { component: 'room-drain', messageId: row.id, err: error },
          'deferred room dispatch recovery failed; keeping it durable for retry',
        );
      }
    }
    return recovered;
  }

  private markDeployResumeQueued(row: { id: number; meta: string }): void {
    let meta: Record<string, any> = {};
    try { meta = JSON.parse(row.meta || '{}'); } catch {}
    const queuedAt = new Date().toISOString();
    const next = {
      ...meta,
      roomDispatch: {
        ...(meta.roomDispatch ?? {}),
        status: 'resume-queued',
        dispatchClass: 'resume',
        resumeQueued: true,
        resumeQueuedAt: queuedAt,
      },
      ...(meta.roomHost ? {
        roomHost: { ...meta.roomHost, status: 'queued', resumeQueued: true, resumeQueuedAt: queuedAt },
      } : {}),
    };
    this.deps.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(next), row.id);
    const source = this.deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id);
    this.deps.sse.broadcast('message', source);

    const errors = this.deps.db.prepare(
      `SELECT * FROM messages
       WHERE json_extract(meta, '$.interruptionReason') = 'deploy-restart'
         AND json_extract(meta, '$.replaySourceMessageId') = ?`,
    ).all(row.id) as Array<{ id: number; meta: string }>;
    for (const error of errors) {
      let errorMeta: Record<string, unknown> = {};
      try { errorMeta = JSON.parse(error.meta || '{}'); } catch {}
      this.deps.db.prepare('UPDATE messages SET content = ?, meta = ? WHERE id = ?').run(
        '部署重启中断，已排队续跑',
        JSON.stringify({ ...errorMeta, resumeQueued: true, resumeQueuedAt: queuedAt }),
        error.id,
      );
      const updated = this.deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(error.id);
      this.deps.sse.broadcast('message', updated);
    }
  }

  finishRecoveredRoomDispatch(
    messageId: number,
    sender: string,
    status: 'done' | 'error',
    detail: unknown,
  ): void {
    const row = this.deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
      | { meta: string }
      | undefined;
    if (!row) return;
    let meta: Record<string, any> = {};
    try { meta = JSON.parse(row.meta || '{}'); } catch {}
    const roomDispatch = {
      ...(meta.roomDispatch ?? {}),
      status,
      completedAt: new Date().toISOString(),
      ...(status === 'error'
        ? { error: detail instanceof Error ? detail.message.slice(0, 500) : String(detail).slice(0, 500) }
        : {}),
    };
    const roomHost = sender === 'room-host'
      ? {
          ...(meta.roomHost ?? {}),
          status,
          completedAt: new Date().toISOString(),
          ...(status === 'done' ? { outcome: detail } : { error: roomDispatch.error }),
        }
      : meta.roomHost;
    const next = { ...meta, roomDispatch, ...(roomHost ? { roomHost } : {}) };
    this.deps.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(next), messageId);
    const updated = this.deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    this.deps.sse.broadcast('message', updated);
  }
}
