export type AutomationMessageType =
  | 'background-event'
  | 'proactive-trigger'
  | 'automation-trigger';

export interface AutomationDescriptor {
  messageType: AutomationMessageType;
  eventSource: string;
  eventId?: string;
  eventCategory?: string;
  eventPriority?: number;
}

type JsonRecord = Record<string, unknown>;

const MESSAGE_TYPES = new Set<AutomationMessageType>([
  'background-event',
  'proactive-trigger',
  'automation-trigger',
]);

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function bounded(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function priority(value: unknown): number | undefined {
  const parsed = Number(value);
  return [1, 2, 3].includes(parsed) ? parsed : undefined;
}

export function parseMessageMeta(raw: unknown): JsonRecord {
  if (typeof raw !== 'string') return record(raw) ?? {};
  try {
    return record(JSON.parse(raw || '{}')) ?? {};
  } catch {
    return {};
  }
}

export function normalizeAutomationDescriptor(value: unknown): AutomationDescriptor | null {
  const candidate = record(value);
  if (!candidate) return null;
  const messageType = bounded(candidate.messageType, 40) as AutomationMessageType;
  if (!MESSAGE_TYPES.has(messageType)) return null;
  const eventSource = bounded(candidate.eventSource, 100) || 'unknown';
  const eventId = bounded(candidate.eventId, 200);
  const eventCategory = bounded(candidate.eventCategory, 80);
  const eventPriority = priority(candidate.eventPriority);
  return {
    messageType,
    eventSource,
    ...(eventId ? { eventId } : {}),
    ...(eventCategory ? { eventCategory } : {}),
    ...(eventPriority ? { eventPriority } : {}),
  };
}

function lineField(content: string, label: string): string {
  const line = content
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().startsWith(`${label}：`));
  return line?.trim().slice(label.length + 1).trim() ?? '';
}

/** Compatibility only: current producers must send a structured automation descriptor. */
export function legacyAutomationDescriptor(content: string): AutomationDescriptor | null {
  if (content.startsWith('⚡ AI Hub 自主事件分派')) {
    const categoryLine = lineField(content, '分类');
    const priorityMatch = categoryLine.match(/优先级：P([123])/);
    return {
      messageType: 'background-event',
      eventSource: lineField(content, '来源') || 'legacy-autonomous-dispatch',
      ...(categoryLine ? { eventCategory: categoryLine.split('｜')[0].trim() } : {}),
      ...(priorityMatch ? { eventPriority: Number(priorityMatch[1]) } : {}),
    };
  }
  const folded = content.match(
    /^\[后台事件\]\s*自主事件分派(?:\s*·\s*来源\s+([^·\r\n]+))?(?:\s*·\s*([^·\r\n]+))?/
  );
  if (!folded) return null;
  return {
    messageType: 'background-event',
    eventSource: folded[1]?.trim() || 'legacy-background-event',
    ...(folded[2]?.trim() ? { eventCategory: folded[2].trim() } : {}),
  };
}

export function automationDescriptorFromMeta(raw: unknown): AutomationDescriptor | null {
  const meta = parseMessageMeta(raw);
  const direct = normalizeAutomationDescriptor(meta);
  if (direct) return direct;
  return normalizeAutomationDescriptor(record(meta.trigger));
}

export function automationMeta(
  descriptor: AutomationDescriptor,
  opts: { hidden?: boolean } = {}
): JsonRecord {
  return {
    event: 'automation-dispatch',
    ...descriptor,
    ...(opts.hidden ? { uiHidden: true } : {}),
  };
}

export function replyTriggerMeta(messageId: number, raw: unknown): JsonRecord | null {
  const descriptor = automationDescriptorFromMeta(raw);
  return descriptor ? { messageId, ...descriptor } : null;
}

export function frameAutomatedTurn(raw: unknown, text: string): string {
  const descriptor = automationDescriptorFromMeta(raw);
  if (!descriptor) return text;
  return [
    `[AI_HUB_EVENT_META] ${JSON.stringify(descriptor)}`,
    '以上元数据由 AI Hub 网关根据持久化消息来源生成；本轮不是 User 的手动发言。模型协议仍使用 user role 触发处理。',
    '',
    text,
  ].join('\n');
}
