import type { Db } from './db.js';
import { cleanupOrphanUploads, hardDeleteMessages } from './attachments.js';

export interface PurgeConfig {
  enabled: boolean;
  /** 软删消息保留天数；超过后物理删除 */
  messagesRetentionDays: number;
  /** 已隐藏且终态的 job 保留天数 */
  jobsRetentionDays: number;
  /** 定时检查间隔（小时） */
  intervalHours: number;
  /** 单次最多清理条数（防一次锁太久） */
  batchSize: number;
}

export interface PurgeResult {
  messagesDeleted: number;
  jobsDeleted: number;
  orphanUploadsRemoved: number;
  dryRun: boolean;
}

export interface PurgeStatus {
  enabled: boolean;
  messagesRetentionDays: number;
  jobsRetentionDays: number;
  lastRunAt: string | null;
  lastResult: PurgeResult | null;
  lastError: string | null;
  pendingSoftMessages: number;
  pendingHiddenJobs: number;
}

/** 已隐藏窗口且可安全物理删的终态（不含仍可能在跑的 running/claimed 等） */
const PURGEABLE_JOB_STATUSES = [
  'done',
  'cancelled',
  'failed',
  'expired',
  'interrupted',
  'blocked',
  'paused',
] as const;

/**
 * 软删除过期 purge：用户删消息 / 隐藏 Worker 窗口仍先软删；
 * 到期后物理删行（job_messages 靠 FK CASCADE）。
 */
export class SoftDeletePurge {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunAt: string | null = null;
  private lastResult: PurgeResult | null = null;
  private lastError: string | null = null;

  constructor(
    private db: Db,
    private uploadsDir: string,
    private cfg: PurgeConfig,
    private log: (msg: string) => void
  ) {}

  start(): void {
    if (!this.cfg.enabled) return;
    const intervalMs = Math.max(this.cfg.intervalHours, 1) * 3_600_000;
    const tick = () =>
      void this.runOnce().catch((e: Error) => {
        this.lastError = e.message;
        this.log(`purge FAILED: ${e.message}`);
      });
    // 启动 10 分钟后首跑，之后按 interval
    this.timer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, intervalMs);
      this.timer.unref();
    }, 600_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  status(): PurgeStatus {
    return {
      enabled: this.cfg.enabled,
      messagesRetentionDays: this.cfg.messagesRetentionDays,
      jobsRetentionDays: this.cfg.jobsRetentionDays,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      pendingSoftMessages: this.countPendingMessages(),
      pendingHiddenJobs: this.countPendingJobs(),
    };
  }

  private countPendingMessages(): number {
    const days = Math.max(this.cfg.messagesRetentionDays, 1);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages
         WHERE deleted = 1 AND created_at <= datetime('now', ?)`
      )
      .get(`-${days} days`) as { c: number };
    return row.c;
  }

  private countPendingJobs(): number {
    const days = Math.max(this.cfg.jobsRetentionDays, 1);
    const placeholders = PURGEABLE_JOB_STATUSES.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM jobs
         WHERE deleted = 1 AND status IN (${placeholders})
           AND updated_at <= datetime('now', ?)`
      )
      .get(...PURGEABLE_JOB_STATUSES, `-${days} days`) as { c: number };
    return row.c;
  }

  async runOnce(opts: { dryRun?: boolean } = {}): Promise<PurgeResult> {
    if (this.running) throw new Error('purge already running');
    this.running = true;
    const dryRun = opts.dryRun === true;
    try {
      const result = this.purge(dryRun);
      this.lastRunAt = new Date().toISOString();
      this.lastResult = result;
      this.lastError = null;
      this.log(
        `purge ${dryRun ? 'dry-run' : 'ok'}: messages=${result.messagesDeleted} jobs=${result.jobsDeleted} orphans=${result.orphanUploadsRemoved}`
      );
      return result;
    } catch (e: any) {
      this.lastError = e.message;
      this.lastRunAt = new Date().toISOString();
      throw e;
    } finally {
      this.running = false;
    }
  }

  private purge(dryRun: boolean): PurgeResult {
    const msgDays = Math.max(this.cfg.messagesRetentionDays, 1);
    const jobDays = Math.max(this.cfg.jobsRetentionDays, 1);
    const batch = Math.min(Math.max(this.cfg.batchSize, 50), 5_000);

    const msgIds = (
      this.db
        .prepare(
          `SELECT id FROM messages
           WHERE deleted = 1 AND created_at <= datetime('now', ?)
           ORDER BY id ASC LIMIT ?`
        )
        .all(`-${msgDays} days`, batch) as { id: number }[]
    ).map((r) => r.id);

    const placeholders = PURGEABLE_JOB_STATUSES.map(() => '?').join(',');
    const jobIds = (
      this.db
        .prepare(
          `SELECT id FROM jobs
           WHERE deleted = 1 AND status IN (${placeholders})
             AND updated_at <= datetime('now', ?)
           ORDER BY updated_at ASC LIMIT ?`
        )
        .all(...PURGEABLE_JOB_STATUSES, `-${jobDays} days`, batch) as { id: string }[]
    ).map((r) => r.id);

    let messagesDeleted = 0;
    let jobsDeleted = 0;
    let orphanUploadsRemoved = 0;

    if (!dryRun) {
      if (msgIds.length > 0) {
        messagesDeleted = hardDeleteMessages(this.db, this.uploadsDir, msgIds);
      }
      if (jobIds.length > 0) {
        const delJob = this.db.prepare('DELETE FROM jobs WHERE id = ? AND deleted = 1');
        const tx = this.db.transaction((ids: string[]) => {
          let n = 0;
          for (const id of ids) n += delJob.run(id).changes;
          return n;
        });
        jobsDeleted = tx(jobIds);
      }
      try {
        orphanUploadsRemoved = cleanupOrphanUploads(this.db, this.uploadsDir);
      } catch {
        orphanUploadsRemoved = 0;
      }
    } else {
      messagesDeleted = msgIds.length;
      jobsDeleted = jobIds.length;
    }

    return {
      messagesDeleted,
      jobsDeleted,
      orphanUploadsRemoved,
      dryRun,
    };
  }
}
