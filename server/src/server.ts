import express, { type Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  type AgentManager,
  contactModelRouter,
  messagesRouter,
  createRoomTaskDispatcher,
} from './runtime/index.js';
import {
  coordinationRoomHealth,
  updateCoordinationRoomReceipt,
  readWorkflowPools,
} from './workflow/index.js';
import { LifeEventRepo } from './companion/index.js';
import {
  type DbBackup,
  type SoftDeletePurge,
  appReleaseRouter,
  deployControlRouter,
  systemRouter,
} from './ops/index.js';
import { CaptionService, attachmentsRouter, journalRouter } from './messages/index.js';
import {
  type HubConfig,
  type Db,
  logMessage,
  type HubLogger,
  sessionAuth,
  localCors,
  type SseHub,
} from './platform/index.js';
import type { VaultClient } from './memory/index.js';
import type { ClaudeQuotaPoller, CodexQuotaPoller, GrokQuotaPoller } from './quota/index.js';
import { contactsRouter, userRouter } from './contacts/index.js';
import { hubMcpRouter } from './tools/index.js';
import {
  roomTasksRouter,
  RoomTaskStore,
  readVaultTaskFile,
  type RoomTaskStoreOptions,
} from './roomTasks/index.js';
import { vaultTasksRouter } from './tasks/index.js';
import { workersRouter, workflowModulesRouter, type JobStore, deriveDeliverySummary } from './jobs/index.js';
import type { WechatChannel } from './wechat/index.js';
import { type CompanionHeartbeat, heartbeatRouter } from './heartbeat/index.js';
import type { CameraSnapBroker, TaobaoBridge } from './devices/index.js';

export interface ServerDependencies {
  config: HubConfig;
  db: Db;
  sse: SseHub;
  vault: VaultClient | null;
  jobStore: JobStore;
  manager: AgentManager;
  heartbeat: CompanionHeartbeat;
  broker: CameraSnapBroker;
  taobao?: TaobaoBridge;
  dbBackup: DbBackup;
  softPurge: SoftDeletePurge;
  quotaPoller: ClaudeQuotaPoller;
  codexQuotaPoller: CodexQuotaPoller;
  grokQuotaPoller: GrokQuotaPoller;
  logger: HubLogger;
  wechatChannel?: Pick<WechatChannel, 'status'>;
  hubToken?: string;
  corsOrigins?: string;
  /** Room task dispatcher + store options built once by the gateway root; tests may omit it. */
  roomTasks?: ReturnType<typeof roomTaskPlumbing>;
}

/** Shared task-ledger plumbing: dispatcher + Vault-backed store options. */
export function roomTaskPlumbing(
  db: Db,
  sse: SseHub,
  manager: AgentManager,
  tasksDir: string | null,
  projectTargets?: RoomTaskStoreOptions['projectTargets'],
): { taskDispatcher: ReturnType<typeof createRoomTaskDispatcher>; taskStoreOptions: Pick<RoomTaskStoreOptions, 'readVaultTask' | 'projectTargets'> } {
  return {
    taskDispatcher: createRoomTaskDispatcher({ db, sse, manager }),
    taskStoreOptions: {
      readVaultTask: (taskPath: string) => readVaultTaskFile(tasksDir, taskPath),
      ...(projectTargets ? { projectTargets } : {}),
    },
  };
}

export function attachWorkerCompletion(deps: ServerDependencies): void {
  const { config, db, jobStore, logger, manager, sse } = deps;
  const tasksDir = config?.memory?.repoPath ? path.join(config.memory.repoPath, 'tasks') : null;
  // Model-driven workflow: completion folds task-ledger jobs into their task
  // and notifies ONLY the explicitly registered return callback. Legacy jobs
  // keep their stored result plus an in-place receipt state update — zero new
  // wakes, zero inferred next stages/recipients. The automatic
  // review/rework/closure chain and the review batcher are retired (see
  // docs/model-driven-room-workflow.md); worker-tail auto-projection is
  // retired with them (explicit task_import + task_get replace it).
  const { taskDispatcher, taskStoreOptions } = deps.roomTasks
    ?? roomTaskPlumbing(db, sse, manager, tasksDir, config?.projectTargets);

  // (Retired helpers removed: ensureLegacyWorkerTail, annotateParentTask,
  // closeLegacyWorkerTail, syncWorkerTail, dispatchRoomReceipt,
  // dispatchCoordinationReceipt, dispatchDegradedDmReceipt. History rows stay;
  // no new automatic wakes are produced.)

  // Durable outbox 驱动：抛错 = 可重试（指数退避），finalAttempt 时只记事件，
  // 处理器把仍然失败的行转 dead（outboxCounts 可观测）。任务回调与回执更新
  // 都是幂等的，整个重试/重启链路上恰好一次可见投递、零推断动作。
  jobStore.onFinished = async (job, ctx) => {
    // Model-driven ledger path first: fold the receipt into the task and
    // notify ONLY the explicitly registered return callback. Never creates
    // jobs/handoffs; infra failures and stale attempts produce ledger events
    // and retries, not new work.
    try {
      const tasks = new RoomTaskStore(db, jobStore, taskDispatcher, taskStoreOptions);
      if (tasks.handleJobFinished(job, { finalAttempt: ctx.finalAttempt }).handled) return;
    } catch (error) {
      logger.error({ component: 'jobs', jobId: job.id, err: error }, 'room task finish fold failed');
      if (!ctx.finalAttempt) throw error;
      return;
    }
    // Legacy path: preserve result storage in place, zero wakes. Fenced
    // attempts get nothing (the takeover replacement owns notifications).
    // No review/rework/closure jobs, no receipt dispatches, no DM fallback.
    if (jobStore.workflowModules.isFenced(job.id)) return;
    if (!ctx.meta.receiptUpdated) {
      const receiptUpdate = updateCoordinationRoomReceipt({ db, sse }, {
        idempotencyKey: `receipt:v1:${job.id}`,
        status: job.status,
        deliveryState: job.delivery_state ?? 'unknown',
        summary: deriveDeliverySummary(job).summary,
      });
      if (receiptUpdate.status === 'updated') {
        logger.info({ component: 'jobs', jobId: job.id, messageId: receiptUpdate.messageId }, 'worker receipt state updated');
        ctx.setMeta({ receiptUpdated: true });
      }
    }
  };
}

