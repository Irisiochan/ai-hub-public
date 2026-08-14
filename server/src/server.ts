import express, { type Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { type AgentManager } from './agents/manager.js';
import {
  coordinationRoomHealth,
  dispatchCoordinationRoomHost,
  updateCoordinationRoomReceipt,
} from './agents/coordinationRoom.js';
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
import { coordinationMarkerDispatchKey, formatCoordinationReceipt, parseCoordinationMarker } from './workers/coordinationReceipt.js';
import { formatWorkerReceiptPreview } from './workers/receiptPreview.js';
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

  const dispatchCoordinationReceipt = (job: JobRow): 'sent' | 'unavailable' | 'not-coordination' => {
    const marker = parseCoordinationMarker(job.prompt);
    if (!marker) return 'not-coordination';
    const dispatchKey = coordinationMarkerDispatchKey(marker);
    const text = formatCoordinationReceipt(job, marker);
    const outcome = dispatchCoordinationRoomHost({ db, sse, manager, logger }, {
      targetId: 'claude',
      content: text,
      kind: 'receipt',
      exactDispatchKey: dispatchKey,
      idempotencyKey: `receipt:v1:${job.id}`,
      meta: {
        receipt: {
          jobId: job.id,
          requestedBy: job.requested_by,
          status: job.status,
          deliveryState: job.delivery_state ?? 'unknown',
        },
        coordination: {
          jobId: job.id,
          taskPath: marker.taskPath,
          planHash: marker.planHash,
          originAnchorId: job.origin_anchor_id,
        },
      },
    });
    if (outcome.status === 'unavailable') {
      logger.warn({ component: 'jobs', jobId: job.id, reason: outcome.reason }, 'coordination receipt room unavailable');
      return 'unavailable';
    }
    return 'sent';
  };

  /** 末次尝试的可见降级：DM 落一条回执。以 meta.jobId 幂等，重启后重放不重复气泡。 */
  const dispatchDegradedDmReceipt = (job: JobRow): void => {
    const contact = db.prepare("SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'").get(job.requested_by) as ContactRow | undefined;
    if (!contact) {
      logger.error({ component: 'jobs', jobId: job.id, requestedBy: job.requested_by }, 'worker receipt dead-end: no room and no DM contact');
      return;
    }
    const existing = db.prepare(
      `SELECT id FROM messages
       WHERE contact_id = ? AND json_extract(meta, '$.event') = 'worker-receipt'
         AND json_extract(meta, '$.jobId') = ?
       ORDER BY id DESC LIMIT 1`
    ).get(contact.id, job.id);
    if (existing) return;
    const text = `【降级投递：会议室不可用】\n${formatWorkerReceiptPreview(job)}`;
    const result = db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin) VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main')`).run(contact.id, text, JSON.stringify({
      event: 'worker-receipt',
      jobId: job.id,
      status: job.status,
      deliveryState: job.delivery_state ?? 'unknown',
      degradedDelivery: true,
    }));
    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(result.lastInsertRowid)) as MessageRow;
    sse.broadcast('message', row);
    if (manager.get(contact).enqueue({ userMessageId: row.id, text }) === 'full') {
      logger.warn({ component: 'jobs', contactId: contact.id, jobId: job.id }, 'receipt persisted but continuation queue is full');
    }
  };

  // Durable outbox 驱动：抛错 = 可重试（指数退避），finalAttempt 时改走可见降级，
  // 处理器把仍然失败的行转 dead（outboxCounts 可观测）。回执幂等键保证整个
  // 重试/重启链路上恰好一条用户可见回执。
  jobStore.onFinished = async (job, ctx) => {
    if (!ctx.meta.tailDone) {
      try {
        await ensureWorkerTail(job);
        ctx.setMeta({ tailDone: true });
      } catch (error) {
        logger.error({ component: 'jobs', jobId: job.id, err: error }, 'worker tail registration failed');
        // vault 恢复后重试补 tail；末次尝试放行，让回执仍然送达。
        if (!ctx.finalAttempt) throw error;
      }
    }
    const receiptUpdate = updateCoordinationRoomReceipt({ db, sse }, {
      idempotencyKey: `receipt:v1:${job.id}`,
      status: job.status,
      deliveryState: job.delivery_state ?? 'unknown',
      summary: deriveDeliverySummary(job).summary,
    });
    if (receiptUpdate.status === 'updated') {
      logger.info({ component: 'jobs', jobId: job.id, messageId: receiptUpdate.messageId }, 'worker receipt state updated');
      return;
    }
    const coordinationOutcome = dispatchCoordinationReceipt(job);
    if (coordinationOutcome === 'sent') return;
    if (coordinationOutcome === 'unavailable' && !ctx.finalAttempt) {
      throw new Error('coordination room unavailable for receipt; will retry');
    }
    if (!job.requested_by || job.requested_by === 'User') return;
    const roomText = `@${job.requested_by} ${formatWorkerReceiptPreview(job)}`;
    const roomOutcome = dispatchCoordinationRoomHost({ db, sse, manager, logger }, {
      targetId: job.requested_by,
      content: roomText,
      kind: 'receipt',
      idempotencyKey: `receipt:v1:${job.id}`,
      meta: {
        receipt: {
          jobId: job.id,
          requestedBy: job.requested_by,
          status: job.status,
          deliveryState: job.delivery_state ?? 'unknown',
        },
      },
    });
    if (roomOutcome.status !== 'unavailable') return;
    if (!ctx.finalAttempt) {
      throw new Error(`worker receipt room unavailable (${roomOutcome.reason ?? 'unknown'}); will retry`);
    }
    logger.warn({
      component: 'jobs',
      jobId: job.id,
      requestedBy: job.requested_by,
      reason: roomOutcome.reason,
    }, 'worker receipt fell back to visible DM main');
    dispatchDegradedDmReceipt(job);
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
      jobOutbox: jobStore.outboxCounts(),
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
  app.use('/api', hubMcpRouter(db, jobStore, {
    hubToken: deps.hubToken,
    envMode: process.env.HUB_MCP_AUTH_MODE,
    logger: deps.logger,
  }));
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
