import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db.js';

export const TASK_STATUSES = ['proposed', 'open', 'blocked', 'done', 'dropped'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];
export type TaskMode = 'ask' | 'auto';

export interface TaskSnapshot {
  taskId: string;
  sourcePath: string;
  status: TaskStatus;
  due: string | null;
  mode: TaskMode;
  parentId: string | null;
  sourceRef: string | null;
  specFingerprint: string;
  contentFingerprint: string;
}

export interface ImportSnapshotResult {
  inserted: number;
  updated: number;
  unchanged: number;
  events: number;
}

export interface TaskTransitionCommand {
  commandId: string;
  idempotencyKey: string;
  taskId: string;
  expectedVersion: number;
  toStatus: TaskStatus;
  actor: string;
  source: string;
  reason: string;
  evidence?: Record<string, unknown>;
  projection?: {
    path: string;
    note: string;
    source: string;
  };
}

export interface TaskTransitionResult {
  commandId: string;
  taskId: string;
  result: 'applied' | 'rejected';
  version?: number;
  eventId?: string;
  error?: string;
  replayed: boolean;
}

export interface TaskUpdateCommand {
  commandId: string;
  idempotencyKey: string;
  taskId: string;
  expectedVersion: number;
  actor: string;
  source: string;
  reason: string;
  evidence?: Record<string, unknown>;
  projection: {
    path: string;
    note: string;
    source: string;
  };
}

export interface RefreshedTask {
  taskId: string;
  sourcePath: string;
  status: TaskStatus;
  version: number;
  changed: boolean;
  contentFingerprint: string;
}

interface WorkItemRow {
  task_id: string;
  source_path: string;
  status: TaskStatus;
  version: number;
  spec_fingerprint: string;
  content_fingerprint: string;
  due: string | null;
  mode: TaskMode;
  parent_id: string | null;
  source_ref: string | null;
}

interface CommandRow {
  command_id: string;
  task_id: string;
  result: 'processing' | 'applied' | 'rejected';
  result_version: number | null;
  event_id: string | null;
  error: string | null;
}

const STATUS_SET = new Set<string>(TASK_STATUSES);
const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  proposed: new Set(['open', 'dropped']),
  open: new Set(['blocked', 'done', 'dropped']),
  blocked: new Set(['open', 'done', 'dropped']),
  done: new Set(),
  dropped: new Set(),
};

function normalizeText(raw: string): string {
  return raw.replaceAll('\r\n', '\n');
}

function digest(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function scalar(frontmatter: string, key: string): string | null {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'im'));
  if (!match) return null;
  const value = unquote(match[1]);
  return value && !['null', 'none', '~'].includes(value.toLowerCase()) ? value : null;
}

export function parseTaskFile(filePath: string, tasksDir: string): TaskSnapshot {
  const raw = normalizeText(fs.readFileSync(filePath, 'utf8'));
  const match = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`task file is missing frontmatter: ${filePath}`);
  const frontmatter = match[1];
  const body = match[2];
  const fileName = path.basename(filePath);
  const taskId = fileName.replace(/\.md$/i, '');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(taskId)) {
    throw new Error(`invalid task slug: ${fileName}`);
  }
  const statusRaw = (scalar(frontmatter, 'status') ?? '').toLowerCase();
  if (!STATUS_SET.has(statusRaw)) throw new Error(`invalid task status in ${fileName}: ${statusRaw || '(missing)'}`);
  const modeRaw = (scalar(frontmatter, 'mode') ?? 'ask').toLowerCase();
  if (modeRaw !== 'ask' && modeRaw !== 'auto') throw new Error(`invalid task mode in ${fileName}: ${modeRaw}`);
  const parentRaw = scalar(frontmatter, 'parent');
  const sourcePath = `tasks/${path.relative(tasksDir, filePath).replaceAll('\\', '/')}`;
  return {
    taskId,
    sourcePath,
    status: statusRaw as TaskStatus,
    due: scalar(frontmatter, 'due'),
    mode: modeRaw,
    parentId: parentRaw?.replace(/^tasks\//i, '').replace(/\.md$/i, '') ?? null,
    sourceRef: scalar(frontmatter, 'source_ref') ?? scalar(frontmatter, 'source'),
    specFingerprint: digest(normalizeText(body).trim()),
    contentFingerprint: digest(raw),
  };
}

export function readTaskSnapshots(tasksDir: string): TaskSnapshot[] {
  const root = path.resolve(tasksDir);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => parseTaskFile(path.join(root, entry.name), root))
    .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

