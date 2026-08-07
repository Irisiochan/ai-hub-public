import crypto from 'node:crypto';
import type { AgentManager } from '../agents/manager.js';
import type { DmTurnResult } from '../agents/runtime.js';
import {
  MAX_IMAGES_PER_MESSAGE,
  deleteMessageFiles,
  persistImageBuffer,
  withAttachments,
} from '../attachments.js';
import type { ContactRow, Db, MessageRow } from '../db.js';
import type { HubLogger } from '../logger.js';
import type { SseHub } from '../sse.js';
import type { WechatChannelConfig } from './config.js';
import { downloadWechatImage, type DownloadedWechatImage } from './media.js';
import {
  WECHAT_ITEM_TYPE,
  WECHAT_MESSAGE_TYPE,
  WechatApiClient,
  type WechatMessage,
} from './protocol.js';
import { routeWechatInput, type WechatTargetId } from './routing.js';
import {
  loadWechatChannelState,
  saveWechatChannelState,
  type WechatChannelState,
} from './state.js';

const RETRY_DELAY_MS = 2_000;
const FAILURE_BACKOFF_MS = 30_000;
const STALE_TOKEN_BACKOFF_MS = 60 * 60_000;
const STALE_TOKEN_CODE = -14;
const TEXT_CHUNK_LIMIT = 4_000;

interface WechatMessageMeta {
  channel: 'wechat';
  wechat: {
    platformMessageId: string;
    targetId: WechatTargetId;
    status: 'processing' | 'reply-ready' | 'sent' | 'failed';
    replyMessageId?: number;
    sentAt?: string;
    error?: string;
  };
}

export interface WechatChannelStatus {
  enabled: boolean;
  running: boolean;
  lastPollAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  lastError: string | null;
}

export interface WechatChannelDeps {
  config: WechatChannelConfig;
  db: Db;
  sse: SseHub;
  manager: AgentManager;
  uploadsDir: string;
  logger: HubLogger;
  api?: WechatApiClient;
  fetchImpl?: typeof fetch;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function parseMeta(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function platformMessageId(message: WechatMessage): string {
  if (message.message_id !== undefined) return String(message.message_id);
  if (message.client_id?.trim()) return message.client_id.trim();
  const stable = JSON.stringify({
    seq: message.seq,
    from: message.from_user_id,
    at: message.create_time_ms,
    items: message.item_list,
  });
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 32);
}

function textItems(message: WechatMessage): string {
  return (message.item_list ?? [])
    .filter((item) => item.type === WECHAT_ITEM_TYPE.text && item.text_item?.text)
    .map((item) => String(item.text_item?.text ?? '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function splitText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const newline = window.lastIndexOf('\n');
    const whitespace = window.lastIndexOf(' ');
    const splitAt = Math.max(newline, whitespace, Math.floor(limit * 0.6));
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining || chunks.length === 0) chunks.push(remaining);
  return chunks;
}

export class WechatChannel {
  private readonly api: WechatApiClient;
  private readonly fetchImpl: typeof fetch;
  private state: WechatChannelState;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private snapshot: WechatChannelStatus;

  constructor(private readonly deps: WechatChannelDeps) {
    this.api = deps.api ?? new WechatApiClient({
      baseUrl: deps.config.baseUrl,
      token: deps.config.token,
    });
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.state = deps.config.enabled
      ? loadWechatChannelState(deps.config.stateFile)
      : { cursor: '', sticky: null };
    this.snapshot = {
      enabled: deps.config.enabled,
      running: false,
      lastPollAt: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      lastError: null,
    };
  }

  status(): WechatChannelStatus {
    return { ...this.snapshot };
  }

  start(): void {
    if (!this.deps.config.enabled || this.loop) return;
    this.abort = new AbortController();
    this.snapshot.running = true;
    this.loop = this.run(this.abort.signal).finally(() => {
      this.snapshot.running = false;
      this.loop = null;
      this.abort = null;
    });
  }

  async stop(): Promise<void> {
    const loop = this.loop;
    this.abort?.abort();
    if (loop) await loop;
  }

  private log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}): void {
    this.deps.logger[level]({ component: 'wechat-channel', ...fields }, message);
  }

