import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

// OpenCode stall watchdog helpers (worker-only, opencode runner only).
//
// Background: 2026-09-12 a Dashboard job hung with the OpenCode bash tool
// already having produced a browser-check result and EXIT:1, while the SQLite
// tool part stayed `running` with no new steps and the Worker kept renewing
// the lease. The plain execute path had no continuous no-progress detection
// (restart/orphan resume in recoverSpool only covers Worker restarts).
// This module holds the pure, unit-testable pieces; worker.mjs wires them
// into execute(). Other runners keep their exact previous behavior.

export const OPENCODE_STALL_DEFAULTS = {
  enabled: true,
  // How often the watchdog re-evaluates progress timestamps.
  checkIntervalMs: 5_000,
  // No stdout/stderr bytes at all for this long -> suspect stall.
  noOutputMs: 12 * 60_000,
  // Bytes may still flow, but no *effective* parsed progress for this long
  // -> suspect stall (prevents log-spam from resetting the timer forever).
  noProgressMs: 10 * 60_000,
  // After suspicion, keep watching this long for late progress/bytes/exit
  // before treating the run as confirmed-stalled. Never kill a normal long
  // test on a bare timer expiry.
  diagnoseGraceMs: 3 * 60_000,
  // SIGTERM -> wait -> SIGKILL -> wait per stage when ending a stalled run.
  killGraceMs: 15_000,
  // Same execution round auto-recovers at most once. Persisted in the spool
  // `resumeAttempts` field shared with restart/orphan resume so a Worker
  // restart cannot reset or bypass the budget.
  maxRecoveries: 1,
  // Recent event fingerprints remembered for duplicate suppression.
  recentFingerprints: 30,
  // Subprocess-activity evidence during the diagnosis grace: when suspected,
  // the worker samples kernel+user CPU of the whole child tree. An advance
  // beyond cpuEpsilonMs clears the suspicion (a busy long tool is not a
  // stall). Disable only to fall back to pure timer confirmation.
  cpuWatch: true,
  cpuEpsilonMs: 50,
  // Share of one core the child tree must use across the diagnosis window
  // to count as alive. Idle OpenCode + idle headless Chrome measured ~0-1.3%.
  cpuBusyRatio: 0.05,
  // When CPU evidence is unavailable (query failure), confirmation requires
  // diagnoseGraceMs * degradedConfirmMultiplier of continuous quiet, and the
  // degraded evidence is disclosed in the timeline. This is still a timer,
  // but longer and labeled — never a silent quick kill.
  degradedConfirmMultiplier: 3,
  // A single tool call observed running longer than toolLimitMs while
  // bytes/parse/CPU stay quiet is positive wedge evidence (recoverable).
  // Pure quiet without such evidence is "unknown": stop + hand back, but
  // never auto-resume.
  toolLimitMs: 600_000,
  // Pre-resume guard: when the agreed job deadline (job.ttl_at) leaves
  // less than this, block instead of starting a recovery round.
  ttlGuardMs: 300_000,
};

function toPositiveInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.floor(num), min), max);
}

export function resolveStallConfig(cfg = {}) {
  const raw = cfg?.opencodeStall && typeof cfg.opencodeStall === 'object'
    ? cfg.opencodeStall
    : {};
  return {
    enabled: raw.enabled !== false,
    checkIntervalMs: toPositiveInt(raw.checkIntervalMs, OPENCODE_STALL_DEFAULTS.checkIntervalMs, 50, 60_000),
    noOutputMs: toPositiveInt(raw.noOutputMs, OPENCODE_STALL_DEFAULTS.noOutputMs, 100, 60 * 60_000),
    noProgressMs: toPositiveInt(raw.noProgressMs, OPENCODE_STALL_DEFAULTS.noProgressMs, 100, 60 * 60_000),
    diagnoseGraceMs: toPositiveInt(raw.diagnoseGraceMs, OPENCODE_STALL_DEFAULTS.diagnoseGraceMs, 100, 30 * 60_000),
    killGraceMs: toPositiveInt(raw.killGraceMs, OPENCODE_STALL_DEFAULTS.killGraceMs, 100, 120_000),
    maxRecoveries: toPositiveInt(raw.maxRecoveries, OPENCODE_STALL_DEFAULTS.maxRecoveries, 1, 1),
    recentFingerprints: toPositiveInt(
      raw.recentFingerprints, OPENCODE_STALL_DEFAULTS.recentFingerprints, 5, 200
    ),
    cpuWatch: raw.cpuWatch !== false,
    cpuEpsilonMs: toPositiveInt(raw.cpuEpsilonMs, OPENCODE_STALL_DEFAULTS.cpuEpsilonMs, 0, 5_000),
    cpuBusyRatio: Number.isFinite(Number(raw.cpuBusyRatio))
      ? Math.min(Math.max(Number(raw.cpuBusyRatio), 0.001), 1)
      : OPENCODE_STALL_DEFAULTS.cpuBusyRatio,
    degradedConfirmMultiplier: toPositiveInt(
      raw.degradedConfirmMultiplier, OPENCODE_STALL_DEFAULTS.degradedConfirmMultiplier, 1, 10
    ),
    toolLimitMs: toPositiveInt(raw.toolLimitMs, OPENCODE_STALL_DEFAULTS.toolLimitMs, 100, 60 * 60_000),
    ttlGuardMs: toPositiveInt(raw.ttlGuardMs, OPENCODE_STALL_DEFAULTS.ttlGuardMs, 0, 60 * 60_000),
  };
}

