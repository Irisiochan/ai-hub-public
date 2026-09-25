import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_FIXTURE_HYGIENE,
  buildStallResumePreamble,
  canStallResume,
  classifyStall,
  cleanupProvenTree,
  confirmStall,
  cpuMinWindowMs,
  cpuWindowBusy,
  createProgressTracker,
  descendantsOf,
  fingerprintEvent,
  findRow,
  isSameProcess,
  normalizeSessionTools,
  OPENCODE_STALL_DEFAULTS,
  resolveStallConfig,
  roundScopedTools,
  sessionQuerySpawnSpec,
  terminateIdentities,
  treeCpuTotal,
  ttlRemainingMs,
} from './stall.mjs';

test('resolveStallConfig keeps conservative defaults and honors overrides', () => {
  const defaults = resolveStallConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.noOutputMs, OPENCODE_STALL_DEFAULTS.noOutputMs);
  assert.equal(defaults.noProgressMs, OPENCODE_STALL_DEFAULTS.noProgressMs);
  assert.equal(defaults.diagnoseGraceMs, OPENCODE_STALL_DEFAULTS.diagnoseGraceMs);
  assert.equal(defaults.maxRecoveries, 1);
  assert.equal(defaults.cpuWatch, true);
  assert.equal(defaults.degradedConfirmMultiplier, 3);
  const custom = resolveStallConfig({
    opencodeStall: { enabled: false, noOutputMs: 500, maxRecoveries: 99 },
  });
  assert.equal(custom.enabled, false);
  assert.equal(custom.noOutputMs, 500);
  assert.equal(custom.maxRecoveries, 1);
});

test('progress tracker separates byte liveness from effective progress', () => {
  const tracker = createProgressTracker({ now: 1000 });
  tracker.noteBytes(1100);
  assert.equal(tracker.lastByteAt, 1100);
  assert.equal(tracker.lastProgressAt, 1000);
  const fresh = fingerprintEvent('tool', 't', 'new step output');
  assert.equal(tracker.noteParsed(fresh, 1200), true);
  assert.equal(tracker.lastProgressAt, 1200);
  // Exact duplicate log lines must not reset the progress timer.
  assert.equal(tracker.noteParsed(fresh, 5000), false);
  assert.equal(tracker.lastProgressAt, 1200);
  assert.equal(tracker.noteParsed(fingerprintEvent('tool', 't', 'different args'), 5100), true);
  assert.equal(tracker.lastProgressAt, 5100);
});

test('classifyStall moves watching -> suspected -> confirmed on windows', () => {
  const config = resolveStallConfig({
    opencodeStall: { noOutputMs: 1000, noProgressMs: 2000, diagnoseGraceMs: 500 },
  });
  const tracker = createProgressTracker({ now: 0 });
  assert.equal(classifyStall(500, tracker, config, null).phase, 'watching');
  const suspected = classifyStall(1200, tracker, config, null);
  assert.equal(suspected.phase, 'suspected');
  assert.equal(suspected.reason, 'no-output');
  // Still inside the diagnosis grace: not confirmed yet.
  assert.equal(classifyStall(1400, tracker, config, 1200).phase, 'suspected');
  assert.equal(classifyStall(1800, tracker, config, 1200).phase, 'confirmed');
});

test('classifyStall reports no-progress even while bytes still flow', () => {
  const config = resolveStallConfig({
    opencodeStall: { noOutputMs: 60_000, noProgressMs: 1000, diagnoseGraceMs: 500 },
  });
  const tracker = createProgressTracker({ now: 0 });
  tracker.noteBytes(1500);
  const decision = classifyStall(1500, tracker, config, null);
  assert.equal(decision.phase, 'suspected');
  assert.equal(decision.reason, 'no-progress');
});

test('confirmStall needs quiet CPU plus the grace window', () => {
  const base = { suspectAt: 600_000, diagnoseGraceMs: 180_000 };
  assert.equal(confirmStall({ ...base, now: 779_999, cpuQuiet: true }), false);
  assert.equal(confirmStall({ ...base, now: 780_000, cpuQuiet: true }), true);
  // CPU advance during the grace vetoes confirmation even after the timer.
  assert.equal(confirmStall({ ...base, now: 900_000, cpuQuiet: false }), false);
  // Degraded evidence (CPU unreadable) requires the multiplied window.
  assert.equal(confirmStall({ ...base, now: 780_000, cpuQuiet: true, cpuDegraded: true, degradedMultiplier: 3 }), false);
  assert.equal(confirmStall({ ...base, now: 1_140_000, cpuQuiet: true, cpuDegraded: true, degradedMultiplier: 3 }), true);
});

