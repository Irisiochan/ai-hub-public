import { Router } from 'express';
import type { Db, JobRow, SseHub } from '../platform/index.js';
import { modelCatalog } from '../contacts/index.js';
import { publicJob } from './deliveryStatus.js';
import type { JobStore } from './jobStore.js';
import { resolveProjectTarget, type ProjectTargetsInput } from './projectTargets.js';
import {
  ensureWorkflowRoomReserves,
  WORKFLOW_MODULES,
  WORKFLOW_MODULE_IDS,
  isWorkflowRoomConfig,
  moduleOfJobOptions,
  poolOf,
  runnerForBackend,
  supportedEfforts,
  isRunnerCompatible,
  type ModuleBinding,
  type WorkflowModuleId,
} from '../workflow/index.js';

export interface QuotaPoolState {
  blocked: boolean;
  reason?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseOptions(job: JobRow): Record<string, unknown> {
  try {
    const value = job.options ? JSON.parse(job.options) : {};
    return record(value);
  } catch {
    return {};
  }
}

function moduleOfJob(job: JobRow): WorkflowModuleId {
  return moduleOfJobOptions(parseOptions(job));
}

function modelOfJob(job: JobRow): string {
  const options = parseOptions(job);
  return typeof options.model === 'string' ? options.model : '';
}

function reasoningOfJob(job: JobRow): string {
  const options = parseOptions(job);
  return typeof options.reasoning === 'string' ? options.reasoning : '';
}

function revisionOfJob(job: JobRow): number {
  const options = parseOptions(job);
  const invocation = record(options.workflowModule);
  const revision = Number(invocation.bindingRevision);
  if (Number.isSafeInteger(revision) && revision > 0) return revision;
  const legacy = record(options.workflow);
  const profileVersion = Number(legacy.profileVersion);
  if (Number.isSafeInteger(profileVersion) && profileVersion > 0) return profileVersion;
  return 1;
}

const KNOWN_AGENT_RUNNERS = new Set(['codex', 'claude', 'grok', 'opencode']);

function catalogBackend(runner: string): string {
  if (runner === 'claude') return 'claude-cli';
  if (runner === 'grok') return 'grok-cli';
  if (runner === 'opencode') return 'opencode-cli';
  return 'codex-cli';
}

/** Shared GET representation for the HTTP contract and behavioral tests. */
export function buildWorkflowModulesView(
  db: Db,
  jobs: JobStore,
  getPools: () => Record<string, QuotaPoolState> = () => ({}),
) {
  const modules = jobs.workflowModules;
    const revision = modules.revision();
    const bindings = modules.bindings();
    const pools = getPools();
    const activeJobs = db.prepare(
      `SELECT * FROM jobs WHERE deleted = 0 AND status IN
        ('pending','claimed','running','recovering','pause_requested','cancel_requested')`,
    ).all() as JobRow[];
    const activeByModule = new Map<string, number>();
    for (const job of activeJobs) {
      const id = moduleOfJob(job);
      activeByModule.set(id, (activeByModule.get(id) ?? 0) + 1);
    }
    const moduleViews = WORKFLOW_MODULES.map((definition) => {
      const binding = bindings[definition.id];
      const contact = db.prepare(
        'SELECT id, backend, enabled, kind FROM contacts WHERE id = ?',
      ).get(binding.contactId) as
        | { id: string; backend: string; enabled: number; kind: string }
        | undefined;
      let status: 'idle' | 'running' | 'blocked' | 'unavailable' = 'idle';
      let statusDetail: string | undefined;
      if (!contact || contact.kind !== 'dm' || contact.enabled !== 1) {
        status = 'unavailable';
        statusDetail = `bound contact ${binding.contactId} is missing or disabled`;
      } else if (runnerForBackend(contact.backend) !== binding.runner) {
        status = 'unavailable';
        statusDetail = `bound contact ${binding.contactId} runs ${contact.backend}, not ${binding.runner}`;
      } else {
        const validation = modules.validateBinding(definition.id, binding);
        const pool = pools[poolOf(binding)];
        if (!validation.ok) {
          status = 'unavailable';
          statusDetail = validation.error;
        } else if (pool?.blocked) {
          status = 'blocked';
          statusDetail = pool.reason ?? 'credential pool unavailable';
        } else if ((activeByModule.get(definition.id) ?? 0) > 0) {
          status = 'running';
        }
      }
      return {
        id: definition.id,
        label: definition.label,
        description: definition.description,
        permissions: definition.permissions,
        binding,
        status,
        ...(statusDetail ? { statusDetail } : {}),
      };
    });

    const contacts = db.prepare(
      "SELECT id, name, backend, enabled FROM contacts WHERE kind = 'dm' ORDER BY sort_order, id",
    ).all() as Array<{ id: string; name: string; backend: string; enabled: number }>;
    const agents = contacts
      .filter((contact) => contact.enabled === 1)
      .map((contact) => {
        const runner = runnerForBackend(contact.backend);
        const quotaPool = KNOWN_AGENT_RUNNERS.has(runner) ? poolOf({ runner } as ModuleBinding) : undefined;
        const pool = quotaPool ? pools[quotaPool] : undefined;
        if (!KNOWN_AGENT_RUNNERS.has(runner)) {
          // Unsupported adapters stay visible but incompatible until write/shell/ssh
          // enforcement exists for them — never silently relax into a binding.
          return {
            contactId: contact.id,
            name: contact.name,
            runner: contact.backend,
            models: [],
            compatibleModules: [],
            unavailableReason: `backend ${contact.backend} cannot enforce module shell-write/SSH separation yet`,
            ...(quotaPool ? { quotaPool } : {}),
          };
        }
        const catalog = modelCatalog(catalogBackend(runner));
        return {
          contactId: contact.id,
          name: contact.name,
          runner,
          models: catalog.models.filter((item) => item.id).map((item) => ({
            id: item.id,
            label: item.label,
            efforts: supportedEfforts(runner, item.id),
          })),
          compatibleModules: WORKFLOW_MODULES.filter((definition) => isRunnerCompatible(runner, definition.permissions)).map((definition) => definition.id),
          ...(pool?.blocked ? { unavailableReason: pool.reason ?? 'credential pool unavailable' } : {}),
          ...(quotaPool ? { quotaPool } : {}),
        };
      });

    const jobRows = db.prepare(
      'SELECT * FROM jobs WHERE deleted = 0 ORDER BY created_at DESC LIMIT 100',
    ).all() as JobRow[];
    const jobViews = jobRows.map((job) => {
      const moduleId = moduleOfJob(job);
      const blocker = jobs.takeoverBlocker(job);
      const already = modules.takeoverOf(job.id);
      return {
        id: job.id,
        moduleId,
        status: job.status,
        model: modelOfJob(job) || job.runner,
        reasoning: reasoningOfJob(job),
        bindingRevision: revisionOfJob(job),
        ...(job.error ? { error: job.error.slice(0, 500) } : {}),
        canTakeover: !blocker && !already,
      };
    });

    return {
      revision,
      workerTarget: modules.workerTarget(),
      modules: moduleViews,
      agents,
      jobs: jobViews,
      audit: modules.audit(30),
    };
}

export function workflowModulesRouter(
  db: Db,
  sse: SseHub,
  jobs: JobStore,
  getPools: () => Record<string, QuotaPoolState> = () => ({}),
  projectTargets?: ProjectTargetsInput,
): Router {
  const r = Router();
  const modules = jobs.workflowModules;
  const buildView = () => buildWorkflowModulesView(db, jobs, getPools);

  r.get('/workflow-modules', (_req, res) => {
    res.json(buildView());
  });

  r.patch('/workflow-modules/worker-target', (req, res) => {
    if (res.locals.irisSession !== true) return res.status(401).json({ error: 'User login session required' });
    const expectedRevision = Number(req.body?.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      return res.status(400).json({ error: 'expectedRevision must be a positive integer' });
    }
    const raw = record(req.body?.target);
    const workerId = String(raw.workerId ?? '').trim();
    const workspace = String(raw.workspace ?? '').trim().replaceAll('\\', '/').replace(/\/+$/, '');
    const repoId = String(raw.repoId ?? '').trim();
    const worker = db.prepare('SELECT capabilities FROM workers WHERE id = ?')
      .get(workerId) as { capabilities: string } | undefined;
    if (!worker || !workspace || workspace.length > 1000) {
      return res.status(400).json({ error: '请选择已登记的 Worker 和工作区' });
    }
    let capabilities: Record<string, unknown> = {};
    try { capabilities = record(JSON.parse(worker.capabilities)); } catch { /* reject below */ }
    const roots = Array.isArray(capabilities.workspaces) ? capabilities.workspaces : [];
    const hasRoot = roots.some((root) => typeof root === 'string'
      && root.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() === workspace.toLowerCase());
    if (!hasRoot) return res.status(400).json({ error: '工作区不在所选 Worker 的白名单中' });
    if (repoId) {
      const mapped = resolveProjectTarget(repoId, projectTargets);
      if (!mapped || mapped.platform !== 'linux' || mapped.workerId !== workerId || mapped.workspace !== workspace) {
        return res.status(400).json({ error: 'VPS 工作区必须与仓库映射的 Worker 和根目录一致' });
      }
    } else if (!/^[A-Za-z]:\//.test(workspace)) {
      return res.status(400).json({ error: 'VPS 工作区请选择已映射的仓库' });
    }
    const target = { workerId, workspace, ...(repoId ? { repoId } : {}) };
    const outcome = modules.setWorkerTarget(target, expectedRevision, 'User');
    if (!outcome.ok) return res.status(outcome.code).json({ error: outcome.error });
    sse.broadcast('workflow-modules', { revision: outcome.revision, workerTarget: target });
    res.json(buildView());
  });

  r.patch('/workflow-modules/:moduleId', (req, res) => {
    const moduleId = req.params.moduleId as WorkflowModuleId;
    if (!WORKFLOW_MODULE_IDS.includes(moduleId)) {
      return res.status(404).json({ error: `unknown module ${req.params.moduleId}` });
    }
    const expectedRevision = Number(req.body?.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      return res.status(400).json({ error: 'expectedRevision must be a positive integer' });
    }
    const raw = record(req.body?.binding);
    const binding: ModuleBinding = {
      contactId: String(raw.contactId ?? '').trim(),
      runner: String(raw.runner ?? '').trim() as ModuleBinding['runner'],
      model: String(raw.model ?? '').trim(),
      reasoning: String(raw.reasoning ?? '').trim(),
    };
    const outcome = modules.setBinding(moduleId, binding, expectedRevision, 'User');
    if (!outcome.ok) {
      const failed = outcome as { error: string; code: number };
      return res.status(failed.code).json({ error: failed.error });
    }
    // A newly bound agent must already sit in workflow rooms as a reserve;
    // idempotent addition, never a removal, never a model wake.
    try {
      ensureWorkflowRoomReserves(db);
    } catch { /* reserve sync is best-effort; binding already committed */ }
    sse.broadcast('workflow-modules', { revision: outcome.revision, moduleId });
    sse.broadcast('workflow-profile', { revision: outcome.revision, moduleId });
    res.json(buildView());
  });

  r.post('/workflow-modules/jobs/:jobId/takeover', (req, res) => {
    const expectedRevision = Number(req.body?.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      return res.status(400).json({ error: 'expectedRevision must be a positive integer' });
    }
    const currentRevision = modules.revision();
    if (Number.isSafeInteger(expectedRevision) && expectedRevision > 0 && expectedRevision !== currentRevision) {
      return res.status(409).json({
        error: `stale revision: expected ${expectedRevision}, current ${currentRevision}`,
      });
    }
    const outcome = jobs.takeover(req.params.jobId, 'User');
    if ('error' in outcome) {
      return res.status(outcome.code).json({ error: outcome.error });
    }
    if (!outcome.existing) {
      sse.broadcast('workflow-modules', {
        revision: currentRevision,
        takeover: { oldJobId: req.params.jobId, newJobId: outcome.job.id },
      });
    }
    res.status(outcome.existing ? 200 : 201).json({ job: publicJob(outcome.job), ...(outcome.existing ? { existing: true } : {}) });
  });

  // Room marker helper shared by room bootstrap: workflow rooms opt in via
  // config.workflowEnabled or the existing coordination object.
  r.get('/workflow-modules/rooms/:roomId', (req, res) => {
    const room = db.prepare("SELECT * FROM contacts WHERE id = ? AND kind = 'room'").get(req.params.roomId) as
      | { id: string; config: string }
      | undefined;
    if (!room) return res.status(404).json({ error: 'room not found' });
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(room.config || '{}') as Record<string, unknown>;
    } catch {
      config = {};
    }
    res.json({ roomId: room.id, workflowEnabled: isWorkflowRoomConfig(config) });
  });

  return r;
}
