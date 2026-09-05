import crypto from 'node:crypto';
import type { HubLogger } from '../logger.js';

/**
 * Gateway-side half of the Taobao bridge. The Taobao desktop client only
 * listens on User's PC (localhost:3654), so a contact's tools/call is parked
 * here, handed to the PC Worker through the claim loop (`taobaoRequest`, the
 * same channel as camera `snapRequest`), and resolved when the Worker posts the
 * MCP result back. Mirrors CameraSnapBroker: nothing is persisted, and a
 * request that nobody claims in time fails with a plain-text reason.
 */

export interface TaobaoContentBlock {
  type: 'text';
  text: string;
}

export interface TaobaoBridgeResult {
  ok: boolean;
  text: string;
  content?: TaobaoContentBlock[];
  isError?: boolean;
}

export interface TaobaoRequestPayload {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
}

interface PendingRequest {
  id: string;
  contactId: string;
  name: string;
  arguments: Record<string, unknown>;
  createdAt: number;
  timeoutMs: number;
  claimed: boolean;
  timer: NodeJS.Timeout;
  resolve(result: TaobaoBridgeResult): void;
}

const MAX_PENDING = 4;
const CLAIM_TIMEOUT_MS = 45_000;
const MAX_TEXT_CHARS = 200_000;

export class TaobaoBridge {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly logger?: HubLogger) {}

  request(
    contactId: string,
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 50_000,
  ): Promise<TaobaoBridgeResult> {
    for (const item of this.pending.values()) {
      if (item.contactId === contactId) {
        return Promise.resolve({ ok: false, text: '上一条淘宝操作还没返回，请等它完成再继续。' });
      }
    }
    if (this.pending.size >= MAX_PENDING) {
      return Promise.resolve({ ok: false, text: '淘宝桥接正忙（排队已满），请稍后再试。' });
    }
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        resolve({
          ok: false,
          text: `淘宝客户端 ${Math.round(timeoutMs / 1000)} 秒内没有返回结果（PC 离线 / 淘宝客户端未开启 MCP？）`,
        });
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        id, contactId, name, arguments: args, createdAt: Date.now(), timeoutMs, claimed: false, timer, resolve,
      });
    });
  }

  takePending(caps: { taobao?: boolean }): TaobaoRequestPayload | null {
    if (caps.taobao !== true) return null;
    for (const item of this.pending.values()) {
      if (item.claimed) continue;
      item.claimed = true;
      return {
        id: item.id,
        name: item.name,
        arguments: item.arguments,
        timeoutMs: Math.min(item.timeoutMs, CLAIM_TIMEOUT_MS),
      };
    }
    return null;
  }

  fulfill(requestId: string, result: { content?: unknown; isError?: unknown }): boolean {
    const item = this.pending.get(requestId);
    if (!item) return false;
    clearTimeout(item.timer);
    this.pending.delete(requestId);
    const content = boundedContent(result.content);
    item.resolve({
      ok: true,
      text: content.map((block) => block.text).join('\n'),
      content,
      isError: result.isError === true,
    });
    this.logger?.info({
      component: 'taobao-bridge',
      requestId,
      contactId: item.contactId,
      tool: item.name,
      blocks: content.length,
      isError: result.isError === true,
      elapsedMs: Date.now() - item.createdAt,
    }, 'taobao tool result fulfilled');
    return true;
  }

  fail(requestId: string, reason: string): boolean {
    const item = this.pending.get(requestId);
    if (!item) return false;
    clearTimeout(item.timer);
    this.pending.delete(requestId);
    item.resolve({ ok: false, text: `淘宝操作失败：${reason.slice(0, 1000)}` });
    return true;
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

function boundedContent(raw: unknown): TaobaoContentBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: TaobaoContentBlock[] = [];
  let budget = MAX_TEXT_CHARS;
  for (const block of raw) {
    if (budget <= 0) break;
    if (!block || typeof block !== 'object') continue;
    const text = (block as { text?: unknown }).text;
    if ((block as { type?: unknown }).type !== 'text' || typeof text !== 'string') continue;
    const slice = text.slice(0, budget);
    budget -= slice.length;
    out.push({ type: 'text', text: slice });
  }
  return out;
}