export function fingerprintEvent(kind, type, content) {
  const normalized = `${kind ?? ''}\n${type ?? ''}\n${typeof content === 'string' ? content.slice(0, 2000) : JSON.stringify(content ?? '').slice(0, 2000)}`;
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

export function createProgressTracker(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const limit = toPositiveInt(options.recentLimit, OPENCODE_STALL_DEFAULTS.recentFingerprints, 5, 200);
  const tracker = {
    lastByteAt: now,
    lastProgressAt: now,
    startedAt: now,
    recent: [],
    progressCount: 0,
    byteCount: 0,
    noteBytes(at = Date.now()) {
      tracker.byteCount += 1;
      tracker.lastByteAt = at;
    },
    // Returns true when this fingerprint counts as NEW effective progress.
    // Consecutive duplicate log lines never reset the progress timer, so a
    // stuck tool cannot hold the watchdog off with meaningless repeats.
    noteParsed(fingerprint, at = Date.now()) {
      if (!fingerprint) return false;
      if (tracker.recent.includes(fingerprint)) return false;
      tracker.recent.push(fingerprint);
      if (tracker.recent.length > limit) tracker.recent.splice(0, tracker.recent.length - limit);
      tracker.progressCount += 1;
      tracker.lastProgressAt = at;
      return true;
    },
  };
  return tracker;
}

// Pure stall-phase decision. `suspectAt` is null while watching, otherwise
// the timestamp suspicion started.
export function classifyStall(now, tracker, config, suspectAt) {
  const sinceProgress = Math.max(now - tracker.lastProgressAt, 0);
  const sinceBytes = Math.max(now - tracker.lastByteAt, 0);
  const reason = sinceBytes >= config.noOutputMs && sinceBytes >= sinceProgress
    ? 'no-output'
    : sinceProgress >= config.noProgressMs
      ? 'no-progress'
      : sinceBytes >= config.noOutputMs
        ? 'no-output'
        : null;
  if (!reason) return { phase: 'watching', reason: null, sinceProgress, sinceBytes };
  if (suspectAt == null) return { phase: 'suspected', reason, sinceProgress, sinceBytes };
  if (now - suspectAt >= config.diagnoseGraceMs) {
    return { phase: 'confirmed', reason, sinceProgress, sinceBytes };
  }
  return { phase: 'suspected', reason, sinceProgress, sinceBytes };
}

// Pure confirmation gate used by the worker once suspicion is open. Timer
// expiry alone is necessary but not sufficient: the caller must also pass
// cpuQuiet (no child-tree CPU advance observed during the grace). When CPU
// evidence is unavailable the gate stays honest by requiring a multiplied
// quiet window and letting the caller disclose the degraded evidence.
export function confirmStall({ now, suspectAt, diagnoseGraceMs, cpuQuiet, cpuDegraded = false, degradedMultiplier = 3 }) {
  if (suspectAt == null) return false;
  if (!cpuQuiet) return false;
  const needMs = Number(diagnoseGraceMs) * (cpuDegraded ? Math.max(Number(degradedMultiplier) || 1, 1) : 1);
  return now - suspectAt >= needMs;
}

// CPU activity is judged as a rate over the accumulated diagnosis window,
// never as a per-tick delta. A live but idle OpenCode (bun) process alone
// burns 15-62ms per 5s (measured 2026-09-14 on a real wedged tool), so a
// fixed per-tick epsilon cleared every suspicion and the watchdog flapped
// forever without confirming. Returns true when the tree used more than
// epsilonMs + busyRatio of one core across a window of at least minWindowMs.
export function cpuWindowBusy({ baselineCpu, baselineAt, cpu, now, epsilonMs, busyRatio, minWindowMs }) {
  if (baselineCpu == null || cpu == null || baselineAt == null) return false;
  const elapsed = now - baselineAt;
  if (elapsed < minWindowMs || elapsed <= 0) return false;
  const advanceMs = Number(cpu - baselineCpu) / 10_000; // 100ns ticks -> ms
  return advanceMs > Math.max(Number(epsilonMs) || 0, 0) + busyRatio * elapsed;
}

export function cpuMinWindowMs(config) {
  return Math.min(config.diagnoseGraceMs, Math.max(config.checkIntervalMs * 2, 30_000));
}

// Process identity is (pid, creation-time), never the bare PID number: a
// reused PID with a different creation timestamp is a different process.
export function isSameProcess(a, b) {
  if (!a || !b) return false;
  if (!Number.isInteger(a.pid) || a.pid !== b.pid || a.pid <= 0) return false;
  const createdA = String(a.created ?? '');
  const createdB = String(b.created ?? '');
  return createdA !== '' && createdA === createdB;
}

export function canStallResume({ sessionId, resumeAttempts, maxRecoveries }) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, reason: 'no-session' };
  }
  if (Number(resumeAttempts ?? 0) >= Number(maxRecoveries ?? 1)) {
    return { ok: false, reason: 'budget-exhausted' };
  }
  return { ok: true, reason: null };
}

