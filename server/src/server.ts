import express, { type Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { type AgentManager } from './agents/manager.js';
import { coordinationRoomHealth, dispatchCoordinationRoomHost } from './agents/coordinationRoom.js';
import { AffectRepo } from './agents/affect.js';
import { type DbBackup } from './backup.js';
import { type HubConfig } from './config.js';
import { type Db, type ContactRow, type JobRow, type MessageRow } from './db.js';
import { type HubLogger } from './logger.js';
import { sessionAuth } from './middleware/auth.js';
import { localCors } from './middleware/cors.js';
import { type VaultClient } from './memory/vaultClient.js';
import { type SoftDeletePurge } from './purge.js';
import { type ClaudeQuotaPoller } from './quota/claudeQuota.js';
import { type CodexQuotaPoller } from './quota/codexQuota.js';
import { type GrokQuotaPoller } from './quota/grokQuota.js';
import { attachmentsRouter } from './routes/attachments.js';
import { appReleaseRouter } from './routes/appRelease.js';
import { contactsRouter } from './routes/contacts.js';
import { hubMcpRouter } from './routes/hubMcp.js';
import { journalRouter } from './routes/journal.js';
import { messagesRouter } from './routes/messages.js';
import { deployControlRouter, systemRouter } from './routes/system.js';
import { userRouter } from './routes/user.js';
import { vaultTasksRouter } from './routes/vaultTasks.js';
import { workersRouter } from './routes/workers.js';
import { type SseHub } from './sse.js';
import { type JobStore } from './workers/jobStore.js';
import { deriveDeliverySummary } from './workers/deliveryStatus.js';
import { formatCoordinationReceipt, parseCoordinationMarker } from './workers/coordinationReceipt.js';
import type { WechatChannel } from './wechat/channel.js';

export interface ServerDependencies {
  config: HubConfig;
  db: Db;
  sse: SseHub;
  vault: VaultClient | null;
  jobStore: JobStore;
  manager: AgentManager;
  dbBackup: DbBackup;
  softPurge: SoftDeletePurge;
  quotaPoller: ClaudeQuotaPoller;
  codexQuotaPoller: CodexQuotaPoller;
  grokQuotaPoller: GrokQuotaPoller;
  logger: HubLogger;
  wechatChannel?: Pick<WechatChannel, 'status'>;
  hubToken?: string;
  corsOrigins?: string;
}

function parseDeliveryMeta(raw: string | null): { dirtyFiles?: string[]; head?: string | null; ahead?: number | null } {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function attachWorkerCompletion(deps: ServerDependencies): void {
  const { db, jobStore, logger, manager, sse, vault } = deps;
  const ensureWorkerTail = async (job: JobRow): Promise<void> => {
    if (!vault || !['blocked_local_changes', 'blocked_unpushed'].includes(job.delivery_state ?? '')) return;
    const taskPath = `tasks/worker-tail-${job.id}.md`;
    const meta = parseDeliveryMeta(job.delivery_meta);
    const files = Array.isArray(meta.dirtyFiles) && meta.dirtyFiles.length
      ? meta.dirtyFiles.map((file) => `- \`${file}\``).join('\n')
      : '- （工作区干净；存在尚未推送的 commit）';
    const note = [
      `Worker job：\`${job.id}\``,
      `交付状态：\`${job.delivery_state}\``,
      `workspace：\`${job.workspace}\``,
      meta.head ? `HEAD：\`${meta.head}\`${typeof meta.ahead === 'number' ? `（领先 upstream ${meta.ahead}）` : ''}` : '',
      '', '### 本地状态', files, '', '### 原始需求', job.prompt.slice(0, 6000), '', '### Worker 回执',
      (job.result || job.error || '（无输出）').slice(0, 8000), '', '### 下一步',
      '从现有工作区续接，核对改动后完成剩余验证；验证通过再只提交本任务文件并 push。禁止从头派单覆盖本地改动。',
    ].filter((line) => line !== '').join('\n');
    const source = job.requested_by || 'codex';
    try {
      await vault.call('read_file', { path: taskPath }, 0);
      await vault.write('update_task', { path: taskPath, status: 'open', note, source });
      logger.info({ component: 'jobs', taskPath, jobId: job.id }, 'worker tail refreshed');
    } catch {
      const outcome = await vault.write('add_task', {
        slug: `worker-tail-${job.id}`,
        title: `Worker 未完成交付 ${job.id.slice(0, 8)}`,
        due: '', content: note,
        tags: ['backlog', 'worker-tail', path.basename(job.workspace).toLowerCase()], source,
      });
      logger.info({ component: 'jobs', taskPath, jobId: job.id, outcome }, 'worker tail registered');
    }
  };

  const workerReceiptText = (job: JobRow): string => {
    const body = job.result || job.error || '（无输出）';
    const delivery = deriveDeliverySummary(job);
    return [
      '⚙ Worker 任务回执（网关自动通知，User 也看得到这条）',
      `任务 ${job.id}：${delivery.summary}`,
      `下一步负责人：${delivery.nextOwner}`,
      `执行环境：${job.runner} · ${job.workspace}`,
      '', 'Worker 原始回执（验收依据）：', body.slice(0, 6000), '',
      '请直接给出验收结论并同步需求账本：以本回执和 worker_job_status 为依据，禁止调用终端/git fetch/VPS 复核。只有本任务要求的验证、commit、push、部署与 post-deploy 验收均完成，或剩余部署已因无 SSH 权限、自断回执风险、等待 exact-target 授权而登记合法 deploy-tail，才 update_task 关闭原 backlog；否则保持 backlog open，并确认自动登记的 worker-tail 写清 workspace、文件、检查、阻塞与下一步。不要条件反射地从头派新任务。',
    ].filter(Boolean).join('\n');
  };

  const dispatchCoordinationReceipt = (job: JobRow): boolean => {
    const marker = parseCoordinationMarker(job.prompt);
    if (!marker) return false;
    const dispatchKey = `coordination:${marker.taskPath}:${marker.planHash}`;
    const text = formatCoordinationReceipt(job, marker);
    const outcome = dispatchCoordinationRoomHost({ db, sse, manager, logger }, {
      targetId: 'claude',
      content: text,
      kind: 'receipt',
      exactDispatchKey: dispatchKey,
      idempotencyKey: `receipt:v1:${job.id}:${job.status}:${job.delivery_state ?? 'unknown'}`,
      meta: {
        coordination: {
          jobId: job.id,
          taskPath: marker.taskPath,
          planHash: marker.planHash,
          originAnchorId: job.origin_anchor_id,
        },
      },
    });
    if (outcome.status === 'unavailable') {
      logger.warn({ component: 'jobs', jobId: job.id, reason: outcome.reason }, 'coordination receipt fell back to DM');
    }
    return outcome.status !== 'unavailable';
  };

  jobStore.onFinished = (job) => {
    try {
      void ensureWorkerTail(job).catch((error) => logger.error({ component: 'jobs', jobId: job.id, err: error }, 'worker tail registration failed'));
      if (dispatchCoordinationReceipt(job)) return;
      if (!job.requested_by || job.requested_by === 'User') return;
      const roomText = `@${job.requested_by} ${workerReceiptText(job)}`;
      const roomOutcome = dispatchCoordinationRoomHost({ db, sse, manager, logger }, {
        targetId: job.requested_by,
        content: roomText,
        kind: 'receipt',
        idempotencyKey: `receipt:v1:${job.id}:${job.status}:${job.delivery_state ?? 'unknown'}`,
        meta: { receipt: { jobId: job.id, requestedBy: job.requested_by } },
      });
      if (roomOutcome.status !== 'unavailable') return;
      logger.warn({
        component: 'jobs',
        jobId: job.id,
        requestedBy: job.requested_by,
        reason: roomOutcome.reason,
      }, 'worker receipt fell back to DM side channel');
      const contact = db.prepare("SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'").get(job.requested_by) as ContactRow | undefined;
      if (!contact) return;
      const text = workerReceiptText(job);
      const result = db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin) VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'side')`).run(contact.id, text, JSON.stringify({ event: 'worker-receipt', jobId: job.id }));
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(result.lastInsertRowid)) as MessageRow;
      sse.broadcast('message', row);
      if (manager.get(contact).enqueue({ userMessageId: row.id, text }) === 'full') {
        logger.warn({ component: 'jobs', contactId: contact.id, jobId: job.id }, 'receipt persisted but continuation queue is full');
      }
    } catch (error) {
      logger.error({ component: 'jobs', err: error }, 'worker completion continuation failed');
    }
  };
}

export function createServer(deps: ServerDependencies): Express {
  const { config, db, dbBackup, grokQuotaPoller, jobStore, manager, quotaPoller, codexQuotaPoller, softPurge, sse } = deps;
  attachWorkerCompletion(deps);
  const app = express();
  app.use(localCors(deps.corsOrigins));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', deployControlRouter());
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
      ...(deps.wechatChannel ? { wechat: deps.wechatChannel.status() } : {}),
    });
  });
  app.get('/api/system/affect', (_req, res) => {
    res.json({ states: new AffectRepo(db).health() });
  });
  app.get('/api/events', (req, res) => {
    const subscriptions = typeof req.query.subscribe === 'string'
      ? new Set(req.query.subscribe.split(',').map((id) => id.trim()).filter(Boolean).slice(0, 100))
      : null;
    sse.addClient(res, subscriptions);
    for (const status of manager.activeStatuses()) sse.send(res, 'status', status);
  });

  app.use('/api/app', appReleaseRouter(config.releasesDir));
  app.use('/api/contacts', contactsRouter(db, sse, manager, config, deps.logger));
  app.use('/api/contacts', messagesRouter(db, sse, manager, config.uploadsDir));
  app.use('/api/attachments', attachmentsRouter(db, config.uploadsDir));
  app.use('/api/user', userRouter(db, sse));
  app.use('/api', journalRouter(db));
  app.use('/api', workersRouter(db, sse, jobStore, deps.logger));
  app.use('/api', hubMcpRouter(db, jobStore));
  app.use('/api/vault', vaultTasksRouter(deps.vault));
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