export function createServer(deps: ServerDependencies): Express {
  const { config, db, dbBackup, grokQuotaPoller, jobStore, manager, quotaPoller, codexQuotaPoller, softPurge, sse } = deps;
  const workflowPools = () => readWorkflowPools(db, {
    claude: () => quotaPoller.get(), codex: () => codexQuotaPoller.get(), grok: () => grokQuotaPoller.get(),
  });
  jobStore.setWorkflowPoolResolver((runner) => workflowPools()[`credential:${runner}`]?.reason ?? null);
  const captions = new CaptionService(db, config.uploadsDir, logMessage(deps.logger, 'caption'));
  const tasksDir = config?.memory?.repoPath ? path.join(config.memory.repoPath, 'tasks') : null;
  const roomTasks = deps.roomTasks ?? roomTaskPlumbing(db, sse, manager, tasksDir, config?.projectTargets);
  attachWorkerCompletion({ ...deps, roomTasks });
  const { taskDispatcher, taskStoreOptions } = roomTasks;
  const app = express();
  app.use(localCors(deps.corsOrigins));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', deployControlRouter(manager));
  const auth = sessionAuth(deps.hubToken);
  if (auth) app.use(auth);

  app.get('/api/session', (_req, res) => res.json({ enabled: false, authenticated: true }));
  app.post('/api/session', (_req, res) => res.json({ enabled: false, authenticated: true }));
  app.delete('/api/session', (_req, res) => res.json({ enabled: false, authenticated: true }));

  app.get('/api/health', (_req, res) => {
    const count = db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
    res.json({
      status: 'ok',
      messageCount: count.c,
      coordination: coordinationRoomHealth(db),
      jobOutbox: jobStore.outboxCounts(),
      ...(deps.wechatChannel ? { wechat: deps.wechatChannel.status() } : {}),
    });
  });
  app.get('/api/system/captions', (_req, res) => {
    res.json(captions.health());
  });
  app.get('/api/system/life-events', (_req, res) => {
    res.json({ events: new LifeEventRepo(db).healthWithNames() });
  });
  app.get('/api/events', (req, res) => {
    const subscriptions = typeof req.query.subscribe === 'string'
      ? new Set(req.query.subscribe.split(',').map((id) => id.trim()).filter(Boolean).slice(0, 100))
      : null;
    sse.addClient(res, subscriptions);
    for (const status of manager.activeStatuses()) sse.send(res, 'status', status);
  });

  app.use('/api/app', appReleaseRouter(config.releasesDir));
  app.use('/api/contacts', contactModelRouter(db, sse, manager, config, deps.logger));
  app.use('/api/contacts', contactsRouter(db, sse, manager));
  app.use('/api/contacts', messagesRouter(db, sse, manager, config.uploadsDir, captions, jobStore));
  app.use('/api/contacts', heartbeatRouter(db, deps.heartbeat));
  app.use('/api/attachments', attachmentsRouter(db, config.uploadsDir));
  app.use('/api/user', userRouter(db, sse));
  app.use('/api', journalRouter(db));
  app.use('/api', workersRouter(db, sse, jobStore, deps.logger, deps.broker, deps.taobao));
  app.use('/api', workflowModulesRouter(db, sse, jobStore, workflowPools, taskStoreOptions.projectTargets));
  app.use('/api', roomTasksRouter(db, jobStore, { dispatcher: taskDispatcher, sse, ...taskStoreOptions }));
  app.use('/api', hubMcpRouter(db, jobStore, {
    hubToken: deps.hubToken,
    envMode: process.env.HUB_MCP_AUTH_MODE,
    logger: deps.logger,
  }, { broker: deps.broker, heartbeat: deps.heartbeat, taobao: deps.taobao, taskDispatch: taskDispatcher, taskStoreOptions }));
  app.use('/api/vault', vaultTasksRouter({
    db,
    tasksDir: config.memory.repoPath ? path.join(config.memory.repoPath, 'tasks') : null,
  }));
  app.use('/api', systemRouter(config));
  app.get('/api/system/backup', (_req, res) => res.json(dbBackup.status()));
  app.post('/api/system/backup', async (_req, res) => {
    try {
      const file = await dbBackup.runOnce();
      res.json({ ok: true, file, ...dbBackup.status() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get('/api/system/purge', (_req, res) => res.json(softPurge.status()));
  app.post('/api/system/purge', async (req, res) => {
    try {
      const result = await softPurge.runOnce({ dryRun: req.query.dryRun === '1' || req.body?.dryRun === true });
      res.json({ ok: true, result, ...softPurge.status() });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get('/api/quota/claude', (_req, res) => res.json(quotaPoller.get()));
  app.get('/api/quota/codex', (_req, res) => {
    const quota = codexQuotaPoller.get();
    res.json({ available: quota !== null, ...(quota ?? {}) });
  });
  app.get('/api/quota/grok', (_req, res) => res.json(grokQuotaPoller.get()));

  app.use('/releases', express.static(config.releasesDir, {
    dotfiles: 'deny',
    fallthrough: false,
    index: false,
    maxAge: '1h',
  }));

  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
  }
  return app;
}
