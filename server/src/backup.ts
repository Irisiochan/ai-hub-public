import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from './db.js';

export interface BackupConfig {
  enabled: boolean;
  /** 快照目录；应在仓库外（prod 默认 /var/backups/ai-hub/db） */
  dir: string;
  /** 最新快照早于该时长才做新备份 */
  intervalHours: number;
  /** 保留最近 N 份 */
  keep: number;
}

export interface BackupStatus {
  enabled: boolean;
  dir: string;
  lastRunAt: string | null;
  lastResult: 'ok' | 'failed' | null;
  lastError: string | null;
  lastFile: string | null;
  files: { name: string; size: number; mtime: string }[];
}

const FILE_RE = /^hub-\d{8}T\d{6}Z\.db$/;

/**
 * SQLite 在线备份：better-sqlite3 的 backup API，不停服务。
 * 每小时检查一次，最新快照超过 intervalHours 才做新的（重启不churn保留窗口）；
 * 快照先写 .tmp，做 integrity_check 校验通过后才转正，然后按 keep 修剪。
 * 注意：这是本机快照，防的是误删/坏迁移/文件损坏，不防整盘故障。
 */
export class DbBackup {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastRunAt: string | null = null;
  private lastResult: 'ok' | 'failed' | null = null;
  private lastError: string | null = null;
  private lastFile: string | null = null;

  constructor(
    private db: Db,
    private cfg: BackupConfig,
    private log: (msg: string) => void
  ) {}

  start(): void {
    if (!this.cfg.enabled) return;
    try {
      fs.mkdirSync(this.cfg.dir, { recursive: true });
    } catch (e: any) {
      this.log(`backup disabled: cannot create ${this.cfg.dir}: ${e.message}`);
      return;
    }
    const tick = () => void this.maybeRun();
    // 启动 5 分钟后首查，之后每小时查一次
    this.timer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, 3_600_000);
      this.timer.unref();
    }, 300_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      clearInterval(this.timer);
    }
  }

  status(): BackupStatus {
    return {
      enabled: this.cfg.enabled,
      dir: this.cfg.dir,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      lastFile: this.lastFile,
      files: this.listSnapshots().map((f) => ({
        name: f.name,
        size: f.size,
        mtime: f.mtime.toISOString(),
      })),
    };
  }

  private listSnapshots(): { name: string; size: number; mtime: Date }[] {
    try {
      return fs
        .readdirSync(this.cfg.dir)
        .filter((n) => FILE_RE.test(n))
        .map((name) => {
          const st = fs.statSync(path.join(this.cfg.dir, name));
          return { name, size: st.size, mtime: st.mtime };
        })
        .sort((a, b) => b.name.localeCompare(a.name)); // 文件名即时间戳，新在前
    } catch {
      return [];
    }
  }

  private async maybeRun(): Promise<void> {
    const newest = this.listSnapshots()[0];
    if (newest && Date.now() - newest.mtime.getTime() < this.cfg.intervalHours * 3_600_000) return;
    await this.runOnce();
  }

  /** 手动或到点触发一次备份；返回快照文件名或抛错 */
  async runOnce(): Promise<string> {
    if (this.running) throw new Error('backup already running');
    this.running = true;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const name = `hub-${stamp}.db`;
    const finalPath = path.join(this.cfg.dir, name);
    const tmpPath = `${finalPath}.tmp`;
    try {
      fs.mkdirSync(this.cfg.dir, { recursive: true });
      await this.db.backup(tmpPath);
      // 演练内建：快照必须能打开且 integrity_check 通过才算备份成功
      const snap = new Database(tmpPath, { readonly: true });
      try {
        const row = snap.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
        if (row.integrity_check !== 'ok') throw new Error(`integrity_check: ${row.integrity_check}`);
        snap.prepare('SELECT COUNT(*) FROM messages').get();
      } finally {
        snap.close();
      }
      fs.renameSync(tmpPath, finalPath);
      this.prune();
      this.lastRunAt = new Date().toISOString();
      this.lastResult = 'ok';
      this.lastError = null;
      this.lastFile = name;
      this.log(`backup ok: ${name}`);
      return name;
    } catch (e: any) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {}
      this.lastRunAt = new Date().toISOString();
      this.lastResult = 'failed';
      this.lastError = e.message;
      this.log(`backup FAILED: ${e.message}`);
      throw e;
    } finally {
      this.running = false;
    }
  }

  private prune(): void {
    const files = this.listSnapshots();
    for (const f of files.slice(Math.max(1, this.cfg.keep))) {
      try {
        fs.rmSync(path.join(this.cfg.dir, f.name), { force: true });
      } catch {}
    }
    // 清理历史遗留的 .tmp（崩溃残留）
    try {
      for (const n of fs.readdirSync(this.cfg.dir)) {
        if (n.endsWith('.tmp')) fs.rmSync(path.join(this.cfg.dir, n), { force: true });
      }
    } catch {}
  }
}
