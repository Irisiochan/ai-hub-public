import type { Db } from '../db.js';
import { readTaskSnapshots, type TaskSnapshot } from './taskStateService.js';

export const INVARIANT_CODES = [
  'I1_TERMINAL_TASK_LIVE_JOB',
  'I2_WRITEBACK_OUTBOX_DIVERGENCE',
  'I3_GHOST_WORKER_TAIL',
  'I4_LIVE_JOB_MISSING_TASK',
] as const;

export type InvariantCode = typeof INVARIANT_CODES[number];

export interface InvariantViolation {
  code: InvariantCode;
  detail: string;
  taskPath?: string;
  jobId?: string;
  writebackId?: number;
  outboxId?: number;
}

export interface InvariantReport {
  schemaVersion: 1;
  scanned: {
    tasks: number;
    jobs: number;
    taskWritebacks: number;
    memoryOutbox: number;
  };
  summary: {
    total: number;
    byCode: Record<InvariantCode, number>;
  };
  violations: InvariantViolation[];
}

interface JobView {
  id: string;
  status: string;
  options: string;
}

interface WritebackView {
  id: number;
  idempotency_key: string;
  task_path: string | null;
  status: string;
  event_id: string | null;
}

interface MemoryOutboxView {
  id: number;
  tool: string;
  args: string;
  status: string;
}

interface TaskOutboxView {
  id: number;
  event_id: string;
  status: string;
}

export const LIVE_JOB_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'claimed',
  'running',
  'recovering',
  'pause_requested',
  'cancel_requested',
  'blocked',
]);
const TERMINAL_JOB_STATUSES = new Set(['done', 'failed', 'interrupted', 'cancelled', 'paused']);

function tableExists(db: Db, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function normalizeTaskPath(raw: string): string {
  return raw.trim().replaceAll('\\', '/').toLowerCase();
}

export function taskPathFromOptions(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as { taskPath?: unknown };
    return typeof value.taskPath === 'string' && value.taskPath.trim()
      ? normalizeTaskPath(value.taskPath)
      : null;
  } catch {
    return null;
  }
}

function matchingOutbox(writeback: WritebackView, rows: MemoryOutboxView[]): MemoryOutboxView[] {
  return rows.filter((row) => {
    if (row.tool !== 'update_task') return false;
    try {
      const args = JSON.parse(row.args) as { path?: unknown; note?: unknown };
      if (writeback.task_path && normalizeTaskPath(String(args.path ?? '')) !== normalizeTaskPath(writeback.task_path)) {
        return false;
      }
      return String(args.note ?? '').includes(writeback.idempotency_key)
        || row.args.includes(writeback.idempotency_key);
    } catch {
      return row.args.includes(writeback.idempotency_key);
    }
  });
}

function violationKey(violation: InvariantViolation): string {
  return [
    violation.code,
    violation.taskPath ?? '',
    violation.jobId ?? '',
    String(violation.writebackId ?? ''),
    String(violation.outboxId ?? ''),
    violation.detail,
  ].join('|');
}

function taskMap(snapshots: TaskSnapshot[]): Map<string, TaskSnapshot> {
  return new Map(snapshots.map((snapshot) => [normalizeTaskPath(snapshot.sourcePath), snapshot]));
}

