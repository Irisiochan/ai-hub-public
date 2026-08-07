import crypto from 'node:crypto';
import type { HubConfig, MemoryConfig } from '../config.js';
import { attachmentPathsForMessages, hardDeleteMessages } from '../attachments.js';
import type { ContactRow, Db, MessageOrigin, MessageRow } from '../db.js';
import { maybeCapture } from '../memory/capture.js';
import { maybeWriteBackTask } from '../memory/taskWriteback.js';
import { timestampedMessage } from '../memory/inject.js';
import type { VaultClient } from '../memory/vaultClient.js';
import { getUserProfile } from '../routes/user.js';
import type { SseHub } from '../sse.js';
import type { JobStore } from '../workers/jobStore.js';
import type { HubLogger } from '../logger.js';
import { BackendFactory } from './backendFactory.js';
import {
  backgroundDedupeMinutes,
  decideBackgroundNotification,
} from './backgroundNotification.js';
import { touchConversationSummary } from './conversationSummary.js';
import { ConversationSummaryRepo } from './conversationSummaryRepo.js';
import { contactConfig, openContact } from './configSchemas.js';
import { MessageRepo, type RoomDeliveryRow } from './messageRepo.js';
import { frameAutomatedTurn, replyTriggerMeta } from './messageSource.js';
import { PromptComposer, type PromptContext } from './promptComposer.js';
import {
  normalizeRoomCoordinationDispatch,
  quotedRoomMessage,
  roomTurnNotice,
  type RoomCoordinationDispatch,
  type RoomTurnSender,
} from './roomPrompt.js';
import { SessionRepo } from './sessionRepo.js';
import type { AgentBackend, TurnHandle } from './types.js';
import { AffectService } from './affectService.js';
import type {
  CoordinationRoomDispatchInput,
  CoordinationRoomDispatchResult,
} from './coordinationRoom.js';

export type RoomTurnOutcome = 'spoke' | 'passed' | 'silent' | 'error';

export interface DmTurnResult {
  outcome: 'done' | 'error' | 'interrupted';
  text: string;
  messageId?: number;
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
  | { kind: 'room-turn'; mode: 'normal' | 'reaction'; enqueuedAt: number; resolve: (r: RoomTurnOutcome) => void };

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

export interface AgentDeps {
  db: Db;
  sse: SseHub;
  config: HubConfig;
  vault: VaultClient | null;
  jobStore: JobStore | null;
  logger?: HubLogger;
  dispatchCoordinationRoomHost?: (
    input: CoordinationRoomDispatchInput
  ) => CoordinationRoomDispatchResult;
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
  private crashes: number[] = [];
  private seenMemoryPaths = new Set<string>();
  state = 'idle';
  stateOrigin: MessageOrigin = 'main';
  private stateTrigger: Record<string, unknown> | null = null;
  private replyToMessageId: number | null = null;

  private readonly messages: MessageRepo;
  private readonly sessions: SessionRepo;
  private readonly prompts: PromptComposer;
  private readonly affect: AffectService;
  private readonly backendFactory: BackendFactory;

  constructor(private convo: ContactRow, private agent: ContactRow, private deps: AgentDeps) {
    this.messages = new MessageRepo(deps.db);
    this.sessions = new SessionRepo(deps.db);
    this.affect = new AffectService(deps.db, (message) => this.log(message));
    this.prompts = new PromptComposer(
      deps.vault,
      this.messages,
      deps.config.agentsDir,
      new ConversationSummaryRepo(deps.db),
      this.affect
    );
    this.backendFactory = new BackendFactory({
      db: deps.db,
      config: deps.config,
      vault: deps.vault,
      jobStore: deps.jobStore,
      prompts: this.prompts,
    });
  }

  private get isRoom(): boolean {
    return this.convo.id !== this.agent.id;
  }