test('isSameProcess keys identity on pid plus creation time', () => {
  const a = { pid: 1234, created: '20260914013123456789' };
  assert.equal(isSameProcess(a, { pid: 1234, created: '20260914013123456789' }), true);
  assert.equal(isSameProcess(a, { pid: 1234, created: '20260914013123999999' }), false);
  assert.equal(isSameProcess(a, { pid: 4321, created: '20260914013123456789' }), false);
  assert.equal(isSameProcess(a, { pid: 1234, created: '' }), false);
  assert.equal(isSameProcess(null, a), false);
});

test('descendantsOf walks the parent chain without touching the OS', () => {
  const rows = [
    { pid: 10, ppid: 1, created: 'a', kernel: 1n, user: 1n },
    { pid: 11, ppid: 10, created: 'b', kernel: 2n, user: 2n },
    { pid: 12, ppid: 11, created: 'c', kernel: 4n, user: 4n },
    { pid: 99, ppid: 1, created: 'd', kernel: 8n, user: 8n },
  ];
  assert.deepEqual(descendantsOf(rows, 10).map((r) => r.pid), [11, 12]);
  assert.deepEqual(descendantsOf(rows, 99).map((r) => r.pid), []);
  assert.equal(findRow(rows, 12)?.created, 'c');
  assert.equal(findRow(rows, 13), null);
  assert.deepEqual(treeCpuTotal(rows, 10), { total: 14n, count: 3 });
  assert.equal(treeCpuTotal(rows, 13), null);
});

test('cleanupProvenTree covers newborns during the kill window (injected snapshots)', async () => {
  // Exact shape of the review repro: rootPid=100; first {101/100}; second
  // {101 same, 102 child of 101}; third {102 only}.
  const snap1 = [{ pid: 101, ppid: 100, created: 'c101', kernel: 1n, user: 1n }];
  const snap2 = [
    { pid: 101, ppid: 100, created: 'c101', kernel: 2n, user: 2n },
    { pid: 102, ppid: 101, created: 'c102', kernel: 0n, user: 0n },
  ];
  const snap3 = [{ pid: 102, ppid: 101, created: 'c102', kernel: 0n, user: 0n }];
  const snapshots = [snap1, snap2, snap3];
  const signaled = [];
  const verdict = await cleanupProvenTree(100, {
    query: async () => snapshots.shift() ?? [],
    signal: (pid) => { signaled.push(pid); },
  });
  // A newborn observed only once is tracked but is not signaled yet.
  assert.deepEqual(signaled, [101]);
  const { known, ...rest } = verdict;
  assert.deepEqual(rest, { attempted: [101], remaining: [102], unprovable: false });
  assert.deepEqual(known.map((k) => k.pid).sort(), [101, 102]);
});

test('cleanupProvenTree flags PID reuse as unprovable (injected snapshots)', async () => {
  const snap1 = [{ pid: 101, ppid: 100, created: 'c101', kernel: 1n, user: 1n }];
  const snap2 = [{ pid: 101, ppid: 100, created: 'c101', kernel: 1n, user: 1n }];
  const snap3 = [{ pid: 101, ppid: 100, created: 'c999-reused', kernel: 0n, user: 0n }];
  const snapshots = [snap1, snap2, snap3];
  const verdict = await cleanupProvenTree(100, {
    query: async () => snapshots.shift() ?? [],
    signal: () => {},
  });
  assert.equal(verdict.unprovable, true);
  assert.deepEqual(verdict.remaining, []);
});

test('normalizeSessionTools reads live tool-call shapes', () => {
  const rows = [
    { data: JSON.stringify({ type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'running', time: { start: 1000 }, input: {} } }), time_created: 1000 },
    { data: JSON.stringify({ type: 'tool', tool: 'sqlite', callID: 'call_2', state: { status: 'completed', time: { start: 900, end: 950 } } }), time_created: 900 },
    { data: JSON.stringify({ type: 'text', text: 'hi' }), time_created: 800 },
    { data: '{broken', time_created: 700 },
  ];
  const { tools, malformed } = normalizeSessionTools(rows);
  assert.equal(malformed, 1);
  assert.deepEqual(tools.map((t) => t.status), ['running', 'completed']);
  assert.equal(tools[0].start, 1000);
  assert.equal(tools[0].callID, 'call_1');
});

