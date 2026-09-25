import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  classifyDelivery,
  collectStructuredReceipt,
  deliveryCompletesJob,
  DEFAULT_RECONCILE_GRACE_MS,
  extractDeliveryDeclaration,
  extractRunnerUsage,
  formatLocalChangesSection,
  formatScratchSection,
  isGitAncestor,
  readScratchReceipts,
  reconciliationDecision,
  repoDeliveryEvidence,
  scratchDirForJob,
  snapshotRepo,
} from './runner/delivery.mjs';
import { autoCommitAndPush, autoCommitEligibility } from './runner/auto-commit.mjs';
import { acquireInstanceLock } from './runner/instance-lock.mjs';
import { buildRunnerSpec, killRunnerTree, supportsResume, sshDeniedEnv } from './runner/runner.mjs';
import {
  closureNotStartedFailure,
  closureResumeFailure,
  deriveClosureDelivery,
  extractLastJsonReport,
  formatClosureResult,
  isClosureJob,
  resolveClosureScript,
  runClosureScript,
  selectClosureTarget,
} from './runner/closure-runner.mjs';
import {
  buildStallResumePreamble,
  canStallResume,
  cleanupProvenTree,
  classifyStall,
  confirmStall,
  createProgressTracker,
  describeStall,
  descendantsOf,
  fingerprintEvent,
  findRow,
  isSameProcess,
  inspectProcessHistory,
  queryProcessTable,
  readSessionEvidence,
  resolveStallConfig,
  roundScopedTools,
  cpuMinWindowMs,
  cpuWindowBusy,
  terminateIdentities,
  treeCpuTotal,
  ttlRemainingMs,
} from './runner/stall.mjs';
import { loadState, saveWorkerSpool } from './state-store.mjs';
import { buildWorkerReleaseInfo } from './runner/worker-release.mjs';
import {
  refreshCapabilityCard,
  resolveCapabilityProbeIntervalMs,
  resolveNpmCacheDir,
} from './runner/capability-card.mjs';
import { ensureNodeModules, frozenTargetOf, provisionWorkspace } from './runner/provision.mjs';
import { resolveStateFile, resolveWorkspaceTarget, workspaceContains, workspaceKey } from './runner/workspace-path.mjs';
import { cameraCapabilities, captureFrame, handleSnapRequest } from './runner/camera.mjs';
import { TaobaoMcpClient, handleTaobaoRequest, taobaoCapabilities, taobaoMcpUrl } from './runner/taobao.mjs';
import { parseHubTimestampMs } from './lib/hub-time.mjs';
import { fileURLToPath } from 'node:url';

// <release>/worker/worker.mjs → <release>. Closure gate scripts are resolved
// under <release>/deploy/, i.e. from what the launcher/installer exported,
// never from the job workspace being judged.
const WORKER_RELEASE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
// G01: stateFile must resolve to an absolute path anchored at the config dir.
const statePath = resolveStateFile(configPath, cfg.stateFile ?? 'worker-state.json');
const base = String(cfg.serverUrl ?? '').replace(/\/$/, '');
if (!base || !cfg.token) throw new Error('serverUrl/token required');
// Worker identity for machine-readable refusal lines: the pairing token is
// `<workerId>.<secret>`, the same id the gateway stores in workers.id.
const workerId = String(cfg.token).split('.')[0].trim();
const maxConcurrent = Math.min(Math.max(Number(cfg.maxConcurrent) || 1, 1), 8);
// One lazy session to the Taobao desktop client; only ever used when allowTaobao is true.
const taobaoClient = new TaobaoMcpClient(taobaoMcpUrl(cfg));
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

// G01: startup workspace realpath check — resolve symlinks before any job is
// claimed so a link escape or missing root is visible in the worker log from
// boot, not mid-run. Non-fatal: a misconfigured root is skipped per-job.
for (const entry of workspaceEntries) {
  try {
    const real = resolveWorkspaceTarget(entry.path, entry.path);
    console.log(`workspace ready: ${entry.path} -> ${real}`);
  } catch (error) {
    console.error(`workspace NOT ready: ${entry.path}: ${error.message}`);
  }
}

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
// Stall-cleanup failures leave the old CLI running but untracked: keep the
// child handle here so worker shutdown still ends it (handle kill, not PID
// kill, so PID reuse cannot hit an unrelated process), and never start a
// second executor for that job while it is stranded.
const strandedChildren = new Map();
const stallConfig = resolveStallConfig(cfg);
const activeRuns = new Map();
const persisted = loadState(statePath);
let spool = { jobs: persisted.jobs, events: persisted.events, stranded: persisted.stranded ?? {} };

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
  // G01: Windows folds case, Linux preserves it; cross-platform pairs never match.
  return workspaceEntries
    .filter((entry) => workspaceContains(entry.path, value))
    .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}

