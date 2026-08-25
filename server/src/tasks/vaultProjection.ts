import type { Db } from '../db.js';
import {
  MEMORY_OUTBOX_MAX_ATTEMPTS,
  memoryOutboxRetryDelayMs,
} from '../memory/vaultClient.js';

export const TASK_OUTBOX_FLUSH_INTERVAL_MS = 5_000;

export interface VaultProjectionClient {
  call(name: string, args?: Record<string, unknown>, retries?: number): Promise<string>;
}

interface TaskOutboxRow {
  id: number;
  payload: string;
  attempts: number;
}

interface VaultTaskPayload {
  path: string;
  nextStatus: 'open' | 'done';
  note: string;
  source: string;
}

function projectionPayload(raw: string): VaultTaskPayload {
  const value = JSON.parse(raw) as Partial<VaultTaskPayload>;
  if (
    typeof value.path !== 'string'
    || !/^tasks\/[a-z0-9][a-z0-9-]*\.md$/.test(value.path)
    || (value.nextStatus !== 'open' && value.nextStatus !== 'done')
    || typeof value.note !== 'string'
    || !value.note.trim()
    || typeof value.source !== 'string'
    || !value.source.trim()
  ) {
    throw new Error('invalid vault-task projection payload');
  }
  return {
    path: value.path,
    nextStatus: value.nextStatus,
    note: value.note,
    source: value.source,
  };
}

export function isIdempotentVaultProjectionError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /文件不存在|not found|ENOENT|already[ _-]?done|already archived|已(?:完成|归档)/i.test(detail);
}

/** Durable at-least-once projection from task_outbox to Vault Markdown. */
export class VaultTaskProjection {
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(
    private readonly db: Db,
    private readonly vault: VaultProjectionClient,
    private readonly log: (message: string) => void,
  ) {}

  start(intervalMs = TASK_OUTBOX_FLUSH_INTERVAL_MS): void {
    if (this.timer) return;
    void this.flushOutbox().catch((error) => {
      this.log(`task outbox startup flush failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.timer = setInterval(() => {
      void this.flushOutbox().catch((error) => {
        this.log(`task outbox flush failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async flushOutbox(): Promise<number> {
    if (this.flushing) return 0;
    this.flushing = true;
    let completed = 0;
    try {
      const now = Date.now();
      const rows = this.db.prepare(
        `SELECT id, payload, attempts FROM task_outbox
         WHERE projection = 'vault-task' AND status = 'pending' AND next_attempt_at <= ?
         ORDER BY id LIMIT 20`
      ).all(now) as TaskOutboxRow[];
      for (const row of rows) {
        try {
          const payload = projectionPayload(row.payload);
          await this.vault.call('update_task', {
            path: payload.path,
            status: payload.nextStatus,
            note: payload.note,
            source: payload.source,
          }, 0);
          this.markDone(row.id);
          completed += 1;
          this.log(`task outbox projected: update_task #${row.id}`);
        } catch (error) {
          if (isIdempotentVaultProjectionError(error)) {
            this.markDone(row.id);
            completed += 1;
            this.log(`task outbox idempotently settled: update_task #${row.id}`);
            continue;
          }
          const detail = String(error instanceof Error ? error.message : error).slice(0, 200);
          const attempts = row.attempts + 1;
          if (attempts >= MEMORY_OUTBOX_MAX_ATTEMPTS) {
            this.db.prepare(
              `UPDATE task_outbox SET status = 'dead', attempts = ?, last_error = ?,
                 next_attempt_at = 0, updated_at = datetime('now') WHERE id = ?`
            ).run(attempts, detail, row.id);
            this.log(`task outbox dead-lettered: update_task #${row.id} after ${attempts} attempts: ${detail}`);
            continue;
          }
          const delayMs = memoryOutboxRetryDelayMs(attempts);
          this.db.prepare(
            `UPDATE task_outbox SET attempts = ?, last_error = ?, next_attempt_at = ?,
               updated_at = datetime('now') WHERE id = ?`
          ).run(attempts, detail, now + delayMs, row.id);
          this.log(`task outbox retry scheduled: update_task #${row.id} attempt ${attempts} in ${delayMs}ms: ${detail}`);
        }
      }
      return completed;
    } finally {
      this.flushing = false;
    }
  }

  private markDone(id: number): void {
    this.db.prepare(
      `UPDATE task_outbox SET status = 'done', last_error = NULL,
         next_attempt_at = 0, updated_at = datetime('now') WHERE id = ?`
    ).run(id);
  }
}