test('ttlRemainingMs parses gateway deadlines', () => {
  const now = Date.parse('2026-09-14T00:00:00Z');
  assert.equal(ttlRemainingMs('2026-09-14 00:05:00', now), 300_000);
  assert.equal(ttlRemainingMs('2026-09-13T23:59:00Z', now), -60_000);
  assert.equal(ttlRemainingMs(null, now), null);
  assert.equal(ttlRemainingMs('not-a-date', now), null);
});

test('canStallResume blocks without session or with spent budget', () => {
  assert.deepEqual(
    canStallResume({ sessionId: null, resumeAttempts: 0, maxRecoveries: 1 }),
    { ok: false, reason: 'no-session' }
  );
  assert.deepEqual(
    canStallResume({ sessionId: 'ses_1', resumeAttempts: 1, maxRecoveries: 1 }),
    { ok: false, reason: 'budget-exhausted' }
  );
  assert.deepEqual(
    canStallResume({ sessionId: 'ses_1', resumeAttempts: 0, maxRecoveries: 1 }),
    { ok: true, reason: null }
  );
});

test('resume preamble carries stall cause and verify-first orders', () => {
  const preamble = buildStallResumePreamble({
    jobId: 'job-1',
    sessionId: 'ses_abc',
    stallReason: 'no-output',
    lastProgressAt: 1700000000000,
    observedExcerpt: 'browser check EXIT:1',
    attempt: 1,
    maxRecoveries: 1,
  });
  assert.match(preamble, /ses_abc/);
  assert.match(preamble, /job-1/);
  assert.match(preamble, /先核对完成到哪一步/);
  assert.match(preamble, /不要重复提交\/推送\/部署/);
  assert.match(preamble, /browser check EXIT:1/);
  assert.match(preamble, /WINDOWTITLE/);
  assert.match(BROWSER_FIXTURE_HYGIENE, /不要依赖 WINDOWTITLE/);
});

test('resume preamble truncates long observed output', () => {
  const preamble = buildStallResumePreamble({
    jobId: 'job-1',
    sessionId: 'ses_abc',
    stallReason: 'no-progress',
    lastProgressAt: null,
    observedExcerpt: `x`.repeat(5000),
    attempt: 1,
    maxRecoveries: 1,
  });
  assert.ok(preamble.length < 4000);
});

test('roundScopedTools drops stale running parts from earlier rounds', () => {
  const roundStart = 1_789_161_900_000;
  const tools = [
    { callID: 'old', tool: 'bash', status: 'running', start: roundStart - 13 * 60_000 },
    { callID: 'slack', tool: 'bash', status: 'running', start: roundStart - 1_000 },
    { callID: 'new', tool: 'bash', status: 'running', start: roundStart + 5_000 },
    { callID: 'unknown', tool: 'bash', status: 'running', start: null },
  ];
  assert.deepEqual(roundScopedTools(tools, roundStart).map((t) => t.callID), ['slack', 'new', 'unknown']);
  assert.equal(roundScopedTools(tools, undefined).length, 4);
});

