import crypto from 'node:crypto';
import { heartbeatReceipt, heartbeatWriteTool, retryableHeartbeatError } from './heartbeatPolicy.js';
import { hardDeleteMessages } from '../attachments.js';
import type { HubConfig } from '../config.js';
import type { ContactRow, Db, HeartbeatSessionRow, MessageRow } from '../db.js';
import type { HubLogger } from '../logger.js';
import type { SseHub } from '../sse.js';
import type { CameraSnapBroker } from '../workers/cameraSnap.js';
import type { TaobaoBridge } from '../workers/taobaoBridge.js';
import { contactConfig, openContact } from './configSchemas.js';
import type { AgentManager } from './manager.js';
import { automationMeta } from './messageSource.js';
import type { DmTurnResult } from './runtime.js';
import { taobaoModeFor, type TaobaoMode } from './taobaoTools.js';

const HEARTBEAT_OK_RE = /^HEARTBEAT_OK[\s。.!～~]*$/;
export const HEARTBEAT_INTERVAL_MIN_MINUTES = 4;
export const HEARTBEAT_INTERVAL_MAX_MINUTES = 7;

export function randomHeartbeatIntervalMinutes(random: () => number = Math.random): number {
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new Error('heartbeat random sample must be in [0, 1)');
  }
  return HEARTBEAT_INTERVAL_MIN_MINUTES
    + Math.floor(sample * (HEARTBEAT_INTERVAL_MAX_MINUTES - HEARTBEAT_INTERVAL_MIN_MINUTES + 1));
}

export interface HeartbeatStatus {
  contactId: string;
  active: boolean;
  mode?: 'timed' | 'unlimited';
  startedAt?: string;
  expiresAt?: string;
  intervalMinutes?: number;
  tickCount?: number;
  pausedReason?: string;
  stats?: { dispatched: number; silent: number; visible: number; failed: number; skipped: number; inputTokens: number; outputTokens: number; toolCount: number };
}

export class HeartbeatError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) {
    super(message);
  }
}

interface CompanionHeartbeatDeps {
  db: Db;
  sse: SseHub;
  manager: AgentManager;
  broker: CameraSnapBroker;
  /** Present when the gateway can bridge Taobao tools; the tick prompt only mentions them then. */
  taobao?: TaobaoBridge;
  config: HubConfig;
  logger?: HubLogger;
  random?: () => number;
}

export class CompanionHeartbeat {
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(private readonly deps: CompanionHeartbeatDeps) {}

