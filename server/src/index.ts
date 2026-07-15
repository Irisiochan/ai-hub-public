import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupOrphanUploads } from './attachments.js';
import { AgentManager } from './agents/manager.js';
import { DbBackup } from './backup.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { VaultClient } from './memory/vaultClient.js';
import { ClaudeQuotaPoller } from './quota/claudeQuota.js';
import { CodexQuotaPoller } from './quota/codexQuota.js';
import { contactsRouter } from './routes/contacts.js';
import { attachmentsRouter } from './routes/attachments.js';
import { hubMcpRouter } from './routes/hubMcp.js';
import { messagesRouter } from './routes/messages.js';
import { systemRouter } from './routes/system.js';
import { userRouter } from './routes/user.js';
import { workersRouter } from './routes/workers.js';
import { ensureCodexContact, seedIfEmpty } from './seed.js';
import { SseHub } from './sse.js';
import { JobStore } from './workers/jobStore.js';

const config = loadConfig();
const db = openDb(config.dbPath);
seedIfEmpty(db, config);
ensureCodexContact(db, config);
const orphanUploads = cleanupOrphanUploads(db, config.uploadsDir);
if (orphanUploads > 0) console.log(`  [uploads] cleaned ${orphanUploads} orphan file(s)`);

const sse = new SseHub();
const vault = config.memory.mcpUrl
  ? new VaultClient(
      config.memory.mcpUrl,
      db,
      (m) => console.log(`  [vault] ${m}`),
      process.env.VAULT_TOKEN ?? null
    )
  : null;
const jobStore = new JobStore(db, sse);
const manager = new AgentManager({ db, sse, config, vault, jobStore });

// Worker 任务终态 → 给派单的联系人投一条回执消息并触发至多一次 continuation，
// 让它在新回合里验收（不占派单那一回合的 5 分钟 turn timeout）。
jobStore.onFinished = (job) => {
  try {
    if (!job.requested_by || job.requested_by === 'User') return;
    const contact = db
      .prepare("SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'")
      .get(job.requested_by) as import('./db.js').ContactRow | undefined;
    if (!contact) return;
    const body = job.result || job.error || '（无输出）';
    const text = [
      `⚙ Worker 任务回执（网关自动通知，User 也看得到这条）`,
      `任务 ${job.id} → ${job.status}（runner: ${job.runner}, workspace: ${job.workspace}）`,
      body.slice(0, 6000),
      '',
      '请验收：结果符合预期就简短向 User 汇报；有问题说清楚差在哪。不要条件反射地再派新任务。',
    ].join('\n');
    const result = db
      .prepare(
        `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta)
         VALUES (?, 'system', 'user', 'text', ?, 'done', ?)`
      )
      .run(contact.id, text, JSON.stringify({ event: 'worker-receipt', jobId: job.id }));
    const row = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as import('./db.js').MessageRow;
    sse.broadcast('message', row);
    const queued = manager.get(contact).enqueue({ userMessageId: row.id, text });
    if (queued === 'full') console.log(`  [jobs] ${contact.id} 队列满，回执 ${job.id} 只落库不续接`);
  } catch (e) {
    console.error('  [jobs] onFinished continuation failed:', e);
  }
};

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
  res.json({ status: 'ok', messageCount: count.c });
});

app.get('/api/events', (req, res) => {
  sse.addClient(res);
  req.on('close', () => {});
});

const dbBackup = new DbBackup(db, config.backup, (m) => console.log(`  [backup] ${m}`));
dbBackup.start();

const quotaPoller = new ClaudeQuotaPoller((m) => console.log(`  [quota] ${m}`));
quotaPoller.start();
const codexQuotaPoller = new CodexQuotaPoller(
  { cliPath: config.codex.cliPath, cwd: config.agentsDir },
  (m) => console.log(`  [quota] ${m}`)
);
codexQuotaPoller.start();

app.use('/api/contacts', contactsRouter(db, sse, manager, config));
app.use('/api/contacts', messagesRouter(db, sse, manager, config.uploadsDir));
app.use('/api/attachments', attachmentsRouter(db, config.uploadsDir));
app.use('/api/user', userRouter(db, sse));
app.use('/api', workersRouter(db, sse, jobStore));
app.use('/api', hubMcpRouter(db, jobStore));
app.use('/api', systemRouter(config));
app.get('/api/system/backup', (_req, res) => {
  res.json(dbBackup.status());
});
app.post('/api/system/backup', async (_req, res) => {
  try {
    const file = await dbBackup.runOnce();
    res.json({ ok: true, file, ...dbBackup.status() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/quota/claude', (_req, res) => {
  res.json(quotaPoller.get());
});
app.get('/api/quota/codex', (_req, res) => {
  const q = codexQuotaPoller.get();
  res.json({ available: q !== null, ...(q ?? {}) });
});

// serve built frontend if present (prod single-process mode)
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
}

const server = app.listen(config.port, config.host, () => {
  console.log('');
  console.log('  🍊 ai-hub gateway');
  console.log(`  http://${config.host}:${config.port}`);
  console.log(`  db: ${config.dbPath}`);
  console.log(`  web: ${fs.existsSync(config.webDist) ? config.webDist : '(dev — run vite separately)'}`);
  console.log('');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal} → graceful shutdown`);
  server.close();
  sse.close();
  dbBackup.stop();
  codexQuotaPoller.stop();
  await manager.stopAll();
  await vault?.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// async 路由里的漏网 rejection 不许带崩整个网关
process.on('unhandledRejection', (reason) => {
  console.error('  [unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('  [uncaughtException]', err);
});
