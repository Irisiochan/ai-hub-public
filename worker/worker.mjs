import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  classifyDelivery,
  deliveryCompletesJob,
  DEFAULT_RECONCILE_GRACE_MS,
  extractDeliveryDeclaration,
  isGitAncestor,
  reconciliationDecision,
  repoDeliveryEvidence,
  snapshotRepo,
} from './delivery.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { buildRunnerSpec, supportsResume } from './runner.mjs';
import { loadState, saveWorkerSpool } from './state-store.mjs';

// The stateful Windows launcher runs hidden, so persist worker stdout/stderr here.
// Timestamps are deliberately rendered in Asia/Shanghai, independent of device timezone.
const logFile = process.env.AI_HUB_WORKER_LOG;
if (logFile) {
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const stamp = () => new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
  const append = (level, values) => {
    const text = values.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).join(' ');
    fs.appendFileSync(logFile, `[${stamp()} +08:00] ${level} ${text}\n`, 'utf8');
  };
  console.log = (...values) => { append('INFO', values); originalLog(...values); };
  console.error = (...values) => { append('ERROR', values); originalError(...values); };
}

const configPath = path.resolve(process.argv[2] ?? 'config.json');
if (!fs.existsSync(configPath)) {
  console.error(`Missing ${configPath}; copy config.example.json to config.json first.`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const statePath = path.resolve(path.dirname(configPath), cfg.stateFile ?? 'worker-state.json');
const base = String(cfg.serverUrl ?? '').replace(/\/$/, '');
if (!base || !cfg.token) throw new Error('serverUrl/token required');
const maxConcurrent = Math.min(Math.max(Number(cfg.maxConcurrent) || 1, 1), 8);
const eventFlushIntervalMs = Math.max(
  Number(process.env.AI_HUB_WORKER_EVENT_FLUSH_MS) || 15_000,
  100
);
const workspaceEntries = (cfg.workspaces ?? []).flatMap((entry) => {
  if (typeof entry === 'string' && entry.trim()) {
    return [{ path: entry, deliveryMode: 'git-check' }];
  }
  if (entry && typeof entry === 'object' && typeof entry.path === 'string' && entry.path.trim()) {
    return [{
      path: entry.path,
      deliveryMode: entry.deliveryMode === 'trust-cli' ? 'trust-cli' : 'git-check',
    }];
  }
  return [];
});

const auth = { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' };

// Two live worker processes against one worker row ping-pong the gateway's
// boot_id and double-claim capacity (2026-08-06 pause-doesn't-stick incident).
// Atomic 'wx' acquire + heartbeat lease lives in instance-lock.mjs; stale
// crash leftovers self-expire, so no manual lock deletion in the normal path.
// `${statePath}.lock` is taken by the state-store's short-lived write lease.
const lockPath = `${statePath}.instance.lock`;
const instanceLock = acquireInstanceLock(lockPath);
if (!instanceLock.acquired) {
  const holder = instanceLock.holder ?? {};
  console.error(
    `another PC Worker (pid ${holder.pid ?? 'unknown'}, since ${holder.startedAt ?? 'unknown'}) already uses ${statePath}; ` +
    `exiting. A crashed holder expires by itself within its lease; only delete ${lockPath} if you are sure no worker is running.`
  );
  process.exit(3);
}
const instanceLockHeartbeat = setInterval(() => {
  try {
    if (instanceLock.refresh()) return;
    console.error('instance lock was taken over by another worker process; exiting to avoid double-claiming');
    process.exit(3);
  } catch (error) {
    console.error(`instance lock heartbeat failed: ${error.message}`);
  }
}, 10_000);
instanceLockHeartbeat.unref();
process.on('exit', () => {
  clearInterval(instanceLockHeartbeat);
  instanceLock.release();
});
const estimatedBootMs = Date.now() - os.uptime() * 1000;
const bootId = process.env.AI_HUB_WORKER_BOOT_ID
  || `${os.hostname()}:${Math.round(estimatedBootMs / 60_000)}`;
let stopping = false;
let lastReconcileAt = 0;
let lastEventFlushAt = 0;
let eventFlushPromise = null;
const activeChildren = new Map();
const orphanPids = new Map();
const activeRuns = new Map();
const persisted = loadState(statePath);
let spool = { jobs: persisted.jobs, events: persisted.events };

function saveSpool() {
  saveWorkerSpool(statePath, spool);
}

function updateEntry(jobId, patch) {
  const current = spool.jobs[jobId] ?? {};
  spool.jobs[jobId] = { ...current, ...patch, updatedAt: new Date().toISOString() };
  saveSpool();
  return spool.jobs[jobId];
}

function removeEntry(jobId) {
  delete spool.jobs[jobId];
  spool.events = spool.events.filter((item) => item.jobId !== jobId);
  saveSpool();
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, init = {}) {
  const res = await fetch(`${base}${url}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error(body.error ?? `${res.status} ${res.statusText}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

function workspaceSettings(value) {
  const target = path.resolve(value).toLowerCase();
  return workspaceEntries
    .filter((entry) => {
      const basePath = path.resolve(entry.path).toLowerCase();
      return target === basePath || target.startsWith(basePath + path.sep);
    })
    .sort((a, b) => path.resolve(b.path).length - path.resolve(a.path).length)[0] ?? null;
}

function allowedWorkspace(value) {
  return workspaceSettings(value) !== null;
}

function sqliteUtcMillis(value) {
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  const normalized = /(?:z|[+-]\d\d:\d\d)$/i.test(value.trim())
    ? value.trim()
    : `${value.trim().replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

async function event(job, kind, content, meta = {}) {
  const payload = { kind, content: String(content).slice(0, 200000), meta };
  try {
    await request(`/api/worker/jobs/${job.id}/events`, {
      method: 'POST', body: JSON.stringify(payload),
    });
  } catch (error) {
    if (error.status === 404 || error.status === 409) {
      console.error(`[${job.id.slice(0, 8)}] late event dropped: ${error.message}`);
      return;
    }
    console.error(`[${job.id.slice(0, 8)}] event upload failed: ${error.message}`);
    spool.events.push({ jobId: job.id, payload });
    if (spool.events.length > 2000) spool.events.splice(0, spool.events.length - 2000);
    saveSpool();
  }
}

function flushEvents() {
  if (eventFlushPromise) return eventFlushPromise;
  eventFlushPromise = (async () => {
    const batch = spool.events.slice(0, 50);
    if (batch.length === 0) return;
    const remaining = [];
    for (const item of batch) {
      try {
        await request(`/api/worker/jobs/${item.jobId}/events`, {
          method: 'POST', body: JSON.stringify(item.payload),
        });
      } catch (error) {
        if (error.status !== 404 && error.status !== 409) remaining.push(item);
      }
    }
    // event() only appends. Preserve anything added while this batch was in flight.
    spool.events = [...remaining, ...spool.events.slice(batch.length)];
    saveSpool();
  })().finally(() => {
    lastEventFlushAt = Date.now();
    eventFlushPromise = null;
  });
  return eventFlushPromise;
}

async function postOutcome(job, outcome) {
  updateEntry(job.id, { job, phase: 'completing', outcome, childPid: null });
  await request(`/api/worker/jobs/${job.id}/complete`, {
    method: 'POST', body: JSON.stringify(outcome),
  });
  removeEntry(job.id);
}

async function reconcileBlockedJobs() {
  if (Date.now() - lastReconcileAt < 60_000) return;
  lastReconcileAt = Date.now();
  const response = await request('/api/worker/reconcile');
  for (const job of response.jobs ?? []) {
    try {
      if (!allowedWorkspace(job.workspace) || !fs.existsSync(job.workspace)) continue;
      const delivery = {
        ...(job.delivery_meta && typeof job.delivery_meta === 'object' ? job.delivery_meta : {}),
        state: job.delivery_state,
      };
      const current = await snapshotRepo(job.workspace);
      const ancestorIncluded = current && delivery.head
        ? await isGitAncestor(job.workspace, delivery.head, current.head)
        : false;
      const updatedAtMs = sqliteUtcMillis(job.updated_at);
      const blockedForMs = Number.isFinite(updatedAtMs)
        ? Math.max(Date.now() - updatedAtMs, 0)
        : 0;
      const decision = reconciliationDecision(delivery, current, ancestorIncluded, {
        blockedForMs,
        graceMs: DEFAULT_RECONCILE_GRACE_MS,
      });
      if (!decision.ready || !current) continue;
      await request(`/api/worker/jobs/${job.id}/reconcile`, {
        method: 'POST',
        body: JSON.stringify({
          head: current.head,
          evidence: {
            dirty: current.dirty,
            ahead: current.ahead,
            ancestorIncluded,
            blockedHead: delivery.head,
            blockedForMs,
            staleFallback: decision.mode === 'clean-timeout-fallback',
            reconciliationMode: decision.mode,
            reason: decision.reason,
          },
        }),
      });
      console.log(`[${job.id.slice(0, 8)}] blocked delivery reconciled at ${current.head.slice(0, 12)}`);
    } catch (error) {
      console.error(`[${job.id.slice(0, 8)}] blocked delivery reconciliation failed: ${error.message}`);
    }
  }
}

function parseLine(job, line, state) {
  if (!line.trim()) return;
  let data;
  try { data = JSON.parse(line); } catch { void event(job, 'log', line); return; }
  for (const candidate of [
    data,
    data.result,
    data.item?.text,
    data.item?.content,
    data.message?.content,
  ]) {
    const declaration = extractDeliveryDeclaration(candidate);
    if (declaration) state.deliveryDeclared = declaration;
  }
  const sessionId = data.session_id ?? data.sessionId ?? data.thread_id ?? data.threadId;
  if (typeof sessionId === 'string' && sessionId !== state.sessionId) {
    state.sessionId = sessionId;
    updateEntry(job.id, { sessionId });
    void event(job, 'session', `session ${sessionId}`, { sessionId });
  }
  // grok streaming-json：逐词 thought/text delta，缓冲成块再上传，end 时清账
  if (data.type === 'thought' || data.type === 'text') {
    if (typeof data.data !== 'string') return;
    const key = data.type === 'thought' ? 'grokThought' : 'grokText';
    state[key] = (state[key] ?? '') + data.data;
    if (data.type === 'thought' && state.grokThought.length > 2000) {
      void event(job, 'thinking', state.grokThought, { type: 'thought' });
      state.grokThought = '';
    }
    return;
  }
  if (data.type === 'end' && (state.grokThought || state.grokText)) {
    if (state.grokThought) {
      void event(job, 'thinking', state.grokThought, { type: 'thought' });
      state.grokThought = '';
    }
    if (state.grokText) {
      state.result = state.grokText;
      state.deliveryDeclared = extractDeliveryDeclaration(state.grokText) ?? state.deliveryDeclared;
      void event(job, 'log', state.grokText, { type: 'text' });
      state.grokText = '';
    }
    return;
  }
  if (data.type === 'result' && typeof data.result === 'string') state.result = data.result;
  if (data.type === 'item.completed' && data.item?.type === 'agent_message') {
    const text = data.item.text ?? data.item.content;
    if (typeof text === 'string') state.result = text;
  }
  const kind = /tool|command/.test(String(data.type ?? ''))
    ? 'tool'
    : /thinking|reason/.test(String(data.type ?? '')) ? 'thinking' : 'log';
  const content = data.message?.content ?? data.message ?? data.error?.message ?? data.error
    ?? data.delta?.text ?? data.item?.text ?? data.result
    ?? (['error', 'turn.failed'].includes(data.type) ? line : data.type) ?? line;
  void event(job, kind, typeof content === 'string' ? content : JSON.stringify(content), { type: data.type });
}

async function execute(job, options = {}) {
  const workspace = workspaceSettings(job.workspace);
  if (!workspace) throw new Error(`workspace is outside allowlist: ${job.workspace}`);
  if (job.permissions?.shell && !cfg.allowShell) throw new Error('job requires shell but worker disallows it');
  if (job.permissions?.ssh && !cfg.allowSsh) throw new Error('job requires SSH but worker disallows it');
  if (!fs.existsSync(job.workspace)) throw new Error(`workspace does not exist: ${job.workspace}`);

  if (options.mode === 'resume' || options.mode === 'restart') {
    const recovered = await request(`/api/worker/jobs/${job.id}/recover`, {
      method: 'POST',
      body: JSON.stringify({ mode: options.mode, sessionId: job.session_id }),
    });
    if (recovered.action === 'cancel') {
      return { status: 'interrupted', error: 'job was cancelled while worker restarted' };
    }
    if (recovered.action === 'pause') {
      return { status: 'paused', error: 'job was paused while worker restarted' };
    }
  } else {
    await request(`/api/worker/jobs/${job.id}/start`, { method: 'POST', body: '{}' });
  }

  const existing = spool.jobs[job.id] ?? {};
  const repoBefore = existing.repoBefore ?? await snapshotRepo(job.workspace);
  updateEntry(job.id, {
    job,
    phase: 'running',
    outcome: null,
    repoBefore,
    childPid: null,
    sessionId: job.session_id ?? existing.sessionId ?? null,
  });
  const spec = buildRunnerSpec(job, cfg);
  await event(job, 'state', `${options.mode === 'start' ? '启动' : '恢复'} ${job.runner}: ${spec.command}`);
  const state = {
    result: '',
    sessionId: job.session_id ?? existing.sessionId ?? null,
    action: 'continue',
    deliveryDeclared: null,
  };

  // Same defense as server claudeCli.ts: settings.json "env" blocks re-inject
  // ANTHROPIC_* when absent, so claude must get explicit overrides
  // (empty key → apiKeySource: none → subscription OAuth).
  // AI_HUB_ALLOW_MASTER：ai-hub 的 pre-commit 钩子挡住共享检出上对 master 的直接提交，
  // 那是给多个交互会话互相收暂存区用的。Worker job 是独立一条串行车道，仍按委派规范
  // 在 workspace 的当前分支上 commit/push，所以这里显式放行。
  const env = { ...process.env, NO_COLOR: '1', AI_HUB_ALLOW_MASTER: '1' };
  if (job.runner === 'claude') {
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_MODEL;
    env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
    env.ANTHROPIC_API_KEY = '';
  }
  const child = spawn(spec.command, spec.args, {
    cwd: job.workspace,
    windowsHide: true,
    shell: process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  activeChildren.set(job.id, child);
  updateEntry(job.id, { childPid: child.pid ?? null });
  child.stdin.end(spec.stdin);
  let stdout = '';
  const consume = (chunk, stream) => {
    const text = chunk.toString('utf8');
    if (stream === 'stderr') void event(job, 'stderr', text);
    if (stream === 'stdout') {
      stdout += text;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? '';
      for (const line of lines) parseLine(job, line, state);
    }
  };
  child.stdout.on('data', (chunk) => consume(chunk, 'stdout'));
  child.stderr.on('data', (chunk) => consume(chunk, 'stderr'));

  const heartbeat = setInterval(async () => {
    try {
      const response = await request(`/api/worker/jobs/${job.id}/heartbeat`, {
        method: 'POST', body: '{}',
      });
      state.action = response.action;
      if (response.action === 'cancel' || response.action === 'pause') child.kill('SIGTERM');
    } catch (error) {
      console.error(`[${job.id.slice(0, 8)}] heartbeat failed: ${error.message}`);
    }
  }, 12_000);

  let exit;
  try {
    exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearInterval(heartbeat);
    activeChildren.delete(job.id);
    spec.cleanup?.();
  }
  if (stdout.trim()) parseLine(job, stdout, state);
  const repoAfter = await snapshotRepo(job.workspace);
  const delivery = {
    ...classifyDelivery(repoBefore, repoAfter, exit.code, {
      deliveryMode: workspace.deliveryMode,
      declaration: state.deliveryDeclared,
    }),
    ...repoDeliveryEvidence(repoBefore, repoAfter),
  };
  if (state.action === 'pause') return { status: 'paused', result: state.result, delivery };
  if (state.action === 'cancel') return { status: 'interrupted', result: state.result, delivery };
  if (delivery.state === 'blocked_local_changes' || delivery.state === 'blocked_unpushed') {
    return { status: 'blocked', result: state.result || 'runner left unfinished local work', delivery };
  }
  if (deliveryCompletesJob(delivery, exit.code)) {
    return {
      status: 'done',
      result: state.result || (exit.code === 0
        ? 'runner exited successfully'
        : `delivery completed before runner exited code=${exit.code}`),
      delivery,
    };
  }
  return {
    status: 'failed',
    result: state.result,
    error: `${spec.command} exited code=${exit.code} signal=${exit.signal}`,
    delivery,
  };
}

async function finishRun(job, mode = 'start') {
  let outcome;
  try {
    outcome = await execute(job, { mode });
  } catch (error) {
    if (stopping) return;
    outcome = { status: 'failed', error: error.stack ?? error.message };
  }
  if (stopping) return;
  try {
    await postOutcome(job, outcome);
  } catch (error) {
    console.error(`[${job.id.slice(0, 8)}] completion upload failed: ${error.message}`);
  }
}

async function recoverOrphan(entry) {
  const job = entry.job;
  let action = 'continue';
  try {
    const recovered = await request(`/api/worker/jobs/${job.id}/recover`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'reattach', childPid: entry.childPid }),
    });
    action = recovered.action;
  } catch (error) {
    console.error(`[${job.id.slice(0, 8)}] orphan reattach failed: ${error.message}`);
    return;
  }
  orphanPids.set(job.id, entry.childPid);
  await event(job, 'state', `Worker 重启后重新接管仍在运行的 PID ${entry.childPid}`);
  while (!stopping && processAlive(entry.childPid)) {
    if (action === 'cancel' || action === 'pause') {
      killPid(entry.childPid);
      break;
    }
    await wait(4_000);
    try {
      const heartbeat = await request(`/api/worker/jobs/${job.id}/heartbeat`, {
        method: 'POST', body: '{}',
      });
      action = heartbeat.action;
    } catch (error) {
      console.error(`[${job.id.slice(0, 8)}] orphan heartbeat failed: ${error.message}`);
    }
  }
  orphanPids.delete(job.id);
  if (stopping) return;
  if (action === 'pause') {
    await postOutcome(job, { status: 'paused', error: 'paused after worker restart' }).catch(() => {});
    return;
  }
  if (action === 'cancel') {
    await postOutcome(job, { status: 'interrupted', error: 'cancelled after worker restart' }).catch(() => {});
    return;
  }
  const current = spool.jobs[job.id] ?? entry;
  const sessionId = current.sessionId ?? job.session_id;
  if (sessionId && supportsResume(job.runner) && Number(current.resumeAttempts ?? 0) < 1) {
    updateEntry(job.id, { resumeAttempts: Number(current.resumeAttempts ?? 0) + 1 });
    await finishRun({ ...job, session_id: sessionId }, 'resume');
    return;
  }
  await postOutcome(job, {
    status: 'interrupted',
    error: 'runner exited while detached; no resumable session was captured',
  }).catch(() => {});
}

function schedule(job, mode = 'start', task = null) {
  const promise = (task ?? finishRun(job, mode))
    .catch((error) => console.error(`[${job.id.slice(0, 8)}] run failed: ${error.stack ?? error.message}`))
    .finally(() => activeRuns.delete(job.id));
  activeRuns.set(job.id, promise);
}

async function recoverSpool() {
  await flushEvents();
  for (const entry of Object.values(spool.jobs)) {
    const job = entry?.job;
    if (!job?.id) continue;
    if (entry.outcome) {
      try {
        await postOutcome(job, entry.outcome);
      } catch (error) {
        console.error(`[${job.id.slice(0, 8)}] stored completion retry failed: ${error.message}`);
      }
      continue;
    }
    if (entry.phase === 'claimed' && !entry.childPid) {
      schedule(job, 'restart');
      continue;
    }
    if (processAlive(entry.childPid)) {
      schedule(job, 'start', recoverOrphan(entry));
      continue;
    }
    const sessionId = entry.sessionId ?? job.session_id;
    if (sessionId && supportsResume(job.runner) && Number(entry.resumeAttempts ?? 0) < 1) {
      updateEntry(job.id, { resumeAttempts: Number(entry.resumeAttempts ?? 0) + 1 });
      schedule({ ...job, session_id: sessionId }, 'resume');
      continue;
    }
    try {
      await postOutcome(job, {
        status: 'interrupted',
        error: 'PC Worker restarted; runner process is gone and no resumable session was captured',
      });
    } catch (error) {
      console.error(`[${job.id.slice(0, 8)}] interruption upload failed: ${error.message}`);
    }
  }
}

function claimedJob(response) {
  if (!response.job) return null;
  return {
    ...response.job,
    deliveryContract: typeof response.deliveryContract === 'string'
      ? response.deliveryContract : '',
    workerProtocolVersion: response.protocolVersion ?? null,
  };
}

async function connect() {
  return request('/api/worker/connect', {
    method: 'POST',
    body: JSON.stringify({
      capabilities: {
        runners: cfg.runners ?? ['codex'],
        workspaces: workspaceEntries.map((entry) => entry.path),
        shell: cfg.allowShell === true,
        ssh: cfg.allowSsh === true,
        maxConcurrent,
        protocolVersion: 2,
      },
      bootId,
    }),
  });
}

async function main() {
  console.log(`ai-hub PC Worker → ${base} (maxConcurrent=${maxConcurrent})`);
  let paused = false;
  let connected = false;
  while (!connected && !stopping) {
    try {
      const response = await connect();
      paused = response.worker?.acceptingJobs === false;
      connected = true;
    } catch (error) {
      console.error(`worker connect: ${error.message}; retrying…`);
      await wait(3_000);
    }
  }
  if (stopping) return;
  await recoverSpool();

  while (!stopping) {
    try {
      if (Date.now() - lastEventFlushAt >= eventFlushIntervalMs) {
        void flushEvents().catch((error) => {
          console.error(`event spool flush failed: ${error.message}`);
        });
      }
      await reconcileBlockedJobs();
      if (paused) {
        const response = await connect();
        paused = response.worker?.acceptingJobs === false;
        if (paused) {
          await wait(3_000);
          continue;
        }
        console.log('worker resumed from ai-hub');
      }
      if (activeRuns.size >= maxConcurrent) {
        await Promise.race([...activeRuns.values(), wait(1_000)]);
        continue;
      }
      const waitSeconds = activeRuns.size === 0 ? 25 : 0;
      const response = await request(`/api/worker/claim?wait=${waitSeconds}`);
      if (response.acceptingJobs === false) {
        paused = true;
        console.log('worker paused from ai-hub; running jobs continue');
        continue;
      }
      const job = claimedJob(response);
      if (!job) {
        if (activeRuns.size > 0) await Promise.race([...activeRuns.values(), wait(1_000)]);
        continue;
      }
      console.log(`[${job.id.slice(0, 8)}] claimed ${job.runner} @ ${job.workspace}`);
      updateEntry(job.id, {
        job,
        phase: 'claimed',
        outcome: null,
        childPid: null,
        sessionId: job.session_id ?? null,
        resumeAttempts: 0,
      });
      schedule(job);
    } catch (error) {
      if (!stopping) console.error(`worker loop: ${error.message}; reconnecting…`);
      await wait(3_000);
      try {
        const response = await connect();
        paused = response.worker?.acceptingJobs === false;
      } catch {}
    }
  }
  await Promise.allSettled([...activeRuns.values()]);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    for (const child of activeChildren.values()) child.kill('SIGTERM');
    for (const pid of orphanPids.values()) killPid(pid);
  });
}

await main();
