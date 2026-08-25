import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Db } from '../db.js';
import {
  LIVE_JOB_STATUSES,
  taskPathFromOptions,
} from '../tasks/invariants.js';
import {
  TaskStateService,
  type TaskTransitionResult,
} from '../tasks/taskStateService.js';

const TASK_PATH = /^tasks\/[a-z0-9][a-z0-9-]*\.md$/;
const TAIL_PATH = /^tasks\/(?:worker-tail-|deploy-)/;

interface VaultTasksDependencies {
  db: Db;
  tasksDir: string | null;
}

interface JobPathRow {
  id: string;
  status: string;
  options: string;
}

type CloseOutcome =
  | { kind: 'already-done' }
  | { kind: 'transition'; transition: TaskTransitionResult };

function liveJobForTask(db: Db, taskPath: string): JobPathRow | null {
  const rows = db.prepare(
    'SELECT id, status, options FROM jobs WHERE deleted = 0 ORDER BY created_at, id'
  ).all() as JobPathRow[];
  return rows.find((job) => (
    LIVE_JOB_STATUSES.has(job.status)
    && taskPathFromOptions(job.options) === taskPath
  )) ?? null;
}

export function vaultTasksRouter({ db, tasksDir }: VaultTasksDependencies): Router {
  const r = Router();
  const activeWrites = new Set<string>();
  const taskState = new TaskStateService(db);

  r.post('/task-status', async (req, res) => {
    if (!tasksDir) {
      return res.status(503).json({ error: 'MEMORY_VAULT_REPO is not configured; canonical tasks are unavailable' });
    }
    const taskPath = typeof req.body?.path === 'string' ? req.body.path.trim().toLowerCase() : '';
    const status = req.body?.status;
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 4000) : '';
    if (!TASK_PATH.test(taskPath) || status !== 'done' || !note) {
      return res.status(400).json({ error: 'path, status=done and note are required' });
    }
    if (TAIL_PATH.test(taskPath)) {
      return res.status(409).json({ error: '尾巴任务不能从回执快捷按钮关闭，请在任务账本单独处理' });
    }
    if (activeWrites.has(taskPath)) {
      return res.status(409).json({ error: '这个任务正在更新，请勿重复点击' });
    }
    const liveJob = liveJobForTask(db, taskPath);
    if (liveJob) {
      return res.status(409).json({
        error: `任务仍有关联的 ${liveJob.status} job ${liveJob.id}，请先处理该 job`,
      });
    }

    activeWrites.add(taskPath);
    try {
      let outcome: CloseOutcome;
      try {
        // Keep an async boundary so a concurrent double-click can observe the
        // in-process guard before the atomic, synchronous SQLite transaction.
        await fs.promises.access(path.join(tasksDir, taskPath.slice('tasks/'.length)));
        outcome = db.transaction((): CloseOutcome => {
          const current = taskState.refreshTask(tasksDir, taskPath);
          if (current.status !== 'open') {
            return { kind: 'already-done' };
          }
          const transition = taskState.transition({
            commandId: crypto.randomUUID(),
            idempotencyKey: `vault-task-status:${current.taskId}:${current.version}:done`,
            taskId: current.taskId,
            expectedVersion: current.version,
            toStatus: 'done',
            actor: 'User',
            source: 'vault-task-status-route',
            reason: note,
            evidence: { note, taskPath },
            projection: { path: taskPath, note, source: 'User' },
          });
          return { kind: 'transition', transition };
        })();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/ENOENT|文件不存在|not found/i.test(detail)) {
          return res.json({ ok: true, path: taskPath, status: 'done', alreadyDone: true });
        }
        return res.status(404).json({ error: `任务读取失败：${detail}` });
      }

      if (outcome.kind === 'already-done') {
        return res.json({ ok: true, path: taskPath, status: 'done', alreadyDone: true });
      }
      const { transition } = outcome;
      if (!transition || transition.result !== 'applied') {
        const detail = transition?.error ?? 'task transition did not complete';
        return res.status(/version_conflict/.test(detail) ? 409 : 500).json({
          error: `任务状态更新失败：${detail}`,
        });
      }
      return res.json({ ok: true, path: taskPath, status: 'done', queued: true });
    } finally {
      activeWrites.delete(taskPath);
    }
  });

  return r;
}
