import { CodexAppServerBackend, type CodexRateLimits } from '../agents/codexAppServer.js';

export interface CodexQuotaSnapshot {
  fiveHour: { remainingPct: number; resetsAt: string | null } | null;
  sevenDay: { remainingPct: number; resetsAt: string | null } | null;
  fetchedAt: string;
}

export class CodexQuotaPoller {
  private snapshot: CodexQuotaSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private failures = 0;

  constructor(
    private opts: { cliPath: string; cwd: string },
    private log: (msg: string) => void
  ) {}

  start(): void {
    void this.poll();
  }

  get(): CodexQuotaSnapshot | null {
    return this.snapshot;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private window(w: CodexRateLimits['primary']) {
    if (!w) return null;
    return {
      remainingPct: Math.max(0, Math.min(100, Math.round(100 - Number(w.usedPercent ?? 0)))),
      resetsAt: w.resetsAt ? new Date(Number(w.resetsAt) * 1000).toISOString() : null,
    };
  }

  private async poll(): Promise<void> {
    try {
      const limits = await CodexAppServerBackend.readRateLimits({
        ...this.opts,
        log: this.log,
      });
      const windows = [limits.primary, limits.secondary].filter(
        (w): w is NonNullable<typeof w> => w !== null
      );
      this.snapshot = {
        fiveHour: this.window(
          windows.find((w) => w.windowDurationMins !== null && w.windowDurationMins <= 360) ?? null
        ),
        sevenDay: this.window(
          windows.find((w) => w.windowDurationMins !== null && w.windowDurationMins >= 7 * 24 * 60) ?? null
        ),
        fetchedAt: new Date().toISOString(),
      };
      this.failures = 0;
    } catch (e: any) {
      this.failures++;
      this.log(`codex quota poll failed (${this.failures}): ${e.message}`);
    }
    if (this.stopped) return;
    const delay = this.failures ? Math.min(60_000 * 2 ** this.failures, 15 * 60_000) : 2 * 60_000;
    this.timer = setTimeout(() => void this.poll(), delay);
  }
}
