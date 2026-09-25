import fs from 'node:fs';
import path from 'node:path';
import { cleanupOrphanUploads } from './messages/index.js';
import { auditRoomOrchestratorConfigs, ensureWorkflowRoomReserves } from './workflow/index.js';
import { AgentManager, type AgentDeps } from './runtime/index.js';
import { DbBackup, SoftDeletePurge } from './ops/index.js';
import {
  loadConfig,
  resolveListenHosts,
  openDb,
  createLogger,
  logMessage,
  SseHub,
} from './platform/index.js';
import { VaultClient } from './memory/index.js';
import { ClaudeQuotaPoller, CodexQuotaPoller, GrokQuotaPoller } from './quota/index.js';
import { ensureCodexContact, ensureGrokContact, ensureMuseContact, ensureOpencodeDelegationRunner, ensureRoomOrchestratorCove, seedIfEmpty } from './contacts/index.js';
import { createServer, roomTaskPlumbing } from './server.js';
import { VaultTaskProjection } from './tasks/index.js';
import { JobStore, DeployReceiptPoller } from './jobs/index.js';
import { loadWechatChannelConfig, WechatChannel } from './wechat/index.js';
import { CameraSnapBroker, TaobaoBridge } from './devices/index.js';
import { CompanionHeartbeat } from './heartbeat/index.js';

const logger = createLogger();
const config = loadConfig();
const db = openDb(config.dbPath);
seedIfEmpty(db, config, logger);
ensureCodexContact(db, config, logger);
ensureGrokContact(db, config, logger);
ensureMuseContact(db, config, logger);
ensureOpencodeDelegationRunner(db, logger);
ensureRoomOrchestratorCove(db, logger);
ensureWorkflowRoomReserves(db, logger);
const orphanUploads = cleanupOrphanUploads(db, config.uploadsDir);
if (orphanUploads > 0) logger.info({ component: 'uploads', count: orphanUploads }, 'orphan uploads cleaned');
for (const issue of auditRoomOrchestratorConfigs(db)) {
  logger.error({ component: 'coordination', ...issue }, 'room coordination.orchestrator misconfigured');
}

const sse = new SseHub();
const vault = config.memory.mcpUrl
  ? new VaultClient(config.memory.mcpUrl, db, logMessage(logger, 'vault'), process.env.VAULT_TOKEN ?? null)
  : null;
const taskProjection = vault
  ? new VaultTaskProjection(db, vault, logMessage(logger, 'task-projection'))
  : null;
const jobStore = new JobStore(db, sse);
const deployReceipts = new DeployReceiptPoller(
  jobStore,
  (message, meta) => logger.info({ component: 'deploy-receipt', ...meta }, message),
);
const broker = new CameraSnapBroker(logger);
const taobao = new TaobaoBridge(logger);
const managerDeps: AgentDeps = { db, sse, config, vault, jobStore, broker, taobao, logger,
  workflowPoolBlocked: (runner: string) => jobStore.workflowPoolBlocker(runner) };
const manager = new AgentManager(managerDeps);
// Model-driven task transport (native + MCP tools deliver through this). The
// dispatcher wakes contacts through the manager, so it is built after it; one
// instance is shared by the runtimes (read at turn time) and the HTTP layer.
const roomTasks = roomTaskPlumbing(
  db, sse, manager,
  config.memory.repoPath ? path.join(config.memory.repoPath, 'tasks') : null,
  config.projectTargets,
);
managerDeps.taskDispatch = roomTasks.taskDispatcher;
managerDeps.taskStoreOptions = roomTasks.taskStoreOptions;
const heartbeat = new CompanionHeartbeat({ db, sse, manager, broker, taobao, config, logger });
manager.attachHeartbeat(heartbeat);
const wechatChannel = new WechatChannel({
  config: loadWechatChannelConfig(path.dirname(config.dbPath)),
  db,
  sse,
  manager,
  uploadsDir: config.uploadsDir,
  logger,
});
const dbBackup = new DbBackup(db, config.backup, logMessage(logger, 'backup'));
const softPurge = new SoftDeletePurge(db, config.uploadsDir, config.purge, logMessage(logger, 'purge'));
const quotaPoller = new ClaudeQuotaPoller(logMessage(logger, 'quota.claude'));
const codexQuotaPoller = new CodexQuotaPoller(
  { cliPath: config.codex.cliPath, cwd: config.agentsDir },
  logMessage(logger, 'quota.codex')
);
const grokQuotaPoller = new GrokQuotaPoller(
  logMessage(logger, 'quota.grok'),
  (message, fields) => logger.warn({ component: 'quota.grok', ...fields }, message),
);