  private get memberId(): string {
    return this.isRoom ? this.agent.id : '';
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
  runRoomTurn(mode: 'normal' | 'reaction'): Promise<RoomTurnOutcome> {
    return new Promise((resolve) => {
      this.queue.push({ kind: 'room-turn', mode, enqueuedAt: Date.now(), resolve });
      void this.run();
    });
  }

  interrupt(): void {
    void this.currentHandle?.interrupt();
  }

  async reset(): Promise<void> {
    this.cancelQueued('会话已重置');
    await this.currentHandle?.interrupt();
    await this.backend?.stop();
    this.backend = null;
    this.crashes = [];
    this.sessions.deactivate(this.convo.id, this.isRoom ? this.memberId : undefined);
    this.stateOrigin = 'main';
    this.stateTrigger = null;
    this.setState('idle');
  }

  async stop(): Promise<void> {
    this.cancelQueued('网关正在停止');
    await this.backend?.stop();
    this.backend = null;
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
    const failure = background && fields.kind === 'error';
    const failureKey = fields.content.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
    const baseMeta = background
      ? failure
        ? { notification: { kind: 'failure', route: 'main', key: `${this.stateTrigger?.eventSource ?? 'background'}:failure:${failureKey}` } }
        : { uiHidden: true }
      : {};
    const meta = {
      ...baseMeta,
      ...(this.replyToMessageId ? { replyToMessageId: this.replyToMessageId } : {}),
      ...(fields.meta && typeof fields.meta === 'object' ? fields.meta : {}),
      ...(this.stateTrigger ? { trigger: this.stateTrigger } : {}),
    };
    return this.messages.insert(this.convo.id, this.agent.id, {
      ...fields,
      meta,
      origin: fields.origin ?? (failure ? 'main' : this.stateOrigin),
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

  private backgroundNotificationSeen(key: string, beforeId?: number): boolean {
    const minutes = backgroundDedupeMinutes();
    if (minutes <= 0) return false;
    const beforeClause = typeof beforeId === 'number' ? ' AND id < ?' : '';
    const row = this.deps.db.prepare(
      `SELECT id FROM messages
       WHERE contact_id = ? AND origin = 'main'
         AND json_extract(meta, '$.notification.key') = ?
         AND created_at >= datetime('now', ?)
         ${beforeClause}
       ORDER BY id DESC LIMIT 1`
    ).get(
      this.convo.id,
      key,
      `-${minutes} minutes`,
      ...(typeof beforeId === 'number' ? [beforeId] : []),
    );
    return row !== undefined;
  }

  private suppressDuplicateBackgroundFailure(row: MessageRow): boolean {
    if (this.stateTrigger?.messageType !== 'background-event' || row.kind !== 'error') return false;
    let meta: Record<string, any> = {};
    try { meta = JSON.parse(row.meta || '{}'); } catch {}
    const key = typeof meta.notification?.key === 'string' ? meta.notification.key : '';
    if (!key || !this.backgroundNotificationSeen(key, row.id)) return false;
    this.messages.update(row.id, row.content, row.status, {
      ...meta,
      uiHidden: true,
      notification: { ...meta.notification, route: 'suppress', duplicate: true },
    });
    this.log('duplicate background failure suppressed', { notificationKey: key });
    return true;
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
      agent: this.agent,
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
    const result = touchConversationSummary(
      this.deps.db,
      this.convo.id,
      this.isRoom ? this.memberId : undefined,
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
  private buildRoomDelivery(): RoomDelivery | null {
    const lastSeen = this.sessions.lastSeen(this.convo.id, this.agent.id);
    const cfg = contactConfig(this.agent);
    const maxChars = Math.max(Number(cfg.roomDeliveryMaxChars ?? 12_000), 2_000);
    const maxRows = Math.min(Math.max(Number(cfg.roomDeliveryMaxMessages ?? 40), 4), 80);
    const rows = this.messages.unreadRoomText(
      this.convo.id,
      lastSeen,
      this.agent.id,
      maxRows
    );
    if (rows.length === 0) return null;
    const upToId = rows[rows.length - 1].id;
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
    const kept: typeof rows = [];
    let used = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const cost = Math.max(render(rows[i]).length, renderPrompt(rows[i]).length)
        + (kept.length ? 1 : 0);
      if (kept.length > 0 && used + cost > maxChars) break;
      kept.push(rows[i]);
      used += cost;
    }
    kept.reverse();
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
      if (!this.suppressDuplicateBackgroundFailure(row)) sse.broadcast('message', row);
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
      delivery = this.buildRoomDelivery();
      if (!delivery) {
        settle('silent'); // 没有新东西可回
        return;
      }
    }

    // Mark thinking as soon as we commit to a turn — before vault/backend prep —
    // so room member name is on the wire during slow ensureStarted (not blank/room title).
    const turnId = crypto.randomUUID();
    this.setState('thinking');

    try {
      const prepStartedAt = Date.now();
      await this.maybeRecycleStale();
      await this.ensureStarted();
      prepMs = Date.now() - prepStartedAt;
    } catch (e: any) {
      this.recordCrash();
      this.backend = null;
      const row = this.insertMessage({
        role: 'system',
        kind: 'error',
        content: `${this.isRoom ? `${this.agent.name} ` : ''}后端启动失败：${e.message}`,
        status: 'done',
        turnId: null,
      });
      if (!this.suppressDuplicateBackgroundFailure(row)) sse.broadcast('message', row);
      this.setState('error', e.message);
      logTiming('error');
      settleDm({ outcome: 'error', text: row.content, messageId: row.id });
      settle('error');
      this.replyToMessageId = null;
      return;
    }

    let textRow: MessageRow | null = null;
    let thinkingRow: MessageRow | null = null;
    let textBuf = '';
    let thinkingBuf = '';
    let terminalEventSeen = false;

    // 本轮实际投喂的文本
    const sourceText = item.kind === 'dm' ? item.text : delivery!.text;
    const reactionSuffix =
      '（接话机会：看完上面新发言，想接就简短接一句；没什么可补充就只回 [PASS]。）';
    const normalSuffix = '（轮到你了。实在没话说也可以只回 [PASS]。）';
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
        roomTurnNotice(item.mode, delivery!.senders, roomWindow, delivery!.coordinationDispatch),
        item.mode === 'reaction' ? reactionSuffix : normalSuffix,
      ].join('\n');
    } else {
      turnText = [
        roomTurnNotice(item.mode, delivery!.senders, roomWindow, delivery!.coordinationDispatch),
        delivery!.promptText,
        item.mode === 'reaction' ? reactionSuffix : normalSuffix,
      ].join('\n');
    }

    const mem = this.memCfg();
    // M1 privacy boundary: DM + User-authored only. Room transcripts can include
    // other members and automated turns, so they are excluded from both payload
    // injection and sidecar scoring.
    const affectUserTurn = !backgroundTurn && item.kind === 'dm' && item.userAuthored;
    turnText = await this.prompts.composeTurn(
      this.promptContext(),
      turnText,
      sourceText,
      this.seenMemoryPaths,
      affectUserTurn
    );

    const handle = this.backend!.sendTurn({
      text: turnText,
      ...(item.kind === 'dm' ? { userMessageId: item.userMessageId } : {}),
      ...(item.kind === 'room-turn' ? { roomMessageIds: delivery!.messageIds } : {}),
      imagePaths: item.kind === 'dm'
        ? attachmentPathsForMessages(this.deps.db, this.deps.config.uploadsDir, [item.userMessageId])
        : delivery!.imagePaths,
    });
    this.currentHandle = handle;

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
            const finalText = stableFinalText(textBuf, ev.finalText);
            const passed = this.isRoom && PASS_RE.test(finalText.trim());

            if (backgroundTurn) {
              const decision = decideBackgroundNotification(finalText, item.kind === 'dm' ? item.sourceMeta : {});
              const roomResult = decision.route === 'main'
                && decision.descriptor?.messageType === 'background-event'
                && this.deps.dispatchCoordinationRoomHost
                ? this.deps.dispatchCoordinationRoomHost({
                    targetId: 'claude',
                    content: `@claude 后台任务通知\n${decision.content}`,
                    kind: 'background-notification',
                    duplicateKey: decision.key,
                    duplicateMinutes: backgroundDedupeMinutes(),
                    meta: {
                      notification: {
                        kind: decision.kind,
                        key: decision.key,
                        source: decision.descriptor?.eventSource ?? 'background',
                        eventId: decision.descriptor?.eventId,
                        sourceContactId: this.convo.id,
                      },
                    },
                  })
                : null;
              const roomPosted = roomResult?.status === 'posted';
              const duplicate = roomResult?.status === 'duplicate'
                || (!roomResult && decision.route === 'main' && this.backgroundNotificationSeen(decision.key));
              const route = duplicate
                ? 'suppress'
                : roomPosted
                  ? 'coordination-room'
                  : decision.route;
              const row = this.insertMessage({
                role: 'assistant',
                kind: 'text',
                content: decision.content || 'NO_OP',
                status: 'done',
                turnId,
                origin: route === 'main' ? 'main' : 'side',
                meta: {
                  usage: ev.usage,
                  uiHidden: route === 'suppress' || route === 'coordination-room',
                  notification: {
                    kind: decision.kind,
                    route,
                    key: decision.key,
                    duplicate,
                    source: decision.descriptor?.eventSource ?? 'background',
                    eventId: decision.descriptor?.eventId,
                  },
                },
              });
              if (route !== 'suppress' && route !== 'coordination-room') sse.broadcast('message', row);
              this.log('background notification routed', {
                notificationKind: decision.kind,
                notificationRoute: route,
                duplicate,
                eventSource: decision.descriptor?.eventSource,
                roomId: roomResult?.roomId,
                roomFallbackReason: roomResult?.status === 'unavailable' ? roomResult.reason : undefined,
              });
            } else if (passed) {
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
            if (affectUserTurn && !passed && finalText.trim()) {
              void this.affect.scoreAfterTurn(this.agent, sourceText, finalText);
            }
            // 自动捕捉只在 DM 里跑：群消息由派发层按"User 原话、群级一次"捕捉，
            // 成员发言（带名字前缀的 transcript）永不参与——防记忆污染
            if (!this.isRoom && item.kind === 'dm' && item.userAuthored && this.deps.vault && mem.capture) {
              const contact = { id: this.agent.id, name: this.agent.name };
              void maybeWriteBackTask(
                this.deps.db,
                this.deps.vault,
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
            terminalEventSeen = true;
            break;
          }

          case 'error': {
            markEvent();
            if (thinkingRow) {
              const updated = this.updateMessage(thinkingRow.id, thinkingBuf, 'interrupted');
              if (!backgroundTurn) sse.broadcast('message', updated);
            }
            if (textRow) {
              sse.broadcast('message', this.updateMessage(textRow.id, textBuf, 'interrupted'));
            }
            const row = this.insertMessage({
              role: 'system',
              kind: 'error',
              content: this.isRoom ? `${this.agent.name}：${ev.message}` : ev.message,
              status: 'done',
              turnId,
            });
            if (!this.suppressDuplicateBackgroundFailure(row)) sse.broadcast('message', row);
            settleDm({ outcome: 'error', text: ev.message, messageId: row.id });
            if (ev.fatal) {
              this.recordCrash();
              this.backend = null;
            }
            this.setState('error', ev.message);
            logTiming('error', sourceText.length, textBuf.length);
            settle('error');
            terminalEventSeen = true;
            break;
          }
        }
      }
    } finally {
      this.currentHandle = null;
      if (!terminalEventSeen) {
        settleDm({ outcome: 'interrupted', text: '后端事件流意外结束' });
        if (thinkingRow) {
          const updated = this.updateMessage(thinkingRow.id, thinkingBuf, 'interrupted');
          if (!backgroundTurn) sse.broadcast('message', updated);
        }
        if (textRow) {
          sse.broadcast(
            'message',
            this.updateMessage(textRow.id, textBuf, 'interrupted')
          );
        }
        this.log('backend event stream ended without a terminal event');
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
      this.replyToMessageId = null;
    }
  }
}