function allowedWorkspace(value) {
  return workspaceSettings(value) !== null;
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

// 精确残留处理（opencode 专用，不碰其他 runner）：枚举仍能证明亲缘的
// 子进程并正常结束，返回人可读的备注。暂停/取消已经获胜时不因此改状态，
// 只如实报告（含枚举不可用）；停滞恢复路径另有严格版本（残留未清或归属
// 不可证明则阻塞，不拉起新执行）。
async function noteResidualTree(job, child) {
  const rootPid = child?.pid;
  if (job.runner !== 'opencode') return '';
  if (process.platform !== 'win32' || !Number.isInteger(rootPid) || rootPid <= 0) return '';
  let tree;
  try {
    tree = await cleanupProvenTree(rootPid);
  } catch {
    tree = { attempted: [], remaining: [], unprovable: true, known: [] };
  }
  if (!tree.unprovable && tree.remaining.length === 0) {
    if (tree.attempted.length > 0) {
      void event(job, 'state', `残留子进程已精确清理（${tree.attempted.length} 个），未按进程名批量处理。`, { stall: 'tree-cleaned' });
    }
    return '';
  }
  const note = tree.unprovable
    ? '残留子进程归属无法枚举确认，未按进程名批量处理，需人工确认'
    : `残留子进程未能确认结束（PID ${tree.remaining.slice(0, 8).join(',')}），未按进程名批量处理，需人工确认`;
  void event(job, 'state', `注意：${note}。`, { stall: 'tree-remaining' });
  // The job stops here, but a later job on the same workspace must not
  // overlap an unproven survivor: keep the durable mutex.
  await strandChild(job, child, note, tree.known ?? []);
  return note;
}

function killPid(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

// --- Durable strand mutex --------------------------------------------------
// A detached-but-possibly-live old executor is recorded in spool.stranded
// (persisted, survives job completion and Worker restarts). Any later
// claim/start/resume for the same job or workspace must verify the old
// executor is gone (or its PID reused by a proven-different process) before
// starting new work. Bare PIDs in chat timelines do not count as tracking;
// this section is the runtime mutex.
function workspaceNorm(value) {
  // G01: comparison key only; Windows folds case, POSIX preserves it.
  return workspaceKey(value);
}

async function strandChild(job, child, reason, knownIdentities = []) {
  strandedChildren.set(job.id, child);
  // Capture the whole live tree (root + descendants with creation-time
  // identity): on Windows the direct shell child dies with the worker while
  // deeper grandchildren survive orphaned, so tracking the root PID alone
  // would falsely clear the mutex after a crash. Identities proven earlier
  // (before the root exited) are merged in: once the root is gone, a live
  // query can no longer reach its orphaned descendants through it.
  let tree = [];
  const add = (item) => {
    if (!Number.isInteger(item?.pid) || !item.created) return;
    if (tree.some((t) => t.pid === item.pid && t.created === item.created)) return;
    tree.push({ pid: item.pid, created: item.created, name: item.name });
  };
  try {
    const rows = await queryProcessTable();
    if (rows && Number.isInteger(child?.pid)) {
      const root = findRow(rows, child.pid);
      if (root) add(root);
      for (const member of descendantsOf(rows, child.pid)) add(member);
    }
  } catch {}
  for (const item of knownIdentities ?? []) add(item);
  const current = spool.jobs[job.id] ?? {};
  const record = {
    jobId: job.id,
    sessionId: current.sessionId ?? job.session_id ?? null,
    workspace: job.workspace,
    pid: Number.isInteger(child?.pid) ? child.pid : null,
    created: tree.find((t) => t.pid === child?.pid)?.created ?? null,
    unverified: tree.length === 0,
    tree,
    reason,
    at: new Date().toISOString(),
  };
  spool.stranded[job.id] = record;
  saveSpool();
  void event(job, 'state',
    `旧执行已脱钩持久跟踪：${reason}（跟踪 ${tree.length} 个进程身份${tree.length ? '' : '，创建时枚举失败'}）。确认其停止前，同工作区不启动新执行。`,
    { stall: 'stranded' });
  return record;
}

function clearStrand(id) {
  if (spool.stranded[id]) {
    delete spool.stranded[id];
    saveSpool();
  }
}

// Verify one strand record against the live process table.
async function verifyStrand(record) {
  let rows = null;
  try {
    rows = await queryProcessTable();
  } catch {
    rows = null;
  }
  if (!rows) return { state: 'unknown', reason: '残留复核时进程枚举失败', alive: [] };
  const tracked = Array.isArray(record.tree) && record.tree.length > 0
    ? record.tree
    : (record.pid != null ? [{ pid: record.pid, created: record.created }] : []);
  if (inspectProcessHistory(rows, tracked).unprovable) {
    return { state: 'unknown', reason: '历史进程树出现未核验后代，父链已变化，保持互斥', alive: [] };
  }
  if (tracked.length === 0) return { state: 'gone', reason: '无可跟踪的进程身份', alive: [] };
  const alive = [];
  let reused = 0;
  let proven = 0;
  for (const item of tracked) {
    if (!Number.isInteger(item?.pid)) continue;
    const row = findRow(rows, item.pid);
    if (!row) continue;
    if (item.created && !isSameProcess({ pid: item.pid, created: item.created }, row)) {
      reused += 1;
      continue;
    }
    if (!item.created) {
      // Identity never captured but a process holds the PID: possible
      // survivor, unprovable either way — report separately.
      alive.push({ pid: item.pid, unverified: true });
      continue;
    }
    proven += 1;
    alive.push({ pid: item.pid, unverified: false });
  }
  if (alive.length > 0) {
    const pids = alive.map((a) => a.pid).join(',');
    const tag = alive.some((a) => a.unverified) ? '（含创建身份未核验者，保持互斥）' : '（创建身份一致）';
    return { state: 'alive-same', reason: `旧执行仍有存活进程（PID ${pids}）${tag}`, alive };
  }
  if (proven > 0 || reused > 0 || tracked.some((t) => t.created)) {
    return {
      state: reused > 0 ? 'reused' : 'gone',
      reason: reused > 0
        ? `旧执行进程已消失，部分 PID 被复用（创建时间不一致），互斥解除`
        : `旧执行跟踪的 ${tracked.length} 个进程身份均已消失`,
      alive: [],
    };
  }
  return { state: 'unknown', reason: '残留身份从未成功捕获，无法复核', alive: [] };
}

// Reconcile one strand record: verify, and when a verified survivor exists,
// terminate exactly those identities (bounded rounds, same standard as the
// stall cleanup) and re-verify. Returns { action: 'clear'|'blocked', reason }.
// A restarted worker therefore self-heals verified leftovers of already
// terminal jobs instead of bricking the workspace, while anything unproven
// keeps the mutex.
async function resolveStrand(record, job) {
  const verdict = await verifyStrand(record);
  if (verdict.state === 'gone' || verdict.state === 'reused') {
    return { action: 'clear', reason: verdict.reason };
  }
  if (verdict.state !== 'alive-same') {
    return { action: 'blocked', reason: verdict.reason };
  }
  const tracked = (Array.isArray(record.tree) && record.tree.length > 0
    ? record.tree
    : [{ pid: record.pid, created: record.created }])
    .filter((t) => Number.isInteger(t?.pid) && t.created && verdict.alive.some((a) => a.pid === t.pid && !a.unverified));
  const unverifiedAlive = verdict.alive.some((a) => a.unverified);
  let term = { ended: [], remaining: [], unprovable: true };
  try {
    term = await terminateIdentities(tracked);
  } catch {
    term = { ended: [], remaining: [], unprovable: true };
  }
  if (job) {
    void event(job, 'state',
      `残留对账：对 ${record.jobId} 的存活残留做精确结束（结束 ${term.ended.join(',') || '无'}，剩余 ${term.remaining.join(',') || '无'}${term.unprovable ? '，复核不可证明' : ''}${unverifiedAlive ? '，另有身份未核验存活者' : ''}）。`,
      { stall: 'strand-reconcile' });
  }
  if (unverifiedAlive) {
    return { action: 'blocked', reason: `${verdict.reason}；存在创建身份未核验的存活进程，无法精确处理，保持互斥` };
  }
  if (!term.unprovable && term.remaining.length === 0) {
    return { action: 'clear', reason: `${verdict.reason}；已精确结束残留，互斥解除` };
  }
  const why = term.unprovable ? '终止后复核枚举失败' : `残留仍存活（PID ${term.remaining.slice(0, 8).join(',')}）`;
  return { action: 'blocked', reason: `${verdict.reason}；已尝试精确结束但${why}，保持互斥` };
}

// Returns a live conflict { record, reason } or null. Stale records
// (gone/reused) are cleared as a side effect. options.excludeSameJob skips
// records of the job itself (used where the caller handles those).
async function strandConflict(job, options = {}) {
  const key = workspaceNorm(job.workspace);
  const ids = Object.keys(spool.stranded);
  if (ids.length > 0) {
    console.error(`[${job.id.slice(0, 8)}] strand check: ${ids.length} record(s) for ${job.id} @ ${key}`);
  }
  for (const [id, record] of Object.entries(spool.stranded)) {
    if (options.excludeSameJob && record.jobId === job.id) continue;
    if (record.jobId !== job.id && workspaceNorm(record.workspace) !== key) continue;
    const resolution = await resolveStrand(record, job);
    console.error(`[${job.id.slice(0, 8)}] strand resolve ${record.jobId}: ${resolution.action} (${resolution.reason})`);
    if (resolution.action === 'clear') {
      clearStrand(id);
      void event(job, 'state', `残留互斥解除（${record.jobId}）：${resolution.reason}。`, { stall: 'strand-cleared' });
      continue;
    }
    return { record, reason: resolution.reason };
  }
  return null;
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
      const updatedAtMs = parseHubTimestampMs(job.updated_at) ?? Number.NaN;
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
  if (!line.trim()) return { progressed: false, fingerprint: null };
  let data;
  try { data = JSON.parse(line); } catch { void event(job, 'log', line); return { progressed: false, fingerprint: null }; }
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
  // P1 cost ledger: runner-reported usage is pass-through only — last usable
  // reading wins, nothing is estimated when the runner reports nothing.
  // Per-step readings (OpenCode) are summed instead.
  const runnerUsage = extractRunnerUsage(data);
  if (runnerUsage) {
    const { perStep, ...reading } = runnerUsage;
    state.usage = perStep && state.usage
      ? {
        inputTokens: state.usage.inputTokens + reading.inputTokens,
        outputTokens: state.usage.outputTokens + reading.outputTokens,
        ...(state.usage.cacheReadTokens !== undefined || reading.cacheReadTokens !== undefined
          ? { cacheReadTokens: (state.usage.cacheReadTokens ?? 0) + (reading.cacheReadTokens ?? 0) }
          : {}),
      }
      : reading;
  }
  const sessionId = data.session_id ?? data.sessionId ?? data.sessionID ?? data.thread_id ?? data.threadId;
  if (typeof sessionId === 'string' && sessionId !== state.sessionId) {
    state.sessionId = sessionId;
    updateEntry(job.id, { sessionId });
    void event(job, 'session', `session ${sessionId}`, { sessionId });
    return { progressed: true, fingerprint: fingerprintEvent('session', 'session', sessionId) };
  }
  if (data.type === 'text' && data.part && typeof data.part.text === 'string') {
    state.result = state.result ? `${state.result}\n${data.part.text}` : data.part.text;
    void event(job, 'log', data.part.text, { type: 'text' });
    return { progressed: true, fingerprint: fingerprintEvent('log', 'text', data.part.text) };
  }
  if (data.type === 'reasoning' && data.part && typeof data.part.text === 'string') {
    void event(job, 'thinking', data.part.text, { type: 'reasoning' });
    return { progressed: true, fingerprint: fingerprintEvent('thinking', 'reasoning', data.part.text) };
  }
  // grok streaming-json：逐词 thought/text delta，缓冲成块再上传，end 时清账
  if ((data.type === 'thought' || data.type === 'text') && typeof data.data === 'string') {
    const key = data.type === 'thought' ? 'grokThought' : 'grokText';
    state[key] = (state[key] ?? '') + data.data;
    if (data.type === 'thought' && state.grokThought.length > 2000) {
      void event(job, 'thinking', state.grokThought, { type: 'thought' });
      state.grokThought = '';
    }
    return { progressed: true, fingerprint: fingerprintEvent(data.type, 'delta', data.data.slice(-500)) };
  }
  if (data.type === 'end' && (state.grokThought || state.grokText)) {
    let flushed = false;
    if (state.grokThought) {
      void event(job, 'thinking', state.grokThought, { type: 'thought' });
      state.grokThought = '';
      flushed = true;
    }
    if (state.grokText) {
      state.result = state.grokText;
      state.deliveryDeclared = extractDeliveryDeclaration(state.grokText) ?? state.deliveryDeclared;
      void event(job, 'log', state.grokText, { type: 'text' });
      state.grokText = '';
      flushed = true;
    }
    return { progressed: flushed, fingerprint: flushed ? fingerprintEvent('log', 'end', state.result.slice(-500)) : null };
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
  return {
    progressed: true,
    fingerprint: fingerprintEvent(kind, data.type, typeof content === 'string' ? content : JSON.stringify(content)),
  };
}

function buildRunnerEnv(job, spec) {
  // Same defense as server claudeCli.ts: settings.json "env" blocks re-inject
  // ANTHROPIC_* when absent, so claude must get explicit overrides
  // (empty key → apiKeySource: none → subscription OAuth).
  // AI_HUB_ALLOW_MASTER：ai-hub 的 pre-commit 钩子挡住共享检出上对 master 的直接提交，
  // 那是给多个交互会话互相收暂存区用的。Worker job 是独立一条串行车道，仍按委派规范
  // 在 workspace 的当前分支上 commit/push，所以这里显式放行。
  const env = { ...process.env, NO_COLOR: '1', AI_HUB_ALLOW_MASTER: '1' };
  // O6: runner self-written receipt channel. The execution prompt points the
  // runner at AI_HUB_SCRATCH_DIR (per-job local dir); the harness collects it
  // back into the receipt instead of round-tripping through the vault.
  try {
    env.AI_HUB_JOB_ID = String(job.id ?? '');
    env.AI_HUB_SCRATCH_DIR = scratchDirForJob(job.id);
  } catch { /* receipt channel is best-effort */ }
  if (job.runner === 'claude') {
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_MODEL;
    env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
    env.ANTHROPIC_API_KEY = '';
  }
  // Runner-spec env overlay (e.g. SSH agent scrub for jobs without ssh):
  // undefined values delete the variable.
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

// Resolves with the exit record, or null on timeout. Never rejects: a missing
// exit means the old execution is NOT proven stopped, which the caller must
// treat as a blocking condition (never start a second executor on top).
function waitChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve(null);
    }, Math.max(Number(timeoutMs) || 0, 0));
    const onExit = (code, signal) => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ code, signal });
    };
    const onError = () => {
      // A spawn error is followed by 'exit'/'close' on a live handle; keep
      // waiting for the exit record until the timeout decides provability.
    };
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

