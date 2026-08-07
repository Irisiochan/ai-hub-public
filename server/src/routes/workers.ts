import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import type { Db, JobRow, WorkerRow } from '../db.js';
import type { SseHub } from '../sse.js';
import {
  ACTIVE_STATUSES,
  JobStore,
  LEASE_SECONDS,
  normalizeWorkspace,
  workspaceAllowed,
} from '../workers/jobStore.js';
import { publicJob } from '../workers/deliveryStatus.js';
import type { HubLogger } from '../logger.js';

// jobs.deleted = 1 is presentation soft-delete; claim/list hide those rows.

type Capabilities = {
  runners?: string[];
  workspaces?: string[];
  shell?: boolean;
  ssh?: boolean;
  maxConcurrent?: number;
  protocolVersion?: number;
};

const BLOCKED_RECONCILE_GRACE_MS = 10 * 60_000;
const WORKER_PROTOCOL_VERSION = 2;
const DELIVERY_CONTRACT = [
  'Delivery is not complete merely because the agent process exits successfully.',
  'For write tasks, run the requested validation and commit/push only when it passes.',
  'When the job has SSH permission and validation passes, the dispatch pre-authorizes commit, push, deploy, target-service restart, and post-deploy verification in one pass.',
  'Do not file a deploy-tail instead of performing an in-scope deployment that this job can safely complete.',
  'Still require explicit owner approval for: skipped or failing validation, irreversible data actions (data deletion, destructive migrations, production rollback, history rewrite, force push), creating or switching branches, credential or access expansion, product-scope decisions, and outbound messages to third parties.',
  'Never restart the process hosting this job (the PC worker service or the ai-hub gateway this job depends on) before the outcome is reported; file a deploy-tail for that instead.',
  'If SSH permission is absent but remote deployment is required, file one deploy-tail with the exact host, checkout, service, and verification steps.',
  'If your host safety policy asks for an exact push or deploy target, list the full repo URL, branch, deploy host, and service in one request and continue after confirmation. If the job must end while confirmation is pending, file one deploy-tail marked awaiting_exact_target_approval; do not misreport it as a code or validation failure.',
  'If validation, commit, push, or deploy is blocked, leave a precise handoff: changed files, checks passed/failed, blocker, and next step.',
  'For a write task, finish with a machine-readable JSON object: {"delivery":{"committed":true|false,"pushed":true|false,"stage":"delivered_waiting_deploy|online_waiting_validation|closed_loop|user_decision","summary":"one human sentence","nextOwner":"unique owner"}}. It may be a standalone line or a fenced/multiline JSON block.',
  'Use stage closed_loop only when every required validation including production post-deploy evidence is complete; otherwise choose the exact earlier stage. Use user_decision only for a real authorization or product choice and include blocker when useful.',
  'Use false/false only when requested changes remain uncommitted; omit this line for read-only tasks.',
].join(' ');

