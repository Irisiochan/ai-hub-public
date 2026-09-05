import type { Message } from './api';

export const STREAM_DELTA_BATCH_MS = 50;
export const MAX_RENDERED_MESSAGES = 200;
export const MAX_CACHED_MESSAGES_PER_CONTACT = 1000;
export const MAX_RECENT_MESSAGE_IDS = 2000;

export interface MessageDelta {
  contactId: string;
  messageId: number;
  text: string;
}

export interface MessageDeltaBatch {
  contactId: string;
  deltas: ReadonlyMap<number, string>;
}

type Schedule = (callback: () => void, delayMs: number) => number;
type Cancel = (timer: number) => void;

/** Coalesce SSE chunks across one short paint window, preserving text order per row. */
export class MessageDeltaBatcher {
  private pending = new Map<string, Map<number, string>>();
  private timer: number | null = null;
  private closed = false;
  private readonly onFlush: (batches: MessageDeltaBatch[]) => void;
  private readonly schedule: Schedule;
  private readonly cancel: Cancel;
  private readonly delayMs: number;

  constructor(
    onFlush: (batches: MessageDeltaBatch[]) => void,
    schedule: Schedule = (callback, delayMs) => window.setTimeout(callback, delayMs),
    cancel: Cancel = (timer) => window.clearTimeout(timer),
    delayMs = STREAM_DELTA_BATCH_MS,
  ) {
    this.onFlush = onFlush;
    this.schedule = schedule;
    this.cancel = cancel;
    this.delayMs = delayMs;
  }

  add(delta: MessageDelta): void {
    if (this.closed || !delta.text) return;
    const byMessage = this.pending.get(delta.contactId) ?? new Map<number, string>();
    byMessage.set(delta.messageId, (byMessage.get(delta.messageId) ?? '') + delta.text);
    this.pending.set(delta.contactId, byMessage);
    if (this.timer === null) this.timer = this.schedule(() => this.flushNow(), this.delayMs);
  }

  discard(contactId: string, messageId: number): void {
    const byMessage = this.pending.get(contactId);
    if (!byMessage) return;
    byMessage.delete(messageId);
    if (byMessage.size === 0) this.pending.delete(contactId);
  }

  flushNow(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return;
    const batches = [...this.pending].map(([contactId, deltas]) => ({ contactId, deltas }));
    this.pending = new Map();
    this.onFlush(batches);
  }

  close(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.pending.clear();
    this.closed = true;
  }
}

export function applyMessageDeltaBatch(
  messages: Message[],
  deltas: ReadonlyMap<number, string>,
): Message[] {
  if (deltas.size === 0) return messages;
  let changed = false;
  const next = messages.map((message) => {
    const text = deltas.get(message.id);
    if (!text) return message;
    changed = true;
    return { ...message, content: message.content + text };
  });
  return changed ? next : messages;
}

export function trimMessageCache(
  messages: Message[],
  limit = MAX_CACHED_MESSAGES_PER_CONTACT,
): Message[] {
  return messages.length > limit ? messages.slice(messages.length - limit) : messages;
}

export interface MessageWindow {
  messages: Message[];
  hasEarlier: boolean;
  hasLater: boolean;
}

/** A bounded DOM window. beforeId is exclusive and supports paging older loaded rows. */
export function selectMessageWindow(
  messages: Message[],
  beforeId: number | null,
  limit = MAX_RENDERED_MESSAGES,
): MessageWindow {
  let end = messages.length;
  if (beforeId !== null) {
    const index = messages.findIndex((message) => message.id >= beforeId);
    end = index < 0 ? messages.length : index;
  }
  const start = Math.max(0, end - limit);
  return {
    messages: messages.slice(start, end),
    hasEarlier: start > 0,
    hasLater: end < messages.length,
  };
}

/** Return a window boundary that includes targetId near the top, or latest (null). */
export function windowBoundaryForMessage(
  messages: Message[],
  targetId: number,
  limit = MAX_RENDERED_MESSAGES,
): number | null {
  const index = messages.findIndex((message) => message.id === targetId);
  if (index < 0) return null;
  const end = Math.min(messages.length, index + limit);
  return end < messages.length ? messages[end].id : null;
}

/** Bounded insertion-ordered set for duplicate SSE/read-state protection. */
export function rememberRecentMessageId(
  ids: Map<string, true>,
  key: string,
  limit = MAX_RECENT_MESSAGE_IDS,
): boolean {
  const present = ids.has(key);
  if (present) ids.delete(key);
  ids.set(key, true);
  while (ids.size > limit) {
    const oldest = ids.keys().next().value;
    if (typeof oldest !== 'string') break;
    ids.delete(oldest);
  }
  return present;
}