function buildStallEvidence(state, exit, repoAfter) {
  const tail = String(state.result ?? '').trim().slice(-1500);
  const repo = repoAfter
    ? `repo head=${repoAfter.head.slice(0, 12)} dirty=${repoAfter.dirty} ahead=${repoAfter.ahead}`
    : 'repo snapshot unavailable';
  return [
    `runner exit code=${exit?.code ?? 'null'} signal=${exit?.signal ?? 'null'}`,
    repo,
    tail ? `result tail:\n${tail}` : 'no result text captured',
  ].join('\n');
}

// Single runner spawn. For opencode with the watchdog enabled this also runs
// stall detection; a confirmed stall returns { stalled: true, ... } with the
// old process already proven stopped (or explicitly unprovable -> blocked).
// It NEVER spawns a second executor itself; the resume decision lives in
// execute() so budget/pause races are checked in one place.
async function runRunnerOnce({
  job, workspace, repoBefore, promptExtra = '', stall = null,
  isResume = false, resumeIndex = 0, launchWord = '启动',
}) {
  const useStall = Boolean(stall?.enabled) && job.runner === 'opencode';
  const spec = buildRunnerSpec(job, cfg);
  await event(job, 'state', `${isResume ? '恢复' : launchWord} ${job.runner}: ${spec.command}`);
  const state = {
    result: '',
    sessionId: job.session_id ?? null,
    action: 'continue',
    deliveryDeclared: null,
    // P1 cost ledger: runner-reported token usage (null until observed).
    usage: null,
  };
  const tracker = useStall ? createProgressTracker({}) : null;
  let suspectAt = null;
  let suspectReason = null;
  let stallEnding = null;
  let endPromise = null;
  let pendingEnding = null;
  let acceptProgress = true;
  let killSent = false;
  let naturalExit = false;
  let resumeProgressNoted = false;
  let cpuBaseline = null;
  let cpuBaselineAt = null;
  // After a CPU-evidenced clear, a still-silent busy tool would re-open the
  // suspicion on the very next tick; hold off one grace window instead.
  let cpuQuietUntil = 0;
  let cpuDegraded = false;
  let degradedNoted = false;
  // Session tool-state verdict inputs: open tool calls observed running
  // with first-seen timestamps; extendUntil defers confirmation while an
  // open tool stays within its agreed limit.
  let sessionSample = null;
  let sessionSampleAt = 0;
  let openSeen = new Map();
  let extendUntil = null;

  const env = buildRunnerEnv(job, spec);
  // G01: POSIX runners start detached in their own process group so a hung
  // tree can be signalled as a group (see killRunnerTree in runner.mjs).
  const child = spawn(spec.command, spec.args, {
    cwd: job.workspace,
    ...(process.platform === 'win32'
      ? { windowsHide: true, shell: true, detached: false }
      : { windowsHide: false, shell: false, detached: true }),
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  activeChildren.set(job.id, child);
  updateEntry(job.id, { childPid: child.pid ?? null });
  child.stdin.end(promptExtra ? `${promptExtra}\n\n${spec.stdin}` : spec.stdin);
  let stdout = '';
  const consume = (chunk, stream) => {
    const text = chunk.toString('utf8');
    if (useStall) tracker.noteBytes(Date.now());
    if (stream === 'stderr') {
      void event(job, 'stderr', text);
      return;
    }
    stdout += text;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? '';
    for (const line of lines) {
      const info = parseLine(job, line, state);
      if (useStall && acceptProgress && info?.progressed && info.fingerprint) {
        if (tracker.noteParsed(info.fingerprint, Date.now())) {
          if (suspectAt !== null) {
            suspectAt = null;
            suspectReason = null;
            cpuBaseline = null;
            cpuBaselineAt = null;
            cpuDegraded = false;
            degradedNoted = false;
            sessionSample = null;
            sessionSampleAt = 0;
            openSeen = new Map();
            extendUntil = null;
            updateEntry(job.id, { stallState: null });
            void event(job, 'state', '停滞解除：观察到新的有效步骤，继续执行。', { stall: false });
          }
          if (isResume && !resumeProgressNoted) {
            resumeProgressNoted = true;
            void event(job, 'state', '恢复后出现新的有效步骤，继续观察。', { stall: 'recovered-progress' });
          }
        }
      }
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
      // G01: cancel/pause must end the whole runner tree (process group on
      // POSIX via killRunnerTree), not just the direct child.
      if (response.action === 'cancel' || response.action === 'pause') killRunnerTree(child);
    } catch (error) {
      console.error(`[${job.id.slice(0, 8)}] heartbeat failed: ${error.message}`);
    }
  }, 12_000);

  // Stall gate fetches must be bounded: an unreachable gateway must produce
  // an explicit block, never an endless wait that keeps the blocked receipt
  // unreachable (the failure path itself must terminate).
  const GATE_TIMEOUT_MS = 15_000;

  function clearSuspicion(message) {
    suspectAt = null;
    suspectReason = null;
    cpuBaseline = null;
    cpuBaselineAt = null;
    cpuDegraded = false;
    degradedNoted = false;
    sessionSample = null;
    sessionSampleAt = 0;
    openSeen = new Map();
    extendUntil = null;
    updateEntry(job.id, { stallState: null });
    if (message) void event(job, 'state', message, { stall: false });
  }

  // Sum of kernel+user CPU over the root + same-snapshot descendants, or
  // null when the root row is absent / the query failed.
  function snapshotCpu(rows) {
    if (!rows) return null;
    const total = treeCpuTotal(rows, child.pid);
    return total ? total.total : null;
  }

  // Final verdict once bytes/parse/CPU are all quiet past the windows.
  // Only a positively-identified stuck tool call (open past the agreed
  // tool limit after real progress) may auto-resume. Every other quiet
  // shape — unknown session/evidence, never-progressed, lingered process,
  // in-limit tool — stops the old execution and hands back WITHOUT a new
  // executor. Returns null to extend the suspicion (tool still in limit).
  async function decideStallVerdict(now) {
    if (sessionSample == null || now - sessionSampleAt >= 2000) {
      sessionSample = await readSessionEvidence({
        opencodeCommand: cfg.opencodeCommand,
        sessionId: state.sessionId ?? job.session_id,
        timeoutMs: 15_000,
      });
      sessionSampleAt = now;
      if (sessionSample.readable && sessionSample.known) {
        sessionSample = { ...sessionSample, tools: roundScopedTools(sessionSample.tools, tracker.startedAt) };
        for (const tool of sessionSample.tools) {
          if (tool.status !== 'running') continue;
          const key = tool.callID ?? `${tool.tool}:${tool.start ?? 'unknown'}`;
          const prev = openSeen.get(key);
          openSeen.set(key, {
            since: Math.min(tool.start ?? now, prev?.since ?? now),
            tool: tool.tool,
          });
        }
      }
    }
    const hadProgress = tracker.progressCount > 0;
    if (!sessionSample.readable || !sessionSample.known) {
      return {
        resume: false,
        reason: `会话工具状态不可读（${sessionSample.error ?? '未知会话'}），无法证明真实停滞`,
      };
    }
    const openNow = sessionSample.tools.filter((tool) => tool.status === 'running');
    const ambiguous = sessionSample.tools.some(
      (tool) => !['running', 'completed', 'error'].includes(tool.status)
    );
    if (ambiguous) {
      return {
        resume: false,
        reason: '会话中存在状态不明的工具调用，无法证明真实停滞',
      };
    }
    const pastLimit = openNow.filter((tool) => {
      const key = tool.callID ?? `${tool.tool}:${tool.start ?? 'unknown'}`;
      const since = openSeen.get(key)?.since ?? now;
      return now - since > stall.toolLimitMs;
    });
    if (pastLimit.length > 0 && hadProgress) {
      return { resume: true, reason: `工具 ${pastLimit[0].tool} 已运行超限且全程静默` };
    }
    if (pastLimit.length > 0) {
      return {
        resume: false,
        reason: '工具调用超时但本轮从未观测到有效进展，状态未知',
      };
    }
    if (openNow.length === 0) {
      return {
        resume: false,
        reason: '会话内工具调用已全部结束但进程仍无输出（可能是远端模型仍在思考），无法证明真实停滞',
      };
    }
    const deferUntil = Math.min(...openNow.map((tool) => {
      const key = tool.callID ?? `${tool.tool}:${tool.start ?? 'unknown'}`;
      const since = openSeen.get(key)?.since ?? now;
      return since + stall.toolLimitMs;
    }));
    if (now < deferUntil) {
      extendUntil = deferUntil;
      return null;
    }
    return null; // limit crossed between evaluate and confirm: re-decide next tick
  }

  async function endStalledChild(willResume, stopReason) {
    // 1. 先向网关复核：任务仍允许运行、未暂停/取消/被接管、授权和租约仍有效。
    try {
      const gate = await request(`/api/worker/jobs/${job.id}/heartbeat`, {
        method: 'POST', body: '{}', signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
      });
      state.action = gate.action;
      if (gate.action === 'cancel' || gate.action === 'pause') {
        killSent = true;
        killRunnerTree(child);
        const ex = await waitChildExit(child, stall.killGraceMs);
        const treeNote = await noteResidualTree(job, child);
        return { proven: true, terminal: gate.action, exit: ex, treeNote };
      }
    } catch (error) {
      return {
        proven: false, terminal: null,
        reason: `恢复前网关复核失败（${error.message}），无法确认任务仍允许运行；未启动第二个执行者`,
      };
    }
    if (process.platform !== 'win32') {
      return {
        proven: false, terminal: null,
        reason: '当前平台无法枚举子进程亲缘，残留归属无法证明；未启动第二个执行者',
      };
    }
    void event(job, 'state',
      willResume
        ? `确认停滞：诊断宽限内无新进展、子进程无活动，且会话显示有工具调用被明确卡住；正在安全结束旧执行（PID ${child.pid ?? 'unknown'}），准备同 session 恢复。`
        : `停止旧执行并正式交回：${stopReason}（PID ${child.pid ?? 'unknown'}）。`,
      { stall: 'confirmed' });
    acceptProgress = false;
    // 进程身份快照（pid + 创建时间）：kill 前后核对，防止 PID 复用。
    const before = await queryProcessTable();
    const rootBefore = before ? findRow(before, child.pid) : null;
    // Identities proven before the kill: once the root exits, its orphaned
    // descendants are unreachable through it, so a blocked outcome must
    // carry them into the durable mutex.
    const knownBefore = before
      ? [rootBefore, ...descendantsOf(before, child.pid)].filter(Boolean)
      : [];
    killSent = true;
    // G01: SIGTERM the runner tree first; escalate to group SIGKILL on POSIX
    // so hung grandchildren in the detached process group die too.
    killRunnerTree(child);
    let ex = await waitChildExit(child, stall.killGraceMs);
    if (!ex) {
      killRunnerTree(child, process.platform, 'SIGKILL');
      ex = await waitChildExit(child, stall.killGraceMs);
    }
    if (!ex) {
      return {
        proven: false, terminal: null, known: knownBefore,
        reason: `旧执行进程（PID ${child.pid ?? 'unknown'}）未能确认结束，未启动第二个执行者`,
      };
    }
    const after = await queryProcessTable();
    if (!after) {
      return {
        proven: false, terminal: null, exit: ex, known: knownBefore,
        reason: '停滞收尾后进程枚举失败，残留是否结束无法确认；未启动第二个执行者',
      };
    }
    const rootAfter = findRow(after, child.pid);
    if (rootAfter && (!rootBefore || isSameProcess(rootBefore, rootAfter))) {
      // Exit was observed on our handle yet the same identity is still
      // present: do not trust it, do not resume.
      return {
        proven: false, terminal: null, exit: ex, known: knownBefore,
        reason: `旧执行 PID ${child.pid} 的同身份进程仍在，无法证明已停止；未启动第二个执行者`,
      };
    }
    if (rootAfter && rootBefore && !isSameProcess(rootBefore, rootAfter)) {
      return {
        proven: false, terminal: null, exit: ex, known: knownBefore,
        reason: `旧执行已退出但 PID ${child.pid} 已被复用（创建时间不一致），残留归属无法证明；未启动第二个执行者`,
      };
    }
    // 2. 严格残留清理：只处理同身份亲缘，绝不按进程名批量杀。
    // 枚举失败（unprovable）与残留存活都必须阻塞自动恢复。
    const tree = await cleanupProvenTree(child.pid, { known: knownBefore });
    if (tree.unprovable) {
      return {
        proven: false, terminal: null, exit: ex, known: [...knownBefore, ...(tree.known ?? [])],
        reason: '残留清理时进程枚举失败，归属无法证明；未启动第二个执行者',
      };
    }
    if (tree.remaining.length > 0) {
      return {
        proven: false, terminal: null, exit: ex, known: [...knownBefore, ...(tree.known ?? [])],
        reason: `可证明归属的残留子进程仍存活（PID ${tree.remaining.slice(0, 8).join(',')}），未启动第二个执行者`,
      };
    }
    return { proven: true, terminal: null, exit: ex, resume: willResume === true, reason: stopReason };
  }

  let stallTimer = null;
  let monitorBusy = false;
  async function monitorTick() {
    if (naturalExit || child.exitCode !== null || child.signalCode !== null) return;
    const now = Date.now();
    if (suspectAt == null) {
      if (now < cpuQuietUntil) return;
      const decision = classifyStall(now, tracker, stall, null);
      if (decision.phase === 'watching') return;
      suspectAt = now;
      suspectReason = decision.reason;
      cpuBaseline = null;
      cpuBaselineAt = null;
      cpuDegraded = false;
      degradedNoted = false;
      sessionSample = null;
      sessionSampleAt = 0;
      openSeen = new Map();
      extendUntil = null;
      updateEntry(job.id, {
        stallState: { phase: 'suspected', reason: decision.reason, suspectAt, recoveries: resumeIndex },
      });
      void event(job, 'state',
        `疑似停滞：${decision.reason === 'no-output' ? '长时间无任何子进程输出' : '长时间无有效进展（输出重复但无新步骤）'}`
        + `（${describeStall({ reason: decision.reason, sinceProgress: decision.sinceProgress, sinceBytes: decision.sinceBytes, recoveries: resumeIndex })}），`
        + `进入诊断宽限 ${Math.round(stall.diagnoseGraceMs / 1000)}s：继续观察工具输出、解析进展与子进程活动；心跳在线不等于任务推进。`,
        { stall: 'suspected', reason: decision.reason });
      return;
    }
    // 诊断宽限：在计时之外，用子进程 CPU 活动做第二证据。工具仍在消耗
    // CPU（正常长测试/模型思考）会解除疑似；三者全静默才走向确认。
    if (stall.cpuWatch) {
      const rows = await queryProcessTable();
      const cpu = snapshotCpu(rows);
      if (cpu == null) {
        if (!cpuDegraded) {
          cpuDegraded = true;
          void event(job, 'state', '诊断证据降级：子进程活动不可读，改用延长静默窗口确认，期间仍以输出与解析进展为准。', { stall: 'degraded' });
        }
      } else if (cpuBaseline == null) {
        cpuBaseline = cpu;
        cpuBaselineAt = now;
      } else if (cpuWindowBusy({
        baselineCpu: cpuBaseline, baselineAt: cpuBaselineAt, cpu, now,
        epsilonMs: stall.cpuEpsilonMs, busyRatio: stall.cpuBusyRatio, minWindowMs: cpuMinWindowMs(stall),
      })) {
        const ratio = Number(cpu - cpuBaseline) / 10_000 / Math.max(now - cpuBaselineAt, 1);
        cpuQuietUntil = now + stall.diagnoseGraceMs;
        clearSuspicion(`停滞解除：诊断窗口内子进程树 CPU 占用约 ${(ratio * 100).toFixed(1)}%（阈值 ${(stall.cpuBusyRatio * 100).toFixed(1)}%），判定仍在工作，继续执行。`);
        return;
      }
      // The baseline is never advanced mid-window: activity is a rate over
      // the whole diagnosis window, so idle runner noise cannot clear it.
    }
    // Without a full CPU window (and CPU readable) confirmation must wait.
    if (stall.cpuWatch && !cpuDegraded
      && (cpuBaselineAt == null || now - cpuBaselineAt < cpuMinWindowMs(stall))) return;
    const cpuQuiet = true; // A busy window already returned above; reaching here means quiet-or-degraded.
    if (extendUntil != null && now < extendUntil) return; // 命中的工具未超限：继续等，不提前确认。
    if (!confirmStall({
      now, suspectAt, diagnoseGraceMs: stall.diagnoseGraceMs,
      cpuQuiet, cpuDegraded, degradedMultiplier: stall.degradedConfirmMultiplier,
    })) return;
    // 计时与 CPU 都静默后，再以会话工具状态做最终裁决：只有本轮工具调用被
    // 明确卡住（超过约定 toolLimitMs）才结束旧执行并恢复。证据不足时不结束
    // 可能正常的执行（低 CPU 的 I/O 等待、远端模型思考），只标注并继续观察；
    // 暂停/取消仍由常规心跳立即生效。
    const verdict = await decideStallVerdict(now);
    if (!verdict) return; // 工具未超限：顺延到超限时刻再裁决。
    if (!verdict.resume) {
      const holdMs = Math.max(stall.noProgressMs, stall.diagnoseGraceMs);
      cpuQuietUntil = now + holdMs;
      clearSuspicion(null);
      updateEntry(job.id, {
        stallState: { phase: 'unknown', reason: verdict.reason, at: new Date(now).toISOString(), recoveries: resumeIndex },
      });
      void event(job, 'state',
        `停滞证据不足：${verdict.reason}；未结束执行、未自动恢复，${Math.round(holdMs / 1000)}s 后再诊断。暂停/取消仍立即生效。`,
        { stall: 'unknown', reason: verdict.reason });
      return;
    }
    stallEnding = {
      reason: suspectReason ?? 'unknown',
      sinceProgress: Math.max(now - tracker.lastProgressAt, 0),
      sinceBytes: Math.max(now - tracker.lastByteAt, 0),
    };
    endPromise = endStalledChild(true, verdict.reason).catch((error) => ({
      proven: false, terminal: null, reason: `停滞收尾异常：${error.message}；未启动第二个执行者`,
    }));
  }
  if (useStall) {
    stallTimer = setInterval(() => {
      if (monitorBusy || stallEnding || endPromise || naturalExit) return;
      monitorBusy = true;
      void monitorTick().finally(() => { monitorBusy = false; });
    }, stall.checkIntervalMs);
  }

  // Late-output guard: after a terminal/blocked disposition the old child is
  // detached (listeners removed, stdio destroyed) so its late output can
  // neither reset timers nor append events to the finished job. The handle
  // stays for the exit record and shutdown cleanup; exactly one outcome is
  // ever returned from here, hence exactly one completion is ever posted.
  function detachChild() {
    try { child.stdout.removeAllListeners('data'); } catch {}
    try { child.stderr.removeAllListeners('data'); } catch {}
    try { child.stdout.destroy(); } catch {}
    try { child.stderr.destroy(); } catch {}
  }

  let exit = null;
  let spawnError = null;
  let exitSettled = false;
  const exitPromise = new Promise((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      exitSettled = true;
      resolve(null);
    });
    child.once('exit', (code, signal) => {
      if (!killSent) naturalExit = true;
      exitSettled = true;
      resolve({ code, signal });
    });
  });
  try {
    if (!useStall) {
      exit = await exitPromise;
    } else {
      // Wait for the first of: natural child exit, or a settled stall
      // disposition. endPromise is created asynchronously by the monitor, so
      // poll for it: awaiting only the child here would hang forever exactly
      // when the failure path must terminate (gateway down, kill ineffective).
      let ending = null;
      while (!exitSettled) {
        if (endPromise) {
          ending = await endPromise; // bounded by construction (gate timeouts, kill graces, query timeouts)
          break;
        }
        await Promise.race([exitPromise, wait(50)]);
      }
      if (exitSettled) {
        exit = await exitPromise;
        // The exit won the race but a disposition may also be ready (confirmed
        // just as the child exited on its own).
        if (!ending && endPromise) ending = await endPromise;
      }
      if (ending && (ending.terminal || !ending.proven)) {
        if (!exitSettled) {
          await Promise.race([exitPromise, wait(250)]);
          detachChild();
        }
        pendingEnding = ending;
      } else if (!exitSettled) {
        exit = await exitPromise;
      }
    }
  } finally {
    clearInterval(heartbeat);
    if (stallTimer) clearInterval(stallTimer);
    activeChildren.delete(job.id);
    spec.cleanup?.();
  }
  if (!exit && spawnError && !endPromise) throw spawnError;
  const ending = pendingEnding ?? (endPromise ? await endPromise : null);
  if (stdout.trim()) parseLine(job, stdout, state);
  const repoAfter = await snapshotRepo(job.workspace);

  if (state.action === 'pause' || ending?.terminal === 'pause') {
    if (ending && !ending.exit) {
      await strandChild(job, child, '暂停时旧执行未能确认结束');
    }
    if (ending?.treeNote) state.result = state.result ? `${state.result}\n${ending.treeNote}` : ending.treeNote;
    if (!ending && useStall) {
      const treeNote = await noteResidualTree(job, child);
      if (treeNote) state.result = state.result ? `${state.result}\n${treeNote}` : treeNote;
    }
    return { stalled: false, outcome: await finishAttempt(job, workspace, repoBefore, repoAfter, state, exit, 'paused') };
  }
  if (state.action === 'cancel' || ending?.terminal === 'cancel') {
    if (ending && !ending.exit) {
      await strandChild(job, child, '取消时旧执行未能确认结束');
    }
    if (ending?.treeNote) state.result = state.result ? `${state.result}\n${ending.treeNote}` : ending.treeNote;
    if (!ending && useStall) {
      const treeNote = await noteResidualTree(job, child);
      if (treeNote) state.result = state.result ? `${state.result}\n${treeNote}` : treeNote;
    }
    return { stalled: false, outcome: await finishAttempt(job, workspace, repoBefore, repoAfter, state, exit, 'interrupted') };
  }
  async function buildBlockedOutcome(reason) {
    void event(job, 'state', `阻塞：${reason}。文件、分支与未提交改动保持原样，正式交回。`, { stall: 'blocked' });
    state.deliveryDeclared = extractDeliveryDeclaration(state.result ?? '') ?? state.deliveryDeclared;
    const blockedReceipt = await collectStructuredReceipt(job.workspace, repoBefore, repoAfter, state.deliveryDeclared, job.options?.patchBase, job.options?.patchSince);
    // P1/P3: same usage + delta pass-through as the normal path.
    if (state.usage) blockedReceipt.usage = { ...state.usage };
    const delivery = {
      ...classifyDelivery(repoBefore, repoAfter, 1, {
        deliveryMode: workspace.deliveryMode,
        declaration: state.deliveryDeclared,
      }),
      ...repoDeliveryEvidence(repoBefore, repoAfter),
      receipt: blockedReceipt,
    };
    // O6: same blocked-receipt extras as the normal path.
    const extras = await collectReceiptExtras(job, repoAfter, delivery.state === 'blocked_local_changes');
    return {
      status: 'blocked',
      result: `${state.result || reason}${extras.text}`,
      error: reason,
      delivery: { ...delivery, ...(extras.scratchFiles.length ? { scratchFiles: extras.scratchFiles } : {}) },
    };
  }

  if (ending && !ending.proven) {
    let reason = ending.reason;
    // 整棵执行树未证明停止（无论根进程是否已退出）：脱钩并持久跟踪
    // （Worker 重启不丢失），确认整树停止前同工作区互斥；追踪同样写入回执与时间线。
    const record = await strandChild(job, child, ending.reason, ending.known ?? []);
    if (!ending.exit && record.pid != null) {
      reason += `（旧执行 PID ${record.pid} 仍在运行，已脱钩持久跟踪，Worker 关机时结束）`;
    } else {
      reason += `（已持久跟踪 ${record.tree.length} 个进程身份，确认整树停止前同工作区不启动新执行）`;
    }
    return { stalled: false, outcome: await buildBlockedOutcome(reason) };
  }
  if (ending?.proven && !naturalExit) {
    // 旧执行已确认结束，且退出是由停滞收尾触发：交由 execute() 做预算/网关复核后同 session 恢复。
    // 自然退出的不算停滞（疑似属于误报），走正常回执。
    return {
      stalled: true,
      state,
      exit: ending.exit,
      repoAfter,
      ending: stallEnding,
      lastProgressAt: tracker.lastProgressAt,
      evidence: buildStallEvidence(state, ending.exit, repoAfter),
    };
  }
  if (ending?.proven && naturalExit) {
    updateEntry(job.id, { stallState: null });
    void event(job, 'state', '旧执行在收尾前自行退出，停滞疑似属于误报，按正常回执处理。', { stall: false });
  }
  return { stalled: false, outcome: await finishAttempt(job, workspace, repoBefore, repoAfter, state, exit, null) };
}