// Browser/fixture lifecycle convention for runner prompts. This only lowers
// the trigger probability; it never replaces the stall watchdog below.
export const BROWSER_FIXTURE_HYGIENE = [
  '后台服务/浏览器生命周期：由本轮 job 启动的 fixture 服务与 headless 浏览器归本轮所有，',
  '必须带显式超时并在用完后正常退出；不要依赖 WINDOWTITLE 批量清理，不要按进程名批量结束无关进程；',
  '优先正常关闭，确需清理时只处理能证明由本轮启动的子进程。',
].join('');

export function buildStallResumePreamble({
  jobId,
  sessionId,
  stallReason,
  lastProgressAt,
  observedExcerpt = '',
  attempt = 1,
  maxRecoveries = 1,
}) {
  const lines = [
    `[AI_HUB_STALL_RESUME] 这是同轮停滞恢复（第 ${attempt} 次，共允许 ${maxRecoveries} 次），原 job ${jobId}，续接原 OpenCode session ${sessionId}。`,
    `停滞原因：${stallReason === 'no-output' ? '长时间无任何子进程输出' : '长时间无有效进展（输出可能仍在重复但无新步骤）'}；`,
    `最后有效进展：${lastProgressAt ? new Date(lastProgressAt).toISOString() : '未知'}。`,
    '先核对完成到哪一步再动手：git status / git log 确认已提交与未提交改动，检查上轮已声明的 delivery 与测试结论，',
    '检查 fixture 服务/浏览器是否仍在运行——已在运行的不要重复启动，已完成的不要重复提交/推送/部署。',
    '上轮已产生结果但 tool 仍卡住的命令不要原样重放；先读其已输出的结果，只补没做完的那一步。',
    '若怀疑网络断连，先做一次轻量连通性检查再动手；断网未恢复时不要反复重试，直接交回并写清证据。',
    '若副作用已无法确认（不确定是否已提交/推送/部署/发消息），不要盲目重做，直接以阻塞交回并写清已确认与未确认的部分。',
    BROWSER_FIXTURE_HYGIENE,
  ];
  const excerpt = String(observedExcerpt ?? '').trim().slice(0, 2000);
  if (excerpt) {
    lines.push('上轮已观察到的结果摘录（只读，不要重复执行已完成的副作用）：');
    lines.push(excerpt);
  }
  return lines.join('\n');
}

export function describeStall({ reason, sinceProgress, sinceBytes, recoveries }) {
  const idle = reason === 'no-output'
    ? `${Math.round(sinceBytes / 1000)}s 无输出`
    : `${Math.round(sinceProgress / 1000)}s 无有效进展`;
  return `疑似停滞（${idle}；已恢复 ${recoveries ?? 0} 次）`;
}

// --- Identity-aware process enumeration (win32 + linux) --------------------
// Process identity is (pid, creation-time); a bare PID number is never
// trusted across time because both Windows and Linux reuse PIDs. Never kill
// by process name: only same-identity members of the stalled root's tree
// are ever signaled.

function runPowerShell(script, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve(null);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null);
    });
  });
}