const app = createServer({
  config,
  db,
  sse,
  vault,
  jobStore,
  manager,
  heartbeat,
  broker,
  taobao,
  dbBackup,
  softPurge,
  quotaPoller,
  codexQuotaPoller,
  grokQuotaPoller,
  logger,
  wechatChannel,
  hubToken: process.env.HUB_TOKEN,
  corsOrigins: process.env.HUB_CORS_ORIGINS,
  roomTasks,
});
const recoveredRoomDispatches = manager.recoverDeferredRoomDispatches();
if (recoveredRoomDispatches > 0) {
  logger.info(
    { component: 'room-drain', recovered: recoveredRoomDispatches },
    'durable room dispatches recovered after gateway restart',
  );
}

dbBackup.start();
softPurge.start();
quotaPoller.start();
codexQuotaPoller.start();
grokQuotaPoller.start();
deployReceipts.start();
heartbeat.start();
taskProjection?.start();
// Retired: the blocked-job out-of-band auto-resolver (mechanical state
// decisions every 30s). Explicit reconcile/resolve routes stay available;
// the sweep remains callable as a pure explicit verifier.
const outboxBackfilled = jobStore.startOutboxProcessor();
if (outboxBackfilled > 0) {
  logger.info({ component: 'jobs', backfilled: outboxBackfilled }, 'job outbox backfilled terminal jobs missing receipts');
}

// Bind every resolved address (primary + auto loopback + configured extras).
// The first one owns startup side effects; the rest are additional doors to
// the same app, so a same-host client never needs the tailnet address.
const listenHosts = resolveListenHosts(config);
const [primaryHost, ...secondaryHosts] = listenHosts;
const server = app.listen(config.port, primaryHost, () => {
  wechatChannel.start();
  logger.info({
    component: 'gateway',
    host: primaryHost,
    hosts: listenHosts,
    port: config.port,
    dbPath: config.dbPath,
    webDist: fs.existsSync(config.webDist) ? config.webDist : null,
  }, 'ai-hub gateway listening');
});
const secondaryServers = secondaryHosts.map((host) => {
  const extra = app.listen(config.port, host, () => {
    logger.info({ component: 'gateway', host, port: config.port }, 'ai-hub gateway extra listener');
  });
  // A dead secondary must never take the gateway down: the primary address is
  // the contract, extras are convenience (e.g. loopback on a box where ::1 or
  // the tailnet IP is momentarily unavailable at boot).
  extra.on('error', (err) => {
    logger.error({ component: 'gateway', host, port: config.port, err }, 'ai-hub gateway extra listener failed');
  });
  return extra;
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ component: 'gateway', signal }, 'graceful shutdown started');
  server.close();
  for (const extra of secondaryServers) extra.close();
  const wechatStop = wechatChannel.stop();
  heartbeat.stop();
  await manager.stopAll(signal === 'SIGTERM' ? 'deploy-restart' : 'claude-error');
  await wechatStop;
  sse.close();
  dbBackup.stop();
  softPurge.stop();
  codexQuotaPoller.stop();
  grokQuotaPoller.stop();
  deployReceipts.stop();
  taskProjection?.stop();
  jobStore.stopOutboxProcessor();
  await vault?.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ component: 'process', err: reason }, 'unhandled rejection'));
process.on('uncaughtException', (error) => logger.fatal({ component: 'process', err: error }, 'uncaught exception'));