test('cpuWindowBusy ignores idle runner noise but sees a busy tree', () => {
  const ms = (v) => BigInt(Math.round(v * 10_000));
  const base = { baselineCpu: ms(1000), baselineAt: 0, epsilonMs: 50, busyRatio: 0.05, minWindowMs: 30_000 };
  // Measured idle OpenCode: ~62ms per 5s at worst -> 372ms over 30s (1.2%).
  assert.equal(cpuWindowBusy({ ...base, cpu: ms(1000 + 372), now: 30_000 }), false);
  // A per-tick 62ms delta must not count before the window is full.
  assert.equal(cpuWindowBusy({ ...base, cpu: ms(1000 + 5_000), now: 5_000 }), false);
  // A tool using a quarter core for 30s is alive.
  assert.equal(cpuWindowBusy({ ...base, cpu: ms(1000 + 7_500), now: 30_000 }), true);
  assert.equal(cpuWindowBusy({ ...base, baselineCpu: null, cpu: ms(9_999), now: 30_000 }), false);
  const cfg = resolveStallConfig({});
  assert.equal(cfg.cpuBusyRatio, 0.05);
  assert.equal(cpuMinWindowMs(cfg), 30_000);
  assert.equal(cpuMinWindowMs(resolveStallConfig({ opencodeStall: { diagnoseGraceMs: 500, checkIntervalMs: 50 } })), 500);
});
test('sessionQuerySpawnSpec keeps the SQL one argument through the cmd shim', () => {
  const win = sessionQuerySpawnSpec('C:/npm/opencode.cmd', 'ses_abc123', 'win32');
  assert.equal(win.options.windowsVerbatimArguments, true);
  assert.deepEqual(win.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(
    win.args[3],
    `""C:/npm/opencode.cmd" db --format json "SELECT data, time_created FROM part WHERE session_id='ses_abc123' ORDER BY time_created DESC LIMIT 100""`
  );
  const posix = sessionQuerySpawnSpec(undefined, 'ses_abc123', 'linux');
  assert.equal(posix.file, 'opencode');
  assert.equal(posix.args.length, 4);
});
const winOnly = { skip: process.platform !== 'win32' };

test('dead parent remains evidence for newborns during termination', winOnly, async () => {
  const row = (pid, ppid) => ({ pid, ppid, created: String(pid) });
  const snapshots = [[row(101, 100)], [row(102, 101)], [row(102, 101)]];
  const result = await terminateIdentities([row(101, 100)], {
    query: async () => snapshots.shift(), signal: () => {}, waitMs: 1,
  });
  assert.equal(result.unprovable, true);
});

test('cleanup checks pre-kill identities even when parent chain disappeared', winOnly, async () => {
  const row = (pid, ppid) => ({ pid, ppid, created: String(pid) });
  const live = [row(102, 101)];
  const result = await cleanupProvenTree(100, {
    known: [row(100, 1), row(101, 100), row(102, 101)],
    query: async () => live, signal: () => {},
  });
  assert.ok(result.remaining.includes(102));
});

test('restart holds unknown descendants of an already dead tracked parent', winOnly, async () => {
  const row = (pid, ppid) => ({ pid, ppid, created: String(pid) });
  const result = await terminateIdentities([row(101, 100)], {
    query: async () => [row(102, 101)], signal: () => assert.fail('unproven descendant must not be killed'), waitMs: 1,
  });
  assert.equal(result.unprovable, true);
});

test('terminateIdentities keeps a descendant born after the strand snapshot (review B3 repro)', winOnly, async () => {
  // Exact review shape: persisted [101]; 102 (child of 101) is alive in all
  // snapshots and only 101 is in the list. The old version returned
  // {ended:[101],remaining:[],unprovable:false} and released the mutex.
  const row = (pid, ppid) => ({ pid, ppid, created: String(pid), kernel: 0n, user: 0n });
  const snapshots = [[row(101, 100), row(102, 101)], [row(102, 101)], [row(102, 101)]];
  const signaled = [];
  const verdict = await terminateIdentities([{ pid: 101, created: '101' }], {
    query: async () => snapshots.shift() ?? [],
    signal: (pid, sig) => { signaled.push(`${pid}:${sig}`); },
    waitMs: 1,
  });
  assert.deepEqual(verdict.remaining, [102]);
  assert.ok(signaled.includes('102:SIGTERM') && signaled.includes('102:SIGKILL'));
});

test('terminateIdentities blocks on a newborn during the kill window and ignores adopted elders', winOnly, async () => {
  const row = (pid, ppid, created) => ({ pid, ppid, created, kernel: 0n, user: 0n });
  // 50 claims parent 101 but was created before it: a stale ppid, not ours.
  const first = [row(101, 100, '20260914000010'), row(50, 101, '20260914000001')];
  const second = [row(101, 100, '20260914000010'), row(103, 101, '20260914000020')];
  const third = [row(103, 101, '20260914000020')];
  const snapshots = [first, second, third];
  const signaled = [];
  const verdict = await terminateIdentities([{ pid: 101, created: '20260914000010' }], {
    query: async () => snapshots.shift() ?? [],
    signal: (pid) => { signaled.push(pid); },
    waitMs: 1,
  });
  assert.ok(!signaled.includes(50), 'an older process with a stale ppid must never be signaled');
  assert.ok(!signaled.includes(103), 'an unproven newborn must never be signaled');
  assert.equal(verdict.unprovable, true);
});