function stablePayload(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function commandResult(row: CommandRow, replayed: boolean): TaskTransitionResult {
  return {
    commandId: row.command_id,
    taskId: row.task_id,
    result: row.result === 'applied' ? 'applied' : 'rejected',
    version: row.result_version ?? undefined,
    eventId: row.event_id ?? undefined,
    error: row.error ?? undefined,
    replayed,
  };
}

export class TaskStateService {
  constructor(private readonly db: Db) {}

  /**
   * Refresh one task from the canonical Vault checkout without emitting a
   * shadow-import event. The caller can wrap this and transition() in one
   * outer transaction so the authoritative refresh and command are atomic.
   */
  refreshTask(tasksDir: string, taskPath: string): RefreshedTask {
    const normalizedPath = taskPath.trim().replaceAll('\\', '/').toLowerCase();
    if (!/^tasks\/[a-z0-9][a-z0-9-]*\.md$/.test(normalizedPath)) {
      throw new Error(`invalid task path: ${taskPath}`);
    }
    const root = path.resolve(tasksDir);
    const snapshot = parseTaskFile(path.join(root, normalizedPath.slice('tasks/'.length)), root);
    if (snapshot.sourcePath.toLowerCase() !== normalizedPath) {
      throw new Error(`task path mismatch: ${taskPath}`);
    }

    const current = this.db.prepare('SELECT * FROM work_items WHERE task_id = ?')
      .get(snapshot.taskId) as WorkItemRow | undefined;
    if (current?.content_fingerprint === snapshot.contentFingerprint) {
      return {
        taskId: current.task_id,
        sourcePath: current.source_path,
        status: current.status,
        version: current.version,
        changed: false,
        contentFingerprint: current.content_fingerprint,
      };
    }

    const nextVersion = current ? current.version + 1 : 1;
    if (current) {
      this.db.prepare(
        `UPDATE work_items SET source_path = ?, status = ?, version = ?, spec_fingerprint = ?,
           content_fingerprint = ?, mode = ?, parent_id = ?, source_ref = ?,
           updated_at = datetime('now') WHERE task_id = ?`
      ).run(
        snapshot.sourcePath, snapshot.status, nextVersion, snapshot.specFingerprint,
        snapshot.contentFingerprint, snapshot.mode, snapshot.parentId,
        snapshot.sourceRef, snapshot.taskId
      );
    } else {
      this.db.prepare(
        `INSERT INTO work_items (
           task_id, source_path, status, version, spec_fingerprint, content_fingerprint,
           due, mode, parent_id, source_ref
         ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
      ).run(
        snapshot.taskId, snapshot.sourcePath, snapshot.status, snapshot.specFingerprint,
        snapshot.contentFingerprint, snapshot.due, snapshot.mode, snapshot.parentId,
        snapshot.sourceRef
      );
    }
    return {
      taskId: snapshot.taskId,
      sourcePath: snapshot.sourcePath,
      status: snapshot.status,
      version: nextVersion,
      changed: true,
      contentFingerprint: snapshot.contentFingerprint,
    };
  }

  importSnapshot(tasksDir: string): ImportSnapshotResult {
    const snapshots = readTaskSnapshots(tasksDir);
    const apply = this.db.transaction((): ImportSnapshotResult => {
      const result: ImportSnapshotResult = { inserted: 0, updated: 0, unchanged: 0, events: 0 };
      const get = this.db.prepare('SELECT * FROM work_items WHERE task_id = ?');
      const insert = this.db.prepare(
        `INSERT INTO work_items (
           task_id, source_path, status, version, spec_fingerprint, content_fingerprint,
           due, mode, parent_id, source_ref
         ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`
      );
      const update = this.db.prepare(
        `UPDATE work_items SET source_path = ?, status = ?, version = ?, spec_fingerprint = ?,
           content_fingerprint = ?, due = ?, mode = ?, parent_id = ?, source_ref = ?,
           updated_at = datetime('now') WHERE task_id = ?`
      );
      const addEvent = this.db.prepare(
        `INSERT INTO task_events (
           event_id, task_id, task_version, kind, previous_status, next_status, actor, source, payload
         ) VALUES (?, ?, ?, 'snapshot_imported', ?, ?, 'shadow-import', 'vault-snapshot', ?)`
      );

      for (const snapshot of snapshots) {
        const current = get.get(snapshot.taskId) as WorkItemRow | undefined;
        if (current?.content_fingerprint === snapshot.contentFingerprint) {
          result.unchanged += 1;
          continue;
        }
        const nextVersion = current ? current.version + 1 : 1;
        if (current) {
          update.run(
            snapshot.sourcePath, snapshot.status, nextVersion, snapshot.specFingerprint,
            snapshot.contentFingerprint, snapshot.due, snapshot.mode, snapshot.parentId,
            snapshot.sourceRef, snapshot.taskId
          );
          result.updated += 1;
        } else {
          insert.run(
            snapshot.taskId, snapshot.sourcePath, snapshot.status, snapshot.specFingerprint,
            snapshot.contentFingerprint, snapshot.due, snapshot.mode, snapshot.parentId,
            snapshot.sourceRef
          );
          result.inserted += 1;
        }
        const eventId = `snapshot:${snapshot.taskId}:${nextVersion}:${snapshot.contentFingerprint}`;
        addEvent.run(
          eventId,
          snapshot.taskId,
          nextVersion,
          current?.status ?? null,
          snapshot.status,
          stablePayload({
            contentFingerprint: snapshot.contentFingerprint,
            sourcePath: snapshot.sourcePath,
            specFingerprint: snapshot.specFingerprint,
          })
        );
        result.events += 1;
      }
      return result;
    });
    return apply();
  }

  transition(command: TaskTransitionCommand): TaskTransitionResult {
    const execute = this.db.transaction((): TaskTransitionResult => {
      const existing = this.db.prepare(
        'SELECT * FROM task_commands WHERE command_id = ? OR idempotency_key = ?'
      ).get(command.commandId, command.idempotencyKey) as CommandRow | undefined;
      if (existing) return commandResult(existing, true);

      this.db.prepare(
        `INSERT INTO task_commands (
           command_id, idempotency_key, task_id, expected_version, requested_status,
           actor, source, reason, evidence, result
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing')`
      ).run(
        command.commandId,
        command.idempotencyKey,
        command.taskId,
        command.expectedVersion,
        command.toStatus,
        command.actor,
        command.source,
        command.reason,
        stablePayload(command.evidence ?? {})
      );

      const reject = (error: string): TaskTransitionResult => {
        this.db.prepare(
          `UPDATE task_commands SET result = 'rejected', error = ?, completed_at = datetime('now')
           WHERE command_id = ?`
        ).run(error, command.commandId);
        return { commandId: command.commandId, taskId: command.taskId, result: 'rejected', error, replayed: false };
      };

      const current = this.db.prepare('SELECT * FROM work_items WHERE task_id = ?')
        .get(command.taskId) as WorkItemRow | undefined;
      if (!current) return reject('task_not_found');
      if (current.version !== command.expectedVersion) {
        return reject(`version_conflict:expected=${command.expectedVersion}:actual=${current.version}`);
      }
      if (!VALID_TRANSITIONS[current.status].has(command.toStatus)) {
        return reject(`invalid_transition:${current.status}->${command.toStatus}`);
      }

      const nextVersion = current.version + 1;
      const eventId = `command:${command.commandId}`;
      const changed = this.db.prepare(
        `UPDATE work_items SET status = ?, version = ?, updated_at = datetime('now')
         WHERE task_id = ? AND version = ?`
      ).run(command.toStatus, nextVersion, command.taskId, command.expectedVersion);
      if (changed.changes !== 1) return reject('version_conflict:during_update');

      const eventPayload = stablePayload({
        commandId: command.commandId,
        evidence: command.evidence ?? {},
        reason: command.reason,
      });
      this.db.prepare(
        `INSERT INTO task_events (
           event_id, task_id, task_version, kind, previous_status, next_status, actor, source, payload
         ) VALUES (?, ?, ?, 'status_transitioned', ?, ?, ?, ?, ?)`
      ).run(
        eventId, command.taskId, nextVersion, current.status, command.toStatus,
        command.actor, command.source, eventPayload
      );
      this.db.prepare(
        `INSERT INTO task_outbox (event_id, task_id, projection, payload)
         VALUES (?, ?, 'vault-task', ?)`
      ).run(eventId, command.taskId, stablePayload({
        eventId,
        expectedSourceVersion: command.expectedVersion,
        nextStatus: command.toStatus,
        ...(command.projection ?? {}),
        taskId: command.taskId,
        taskVersion: nextVersion,
      }));
      this.db.prepare(
        `UPDATE task_commands SET result = 'applied', result_version = ?, event_id = ?,
           completed_at = datetime('now') WHERE command_id = ?`
      ).run(nextVersion, eventId, command.commandId);
      return {
        commandId: command.commandId,
        taskId: command.taskId,
        result: 'applied',
        version: nextVersion,
        eventId,
        replayed: false,
      };
    });
    return execute();
  }

  annotate(command: TaskUpdateCommand): TaskTransitionResult {
    return this.applyUpdate('annotate', command, null);
  }

  reschedule(command: TaskUpdateCommand, due: string): TaskTransitionResult {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      throw new Error(`invalid reschedule due: ${due}`);
    }
    return this.applyUpdate('reschedule', command, due);
  }

  private applyUpdate(
    kind: 'annotate' | 'reschedule',
    command: TaskUpdateCommand,
    due: string | null,
  ): TaskTransitionResult {
    const execute = this.db.transaction((): TaskTransitionResult => {
      const existing = this.db.prepare(
        'SELECT * FROM task_commands WHERE command_id = ? OR idempotency_key = ?'
      ).get(command.commandId, command.idempotencyKey) as CommandRow | undefined;
      if (existing) return commandResult(existing, true);

      this.db.prepare(
        `INSERT INTO task_commands (
           command_id, idempotency_key, task_id, expected_version, requested_status,
           actor, source, reason, evidence, result
         ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, 'processing')`
      ).run(
        command.commandId,
        command.idempotencyKey,
        command.taskId,
        command.expectedVersion,
        command.actor,
        command.source,
        command.reason,
        stablePayload(command.evidence ?? {})
      );

      const reject = (error: string): TaskTransitionResult => {
        this.db.prepare(
          `UPDATE task_commands SET result = 'rejected', error = ?, completed_at = datetime('now')
           WHERE command_id = ?`
        ).run(error, command.commandId);
        return { commandId: command.commandId, taskId: command.taskId, result: 'rejected', error, replayed: false };
      };

      const current = this.db.prepare('SELECT * FROM work_items WHERE task_id = ?')
        .get(command.taskId) as WorkItemRow | undefined;
      if (!current) return reject('task_not_found');
      if (current.version !== command.expectedVersion) {
        return reject(`version_conflict:expected=${command.expectedVersion}:actual=${current.version}`);
      }
      if (current.status !== 'open') return reject(`invalid_update_status:${current.status}`);

      const nextVersion = current.version + 1;
      const eventId = `command:${command.commandId}`;
      const changed = kind === 'reschedule'
        ? this.db.prepare(
            `UPDATE work_items SET due = ?, version = ?, updated_at = datetime('now')
             WHERE task_id = ? AND version = ? AND status = 'open'`
          ).run(due, nextVersion, command.taskId, command.expectedVersion)
        : this.db.prepare(
            `UPDATE work_items SET version = ?, updated_at = datetime('now')
             WHERE task_id = ? AND version = ? AND status = 'open'`
          ).run(nextVersion, command.taskId, command.expectedVersion);
      if (changed.changes !== 1) return reject('version_conflict:during_update');

      const eventPayload = stablePayload({
        commandId: command.commandId,
        evidence: command.evidence ?? {},
        ...(kind === 'reschedule' ? { nextDue: due, previousDue: current.due } : {}),
        reason: command.reason,
      });
      this.db.prepare(
        `INSERT INTO task_events (
           event_id, task_id, task_version, kind, previous_status, next_status, actor, source, payload
         ) VALUES (?, ?, ?, ?, 'open', 'open', ?, ?, ?)`
      ).run(
        eventId,
        command.taskId,
        nextVersion,
        kind === 'reschedule' ? 'task_rescheduled' : 'task_annotated',
        command.actor,
        command.source,
        eventPayload
      );
      this.db.prepare(
        `INSERT INTO task_outbox (event_id, task_id, projection, payload)
         VALUES (?, ?, 'vault-task', ?)`
      ).run(eventId, command.taskId, stablePayload({
        eventId,
        expectedSourceVersion: command.expectedVersion,
        nextStatus: 'open',
        ...(kind === 'reschedule' ? { due } : {}),
        ...command.projection,
        taskId: command.taskId,
        taskVersion: nextVersion,
      }));
      this.db.prepare(
        `UPDATE task_commands SET result = 'applied', result_version = ?, event_id = ?,
           completed_at = datetime('now') WHERE command_id = ?`
      ).run(nextVersion, eventId, command.commandId);
      return {
        commandId: command.commandId,
        taskId: command.taskId,
        result: 'applied',
        version: nextVersion,
        eventId,
        replayed: false,
      };
    });
    return execute();
  }
}