/**
 * O6: receipt-text extras. Blocked_local_changes carries the dirty-file list
 * in 正文; any runner self-written scratch receipt is collected back in.
 * Best-effort: failures yield empty extras, never a failed job.
 */
async function collectReceiptExtras(job, repoAfter, includeChanges) {
  const sections = [];
  if (includeChanges) {
    try {
      const changes = formatLocalChangesSection(repoAfter);
      if (changes) sections.push(changes);
    } catch { /* harness git facts already stand on their own */ }
  }
  let scratchFiles = [];
  try {
    const entries = await readScratchReceipts(scratchDirForJob(job.id));
    const scratch = formatScratchSection(entries);
    if (scratch) sections.push(scratch);
    scratchFiles = entries.map((entry) => entry.skipped
      ? `${entry.name} (skipped: ${entry.skipped})`
      : entry.name);
  } catch { /* scratch is best-effort */ }
  return { text: sections.length ? `\n\n${sections.join('\n\n')}` : '', scratchFiles };
}

async function finishAttempt(job, workspace, repoBefore, repoAfter, state, exit, forcedStatus) {  // Declarations can span streamed text parts; the joined result is authoritative.
  state.deliveryDeclared = extractDeliveryDeclaration(state.result ?? '') ?? state.deliveryDeclared;
  const buildDelivery = async (after, declaration) => {
    const receipt = await collectStructuredReceipt(
      job.workspace,
      repoBefore,
      after,
      declaration,
      job.options?.patchBase,
      job.options?.patchSince,
    );
    // P1 cost ledger: attach runner-reported usage when observed; otherwise the
    // receipt carries no usage field and the server ledger stays empty.
    if (state.usage) receipt.usage = { ...state.usage };
    return {
      ...classifyDelivery(repoBefore, after, exit?.code ?? 1, {
        deliveryMode: workspace.deliveryMode,
        declaration,
      }),
      ...repoDeliveryEvidence(repoBefore, after),
      receipt,
    };
  };
  let delivery = await buildDelivery(repoAfter, state.deliveryDeclared);
  if (forcedStatus === 'pause' || state.action === 'pause') {
    return { status: 'paused', result: state.result, delivery };
  }
  if (forcedStatus === 'interrupted' || state.action === 'cancel') {
    return { status: 'interrupted', result: state.result, delivery };
  }
  // Gate on the normalized declaration (tests in any accepted shape).
  const autoGate = autoCommitEligibility({
    job, delivery, declaration: delivery.declared ?? null, before: repoBefore, after: repoAfter, exitCode: exit?.code ?? 1,
  });
  if (autoGate.ok) {
    const auto = await autoCommitAndPush(job.workspace, { job, declaration: delivery.declared ?? null, after: repoAfter });
    const committedAfter = (await snapshotRepo(job.workspace)) ?? repoAfter;
    // Nothing committed (commit refused / hook failed): the runner's own
    // declaration stands and the receipt stays blocked exactly as before.
    const nowCommitted = auto.committed || !repoAfter.dirty;
    const declaration = nowCommitted
      ? { ...state.deliveryDeclared, committed: true, pushed: auto.pushed }
      : state.deliveryDeclared;
    repoAfter = committedAfter;
    delivery = { ...(await buildDelivery(committedAfter, declaration)), autoCommit: { ...auto, reason: autoGate.reason } };
    void event(job, 'state', auto.pushed
      ? `Worker 自动提交候选：runner 未提交但申报测试全 pass，已 commit+push ${auto.sha?.slice(0, 12) ?? ''}`
      : `Worker 自动提交未完成：${auto.error ?? 'unknown'}；按阻塞回执交回`, { autoCommit: auto.pushed ? 'pushed' : 'failed' });
  } else if (autoGate.applicable) {
    delivery = { ...delivery, autoCommit: { skipped: autoGate.reason } };
  }
  if (delivery.state === 'blocked_local_changes' || delivery.state === 'blocked_unpushed') {
    // O6: blocked receipts carry the dirty-file list in 正文 (status --short
    // plus parsed dirtyFiles) plus any runner self-written scratch receipt.
    const extras = await collectReceiptExtras(job, repoAfter, delivery.state === 'blocked_local_changes');
    return {
      status: 'blocked',
      result: `${state.result || 'runner left unfinished local work'}${extras.text}`,
      delivery: { ...delivery, ...(extras.scratchFiles.length ? { scratchFiles: extras.scratchFiles } : {}) },
    };
  }
  if (deliveryCompletesJob(delivery, exit?.code ?? 1)) {
    return {
      status: 'done',
      result: state.result || (exit?.code === 0
        ? 'runner exited successfully'
        : `delivery completed before runner exited code=${exit?.code}`),
      delivery,
    };
  }
  return {
    status: 'failed',
    result: state.result,
    error: `${job.runner} exited code=${exit?.code} signal=${exit?.signal}`,
    delivery,
  };
}