const TABLE_SCRIPT = [
  '$rows = Get-CimInstance Win32_Process',
  'foreach ($p in $rows) {',
  '  $cd = $p.CreationDate',
  '  if ($cd -is [datetime]) { $cds = $cd.ToString("yyyyMMddHHmmssffffff") } else { $cds = "$cd" }',
  '  "$($p.ProcessId)|$($p.ParentProcessId)|$cds|$($p.KernelModeTime)|$($p.UserModeTime)|$($p.Name)"',
  '}',
].join('; ');

function parseProcessTable(raw) {
  // Expects lines of "pid|ppid|created|kernel|user|name".
  const rows = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const parts = line.trim().split('|');
    if (parts.length !== 6) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) continue;
    let kernel = null;
    let user = null;
    try { kernel = BigInt(parts[3]); user = BigInt(parts[4]); } catch { kernel = null; user = null; }
    rows.push({ pid, ppid, created: parts[2] ?? '', kernel, user, name: parts[5] ?? '' });
  }
  return rows;
}

// Linux snapshot from /proc/<pid>/stat. Identity is the kernel start time
// (field 22, clock ticks since boot), zero-padded so string order is time
// order like the Windows timestamp, and tagged with the boot id: start
// ticks restart at every boot, so an identity persisted before a reboot
// must never match or order against a process of the current boot.
// CPU is converted to the Windows 100ns unit cpuWindowBusy expects.
const PROC_START_WIDTH = 20;
let clockTicksPerSec = null;

function linuxClockTicks() {
  if (clockTicksPerSec == null) {
    const probe = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 5_000 });
    const value = Number(String(probe.stdout ?? '').trim());
    // USER_HZ is ABI-fixed at 100 on mainstream Linux; getconf only confirms.
    clockTicksPerSec = Number.isInteger(value) && value > 0 ? value : 100;
  }
  return clockTicksPerSec;
}

// Pure: one /proc/<pid>/stat line -> row, or null for unparsable lines and
// zombies (Z/X run no code and pin their PID against reuse; counting them
// would block forever on orphans an unreaping subreaper never collects).
export function parseProcStat(text, bootId, ticksPerSec = 100) {
  const raw = String(text ?? '');
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open <= 0 || close <= open || !bootId) return null;
  const pid = Number(raw.slice(0, open).trim());
  // Fields after the comm: [0]=state(3) [1]=ppid(4) [3]=session(6)
  // [11]=utime(14) [12]=stime(15) [19]=starttime(22).
  const rest = raw.slice(close + 1).trim().split(/\s+/);
  if (rest.length < 20) return null;
  if (rest[0] === 'Z' || rest[0] === 'X' || rest[0] === 'x') return null;
  const ppid = Number(rest[1]);
  const sid = Number(rest[3]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) return null;
  if (!/^\d+$/.test(rest[19])) return null;
  let kernel = null;
  let user = null;
  try {
    const unit = BigInt(Math.round(10_000_000 / ticksPerSec));
    kernel = BigInt(rest[12]) * unit;
    user = BigInt(rest[11]) * unit;
  } catch { kernel = null; user = null; }
  return {
    pid,
    ppid,
    sid: Number.isInteger(sid) && sid > 0 ? sid : null,
    created: `${rest[19].padStart(PROC_START_WIDTH, '0')}@${bootId}`,
    kernel,
    user,
    name: raw.slice(open + 1, close),
  };
}

export async function queryProcTable(procRoot = '/proc') {
  let bootId;
  let entries;
  try {
    bootId = (await fs.promises.readFile(`${procRoot}/sys/kernel/random/boot_id`, 'utf8')).trim();
    entries = await fs.promises.readdir(procRoot);
  } catch {
    return null;
  }
  if (!bootId) return null;
  const ticks = linuxClockTicks();
  const rows = [];
  await Promise.all(entries.filter((name) => /^\d+$/.test(name)).map(async (name) => {
    let text;
    try {
      text = await fs.promises.readFile(`${procRoot}/${name}/stat`, 'utf8');
    } catch {
      return; // exited between readdir and read: simply absent
    }
    const row = parseProcStat(text, bootId, ticks);
    if (row) rows.push(row);
  }));
  // A /proc that cannot even see this process is not a usable table
  // (e.g. hidepid or a foreign pid namespace): report unprovable.
  if (!rows.some((row) => row.pid === process.pid)) return null;
  return rows;
}

export function processTableSupported(platform = process.platform) {
  return platform === 'win32' || platform === 'linux';
}

