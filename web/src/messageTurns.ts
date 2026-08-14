import type { Message } from './api';

export type MessageTimelineEntry =
  | {
      type: 'message';
      key: string;
      message: Message;
      turnId: string | null;
      isFinalTurnBlock: boolean;
      compactWithPrevious: boolean;
    }
  | {
      type: 'tools';
      key: string;
      messages: Message[];
      turnId: string | null;
      isFinalTurnBlock: boolean;
      compactWithPrevious: boolean;
    };

export interface MessageSelectionUnit {
  key: string;
  message: Message;
  messageIds: number[];
  deleteScope?: 'turn';
}

type RawMessageTimelineEntry =
  | { type: 'message'; key: string; message: Message; turnId: string | null }
  | { type: 'tools'; key: string; messages: Message[]; turnId: string | null };

export function assistantTurnId(message: Message): string | null {
  return message.role !== 'user' && message.turn_id ? message.turn_id : null;
}

export function messageSelectionKey(message: Message): string {
  const turnId = assistantTurnId(message);
  return turnId ? `turn-${turnId}` : `message-${message.id}`;
}

function isRenderable(message: Message): boolean {
  return message.kind !== 'thinking' || Boolean(message.content) || message.status === 'streaming';
}

/**
 * Build the logical units used by batch selection and deletion.
 * Assistant rows only share a unit when the durable `turn_id` matches; user and
 * legacy rows without `turn_id` always retain single-message semantics.
 */
export function buildMessageSelectionUnits(messages: Message[]): MessageSelectionUnit[] {
  const units = new Map<string, MessageSelectionUnit>();
  for (const message of messages) {
    if (!isRenderable(message)) continue;
    const key = messageSelectionKey(message);
    const existing = units.get(key);
    if (existing) {
      existing.message = message;
      existing.messageIds.push(message.id);
      continue;
    }
    units.set(key, {
      key,
      message,
      messageIds: [message.id],
      ...(assistantTurnId(message) ? { deleteScope: 'turn' as const } : {}),
    });
  }
  return [...units.values()];
}

/**
 * Preserve timeline order while collapsing every turn's tool rows into one block.
 * `turn_id` is the runtime's durable assistant-turn boundary; no timing heuristic is used.
 */
export function buildMessageTimeline(messages: Message[]): MessageTimelineEntry[] {
  const toolGroups = new Map<string, Message[]>();
  for (const message of messages) {
    if (message.kind !== 'tool_use') continue;
    const key = message.turn_id ?? `message-${message.id}`;
    toolGroups.set(key, [...(toolGroups.get(key) ?? []), message]);
  }

  const raw: RawMessageTimelineEntry[] = [];
  for (const message of messages) {
    if (!isRenderable(message)) continue;
    const turnId = assistantTurnId(message);
    if (message.kind !== 'tool_use') {
      raw.push({ type: 'message', key: `message-${message.id}`, message, turnId });
      continue;
    }

    const toolKey = message.turn_id ?? `message-${message.id}`;
    const group = toolGroups.get(toolKey) ?? [message];
    if (group[0].id !== message.id) continue;
    raw.push({ type: 'tools', key: `tools-${toolKey}`, messages: group, turnId });
  }

  const finalBlockByTurn = new Map<string, string>();
  for (const entry of raw) {
    if (entry.turnId) finalBlockByTurn.set(entry.turnId, entry.key);
  }

  return raw.map((entry, index) => ({
    ...entry,
    isFinalTurnBlock: Boolean(entry.turnId && finalBlockByTurn.get(entry.turnId) === entry.key),
    compactWithPrevious: Boolean(entry.turnId && raw[index - 1]?.turnId === entry.turnId),
  }));
}
