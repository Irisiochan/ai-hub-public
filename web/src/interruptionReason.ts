import type { Message } from './api';

export const TURN_INTERRUPTION_REASONS = [
  'turn-timeout',
  'user-interrupt',
  'deploy-restart',
  'claude-error',
] as const;

export type TurnInterruptionReason = (typeof TURN_INTERRUPTION_REASONS)[number];

export function interruptionReason(message: Pick<Message, 'meta'>): TurnInterruptionReason | null {
  try {
    const value = JSON.parse(message.meta || '{}')?.interruptionReason;
    return TURN_INTERRUPTION_REASONS.includes(value) ? value : null;
  } catch {
    return null;
  }
}

export function displayedErrorContent(message: Pick<Message, 'content' | 'meta'>): string {
  const reason = interruptionReason(message);
  if (reason === 'turn-timeout') return '这轮超时了，已打断';
  if (reason === 'user-interrupt') return '这轮被打断了';
  if (reason === 'deploy-restart') {
    try {
      if (JSON.parse(message.meta || '{}')?.resumeQueued === true) {
        return '部署重启中断，已排队续跑';
      }
    } catch {}
    return '部署重启中断';
  }
  return message.content;
}