// One full snapshot: [{ pid, ppid, created, kernel, user }] (+ sid on linux).
// Returns null when enumeration is unavailable (other platforms), forced off
// for tests (OPENCODE_STALL_FORCE_NO_ENUM=1), or the query fails. Null always
// means "ownership unprovable" to the caller — never "tree is empty".
export async function queryProcessTable() {
  if (!processTableSupported()) return null;
  if (process.env.OPENCODE_STALL_FORCE_NO_ENUM === '1') return null;
  if (process.platform === 'linux') return queryProcTable();
  const raw = await runPowerShell(TABLE_SCRIPT);
  if (raw == null) return null;
  return parseProcessTable(raw);
}

export function findRow(rows, pid) {
  return (rows ?? []).find((row) => row.pid === pid) ?? null;
}

// Pure: same-identity members of rootPid's tree (rows carry identity).
// Linux reparents orphans to init/a subreaper, so the ppid chain alone loses
// a dead root's survivors (Windows keeps the stale ppid instead). The POSIX
// runner is spawned detached, i.e. as leader of its own session, and the
// kernel never hands out a PID still in use as a session id: rows whose sid
// is rootPid are members of that root's session, orphaned or not.
export function descendantsOf(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows ?? []) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const out = [];
  const sessionMembers = (rows ?? []).filter((row) => row.sid != null && row.sid === rootPid && row.pid !== rootPid);
  const queue = [...(byParent.get(rootPid) ?? []), ...sessionMembers];
  const seen = new Set([rootPid]);
  while (queue.length) {
    const row = queue.shift();
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    out.push(row);
    for (const child of byParent.get(row.pid) ?? []) queue.push(child);
  }
  return out;
}

// Pure: kernel+user CPU over root + same-snapshot descendants. Returns null
// when the root row itself is absent (exited or never existed).
export function treeCpuTotal(rows, rootPid) {
  const root = findRow(rows, rootPid);
  if (!root || root.kernel == null) return null;
  let total = root.kernel + root.user;
  let count = 1;
  for (const member of descendantsOf(rows, rootPid)) {
    if (member.kernel == null) continue;
    total += member.kernel + member.user;
    count += 1;
  }
  return { total, count };
}

// Graceful termination of only same-identity descendants of rootPid.
// `deps` is a test seam: { query: () => rows|null, signal: (pid) => void }.
// The final proof covers not just the original targets but every process
// ever observed in the tree plus brand-new tree rows: newborns during the
// kill window, identity changes, chain breaks, or any unprovable state all
// BLOCK (remaining non-empty or unprovable true). Only
// unprovable === false && remaining.length === 0 may resume.
export async function cleanupProvenTree(rootPid, deps = {}) {
  const query = deps.query ?? queryProcessTable;
  const signal = deps.signal ?? ((pid) => process.kill(pid, 'SIGTERM'));
  if (!processTableSupported() || !Number.isInteger(rootPid) || rootPid <= 0) {
    return { attempted: [], remaining: [], unprovable: true };
  }
  const first = await query();
  if (!first) return { attempted: [], remaining: [], unprovable: true };
  // Ownership history: every pid ever seen parented into this tree, with
  // the identity it had when observed.
  const seen = new Map((deps.known ?? []).filter((r) => r?.created).map((r) => [r.pid, r]));
  const historical = inspectProcessHistory(first, [...seen.values()]);
  if (historical.unprovable) return { attempted: [], remaining: historical.remaining, unprovable: true, known: [...seen.values()] };
  for (const member of descendantsOf(first, rootPid)) seen.set(member.pid, member);
  const second = await query();
  if (!second) return { attempted: [], remaining: [], unprovable: true };
  let unprovable = false;
  const secondByPid = new Map(second.map((row) => [row.pid, row]));
  for (const member of descendantsOf(second, rootPid)) {
    const prev = seen.get(member.pid);
    if (!prev) {
      seen.set(member.pid, member); // newborn between snapshots: observed once
      continue;
    }
    if (member.ppid !== prev.ppid || !isSameProcess(member, prev)) {
      // Identity changed or chain broke mid-cleanup: the new identity was
      // never proven ours — do not signal it, stay blocked.
      unprovable = true;
      seen.delete(member.pid);
    }
  }
  // Kill only twice-verified same-identity members (present in both
  // snapshots with identical identity and parent link). On Linux an orphan
  // is reparented when its parent dies, so the link of a known identity may
  // legitimately change; (pid, start time) alone still proves it ours.
  const reparentOk = process.platform === 'linux';
  const targets = [...seen.values()].filter((member) => {
    const current = secondByPid.get(member.pid);
    const previous = findRow(first, member.pid);
    return current
      && previous && isSameProcess(previous, current)
      && (current.ppid === member.ppid || reparentOk)
      && isSameProcess(current, member);
  });
  const attempted = [];
  // Youngest-first is only a shutdown-order heuristic.
  for (const target of [...targets].reverse()) {
    try { signal(target.pid); attempted.push(target.pid); } catch {}
  }
  // Signal delivery is asynchronous (on Linux a SIGTERMed node needs a few
  // ms to exit): re-snapshot, bounded, while a signaled identity still lives,
  // so the final proof does not race the kill it is proving.
  const settleMs = Math.max(Number(deps.settleMs ?? 2_000) || 0, 0);
  const settleDeadline = Date.now() + settleMs;
  const signaledLive = (rows) => attempted.some((pid) => {
    const row = findRow(rows, pid);
    return row && isSameProcess(row, seen.get(pid));
  });
  let third = await query();
  while (third && signaledLive(third) && Date.now() < settleDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    third = await query();
  }
  if (!third) return { attempted, remaining: [], unprovable: true };
  const thirdByPid = new Map(third.map((row) => [row.pid, row]));
  const remaining = [];
  for (const [pid, history] of seen) {
    const current = thirdByPid.get(pid);
    if (!current) continue; // gone: cleaned
    if (isSameProcess(history, current)) {
      remaining.push(pid); // still ours (wherever reparented now)
    } else {
      unprovable = true; // PID reused under our eyes
    }
  }
  for (const member of descendantsOf(third, rootPid)) {
    if (!seen.has(member.pid)) {
      unprovable = true; // born during the kill window: ownership unproven
    }
  }
  if (inspectProcessHistory(third, [...seen.values()]).unprovable) unprovable = true;
  // Every identity ever proven in the tree, so a blocked caller can keep a
  // durable mutex on survivors even after the root itself exited.
  const known = [...seen.values()].map(({ pid, created, name }) => ({ pid, created, name }));
  return { attempted, remaining, unprovable, known };
}

