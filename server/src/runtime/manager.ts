import path from 'node:path';
import {
  type MemoryConfig,
  isWorkflowOnlyEnabled,
  type ContactRow,
  type MessageOrigin,
} from '../platform/index.js';
import { maybeCapture } from '../memory/index.js';
import { maybeWriteBackTask } from '../tasks/index.js';
import { contactConfig, openContact } from '../contacts/index.js';
import { Debouncer } from './debouncer.js';
import {
  coordinationAuthorityHolderIds,
  type RoomCoordinationDispatch,
  filterWorkflowRoomTargets,
  parseRoomTargets,
  roomDirectlyMentions,
} from '../rooms/index.js';
import { AgentRuntime, type AgentDeps, type RoomModuleContext, type RoomTurnOutcome } from './runtime.js';
import { SessionRepo } from './sessionRepo.js';
import {
  WORKFLOW_MODULES,
  WORKFLOW_MODULE_IDS,
  isOpenGovernance,
  isWorkflowRoomConfig,
  runnerForBackend,
  type ModuleBinding,
  type ModulePermissions,
  type WorkflowModuleId,
  moduleBindingHash,
  resolveWorkflowOrchestratorId,
  validateCapturedSnapshot,
} from '../workflow/index.js';
import { RoomTaskStore } from '../roomTasks/index.js';
import type { HeartbeatActivity } from '../devices/index.js';
import type { TurnInterruptionReason } from '../backends/index.js';
import { RoomDispatchDrain } from './roomDispatchDrain.js';
import { RoomDispatchRecovery } from './roomDispatchRecovery.js';

export { AgentRuntime } from './runtime.js';
export type { RoomTurnOutcome } from './runtime.js';

/** Base runtime key without the module suffix (`room:member` or DM id). */
function baseRuntimeKey(key: string): string {
  const cut = key.indexOf('::');
  return cut < 0 ? key : key.slice(0, cut);
}

/** True when a runtime key belongs to the contact (DM, room, or module-scoped). */
function runtimeKeyTargetsContact(key: string, contactId: string): boolean {
  const base = baseRuntimeKey(key);
  return base === contactId || base.endsWith(`:${contactId}`);
}

interface InvalidationPayload {
  contact: ContactRow;
  affectedFromId: number;
}

export interface RoomRoundStats {
  normal: Record<RoomTurnOutcome, number>;
  reactions: Array<Record<RoomTurnOutcome, number>>;
}

export interface RoomDispatchOptions {
  targetOverride?: ContactRow[];
  capture?: boolean;
  reactionRounds?: number;
  userMessageId?: number;
  /**
   * Coordination-domain host rounds only: reaction participants are filtered to
   * coordination_authority holders; non-holders are counted as passed with no
   * model wake. Leave unset for idea/social rooms so reactions stay unchanged.
   */
  coordinationDomain?: boolean;
  /** Optional structured dispatch; widens authority beyond orchestrator alone. */
  coordination?: RoomCoordinationDispatch;
  /**
   * Trusted host paths may name the applicable fixed module explicitly.
   * Ordinary user messages always resolve to the plan module.
   */
  moduleId?: string;
  /**
   * Model-driven task handoff transport: references the durable handoff row.
   * Verified server-side against room_tasks/room_task_handoffs on every
   * dispatch (frozen captured snapshot wins over live bindings). Never parsed
   * from message text — ordinary model text cannot forge it.
   */
  taskHandoff?: { taskId: string; handoffId: string };
  /**
   * Model-driven task callback transport: references the durable explicit
   * callback registration (frozen return module/contact/binding). Verified
   * server-side on every dispatch, including drain recovery.
   */
  taskCallback?: { taskId: string; jobId: string };
}

export interface ScheduledRoomDispatchOptions extends RoomDispatchOptions {
  directMentionTargetIds?: string[];
  roomHostTargetIds?: string[];
  /** Captured module invocation: new turns use it, never mutated live config. */
  workflowModule?: {
    moduleId: WorkflowModuleId;
    binding: ModuleBinding;
    revision: number;
    permissions: ModulePermissions;
    taskPath?: string;
    workspace?: string;
    taskId?: string;
    handoffId?: string;
    callbackJobId?: string;
  };
}

export interface TrackedRoomDispatch {
  targets: string[];
  completion: Promise<RoomRoundStats>;
  deferred?: boolean;
}

export class AgentManager {
  private runtimes = new Map<string, AgentRuntime>();

  private readonly sessions: SessionRepo;
  private readonly invalidations: Debouncer<string, InvalidationPayload>;
  private readonly roomDispatchDrain = new RoomDispatchDrain();
  private roomRoundsInFlight = 0;
  private activeRoomDispatchSourceIds = new Set<number>();
  private readonly dispatchRecovery: RoomDispatchRecovery;

  constructor(private deps: AgentDeps) {
    this.sessions = new SessionRepo(deps.db);
    this.invalidations = new Debouncer(
      300,
      (previous, next) => ({
        contact: next.contact,
        affectedFromId:
          previous.affectedFromId > 0 && next.affectedFromId > 0
            ? Math.min(previous.affectedFromId, next.affectedFromId)
            : previous.affectedFromId === 0 || next.affectedFromId === 0
              ? 0
              : next.affectedFromId || previous.affectedFromId || 0,
      }),
      async ({ contact, affectedFromId }) => this.invalidateNow(contact, affectedFromId)
    );
    // 回调在调用时才取实例方法（不在这里 bind）：smoke 替换掉的 scheduleRoomRound 照样生效。
    this.dispatchRecovery = new RoomDispatchRecovery(deps, {
      roomMembers: (room) => this.roomMembers(room),
      verifyTaskHandoff: (room, ref) => this.verifyTaskHandoff(room, ref),
      verifyTaskCallback: (room, ref) => this.verifyTaskCallback(room, ref),
      resolveWorkflowModule: (room, userMessageId) => this.resolveWorkflowModule(room, userMessageId),
      noteWorkflowModuleUnavailable: (roomId, triggerId, moduleId, detail) =>
        this.noteWorkflowModuleUnavailable(roomId, triggerId, moduleId, detail),
      scheduleRoomRound: (room, targets, options) => this.scheduleRoomRound(room, targets, options),
    });
  }

  attachHeartbeat(heartbeat: HeartbeatActivity): void {
    this.deps.heartbeat = heartbeat;
  }