export function collectInvariantReport(db: Db, tasksDir: string): InvariantReport {
  const snapshots = readTaskSnapshots(tasksDir);
  const tasks = taskMap(snapshots);
  const jobs = tableExists(db, 'jobs')
    ? db.prepare('SELECT id, status, options FROM jobs WHERE deleted = 0 ORDER BY id').all() as JobView[]
    : [];
  const writebacks = tableExists(db, 'task_writebacks')
    ? db.prepare('SELECT id, idempotency_key, task_path, status, event_id FROM task_writebacks ORDER BY id').all() as WritebackView[]
    : [];
  const taskOutbox = tableExists(db, 'task_outbox')
    ? db.prepare('SELECT id, event_id, status FROM task_outbox ORDER BY id').all() as TaskOutboxView[]
    : [];
  const memoryOutbox = tableExists(db, 'memory_outbox')
    ? db.prepare('SELECT id, tool, args, status FROM memory_outbox ORDER BY id').all() as MemoryOutboxView[]
    : [];
  const violations: InvariantViolation[] = [];

  for (const job of jobs) {
    const taskPath = taskPathFromOptions(job.options);
    if (!taskPath || !LIVE_JOB_STATUSES.has(job.status)) continue;
    const task = tasks.get(taskPath);
    if (!task) {
      violations.push({
        code: 'I4_LIVE_JOB_MISSING_TASK',
        detail: `live job ${job.status} references a task file absent from the active task directory`,
        taskPath,
        jobId: job.id,
      });
      continue;
    }
    if (task.status === 'done' || task.status === 'dropped') {
      violations.push({
        code: 'I1_TERMINAL_TASK_LIVE_JOB',
        detail: `task is ${task.status} while linked job is ${job.status}`,
        taskPath,
        jobId: job.id,
      });
    }
  }

  for (const writeback of writebacks) {
    if (writeback.event_id) {
      const matches = taskOutbox.filter((row) => row.event_id === writeback.event_id);
      const dead = matches.find((row) => row.status === 'dead');
      let detail: string | null = null;
      let outbox: TaskOutboxView | undefined;
      if (writeback.status === 'applied' && dead) {
        detail = 'task writeback is applied while its linked task outbox row is dead';
        outbox = dead;
      } else if (writeback.status === 'applied' && matches.length === 0) {
        detail = 'task writeback is applied but no linked task outbox row exists';
      } else if (writeback.status !== 'applied' && matches.length > 0) {
        detail = `task writeback is ${writeback.status} while a linked task outbox row exists`;
        outbox = matches[0];
      }
      if (detail) {
        violations.push({
          code: 'I2_WRITEBACK_OUTBOX_DIVERGENCE',
          detail,
          taskPath: writeback.task_path ? normalizeTaskPath(writeback.task_path) : undefined,
          writebackId: writeback.id,
          outboxId: outbox?.id,
        });
      }
      continue;
    }

    const matches = matchingOutbox(writeback, memoryOutbox);
    const dead = matches.find((row) => row.status === 'dead');
    const pending = matches.find((row) => row.status === 'pending');
    let detail: string | null = null;
    let outbox: MemoryOutboxView | undefined;
    if (writeback.status === 'queued' && dead) {
      detail = 'task writeback remains queued while its memory outbox row is dead';
      outbox = dead;
    } else if (writeback.status === 'queued' && matches.length === 0) {
      detail = 'task writeback remains queued but no matching memory outbox row exists';
    } else if (writeback.status === 'applied' && (pending || dead)) {
      detail = `task writeback is applied while its memory outbox row is ${pending ? 'pending' : 'dead'}`;
      outbox = pending ?? dead;
    } else if (writeback.status === 'failed' && pending) {
      detail = 'task writeback is failed while its memory outbox row is still pending';
      outbox = pending;
    }
    if (detail) {
      violations.push({
        code: 'I2_WRITEBACK_OUTBOX_DIVERGENCE',
        detail,
        taskPath: writeback.task_path ? normalizeTaskPath(writeback.task_path) : undefined,
        writebackId: writeback.id,
        outboxId: outbox?.id,
      });
    }
  }

  const jobsById = new Map(jobs.map((job) => [job.id.toLowerCase(), job]));
  for (const snapshot of snapshots) {
    if (snapshot.status !== 'open') continue;
    const match = /^worker-tail-([a-z0-9-]+)$/i.exec(snapshot.taskId);
    if (!match) continue;
    const job = jobsById.get(match[1].toLowerCase());
    if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) continue;
    violations.push({
      code: 'I3_GHOST_WORKER_TAIL',
      detail: `worker tail remains open while its job is ${job.status}`,
      taskPath: normalizeTaskPath(snapshot.sourcePath),
      jobId: job.id,
    });
  }

  violations.sort((a, b) => violationKey(a).localeCompare(violationKey(b)));
  const byCode = Object.fromEntries(INVARIANT_CODES.map((code) => [code, 0])) as Record<InvariantCode, number>;
  for (const violation of violations) byCode[violation.code] += 1;
  return {
    schemaVersion: 1,
    scanned: {
      tasks: snapshots.length,
      jobs: jobs.length,
      taskWritebacks: writebacks.length,
      memoryOutbox: memoryOutbox.length,
    },
    summary: { total: violations.length, byCode },
    violations,
  };
}

export function renderInvariantJson(report: InvariantReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderInvariantMarkdown(report: InvariantReport): string {
  const lines = [
    '# Task Controller shadow invariant report',
    '',
    `Scanned ${report.scanned.tasks} tasks, ${report.scanned.jobs} jobs, ${report.scanned.taskWritebacks} task writebacks, and ${report.scanned.memoryOutbox} memory outbox rows.`,
    '',
    `Total violations: ${report.summary.total}`,
    '',
    '| Invariant | Count |',
    '| --- | ---: |',
    ...INVARIANT_CODES.map((code) => `| ${code} | ${report.summary.byCode[code]} |`),
    '',
    '## Violations',
    '',
  ];
  if (report.violations.length === 0) {
    lines.push('None.');
  } else {
    for (const violation of report.violations) {
      const refs = [
        violation.taskPath ? `task=${violation.taskPath}` : '',
        violation.jobId ? `job=${violation.jobId}` : '',
        violation.writebackId !== undefined ? `writeback=${violation.writebackId}` : '',
        violation.outboxId !== undefined ? `outbox=${violation.outboxId}` : '',
      ].filter(Boolean).join(', ');
      lines.push(`- **${violation.code}**${refs ? ` (${refs})` : ''}: ${violation.detail}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
