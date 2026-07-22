import type { ContactStatus } from './api';

/**
 * Status line / typing hint.
 * Room labels use `status.member` only — never the room title (contact.name).
 * Regression: mid-turn resync used to drop member and typing-hint fell back to
 * contact.name → 「会议室 思考中」.
 */
export function statusText(
  status: ContactStatus,
  opts?: { isRoom?: boolean; contactName?: string }
): string {
  // DM may show contact name when member is absent; rooms must not fall back to room title.
  const who = status.member
    ? `${status.member} `
    : !opts?.isRoom && opts?.contactName
      ? `${opts.contactName} `
      : '';
  if (status.state === 'thinking') return `${who}思考中…`;
  if (status.state === 'streaming') return `${who}正在输入…`;
  if (status.state.startsWith('tool:')) return `${who}正在用 ${status.state.slice(5)}`;
  if (status.state === 'error') return '出错了，可以再试一次或重置会话';
  return '';
}
