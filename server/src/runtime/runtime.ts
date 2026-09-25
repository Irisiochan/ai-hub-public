import crypto from 'node:crypto';
import { heartbeatReceipt, LifeEventService } from '../companion/index.js';
import path from 'node:path';
import {
  type HubConfig,
  type MemoryConfig,
  isWorkflowOnlyEnabled,
  type ContactRow,
  type Db,
  type MessageOrigin,
  type MessageRow,
  type SseHub,
  type HubLogger,
  redactSecrets,
} from '../platform/index.js';
import {
  attachmentPathsForMessages,
  hardDeleteMessages,
  MessageRepo,
  type RoomDeliveryRow,
  frameAutomatedTurn,
  replyTriggerMeta,
} from '../messages/index.js';
import { maybeCapture, timestampedMessage, type VaultClient } from '../memory/index.js';
import { maybeWriteBackTask } from '../tasks/index.js';
import { getUserProfile, contactConfig, openContact } from '../contacts/index.js';
import type { JobStore } from '../jobs/index.js';
import type { CameraSnapBroker, TaobaoBridge, HeartbeatActivity } from '../devices/index.js';
import { BackendFactory } from './backendFactory.js';
import {
  touchConversationSummary,
  ConversationSummaryRepo,
  PromptComposer,
  type PromptContext,
} from '../prompt/index.js';
import {
  delegateScopeForModule,
  moduleBindingHash,
  resolveWorkflowOrchestratorId,
  type ModuleTurnInvocation,
  parseRoomGovernance,
} from '../workflow/index.js';
import {
  normalizeRoomCoordinationDispatch,
  quotedRoomMessage,
  resolveRoomOrchestratorId,
  roomTurnNotice,
  type RoomCoordinationDispatch,
  type RoomTurnSender,
} from '../rooms/index.js';
import {
  beginRoomTurn,
  endRoomTurn,
  setTurnMessageId,
  checkTurnObligation,
  recordUnsettled,
  remedyEligibility,
  type ObligationRemedy,
  RoomTaskStore,
  isRemedyTurn,
  markRemedyTurn,
  tryClaimRemedy,
} from '../roomTasks/index.js';
import { SessionRepo } from './sessionRepo.js';
import {
  type AgentBackend,
  type TurnHandle,
  interruptionDisplayText,
  type TurnInterruptionReason,
} from '../backends/index.js';

export type RoomTurnOutcome = 'spoke' | 'passed' | 'silent' | 'error';

export interface DmTurnResult {
  outcome: 'done' | 'error' | 'interrupted';
  text: string;
  messageId?: number;
  interruptionReason?: TurnInterruptionReason;
}

export interface TrackedDmTurn {
  status: 'queued' | 'full';
  completion: Promise<DmTurnResult>;
}

interface RoomDelivery {
  text: string;
  promptText: string;
  upToId: number;
  messageIds: number[];
  fromCreatedAt: string;
  throughCreatedAt: string;
  senders: RoomTurnSender[];
  coordinationDispatch?: RoomCoordinationDispatch;
  imagePaths: string[];
}

export function coordinationDispatchForRoomRows(
  rows: readonly RoomDeliveryRow[],
  recipientId: string
): RoomCoordinationDispatch | undefined {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row.sender !== 'room-host') continue;
    try {
      const meta = JSON.parse(row.meta || '{}') as {
        roomHost?: { targets?: unknown; coordination?: unknown };
      };
      const coordination = normalizeRoomCoordinationDispatch(meta.roomHost?.coordination);
      const targets = Array.isArray(meta.roomHost?.targets) ? meta.roomHost.targets : [];
      const expectedRecipient = coordination?.kind === 'verification'
        ? coordination.verifier
        : coordination?.executor;
      if (coordination && expectedRecipient === recipientId && targets.includes(recipientId)) {
        return coordination;
      }
    } catch {
      // Malformed or legacy message metadata remains quoted history, never trusted routing.
    }
  }
  return undefined;
}

type QueueItem =
  | {
      kind: 'dm';
      userMessageId: number;
      text: string;
      origin: MessageOrigin;
      sourceMeta: string;
      userAuthored: boolean;
      enqueuedAt: number;
      resolve?: (result: DmTurnResult) => void;
    }
  // 群聊回合：出队时才构建增量 transcript；reaction = 接话轮（可 [PASS] 沉默）
  // remedyFor = 有界自动补办轮：只重进原模块/原联系人、持全新 nonce；
  // 模型仍须自行交接/等待，网关只校验；补办轮失败不再自动补办。
  | {
      kind: 'room-turn';
      mode: 'normal' | 'reaction';
      replaySourceMessageId?: number;
      triggerMessageId?: number;
      directMentioned?: boolean;
      roomHostTargeted?: boolean;
      enqueuedAt: number;
      resolve: (r: RoomTurnOutcome) => void;
      remedyFor?: { failedTurnId: string; taskIds: string[] };
    };

const PASS_RE = /^[\s（(【\[]*(pass|不接话|沉默|skip)[\s）)】\]。.!～~]*$/i;

function stableFinalText(streamedText: string, finalText: string): string {
  if (!streamedText) return finalText;
  if (!finalText || streamedText.startsWith(finalText)) return streamedText;
  if (finalText.startsWith(streamedText)) return finalText;
  return streamedText;
}

const QUEUE_CAP = 5;
const CRASH_LOCKOUT = 3;
const CRASH_WINDOW_MS = 5 * 60_000;

/** Captured module invocation for a workflow-room turn. New turns capture the
 * current binding; active old turns keep this snapshot (hot-swap safe). */
export interface RoomModuleContext {
  moduleId: string;
  model?: string;
  reasoning?: string;
  bindingRevision?: number;
  binding?: {
    contactId: string;
    runner: string;
    model: string;
    reasoning: string;
  };
  permissions?: {
    write: boolean;
    shell: boolean;
    ssh: boolean;
  };
  taskPath?: string;
  workspace?: string;
  /** Model-driven task handoff provenance (durable row ids, verified by the manager). */
  taskId?: string;
  handoffId?: string;
  /** Callback-woken turns carry the durable callback job id (same trust). */
  callbackJobId?: string;
}

export interface AgentDeps {
  db: Db;
  sse: SseHub;
  config: HubConfig;
  vault: VaultClient | null;
  jobStore: JobStore | null;
  broker?: CameraSnapBroker;
  heartbeat?: HeartbeatActivity;
  taobao?: TaobaoBridge;
  logger?: HubLogger;
  /** Delivery transport for model-driven task handoffs/callbacks. */
  taskDispatch?: import('../roomTasks/index.js').RoomTaskDispatcher | null;
  taskStoreOptions?: import('../roomTasks/index.js').RoomTaskStoreOptions;
  /**
   * Pre-call quota/availability gate for NEW room rounds. Returns a human
   * reason when the runner's credential pool is blocked, or null when no
   * block is known. Unknown quota is never treated as exhausted: the
   * default (unset) blocks nothing and root wires the shared quota resolver.
   */
  workflowPoolBlocked?: (runner: string) => string | null;
}

/**
 * 一个"某成员在某会话里"的运行时。DM 时 convo === agent；
 * 群聊时 convo 是 room 行、agent 是成员联系人（各成员独立会话互不拖累）。
 */
export class AgentRuntime {
  private queue: QueueItem[] = [];
  private running = false;
  private backend: AgentBackend | null = null;
  private backendStartedAt = 0;
  private sessionInputTokens = 0;
  private rolloverAfterTurn = false;
  private currentHandle: TurnHandle | null = null;
  /**
   * Server-created origin-turn nonce for the CURRENT room module turn.
   * Bound into this turn's own backend tool closures and signed MCP bearer
   * at build time (backend is rebuilt per room turn). Null for DM/legacy.
   */
  private originTurnId: string | null = null;
  private crashes: number[] = [];
  private seenMemoryPaths = new Set<string>();
  state = 'idle';
  stateOrigin: MessageOrigin = 'main';
  private stateTrigger: Record<string, unknown> | null = null;
  private replyToMessageId: number | null = null;
  private currentInterruptionReason: TurnInterruptionReason | null = null;
  private stopping = false;

  private readonly messages: MessageRepo;
  private readonly sessions: SessionRepo;
  private readonly prompts: PromptComposer;
  private readonly lifeEvents: LifeEventService;
  private readonly backendFactory: BackendFactory;