  private error(error: unknown, message: string): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.snapshot.lastError = detail.slice(0, 500);
    this.log('error', message, { err: detail });
  }

  private saveState(): void {
    saveWechatChannelState(this.deps.config.stateFile, this.state);
  }

  private async run(signal: AbortSignal): Promise<void> {
    try {
      await this.api.notifyStart();
      this.log('info', 'WeChat channel started', {
        botId: this.deps.config.botId,
        cursorBytes: this.state.cursor.length,
      });
    } catch (error) {
      this.error(error, 'WeChat notifystart failed; polling will retry independently');
    }

    let consecutiveFailures = 0;
    let nextPollMs = this.deps.config.longPollMs;
    while (!signal.aborted) {
      try {
        const response = await this.api.getUpdates(this.state.cursor, nextPollMs, signal);
        if (signal.aborted) break;
        this.snapshot.lastPollAt = new Date().toISOString();
        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          nextPollMs = Math.min(Math.max(response.longpolling_timeout_ms, 5_000), 60_000);
        }
        const errorCode = response.errcode || response.ret || 0;
        if (errorCode !== 0) {
          const delay = errorCode === STALE_TOKEN_CODE ? STALE_TOKEN_BACKOFF_MS : RETRY_DELAY_MS;
          this.error(
            new Error(`ret=${response.ret ?? 0} errcode=${response.errcode ?? 0} ${response.errmsg ?? ''}`.trim()),
            errorCode === STALE_TOKEN_CODE
              ? 'WeChat bot token is stale; pausing for one hour'
              : 'WeChat getupdates returned an API error',
          );
          consecutiveFailures = errorCode === STALE_TOKEN_CODE ? 0 : consecutiveFailures + 1;
          await sleep(delay, signal);
          continue;
        }
        consecutiveFailures = 0;
        for (const message of response.msgs ?? []) await this.handleInbound(message);
        if (response.get_updates_buf) {
          this.state.cursor = response.get_updates_buf;
          this.saveState();
        }
      } catch (error) {
        if (signal.aborted) break;
        consecutiveFailures++;
        this.error(error, 'WeChat polling/dispatch failed');
        await sleep(consecutiveFailures >= 3 ? FAILURE_BACKOFF_MS : RETRY_DELAY_MS, signal);
        if (consecutiveFailures >= 3) consecutiveFailures = 0;
      }
    }

    try {
      await this.api.notifyStop();
    } catch (error) {
      this.error(error, 'WeChat notifystop failed during shutdown');
    }
    this.log('info', 'WeChat channel stopped');
  }

  private async handleInbound(message: WechatMessage): Promise<void> {
    const from = message.from_user_id?.trim() ?? '';
    if (!this.deps.config.allowFrom.has(from)) {
      this.log('warn', 'Dropped non-whitelisted WeChat sender');
      return;
    }
    if (message.to_user_id && message.to_user_id !== this.deps.config.botId) {
      this.log('warn', 'Dropped WeChat message addressed to another bot');
      return;
    }
    if (message.message_type !== undefined && message.message_type !== WECHAT_MESSAGE_TYPE.user) return;

    this.snapshot.lastInboundAt = new Date().toISOString();
    const id = platformMessageId(message);
    const rawText = textItems(message);
    const route = routeWechatInput(rawText, this.state.sticky);
    if (!route) {
      await this.sendSystem(message, id, '发给谁？Claude / Codex / 阿野');
      return;
    }
    this.state.sticky = { targetId: route.targetId, touchedAt: Date.now() };
    this.saveState();

    const items = message.item_list ?? [];
    if (items.some((item) => item.type === WECHAT_ITEM_TYPE.voice)) {
      await this.sendSystem(message, id, '暂时听不懂语音，打字吧');
      return;
    }
    if (items.some((item) => item.type === WECHAT_ITEM_TYPE.file || item.type === WECHAT_ITEM_TYPE.video)) {
      await this.sendSystem(message, id, '暂时只支持文字和图片');
      return;
    }
    const imageItems = items.filter((item) => item.type === WECHAT_ITEM_TYPE.image).slice(0, MAX_IMAGES_PER_MESSAGE);
    if (!route.text && imageItems.length === 0) {
      await this.sendSystem(message, id, `已切到${this.targetLabel(route.targetId)}，接着说`);
      return;
    }

    let images: DownloadedWechatImage[] = [];
    try {
      images = await Promise.all(
        imageItems.map((item) => downloadWechatImage(item, this.deps.config.cdnBaseUrl, this.fetchImpl)),
      );
    } catch (error) {
      this.error(error, 'WeChat image download/decrypt failed');
      await this.sendSystem(message, id, '图片没接住，请重新发一次');
      return;
    }

    const typing = await this.startTyping(from, message.context_token);
    try {
      await this.dispatchToHub({
        platformId: id,
        targetId: route.targetId,
        text: route.text || '请看这张图片。',
        images,
        to: from,
        contextToken: message.context_token,
      });
    } finally {
      await typing();
    }
  }

  private targetLabel(targetId: WechatTargetId): string {
    return targetId === 'claude' ? 'Claude' : targetId === 'codex' ? 'Codex' : '阿野';
  }

  private async startTyping(userId: string, contextToken?: string): Promise<() => Promise<void>> {
    let ticket: string | null = null;
    try {
      ticket = await this.api.getTypingTicket(userId, contextToken);
      if (!ticket) return async () => {};
      await this.api.sendTyping(userId, ticket, 1);
    } catch (error) {
      this.log('warn', 'WeChat typing indicator unavailable', {
        err: error instanceof Error ? error.message : String(error),
      });
      return async () => {};
    }
    const keepalive = setInterval(() => {
      void this.api.sendTyping(userId, ticket!, 1).catch((error) => {
        this.log('warn', 'WeChat typing keepalive failed', {
          err: error instanceof Error ? error.message : String(error),
        });
      });
    }, 5_000);
    return async () => {
      clearInterval(keepalive);
      try {
        await this.api.sendTyping(userId, ticket!, 2);
      } catch (error) {
        this.log('warn', 'WeChat typing cancel failed', {
          err: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }

  private contact(targetId: WechatTargetId): ContactRow {
    const row = this.deps.db
      .prepare("SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'")
      .get(targetId) as ContactRow | undefined;
    if (!row) throw new Error(`WeChat target contact ${targetId} is unavailable`);
    return row;
  }

  private updateWechatMeta(row: MessageRow, update: Partial<WechatMessageMeta['wechat']>): MessageRow {
    const meta = parseMeta(row.meta);
    const current = meta.wechat && typeof meta.wechat === 'object' && !Array.isArray(meta.wechat)
      ? meta.wechat as Record<string, unknown>
      : {};
    const next = { ...meta, channel: 'wechat', wechat: { ...current, ...update } };
    this.deps.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(next), row.id);
    return this.deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(row.id) as MessageRow;
  }

  private correlatedReply(contactId: string, userMessageId: number): MessageRow | null {
    return this.deps.db.prepare(
      `SELECT * FROM messages
       WHERE contact_id = ? AND status = 'done' AND deleted = 0
         AND kind IN ('text', 'error')
         AND json_extract(meta, '$.replyToMessageId') = ?
       ORDER BY id DESC LIMIT 1`,
    ).get(contactId, userMessageId) as MessageRow | undefined ?? null;
  }

  private async dispatchToHub(input: {
    platformId: string;
    targetId: WechatTargetId;
    text: string;
    images: DownloadedWechatImage[];
    to: string;
    contextToken?: string;
  }): Promise<void> {
    const contact = this.contact(input.targetId);
    const idempotencyKey = `wechat:${input.platformId}`.slice(0, 200);
    let userRow = this.deps.db.prepare(
      'SELECT * FROM messages WHERE contact_id = ? AND idempotency_key = ?',
    ).get(contact.id, idempotencyKey) as MessageRow | undefined;

    if (!userRow) {
      const meta: WechatMessageMeta = {
        channel: 'wechat',
        wechat: {
          platformMessageId: input.platformId,
          targetId: input.targetId,
          status: 'processing',
        },
      };
      const result = this.deps.db.prepare(
        `INSERT INTO messages
         (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
         VALUES (?, 'user', 'user', 'text', ?, 'done', ?, 'main', ?)`,
      ).run(contact.id, input.text, JSON.stringify(meta), idempotencyKey);
      userRow = this.deps.db.prepare('SELECT * FROM messages WHERE id = ?')
        .get(Number(result.lastInsertRowid)) as MessageRow;
      try {
        input.images.forEach((image, index) => persistImageBuffer(
          this.deps.db,
          this.deps.uploadsDir,
          userRow!.id,
          {
            bytes: image.bytes,
            mimeType: image.mimeType,
            originalName: `wechat-${input.platformId}-${index + 1}${image.mimeType === 'image/jpeg' ? '.jpg' : `.${image.mimeType.slice(6)}`}`,
          },
        ));
      } catch (error) {
        deleteMessageFiles(this.deps.db, this.deps.uploadsDir, userRow.id);
        this.deps.db.prepare('DELETE FROM messages WHERE id = ?').run(userRow.id);
        throw error;
      }
      this.deps.sse.broadcast('message', withAttachments(this.deps.db, userRow));
    }

    const meta = parseMeta(userRow.meta) as Partial<WechatMessageMeta>;
    if (meta.wechat?.status === 'sent') return;

    let reply = meta.wechat?.replyMessageId
      ? this.deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(meta.wechat.replyMessageId) as MessageRow | undefined
      : undefined;
    reply ??= this.correlatedReply(contact.id, userRow.id) ?? undefined;

    if (!reply) {
      const tracked = this.deps.manager.get(contact).enqueueTracked({
        userMessageId: userRow.id,
        text: userRow.content,
      });
      if (tracked.status === 'full') {
        this.updateWechatMeta(userRow, { status: 'failed', error: 'queue full' });
        await this.sendSystemRaw(input.to, input.contextToken, input.platformId, '排队太长了，等一下再发');
        return;
      }
      const result: DmTurnResult = await tracked.completion;
      reply = result.messageId
        ? this.deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(result.messageId) as MessageRow | undefined
        : undefined;
      if (!reply) throw new Error(`ai-hub turn ended without a reply row (${result.outcome})`);
    }

    userRow = this.updateWechatMeta(userRow, {
      status: 'reply-ready',
      replyMessageId: reply.id,
      error: undefined,
    });
    await this.sendAgentText(
      input.to,
      input.contextToken,
      input.platformId,
      contact.name,
      reply.content || '（没有回复内容）',
    );
    this.updateWechatMeta(userRow, {
      status: 'sent',
      replyMessageId: reply.id,
      sentAt: new Date().toISOString(),
    });
  }

  private async sendAgentText(
    to: string,
    contextToken: string | undefined,
    platformId: string,
    name: string,
    text: string,
  ): Promise<void> {
    const prefix = `[${name}] `;
    const chunks = splitText(text, TEXT_CHUNK_LIMIT - prefix.length);
    for (let index = 0; index < chunks.length; index++) {
      await this.api.sendText({
        to,
        contextToken,
        text: `${prefix}${chunks[index]}`,
        clientId: `ai-hub-${platformId}-reply-${index + 1}`,
        runId: `ai-hub-${platformId}`,
      });
      this.snapshot.lastOutboundAt = new Date().toISOString();
    }
  }

  private async sendSystem(message: WechatMessage, platformId: string, text: string): Promise<void> {
    await this.sendSystemRaw(
      message.from_user_id ?? '',
      message.context_token,
      platformId,
      text,
    );
  }

  private async sendSystemRaw(
    to: string,
    contextToken: string | undefined,
    platformId: string,
    text: string,
  ): Promise<void> {
    await this.api.sendText({
      to,
      contextToken,
      text,
      clientId: `ai-hub-${platformId}-system`,
      runId: `ai-hub-${platformId}`,
    });
    this.snapshot.lastOutboundAt = new Date().toISOString();
  }
}