/**
 * WP-C deterministic closure execution. Runs job.options.closureCommand
 * directly (no model, no stall watchdog, no session resume). The receipt is
 * the raw script stdout/stderr; delivery is derived from the final JSON
 * report only. Git facts are still collected by the harness.
 */
async function executeClosure(job, workspace, repoBefore, options = {}) {
  const closureCommand = job.options?.closureCommand;
  const kind = closureCommand?.kind === 'deploy' ? 'deploy' : 'merge';
  if (options.mode && options.mode !== 'start') {
    await event(job, 'state', 'closure job 不支持续跑，请 task_retry（直接按 failed 收尾）。', { closure: kind });
    const refusal = closureResumeFailure(kind);
    const repoAfter = await snapshotRepo(job.workspace);
    const receipt = await collectStructuredReceipt(
      job.workspace, repoBefore, repoAfter, null, job.options?.patchBase,
    );
    return {
      status: 'failed',
      result: refusal.result,
      error: refusal.error,
      delivery: {
        ...refusal.delivery,
        ...repoDeliveryEvidence(repoBefore, repoAfter),
        receipt: { ...receipt, ...refusal.delivery.receipt },
      },
    };
  }
  const target = selectClosureTarget(closureCommand, process.platform);
  // The gate script comes from this worker's release tree, not from the repo
  // under test (see resolveClosureScript). Unresolvable = fail closed before
  // anything runs.
  const script = resolveClosureScript(target.file, WORKER_RELEASE_ROOT);
  if (!script.ok) {
    await event(job, 'state', `确定性收口未启动 ${kind}：${script.reason}`, { closure: kind });
    const refusal = closureNotStartedFailure(kind, script.reason);
    const repoAfter = await snapshotRepo(job.workspace);
    const receipt = await collectStructuredReceipt(
      job.workspace, repoBefore, repoAfter, null, job.options?.patchBase,
    );
    return {
      ...refusal,
      delivery: {
        ...refusal.delivery,
        ...repoDeliveryEvidence(repoBefore, repoAfter),
        receipt: { ...receipt, ...refusal.delivery.receipt },
      },
    };
  }
  await event(job, 'state', `确定性收口启动 ${kind}：${target.file}`, { closure: kind });
  const perms = job.permissions ?? {};
  const envOverlay = perms.ssh === true ? {} : sshDeniedEnv();
  const run = await runClosureScript({
    file: script.path,
    args: target.args ?? [],
    cwd: job.workspace,
    env: envOverlay,
    timeoutMs: Number(closureCommand.timeoutMs) || (kind === 'merge' ? 45 * 60 * 1000 : 20 * 60 * 1000),
  });
  const repoAfter = await snapshotRepo(job.workspace);
  const scriptReport = extractLastJsonReport(run.stdout);
  const derived = deriveClosureDelivery({ kind, exitCode: run.exitCode, scriptReport });
  // Map the script's tests array into receipt.tests via the declaration
  // channel (same normalization as LLM declarations); git facts still win.
  const declaration = scriptReport && typeof scriptReport === 'object'
    ? {
      committed: derived.delivery.declared.committed,
      pushed: derived.delivery.declared.pushed,
      stage: derived.delivery.declared.stage,
      ...(Array.isArray(scriptReport.tests) ? { tests: scriptReport.tests } : {}),
    }
    : {
      committed: derived.delivery.declared.committed,
      pushed: derived.delivery.declared.pushed,
      stage: derived.delivery.declared.stage,
    };
  const gitReceipt = await collectStructuredReceipt(
    job.workspace, repoBefore, repoAfter, declaration, job.options?.patchBase,
  );
  const receipt = {
    ...gitReceipt,
    ...(scriptReport ? { scriptReport } : {}),
    scriptExitCode: run.exitCode,
  };
  const result = formatClosureResult({
    kind,
    file: target.file,
    args: target.args ?? [],
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    stdout: run.stdout,
    stderr: run.stderr,
  });
  const delivery = {
    ...derived.delivery,
    ...repoDeliveryEvidence(repoBefore, repoAfter),
    receipt,
  };
  if (derived.jobStatus === 'done') {
    return { status: 'done', result, delivery };
  }
  return {
    status: 'failed',
    result,
    error: `closure ${kind} failed: exit=${run.exitCode}${scriptReport ? '' : ' (no script JSON report)'}`,
    delivery,
  };
}