// Windows keeps a dead parent's PID in ppid, so a PID-reusing parent can
// "adopt" older processes. A real child is never created before its parent,
// nor in another boot (Linux identities end in "@<boot id>").
function bornAfter(child, parent) {
  const c = String(child?.created ?? '');
  const p = String(parent?.created ?? '');
  if (c === '' || p === '') return false;
  const [cStart, cBoot = ''] = c.split('@');
  const [pStart, pBoot = ''] = p.split('@');
  return cBoot === pBoot && cStart >= pStart;
}

// Historical parents remain evidence after exit. A newly seen child of a
// dead/reused parent cannot be safely attributed or ignored: hold the mutex.
export function inspectProcessHistory(rows, history) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const known = new Map(history.map((r) => [r.pid, r]));
  const remaining = history.filter((r) => isSameProcess(r, byPid.get(r.pid))).map((r) => r.pid);
  let unprovable = false;
  const queue = [...history];
  const visited = new Set();
  while (queue.length) {
    const parent = queue.shift();
    if (visited.has(parent.pid)) continue;
    visited.add(parent.pid);
    for (const row of rows) {
      if (row.ppid !== parent.pid || !bornAfter(row, parent)) continue;
      if (!isSameProcess(known.get(row.pid), row)) unprovable = true;
      queue.push(row);
    }
  }
  return { remaining, unprovable };
}

// Live same-identity descendants of verified members, following only
// parent links whose child was created after the parent.
function ownedDescendants(rows, members) {
  const byPid = new Map((rows ?? []).map((row) => [row.pid, row]));
  const owned = new Map();
  const queue = [...members];
  while (queue.length) {
    const parent = queue.shift();
    for (const row of descendantsOf(rows, parent.pid)) {
      if (row.ppid !== parent.pid || owned.has(row.pid)) continue;
      if (!bornAfter(row, parent)) continue;
      owned.set(row.pid, row);
      queue.push(byPid.get(row.pid) ?? row);
    }
  }
  return owned;
}