  /** DM runtime。 */
  get(contact: ContactRow): AgentRuntime {
    contact = openContact(contact);
    let rt = this.runtimes.get(contact.id);
    if (!rt) {
      rt = new AgentRuntime(contact, contact, this.deps);
      this.runtimes.set(contact.id, rt);
    }
    return rt;
  }

  /** 群成员 runtime。 */
  getRoomMember(room: ContactRow, member: ContactRow, moduleCtx?: RoomModuleContext | null): AgentRuntime {
    room = openContact(room);
    member = openContact(member);
    const key = moduleCtx?.moduleId
      ? `${room.id}:${member.id}::${moduleCtx.moduleId}::${moduleBindingHash(moduleCtx)}`
      : `${room.id}:${member.id}`;
    let rt = this.runtimes.get(key);
    if (!rt) {
      rt = new AgentRuntime(room, member, this.deps, moduleCtx ?? null);
      this.runtimes.set(key, rt);
      // Hot-swap hygiene: retire idle runtimes of the same room/member/module
      // that captured an older binding. Busy ones finish their active turn
      // first and are swept on the next dispatch.
      if (moduleCtx?.moduleId) {
        const prefix = `${room.id}:${member.id}::${moduleCtx.moduleId}::`;
        for (const [otherKey, other] of [...this.runtimes]) {
          if (otherKey !== key && otherKey.startsWith(prefix) && other.state === 'idle') {
            this.runtimes.delete(otherKey);
            void other.stop();
          }
        }
      }
    }
    return rt;
  }

  private roomMembers(room: ContactRow): ContactRow[] {
    const cfg = contactConfig(room);
    const ids: string[] = Array.isArray(cfg.members) ? cfg.members : [];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.deps.db
      .prepare(
        `SELECT * FROM contacts WHERE id IN (${placeholders}) AND enabled = 1 AND kind = 'dm'`
      )
      .all(...ids).map((row) => openContact(row as ContactRow));
  }

  /** 点名解析：@名字/@id/@all；模型消息里的 @ 一律不算（只处理 user 消息）。 */
  parseTargets(room: ContactRow, content: string): ContactRow[] {
    const members = this.roomMembers(room);
    return parseRoomTargets(members, content, contactConfig(room));
  }

  private roomChains = new Map<string, Promise<void>>();

  /** 用户在群里发言 → 顺序点名轮 + 接话轮（输出不互相触发，轮数硬上限）。
   *  记忆捕捉在这里做且只做一次：只看 User 的原话，成员发言永不参与。 */
  imageRoomMembers(room: ContactRow): ContactRow[] {
    return this.roomMembers(room);
  }

  /**
   * Fixed-module resolution for workflow rooms (config.workflowEnabled or the
   * existing coordination object). Returns null for social rooms/DMs, which
   * keep legacy behavior untouched.
   *
   * Snapshot rule (immutable room snapshot):
   * - explicit trusted moduleId (host paths) or ordinary intake -> CURRENT
   *   binding: these are NEW turns, hot swaps apply.
   * - a room-host source row carrying a complete captured workflowModule ->
   *   the CAPTURED binding: in-flight rounds keep their snapshot even after
   *   a hot swap. The source row is scoped to THIS room (contact_id match).
   * - an older room-host coordination dispatch without a capture -> CURRENT
   *   binding for its applicable module.
   * Ordinary intake always resolves to plan; structured trusted host events
   * resolve to their applicable module.
   */
  private resolveWorkflowModule(
    room: ContactRow,
    userMessageId?: number,
    explicitModuleId?: string,
  ): {
    moduleId: WorkflowModuleId;
    binding: ModuleBinding;
    revision: number;
    permissions: ModulePermissions;
    taskPath?: string;
    workspace?: string;
    pinned: boolean;
  } | null {
    const store = this.deps.jobStore?.workflowModules;
    if (!store) return null;
    let cfg: Record<string, unknown>;
    try {
      cfg = contactConfig(room) as unknown as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!isWorkflowRoomConfig(cfg)) return null;
    const openPlanWrite = isOpenGovernance(cfg) && (cfg as { planWrite?: unknown }).planWrite === true;
    const current = (moduleId: WorkflowModuleId) => {
      const invocation = store.invoke(moduleId, '', '');
      // O3: plan write:false is a default in open rooms; an explicit room
      // planWrite flag lifts it (task-level grants ride the frozen handoff
      // snapshot instead). Worker boundaries still apply downstream.
      const permissions = moduleId === 'plan' && openPlanWrite
        ? { ...invocation.permissions, write: true }
        : invocation.permissions;
      return {
        moduleId,
        binding: invocation.binding,
        revision: invocation.bindingRevision,
        permissions,
        pinned: false as const,
      };
    };
    if (explicitModuleId && (WORKFLOW_MODULE_IDS as readonly string[]).includes(explicitModuleId)) {
      return current(explicitModuleId as WorkflowModuleId);
    }
    if (typeof userMessageId === 'number') {
      try {
        // Room-scoped: a forged or moved message id from another chat can
        // never supply authority here.
        const source = this.deps.db.prepare(
          'SELECT sender, meta FROM messages WHERE id = ? AND contact_id = ?',
        ).get(userMessageId, room.id) as { sender: string; meta: string } | undefined;
        if (source?.sender === 'room-host') {
          const meta = JSON.parse(source.meta || '{}') as {
            roomHost?: {
              workflowModule?: unknown;
              coordination?: { kind?: unknown; taskPath?: unknown; workspace?: unknown };
              reviewBatchFlush?: unknown;
              reviewBatch?: unknown;
            };
          };
          const captured = validateCapturedSnapshot(meta.roomHost?.workflowModule);
          if (captured && captured.policyVersion === 1) {
            const permissions = { ...captured.permissions };
            const coordination = meta.roomHost?.coordination;
            return {
              moduleId: captured.moduleId,
              binding: { ...captured.binding },
              revision: captured.revision,
              permissions,
              taskPath: captured.taskPath ?? (typeof coordination?.taskPath === 'string' ? coordination.taskPath : undefined),
              workspace: captured.workspace ?? (typeof coordination?.workspace === 'string' ? coordination.workspace : undefined),
              pinned: true as const,
            };
          }
          const coordination = meta.roomHost?.coordination;
          const kind = coordination?.kind;
          const taskPath = typeof coordination?.taskPath === 'string' ? coordination.taskPath : undefined;
          const workspace = typeof coordination?.workspace === 'string' ? coordination.workspace : undefined;
          const mapped = kind === 'execution' ? 'execute' : kind === 'verification' ? 'review' : 'plan';
          const resolved = current(mapped);
          return { ...resolved, ...(taskPath ? { taskPath } : {}), ...(workspace ? { workspace } : {}) };
        }
      } catch { /* fall back to plan */ }
    }
    return current('plan');
  }