async function execute(job, options = {}) {
  const workspace = workspaceSettings(job.workspace);
  if (!workspace) throw new Error(`workspace is outside allowlist: ${job.workspace}`);
  if (job.permissions?.shell && !cfg.allowShell) throw new Error('job requires shell but worker disallows it');
  if (job.permissions?.ssh && !cfg.allowSsh) throw new Error('job requires SSH but worker disallows it');
  if (!fs.existsSync(job.workspace)) {
    // G04: "exists or can be supplied" — a frozen projectTarget job gets one
    // clone attempt from the trusted repo mapping (provision.mjs); anything
    // else still refuses here with the reason in the error.
    provisionWorkspace(job, { repos: cfg.repos, root: workspace.path, workerId });
  }
  // PC worktree supply gap: a worktree-style checkout carries no
  // node_modules. In supply context (frozen projectTarget) top up whichever
  // of server/web/worker lacks node_modules with VPS-supply semantics.
  {
    const frozen = frozenTargetOf(job);
    if (frozen?.repoId) {
      const filled = ensureNodeModules(job.workspace, { repoId: frozen.repoId, repos: cfg.repos });
      if (filled.installed.length > 0) {
        console.log(`[${job.id.slice(0, 8)}] worktree deps installed: ${filled.installed.join(',')}`);
      }
    }
  }
  // G01: per-claim realpath containment — a symlink inside the allowlist that
  // resolves outside it must be refused before spawn.
  try {
    resolveWorkspaceTarget(workspace.path, job.workspace);
  } catch (error) {
    throw new Error(`workspace realpath check failed for ${job.workspace}: ${error.message}`);
  }
  // O6: per-job scratch dir for runner self-written receipts (best-effort).
  try {
    fs.mkdirSync(scratchDirForJob(job.id), { recursive: true });
  } catch { /* receipt channel is best-effort */ }

  // WP-C: deterministic closure jobs bypass the LLM runner, stall watchdog
  // and session resume entirely. Still goes through /start so the server
  // lease/claim contract holds; resume modes are refused as failed.
  if (isClosureJob(job)) {
    await request(`/api/worker/jobs/${job.id}/start`, { method: 'POST', body: '{}' });
    const existingClosure = spool.jobs[job.id] ?? {};
    const repoBeforeClosure = existingClosure.repoBefore ?? await snapshotRepo(job.workspace);
    updateEntry(job.id, {
      job,
      phase: 'running',
      outcome: null,
      repoBefore: repoBeforeClosure,
      childPid: null,
      sessionId: null,
    });
    return executeClosure(job, workspace, repoBeforeClosure, options);
  }

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

  const launchWord = options.mode === 'start' ? '启动' : '恢复';
  const useStall = job.runner === 'opencode' && stallConfig.enabled;
  if (!useStall) {
    const single = await runRunnerOnce({
      job, workspace, repoBefore, stall: null, isResume: false, resumeIndex: 0, launchWord,
    });
    return single.outcome;
  }

  // OpenCode 停滞恢复循环：同一执行轮次最多自动恢复一次，预算记在持久化的
  // resumeAttempts（与重启/孤儿恢复共用，重启不归零）。每次恢复前都经网关
  // recover 复核；暂停/取消、无 session、预算耗尽、再次停滞一律正式交回，
  // 不自行换模型、扩权限或开新任务。
  let promptExtra = '';
  let currentJob = job;
  let resumeIndex = 0;
  while (true) {
    const round = await runRunnerOnce({
      job: currentJob, workspace, repoBefore, promptExtra,
      stall: stallConfig, isResume: resumeIndex > 0, resumeIndex, launchWord,
    });
    if (!round.stalled) return round.outcome;
    const session = currentJob.session_id ?? round.state.sessionId;
    let gateAction = 'continue';
    try {
      const recovered = await request(`/api/worker/jobs/${job.id}/recover`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'resume', sessionId: session }),
        signal: AbortSignal.timeout(15_000),
      });
      gateAction = recovered.action;
    } catch (error) {
      const reason = `恢复前网关复核失败（${error.message}），未拉起新执行；旧执行已确认结束，正式交回`;
      return stallTerminalOutcome(job, workspace, repoBefore, round, 'blocked', reason);
    }
    if (gateAction === 'pause') {
      return stallTerminalOutcome(job, workspace, repoBefore, round, 'paused', '停滞恢复前网关指示已暂停，不再拉起；正式交回');
    }
    if (gateAction === 'cancel') {
      return stallTerminalOutcome(job, workspace, repoBefore, round, 'interrupted', '停滞恢复前网关指示已取消，不再拉起；正式交回');
    }
    const spent = Number((spool.jobs[job.id] ?? {}).resumeAttempts ?? 0);
    const budget = canStallResume({ sessionId: session, resumeAttempts: spent, maxRecoveries: stallConfig.maxRecoveries });
    if (!budget.ok) {
      const reason = budget.reason === 'no-session'
        ? '停滞恢复需要原 session，但本轮未捕获到可用 session，给出明确阻塞；旧执行已确认结束，正式交回'
        : '同一执行轮次已自动恢复一次，预算耗尽，不再自动恢复；正式交回由规划席决定下一步';
      return stallTerminalOutcome(
        job, workspace, repoBefore, round,
        budget.reason === 'no-session' ? 'blocked' : 'failed', reason,
      );
    }
    // 约定时限守卫：job.ttl_at 是服务端派发的双方约定时限；剩余不足以
    // 安全跑完恢复轮次时直接交回，不开新执行。
    const ttlLeft = ttlRemainingMs(job.ttl_at, Date.now());
    if (ttlLeft != null && ttlLeft < stallConfig.ttlGuardMs) {
      return stallTerminalOutcome(job, workspace, repoBefore, round, 'blocked',
        `任务约定时限仅剩约${Math.max(Math.round(ttlLeft / 1000), 0)}s，不足以安全恢复；未拉起新执行，正式交回`);
    }
    // 残留互斥：同工作区的旧执行若仍被跟踪且未证实停止，不拉起新执行。
    const strand = await strandConflict(currentJob, { excludeSameJob: true });
    if (strand) {
      return stallTerminalOutcome(job, workspace, repoBefore, round, 'blocked',
        `残留互斥：${strand.reason}；未拉起新执行，正式交回`);
    }
    const nextAttempts = spent + 1;
    updateEntry(job.id, {
      resumeAttempts: nextAttempts,
      sessionId: session ?? null,
      stallState: { phase: 'recovering', recoveries: nextAttempts, at: new Date().toISOString() },
    });
    await event(job, 'state',
      `同 session 恢复中（第 ${nextAttempts} 次，仅一次）：session ${session}。`
      + '旧执行已确认结束；原 job、工作区、分支、未提交成果、授权与累计次数完整保留。',
      { stall: 'recovering', sessionId: session });
    promptExtra = buildStallResumePreamble({
      jobId: job.id,
      sessionId: session,
      stallReason: round.ending?.reason ?? 'unknown',
      lastProgressAt: round.lastProgressAt,
      observedExcerpt: round.evidence,
      attempt: nextAttempts,
      maxRecoveries: stallConfig.maxRecoveries,
    });
    currentJob = session ? { ...job, session_id: session } : job;
    resumeIndex = nextAttempts;
  }
}