// Terminate an explicit identity list [{pid, created}] — used to reconcile a
// tracked strand on restart/claim: only same-identity rows are ever
// signaled, in at most two bounded rounds (TERM, then KILL for verified
// survivors). Returns { ended, remaining, unprovable }.
// The proof covers the whole owned tree, not just the persisted list: live
// descendants of verified members at the first snapshot are ours too and
// are terminated with them; a descendant first appearing later (born after
// the strand snapshot, during the kill window) keeps the mutex unprovable.
export async function terminateIdentities(list, deps = {}) {
  const query = deps.query ?? queryProcessTable;
  const signal = deps.signal ?? ((pid, sig) => process.kill(pid, sig));
  const waitMs = Math.max(Number(deps.waitMs) || 3000, 0);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (!processTableSupported()) return { ended: [], remaining: [], unprovable: true };
  const wanted = (list ?? []).filter((t) => Number.isInteger(t?.pid) && t.pid > 0 && t.created);
  if (wanted.length === 0) return { ended: [], remaining: [], unprovable: true };
  const first = await query();
  if (!first) return { ended: [], remaining: [], unprovable: true };
  const firstByPid = new Map(first.map((row) => [row.pid, row]));
  const known = new Map();
  for (const t of wanted) {
    const current = firstByPid.get(t.pid);
    if (current && isSameProcess({ pid: t.pid, created: t.created }, current)) known.set(t.pid, current);
  }
  for (const [pid, row] of ownedDescendants(first, [...known.values()])) {
    if (!known.has(pid)) known.set(pid, row);
  }
  if (known.size === 0) return { ended: [], ...inspectProcessHistory(first, wanted) };
  const aliveIn = (rows) => {
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    return [...known.values()].filter((member) => {
      const current = byPid.get(member.pid);
      return current && isSameProcess(member, current);
    });
  };
  const hasNewborn = (rows) => inspectProcessHistory(rows, [...wanted, ...known.values()]).unprovable;
  for (const member of [...known.values()].reverse()) {
    try { signal(member.pid, 'SIGTERM'); } catch {}
  }
  await sleep(waitMs);
  const second = await query();
  if (!second) return { ended: [], remaining: [...known.keys()], unprovable: true };
  const survivors = aliveIn(second);
  let unprovable = hasNewborn(second, survivors);
  for (const member of survivors) {
    try { signal(member.pid, 'SIGKILL'); } catch {}
  }
  await sleep(waitMs);
  const third = await query();
  if (!third) return { ended: [], remaining: survivors.map((m) => m.pid), unprovable: true };
  const stillAlive = aliveIn(third);
  if (hasNewborn(third, stillAlive)) unprovable = true;
  const remaining = stillAlive.map((m) => m.pid);
  // gone, or PID reused by a proven-different process
  const ended = [...known.keys()].filter((pid) => !remaining.includes(pid));
  return { ended, remaining, unprovable };
}

// --- Session tool-state evidence (OpenCode's own database, read-only) ------
// Positive wedge evidence comes from the runner's own bookkeeping, not from
// our timers: part rows carry tool calls with state.status running/
// completed/error plus time.start/end. A tool call observed running past the
// agreed tool limit while bytes/parse/CPU stay quiet is a stuck tool; pure
// quiet without such evidence is "unknown", never auto-resumed.

export const OPENCODE_SESSION_ID_RE = /^ses_[A-Za-z0-9]{1,64}$/;

// null/'' must stay unknown: Number(null) is 0, which would read as epoch.
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// Pure: normalize raw part rows ([{data, time_created}]) into tool states.
export function normalizeSessionTools(rows) {
  const tools = [];
  let malformed = 0;
  for (const row of rows ?? []) {
    let data = null;
    try {
      data = typeof row?.data === 'string' ? JSON.parse(row.data) : row?.data;
    } catch {
      malformed += 1;
      continue;
    }
    if (!data || typeof data !== 'object' || data.type !== 'tool') continue;
    const state = data.state && typeof data.state === 'object' ? data.state : {};
    const status = typeof state.status === 'string' ? state.status : 'unknown';
    const start = finiteOrNull(state.time?.start) ?? finiteOrNull(row?.time_created);
    tools.push({
      callID: typeof data.callID === 'string' ? data.callID : null,
      tool: typeof data.tool === 'string' ? data.tool : 'unknown',
      status,
      start,
    });
  }
  return { tools, malformed };
}

// A killed OpenCode never finalizes its open tool part: the row stays
// `running` in the DB forever (observed 2026-09-12: one session carried two
// such rows 13 minutes apart). A resumed round on the same session must not
// read that leftover as its own stuck tool, so only calls started within
// this round (minus a small clock slack) count. Calls with an unknown start
// cannot be scoped and are kept.
export const ROUND_START_SLACK_MS = 2_000;

export function roundScopedTools(tools, roundStartedAt) {
  const floor = Number(roundStartedAt) - ROUND_START_SLACK_MS;
  if (!Number.isFinite(floor)) return [...(tools ?? [])];
  return (tools ?? []).filter((tool) => tool.start == null || tool.start >= floor);
}

