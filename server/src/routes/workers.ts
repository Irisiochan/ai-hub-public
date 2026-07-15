import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import type { Db, JobRow, WorkerRow } from '../db.js';
import type { SseHub } from '../sse.js';
import { ACTIVE_STATUSES, JobStore, LEASE_SECONDS, workspaceAllowed } from '../workers/jobStore.js';

type Capabilities = {
  runners?: string[];
  workspaces?: string[];
  shell?: boolean;
  ssh?: boolean;
};

function json<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function slug(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
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

function publicJob(row: JobRow) {
  return { ...row, permissions: json(row.permissions, {}) };
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

export function workersRouter(db: Db, sse: SseHub, jobs: JobStore): Router {
  const r = Router();

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
    db.prepare(
      `INSERT INTO workers (id, name, token_hash) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash,
       status = 'offline', accepting_jobs = 1, boot_id = NULL, last_seen_at = NULL`
    ).run(id, name, hash(token));
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
    const nextStatus = worker.status === 'busy' ? 'busy' : enabled ? 'online' : 'paused';
    db.prepare('UPDATE workers SET accepting_jobs = ?, status = ? WHERE id = ?')
      .run(enabled ? 1 : 0, nextStatus, worker.id);
    const updated = db.prepare('SELECT * FROM workers WHERE id = ?').get(worker.id) as WorkerRow;
    const payload = publicWorker(updated);
    sse.broadcast('worker', payload);
    res.json(payload);
  });

  r.get('/jobs', (req, res) => {
    jobs.reap();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 300);
    const rows = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as JobRow[];
    res.json({ jobs: rows.map(publicJob) });
  });

  r.get('/jobs/:id', (req, res) => {
    jobs.reap();
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({ job: publicJob(job), messages: jobs.messages(job.id) });
  });

  r.post('/jobs', (req, res) => {
    const runner = req.body?.runner === 'claude' ? 'claude' : req.body?.runner === 'codex' ? 'codex' : '';
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
    });
    if ('error' in created) {
      const code = created.error === 'duplicate idempotency key' ? 409 : 400;
      return res.status(code).json({ error: created.error });
    }
    res.status(201).json(publicJob(created.job));
  });

  r.post('/jobs/:id/action', (req, res) => {
    const outcome = jobs.action(req.params.id, req.body?.action, 'User');
    if ('error' in outcome) {
      return res.status(outcome.error === 'job not found' ? 404 : 409).json({ error: outcome.error });
    }
    res.json({ ok: true, status: outcome.status });
  });

  r.post('/worker/connect', (req, res) => {
    const worker = workerFrom(req, db);
    if (!worker) return res.status(401).json({ error: 'invalid worker token' });
    const caps = req.body?.capabilities && typeof req.body.capabilities === 'object' ? req.body.capabilities : {};
    const bootId = typeof req.body?.bootId === 'string' ? req.body.bootId.trim().slice(0, 200) : '';
    // A manual pause survives reconnects and child-process crashes in the same
    // Windows boot. A genuinely new boot restores the normal auto-start state.
    const newBoot = !!bootId && bootId !== worker.boot_id;
    const acceptingJobs = newBoot ? 1 : worker.accepting_jobs;
    db.prepare(
      `UPDATE workers SET capabilities = ?, status = ?, accepting_jobs = ?,
       boot_id = CASE WHEN ? <> '' THEN ? ELSE boot_id END, last_seen_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(caps), acceptingJobs ? 'online' : 'paused', acceptingJobs, bootId, bootId, worker.id);
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
    const candidates = db.prepare(
      `SELECT * FROM jobs WHERE status = 'pending' AND (worker_id IS NULL OR worker_id = ?)
       ORDER BY priority DESC, created_at ASC LIMIT 50`
    ).all(worker.id) as JobRow[];
    for (const job of candidates) {
      const perms = json<{ shell?: boolean; ssh?: boolean }>(job.permissions, {});
      if (!runners.includes(job.runner) || !workspaceAllowed(job.workspace, roots)) continue;
      if (perms.shell && !caps.shell || perms.ssh && !caps.ssh) continue;
      const result = db.prepare(
        `UPDATE jobs SET worker_id = ?, status = 'claimed', lease_until = datetime('now', ?),
         updated_at = datetime('now') WHERE id = ? AND status = 'pending'`
      ).run(worker.id, `+${LEASE_SECONDS} seconds`, job.id);
      if (result.changes) {
        jobs.addMessage(job.id, worker.id, 'state', 'Worker 已认领任务');
        jobs.emitJob(job.id);
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
        db.prepare("UPDATE workers SET status = 'paused', last_seen_at = datetime('now') WHERE id = ?").run(worker.id);
        return res.json({ job: null, acceptingJobs: false });
      }
      db.prepare("UPDATE workers SET status = 'online', last_seen_at = datetime('now') WHERE id = ?").run(worker.id);
      const job = tryClaim(worker);
      if (job) return res.json({ job: publicJob(job), acceptingJobs: true, leaseSeconds: LEASE_SECONDS });
      if (Date.now() >= deadline) return res.json({ job: null, acceptingJobs: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
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
    res.json({ ok: true });
  });

  r.post('/worker/jobs/:id/heartbeat', (req, res) => {
    const worker = workerFrom(req, db);
    if (!worker) return res.status(401).json({ error: 'invalid worker token' });
    const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND worker_id = ?').get(req.params.id, worker.id) as JobRow | undefined;
    if (!job) return res.status(404).json({ error: 'job not found' });
    db.prepare("UPDATE workers SET status = 'busy', last_seen_at = datetime('now') WHERE id = ?").run(worker.id);
    if (ACTIVE_STATUSES.has(job.status)) {
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
    const status = jobs.complete(job, req.body?.status, result, error);
    const fresh = db.prepare('SELECT accepting_jobs FROM workers WHERE id = ?').get(worker.id) as { accepting_jobs: number };
    db.prepare("UPDATE workers SET status = ?, last_seen_at = datetime('now') WHERE id = ?")
      .run(fresh.accepting_jobs === 1 ? 'online' : 'paused', worker.id);
    res.json({ ok: true, status });
  });

  return r;
}