async function stallTerminalOutcome(job, workspace, repoBefore, round, status, reason) {
  const repoAfter = round.repoAfter ?? await snapshotRepo(job.workspace);
  round.state.deliveryDeclared = extractDeliveryDeclaration(round.state.result ?? '') ?? round.state.deliveryDeclared;
  const receipt = await collectStructuredReceipt(
    job.workspace, repoBefore, repoAfter, round.state.deliveryDeclared, job.options?.patchBase, job.options?.patchSince,
  );
  // P1 cost ledger: same pass-through as finishAttempt (stall-resume rounds).
  if (round.state.usage) receipt.usage = { ...round.state.usage };
  const delivery = {
    ...classifyDelivery(repoBefore, repoAfter, 1, {
      deliveryMode: workspace.deliveryMode,
      declaration: round.state.deliveryDeclared,
    }),
    ...repoDeliveryEvidence(repoBefore, repoAfter),
    receipt,
  };
  await event(job, 'state', `${status === 'paused' || status === 'interrupted' ? '终止' : '阻塞'}：${reason}`, { stall: 'terminal' });
  if (status === 'paused') return { status, result: round.state.result || reason, delivery };
  if (status === 'interrupted') return { status, result: round.state.result || reason, delivery };
  return { status, result: round.state.result || reason, error: reason, delivery };
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

// Strand-mutex refusal: the claimed job is never spawned. start→complete
// keeps the server contract; the blocked receipt carries the strand reason
// as formal handoff evidence.
async function refuseStrandedJob(job, strand) {
  const reason = `残留互斥拒绝启动：${strand.reason}（源自 ${strand.record.jobId}）。未启动新执行，正式交回。`;
  const workspace = workspaceSettings(job.workspace);
  updateEntry(job.id, {
    job, phase: 'refused', outcome: null, childPid: null,
    sessionId: job.session_id ?? null,
  });
  try {
    await request(`/api/worker/jobs/${job.id}/start`, { method: 'POST', body: '{}' });
  } catch (error) {
    console.error(`[${job.id.slice(0, 8)}] refuse start failed: ${error.message}`);
    return;
  }
  const repo = await snapshotRepo(job.workspace);
  const receipt = await collectStructuredReceipt(job.workspace, repo, repo, null, job.options?.patchBase);
  const delivery = {
    ...classifyDelivery(repo, repo, 1, {
      deliveryMode: workspace?.deliveryMode ?? 'git-check',
    }),
    ...repoDeliveryEvidence(repo, repo),
    receipt,
  };
  await event(job, 'state', `拒绝启动：${reason}`, { stall: 'refused' });
  try {
    await postOutcome(job, { status: 'blocked', result: reason, error: reason, delivery });
  } catch (error) {
    console.error(`[${job.id.slice(0, 8)}] refuse completion failed: ${error.message}`);
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
    // Strand mutex at restart: resolve (verify, terminate verified
    // leftovers, re-verify) before any new spawn. Cleared records fall
    // through to the normal paths below; live ones block with a formal
    // handoff. The same-job survivor is NOT special-cased: its job is
    // already terminal, so its leftovers are reconciled like any other.
    const strand = await strandConflict(job);
    if (strand) {
      try {
        await postOutcome(job, {
          status: 'blocked',
          error: `重启恢复被残留互斥阻止：${strand.reason}（源自 ${strand.record.jobId}）。未启动新执行，正式交回。`,
        });
      } catch (error) {
        console.error(`[${job.id.slice(0, 8)}] strand-block upload failed: ${error.message}`);
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

// Capability card: cheap self-probes (runner --version, workspace/npm-cache
// writability, config readability) reported beside releaseSha so the gateway
// can refuse dispatch before a job starts. Probed once at boot, then
// re-probed every capabilityProbeIntervalMinutes (default 60); a failed probe
// only lands in the card, never takes the worker offline.
let capabilityCard = null;
const capabilityProbeIntervalMs = resolveCapabilityProbeIntervalMs(cfg);

async function refreshCard(reason) {
  try {
    capabilityCard = await refreshCapabilityCard(cfg, {
      configPath,
      workspaceRoots: workspaceEntries.map((entry) => entry.path),
      npmCacheDir: resolveNpmCacheDir(),
    });
    if (reason) console.log(`capability card refreshed (${reason})`);
  } catch (error) {
    console.error(`capability probe failed, keeping last card: ${error.message}`);
  }
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
        // W2: vps-dev release identity. releaseSha is the <sha12> release
        // directory `current` points at (null in a dev checkout);
        // pendingReleaseSha is the deferred deploy sha from
        // install-vps-worker.sh, if any. Both surface in /api/workers, so a
        // post-deploy check can verify gateway SHA == vps-dev releaseSha.
        ...buildWorkerReleaseInfo({ releaseRoot: WORKER_RELEASE_ROOT }),
        capabilityCard,
        ...cameraCapabilities(cfg),
        ...taobaoCapabilities(cfg),
      },
      bootId,
    }),
  });
}