// `shell: true` concatenates args without quoting, so cmd split the SQL into
// words and `opencode db` printed its help and exited 1 (seen live
// 2026-09-14: every real stall read as "session query failed"). On win32 the
// .cmd shim still needs cmd, so build one verbatim command line with the
// SQL quoted. Safe only because sessionId is regex-validated and the query
// holds no cmd metacharacters or double quotes.
export function sessionQuerySpawnSpec(opencodeCommand, sessionId, platform = process.platform) {
  const command = opencodeCommand ?? (platform === 'win32' ? 'opencode.cmd' : 'opencode');
  const sql = `SELECT data, time_created FROM part WHERE session_id='${sessionId}' ORDER BY time_created DESC LIMIT 100`;
  if (platform !== 'win32') {
    return { file: command, args: ['db', '--format', 'json', sql], options: {} };
  }
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `""${command}" db --format json "${sql}""`],
    options: { windowsVerbatimArguments: true },
  };
}

function runSessionQuery({ opencodeCommand, sessionId, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      const spec = sessionQuerySpawnSpec(opencodeCommand, sessionId);
      child = spawn(spec.file, spec.args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        ...spec.options,
      });
    } catch {
      done(null);
      return;
    }
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      done(null);
    }, Math.max(Number(timeoutMs) || 15_000, 1000));
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= 1_000_000) chunks.push(chunk);
    });
    child.once('error', () => { clearTimeout(timer); done(null); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) { done(null); return; }
      try {
        done(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        done(null);
      }
    });
  });
}

// Read-only session evidence. Returns
// { readable, known, tools, error? }.
// - readable=false: the query itself failed (CLI missing, DB locked,
//   timeout, unparsable output, oversize).
// - known=false: query worked but the session has no part rows (unknown
//   session or nothing flushed yet) — nothing can be proven either way.
// Tests point OPENCODE_STALL_FAKE_SESSION at a fixture file
// ({ tools: [{callID, tool, status, start}] }) instead of the live CLI.
export async function readSessionEvidence({ opencodeCommand, sessionId, timeoutMs = 15_000 } = {}) {
  const fakePath = process.env.OPENCODE_STALL_FAKE_SESSION;
  if (fakePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(fakePath, 'utf8'));
      const tools = Array.isArray(parsed?.tools) ? parsed.tools : [];
      return {
        readable: true,
        known: true,
        tools: tools.map((t) => ({
          callID: typeof t?.callID === 'string' ? t.callID : null,
          tool: typeof t?.tool === 'string' ? t.tool : 'unknown',
          status: typeof t?.status === 'string' ? t.status : 'unknown',
          start: finiteOrNull(t?.start),
        })),
        checkedAt: Date.now(),
      };
    } catch (error) {
      return { readable: false, known: false, tools: [], error: `fixture unreadable: ${error.message}` };
    }
  }
  if (!OPENCODE_SESSION_ID_RE.test(sessionId ?? '')) {
    return { readable: false, known: false, tools: [], error: 'no-session' };
  }
  const rows = await runSessionQuery({ opencodeCommand, sessionId, timeoutMs });
  if (!Array.isArray(rows)) {
    return { readable: false, known: false, tools: [], error: 'session query failed' };
  }
  if (rows.length === 0) {
    return { readable: true, known: false, tools: [], error: 'session has no flushed parts' };
  }
  const { tools, malformed } = normalizeSessionTools(rows);
  return {
    readable: true, known: true, tools, checkedAt: Date.now(),
    ...(malformed > 0 ? { error: `${malformed} malformed part rows ignored` } : {}),
  };
}

// --- Agreed deadline guard -------------------------------------------------
// job.ttl_at arrives via the claim payload (server spread). Remaining time
// below ttlGuardMs means the agreed window cannot fit a recovery round:
// block instead of resuming. Returns remaining ms, null when unknown.
export function ttlRemainingMs(ttlAt, nowMs = Date.now()) {
  if (typeof ttlAt !== 'string' || !ttlAt.trim()) return null;
  const text = ttlAt.trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  let ms = NaN;
  if (match) {
    const [, Y, Mo, D, h, mi, s, frac, tz] = match;
    let iso = `${Y}-${Mo}-${D}T${h}:${mi}:${s}`;
    if (frac) iso += `.${String(frac).slice(0, 3).padEnd(3, '0')}`;
    if (!tz || tz === 'Z') iso += 'Z';
    else iso += tz.includes(':') ? tz : `${tz.slice(0, 3)}:${tz.slice(3)}`;
    ms = Date.parse(iso);
  } else {
    ms = Date.parse(text);
  }
  if (!Number.isFinite(ms)) return null;
  return ms - nowMs;
}