  constructor(
    private convo: ContactRow,
    private agent: ContactRow,
    private deps: AgentDeps,
    private readonly moduleCtx?: RoomModuleContext | null,
  ) {
    this.messages = new MessageRepo(deps.db);
    this.sessions = new SessionRepo(deps.db);
    this.lifeEvents = new LifeEventService(deps.db, (message) => this.log(message));
    this.prompts = new PromptComposer(
      deps.vault,
      this.messages,
      deps.config.agentsDir,
      new ConversationSummaryRepo(deps.db),
      this.lifeEvents,
      isWorkflowOnlyEnabled(deps.config)
    );
    this.backendFactory = new BackendFactory({
      db: deps.db,
      config: deps.config,
      vault: deps.vault,
      jobStore: deps.jobStore,
      broker: deps.broker,
      heartbeat: deps.heartbeat,
      taobao: deps.taobao,
      prompts: this.prompts,
      taskDispatch: deps.taskDispatch ?? null,
      taskStoreOptions: deps.taskStoreOptions ?? {},
    });
  }

  private get isRoom(): boolean {
    return this.convo.id !== this.agent.id;
  }

  private get memberId(): string {
    if (!this.isRoom) return '';
    // Same contact bound to several modules gets isolated invocation identity,
    // and a binding/model/revision switch always starts a fresh persistent
    // session: the member id carries the immutable binding identity, so a new
    // binding can never resume the previous model session.
    if (!this.moduleCtx?.moduleId) return this.agent.id;
    return `${this.agent.id}::${this.moduleCtx.moduleId}::${moduleBindingHash(this.moduleCtx)}`;
  }

  /** Module invocation for the backend factory, or null for DM/legacy turns. */
  private moduleInvocationForFactory(): ModuleTurnInvocation | null {
    if (!this.isRoom || !this.moduleCtx?.moduleId) return null;
    if (!this.moduleCtx.binding || !this.moduleCtx.permissions) return null;
    return {
      moduleId: this.moduleCtx.moduleId,
      binding: this.moduleCtx.binding,
      revision: this.moduleCtx.bindingRevision ?? 0,
      permissions: this.moduleCtx.permissions,
      ...(this.moduleCtx.taskPath ? { taskPath: this.moduleCtx.taskPath } : {}),
      ...(this.moduleCtx.workspace ? { workspace: this.moduleCtx.workspace } : {}),
      ...(this.moduleCtx.taskId ? { taskId: this.moduleCtx.taskId } : {}),
      ...(this.moduleCtx.handoffId ? { handoffId: this.moduleCtx.handoffId } : {}),
      ...(this.moduleCtx.callbackJobId ? { callbackJobId: this.moduleCtx.callbackJobId } : {}),
      ...(this.originTurnId ? { turnId: this.originTurnId } : {}),
    };
  }

