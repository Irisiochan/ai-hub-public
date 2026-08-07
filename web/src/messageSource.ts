import type { Message, MessageOrigin } from './api';

export interface AutomationDescriptor {
  messageType: 'background-event' | 'proactive-trigger' | 'automation-trigger';
  eventSource: string;
  eventId?: string;
  eventCategory?: string;
  eventPriority?: number;
}

function parsedMeta(message: Pick<Message, 'meta'>): Record<string, any> {
  try {
    const value = JSON.parse(message.meta || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function normalized(value: any): AutomationDescriptor | null {
  if (!value || typeof value !== 'object') return null;
  if (!['background-event', 'proactive-trigger', 'automation-trigger'].includes(value.messageType)) {
    return null;
  }
  return {
    messageType: value.messageType,
    eventSource: typeof value.eventSource === 'string' && value.eventSource.trim()
      ? value.eventSource.trim()
      : 'unknown',
    ...(typeof value.eventId === 'string' && value.eventId.trim()
      ? { eventId: value.eventId.trim() }
      : {}),
    ...(typeof value.eventCategory === 'string' && value.eventCategory.trim()
      ? { eventCategory: value.eventCategory.trim() }
      : {}),
    ...([1, 2, 3].includes(Number(value.eventPriority))
      ? { eventPriority: Number(value.eventPriority) }
      : {}),
  };
}

/** Structured metadata is authoritative; content checks only support pre-metadata rows. */
export function automationDescriptor(
  message: Pick<Message, 'content' | 'meta'>
): AutomationDescriptor | null {
  const meta = parsedMeta(message);
  const direct = normalized(meta);
  if (direct) return direct;
  const trigger = normalized(meta.trigger);
  if (trigger) return trigger;
  if (message.content.startsWith('⚡ AI Hub 自主事件分派')) {
    const source = lineField(message.content, '来源');
    const categoryLine = lineField(message.content, '分类');
    const priority = categoryLine.match(/优先级：P([123])/)?.[1];
    return {
      messageType: 'background-event',
      eventSource: source || 'legacy-autonomous-dispatch',
      ...(categoryLine ? { eventCategory: categoryLine.split('｜')[0].trim() } : {}),
      ...(priority ? { eventPriority: Number(priority) } : {}),
    };
  }
  const folded = message.content.match(
    /^\[后台事件\]\s*自主事件分派(?:\s*·\s*来源\s+([^·\r\n]+))?(?:\s*·\s*([^·\r\n]+))?/
  );
  return folded ? {
    messageType: 'background-event',
    eventSource: folded[1]?.trim() || 'legacy-background-event',
    ...(folded[2]?.trim() ? { eventCategory: folded[2].trim() } : {}),
  } : null;
}

export function effectiveMessageOrigin(
  message: Pick<Message, 'content' | 'meta' | 'origin'>
): MessageOrigin {
  return automationDescriptor(message)?.messageType === 'background-event'
    ? 'side'
    : message.origin;
}

export function isManualUserMessage(
  message: Pick<Message, 'content' | 'meta' | 'origin' | 'sender'>
): boolean {
  return message.sender === 'user'
    && effectiveMessageOrigin(message) === 'main'
    && automationDescriptor(message) === null;
}

function lineField(content: string, label: string): string {
  const line = content
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith(`${label}：`));
  return line?.trim().slice(label.length + 1).trim() ?? '';
}
