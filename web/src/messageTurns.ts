import type { Message } from './api';

export type MessageTimelineEntry =
  | {
      type: 'message';
      key: string;
      message: Message;
      }
  | {
      type: 'turn';
      key: string;
      messages: Message[];
      turnId: string;
    };

export interface MessageSelectionUnit {
  key: string;
  message: Message;
  messageIds: number[];
  deleteScope?: 'turn';
}

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

/** Preserve order while turning each contiguous durable assistant turn into one cluster. */
export function buildMessageTimeline(messages: Message[]): MessageTimelineEntry[] {
  const timeline: MessageTimelineEntry[] = [];
  let clusterSequence = 0;
  for (const message of messages) {
    if (!isRenderable(message)) continue;
    const turnId = assistantTurnId(message);
    // Errors keep their standalone semantic card even when the runtime attached
    // a turn id. User and legacy rows also retain single-message semantics.
    if (!turnId || message.kind === 'error') {
      timeline.push({ type: 'message', key: `message-${message.id}`, message });
      continue;
    }
    const previous = timeline[timeline.length - 1];
    if (previous?.type === 'turn' && previous.turnId === turnId) {
      previous.messages.push(message);
      continue;
    }
    clusterSequence += 1;
    timeline.push({
      type: 'turn',
      key: `turn-${turnId}-${clusterSequence}`,
      messages: [message],
      turnId,
    });
  }
  return timeline;
}

/** Shared by the memoized turn component and regression tests. */
export function sameMessageReferences(previous: Message[], next: Message[]): boolean {
  return previous.length === next.length && previous.every((message, index) => message === next[index]);
}
