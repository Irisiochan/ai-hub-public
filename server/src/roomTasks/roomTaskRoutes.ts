import { Router } from 'express';
import { z } from 'zod';
import type { Db, SseHub } from '../platform/index.js';
import { type JobStore, resolveProjectTarget, publicJob } from '../jobs/index.js';
import { RoomTaskStore, type RoomTaskDispatcher, type RoomTaskStoreOptions } from './roomTaskStore.js';
import { parseNeedsPc } from './baselineDefaults.js';

const createBody = z.object({
  task_path: z.string().trim().regex(/^tasks\/[a-z0-9][a-z0-9-]*\.md$/i),
  title: z.string().trim().min(1).max(300).optional(),
  requirements: z.string().trim().min(1).max(20_000).optional(),
  // W3: workspace 可缺省——repo_id 有映射时服务端默认选 VPS 围栏工作区。
  workspace: z.string().trim().max(1000).optional(),
  // W3: 映射仓库（server/config.json projectTargets 键）；缺省工作区时必填其一。
  repo_id: z.string().trim().min(1).max(100).optional(),
  // Required by the store for VPS-fenced workspaces (first attempt must be
  // provisioned at a known trunk commit); W3: 未填时按部署回执 → ls-remote
  // 缺省，两者都取不到才报错；来源见回执 baseline_source。
  baseline_sha: z.string().trim().regex(/^[0-9a-f]{40}$/i).optional(),
  // W3: PC-only 能力声明；声明任一即走 PC 工作区，不再默认 VPS。
  needs_camera: z.boolean().optional(),
  needs_taobao: z.boolean().optional(),
  needs_ssh: z.boolean().optional(),
  needs_win32: z.boolean().optional(),
  dispatch: z.object({
    to_module: z.enum(['plan', 'execute']), request: z.string().trim().min(1).max(20_000),
    auto_start: z.boolean().optional(), return_to_module: z.string().min(1).optional(),
  }).strict().optional(),
}).strict();

/**
 * User-facing task reads (UI + live acceptance): list a room's tasks and read
 * one task's full state/evidence/attempts with paginated receipts. Reads act
 * as the gateway owner ('User'), bound to the requested room; model turns use
 * the task_* tools instead (per-turn authority, never this route). The
 * irisReadEndpoint carve-out keeps this trusted User channel usable while
 * model native/MCP reads always require a live exact origin-turn nonce.
 */
export function roomTasksRouter(db: Db, jobs: JobStore, deps?: {
  dispatcher: RoomTaskDispatcher; sse: SseHub; readVaultTask?: (taskPath: string) => string | null;
  projectTargets?: RoomTaskStoreOptions['projectTargets'];
  baselineReaders?: RoomTaskStoreOptions['baselineReaders'];
}): Router {
  const r = Router();

  // W3: 账本表单用的映射表（无凭据：仅 repoId/platform/workerId/workspace）。
  r.get('/project-targets', (_req, res) => {
    const raw: unknown = deps?.projectTargets;
    const container = raw && typeof raw === 'object' && !Array.isArray(raw) && 'projectTargets' in (raw as Record<string, unknown>)
      ? (raw as { projectTargets?: unknown }).projectTargets
      : raw;
    const entries: unknown[] = Array.isArray(container)
      ? container
      : container && typeof container === 'object'
        ? Object.values(container as Record<string, unknown>)
        : [];
    const targets = entries
      .map((entry) => {
        const repoId = entry && typeof entry === 'object' && !Array.isArray(entry)
          && typeof (entry as Record<string, unknown>).repoId === 'string'
          ? ((entry as Record<string, unknown>).repoId as string).trim()
          : '';
        const resolved = repoId ? resolveProjectTarget(repoId, deps?.projectTargets) : null;
        return resolved
          ? { repoId: resolved.repoId, platform: resolved.platform, workerId: resolved.workerId, workspace: resolved.workspace }
          : null;
      })
      .filter((item): item is { repoId: string; platform: 'linux' | 'win32'; workerId: string; workspace: string } => item !== null);
    res.json({ targets });
  });

  r.post('/room-tasks/:roomId', (req, res) => {
    if (res.locals.irisSession !== true) return res.status(401).json({ error: 'User login session required' });
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map(issue => issue.message).join('; ') });
    const body = parsed.data;
    if (!body.workspace && !body.repo_id) {
      return res.status(400).json({ error: 'workspace 与 repo_id 至少填一个；映射仓库可只填 repo_id 默认走 VPS 围栏工作区' });
    }
    const requirements = body.requirements ?? deps?.readVaultTask?.(body.task_path);
    if (!requirements?.trim()) return res.status(404).json({ error: 'Vault 任务原文不存在；请提供 requirements' });
    const store = new RoomTaskStore(db, jobs, deps?.dispatcher ?? null, {
      toolContext: { roomId: req.params.roomId, moduleId: 'plan' },
      ...(deps?.projectTargets ? { projectTargets: deps.projectTargets } : {}),
      ...(deps?.baselineReaders ? { baselineReaders: deps.baselineReaders } : {}),
    });
    const result = store.createFromIris({
      roomId: req.params.roomId, taskPath: body.task_path,
      title: body.title ?? body.task_path.slice(6, -3), requirements,
      workspace: body.workspace ?? '', repoId: body.repo_id ?? null,
      needsPc: parseNeedsPc(body),
      dispatch: body.dispatch,
      baselineSha: body.baseline_sha ?? null,
    });
    if ('error' in result) return res.status(result.code ?? 400).json({ error: result.error });
    const anchor = db.prepare('SELECT * FROM messages WHERE id = ?').get(result.anchorId);
    if (anchor) deps?.sse.broadcast('message', anchor);
    return res.status(201).json({ ...result, baseline_source: result.baselineSource, ...(result.job ? { job: publicJob(result.job) } : {}) });
  });

  r.get('/room-tasks/:roomId', (req, res) => {
    const store = new RoomTaskStore(db, jobs, null, {
      toolContext: { roomId: req.params.roomId, moduleId: 'plan' },
      irisReadEndpoint: true,
    });
    const tasks = store.listTasks(req.params.roomId);
    res.json({
      roomId: req.params.roomId,
      tasks: tasks.map((task) => ({
        ...task,
        attemptCount: store.linkedJobs(task.id).length,
      })),
    });
  });

  r.get('/room-tasks/:roomId/:taskFile', (req, res) => {
    const store = new RoomTaskStore(db, jobs, null, {
      toolContext: { roomId: req.params.roomId, moduleId: 'plan' },
      irisReadEndpoint: true,
    });
    const query = req.query as Record<string, string | undefined>;
    const outcome = store.getFull({
      roomId: req.params.roomId,
      taskPath: `tasks/${req.params.taskFile}`,
      actorContact: 'User',
      ...(query.receipt_job_id ? { receiptJobId: query.receipt_job_id } : {}),
      ...(query.receipt_offset ? { receiptOffset: Number(query.receipt_offset) } : {}),
      ...(query.receipt_limit ? { receiptLimit: Number(query.receipt_limit) } : {}),
      ...(query.event_limit ? { eventLimit: Number(query.event_limit) } : {}),
    });
    if ('error' in outcome) {
      const status = (outcome as { code?: number }).code ?? 400;
      return res.status(status).json({ error: outcome.error });
    }
    res.json((outcome as { view: unknown }).view);
  });

  return r;
}
