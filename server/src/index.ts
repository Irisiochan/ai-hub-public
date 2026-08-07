import fs from 'node:fs';
import path from 'node:path';
import { cleanupOrphanUploads } from './attachments.js';
import { AgentManager } from './agents/manager.js';
import { DbBackup } from './backup.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createLogger, logMessage } from './logger.js';
import { VaultClient } from './memory/vaultClient.js';
import { SoftDeletePurge } from './purge.js';
import { ClaudeQuotaPoller } from './quota/claudeQuota.js';
import { CodexQuotaPoller } from './quota/codexQuota.js';
import { GrokQuotaPoller } from './quota/grokQuota.js';
import { ensureCodexContact, ensureGrokContact, seedIfEmpty } from './seed.js';
import { createServer } from './server.js';
import { SseHub } from './sse.js';
import { JobStore } from './workers/jobStore.js';
import { DeployReceiptPoller } from './workers/deployReceipt.js';
import { loadWechatChannelConfig } from './wechat/config.js';
import { WechatChannel } from './wechat/channel.js';

const logger = createLogger();
const config = loadConfig();
const db = openDb(config.dbPath);
seedIfEmpty(db, config, logger);
ensureCodexContact(db, config, logger);
ensureGrokContact(db, config, logger);
const orphanUploads = cleanupOrphanUploads(db, config.uploadsDir);
if (orphanUploads > 0) logger.info({ component: 'uploads', count: orphanUploads }, 'orphan uploads cleaned');

const sse = new SseHub();
const vault = config.memory.mcpUrl
  ? new VaultClient(config.memory.mcpUrl, db, logMessage(logger, 'vault'), process.env.VAULT_TOKEN ?? null)
  : null;
const jobStore = new JobStore(db, sse);
const deployReceipts = new DeployReceiptPoller(
  jobStore,
  (message, meta) => logger.info({ component: 'deploy-receipt', ...meta }, message),
);
const manager = new AgentManager({ db, sse, config, vault, jobStore, logger });
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
const grokQuotaPoller = new GrokQuotaPoller(logMessage(logger, 'quota.grok'));

const app = createServer({
  config,
  db,
  sse,
  vault,
  jobStore,
  manager,
  dbBackup,
  softPurge,
  quotaPoller,
  codexQuotaPoller,
  grokQuotaPoller,
  logger,
  wechatChannel,
  hubToken: process.env.HUB_TOKEN,
  corsOrigins: process.env.HUB_CORS_ORIGINS,
});

dbBackup.start();
softPurge.start();
quotaPoller.start();
codexQuotaPoller.start();
grokQuotaPoller.start();
deployReceipts.start();
jobStore.startOutOfBandResolver();

const server = app.listen(config.port, config.host, () => {
  wechatChannel.start();
  logger.info({
    component: 'gateway',
    host: config.host,
    port: config.port,
    dbPath: config.dbPath,
    webDist: fs.existsSync(config.webDist) ? config.webDist : null,
  }, 'ai-hub gateway listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ component: 'gateway', signal }, 'graceful shutdown started');
  server.close();
  const wechatStop = wechatChannel.stop();
  await manager.stopAll();
  await wechatStop;
  sse.close();
  dbBackup.stop();
  softPurge.stop();
  codexQuotaPoller.stop();
  grokQuotaPoller.stop();
  deployReceipts.stop();
  jobStore.stopOutOfBandResolver();
  await vault?.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ component: 'process', err: reason }, 'unhandled rejection'));
process.on('uncaughtException', (error) => logger.fatal({ component: 'process', err: error }, 'uncaught exception'));
