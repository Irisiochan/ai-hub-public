import path from 'node:path';
import type { MemoryConfig } from '../config.js';
import type { ContactRow, MessageOrigin } from '../db.js';
import { maybeCapture } from '../memory/capture.js';
import { maybeWriteBackTask } from '../memory/taskWriteback.js';
import { contactConfig, openContact } from './configSchemas.js';
import { Debouncer } from './debouncer.js';
import {
  coordinationAuthorityHolderIds,
  resolveRoomOrchestratorId,
  type RoomCoordinationDispatch,
  normalizeRoomCoordinationDispatch,
} from './roomPrompt.js';
import { AgentRuntime, type AgentDeps, type RoomTurnOutcome } from './runtime.js';
import { SessionRepo } from './sessionRepo.js';
import { parseRoomTargets, roomDirectlyMentions } from './roomTargets.js';
import type { CompanionHeartbeat } from './companionHeartbeat.js';
import type { TurnInterruptionReason } from './turnInterruption.js';
import { RoomDispatchDrain } from './roomDispatchDrain.js';

export { AgentRuntime } from './runtime.js';
export type { RoomTurnOutcome } from './runtime.js';

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
}

interface ScheduledRoomDispatchOptions extends RoomDispatchOptions {
  directMentionTargetIds?: string[];
  roomHostTargetIds?: string[];
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
  private deployResumeClaims = new Set<number>();

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
  }

  attachHeartbeat(heartbeat: CompanionHeartbeat): void {
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
  getRoomMember(room: ContactRow, member: ContactRow): AgentRuntime {
    room = openContact(room);
    member = openContact(member);
    const key = `${room.id}:${member.id}`;
    let rt = this.runtimes.get(key);
    if (!rt) {
      rt = new AgentRuntime(room, member, this.deps);
      this.runtimes.set(key, rt);
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
    const targets = options.targetOverride ?? this.parseTargets(room, content);

    const roomCfg = contactConfig(room);
    const mem: MemoryConfig = { ...this.deps.config.memory, ...(roomCfg.memory ?? {}) };
    if (options.capture !== false && this.deps.vault && mem.capture) {
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
    };
    const dispatch = () => this.scheduleRoomRound(room, targets, scheduledOptions);
    const durableHostDispatch = typeof options.userMessageId === 'number'
      && this.isDeployReplayableRoomHostMessage(options.userMessageId);
    try {
      if (this.roomDispatchDrain.isActive()) {
        if (typeof options.userMessageId !== 'number') {
          throw new Error('drain deferral requires a persisted source message id');
        }
        this.writeRoomDispatchState(options.userMessageId, {
          status: 'deferred',
          targetIds,
          reactionRounds: options.reactionRounds,
          coordinationDomain: options.coordinationDomain === true,
          coordination: options.coordination,
          dispatchClass: 'drain',
          deferredAt: new Date().toISOString(),
        });
        const completion = this.roomDispatchDrain.defer(async () => {
          this.writeRoomDispatchState(options.userMessageId!, {
            status: 'dispatching',
            dispatchedAt: new Date().toISOString(),
          });
          return dispatch();
        });
        void completion.then(
          () => this.writeRoomDispatchState(options.userMessageId!, {
            status: 'done',
            completedAt: new Date().toISOString(),
          }),
          (error) => this.writeRoomDispatchState(options.userMessageId!, {
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
      this.writeRoomDispatchState(options.userMessageId!, {
        status: 'dispatching',
        targetIds,
        reactionRounds: options.reactionRounds,
        coordinationDomain: options.coordinationDomain === true,
        coordination: options.coordination,
        dispatchClass: 'live',
        dispatchedAt: new Date().toISOString(),
      });
    }
    const completion = dispatch();
    if (durableHostDispatch) {
      void completion.then(
        (outcome) => this.finishLiveRoomDispatch(options.userMessageId!, outcome),
        (error) => this.finishRecoveredRoomDispatch(options.userMessageId!, 'room-host', 'error', error),
      );
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

  private writeRoomDispatchState(messageId: number, patch: Record<string, unknown>): void {
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

  private isDeployReplayableRoomHostMessage(messageId: number): boolean {
    const row = this.deps.db.prepare('SELECT sender, meta FROM messages WHERE id = ?').get(messageId) as
      | { sender: string; meta: string }
      | undefined;
    if (!row || row.sender !== 'room-host') return false;
    try {
      const meta = JSON.parse(row.meta || '{}') as Record<string, any>;
      const roomHost = meta.roomHost;
      const coordination = roomHost?.coordination;
      const receipt = roomHost?.receipt;
      return !!roomHost && typeof roomHost === 'object' && !Array.isArray(roomHost)
        && (
          (!!coordination && typeof coordination === 'object' && !Array.isArray(coordination))
          || (!!receipt && typeof receipt === 'object' && !Array.isArray(receipt))
        );
    } catch {
      return false;
    }
  }

  private markDeployInterruptedRoomDispatch(
    messageId: number,
    dispatchSnapshot?: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (!this.isDeployReplayableRoomHostMessage(messageId)) return null;
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
      roomHost: {
        ...(meta.roomHost ?? {}),
        status: 'error',
        interruptionReason: 'deploy-restart',
        interruptedAt,
      },
    };
    this.deps.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(next), messageId);
    return interruptedDispatch;
  }

  private finishLiveRoomDispatch(messageId: number, outcome: RoomRoundStats): void {
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
        const deployResume = deferred.interruptionReason === 'deploy-restart'
          && ['error', 'resume-queued'].includes(String(deferred.status));
        if (deployResume && this.deployResumeClaims.has(row.id)) continue;
        const roomHostTargets = Array.isArray(meta.roomHost?.targets) ? meta.roomHost.targets : [];
        const targetIds = Array.isArray(deferred.targetIds)
          ? deferred.targetIds.map(String)
          : roomHostTargets.map(String);
        const targets = this.roomMembers(room).filter((member) => targetIds.includes(member.id));
        if (targets.length === 0) throw new Error('deferred targets are unavailable');
        const coordination = normalizeRoomCoordinationDispatch(deferred.coordination);
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
        const completion = this.scheduleRoomRound(room, targets, options);
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
      roomHost: {
        ...(meta.roomHost ?? {}),
        status: 'queued',
        resumeQueued: true,
        resumeQueuedAt: queuedAt,
      },
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

  private finishRecoveredRoomDispatch(
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
    options: Pick<ScheduledRoomDispatchOptions, 'reactionRounds' | 'coordinationDomain' | 'coordination' | 'userMessageId' | 'directMentionTargetIds' | 'roomHostTargetIds'> = {}
  ): Promise<RoomRoundStats> {
    const {
      reactionRounds,
      coordinationDomain,
      coordination,
      userMessageId,
      directMentionTargetIds,
      roomHostTargetIds,
    } = options;
    const replaySourceMessageId = typeof userMessageId === 'number'
      && this.isDeployReplayableRoomHostMessage(userMessageId)
      ? userMessageId
      : undefined;
    const normal = await Promise.all(
      this.shuffle(targets).map((member) => (
        this.getRoomMember(room, member).runRoomTurn(
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
    // Anti-regression gate for coordination host rounds: policy already forces
    // role=member → [PASS], so do not spend a model wake computing that. Idea /
    // social rooms leave coordinationDomain unset and keep full reactions.
    const authorityIds = coordinationDomain
      ? new Set(coordinationAuthorityHolderIds(coordination, resolveRoomOrchestratorId(roomCfg)))
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
        const outcome = await this.getRoomMember(room, member).runRoomTurn('reaction', replaySourceMessageId);
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
      if (key !== contactId && !key.endsWith(`:${contactId}`)) continue;
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
      if (key.endsWith(`:${contact.id}`)) await rt.invalidateCliContext();
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
      for (const member of this.roomMembers(contact)) {
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
      if (key.endsWith(`:${contact.id}`)) await roomRt.updateAgent(contact);
    }
  }

  async remove(contactId: string): Promise<void> {
    for (const [key, rt] of [...this.runtimes]) {
      if (key === contactId || key.startsWith(`${contactId}:`) || key.endsWith(`:${contactId}`)) {
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
      const snapshot = this.markDeployInterruptedRoomDispatch(messageId);
      if (snapshot) interruptedDispatches.set(messageId, snapshot);
    }
    await Promise.all([...this.runtimes.values()].map((rt) => rt.stop(reason)));
    // Runtime completion callbacks can settle while stop() is awaiting. Reapply
    // the durable interruption marker after they finish so startup recovery sees
    // the source event in error state instead of a misleading done state.
    for (const [messageId, snapshot] of interruptedDispatches) {
      this.markDeployInterruptedRoomDispatch(messageId, snapshot);
    }
  }
}