async function main() {
  console.log(`ai-hub PC Worker → ${base} (maxConcurrent=${maxConcurrent})`);
  await refreshCard('boot');
  // Periodic re-probe: refresh the card and re-announce it via /connect so
  // /api/workers always shows a fresh card. A failed re-probe keeps the last
  // card; the worker stays online either way.
  const capabilityProbeTimer = setInterval(() => {
    if (stopping) return;
    void refreshCard('interval').then(() => {
      if (!stopping) void connect().catch((error) => console.error(`capability refresh upload failed: ${error.message}`));
    });
  }, capabilityProbeIntervalMs);
  capabilityProbeTimer.unref?.();
  let paused = false;
  let connected = false;
  // A job claimed from the server but not yet scheduled (transient local
  // failure between claim and schedule, e.g. a stale state lock after a
  // crash) is held here and retried while the server lease plausibly holds,
  // instead of being silently dropped.
  let pendingClaim = null;
  const PENDING_CLAIM_HOLD_MS = 40_000;
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
      let job = null;
      if (pendingClaim && Date.now() - pendingClaim.since < PENDING_CLAIM_HOLD_MS) {
        job = pendingClaim.job;
      } else {
        pendingClaim = null;
        const waitSeconds = activeRuns.size === 0 ? 25 : 0;
        const response = await request(`/api/worker/claim?wait=${waitSeconds}`);
        if (response.acceptingJobs === false) {
          paused = true;
          console.log('worker paused from ai-hub; running jobs continue');
          continue;
        }
        if (response.snapRequest) {
          void handleSnapRequest(
            cfg,
            response.snapRequest,
            (requestId, payload) => request(`/api/worker/snap/${encodeURIComponent(requestId)}`, {
              method: 'POST',
              body: JSON.stringify(payload),
            }),
            captureFrame,
          ).catch((error) => console.error(`camera snapshot upload failed: ${error.message}`));
        }
        if (response.taobaoRequest) {
          void handleTaobaoRequest(
            cfg,
            response.taobaoRequest,
            (requestId, payload) => request(`/api/worker/taobao/${encodeURIComponent(requestId)}`, {
              method: 'POST',
              body: JSON.stringify(payload),
            }),
            taobaoClient,
          ).catch((error) => console.error(`taobao bridge upload failed: ${error.message}`));
        }
        job = claimedJob(response);
        if (!job) {
          if (activeRuns.size > 0) await Promise.race([...activeRuns.values(), wait(1_000)]);
          continue;
        }
        console.log(`[${job.id.slice(0, 8)}] claimed ${job.runner} @ ${job.workspace}`);
      }
      try {
        updateEntry(job.id, {
          job,
          phase: 'claimed',
          outcome: null,
          childPid: null,
          sessionId: job.session_id ?? null,
          resumeAttempts: 0,
        });
        // Strand mutex at claim time: never start work on a job/workspace
        // whose old executor is still tracked alive. Refusal is a formal
        // blocked handoff, not silent idling.
        const strand = await strandConflict(job);
        if (strand) {
          console.error(`[${job.id.slice(0, 8)}] strand mutex refuses ${job.id} (from ${strand.record.jobId}): ${strand.reason}`);
          await refuseStrandedJob(job, strand);
          pendingClaim = null;
          continue;
        }
        schedule(job);
        pendingClaim = null;
      } catch (error) {
        console.error(`[${job.id.slice(0, 8)}] claim handling failed, holding server claim for retry: ${error.message}`);
        if (!pendingClaim) pendingClaim = { job, since: Date.now() };
        await wait(3_000);
        continue;
      }
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
    // G01: shutdown ends whole runner trees (process group on POSIX).
    for (const child of activeChildren.values()) killRunnerTree(child);
    for (const pid of orphanPids.values()) killPid(pid);
    for (const child of strandedChildren.values()) killRunnerTree(child);
  });
}

await main();