  /** Backend-facing agent view: persona unchanged, model/effort from the
   * captured module binding when present (hot-swap only affects new turns). */
  private effectiveAgent(): ContactRow {
    if (!this.isRoom || !this.moduleCtx?.model) return this.agent;
    const base = openContact(this.agent);
    const parsed = { ...(base.configParsed as unknown as Record<string, unknown>) };
    parsed.model = this.moduleCtx.model;
    if (this.moduleCtx.reasoning) parsed.effort = this.moduleCtx.reasoning;
    const copy = { ...base };
    Object.defineProperty(copy, 'configParsed', {
      value: parsed,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    return copy;
  }

  /** Workflow-aware orchestrator: plan binding in workflow rooms, legacy config elsewhere. */
  private roomNoticeOrchestrator(): string {
    if (!this.isRoom) return resolveRoomOrchestratorId(contactConfig(this.convo));
    try {
      return resolveWorkflowOrchestratorId(this.deps.jobStore?.workflowModules ?? null, this.convo);
    } catch {
      return resolveRoomOrchestratorId(contactConfig(this.convo));
    }
  }

  /** O7: room governance for prompt text (open rooms get the pass-based spec). */
  private roomNoticeGovernance(): 'strict' | 'open' {
    try {
      if (!this.isRoom) return 'strict';
      return parseRoomGovernance(JSON.parse((this.convo as { config?: unknown }).config as string ?? '{}'));
    } catch {
      return 'strict';
    }
  }

  /** Module authority block for the turn notice, if this is a module turn. */
  private roomNoticeModule():
    | { moduleId: string; permissions: { write: boolean; shell: boolean; ssh: boolean }; bindingRevision: number; canDispatch: boolean; routeClasses: string[]; executeContactId?: string }
    | undefined {
    const invocation = this.moduleInvocationForFactory();
    if (!invocation) return undefined;
    const scope = delegateScopeForModule(invocation.moduleId);
    return {
      moduleId: invocation.moduleId,
      permissions: invocation.permissions,
      bindingRevision: invocation.revision,
      canDispatch: scope.allow,
      routeClasses: [...scope.routeClasses],
      ...(invocation.moduleId === 'plan' && scope.allow
        ? { executeContactId: this.planDispatchExecutor() }
        : {}),
    };
  }

  /**
   * Server-derived execute contact for Plan handoff guidance. Read live, not
   * pinned to this turn's plan snapshot: a future formal dispatch snapshots
   * the CURRENT execute binding at creation time, so the hint tracks that,
   * while this turn's own plan authority stays captured. Read-only: never
   * mutates bindings or config. Undefined when execute is unavailable (no
   * store, dangling/disabled contact, or not a room member) so the notice
   * blocks instead of guessing.
   */
  private planDispatchExecutor(): string | undefined {
    try {
      const id = this.deps.jobStore?.workflowModules.bindings()?.execute?.contactId;
      if (typeof id !== 'string' || !id) return undefined;
      const contact = this.deps.db.prepare(
        "SELECT enabled FROM contacts WHERE id = ? AND kind = 'dm'",
      ).get(id) as { enabled: number } | undefined;
      if (!contact || contact.enabled !== 1) return undefined;
      const members: unknown = contactConfig(this.convo).members;
      if (!Array.isArray(members) || !members.includes(id)) return undefined;
      return id;
    } catch {
      return undefined;
    }
  }

  /** 记忆配置：全局 < 成员自己的 < 群覆盖 */
  private memCfg(): MemoryConfig {
    const agentCfg = contactConfig(this.agent);
    const convoCfg = contactConfig(this.convo);
    return {
      ...this.deps.config.memory,
      ...(agentCfg.memory ?? {}),
      ...(this.isRoom ? convoCfg.memory ?? {} : {}),
    };
  }

  /**
   * Bounded automatic remedy for a failed handoff obligation (scheme item 3).
   *
   * At most ONE remedy wake per failed turn+task (persistent INSERT OR IGNORE
   * dedup survives restarts), remedy turns never chain (in-memory marker plus
   * persistent isRemedyTurn), and the wake only re-invokes the ORIGINAL
   * module/contact with a FRESH nonce — never the next stage, never another
   * contact. The model still decides the operation inside the remedy turn;
   * the gateway only validates (owner / revision / nonce / fenced /
   * single-write-lease / dispatch idempotency all still apply), so moved
   * responsibility can never be越权补办 and no Worker is duplicated.
   *
   * Returns the number of tasks covered by the scheduled wake (0 = none).
   * Never throws: any doubt leaves the explicit red error for the manual path.
   */
  private scheduleBoundedRemedy(input: {
    failedTurnId: string;
    roomId: string;
    contactId: string;
    moduleId: string;
    callbackJobId?: string;
    taskIds: string[];
    remedies: ObligationRemedy[];
    cameFromRemedy: boolean;
  }): number {
    try {
      if (input.cameFromRemedy) return 0;
      if (this.stopping) return 0;
      if (!this.isRoom) return 0;
      if (!this.deps.jobStore) return 0;
      if (this.queue.length >= QUEUE_CAP) return 0;
      if (input.taskIds.length === 0) return 0;
      // Quota-blocked runners never auto-wake; unknown quota never blocks.
      try {
        const runner = this.moduleCtx?.binding?.runner;
        if (runner && this.deps.workflowPoolBlocked?.(runner)) return 0;
      } catch {
        // ignore gate errors and continue
      }
      const hintOf = new Map(input.remedies.map((remedy) => [remedy.taskId, remedy] as const));
      const claimed: string[] = [];
      const lines: string[] = [];
      for (const taskId of input.taskIds) {
        let eligibility = { eligible: false, reason: '责任链读取失败，暂不自动补办' };
        try {
          eligibility = remedyEligibility(
            this.deps.db,
            this.deps.jobStore,
            taskId,
            input.moduleId,
            input.contactId,
            input.callbackJobId,
          );
        } catch {
          // fail closed for this task
        }
        if (!eligibility.eligible) continue;
        let claimedNow = false;
        try {
          claimedNow = tryClaimRemedy(this.deps.db, {
            failedTurnId: input.failedTurnId,
            taskId,
            roomId: input.roomId,
            contactId: input.contactId,
            moduleId: input.moduleId,
          }).claimed;
        } catch {
          claimedNow = false;
        }
        if (!claimedNow) continue;
        claimed.push(taskId);
        const hint = hintOf.get(taskId);
        lines.push(`- ${hint?.taskPath ?? taskId}：${hint?.hint ?? '按真实状态交接、等待或拒绝承接'}（${eligibility.reason}）`);
      }
      if (claimed.length === 0) return 0;
      // One remedy fact per failed turn (idempotent): the remedy turn picks
      // it up as its trigger so it always has delivery, even with no user text.
      const key = `task-remedy:v1:${input.failedTurnId}`;
      let factId: number | null = null;
      try {
        const existing = this.messages.idByIdempotencyKey(input.roomId, key);
        if (existing !== undefined) {
          factId = existing;
        } else {
          const content = [
            `【交接补办】${this.agent.name}（${input.moduleId}）上一轮交接检查未通过（turn ${input.failedTurnId.slice(0, 8)}），给本模块一次补办机会：`,
            ...lines,
            '做法：先 task_get 重读任务与 revision，再按真实状态决定——继续真实执行、显式 task_handoff 并投递成功、登记 task_wait（blocked/waiting_user，回调轮次 waiting_owner）、或 decline 不再承接；已有在途有效执行只确认等待，不重复启动 Worker、不重复派单；责任已转移时不得越权。网关只校验，不代选阶段与联系人。',
          ].join('\n');
          const meta = {
            event: 'room-task-remedy',
            moduleId: input.moduleId,
            target: input.contactId,
            taskIds: claimed,
            failedTurnId: input.failedTurnId,
          };
          const row = this.messages.insertKeyed(input.roomId, 'system', {
            role: 'user', kind: 'text', content, status: 'done', turnId: null, meta,
          }, key);
          factId = row.id;
          this.deps.sse.broadcast('message', row);
        }
      } catch {
        return 0;
      }
      if (factId == null || !Number.isSafeInteger(factId)) return 0;
      this.queue.push({
        kind: 'room-turn',
        mode: 'normal',
        triggerMessageId: factId,
        directMentioned: false,
        roomHostTargeted: false,
        enqueuedAt: Date.now(),
        resolve: () => {},
        remedyFor: { failedTurnId: input.failedTurnId, taskIds: claimed },
      });
      return claimed.length;
    } catch {
      return 0;
    }
  }

  /**
   * B1: dispatch turn-end auto-pass wakes stashed by autoPassUnfinished.
   * Runs once, after this turn settles (settle + lastSeen + origin-turn end
   * all done), so the ledger never reads posted-before-settled and the wake
   * always chains behind a finalized round. Best-effort: the baton already
   * moved and the auto-pass marker is already logged; a failed wake only
   * flips the dispatch ledger for an explicit task_retry.
   */
  private flushDeferredAutoPass(store: RoomTaskStore | null): void {
    if (!store) return;
    try {
      const flushed = store.flushDeferredPass();
      for (const item of flushed) {
        if (item.status === 'failed') {
          this.log(`deferred auto-pass wake not delivered: ${(item.reason ?? 'unknown').slice(0, 200)}`);
        }
      }
    } catch (error) {
      this.log(`deferred auto-pass flush failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async updateAgent(row: ContactRow): Promise<void> {
    this.agent = openContact(row);
    if (!this.isRoom) this.convo = this.agent;
    if (this.backend) {
      await this.backend.stop();
      this.backend = null;
    }
  }

  updateConvo(row: ContactRow): void {
    if (this.isRoom) this.convo = openContact(row);
  }

  enqueue(item: { userMessageId: number; text: string }): 'queued' | 'full' {
    return this.enqueueDm(item, false).status;
  }

  enqueueTracked(item: { userMessageId: number; text: string }): TrackedDmTurn {
    return this.enqueueDm(item, true);
  }

  private enqueueDm(
    item: { userMessageId: number; text: string },
    tracked: boolean,
  ): TrackedDmTurn {
    if (this.queue.length >= QUEUE_CAP) {
      return {
        status: 'full',
        completion: Promise.resolve({ outcome: 'error', text: 'queue full' }),
      };
    }
    let resolve: ((result: DmTurnResult) => void) | undefined;
    const completion = tracked
      ? new Promise<DmTurnResult>((done) => { resolve = done; })
      : Promise.resolve({ outcome: 'interrupted' as const, text: '' });
    const source = this.messages.queueSource(item.userMessageId);
    const origin = source?.origin ?? 'main';
    this.queue.push({
      kind: 'dm',
      ...item,
      origin,
      sourceMeta: source?.meta ?? '{}',
      userAuthored: source?.sender === 'user',
      enqueuedAt: Date.now(),
      resolve,
    });
    void this.run();
    return { status: 'queued', completion };
  }

  private cancelQueued(reason: string): void {
    const queued = this.queue.splice(0);
    for (const item of queued) {
      if (item.kind === 'dm') item.resolve?.({ outcome: 'interrupted', text: reason });
      else item.resolve('error');
    }
  }

  /** 群聊回合：编排器 await 结果（spoke/silent/error），实现顺序发言与接话轮。 */
  runRoomTurn(
    mode: 'normal' | 'reaction',
    replaySourceMessageId?: number,
    triggerMessageId?: number,
    directMentioned: boolean = false,
    roomHostTargeted: boolean = false
  ): Promise<RoomTurnOutcome> {
    return new Promise((resolve) => {
      this.queue.push({
        kind: 'room-turn',
        mode,
        replaySourceMessageId,
        triggerMessageId,
        directMentioned,
        roomHostTargeted,
        enqueuedAt: Date.now(),
        resolve,
      });
      void this.run();
    });
  }

  interrupt(reason: TurnInterruptionReason = 'user-interrupt'): void {
    this.currentInterruptionReason = reason;
    void this.currentHandle?.interrupt();
  }

  async reset(): Promise<void> {
    this.cancelQueued('会话已重置');
    this.currentInterruptionReason = 'user-interrupt';
    await this.currentHandle?.interrupt();
    await this.backend?.stop();
    this.backend = null;
    this.crashes = [];
    this.sessions.deactivate(this.convo.id, this.isRoom ? this.memberId : undefined);
    this.stateOrigin = 'main';
    this.stateTrigger = null;
    this.setState('idle');
  }

  /** Resume scheduling after a transient heartbeat failure without resetting conversation history. */
  recoverHeartbeatError(): boolean {
    if (this.state !== 'error' || this.running || this.stopping || this.queue.length || this.lockedOut()) return false;
    if (this.stateTrigger?.eventSource !== 'heartbeat') return false;
    this.setState('idle');
    return true;
  }

  async stop(reason: TurnInterruptionReason = 'claude-error'): Promise<void> {
    this.stopping = true;
    this.cancelQueued('网关正在停止');
    this.currentInterruptionReason = reason;
    await this.currentHandle?.interrupt();
    await this.backend?.stop();
    this.backend = null;
    const deadline = Date.now() + 5_000;
    while (this.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private log(msg: string, fields: Record<string, unknown> = {}): void {
    const tag = this.isRoom ? `${this.convo.name}·${this.agent.name}` : this.agent.name;
    this.deps.logger?.info({ component: 'agent', contactId: this.convo.id, agentId: this.agent.id, tag, ...fields }, msg);
  }

  /** Display name of the speaking agent (room member or DM contact). */
  get agentName(): string {
    return this.agent.name;
  }

  private setState(state: string, detail?: string): void {
    this.state = state;
    const origin = this.stateOrigin;
    this.deps.sse.broadcast('status', {
      contactId: this.convo.id,
      state,
      detail,
      origin,
      // Room turns must always carry the member display name — UI must never
      // fall back to the room title (e.g. 「会议室 思考中」).
      member: this.isRoom ? this.agent.name : undefined,
    });
  }

  /** 发言人显示名：user → User 的资料名，其余查联系人表。 */
  private nameOf(sender: string): string {
    if (sender === 'user') return getUserProfile(this.deps.db).name;
    if (sender === 'room-host') return 'DS 主持';
    if (sender === this.agent.id) return this.agent.name;
    return this.messages.contactName(sender) ?? sender;
  }

  private insertMessage(fields: {
    role: string;
    kind: string;
    content: string;
    status: string;
    turnId: string | null;
    meta?: unknown;
    origin?: MessageOrigin;
  }): MessageRow {
    const background = this.stateTrigger?.messageType === 'background-event';
    const baseMeta = background ? { uiHidden: true } : {};
    const meta = {
      ...baseMeta,
      ...(this.replyToMessageId ? { replyToMessageId: this.replyToMessageId } : {}),
      ...(fields.meta && typeof fields.meta === 'object' ? fields.meta : {}),
      ...(this.stateTrigger ? { trigger: this.stateTrigger } : {}),
    };
    return this.messages.insert(this.convo.id, this.agent.id, {
      ...fields,
      meta,
      origin: fields.origin ?? this.stateOrigin,
    });
  }

  private updateMessage(id: number, content: string, status: string, meta?: unknown): MessageRow {
    const base = {
      ...(this.replyToMessageId ? { replyToMessageId: this.replyToMessageId } : {}),
      ...(meta && typeof meta === 'object' ? meta : {}),
    };
    const enriched = this.stateTrigger ? { ...base, trigger: this.stateTrigger } : base;
    return this.messages.update(id, content, status, enriched);
  }

  /**
   * Q1 (cost batch 2): link a settled origin turn to its final assistant
   * message so taskTurnCost can attribute chat-seat usage. Best-effort: only
   * real persisted message ids, never fabricated; PASS-silent turns (bubbles
   * hard-deleted) and message-free turns stay NULL.
   */
  private recordTurnMessageId(originTurnId: string | null, row: MessageRow | null): void {
    if (!originTurnId || !row || typeof row.id !== 'number') return;
    try {
      setTurnMessageId(this.deps.db, originTurnId, row.id);
    } catch {
      // best-effort; the turn simply stays unattributed in the cost ledger
    }
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        await this.processTurn(item);
      }
    } finally {
      this.running = false;
    }
  }

  private lockedOut(): boolean {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    return this.crashes.length >= CRASH_LOCKOUT;
  }

  private recordCrash(): void {
    this.crashes.push(Date.now());
  }

  private promptContext(): PromptContext {
    return {
      agent: this.effectiveAgent(),
      convo: this.convo,
      isRoom: this.isRoom,
      memory: this.memCfg(),
      userName: getUserProfile(this.deps.db).name,
      nameOf: (sender) => this.nameOf(sender),
      log: (message) => this.log(message),
    };
  }

  private async ensureStarted(): Promise<void> {
    if (this.backend?.alive()) return;
    const resumeToken = this.sessions.active(this.convo.id, this.memberId);
    this.seenMemoryPaths.clear();
    this.backend = await this.backendFactory.build({
      ...this.promptContext(),
      memberId: this.memberId,
      resumeToken,
      moduleInvocation: this.moduleInvocationForFactory(),
    });
    this.log(`starting backend${resumeToken ? ` (resume ${resumeToken.slice(0, 8)}…)` : ''}`);
    await this.backend.start(resumeToken);
    this.backendStartedAt = Date.now();
  }

  /**
   * 编辑/删除触及上下文：
   * - API：摘要覆盖区局部重建；仅改近期原文则保留摘要
   * - CLI：重置会话，下次 spawn 用存档回放
   * @param affectedFromId 变更起始 message id；省略/0 表示整份摘要作废（会话重置等）
   */
  async invalidateCliContext(affectedFromId?: number): Promise<void> {
    const cfg = contactConfig(this.agent);
    // 群聊共享摘要：touch 共享行 member_id=''；DM 传 undefined 以便整 contact 清理/覆盖遗留行。
    const result = touchConversationSummary(
      this.deps.db,
      this.convo.id,
      this.isRoom ? '' : undefined,
      affectedFromId ?? 0,
      {
        summaryMaxTokens: Math.max(Number(cfg.summaryMaxTokens ?? 3000), 256),
        historyTokenBudget: Math.max(Number(cfg.historyTokenBudget ?? 8000), 2048),
        nameOf: this.isRoom ? (s) => this.nameOf(s) : undefined,
      }
    );
    if (this.agent.backend === 'api') {
      this.log(
        `API rolling summary touch action=${result.action}` +
          (result.action === 'rebuilt'
            ? ` through=${result.through} rows=${result.rows} tokens=${result.tokens}`
            : result.action === 'kept'
              ? ` through=${result.through}`
              : '')
      );
      this.backend?.invalidateHistory?.(affectedFromId);
      return;
    }
    this.log(
      `CLI rolling summary touch action=${result.action}` +
        (result.action === 'rebuilt'
          ? ` through=${result.through} rows=${result.rows} tokens=${result.tokens}`
          : result.action === 'kept'
            ? ` through=${result.through}`
            : '')
    );
    this.sessions.deactivate(this.convo.id, this.isRoom ? this.memberId : undefined);
    if (this.isRoom) {
      // 存档回放会覆盖历史，跳过重复的增量投递
      const maxId = this.messages.maxId(this.convo.id);
      this.sessions.setLastSeen(this.convo.id, this.agent.id, maxId);
    }
    if (this.backend) {
      await this.backend.stop();
      this.backend = null;
    }
    this.log('CLI context invalidated (edit/delete) — will replay archive on next spawn');
  }

  /** 从某条 user 消息重新生成（仅 DM）。 */
  async regenerateFrom(userMessageId: number, text: string): Promise<'queued' | 'full'> {
    this.messages.softDeleteAfter(this.convo.id, userMessageId);
    this.deps.sse.broadcast('prune', { contactId: this.convo.id, afterId: userMessageId });
    // 该条可能被改写，且其后消息已删 → 从本条起触及摘要覆盖区
    await this.invalidateCliContext(userMessageId);
    return this.enqueue({ userMessageId, text });
  }

  private async maybeRecycleStale(): Promise<void> {
    const mem = this.memCfg();
    if (!this.deps.vault || !mem.injectOnSpawn) return;
    const maxAgeMs = mem.sessionMaxAgeHours * 3_600_000;
    if (this.backend?.alive() && maxAgeMs > 0 && Date.now() - this.backendStartedAt > maxAgeMs) {
      this.log(`backend older than ${mem.sessionMaxAgeHours}h — recycling for fresh memory context`);
      await this.backend.stop();
      this.backend = null;
    }
  }

  /**
   * 群聊增量投递：未读文本 → 带名字 transcript。
   * 错误/工具消息永不进入。超长时保留更近的消息，丢掉较早未读（仍推进 last_seen 到 upToId，
   * 避免卡死；被丢掉的早期未读可走成员自己的滚动摘要/历史预算）。
   */
  private buildRoomDelivery(requiredMessageId?: number): RoomDelivery | null {
    const lastSeen = this.sessions.lastSeen(this.convo.id, this.agent.id);
    const cfg = contactConfig(this.agent);
    const maxChars = Math.max(Number(cfg.roomDeliveryMaxChars ?? 12_000), 2_000);
    const maxRows = Math.min(Math.max(Number(cfg.roomDeliveryMaxMessages ?? 40), 4), 80);
    let rows = this.messages.unreadRoomText(
      this.convo.id,
      lastSeen,
      this.agent.id,
      maxRows
    );
    if (
      typeof requiredMessageId === 'number'
      && requiredMessageId > lastSeen
      && !rows.some((row) => row.id === requiredMessageId)
    ) {
      const required = this.messages.roomDeliveryTextById(
        this.convo.id,
        requiredMessageId,
        this.agent.id
      );
      if (required) {
        const others = rows.slice(-(maxRows - 1));
        rows = [...others, required].sort((a, b) => a.id - b.id);
      } else {
        this.log(`room trigger message unavailable id=${requiredMessageId}`);
      }
    }
    if (rows.length === 0) return null;
    const upToId = Math.max(...rows.map((row) => row.id));
    // 未读可能是几小时前甚至隔天的：带上绝对时间，别让离线后上线的成员当成"刚说的"
    const render = (row: RoomDeliveryRow) =>
      timestampedMessage(
        `${this.nameOf(row.sender)}：${row.content}`,
        row.created_at,
        '本轮新消息'
      );
    const renderPrompt = (row: RoomDeliveryRow) =>
      quotedRoomMessage({
        senderId: row.sender,
        senderName: this.nameOf(row.sender),
        content: row.content,
        createdAt: row.created_at,
        temporal: '本轮新消息',
      });
    // 从最新往回装，保证接话轮看到最近上下文
    const required = typeof requiredMessageId === 'number'
      ? rows.find((row) => row.id === requiredMessageId)
      : undefined;
    const kept: typeof rows = required ? [required] : [];
    let used = required
      ? Math.max(render(required).length, renderPrompt(required).length)
      : 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].id === required?.id) continue;
      const cost = Math.max(render(rows[i]).length, renderPrompt(rows[i]).length)
        + (kept.length ? 1 : 0);
      if (kept.length > 0 && used + cost > maxChars) break;
      kept.push(rows[i]);
      used += cost;
    }
    kept.sort((a, b) => a.id - b.id);
    if (kept.length < rows.length) {
      this.log(
        `room delivery trimmed ${rows.length - kept.length}/${rows.length} older unread (maxChars=${maxChars})`
      );
    }
    const lines = kept.map(render);
    return {
      text: lines.join('\n'),
      promptText: kept.map(renderPrompt).join('\n'),
      upToId,
      messageIds: kept.map((row) => row.id),
      fromCreatedAt: kept[0].created_at,
      throughCreatedAt: kept[kept.length - 1].created_at,
      senders: [...new Map(
        kept.map((row) => [
          row.sender,
          { id: row.sender, name: this.nameOf(row.sender) },
        ])
      ).values()],
      coordinationDispatch: coordinationDispatchForRoomRows(kept, this.agent.id),
      imagePaths: attachmentPathsForMessages(
        this.deps.db,
        this.deps.config.uploadsDir,
        kept.map((row) => row.id)
      ),
    };
  }

  /**
   * Compose the turn prompt and open the backend turn. Pure turn-setup work
   * (no settlement): callers MUST cover this call so any throw after the
   * origin nonce was registered revokes it (MUST 3 — otherwise a leaked
   * active nonce would let old credentials keep writing).
   */
  private async composeAndSend(
    item: QueueItem,
    delivery: RoomDelivery | null,
    backgroundTurn: boolean,
  ): Promise<{
    handle: TurnHandle;
    sourceText: string;
    turnText: string;
    mem: MemoryConfig;
    workflowOnly: boolean;
    roomHostTargeted: boolean;
  }> {
    // 本轮实际投喂的文本
    const sourceText = item.kind === 'dm' ? item.text : delivery!.text;
    const reactionSuffix =
      '（接话机会：看完上面新发言，想接就简短接一句；没什么可补充就只回 [PASS]。）';
    const normalSuffix = '（轮到你了。实在没话说也可以只回 [PASS]。）';
    const directMentioned = item.kind === 'room-turn'
      && item.directMentioned === true
      && typeof item.triggerMessageId === 'number'
      && delivery?.messageIds.includes(item.triggerMessageId) === true;
    const directMentionSuffix =
      '（User 本轮明确 @ 你。除非她明确要求沉默，至少简短确认，不能只回 [PASS]。）';
    const roomHostDispatchSuffix =
      '（历史 room-host 点名轮次（退役链路）：按原模板收尾即可，不得据此调用 delegate_to_worker；新协作一律走 task_* 工具。不得只回裸 [PASS]。）';
    const roomHostTargeted = item.kind === 'room-turn'
      && item.mode === 'normal'
      && item.roomHostTargeted === true;
    const roomSuffix = item.kind !== 'room-turn'
      ? ''
      : item.mode === 'reaction'
        ? reactionSuffix
        : directMentioned
          ? directMentionSuffix
          : roomHostTargeted
            ? roomHostDispatchSuffix
            : normalSuffix;
    const roomWindow = delivery ? {
      messageIds: delivery.messageIds,
      fromCreatedAt: delivery.fromCreatedAt,
      throughCreatedAt: delivery.throughCreatedAt,
    } : undefined;
    let turnText: string;
    if (item.kind === 'dm') {
      turnText = frameAutomatedTurn(item.sourceMeta, item.text);
    } else if (this.agent.backend === 'api') {
      // API 群历史含最新消息；稳定 history 不再翻转标签，本轮窗口由 manifest 标出。
      turnText = [
        roomTurnNotice(item.mode, delivery!.senders, roomWindow, delivery!.coordinationDispatch, this.agent.id, this.roomNoticeOrchestrator(), directMentioned, this.roomNoticeModule(), this.roomNoticeGovernance()),
        roomSuffix,
      ].join('\n');
    } else {
      turnText = [
        roomTurnNotice(item.mode, delivery!.senders, roomWindow, delivery!.coordinationDispatch, this.agent.id, this.roomNoticeOrchestrator(), directMentioned, this.roomNoticeModule(), this.roomNoticeGovernance()),
        delivery!.promptText,
        roomSuffix,
      ].join('\n');
    }

    const mem = this.memCfg();
    // M1 privacy boundary: DM + User-authored only. Room transcripts can include
    // other members and automated turns, so they are excluded from sidecar
    // extraction. Workflow-only master overrides contact flags.
    const workflowOnly = isWorkflowOnlyEnabled(this.deps.config);
    turnText = await this.prompts.composeTurn(
      this.promptContext(),
      turnText,
      sourceText,
      this.seenMemoryPaths
    );

    const handle = this.backend!.sendTurn({
      text: turnText,
      ...(item.kind === 'dm' ? { userMessageId: item.userMessageId } : {}),
      ...(item.kind === 'room-turn' ? { roomMessageIds: delivery!.messageIds } : {}),
      imagePaths: item.kind === 'dm'
        ? attachmentPathsForMessages(this.deps.db, this.deps.config.uploadsDir, [item.userMessageId])
        : delivery!.imagePaths,
      ...(this.stateTrigger?.eventSource === 'heartbeat' ? { emptyVisibleText: 'HEARTBEAT_OK' } : {}),
    });
    return { handle, sourceText, turnText, mem, workflowOnly, roomHostTargeted };
  }

  private async processTurn(item: QueueItem): Promise<void> {
    const { sse } = this.deps;
    const convoId = this.convo.id;
    const turnStartedAt = Date.now();
    this.stateOrigin = item.kind === 'dm' ? item.origin : 'main';
    this.stateTrigger = item.kind === 'dm'
      ? replyTriggerMeta(item.userMessageId, item.sourceMeta)
      : null;
    this.replyToMessageId = item.kind === 'dm' ? item.userMessageId : null;
    let dmSettled = false;
    const settleDm = (result: DmTurnResult) => {
      if (item.kind === 'dm' && !dmSettled) {
        dmSettled = true;
        item.resolve?.(result);
      }
    };
    const backgroundTurn = this.stateTrigger?.messageType === 'background-event';
    const queueWaitMs = Math.max(turnStartedAt - item.enqueuedAt, 0);
    const modeLabel = item.kind === 'room-turn' ? `room-${item.mode}` : 'dm';
    let prepMs = 0;
    let firstEventAt = 0;
    let firstTextAt = 0;
    let timingLogged = false;
    const markEvent = () => {
      if (!firstEventAt) firstEventAt = Date.now();
    };
    const markText = () => {
      markEvent();
      if (!firstTextAt) firstTextAt = Date.now();
    };
    const logTiming = (outcome: RoomTurnOutcome | 'done' | 'error' | 'silent', inputChars = 0, outputChars = 0) => {
      if (timingLogged) return;
      timingLogged = true;
      const totalMs = Date.now() - turnStartedAt;
      const firstEventMs = firstEventAt ? firstEventAt - turnStartedAt : -1;
      const firstTextMs = firstTextAt ? firstTextAt - turnStartedAt : -1;
      this.log('turn completed', {
        event: 'turn_timing', mode: modeLabel, outcome, queueWaitMs, prepMs,
        firstEventMs, firstTextMs, totalMs, inputChars, outputChars,
      });
    };

    // 群回合结果只回传一次
    let settled = false;
    const settle = (r: RoomTurnOutcome) => {
      if (item.kind === 'room-turn' && !settled) {
        settled = true;
        item.resolve(r);
      }
    };

    if (this.lockedOut()) {
      const row = this.insertMessage({
        role: 'system',
        kind: 'error',
        content: `${this.isRoom ? `${this.agent.name} ` : ''}连续崩了好几次，先歇了。用会话重置（session/reset）再叫我。`,
        status: 'done',
        turnId: null,
      });
      if (!backgroundTurn) sse.broadcast('message', row);
      this.setState('error', 'crash lockout');
      this.cancelQueued('连续崩溃锁定');
      settleDm({ outcome: 'error', text: row.content, messageId: row.id });
      settle('error');
      this.replyToMessageId = null;
      return;
    }

    // 群聊：出队时构建增量投递（合批天然完成）
    let delivery: RoomDelivery | null = null;
    if (item.kind === 'room-turn') {
      delivery = this.buildRoomDelivery(item.triggerMessageId);
      if (!delivery) {
        settle('silent'); // 没有新东西可回
        return;
      }
    }
    const interruptionMeta = (reason: TurnInterruptionReason) => ({
      interruptionReason: reason,
      ...(reason === 'deploy-restart' && item.kind === 'room-turn' && item.replaySourceMessageId
        ? { replaySourceMessageId: item.replaySourceMessageId }
        : {}),
    });

    // Mark thinking as soon as we commit to a turn — before vault/backend prep —
    // so room member name is on the wire during slow ensureStarted (not blank/room title).
    const turnId = crypto.randomUUID();
    this.currentInterruptionReason = null;
    // Origin-turn provenance for the handoff obligation: room module turns
    // register a server-created nonce and rebuild the backend so this turn's
    // own native tool closures and signed MCP bearer carry exactly this
    // nonce. Persistent backends must never reuse a prior turn's identity.
    const roomModuleTurn = this.isRoom && !!this.moduleCtx?.moduleId;
    this.originTurnId = null;
    if (roomModuleTurn && !backgroundTurn) {
      try {
        const origin = beginRoomTurn(this.deps.db, {
          roomId: this.convo.id,
          contactId: this.agent.id,
          moduleId: this.moduleCtx!.moduleId,
          ...(this.moduleCtx!.taskId ? { taskId: this.moduleCtx!.taskId } : {}),
          ...(this.moduleCtx!.handoffId ? { handoffId: this.moduleCtx!.handoffId } : {}),
          ...(this.moduleCtx!.callbackJobId ? { callbackJobId: this.moduleCtx!.callbackJobId } : {}),
        });
        this.originTurnId = origin.turnId;
        // Remedy chain-breaker (persistent): a remedy turn carries a FRESH
        // nonce but is linked to the failed turn it补办s, so its own failure
        // can never schedule another automatic remedy — no infinite retry.
        if (item.kind === 'room-turn' && item.remedyFor) {
          try {
            for (const taskId of item.remedyFor.taskIds) {
              markRemedyTurn(this.deps.db, origin.turnId, item.remedyFor.failedTurnId, taskId);
            }
          } catch {
            // best-effort; the in-memory marker below still breaks the chain
          }
        }
      } catch (error) {
        // Origin initialization failed: the turn has no verifiable identity,
        // so it must fail visibly here — never continue toward a normal done
        // that the obligation gate would have to skip for lack of a nonce.
        this.originTurnId = null;
        const failure = `任务轮次初始化失败（${error instanceof Error ? error.message : String(error)}）；本轮拒绝结算。`;
        const row = this.insertMessage({
          role: 'system',
          kind: 'error',
          content: `${this.agent.name}：${failure}`,
          status: 'done',
          turnId,
          meta: { handoffObligation: true, originInitFailed: true },
        });
        if (!backgroundTurn) sse.broadcast('message', row);
        this.setState('error', failure);
        logTiming('error');
        settleDm({ outcome: 'error', text: row.content, messageId: row.id });
        settle('error');
        this.replyToMessageId = null;
        return;
      }
      // Rebuild so tool closures + MCP bearer bind the fresh nonce. Session
      // continuity is preserved via the persisted resume token, not the
      // backend instance.
      try {
        await this.backend?.stop();
      } catch {
        // ignore stop errors; rebuild below
      }
      this.backend = null;
    }
    this.setState('thinking');

    try {
      const prepStartedAt = Date.now();
      await this.maybeRecycleStale();
      await this.ensureStarted();
      prepMs = Date.now() - prepStartedAt;
    } catch (e: any) {
      if (this.originTurnId) {
        try { endRoomTurn(this.deps.db, this.originTurnId, 'error'); } catch { /* ignore */ }
        this.originTurnId = null;
      }
      this.recordCrash();
      this.backend = null;
      const failure = redactSecrets(e.message);
      const row = this.insertMessage({
        role: 'system',
        kind: 'error',
        content: `${this.isRoom ? `${this.agent.name} ` : ''}后端启动失败：${failure}`,
        status: 'done',
        turnId: null,
      });
      if (!backgroundTurn) sse.broadcast('message', row);
      this.setState('error', failure);
      logTiming('error');
      settleDm({ outcome: 'error', text: row.content, messageId: row.id });
      settle('error');
      this.replyToMessageId = null;
      return;
    }

    if (this.stopping || !this.backend) {
      const reason = this.currentInterruptionReason ?? 'claude-error';
      const failure = interruptionDisplayText(reason, '后端事件流意外结束');
      const row = this.insertMessage({
        role: 'system',
        kind: 'error',
        content: this.isRoom ? `${this.agent.name}：${failure}` : failure,
        status: 'done',
        turnId,
        meta: interruptionMeta(reason),
      });
      if (!backgroundTurn) sse.broadcast('message', row);
      settleDm({
        outcome: 'interrupted',
        text: failure,
        messageId: row.id,
        interruptionReason: reason,
      });
      settle('error');
      if (this.originTurnId) {
        try { endRoomTurn(this.deps.db, this.originTurnId, 'error'); } catch { /* ignore */ }
        this.originTurnId = null;
      }
      this.replyToMessageId = null;
      return;
    }

    let textRow: MessageRow | null = null;
    let thinkingRow: MessageRow | null = null;
    let textBuf = '';
    let thinkingBuf = '';
    let terminalEventSeen = false;

    // MUST 3: every abrupt exit after the origin nonce was registered revokes
    // it. composeAndSend covers context composition and backend sendTurn; any
    // throw here fails the turn visibly instead of leaking an active nonce
    // that old credentials could keep writing with.
    let sourceText: string;
    let mem: MemoryConfig;
    let roomHostTargeted: boolean;
    let handle: TurnHandle;
    try {
      ({
        handle, sourceText, mem, roomHostTargeted,
      } = await this.composeAndSend(item, delivery, backgroundTurn));
      this.currentHandle = handle;
    } catch (e: any) {
      if (this.originTurnId) {
        try { endRoomTurn(this.deps.db, this.originTurnId, 'error'); } catch { /* ignore */ }
        this.originTurnId = null;
      }
      const failure = redactSecrets(e instanceof Error ? e.message : String(e));
      const setupRow = this.insertMessage({
        role: 'system',
        kind: 'error',
        content: this.isRoom ? `${this.agent.name}：轮次启动失败：${failure}` : `轮次启动失败：${failure}`,
        status: 'done',
        turnId,
        meta: { handoffObligation: true, setupFailed: true },
      });
      if (!backgroundTurn) sse.broadcast('message', setupRow);
      settleDm({ outcome: 'error', text: setupRow.content, messageId: setupRow.id });
      this.setState('error', failure);
      logTiming('error');
      settle('error');
      this.replyToMessageId = null;
      return;
    }

    try {
      for await (const ev of handle.events) {
        switch (ev.type) {
          case 'session':
            this.sessions.save(convoId, ev.sessionId, this.memberId);
            break;

          case 'delta':
            markText();
            if (backgroundTurn) {
              textBuf += ev.text;
              this.setState('streaming');
              break;
            }
            if (!textRow) {
              textRow = this.insertMessage({
                role: 'assistant',
                kind: 'text',
                content: '',
                status: 'streaming',
                turnId,
              });
              sse.broadcast('message', textRow);
              this.setState('streaming');
            }
            textBuf += ev.text;
            sse.broadcast('delta', { contactId: convoId, messageId: textRow.id, text: ev.text });
            break;

          case 'thinking':
            markEvent();
            if (!thinkingRow) {
              thinkingRow = this.insertMessage({
                role: 'assistant',
                kind: 'thinking',
                content: '',
                status: 'streaming',
                turnId,
              });
              if (!backgroundTurn) sse.broadcast('message', thinkingRow);
            }
            thinkingBuf += ev.text;
            if (!backgroundTurn) {
              sse.broadcast('delta', { contactId: convoId, messageId: thinkingRow.id, text: ev.text });
            }
            break;

          case 'tool_use': {
            markEvent();
            const row = this.insertMessage({
              role: 'assistant',
              kind: 'tool_use',
              content: ev.name,
              status: 'done',
              turnId,
              meta: { name: ev.name, input: ev.inputSummary },
            });
            if (!backgroundTurn) sse.broadcast('message', row);
            this.setState(`tool:${ev.name}`);
            break;
          }

          case 'tool_result':
            this.setState('thinking', `${ev.name}: ${ev.ok ? 'ok' : 'denied/failed'}`);
            break;

          case 'done': {
            if (thinkingRow) {
              const updated = this.updateMessage(thinkingRow.id, thinkingBuf, 'done');
              if (!backgroundTurn) sse.broadcast('message', updated);
            }
            let finalText = stableFinalText(textBuf, ev.finalText);
            if (this.stateTrigger?.eventSource === 'heartbeat') {
              finalText = heartbeatReceipt(finalText, this.messages.toolUseContents(convoId, turnId));
            }
            const passed = this.isRoom && PASS_RE.test(finalText.trim());

            // End-of-turn handoff obligation: for room module turns with
            // related unfinished tasks, a bare final/PASS without verifiable
            // disposition fails instead of settling normal done. The model
            // still chooses the next step; the gateway only validates.
            // DM turns and task-free conversation are unaffected.
            let obligationFailed: {
              reason: string;
              taskIds: string[];
              remedies: ObligationRemedy[];
            } | null = null;
            let failedTurnIdForAlert: string | null = null;
            // B1: owns the deferred auto-pass wakes stashed during finalize;
            // flushed once, after this turn settles (see flushDeferredAutoPass).
            let autoPassStore: RoomTaskStore | null = null;
            // Q1: origin nonce of the turn settling here. endRoomTurn runs
            // before the final assistant row is persisted, so the message_id
            // link is written after (recordTurnMessageId below), never guessed.
            let settledOriginTurnId: string | null = null;
            if (!backgroundTurn && roomModuleTurn && this.originTurnId && item.kind === 'room-turn' && this.deps.jobStore) {
              const originTurnId = this.originTurnId;
              settledOriginTurnId = originTurnId;
              try {
                const store = new RoomTaskStore(this.deps.db, this.deps.jobStore, this.deps.taskDispatch ?? null, {
                  ...(this.deps.taskStoreOptions ?? {}),
                  toolContext: {
                    roomId: convoId,
                    moduleId: this.moduleCtx!.moduleId,
                    ...(this.moduleCtx!.taskId ? { taskId: this.moduleCtx!.taskId } : {}),
                    ...(this.moduleCtx!.handoffId ? { handoffId: this.moduleCtx!.handoffId } : {}),
                    ...(this.moduleCtx!.callbackJobId ? { callbackJobId: this.moduleCtx!.callbackJobId } : {}),
                    turnId: originTurnId,
                  },
                });
                autoPassStore = store;
                const verdict = checkTurnObligation(this.deps.db, this.deps.jobStore, store, {
                  roomId: convoId,
                  contactId: this.agent.id,
                  moduleId: this.moduleCtx!.moduleId,
                  turnId: originTurnId,
                  ...(this.moduleCtx!.taskId ? { pinnedTaskId: this.moduleCtx!.taskId } : {}),
                });
                // B1: the sweep below must also run when the verdict is ok:
                // the obligation only examines pinned + touched tasks, so an
                // unpinned holder turn with no tool calls settles ok while
                // still holding the baton. Entering on open governance even
                // for ok verdicts returns those tasks to plan (invariant #2).
                if (!verdict.ok || store.isOpenGovernance(convoId)) {
                  // O2 open-governance: replace the fail-closed obligation with
                  // the automatic baton return (invariant #2). Tasks still held
                  // by this module with no in-flight job fall back to plan;
                  // tasks held by others impose no duty on this turn. Only
                  // tasks that cannot be auto-passed keep the strict failure.
                  const openIds = verdict.taskIds ?? [];
                  let openHandled = false;
                  try {
                    if (store.isOpenGovernance(convoId)) {
                      // B1: the obligation only covers the pinned + touched
                      // tasks, so an unpinned holder turn with no tool calls
                      // settles ok and the baton silently sticks. Sweep every
                      // open task this module still holds (no in-flight job):
                      // invariant #2 returns them to plan at turn end.
                      // autoPassUnfinished re-guards each id (holder/plan/
                      // job/status), so the union cannot over-fire.
                      try {
                        for (const held of store.openTasksHeldBy(convoId, this.moduleCtx!.moduleId)) {
                          if (!openIds.includes(held.id)) openIds.push(held.id);
                        }
                      } catch { /* sweep is best-effort; verdict ids still run */ }
                      const remaining: string[] = [];
                      for (const taskId of openIds) {
                        // B1: the baton moves NOW (synchronously, so the
                        // ledger never shows posted-before-settled), but the
                        // recipient wake stays stashed until this turn fully
                        // finalizes — flushed after settle() below via
                        // flushDeferredAutoPass, never from inside finalize.
                        const done = store.autoPassUnfinished(taskId, this.agent.id, this.moduleCtx!.moduleId, finalText.trim().slice(-300), { deferDelivery: true });
                        if (!done) {
                          try {
                            const t = store.getTaskById(taskId);
                            const holder = t ? (t.holder_module ?? t.owner_module) : null;
                            if (t && holder && holder !== this.moduleCtx!.moduleId) continue;
                            if (t && store.activeLinkedJobs(taskId).length > 0) continue;
                            if (t && ['closed', 'dropped', 'blocked'].includes(t.status)) continue;
                          } catch { /* fall through to failure */ }
                          remaining.push(taskId);
                        }
                      }
                      if (remaining.length === 0) {
                        openHandled = true;
                      } else {
                        obligationFailed = {
                          reason: verdict.reason ?? '未交接',
                          taskIds: remaining,
                          remedies: (verdict.remedies ?? []).filter((r) => remaining.includes(r.taskId)),
                        };
                      }
                    }
                  } catch { /* fall through to strict failure */ }
                  if (!openHandled && !obligationFailed) {
                  obligationFailed = {
                    reason: verdict.reason ?? '未交接',
                    taskIds: verdict.taskIds ?? [],
                    remedies: verdict.remedies ?? [],
                  };
                  }
                  if (obligationFailed) {
                  failedTurnIdForAlert = originTurnId;
                  for (const taskId of obligationFailed.taskIds) {
                    try {
                      recordUnsettled(store, taskId, this.agent.id, { turnId: originTurnId, reason: obligationFailed.reason }, this.moduleCtx!.moduleId);
                    } catch { /* audit best-effort */ }
                  }
                  // Bounded automatic remedy (best-effort, never throws): at
                  // most one remedy wake per failed turn+task, remedy turns
                  // never chain, and the wake only re-invokes THIS module —
                  // the model still decides the operation. Any doubt keeps
                  // the explicit red error for the manual path.
                  try {
                    const cameFromRemedy = item.remedyFor != null
                      || isRemedyTurn(this.deps.db, originTurnId);
                    this.scheduleBoundedRemedy({
                      failedTurnId: originTurnId,
                      roomId: convoId,
                      contactId: this.agent.id,
                      moduleId: this.moduleCtx!.moduleId,
                      ...(this.moduleCtx!.callbackJobId
                        ? { callbackJobId: this.moduleCtx!.callbackJobId }
                        : {}),
                      taskIds: obligationFailed.taskIds,
                      remedies: obligationFailed.remedies,
                      cameFromRemedy,
                    });
                  } catch { /* manual path remains */ }
                  }
                }
              } catch (error) {
                // Guard infra failures fail closed with a visible reason —
                // never silently pass as normal done.
                obligationFailed = {
                  reason: `交接检查失败：${error instanceof Error ? error.message : String(error)}`,
                  taskIds: [],
                  remedies: [],
                };
              }
              try { endRoomTurn(this.deps.db, originTurnId, obligationFailed ? 'unsettled' : 'settled'); } catch { /* ignore */ }
              this.originTurnId = null;
            }

            if (obligationFailed) {
              // Keep the model's text visible (never prune a PASS bubble on
              // failure) and add an explicit error outcome with task refs.
              // Task evidence/owner stay unchanged except the honest
              // turn-unsettled events above — no automatic block is invented.
              if (textRow && finalText.trim()) {
                textRow = this.updateMessage(textRow.id, finalText, 'done', { usage: ev.usage });
                sse.broadcast('message', textRow);
              } else if (finalText.trim()) {
                const row = this.insertMessage({
                  role: 'assistant',
                  kind: 'text',
                  content: finalText,
                  status: 'done',
                  turnId,
                  meta: { usage: ev.usage },
                });
                textRow = row;
                sse.broadcast('message', row);
              }
              // Q1: link the settled turn to the model's final text row.
              this.recordTurnMessageId(settledOriginTurnId, textRow);
              const errRow = this.insertMessage({
                role: 'system',
                kind: 'error',
                content: `${this.agent.name}：${obligationFailed.reason}`,
                status: 'done',
                turnId,
                meta: {
                  handoffObligation: true,
                  taskIds: obligationFailed.taskIds,
                  ...(failedTurnIdForAlert ? { failedTurnId: failedTurnIdForAlert } : {}),
                },
              });
              sse.broadcast('message', errRow);
              settleDm({
                outcome: 'done',
                text: finalText,
                ...(textRow ? { messageId: textRow.id } : {}),
              });
              if (item.kind === 'room-turn' && delivery) {
                this.sessions.setLastSeen(convoId, this.agent.id, delivery.upToId);
              }
              this.setState('error', obligationFailed.reason.slice(0, 300));
              this.log('handoff obligation failed', { reason: obligationFailed.reason.slice(0, 300) });
              logTiming('error', sourceText.length, finalText.length);
              settle('error');
              this.flushDeferredAutoPass(autoPassStore);
              terminalEventSeen = true;
              break;
            }
            if (this.originTurnId) {
              try { endRoomTurn(this.deps.db, this.originTurnId, 'settled'); } catch { /* ignore */ }
              this.originTurnId = null;
            }

            if (backgroundTurn) {
              const row = this.insertMessage({
                role: 'assistant',
                kind: 'text',
                content: finalText.trim() || 'NO_OP',
                status: 'done',
                turnId,
                origin: 'side',
                meta: {
                  usage: ev.usage,
                  uiHidden: true,
                },
              });
              this.log('background turn archived', {
                messageId: row.id,
                eventSource: this.stateTrigger?.eventSource,
              });
            } else if (passed && !roomHostTargeted) {
              // 成员选择沉默：内部气泡无审计价值 → 物理删除 + prune（不走 soft-delete）
              const retractIds = [textRow?.id, thinkingRow?.id].filter(
                (id): id is number => typeof id === 'number'
              );
              if (retractIds.length > 0) {
                hardDeleteMessages(this.deps.db, this.deps.config.uploadsDir, retractIds);
                sse.broadcast('prune', { contactId: convoId, ids: retractIds });
              }
              this.log('passed (silent, hard-deleted bubbles)');
            } else if (textRow) {
              textRow = this.updateMessage(textRow.id, finalText, 'done', { usage: ev.usage });
              sse.broadcast('message', textRow);
            } else if (finalText) {
              const row = this.insertMessage({
                role: 'assistant',
                kind: 'text',
                content: finalText,
                status: 'done',
                turnId,
                meta: { usage: ev.usage },
              });
              textRow = row;
              sse.broadcast('message', row);
            }
            // Q1: link the settled turn to the final assistant row. The
            // passed-silent branch above hard-deleted its bubbles, so there is
            // deliberately no call there (stays NULL, never fabricated).
            this.recordTurnMessageId(settledOriginTurnId, textRow);
            settleDm({
              outcome: 'done',
              text: finalText,
              ...(textRow ? { messageId: textRow.id } : {}),
            });
            if (item.kind === 'room-turn' && delivery) {
              this.sessions.setLastSeen(convoId, this.agent.id, delivery.upToId);
            }
            this.crashes = [];
            this.setState('idle');
            if (!this.isRoom || item.kind === 'room-turn') {
              const u = ev.usage;
              this.sessionInputTokens +=
                (u?.input ?? 0) + (u?.cacheCreation ?? 0) + (u?.cacheRead ?? 0);
              const cfg = contactConfig(this.agent);
              const threshold = Math.max(Number(cfg.maxSessionInputTokens ?? 120000), 0);
              if (this.agent.backend !== 'api' && threshold > 0 && this.sessionInputTokens >= threshold) {
                this.rolloverAfterTurn = true;
                this.log(`session token threshold reached (${this.sessionInputTokens}/${threshold}) — rolling over`);
              }
            }
            // P3 S2：跨联系人生活事件旁路提取。只在 DM 里看 User 的原话。
            // Workflow-only: auxiliary DS extraction stays off even with contact opt-in.
            if (!isWorkflowOnlyEnabled(this.deps.config) && !this.isRoom && item.kind === 'dm' && item.userAuthored) {
              void this.lifeEvents.extractAfterTurn(this.agent, item.userMessageId, sourceText);
            }
            // 自动捕捉只在 DM 里跑：群消息由派发层按"User 原话、群级一次"捕捉，
            // 成员发言（带名字前缀的 transcript）永不参与——防记忆污染
            // Workflow-only: natural-language capture/writeback DS stays off (master overrides mem.capture).
            if (!isWorkflowOnlyEnabled(this.deps.config) && !this.isRoom && item.kind === 'dm' && item.userAuthored && this.deps.vault && mem.capture) {
              const contact = { id: this.agent.id, name: this.agent.name };
              void maybeWriteBackTask(
                this.deps.db,
                this.deps.vault,
                this.deps.config.memory.repoPath
                  ? path.join(this.deps.config.memory.repoPath, 'tasks')
                  : null,
                contact,
                item.userMessageId,
                sourceText,
                (m) => this.log(m)
              ).then((outcome) => {
                if (!['ignored', 'rejected', 'ambiguous'].includes(outcome.status)) return;
                return maybeCapture(
                  this.deps.vault!,
                  contact,
                  sourceText,
                  finalText,
                  (m) => this.log(m)
                );
              }).catch((error) => this.log(
                `task writeback pipeline failed: ${error instanceof Error ? error.message : String(error)}`
              ));
            }
            logTiming(passed ? 'passed' : 'spoke', sourceText.length, finalText.length);
            settle(passed ? 'passed' : 'spoke');
            this.flushDeferredAutoPass(autoPassStore);
            terminalEventSeen = true;
            break;
          }

          case 'error': {
            markEvent();
            const reason = ev.reason ?? this.currentInterruptionReason ?? 'claude-error';
            const failure = redactSecrets(interruptionDisplayText(reason, ev.message));
            const interruption = interruptionMeta(reason);
            if (thinkingRow) {
              const updated = this.updateMessage(thinkingRow.id, thinkingBuf, 'interrupted', interruption);
              if (!backgroundTurn) sse.broadcast('message', updated);
            }
            if (textRow) {
              sse.broadcast('message', this.updateMessage(textRow.id, textBuf, 'interrupted', interruption));
            }
            const row = this.insertMessage({
              role: 'system',
              kind: 'error',
              content: this.isRoom ? `${this.agent.name}：${failure}` : failure,
              status: 'done',
              turnId,
              meta: interruption,
            });
            if (!backgroundTurn) sse.broadcast('message', row);
            settleDm({ outcome: 'error', text: failure, messageId: row.id, interruptionReason: reason });
            if (ev.fatal && reason === 'claude-error') {
              this.recordCrash();
              this.backend = null;
            }
            // Runtime errors/cancel can never claim normal completion.
            if (this.originTurnId) {
              try { endRoomTurn(this.deps.db, this.originTurnId, 'error'); } catch { /* ignore */ }
              this.originTurnId = null;
            }
            this.setState('error', failure);
            logTiming('error', sourceText.length, textBuf.length);
            settle('error');
            terminalEventSeen = true;
            break;
          }
        }
      }
    } finally {
      this.currentHandle = null;
      if (this.originTurnId) {
        try { endRoomTurn(this.deps.db, this.originTurnId, terminalEventSeen ? 'settled' : 'error'); } catch { /* ignore */ }
        this.originTurnId = null;
      }
      if (!terminalEventSeen) {
        const reason = this.currentInterruptionReason ?? 'claude-error';
        const failure = interruptionDisplayText(reason, '后端事件流意外结束');
        const interruption = interruptionMeta(reason);
        if (thinkingRow) {
          const updated = this.updateMessage(thinkingRow.id, thinkingBuf, 'interrupted', interruption);
          if (!backgroundTurn) sse.broadcast('message', updated);
        }
        if (textRow) {
          sse.broadcast(
            'message',
            this.updateMessage(textRow.id, textBuf, 'interrupted', interruption)
          );
        }
        const row = this.insertMessage({
          role: 'system',
          kind: 'error',
          content: this.isRoom ? `${this.agent.name}：${failure}` : failure,
          status: 'done',
          turnId,
          meta: interruption,
        });
        if (!backgroundTurn) sse.broadcast('message', row);
        settleDm({
          outcome: 'interrupted',
          text: failure,
          messageId: row.id,
          interruptionReason: reason,
        });
        this.log('backend event stream ended without a terminal event', { interruptionReason: reason });
      }
      settle('error'); // 流意外结束的兜底
      if (this.rolloverAfterTurn) {
        this.rolloverAfterTurn = false;
        this.sessionInputTokens = 0;
        this.sessions.deactivate(this.convo.id, this.isRoom ? this.memberId : undefined);
        await this.backend?.stop();
        this.backend = null;
        this.seenMemoryPaths.clear();
      }
      if (this.state === 'streaming' || this.state === 'thinking' || this.state.startsWith('tool:')) {
        this.setState('idle');
      }
      if (!timingLogged) logTiming('error');
      this.currentInterruptionReason = null;
      this.replyToMessageId = null;
    }
  }
}