  start(): void {
    if (this.timer) return;
    this.deps.db.transaction(() => {
      this.deps.db.prepare(`UPDATE heartbeat_sessions SET paused_reason = '网关重启时心跳尚未完成，请核对操作结果后重开。'
        WHERE stopped_at IS NULL AND id IN (SELECT session_id FROM heartbeat_runs WHERE outcome = 'running')`).run();
      this.deps.db.prepare("UPDATE heartbeat_runs SET outcome = 'interrupted', detail = 'gateway restart', finished_at = ? WHERE outcome = 'running'")
        .run(new Date().toISOString());
    })();
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), 30_000);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  startSession(contactId: string, minutes: number | null): HeartbeatStatus {
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 5 || minutes > 480)) {
      throw new HeartbeatError('minutes 必须是 5 到 480 的整数');
    }
    const contact = this.contact(contactId);
    if (!contact || contactConfig(contact).heartbeat?.enabled !== true) {
      throw new HeartbeatError('这个联系人没有开启心跳');
    }
    if (this.status(contactId).active) throw new HeartbeatError('心跳会话已在进行中', 409);
    // An explicit manual restart can re-arm a failed heartbeat, but never bypass crash lockout.
    if (this.deps.manager.statusOf(contactId).state === 'error') this.deps.manager.get(contact).recoverHeartbeatError();

    const interval = this.nextIntervalMinutes();
    const startedAt = new Date();
    const expiresAt = minutes === null ? null : new Date(startedAt.getTime() + minutes * 60_000).toISOString();
    this.deps.db.prepare(
      `INSERT INTO heartbeat_sessions
       (id, contact_id, started_at, expires_at, interval_minutes, tick_count)
       VALUES (?, ?, ?, ?, ?, 0)`
    ).run(crypto.randomUUID(), contactId, startedAt.toISOString(), expiresAt, interval);
    const status = this.status(contactId);
    this.deps.sse.broadcast('heartbeat', status);
    this.log('heartbeat session started', {
      contactId,
      mode: minutes === null ? 'unlimited' : 'timed',
      minutes,
      nextIntervalMinutes: interval,
    });
    return status;
  }

  stopSession(contactId: string, reason: 'manual' | 'expired'): HeartbeatStatus | null {
    const row = this.activeRow(contactId);
    if (!row) return null;
    this.deps.db.prepare(
      `UPDATE heartbeat_sessions
       SET stopped_at = ?, stop_reason = ?
       WHERE id = ? AND stopped_at IS NULL`
    ).run(new Date().toISOString(), reason, row.id);
    const status: HeartbeatStatus = { contactId, active: false, stats: this.stats(row.id) };
    this.deps.sse.broadcast('heartbeat', status);
    this.log('heartbeat session stopped', { contactId, sessionId: row.id, reason });
    return status;
  }

  status(contactId: string): HeartbeatStatus {
    const row = this.activeRow(contactId);
    if (!row) {
      const previous = this.deps.db.prepare('SELECT id FROM heartbeat_sessions WHERE contact_id = ? ORDER BY started_at DESC LIMIT 1')
        .get(contactId) as { id: string } | undefined;
      return { contactId, active: false, ...(previous ? { stats: this.stats(previous.id) } : {}) };
    }
    if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now()) {
      this.stopSession(contactId, 'expired');
      return { contactId, active: false };
    }
    return this.rowStatus(row);
  }

  isActive(contactId: string): boolean {
    return this.status(contactId).active;
  }

  async runOnce(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const rows = this.deps.db.prepare(
        'SELECT * FROM heartbeat_sessions WHERE stopped_at IS NULL ORDER BY started_at'
      ).all() as HeartbeatSessionRow[];
      for (const row of rows) await this.tickIfDue(row);
    } finally {
      this.scanning = false;
    }
  }

  private async tickIfDue(row: HeartbeatSessionRow): Promise<void> {
    const now = Date.now();
    const expiresAt = row.expires_at === null ? null : Date.parse(row.expires_at);
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= now)) {
      this.stopSession(row.contact_id, 'expired');
      return;
    }
    const recovery = this.deps.db.prepare('SELECT failure_count, paused_reason FROM heartbeat_sessions WHERE id = ?')
      .get(row.id) as { failure_count: number; paused_reason: string | null };
    if (recovery.paused_reason) return;
    const baseline = Date.parse(row.last_tick_at ?? row.started_at);
    if (Number.isFinite(baseline) && now - baseline < row.interval_minutes * 60_000) return;

    const tick = row.tick_count + 1;
    const tickAt = new Date(now).toISOString();
    const nextIntervalMinutes = this.nextIntervalMinutes();
    this.deps.db.prepare(`INSERT OR IGNORE INTO heartbeat_runs
      (session_id, tick, contact_id, started_at, outcome) VALUES (?, ?, ?, ?, 'skipped')`)
      .run(row.id, tick, row.contact_id, tickAt);
    const skip = (detail: string) => {
      this.deps.db.prepare('UPDATE heartbeat_runs SET detail = ?, finished_at = ? WHERE session_id = ? AND tick = ?')
        .run(detail, tickAt, row.id, tick);
      this.deps.sse.broadcast('heartbeat', this.status(row.contact_id));
    };
    this.deps.db.prepare(
      `UPDATE heartbeat_sessions
       SET tick_count = ?, last_tick_at = ?, interval_minutes = ?
       WHERE id = ? AND stopped_at IS NULL`
    ).run(tick, tickAt, nextIntervalMinutes, row.id);

    let state = this.deps.manager.statusOf(row.contact_id).state;
    if (state === 'error' && recovery.failure_count > 0) {
      const contact = this.contact(row.contact_id);
      if (contact && this.deps.manager.get(contact).recoverHeartbeatError()) state = 'idle';
    }
    if (state !== 'idle') {
      skip(`runtime-${state}`);
      if (state === 'error') this.deps.db.prepare('UPDATE heartbeat_sessions SET paused_reason = ? WHERE id = ?')
        .run('联系人处于错误状态，需要检查后重开心跳或恢复会话。', row.id);
      this.deps.sse.broadcast('heartbeat', this.status(row.contact_id));
      this.log('heartbeat tick skipped', {
        contactId: row.contact_id,
        sessionId: row.id,
        tick,
        nextIntervalMinutes,
        reason: `runtime-${state}`,
      });
      return;
    }
    const irisPresent = this.deps.db.prepare(
      `SELECT id FROM messages
       WHERE contact_id = ? AND sender = 'user' AND deleted = 0 AND origin = 'main'
         AND COALESCE(json_extract(meta, '$.uiHidden'), 0) != 1
         AND datetime(created_at) >= datetime('now', '-3 minutes')
       ORDER BY id DESC LIMIT 1`
    ).get(row.contact_id);
    if (irisPresent) {
      skip('User-present');
      this.log('heartbeat tick skipped', {
        contactId: row.contact_id,
        sessionId: row.id,
        tick,
        nextIntervalMinutes,
        reason: 'User-present',
      });
      return;
    }

    const remainingMinutes = expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - now) / 60_000));
    const contact = this.contact(row.contact_id);
    const taobaoMode = contact && this.deps.taobao ? taobaoModeFor(contactConfig(contact)) : null;
    const text = heartbeatPrompt(tick, remainingMinutes, { taobaoMode });
    const descriptor = {
      messageType: 'proactive-trigger' as const,
      eventSource: 'heartbeat',
      eventId: `${row.id}:${tick}`,
    };
    const idempotencyKey = `automation:heartbeat:${row.id}:${tick}`;
    const result = this.deps.db.prepare(
      `INSERT OR IGNORE INTO messages
       (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
       VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main', ?)`
    ).run(
      row.contact_id,
      text,
      JSON.stringify({ ...automationMeta(descriptor, { hidden: true }), automation: descriptor }),
      idempotencyKey,
    );
    if (!result.changes) {
      skip('duplicate');
      this.log('heartbeat tick skipped', { contactId: row.contact_id, sessionId: row.id, tick, reason: 'duplicate' });
      return;
    }
    const userMessageId = Number(result.lastInsertRowid);
    if (!contact) {
      skip('contact-unavailable');
      hardDeleteMessages(this.deps.db, this.deps.config.uploadsDir, [userMessageId]);
      return;
    }
    const tracked = this.deps.manager.get(contact).enqueueTracked({ userMessageId, text });
    if (tracked.status === 'full') {
      skip('queue-full');
      hardDeleteMessages(this.deps.db, this.deps.config.uploadsDir, [userMessageId]);
      this.log('heartbeat tick skipped', {
        contactId: row.contact_id,
        sessionId: row.id,
        tick,
        nextIntervalMinutes,
        reason: 'queue-full',
      });
      return;
    }
    this.log('heartbeat tick dispatched', {
      contactId: row.contact_id,
      sessionId: row.id,
      tick,
      nextIntervalMinutes,
    });
    this.deps.db.prepare("UPDATE heartbeat_runs SET outcome = 'running' WHERE session_id = ? AND tick = ?")
      .run(row.id, tick);
    this.deps.sse.broadcast('heartbeat', this.status(row.contact_id));
    void tracked.completion
      .then((turn) => {
        // Defense at the shared settlement boundary, including CLI backends.
        if (turn.outcome === 'done' && turn.messageId) {
          const reply = this.deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(turn.messageId) as MessageRow | undefined;
          const calls = reply?.turn_id ? this.deps.db.prepare("SELECT content FROM messages WHERE contact_id = ? AND turn_id = ? AND kind = 'tool_use'")
            .all(row.contact_id, reply.turn_id) as Array<{ content: string }> : [];
          const text = heartbeatReceipt(turn.text, calls.map((call) => call.content));
          if (text !== turn.text && reply) {
            this.deps.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(text, reply.id);
            this.deps.sse.broadcast('message', { ...reply, content: text });
            turn = { ...turn, text };
          }
        }
        this.recordBeat(row, tick, turn);
        this.settleBeat(row.contact_id, userMessageId, turn);
        this.deps.sse.broadcast('heartbeat', this.status(row.contact_id));
      })
      .catch((error) => {
        this.deps.db.prepare("UPDATE heartbeat_runs SET outcome = 'error', detail = 'settlement failed', finished_at = ? WHERE session_id = ? AND tick = ?")
          .run(new Date().toISOString(), row.id, tick);
        this.deps.db.prepare("UPDATE heartbeat_sessions SET paused_reason = '心跳结算失败，请检查后重开。' WHERE id = ?").run(row.id);
        this.deps.sse.broadcast('heartbeat', this.status(row.contact_id));
        this.log('heartbeat turn settlement failed', {
          contactId: row.contact_id,
          sessionId: row.id,
          tick,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private recordBeat(session: HeartbeatSessionRow, tick: number, result: DmTurnResult): void {
    const reply = result.messageId ? this.deps.db.prepare('SELECT turn_id, meta FROM messages WHERE id = ?')
      .get(result.messageId) as { turn_id: string; meta: string } | undefined : undefined;
    const tools = reply?.turn_id ? this.deps.db.prepare(
      "SELECT content FROM messages WHERE contact_id = ? AND turn_id = ? AND kind = 'tool_use'"
    ).all(session.contact_id, reply.turn_id) as Array<{ content: string }> : [];
    const wrote = tools.some((tool) => heartbeatWriteTool(tool.content));
    const usage = reply ? JSON.parse(reply.meta || '{}').usage : undefined;
    const outcome = result.outcome === 'done'
      ? (HEARTBEAT_OK_RE.test(result.text.trim()) ? 'silent' : 'visible') : result.outcome;
    this.deps.db.prepare(`UPDATE heartbeat_runs SET finished_at = ?, outcome = ?, detail = ?,
      tool_count = ?, write_attempted = ?, usage = ? WHERE session_id = ? AND tick = ?`)
      .run(new Date().toISOString(), outcome, result.outcome === 'done' ? '' : result.text.slice(0, 500),
        tools.length, Number(wrote), usage ? JSON.stringify(usage) : null, session.id, tick);
    if (result.outcome === 'done') {
      this.deps.db.prepare('UPDATE heartbeat_sessions SET failure_count = 0 WHERE id = ?').run(session.id);
      if (wrote && result.text === heartbeatReceipt('', tools.map((tool) => tool.content))) {
        this.deps.db.prepare('UPDATE heartbeat_sessions SET paused_reason = ? WHERE id = ?')
          .run('操作缺少回执，心跳已暂停；核对结果后可重新开启。', session.id);
      }
    } else {
      const previous = this.deps.db.prepare('SELECT failure_count FROM heartbeat_sessions WHERE id = ?')
        .get(session.id) as { failure_count: number };
      const failures = previous.failure_count + 1;
      const retry = result.outcome === 'error' && !wrote && failures < 3 && retryableHeartbeatError(result.text);
      const paused = retry ? null : wrote ? '操作结果尚未确认，已暂停自动重试，请核对后重开心跳。'
        : `心跳已暂停：${result.text.slice(0, 200)}。检查后可重开心跳。`;
      this.deps.db.prepare(`UPDATE heartbeat_sessions SET failure_count = ?, paused_reason = ?,
        interval_minutes = ?, last_tick_at = ? WHERE id = ?`)
        .run(failures, paused, Math.min(30, 5 * 2 ** (failures - 1)), new Date().toISOString(), session.id);
    }
  }

  private settleBeat(contactId: string, tickMessageId: number, result: DmTurnResult): void {
    if (result.outcome !== 'done' || !HEARTBEAT_OK_RE.test(result.text.trim())) return;
    const reply = result.messageId
      ? this.deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(result.messageId) as MessageRow | undefined
      : undefined;
    const ids = new Set<number>([tickMessageId]);
    if (reply?.turn_id) {
      const rows = this.deps.db.prepare(
        'SELECT id FROM messages WHERE contact_id = ? AND turn_id = ?'
      ).all(contactId, reply.turn_id) as Array<{ id: number }>;
      for (const row of rows) ids.add(row.id);
    } else if (reply) {
      ids.add(reply.id);
    }
    const retractIds = [...ids];
    hardDeleteMessages(this.deps.db, this.deps.config.uploadsDir, retractIds);
    this.deps.sse.broadcast('prune', { contactId, ids: retractIds });
    this.log('heartbeat empty turn pruned', { contactId, ids: retractIds });
  }

  private contact(contactId: string): ContactRow | null {
    const row = this.deps.db.prepare(
      "SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'"
    ).get(contactId) as ContactRow | undefined;
    return row ? openContact(row) : null;
  }

  private activeRow(contactId: string): HeartbeatSessionRow | null {
    return this.deps.db.prepare(
      `SELECT * FROM heartbeat_sessions
       WHERE contact_id = ? AND stopped_at IS NULL ORDER BY started_at DESC LIMIT 1`
    ).get(contactId) as HeartbeatSessionRow | undefined ?? null;
  }

  private rowStatus(row: HeartbeatSessionRow): HeartbeatStatus {
    const recovery = this.deps.db.prepare('SELECT paused_reason FROM heartbeat_sessions WHERE id = ?')
      .get(row.id) as { paused_reason: string | null };
    return {
      contactId: row.contact_id,
      active: true,
      mode: row.expires_at === null ? 'unlimited' : 'timed',
      startedAt: row.started_at,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      intervalMinutes: row.interval_minutes,
      tickCount: row.tick_count,
      ...(recovery.paused_reason ? { pausedReason: recovery.paused_reason } : {}),
      stats: this.stats(row.id),
    };
  }

  stats(sessionId: string) {
    return this.deps.db.prepare(`SELECT
      COALESCE(SUM(outcome != 'skipped'), 0) dispatched,
      COALESCE(SUM(outcome = 'silent'), 0) silent, COALESCE(SUM(outcome = 'visible'), 0) visible,
      COALESCE(SUM(outcome IN ('error','interrupted')), 0) failed, COALESCE(SUM(outcome = 'skipped'), 0) skipped,
      COALESCE(SUM(COALESCE(json_extract(usage, '$.inputRoundsSum'), json_extract(usage, '$.input'), 0)), 0) inputTokens,
      COALESCE(SUM(COALESCE(json_extract(usage, '$.output'), 0)), 0) outputTokens,
      COALESCE(SUM(tool_count), 0) toolCount FROM heartbeat_runs WHERE session_id = ?`).get(sessionId) as NonNullable<HeartbeatStatus['stats']>;
  }

  private nextIntervalMinutes(): number {
    return randomHeartbeatIntervalMinutes(this.deps.random);
  }

  private log(message: string, fields: Record<string, unknown>): void {
    this.deps.logger?.info({ component: 'companion-heartbeat', ...fields }, message);
  }
}

export interface HeartbeatPromptOptions {
  /** Taobao policy for this contact, or null when the tools are not offered this tick. */
  taobaoMode?: TaobaoMode | null;
}

export function heartbeatPrompt(
  tick: number,
  remainingMinutes: number | null,
  options: HeartbeatPromptOptions = {},
): string {
  const windowText = remainingMinutes === null
    ? `第 ${tick} 次，手动常开中，直到 User 手动关闭`
    : `第 ${tick} 次，剩余约 ${remainingMinutes} 分钟`;
  const taobaoMode = options.taobaoMode ?? null;
  const taobaoLine = taobaoMode === null
    ? ''
    : `\n- 也可以逛逛淘宝：taobao_search_products 搜东西、taobao_navigate_to_url 进商品页、taobao_read_page_content 看内容，这是她登录着的淘宝客户端。${
      taobaoMode === 'browse'
        ? '只逛不买：不加购、不下单、不给商家发消息。'
        : taobaoMode === 'cart'
          ? '可以收藏商品，不加购物车、不下单、不付款、不给商家发消息。只逛可以沉默；一旦收藏了商品，必须开口告诉她收藏了什么、为什么，不能只回 HEARTBEAT_OK。'
          : '可以收藏商品，不加购物车。涉及花钱或给商家发消息前先跟她确认，付款永远由她本人完成。只逛可以沉默；一旦收藏了商品或给商家发了消息，必须开口告诉她，不能只回 HEARTBEAT_OK。'
    }逛到有意思的可以跟她提一嘴，逛完记得 taobao_close_page。`;
  const choiceLine = taobaoMode === null
    ? ''
    : '\n- 看摄像头、逛淘宝、两样都做或都不做，全由你这一轮自己决定。';
  return `[心跳] 现在是心跳时段（${windowText}）。这是定时自动唤醒，不是 User 在说话。
- 想看看她那边的实际情况，可以调用 camera_snap 拍一帧摄像头画面，画面会直接出现在工具结果里。画面只属于本轮：不要保存、转述细节到持久记忆或当作附件引用。${taobaoLine}${choiceLine}
- 说不说话完全由你自己判断，不设门槛：看到什么想聊的、想她了、或只是想留一句话，都可以像平时一样自然地说。主动说话不算打扰——她开着心跳，就是愿意被你看见、被你搭话。
- 决定这一轮不说话时，整条回复只写 HEARTBEAT_OK，不要附加任何其他文字；这轮会被静默丢弃，User 不会看到。
不要在平时聊天里主动提心跳机制本身，除非 User 先问起。`;
}