  /**
   * O3 open-governance: resolve an User @<member> mention to the module that
   * member currently holds. Returns null when no member is directly mentioned
   * or the mentioned member holds no module (bare messages stay on plan).
   */
  private resolveOpenDirectModule(
    room: ContactRow,
    content: string,
  ): {
    moduleId: WorkflowModuleId;
    binding: ModuleBinding;
    revision: number;
    permissions: ModulePermissions;
    pinned: boolean;
  } | null {
    try {
      const store = this.deps.jobStore?.workflowModules;
      if (!store) return null;
      const members = this.imageRoomMembers(room);
      if (!members.length) return null;
      const mentioned = members.filter((member) => roomDirectlyMentions(member, content));
      if (!mentioned.length) return null;
      const bindings = store.bindings();
      const revision = store.revision();
      for (const member of mentioned) {
        for (const moduleId of WORKFLOW_MODULE_IDS) {
          const binding = bindings[moduleId];
          if (binding?.contactId === member.id) {
            const invocation = store.invoke(moduleId, '', '');
            return {
              moduleId,
              binding: invocation.binding,
              revision: invocation.bindingRevision || revision,
              permissions: invocation.permissions,
              pinned: false as const,
            };
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * SHOULD-a: an User @<member> direct wake is a model wake like any other.
   * When the message names room tasks (tasks/<name>.md), count one wake per
   * task against its daily budget (exhaustion auto-blocks, surfaced to User).
   * SHOULD-a2: a bare colloquial wake (@muse 再跑一次, no task path) counts
   * against every open task currently held by that module (same task counted
   * once via the seen set). A module holding nothing and naming nothing is a
   * true idle chat and counts nowhere. Best-effort: never blocks or fails
   * intake.
   */
  private countOpenDirectWake(roomId: string, content: string, moduleId: string): void {
    try {
      const jobs = this.deps.jobStore;
      if (!jobs) return;
      const store = new RoomTaskStore(this.deps.db, jobs, this.deps.taskDispatch ?? null);
      const seen = new Set<string>();
      for (const match of content.matchAll(/(?:^|[^\w/-])tasks\/([^/\s\\]{1,100}\.md)/gi)) {
        const taskPath = `tasks/${match[1]}`.replace(/[),.;:!?'"\]]+$/, '');
        if (!taskPath || seen.has(taskPath)) continue;
        seen.add(taskPath);
        try {
          store.countMentionWake(roomId, taskPath, 'User', moduleId);
        } catch { /* best-effort */ }
      }
      try {
        for (const held of store.openTasksHeldBy(roomId, moduleId)) {
          if (!held.task_path || seen.has(held.task_path)) continue;
          seen.add(held.task_path);
          try {
            store.countMentionWake(roomId, held.task_path, 'User', moduleId);
          } catch { /* best-effort */ }
        }
      } catch { /* best-effort */ }
    } catch { /* best-effort */ }
  }

  /**
   * Verify a model-driven task handoff reference against the durable ledger
   * and return the FROZEN captured snapshot. Fail-closed: unknown task,
   * cross-room reference, decided/superseded handoff, malformed snapshot, or
   * a recipient that is no longer a room member all yield null (the dispatch
   * is refused, never re-resolved live). A global revision bump for unrelated
   * modules does NOT invalidate the snapshot; only the captured contact still
   * holding the target role matters (checked by the ledger at accept time).
   */
  private verifyTaskHandoff(
    room: ContactRow,
    ref: { taskId: string; handoffId: string },
  ): {
    moduleId: WorkflowModuleId;
    binding: ModuleBinding;
    revision: number;
    permissions: ModulePermissions;
    taskPath?: string;
    workspace?: string;
    taskId: string;
    handoffId: string;
    pinned: boolean;
  } | null {
    try {
      const ledger = this.deps.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room_task_handoffs'",
      ).get() as { 1?: number } | undefined;
      if (!ledger) return null;
      const handoff = this.deps.db.prepare(
        'SELECT * FROM room_task_handoffs WHERE id = ?',
      ).get(ref.handoffId) as Record<string, unknown> | undefined;
      const task = handoff
        ? this.deps.db.prepare('SELECT * FROM room_tasks WHERE id = ?').get(String(handoff.task_id)) as Record<string, unknown> | undefined
        : undefined;
      if (!handoff || !task) return null;
      if (String(handoff.task_id) !== ref.taskId || String(task.id) !== ref.taskId) return null;
      if (String(task.room_id) !== room.id) return null;
      if (!['pending', 'accepted'].includes(String(handoff.status))) return null;
      // Completion handoffs retain their source attempt's fence at the wake
      // layer as well; a deferred/retried old edge cannot revive a takeover.
      const fencedReturn = this.deps.db.prepare(`SELECT 1 FROM room_task_completion_handoffs c
        JOIN workflow_module_takeovers f ON f.old_job_id = c.job_id WHERE c.handoff_id = ?`)
        .get(ref.handoffId);
      if (fencedReturn) return null;
      const moduleId = String(handoff.to_module);
      if (!(WORKFLOW_MODULE_IDS as readonly string[]).includes(moduleId)) return null;
      let binding: unknown = null;
      let permissions: unknown = null;
      try {
        binding = JSON.parse(String(handoff.to_binding ?? '{}'));
        permissions = JSON.parse(String(handoff.to_permissions ?? '{}'));
      } catch { return null; }
      const bound = binding as Record<string, unknown>;
      const perms = permissions as Record<string, unknown>;
      if (typeof bound.contactId !== 'string' || !bound.contactId
        || typeof bound.runner !== 'string' || !bound.runner
        || typeof bound.model !== 'string' || !bound.model
        || typeof bound.reasoning !== 'string' || !bound.reasoning) return null;
      if (['write', 'shell', 'ssh'].some((key) => typeof perms[key] !== 'boolean')) return null;
      const members = this.roomMembers(room);
      if (!members.some((member) => member.id === bound.contactId)) return null;
      const definition = WORKFLOW_MODULES.find((item) => item.id === moduleId)!;
      const narrowed = {
        write: perms.write === true && definition.permissions.write,
        shell: perms.shell === true && definition.permissions.shell,
        ssh: perms.ssh === true && definition.permissions.ssh,
      };
      const revision = Number(handoff.to_revision);
      if (!Number.isSafeInteger(revision) || revision <= 0) return null;
      return {
        moduleId: moduleId as WorkflowModuleId,
        binding: {
          contactId: bound.contactId,
          runner: bound.runner as ModuleBinding['runner'],
          model: bound.model,
          reasoning: bound.reasoning,
        },
        revision,
        permissions: narrowed,
        taskPath: typeof task.task_path === 'string' ? task.task_path : undefined,
        workspace: typeof handoff.approved_workspace === 'string' && handoff.approved_workspace
          ? handoff.approved_workspace
          : undefined,
        taskId: String(task.id),
        handoffId: String(handoff.id),
        pinned: true as const,
      };
    } catch {
      return null;
    }
  }

  /**
   * Verify a model-driven task callback reference against the durable
   * EXPLICIT callback registration and return its FROZEN snapshot.
   * Fail-closed like handoffs. Rebinds after registration never reroute the
   * callback: the executor chose this recipient at start time.
   */
  private verifyTaskCallback(
    room: ContactRow,
    ref: { taskId: string; jobId: string },
  ): {
    moduleId: WorkflowModuleId;
    binding: ModuleBinding;
    revision: number;
    permissions: ModulePermissions;
    taskPath?: string;
    workspace?: string;
    taskId: string;
    callbackJobId: string;
    pinned: boolean;
  } | null {
    try {
      const ledger = this.deps.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'room_task_callbacks'",
      ).get() as { 1?: number } | undefined;
      if (!ledger) return null;
      const callback = this.deps.db.prepare(
        'SELECT * FROM room_task_callbacks WHERE job_id = ?',
      ).get(ref.jobId) as Record<string, unknown> | undefined;
      const task = callback
        ? this.deps.db.prepare('SELECT * FROM room_tasks WHERE id = ?').get(String(callback.task_id)) as Record<string, unknown> | undefined
        : undefined;
      if (!callback || !task) return null;
      if (String(callback.task_id) !== ref.taskId || String(task.id) !== ref.taskId) return null;
      if (String(task.room_id) !== room.id) return null;
      // Fence: a taken-over attempt's callback reference is dead at the
      // manager layer too, so neither fresh dispatches nor drain replays can
      // wake it. The replacement job carries its own callback row/job id.
      try {
        const fenced = this.deps.db.prepare(
          'SELECT 1 FROM workflow_module_takeovers WHERE old_job_id = ?',
        ).get(ref.jobId) as { 1?: number } | undefined;
        if (fenced) return null;
      } catch {
        return null;
      }
      const moduleId = String(callback.return_module);
      if (!(WORKFLOW_MODULE_IDS as readonly string[]).includes(moduleId)) return null;
      let binding: unknown = null;
      let permissions: unknown = null;
      try {
        binding = JSON.parse(String(callback.return_binding ?? '{}'));
        permissions = JSON.parse(String(callback.return_permissions ?? '{}'));
      } catch { return null; }
      const bound = binding as Record<string, unknown>;
      const perms = permissions as Record<string, unknown>;
      if (typeof bound.contactId !== 'string' || !bound.contactId
        || typeof bound.runner !== 'string' || !bound.runner
        || typeof bound.model !== 'string' || !bound.model
        || typeof bound.reasoning !== 'string' || !bound.reasoning) return null;
      if (bound.contactId !== String(callback.return_contact)) return null;
      if (['write', 'shell', 'ssh'].some((key) => typeof perms[key] !== 'boolean')) return null;
      const members = this.roomMembers(room);
      if (!members.some((member) => member.id === bound.contactId)) return null;
      const definition = WORKFLOW_MODULES.find((item) => item.id === moduleId)!;
      const narrowed = {
        write: perms.write === true && definition.permissions.write,
        shell: perms.shell === true && definition.permissions.shell,
        ssh: perms.ssh === true && definition.permissions.ssh,
      };
      const revision = Number(callback.return_revision);
      if (!Number.isSafeInteger(revision) || revision <= 0) return null;
      return {
        moduleId: moduleId as WorkflowModuleId,
        binding: {
          contactId: bound.contactId,
          runner: bound.runner as ModuleBinding['runner'],
          model: bound.model,
          reasoning: bound.reasoning,
        },
        revision,
        permissions: narrowed,
        taskPath: typeof task.task_path === 'string' ? task.task_path : undefined,
        workspace: typeof task.approved_workspace === 'string' && task.approved_workspace
          ? task.approved_workspace
          : undefined,
        taskId: String(task.id),
        callbackJobId: ref.jobId,
        pinned: true as const,
      };
    } catch {
      return null;
    }
  }

  /** Missing/unavailable module stage surfaces a specific room state instead of blanking the room. */
  private noteWorkflowModuleUnavailable(
    roomId: string,
    triggerId: number | undefined,
    moduleId: string,
    detail: string,
  ): void {
    const key = `module-unavailable:v1:${triggerId ?? 'adhoc'}:${moduleId}`;
    try {
      const dup = this.deps.db.prepare(
        'SELECT id FROM messages WHERE contact_id = ? AND idempotency_key = ? LIMIT 1',
      ).get(roomId, key) as { id: number } | undefined;
      if (dup) return;
      const content = `【workflow 模块不可用】${moduleId} 当前无法接管（${detail}）；房间其他流程不受影响。`;
      const result = this.deps.db.prepare(
        `INSERT INTO messages
          (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
         VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main', ?)`,
      ).run(roomId, content, JSON.stringify({
        event: 'workflow-module-unavailable',
        moduleId,
        detail: detail.slice(0, 500),
      }), key);
      const row = this.deps.db.prepare('SELECT * FROM messages WHERE id = ?')
        .get(Number(result.lastInsertRowid));
      this.deps.sse.broadcast('message', row);
    } catch (error) {
      this.deps.logger?.error(
        { component: 'room', roomId, moduleId, err: error },
        'workflow unavailable note failed; room continues without it',
      );
    }
  }

  dispatchRoomMessage(
    room: ContactRow,
    content: string,
    targetOverride?: ContactRow[],
    userMessageId?: number
  ): string[] {
    return this.dispatchRoomMessageTracked(room, content, { targetOverride, userMessageId }).targets;
  }

  dispatchRoomMessageTracked(
    room: ContactRow,
    content: string,
    options: RoomDispatchOptions = {}
  ): TrackedRoomDispatch {
    // Fixed-module pre-call filter for workflow rooms: unbound reserve agents
    // never wake (ordinary messages, @all, reactions, receipts alike) and a
    // bound agent wakes only for its APPLICABLE module — never merely for
    // holding some other binding. The captured binding rides the whole round
    // so hot swaps affect only NEW turns.
    //
    // Model-driven task refs resolve from verified durable rows (frozen
    // snapshots), never from live bindings and never from text.
    const taskHandoff = options.taskHandoff;
    const taskCallback = options.taskCallback;
    let workflow = taskHandoff
      ? this.verifyTaskHandoff(room, taskHandoff)
      : taskCallback
        ? this.verifyTaskCallback(room, taskCallback)
        : this.resolveWorkflowModule(room, options.userMessageId, options.moduleId);
    if (taskHandoff && !workflow) {
      this.noteWorkflowModuleUnavailable(
        room.id, options.userMessageId, 'task-handoff',
        'durable handoff verification failed (unknown, cross-room, decided, or rebound recipient); refusing instead of re-resolving',
      );
      return {
        targets: [],
        completion: Promise.resolve({
          normal: this.outcomeCounts([]),
          reactions: [],
        }),
      };
    }
    if (taskCallback && !workflow) {
      this.noteWorkflowModuleUnavailable(
        room.id, options.userMessageId, 'task-callback',
        'durable callback verification failed (unknown, cross-room, or departed recipient); refusing instead of re-resolving',
      );
      return {
        targets: [],
        completion: Promise.resolve({
          normal: this.outcomeCounts([]),
          reactions: [],
        }),
      };
    }
    let targets = options.targetOverride ?? this.parseTargets(room, content);
    let workflowModule: ScheduledRoomDispatchOptions['workflowModule'];
    if (workflow) {
      const poolBlock = this.deps.workflowPoolBlocked?.(workflow.binding.runner);
      if (typeof poolBlock === 'string' && poolBlock) {
        // Quota/auth/runner pool blocked: surface it, instantiate nothing.
        // Unknown quota never blocks (the callback stays silent for it).
        this.noteWorkflowModuleUnavailable(
          room.id, options.userMessageId, workflow.moduleId,
          `credential pool blocked: ${poolBlock}`,
        );
        targets = [];
      } else {
        const members = this.imageRoomMembers(room);
        const memberIds = new Set(members.map((member) => member.id));
        if (options.targetOverride) {
          // Trusted host targeting still cannot wake anyone except the
          // applicable module's bound contact — not other bound modules,
          // not unbound reserves.
          targets = filterWorkflowRoomTargets(options.targetOverride, content, new Set([workflow.binding.contactId]))
            .filter((member) => memberIds.has(member.id));
          if (targets.length === 0) {
            this.noteWorkflowModuleUnavailable(
              room.id, options.userMessageId, workflow.moduleId,
              `host target is not the bound ${workflow.moduleId} contact ${workflow.binding.contactId}`,
            );
          }
        } else {
          // O3 open-governance: User @<member> wakes that member under its
          // currently held module; bare messages fall back to plan.
          // Strict rooms keep plan-only intake.
          const roomCfg = (() => {
            try {
              return contactConfig(room) as unknown as Record<string, unknown>;
            } catch {
              return {};
            }
          })();
          if (!taskHandoff && !taskCallback && !options.moduleId && isOpenGovernance(roomCfg)) {
            const direct = this.resolveOpenDirectModule(room, content);
            if (direct) {
              workflow = direct;
              this.countOpenDirectWake(room.id, content, direct.moduleId);
            }
          }
          // Ordinary intake goes to the plan module only; @all cannot override.
          // (User-authored messages always resolve to plan above; open rooms
          // may have retargeted `workflow` to the @-mentioned member above.)
          const boundId = workflow.binding.contactId;
          const planMember = members.find((member) => member.id === boundId);
          if (!planMember) {
            this.noteWorkflowModuleUnavailable(
              room.id, options.userMessageId, 'plan',
              `bound contact ${boundId} is not a room member`,
            );
            targets = [];
          } else {
            targets = filterWorkflowRoomTargets(members, content, new Set([boundId]));
          }
        }
      }
      workflowModule = {
        moduleId: workflow.moduleId,
        binding: workflow.binding,
        revision: workflow.revision,
        permissions: workflow.permissions,
        ...(workflow.taskPath ? { taskPath: workflow.taskPath } : {}),
        ...(workflow.workspace ? { workspace: workflow.workspace } : {}),
        ...('taskId' in workflow && workflow.taskId ? { taskId: workflow.taskId as string } : {}),
        ...('handoffId' in workflow && workflow.handoffId ? { handoffId: workflow.handoffId as string } : {}),
        ...('callbackJobId' in workflow && (workflow as { callbackJobId?: string }).callbackJobId
          ? { callbackJobId: (workflow as { callbackJobId: string }).callbackJobId }
          : {}),
      };
    }

    const roomCfg = contactConfig(room);
    const mem: MemoryConfig = { ...this.deps.config.memory, ...(roomCfg.memory ?? {}) };
    // Workflow-only master: room intake capture/writeback DS stays off even
    // with room/global mem.capture=true. Formal receipts/outbox untouched.
    if (!isWorkflowOnlyEnabled(this.deps.config) && options.capture !== false && this.deps.vault && mem.capture) {
      const contact = { id: room.id, name: room.name };
      const log = (message: string) => this.deps.logger?.info(
        { component: 'memory.capture', roomId: room.id },
        message
      );
      const writeback = typeof options.userMessageId === 'number'
        ? maybeWriteBackTask(
            this.deps.db,
            this.deps.vault,
            this.deps.config.memory.repoPath
              ? path.join(this.deps.config.memory.repoPath, 'tasks')
              : null,
            contact,
            options.userMessageId,
            content,
            log
          )
        : Promise.resolve({ status: 'ignored' as const });
      void writeback.then((outcome) => {
        if (!['ignored', 'rejected', 'ambiguous'].includes(outcome.status)) return;
        return maybeCapture(this.deps.vault!, contact, content, '', log);
      }).catch((error) => log(
        `task writeback pipeline failed: ${error instanceof Error ? error.message : String(error)}`
      ));
    }
    if (targets.length === 0) {
      return {
        targets: [],
        completion: Promise.resolve({
          normal: this.outcomeCounts([]),
          reactions: [],
        }),
      };
    }

    const targetIds = targets.map((target) => target.id);
    const source = typeof options.userMessageId === 'number'
      ? this.deps.db.prepare('SELECT sender, content, meta FROM messages WHERE id = ?').get(options.userMessageId) as
          | { sender: string; content: string; meta: string }
          | undefined
      : undefined;
    const directMentionTargetIds = source?.sender === 'user'
      ? targets.filter((target) => roomDirectlyMentions(target, source.content)).map((target) => target.id)
      : [];
    let roomHostTargetIds: string[] = [];
    if (source?.sender === 'room-host') {
      try {
        const meta = JSON.parse(source.meta || '{}') as { roomHost?: { targets?: unknown } };
        roomHostTargetIds = Array.isArray(meta.roomHost?.targets)
          ? meta.roomHost.targets.map(String)
          : [];
      } catch {}
    }
    const scheduledOptions: ScheduledRoomDispatchOptions = {
      ...options,
      directMentionTargetIds,
      roomHostTargetIds,
      ...(workflowModule ? { workflowModule } : {}),
    };
    const dispatch = () => this.scheduleRoomRound(room, targets, scheduledOptions);
    // 任务账本派单在途时也落 durable 快照（带引用），部署重启后才能校验引用再续跑。
    const taskRef = options.taskHandoff ?? options.taskCallback;
    const durableHostDispatch = typeof options.userMessageId === 'number'
      && (!!taskRef || this.dispatchRecovery.isDeployResumableSource(options.userMessageId));
    try {
      if (this.roomDispatchDrain.isActive()) {
        if (typeof options.userMessageId !== 'number') {
          throw new Error('drain deferral requires a persisted source message id');
        }
        this.dispatchRecovery.writeRoomDispatchState(options.userMessageId, {
          status: 'deferred',
          targetIds,
          reactionRounds: options.reactionRounds,
          coordinationDomain: options.coordinationDomain === true,
          coordination: options.coordination,
          // The captured module snapshot rides the durable state so a
          // post-restart recovery replays the same invocation, not the
          // latest binding. Task handoffs additionally keep their durable
          // row reference so recovery re-verifies the frozen snapshot.
          ...(workflowModule ? { workflowModule } : {}),
          ...(options.taskHandoff ? { taskHandoff: options.taskHandoff } : {}),
          ...(options.taskCallback ? { taskCallback: options.taskCallback } : {}),
          dispatchClass: 'drain',
          deferredAt: new Date().toISOString(),
        });
        const completion = this.roomDispatchDrain.defer(async () => {
          this.dispatchRecovery.writeRoomDispatchState(options.userMessageId!, {
            status: 'dispatching',
            dispatchedAt: new Date().toISOString(),
          });
          return dispatch();
        });
        void completion.then(
          () => this.dispatchRecovery.writeRoomDispatchState(options.userMessageId!, {
            status: 'done',
            completedAt: new Date().toISOString(),
          }),
          (error) => this.dispatchRecovery.writeRoomDispatchState(options.userMessageId!, {
            status: 'error',
            completedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          }),
        );
        return { targets: targetIds, completion, deferred: true };
      }
    } catch (error) {
      // Drain is safety reinforcement, never an event sink. Any guard/storage
      // failure falls back to the pre-drain dispatch behavior.
      this.deps.logger?.error(
        { component: 'room-drain', roomId: room.id, err: error },
        'room drain guard failed open',
      );
    }
    if (durableHostDispatch) {
      this.dispatchRecovery.writeRoomDispatchState(options.userMessageId!, {
        status: 'dispatching',
        targetIds,
        reactionRounds: options.reactionRounds,
        coordinationDomain: options.coordinationDomain === true,
        coordination: options.coordination,
        ...(workflowModule ? { workflowModule } : {}),
        ...(options.taskHandoff ? { taskHandoff: options.taskHandoff } : {}),
        ...(options.taskCallback ? { taskCallback: options.taskCallback } : {}),
        dispatchClass: 'live',
        dispatchedAt: new Date().toISOString(),
      });
    }
    const completion = dispatch();
    if (durableHostDispatch) {
      void completion.then(
        (outcome) => this.dispatchRecovery.finishLiveRoomDispatch(options.userMessageId!, outcome),
        (error) => this.dispatchRecovery.finishRecoveredRoomDispatch(options.userMessageId!, taskRef ? 'system' : 'room-host', 'error', error),
      ).catch((error) => this.deps.logger?.error(
        { component: 'room-dispatch', messageId: options.userMessageId, err: error },
        'live room dispatch state write failed',
      ));
    }
    return { targets: targetIds, completion };
  }

  private scheduleRoomRound(
    room: ContactRow,
    targets: ContactRow[],
    options: ScheduledRoomDispatchOptions,
  ): Promise<RoomRoundStats> {
    // 同一个群的轮次串行：用户连发消息时排队，不交叉。计数覆盖正在跑和
    // 已接纳但排在 roomChains 后面的轮次，部署 drain 才不会漏掉后者。
    this.roomRoundsInFlight++;
    const prev = this.roomChains.get(room.id) ?? Promise.resolve();
    const round = prev.then(async () => {
      const sourceId = options.userMessageId;
      if (typeof sourceId === 'number') this.activeRoomDispatchSourceIds.add(sourceId);
      try {
        return await this.runRoomRound(room, targets, {
          reactionRounds: options.reactionRounds,
          coordinationDomain: options.coordinationDomain,
          coordination: options.coordination,
          userMessageId: options.userMessageId,
          directMentionTargetIds: options.directMentionTargetIds,
          roomHostTargetIds: options.roomHostTargetIds,
          workflowModule: options.workflowModule,
        });
      } finally {
        if (typeof sourceId === 'number') this.activeRoomDispatchSourceIds.delete(sourceId);
      }
    });
    const completion = round.finally(() => { this.roomRoundsInFlight--; });
    this.roomChains.set(
      room.id,
      completion.then(() => undefined).catch((error) =>
        this.deps.logger?.error(
          { component: 'room', roomId: room.id, err: error },
          'room round failed',
        )
      ),
    );
    return completion;
  }

  beginRoomDispatchDrain(): boolean {
    return this.roomDispatchDrain.begin();
  }

  endRoomDispatchDrain(): number {
    return this.roomDispatchDrain.release();
  }

  roomDispatchDraining(): boolean {
    return this.roomDispatchDrain.isActive();
  }

  roomDispatchDrainPendingCount(): number {
    return this.roomDispatchDrain.pendingCount();
  }

  activeRoomRoundCount(): number {
    return this.roomRoundsInFlight;
  }

  recoverDeferredRoomDispatches(): number {
    return this.dispatchRecovery.recoverDeferredRoomDispatches();
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** 一轮群聊：点名成员 normal 并行、按完成顺序落库；reaction 串行，后发言者看得见前人。
   *  多人点名时再跑至多 reactionRounds 轮接话；单人点名只让被点名者回答。 */
  private outcomeCounts(outcomes: RoomTurnOutcome[]): Record<RoomTurnOutcome, number> {
    const counts: Record<RoomTurnOutcome, number> = {
      spoke: 0,
      passed: 0,
      silent: 0,
      error: 0,
    };
    for (const outcome of outcomes) counts[outcome]++;
    return counts;
  }

  private async runRoomRound(
    room: ContactRow,
    targets: ContactRow[],
    options: Pick<ScheduledRoomDispatchOptions, 'reactionRounds' | 'coordinationDomain' | 'coordination' | 'userMessageId' | 'directMentionTargetIds' | 'roomHostTargetIds' | 'workflowModule'> = {}
  ): Promise<RoomRoundStats> {
    const {
      reactionRounds,
      coordinationDomain,
      coordination,
      userMessageId,
      directMentionTargetIds,
      roomHostTargetIds,
      workflowModule,
    } = options;
    if (workflowModule) {
      const blocked = this.deps.workflowPoolBlocked?.(workflowModule.binding.runner);
      if (blocked) {
        this.noteWorkflowModuleUnavailable(room.id, userMessageId, workflowModule.moduleId, blocked);
        return { normal: this.outcomeCounts([]), reactions: [] };
      }
    }
    const replaySourceMessageId = typeof userMessageId === 'number'
      && this.dispatchRecovery.isDeployResumableSource(userMessageId)
      ? userMessageId
      : undefined;
    const moduleCtxFor = (member: ContactRow): RoomModuleContext | null => {
      if (!workflowModule) return null;
      const bound = workflowModule.binding;
      // Backend ids carry a -cli suffix (opencode-cli); runner ids do not.
      // Comparing raw backend strings drops the pinned model for muse/grok.
      const matches = member.id === bound.contactId && runnerForBackend(member.backend) === bound.runner;
      return {
        moduleId: workflowModule.moduleId,
        ...(matches ? { model: bound.model, reasoning: bound.reasoning } : {}),
        bindingRevision: workflowModule.revision,
        binding: { ...bound },
        permissions: { ...workflowModule.permissions },
        ...(workflowModule.taskPath ? { taskPath: workflowModule.taskPath } : {}),
        ...(workflowModule.workspace ? { workspace: workflowModule.workspace } : {}),
        ...(workflowModule.taskId ? { taskId: workflowModule.taskId } : {}),
        ...(workflowModule.handoffId ? { handoffId: workflowModule.handoffId } : {}),
        ...(workflowModule.callbackJobId ? { callbackJobId: workflowModule.callbackJobId } : {}),
      };
    };
    const normal = await Promise.all(
      this.shuffle(targets).map((member) => (
        this.getRoomMember(room, member, moduleCtxFor(member)).runRoomTurn(
          'normal',
          replaySourceMessageId,
          userMessageId,
          directMentionTargetIds?.includes(member.id) === true,
          roomHostTargetIds?.includes(member.id) === true
        )
      ))
    );

    const stats: RoomRoundStats = {
      normal: this.outcomeCounts(normal),
      reactions: [],
    };
    // Preserve the low-latency user path for a single @mention. A tracked host
    // round passes an explicit override so unmentioned members still get the
    // later reaction opportunities required by idea mode.
    if (targets.length <= 1 && reactionRounds === undefined) return stats;

    const roomCfg = contactConfig(room);
    const maxReactionRounds = Math.min(
      Math.max(Number(reactionRounds ?? roomCfg.reactionRounds ?? 1), 0),
      3
    );
    const everyone = this.roomMembers(room);
    // Workflow-aware orchestrator: the plan module binding in workflow rooms
    // (never a stale or unbound legacy default), legacy config otherwise.
    const roundOrchestrator = resolveWorkflowOrchestratorId(
      this.deps.jobStore?.workflowModules ?? null,
      room,
    );
    // Anti-regression gate for coordination host rounds: policy already forces
    // role=member → [PASS], so do not spend a model wake computing that. Idea /
    // social rooms leave coordinationDomain unset and keep full reactions.
    const authorityIds = coordinationDomain
      ? new Set(coordinationAuthorityHolderIds(coordination, roundOrchestrator))
      : null;
    // Workflow rooms additionally filter reaction rounds pre-call: only the
    // applicable module's bound contact (plus the plan-bound orchestrator on
    // coordination rounds) may wake; reserves stay silent with no model
    // instantiation.
    const workflowReactionIds = workflowModule
      ? new Set([
          workflowModule.binding.contactId,
          ...(coordinationDomain ? [roundOrchestrator] : []),
        ])
      : null;

    for (let round = 0; round < maxReactionRounds; round++) {
      let anySpoke = false;
      const outcomes: RoomTurnOutcome[] = [];
      for (const member of this.shuffle(everyone)) {
        if (authorityIds && !authorityIds.has(member.id)) {
          // Zero-token short-circuit: same outcome bucket as model-side [PASS].
          outcomes.push('passed');
          continue;
        }
        if (workflowReactionIds && !workflowReactionIds.has(member.id)) {
          outcomes.push('passed');
          continue;
        }
        const outcome = await this.getRoomMember(room, member, moduleCtxFor(member)).runRoomTurn('reaction', replaySourceMessageId);
        outcomes.push(outcome);
        if (outcome === 'spoke') anySpoke = true;
      }
      stats.reactions.push(this.outcomeCounts(outcomes));
      if (!anySpoke) break; // 全员沉默，话题自然结束
    }
    return stats;
  }

  /** 会话状态聚合（列表小圆点用）：DM 直取；群取最忙成员。 */
  stateOf(contactId: string): string {
    return this.statusOf(contactId).state;
  }

  /**
   * Full status for a contact/room, including which room member is busy.
   * Clients must use `member` for room typing labels — never the room title.
   */
  statusOf(contactId: string): { state: string; member?: string; origin?: MessageOrigin } {
    const dm = this.runtimes.get(contactId);
    if (dm) return { state: dm.state, origin: dm.stateOrigin };

    let best: { state: string; member?: string; rank: number } = { state: 'idle', rank: 0 };
    const rankOf = (state: string): number => {
      if (state === 'streaming' || state.startsWith('tool:')) return 3;
      if (state === 'thinking') return 2;
      if (state === 'error') return 1;
      return 0;
    };
    for (const [key, rt] of this.runtimes) {
      if (!key.startsWith(`${contactId}:`)) continue;
      const rank = rankOf(rt.state);
      if (rank > best.rank) {
        best = { state: rt.state, member: rt.agentName, rank };
      }
    }
    return best.rank > 0
      ? { state: best.state, member: best.member }
      : { state: 'idle' };
  }

  /**
   * Snapshot of non-idle runtimes for SSE reconnect. Room rows include member name
   * so a mid-turn resync does not fall back to the room title.
   */
  activeStatuses(): Array<{ contactId: string; state: string; member?: string; origin?: MessageOrigin }> {
    const roomIds = new Set<string>();
    const out: Array<{ contactId: string; state: string; member?: string; origin?: MessageOrigin }> = [];
    for (const [key, rt] of this.runtimes) {
      if (rt.state === 'idle') continue;
      const sep = key.indexOf(':');
      if (sep > 0) {
        roomIds.add(key.slice(0, sep));
      } else {
        out.push({ contactId: key, state: rt.state, origin: rt.stateOrigin });
      }
    }
    for (const roomId of roomIds) {
      const s = this.statusOf(roomId);
      if (s.state !== 'idle') out.push({ contactId: roomId, state: s.state, member: s.member });
    }
    return out;
  }

  private runtimesOfRoom(roomId: string): AgentRuntime[] {
    return [...this.runtimes.entries()]
      .filter(([key]) => key.startsWith(`${roomId}:`))
      .map(([, rt]) => rt);
  }

  interruptAll(contact: ContactRow): void {
    if (contact.kind === 'room') {
      for (const rt of this.runtimesOfRoom(contact.id)) rt.interrupt();
    } else {
      this.runtimes.get(contact.id)?.interrupt();
    }
  }

  /** A model switch must not cut through an in-flight DM or room-member turn. */
  isAgentBusy(contactId: string): boolean {
    for (const [key, rt] of this.runtimes) {
      if (!runtimeKeyTargetsContact(key, contactId)) continue;
      if (rt.state === 'thinking' || rt.state === 'streaming' || rt.state.startsWith('tool:')) {
        return true;
      }
    }
    return false;
  }

  /** Apply a new model without ever resuming a thread created by the old model. */
  async switchContactModel(contact: ContactRow): Promise<void> {
    const dm = this.runtimes.get(contact.id);
    if (dm) await dm.invalidateCliContext();
    else this.sessions.deactivate(contact.id, '');

    for (const [key, rt] of this.runtimes) {
      if (runtimeKeyTargetsContact(key, contact.id) && key !== contact.id) await rt.invalidateCliContext();
    }
    // Also cover rooms that have not created an in-memory runtime since gateway boot.
    this.sessions.deactivateMemberEverywhere(contact.id);
    await this.notifyContactUpdated(contact);
  }

  async resetConversation(contact: ContactRow): Promise<void> {
    if (contact.kind === 'room') {
      for (const rt of this.runtimesOfRoom(contact.id)) await rt.reset();
      this.sessions.deactivate(contact.id); // 兜底：包括没有 runtime 的成员
    } else {
      await this.get(contact).reset();
    }
  }

  /**
   * 删除/批量变更后的上下文处理：DM 单 runtime；群里全体成员。
   * 300ms 合并窗口内取最小 affectedFromId（更早的变更覆盖更广）。
   */
  invalidateConversation(contact: ContactRow, affectedFromId = 0): Promise<void> {
    return this.invalidations.push(contact.id, { contact, affectedFromId });
  }

  private async invalidateNow(contact: ContactRow, affectedFromId: number): Promise<void> {
    if (contact.kind === 'room') {
      // Invalidate every module-scoped runtime of each member; plain
      // getRoomMember would address only the legacy key.
      const seen = new Set<string>();
      for (const [key, rt] of [...this.runtimes]) {
        if (!key.startsWith(`${contact.id}:`)) continue;
        const base = baseRuntimeKey(key);
        if (seen.has(base)) continue;
        seen.add(base);
        await rt.invalidateCliContext(affectedFromId);
      }
      for (const member of this.roomMembers(contact)) {
        const base = `${contact.id}:${member.id}`;
        if (seen.has(base)) continue;
        seen.add(base);
        await this.getRoomMember(contact, member).invalidateCliContext(affectedFromId);
      }
    } else {
      await this.get(contact).invalidateCliContext(affectedFromId);
    }
  }

  async notifyContactUpdated(contact: ContactRow): Promise<void> {
    if (contact.kind === 'room') {
      for (const rt of this.runtimesOfRoom(contact.id)) rt.updateConvo(contact);
      return;
    }
    const rt = this.runtimes.get(contact.id);
    if (rt) await rt.updateAgent(contact);
    // 该联系人作为群成员的 runtime 也要换新配置
    for (const [key, roomRt] of this.runtimes) {
      if (runtimeKeyTargetsContact(key, contact.id) && key !== contact.id) await roomRt.updateAgent(contact);
    }
  }

  async remove(contactId: string): Promise<void> {
    for (const [key, rt] of [...this.runtimes]) {
      if (key === contactId || key.startsWith(`${contactId}:`) || runtimeKeyTargetsContact(key, contactId)) {
        await rt.stop();
        this.runtimes.delete(key);
      }
    }
  }

  async stopAll(reason: TurnInterruptionReason = 'claude-error'): Promise<void> {
    const interruptedSources = reason === 'deploy-restart'
      ? [...this.activeRoomDispatchSourceIds]
      : [];
    const interruptedDispatches = new Map<number, Record<string, unknown>>();
    for (const messageId of interruptedSources) {
      const snapshot = this.dispatchRecovery.markDeployInterruptedRoomDispatch(messageId);
      if (snapshot) interruptedDispatches.set(messageId, snapshot);
    }
    await Promise.all([...this.runtimes.values()].map((rt) => rt.stop(reason)));
    // Runtime completion callbacks can settle while stop() is awaiting. Reapply
    // the durable interruption marker after they finish so startup recovery sees
    // the source event in error state instead of a misleading done state.
    for (const [messageId, snapshot] of interruptedDispatches) {
      this.dispatchRecovery.markDeployInterruptedRoomDispatch(messageId, snapshot);
    }
  }
}
