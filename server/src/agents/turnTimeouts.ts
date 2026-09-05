import type { TurnEvent } from './types.js';

export type TurnTimeoutKind = 'idle' | 'hard';

export interface TurnTimeoutConfig {
  idleTimeoutMs: number;
  hardTimeoutMs: number;
}

const ACTIVITY_EVENTS = new Set<TurnEvent['type']>([
  'delta',
  'thinking',
  'tool_use',
  'tool_result',
]);

function positiveMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function resolveTurnTimeouts(
  globalConfig: {
    turnTimeoutMs?: number;
    turnIdleTimeoutMs?: number;
    turnHardTimeoutMs?: number;
  },
  profile: {
    turnTimeoutMs?: number;
    turnIdleTimeoutMs?: number;
    turnHardTimeoutMs?: number;
  } = {},
): TurnTimeoutConfig {
  const idleTimeoutMs = positiveMs(
    profile.turnIdleTimeoutMs ?? globalConfig.turnIdleTimeoutMs,
    120_000,
  );
  const hardTimeoutMs = positiveMs(
    profile.turnHardTimeoutMs
      ?? globalConfig.turnHardTimeoutMs,
    900_000,
  );
  return { idleTimeoutMs, hardTimeoutMs };
}

export function timeoutTurnEvent(kind: TurnTimeoutKind): Extract<TurnEvent, { type: 'error' }> {
  return {
    type: 'error',
    message: kind === 'idle'
      ? '这轮空闲超时了，已打断'
      : '这轮达到最长时间，已打断',
    fatal: false,
    reason: 'turn-timeout',
  };
}

export class TurnTimeoutController {
  private idleTimer: NodeJS.Timeout | null = null;
  private hardTimer: NodeJS.Timeout | null = null;
  private finished = false;

  constructor(
    private readonly config: TurnTimeoutConfig,
    private readonly onTimeout: (kind: TurnTimeoutKind) => void,
  ) {}

  start(): void {
    this.finish();
    this.finished = false;
    this.armIdle();
    this.hardTimer = setTimeout(() => this.fire('hard'), this.config.hardTimeoutMs);
  }

  activity(event: Pick<TurnEvent, 'type'>): void {
    if (this.finished || !ACTIVITY_EVENTS.has(event.type)) return;
    this.armIdle();
  }

  /** Reset idle for child output that is not a user-visible activity event (JSON init, stderr). */
  pulse(): void {
    if (this.finished) return;
    this.armIdle();
  }

  finish(): void {
    this.finished = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.idleTimer = null;
    this.hardTimer = null;
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.fire('idle'), this.config.idleTimeoutMs);
  }

  private fire(kind: TurnTimeoutKind): void {
    if (this.finished) return;
    this.finish();
    this.onTimeout(kind);
  }
}
