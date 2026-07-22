import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { cleanupOrphanUploads } from './attachments.js';
import { desktopSessionAuth } from './auth.js';
import { AgentManager } from './agents/manager.js';
import { DbBackup } from './backup.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { SoftDeletePurge } from './purge.js';
import { VaultClient } from './memory/vaultClient.js';
import { ClaudeQuotaPoller } from './quota/claudeQuota.js';
import { CodexQuotaPoller } from './quota/codexQuota.js';
import { GrokQuotaPoller } from './quota/grokQuota.js';
import { contactsRouter } from './routes/contacts.js';
import { attachmentsRouter } from './routes/attachments.js';
import { hubMcpRouter } from './routes/hubMcp.js';
import { messagesRouter } from './routes/messages.js';
import { systemRouter } from './routes/system.js';
import { getUserProfile, userRouter } from './routes/user.js';
import { workersRouter } from './routes/workers.js';
import { seedIfEmpty } from './seed.js';
import { SseHub } from './sse.js';
import { JobStore } from './workers/jobStore.js';

const config = loadConfig();
const db = openDb(config.dbPath);
seedIfEmpty(db, config);
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

function parseDeliveryMeta(raw: string | null): {
  dirtyFiles?: string[];
  head?: string | null;
  ahead?: number | null;
} {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function ensureWorkerTail(job: import('./db.js').JobRow): Promise<void> {
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
    '',
    '### 本地状态',
    files,
    '',
    '### 原始需求',
    job.prompt.slice(0, 6000),
    '',
    '### Worker 回执',
    (job.result || job.error || '（无输出）').slice(0, 8000),
    '',
    '### 下一步',
    '从现有工作区续接，核对改动后完成剩余验证；验证通过再只提交本任务文件并 push。禁止从头派单覆盖本地改动。',
  ].filter((line) => line !== '').join('\n');
  const source = job.requested_by || 'codex';
  try {
    await vault.call('read_file', { path: taskPath }, 0);
    await vault.write('update_task', {
      path: taskPath,
      status: 'open',
      note,
      source,
    });
    console.log(`  [jobs] refreshed ${taskPath}`);
  } catch {
    const outcome = await vault.write('add_task', {
      slug: `worker-tail-${job.id}`,
      title: `Worker 未完成交付 ${job.id.slice(0, 8)}`,
      due: '',
      content: note,
      tags: ['backlog', 'worker-tail', path.basename(job.workspace).toLowerCase()],
      source,
    });
    console.log(`  [jobs] registered ${taskPath} (${outcome})`);
  }
}

// Worker 任务终态 → 给派单的联系人投一条回执消息并触发至多一次 continuation，
// 让它在新回合里验收（不占派单那一回合的 5 分钟 turn timeout）。
jobStore.onFinished = (job) => {
  try {
    void ensureWorkerTail(job).catch((e) => {
      console.error(`  [jobs] worker-tail registration failed for ${job.id}:`, e);
    });
    if (!job.requested_by || job.requested_by === 'user') return;
    const contact = db
      .prepare("SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'")
      .get(job.requested_by) as import('./db.js').ContactRow | undefined;
    if (!contact) return;
    const body = job.result || job.error || '（无输出）';
    const userName = getUserProfile(db).name;
    const text = [
      `⚙ Worker 任务回执（网关自动通知，${userName} 也看得到这条）`,
      `任务 ${job.id} → ${job.status}（runner: ${job.runner}, workspace: ${job.workspace}）`,
      job.delivery_state ? `交付状态：${job.delivery_state}` : '',
      body.slice(0, 6000),
      '',
      '请直接给出验收结论并同步需求账本：以本回执和 worker_job_status 为依据，禁止调用终端/git fetch/VPS 复核。任务范围内验证、commit、push 均完成则 update_task 关闭原 backlog（其他 backlog 的本地改动不算本任务阻塞）；未完成则保持 backlog open 并确认自动登记的 worker-tail 写清 workspace、文件、检查、阻塞与下一步。不要条件反射地从头派新任务。',
    ].filter(Boolean).join('\n');
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

// Android 壳（Capacitor WebView）从 http://localhost 等本地 origin 跨源调 API。
// 只放行 WebView 本地 origin，普通网站的 origin 永远不在名单里；
// 需要扩展时用 HUB_CORS_ORIGINS（逗号分隔）覆盖。
const corsOrigins = new Set(
  (process.env.HUB_CORS_ORIGINS ?? 'http://localhost,https://localhost,capacitor://localhost')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && corsOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        (req.headers['access-control-request-headers'] as string | undefined) ?? 'Content-Type'
      );
      res.setHeader('Access-Control-Max-Age', '86400');
      return res.status(204).end();
    }
  }
  next();
});

app.use(express.json({ limit: '2mb' }));

// Desktop-shell session auth: when HUB_TOKEN is set (Electron spawns us with a
// random token), every request must carry it — first load passes ?token=…,
// which we swap for an httpOnly cookie. Exact worker device and hub-mcp paths
// keep their own Bearer auth and are exempt. Without HUB_TOKEN (web/VPS)
// nothing changes.
const hubToken = process.env.HUB_TOKEN;
if (hubToken) {
  app.use(desktopSessionAuth(hubToken));
}

app.get('/api/health', (_req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
  res.json({ status: 'ok', messageCount: count.c });
});

app.get('/api/events', (req, res) => {
  sse.addClient(res);
  // Reconnect mid-turn: push current busy statuses (with room member names)
  // so the UI never falls back to the room title while waiting for the next setState.
  for (const status of manager.activeStatuses()) {
    sse.send(res, 'status', status);
  }
  req.on('close', () => {});
});

const dbBackup = new DbBackup(db, config.backup, (m) => console.log(`  [backup] ${m}`));
dbBackup.start();

const softPurge = new SoftDeletePurge(
  db,
  config.uploadsDir,
  config.purge,
  (m) => console.log(`  [purge] ${m}`)
);
softPurge.start();

const quotaPoller = new ClaudeQuotaPoller((m) => console.log(`  [quota] ${m}`));
quotaPoller.start();
const codexQuotaPoller = new CodexQuotaPoller(
  { cliPath: config.codex.cliPath, cwd: config.agentsDir },
  (m) => console.log(`  [quota] ${m}`)
);
codexQuotaPoller.start();
const grokQuotaPoller = new GrokQuotaPoller((m) => console.log(`  [quota] ${m}`));
grokQuotaPoller.start();

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
app.get('/api/system/purge', (_req, res) => {
  res.json(softPurge.status());
});
app.post('/api/system/purge', async (req, res) => {
  try {
    const dryRun = req.query.dryRun === '1' || req.body?.dryRun === true;
    const result = await softPurge.runOnce({ dryRun });
    res.json({ ok: true, result, ...softPurge.status() });
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
app.get('/api/quota/grok', (_req, res) => {
  res.json(grokQuotaPoller.get());
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
  softPurge.stop();
  codexQuotaPoller.stop();
  grokQuotaPoller.stop();
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
