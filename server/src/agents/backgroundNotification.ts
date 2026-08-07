import { automationDescriptorFromMeta, type AutomationDescriptor } from './messageSource.js';

export type BackgroundNotificationKind =
  | 'no_op'
  | 'state_change'
  | 'due_escalation'
  | 'failure'
  | 'delivery_block'
  | 'user_decision';

export interface BackgroundNotificationDecision {
  route: 'suppress' | 'side' | 'main';
  kind: BackgroundNotificationKind | 'unclassified';
  content: string;
  key: string;
  descriptor: AutomationDescriptor | null;
}

const MAIN_KINDS = new Set<BackgroundNotificationKind>([
  'state_change', 'due_escalation', 'failure', 'delivery_block', 'user_decision',
]);
const MARKER_RE = /^\s*\[AI_HUB_NOTIFY\]\s*(\{[^\r\n]+\})\s*(?:\r?\n|$)/i;
const NO_OP_RE = /^\s*(?:NO[_ -]?OP|无需动作|无变化|无需通知)(?:\s*[:：-].*)?\s*$/i;

function compactKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 180);
}

function marker(content: string): { kind: BackgroundNotificationKind; key: string } | null {
  const match = content.match(MARKER_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as { kind?: unknown; key?: unknown };
    const kind = typeof parsed.kind === 'string'
      ? parsed.kind.trim().toLowerCase() as BackgroundNotificationKind
      : 'no_op';
    if (!MAIN_KINDS.has(kind) && kind !== 'no_op') return null;
    return {
      kind,
      key: typeof parsed.key === 'string' ? compactKey(parsed.key) : '',
    };
  } catch {
    return null;
  }
}

/** Conservative routing: only an explicit allowed marker may interrupt the main chat. */
export function decideBackgroundNotification(content: string, sourceMeta: unknown): BackgroundNotificationDecision {
  const descriptor = automationDescriptorFromMeta(sourceMeta);
  const trimmed = content.trim();
  const parsed = marker(trimmed);
  const body = parsed ? trimmed.replace(MARKER_RE, '').trim() : trimmed;
  const source = descriptor?.eventSource ?? 'background';

  if (!trimmed || (parsed?.kind === 'no_op') || (!parsed && NO_OP_RE.test(trimmed))) {
    return {
      route: 'suppress',
      kind: 'no_op',
      content: body || trimmed || 'NO_OP',
      key: `${source}:no_op`,
      descriptor,
    };
  }

  if (parsed && MAIN_KINDS.has(parsed.kind)) {
    return {
      route: 'main',
      kind: parsed.kind,
      content: body,
      key: `${source}:${parsed.key || compactKey(body) || parsed.kind}`,
      descriptor,
    };
  }

  return {
    route: 'side',
    kind: 'unclassified',
    content: trimmed,
    key: `${source}:unclassified:${compactKey(trimmed)}`,
    descriptor,
  };
}

export function backgroundDedupeMinutes(): number {
  const parsed = Number(process.env.AI_HUB_BACKGROUND_NOTIFY_DEDUPE_MINUTES ?? 30);
  return Number.isFinite(parsed) ? Math.max(Math.min(parsed, 24 * 60), 0) : 30;
}
