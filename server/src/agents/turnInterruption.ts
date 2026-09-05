export const TURN_INTERRUPTION_REASONS = [
  'turn-timeout',
  'user-interrupt',
  'deploy-restart',
  'claude-error',
] as const;

export type TurnInterruptionReason = (typeof TURN_INTERRUPTION_REASONS)[number];

export function interruptionDisplayText(
  reason: TurnInterruptionReason,
  fallback: string,
): string {
  if (reason === 'turn-timeout') return '这轮超时了，已打断';
  if (reason === 'user-interrupt') return '这轮被打断了';
  if (reason === 'deploy-restart') return '部署重启中断';
  return fallback;
}