function json<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function sqliteUtcMillis(value: string): number {
  const normalized = /(?:z|[+-]\d\d:\d\d)$/i.test(value.trim())
    ? value.trim()
    : `${value.trim().replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function slug(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

function workspaceKey(value: string): string {
  const normalized = normalizeWorkspace(value);
  return /^[a-z]:\\/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function publicWorker(row: WorkerRow) {
  const seen = row.last_seen_at ? new Date(`${row.last_seen_at}Z`).getTime() : 0;
  return {
    id: row.id,
    name: row.name,
    capabilities: json<Capabilities>(row.capabilities, {}),
    status: seen && Date.now() - seen < 70_000 ? row.status : 'offline',
    acceptingJobs: row.accepting_jobs === 1,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
  };
}

function workerFrom(req: Request, db: Db): WorkerRow | null {
  const auth = req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as WorkerRow | undefined;
  if (!worker) return null;
  const actual = Buffer.from(hash(token));
  const expected = Buffer.from(worker.token_hash);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected) ? worker : null;
}

export function workersRouter(db: Db, sse: SseHub, jobs: JobStore, logger?: HubLogger): Router {
  const r = Router();
  const logAcceptance = (workerId: string, from: number, to: number, actor: string, reason: string): void => {
    if (from === to) return;
    logger?.info(
      { component: 'workers', workerId, actor, from: from === 1, to: to === 1 },
      `worker ${workerId} accepting_jobs ${from === 1 ? 'on' : 'off'} → ${to === 1 ? 'on' : 'off'} (${reason})`
    );
  };
  const activeRows = (workerId: string): JobRow[] => db.prepare(
    `SELECT * FROM jobs
     WHERE worker_id = ? AND status IN ('claimed','running','recovering','pause_requested','cancel_requested')`
  ).all(workerId) as JobRow[];
  const updateWorkerRuntimeStatus = (workerId: string, touch = true): void => {
    const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId) as WorkerRow;
    const status = activeRows(workerId).length > 0
      ? 'busy'
      : worker.accepting_jobs === 1 ? 'online' : 'paused';
    db.prepare(
      `UPDATE workers SET status = ?${touch ? ", last_seen_at = datetime('now')" : ''} WHERE id = ?`
    ).run(status, workerId);
  };

  r.get('/workers', (_req, res) => {
    jobs.reap();
    const workers = db.prepare('SELECT * FROM workers ORDER BY created_at').all() as WorkerRow[];
    res.json({ workers: workers.map(publicWorker) });
  });

  r.post('/workers', (req, res) => {
    const id = slug(req.body?.id || req.body?.name);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!id || !name) return res.status(400).json({ error: 'worker id/name required' });
    const token = `${id}.${crypto.randomBytes(32).toString('base64url')}`;
    const prior = db.prepare('SELECT accepting_jobs FROM workers WHERE id = ?').get(id) as
      | Pick<WorkerRow, 'accepting_jobs'>
      | undefined;
    db.prepare(
      `INSERT INTO workers (id, name, token_hash) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash,
       status = 'offline', accepting_jobs = 1, boot_id = NULL, last_seen_at = NULL`
    ).run(id, name, hash(token));
    if (prior) logAcceptance(id, prior.accepting_jobs, 1, 'User', 're-pair reset');
    const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(id) as WorkerRow;
    res.status(201).json({ worker: publicWorker(worker), token });
  });

  // 只允许删掉线且从未被任务引用的 worker（配对失误的废行）；有历史任务的留着做审计
  r.delete('/workers/:id', (req, res) => {
    jobs.reap();
    const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.params.id) as WorkerRow | undefined;
    if (!worker) return res.status(404).json({ error: 'worker not found' });
    if (publicWorker(worker).status !== 'offline') {
      return res.status(409).json({ error: 'worker 在线，先停掉它再删' });
    }
    const referenced = db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE worker_id = ?').get(worker.id) as { c: number };
    if (referenced.c > 0) {
      return res.status(409).json({ error: `有 ${referenced.c} 条历史任务引用这个 worker，保留作审计` });
    }
    db.prepare('DELETE FROM workers WHERE id = ?').run(worker.id);
    res.json({ ok: true });
  });

  r.post('/workers/:id/control', (req, res) => {
    const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(req.params.id) as WorkerRow | undefined;
    if (!worker) return res.status(404).json({ error: 'worker not found' });
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled boolean required' });
    }
    const enabled = req.body.enabled === true;
    db.prepare('UPDATE workers SET accepting_jobs = ? WHERE id = ?')
      .run(enabled ? 1 : 0, worker.id);
    logAcceptance(worker.id, worker.accepting_jobs, enabled ? 1 : 0, 'User', 'panel control');
    updateWorkerRuntimeStatus(worker.id, false);
    const updated = db.prepare('SELECT * FROM workers WHERE id = ?').get(worker.id) as WorkerRow;
    const payload = publicWorker(updated);
    sse.broadcast('worker', payload);
    res.json(payload);
  });

  r.get('/jobs', (req, res) => {
    jobs.reap();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);
    const rows = db
      .prepare('SELECT * FROM jobs WHERE deleted = 0 ORDER BY created_at DESC LIMIT ?')
      .all(limit) as JobRow[];
    res.json({ jobs: rows.map(publicJob) });
  });

  r.get('/jobs/:id', (req, res) => {
    jobs.reap();
    const job = jobs.get(req.params.id);
    if (!job || job.deleted === 1) return res.status(404).json({ error: 'job not found' });
    res.json({ job: publicJob(job), messages: jobs.messages(job.id) });
  });

  /**
   * Soft-delete / hide a job window (presentation layer). Not a hard delete.
   * Active jobs need force=true after UI confirmation that the worker may continue.
   */
  r.delete('/jobs/:id', (req, res) => {
    const force =
      req.body?.force === true ||
      req.query.force === '1' ||
      req.query.force === 'true';
    const outcome = jobs.softDelete(req.params.id, 'User', { force });
    if ('error' in outcome) {
      return res.status(outcome.code).json({ error: outcome.error });
    }
    res.json({ ok: true, job: publicJob(outcome.job) });
  });

  r.post('/jobs', (req, res) => {
    const runner = ['claude', 'codex', 'grok'].includes(req.body?.runner) ? req.body.runner : '';
    if (!runner) return res.status(400).json({ error: 'runner/workspace/prompt required' });
    const created = jobs.create({
      requestedBy: typeof req.body?.requestedBy === 'string' ? req.body.requestedBy : 'User',
      runner,
      workspace: typeof req.body?.workspace === 'string' ? req.body.workspace : '',
      prompt: typeof req.body?.prompt === 'string' ? req.body.prompt : '',
      workerId: typeof req.body?.workerId === 'string' && req.body.workerId ? req.body.workerId : null,
      priority: Number(req.body?.priority) || 0,
      ttlMinutes: Number(req.body?.ttlMinutes) || undefined,
      idempotencyKey:
        typeof req.body?.idempotencyKey === 'string' && req.body.idempotencyKey
          ? req.body.idempotencyKey
          : undefined,
      permissions: {
        write: req.body?.permissions?.write !== false,
        shell: req.body?.permissions?.shell === true,
        ssh: req.body?.permissions?.ssh === true,
      },
      originContactId:
        typeof req.body?.originContactId === 'string' && req.body.originContactId
          ? req.body.originContactId
          : null,
      originAnchorId:
        Number.isSafeInteger(req.body?.originAnchorId) && req.body.originAnchorId > 0
          ? req.body.originAnchorId
          : null,
    });
    if ('error' in created) {
      const code = created.error === 'duplicate idempotency key' ? 409 : 400;
      return res.status(code).json({ error: created.error });
    }
    res.status(201).json(publicJob(created.job));
  });

  r.post('/jobs/:id/action', (req, res) => {
    const existing = jobs.get(req.params.id);
    if (!existing || existing.deleted === 1) {
      return res.status(404).json({ error: 'job not found' });
    }
    const outcome = jobs.action(req.params.id, req.body?.action, 'User');
    if ('error' in outcome) {
      return res.status(outcome.error === 'job not found' ? 404 : 409).json({ error: outcome.error });
    }
    res.json({ ok: true, status: outcome.status });
  });

  r.post('/jobs/:id/resolve-out-of-band', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.deleted === 1) return res.status(404).json({ error: 'job not found' });
    const outcome = jobs.resolveBlockedOutOfBand(job, 'User', { mode: 'manual' });
    if ('error' in outcome) return res.status(409).json({ error: outcome.error });
    res.json({ ok: true, job: publicJob(outcome.job) });
  });

  r.patch('/jobs/:id/delivery', (req, res) => {
    const existing = jobs.get(req.params.id);
    if (!existing || existing.deleted === 1) {
      return res.status(404).json({ error: 'job not found' });
    }
    const stage = typeof req.body?.stage === 'string' ? req.body.stage : '';
    const outcome = jobs.updateDelivery(existing.id, 'User', {
      stage,
      summary: typeof req.body?.summary === 'string' ? req.body.summary : undefined,
      nextOwner: typeof req.body?.nextOwner === 'string' ? req.body.nextOwner : undefined,
      blocker: typeof req.body?.blocker === 'string' ? req.body.blocker : undefined,
    });
    if ('error' in outcome) {
      return res.status(outcome.error === 'job not found' ? 404 : 409).json({ error: outcome.error });
    }
    res.json({ ok: true, job: publicJob(outcome.job) });
  });

  r.post('/worker/connect', (req, res) => {
    const worker = workerFrom(req, db);
    if (!worker) return res.status(401).json({ error: 'invalid worker token' });
    const caps = req.body?.capabilities && typeof req.body.capabilities === 'object' ? req.body.capabilities : {};
    const bootId = typeof req.body?.bootId === 'string' ? req.body.bootId.trim().slice(0, 200) : '';
    // A manual pause is durable user intent: reconnects, child restarts, and even
    // a new Windows boot must NOT silently resume claiming. Only the panel's
    // explicit resume (/workers/:id/control) turns acceptance back on.
    // boot_id is kept for diagnostics only: a bootId that keeps flipping between
    // two values means two worker processes are alive against one worker row
    // (the 2026-08-06 pause-doesn't-stick incident).
    if (!!bootId && !!worker.boot_id && bootId !== worker.boot_id) {
      logger?.info(
        { component: 'workers', workerId: worker.id, from: worker.boot_id, to: bootId },
        `worker ${worker.id} bootId changed; if this repeats every few seconds, two worker processes are running`
      );
    }
    db.prepare(
      `UPDATE workers SET capabilities = ?,
       boot_id = CASE WHEN ? <> '' THEN ? ELSE boot_id END, last_seen_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(caps), bootId, bootId, worker.id);
    updateWorkerRuntimeStatus(worker.id);
    const updated = db.prepare('SELECT * FROM workers WHERE id = ?').get(worker.id) as WorkerRow;
    sse.broadcast('worker', publicWorker(updated));
    res.json({ worker: publicWorker(updated), leaseSeconds: LEASE_SECONDS });
  });

  const tryClaim = (worker: WorkerRow): JobRow | null => {
    jobs.reap();
    const fresh = db.prepare('SELECT * FROM workers WHERE id = ?').get(worker.id) as WorkerRow;
    if (fresh.accepting_jobs !== 1) return null;
    const caps = json<Capabilities>(fresh.capabilities, {});
    const runners = Array.isArray(caps.runners) ? caps.runners : [];
    const roots = Array.isArray(caps.workspaces) ? caps.workspaces : [];
    const maxConcurrent = Math.min(Math.max(Number(caps.maxConcurrent) || 1, 1), 8);
    const active = activeRows(worker.id);
    if (active.length >= maxConcurrent) return null;
    const lockedWorkspaces = new Set(active.map((job) => workspaceKey(job.workspace)));
    const candidates = db.prepare(
      `SELECT * FROM jobs WHERE deleted = 0 AND status = 'pending' AND (worker_id IS NULL OR worker_id = ?)
       ORDER BY priority DESC, created_at ASC LIMIT 50`
    ).all(worker.id) as JobRow[];
    for (const job of candidates) {
      const perms = json<{ shell?: boolean; ssh?: boolean }>(job.permissions, {});
      if (!runners.includes(job.runner) || !workspaceAllowed(job.workspace, roots)) continue;
      if (perms.shell && !caps.shell || perms.ssh && !caps.ssh) continue;
      if (lockedWorkspaces.has(workspaceKey(job.workspace))) continue;
      const result = db.prepare(
        `UPDATE jobs SET worker_id = ?, status = 'claimed', lease_until = datetime('now', ?),
         updated_at = datetime('now') WHERE id = ? AND status = 'pending'`
      ).run(worker.id, `+${LEASE_SECONDS} seconds`, job.id);
      if (result.changes) {
        jobs.addMessage(job.id, worker.id, 'state', 'Worker 已认领任务');
        jobs.emitJob(job.id);
        updateWorkerRuntimeStatus(worker.id);
        return jobs.get(job.id)!;
      }
    }
    return null;
  };

  r.get('/worker/claim', async (req, res) => {
    const worker = workerFrom(req, db);
    if (!worker) return res.status(401).json({ error: 'invalid worker token' });
    const deadline = Date.now() + Math.min(Math.max(Number(req.query.wait) || 20, 0), 25) * 1000;
    let closed = false;
    req.on('close', () => { closed = true; });
    while (!closed) {
      const current = db.prepare('SELECT * FROM workers WHERE id = ?').get(worker.id) as WorkerRow;
      if (current.accepting_jobs !== 1) {
        updateWorkerRuntimeStatus(worker.id);
        return res.json({ job: null, acceptingJobs: false });
      }
      updateWorkerRuntimeStatus(worker.id);
      const job = tryClaim(worker);
      if (job) {
        return res.json({
          job: publicJob(job),
          acceptingJobs: true,
          leaseSeconds: LEASE_SECONDS,
          protocolVersion: WORKER_PROTOCOL_VERSION,
          deliveryContract: DELIVERY_CONTRACT,
        });
      }
      if (Date.now() >= deadline) return res.json({ job: null, acceptingJobs: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  r.get('/worker/reconcile', (req, res) => {
    const worker = workerFrom(req, db);
    if (!worker) return res.status(401).json({ error: 'invalid worker token' });
    const rows = db.prepare(
      `SELECT * FROM jobs
       WHERE worker_id = ? AND status = 'blocked'
       AND delivery_state IN ('blocked_local_changes', 'blocked_unpushed')
       ORDER BY updated_at ASC LIMIT 50`
    ).all(worker.id) as JobRow[];
    res.json({ jobs: rows.map(publicJob) });
  });

  r.post('/worker/jobs/:id/reconcile', (req, res) => {
    const worker = workerFrom(req, db);
    if (!worker) return res.status(401).json({ error: 'invalid worker token' });
    const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND worker_id = ?')
      .get(req.params.id, worker.id) as JobRow | undefined;
    if (!job) return res.status(404).json({ error: 'job not found' });
    const head = typeof req.body?.head === 'string' ? req.body.head.trim() : '';
    const evidence = req.body?.evidence && typeof req.body.evidence === 'object'
      ? req.body.evidence as Record<string, unknown>
      : null;
    const blockedAtMs = sqliteUtcMillis(job.updated_at);
    const serverBlockedForMs = Number.isFinite(blockedAtMs)
      ? Math.max(Date.now() - blockedAtMs, 0)
      : 0;
    const historyEvidence = evidence?.ancestorIncluded === true;
    const staleFallback = evidence?.staleFallback === true
      && serverBlockedForMs >= BLOCKED_RECONCILE_GRACE_MS;
    if (
      !/^[0-9a-f]{7,64}$/i.test(head)
      || evidence?.dirty !== false
      || evidence?.ahead !== 0
      || (!historyEvidence && !staleFallback)
    ) {
      return res.status(400).json({ error: 'clean synchronized git evidence required' });
    }
    const previous = json<Record<string, unknown>>(job.delivery_meta ?? '', {});
    const previousDeclared = previous.declared && typeof previous.declared === 'object'
      && !Array.isArray(previous.declared)
      ? previous.declared as Record<string, unknown>
      : {};
    const permissions = json<{ write?: boolean }>(job.permissions, {});
    const blockedHead = typeof previous.head === 'string' ? previous.head : '';
    if (
      !/^[0-9a-f]{7,64}$/i.test(blockedHead)
      || evidence.blockedHead !== blockedHead
    ) {
      return res.status(400).json({ error: 'evidence does not match blocked delivery' });
    }
    const deliveryMeta = JSON.stringify({
      ...previous,
      state: 'delivered',
      reconciledAt: new Date().toISOString(),
      reconciliation: {
        ...evidence,
        head,
        serverBlockedForMs,
        mode: staleFallback ? 'clean-timeout-fallback' : 'git-history',
      },
      declared: {
        ...previousDeclared,
        stage: permissions.write === false ? 'closed_loop' : 'delivered_waiting_deploy',
        summary: permissions.write === false
          ? '只读任务已完成，结论与证据已经交付。'
          : '外部续接已完成提交和推送，尚未收到部署完成证据。',
        nextOwner: permissions.write === false ? '无需后续动作' : '部署负责人',
      },
    }).slice(0, 100_000);
    const outcome = jobs.reconcileBlocked(job, worker.id, deliveryMeta, head);
    if ('error' in outcome) return res.status(409).json({ error: outcome.error });
    db.prepare("UPDATE workers SET last_seen_at = datetime('now') WHERE id = ?").run(worker.id);
    res.json({ ok: true, status: outcome.status });
  });

  r.post('/worker/jobs/:id/recover', (req, res) => {
    const worker = workerFrom(req, db);
    if (!worker) return res.status(401).json({ error: 'invalid worker token' });
    const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND worker_id = ?')
      .get(req.params.id, worker.id) as JobRow | undefined;
    if (!job) return res.status(404).json({ error: 'job not found' });
    const action = job.status === 'cancel_requested'
      ? 'cancel'
      : job.status === 'pause_requested' ? 'pause' : 'continue';
    if (action !== 'continue') return res.json({ ok: true, action, status: job.status });
    if (!['claimed', 'running', 'recovering'].includes(job.status)) {
      return res.status(409).json({ error: `cannot recover from ${job.status}` });
    }
    const mode = req.body?.mode === 'reattach'
      ? 'reattach'
      : req.body?.mode === 'restart' ? 'restart' : 'resume';
    const sessionId = typeof req.body?.sessionId === 'string'
      && /^[a-zA-Z0-9_-]{1,128}$/.test(req.body.sessionId)
      ? req.body.sessionId
      : null;
    const result = db.prepare(
      `UPDATE jobs SET status = 'running', lease_until = datetime('now', ?),
       session_id = COALESCE(?, session_id), error = NULL, updated_at = datetime('now')
       WHERE id = ? AND worker_id = ? AND status IN ('claimed','running','recovering')`
    ).run(`+${LEASE_SECONDS} seconds`, sessionId, job.id, worker.id);
    if (!result.changes) return res.status(409).json({ error: 'job changed before recovery' });
    jobs.addMessage(
      job.id,
      worker.id,
      'state',
      mode === 'reattach'
        ? `Worker 重启恢复：重新接管仍存活的 runner PID ${Number(req.body?.childPid) || 'unknown'}`
        : mode === 'restart'
          ? 'Worker 重启恢复：任务尚未启动，重新开始 runner'
          : `Worker 重启恢复：续接 CLI session ${sessionId ?? job.session_id ?? 'unknown'}`
    );
    jobs.emitJob(job.id);
    updateWorkerRuntimeStatus(worker.id);
    res.json({ ok: true, action: 'continue', status: 'running' });
  });

  r.post('/worker/jobs/:id/start', (req, res) => {
    const worker = workerFrom(req, db);
    if (!worker) return res.status(401).json({ error: 'invalid worker token' });
    const result = db.prepare(
      `UPDATE jobs SET status = 'running', lease_until = datetime('now', ?), updated_at = datetime('now')
       WHERE id = ? AND worker_id = ? AND status = 'claimed'`
    ).run(`+${LEASE_SECONDS} seconds`, req.params.id, worker.id);
    if (!result.changes) return res.status(409).json({ error: 'job is not claimed by this worker' });
    jobs.addMessage(req.params.id, worker.id, 'state', '开始执行');
    jobs.emitJob(req.params.id);
    updateWorkerRuntimeStatus(worker.id);
    res.json({ ok: true });
  });

  r.post('/worker/jobs/:id/heartbeat', (req, res) => {
    const worker = workerFrom(req, db);
    if (!worker) return res.status(401).json({ error: 'invalid worker token' });
    const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND worker_id = ?').get(req.params.id, worker.id) as JobRow | undefined;
    if (!job) return res.status(404).json({ error: 'job not found' });
    updateWorkerRuntimeStatus(worker.id);
    if (job.status === 'recovering') {
      db.prepare(
        `UPDATE jobs SET status = 'running', error = NULL, lease_until = datetime('now', ?),
         updated_at = datetime('now') WHERE id = ?`
      ).run(`+${LEASE_SECONDS} seconds`, job.id);
      jobs.emitJob(job.id);
    } else if (ACTIVE_STATUSES.has(job.status)) {
      db.prepare("UPDATE jobs SET lease_until = datetime('now', ?), updated_at = datetime('now') WHERE id = ?")
        .run(`+${LEASE_SECONDS} seconds`, job.id);
    }
    const action = job.status === 'cancel_requested' ? 'cancel' : job.status === 'pause_requested' ? 'pause' : 'continue';
    res.json({ action, status: job.status });
  });

  r.post('/worker/jobs/:id/events', (req, res) => {
    const worker = workerFrom(req, db);
    if (!worker) return res.status(401).json({ error: 'invalid worker token' });
    const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND worker_id = ?').get(req.params.id, worker.id) as JobRow | undefined;
    if (!job || ['cancelled', 'expired'].includes(job.status)) return res.status(409).json({ error: 'job no longer accepts events' });
    const kind = typeof req.body?.kind === 'string' ? req.body.kind.slice(0, 40) : 'log';
    const content = typeof req.body?.content === 'string' ? req.body.content : JSON.stringify(req.body?.content ?? '');
    if (kind === 'session' && typeof req.body?.meta?.sessionId === 'string') {
      db.prepare("UPDATE jobs SET session_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(req.body.meta.sessionId, job.id);
    }
    const row = jobs.addMessage(job.id, worker.id, kind, content, req.body?.meta ?? {});
    res.status(201).json(row);
  });

  r.post('/worker/jobs/:id/complete', (req, res) => {
    const worker = workerFrom(req, db);
    if (!worker) return res.status(401).json({ error: 'invalid worker token' });
    const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND worker_id = ?').get(req.params.id, worker.id) as JobRow | undefined;
    if (!job) return res.status(404).json({ error: 'job not found' });
    const result = typeof req.body?.result === 'string' ? req.body.result.slice(0, 500_000) : null;
    const error = typeof req.body?.error === 'string' ? req.body.error.slice(0, 20_000) : null;
    const delivery = req.body?.delivery && typeof req.body.delivery === 'object'
      ? req.body.delivery as Record<string, unknown>
      : null;
    const allowedDeliveryStates = new Set([
      'delivered',
      'blocked_local_changes',
      'blocked_unpushed',
      'failed_clean',
      'unknown',
    ]);
    const deliveryState = delivery && allowedDeliveryStates.has(String(delivery.state))
      ? String(delivery.state)
      : null;
    const deliveryMeta = delivery ? JSON.stringify(delivery).slice(0, 100_000) : null;
    const outcome = jobs.complete(job, req.body?.status, result, error, deliveryState, deliveryMeta);
    if ('error' in outcome) return res.status(409).json({ error: outcome.error });
    updateWorkerRuntimeStatus(worker.id);
    res.json({ ok: true, status: outcome.status });
  });

  return r;
}
