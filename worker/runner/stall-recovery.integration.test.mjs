import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupProvenTree } from './stall.mjs';

// Stall-recovery integration: a fake opencode CLI reproduces the 2026-09-12
// hang ("command produced a result but the tool stays running, no new
// steps"), the watchdog must resume the SAME session once, observe new
// effective steps, and produce a real receipt. No bare-timer green lights.

const TERMINATION_TIMEOUT_MS = 5_000;

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    Connection: 'close',
  });
  res.end(data);
}

function trace(msg) {
  if (process.env.STALL_DEBUG_LOG) {
    try { fs.appendFileSync(process.env.STALL_DEBUG_LOG, `${Date.now()} test ${msg}\n`); } catch {}
  }
}

function procHas(tag) {
  // Zombies expose an empty cmdline, so only live processes match.
  let found = false;
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').includes(tag)) found = true;
    } catch {}
  }
  return found;
}

function cimHas(tag) {
  if (process.platform !== 'win32') return Promise.resolve(procHas(tag));
  return new Promise((resolve) => {
    // NOTE: match node.exe only — the querying powershell.exe carries the
    // tag in its own -Command line and must not self-match.
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*${tag}*' } | ForEach-Object { $_.ProcessId }`],
    { timeout: 20_000 },
    (error, stdout) => {
      if (error) return resolve(null);
      resolve(stdout.trim().length > 0);
    });
  });
}

function writeFakeOpencode(dir) {
  const runner = path.join(dir, 'fake-opencode.mjs');
  const cmd = path.join(dir, process.platform === 'win32' ? 'fake-opencode.cmd' : 'fake-opencode');
  fs.writeFileSync(runner, `
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
// Capability-card heartbeat probe: answer like real opencode, never a round.
if (args.includes('--version')) {
  console.log('0.0.0-fake');
  process.exit(0);
}
const fakeDir = process.env.STALL_FAKE_DIR;
const mode = process.env.STALL_FAKE_MODE ?? 'hang-once';
const gcTag = process.env.STALL_GC_TAG ?? '';
// Teardown sentinel: die file ends even orphaned survivors (Windows cmd
// orphans keep cwd open and would block tmp cleanup with EPERM).
setInterval(() => {
  try { if (fs.existsSync(path.join(fakeDir, 'die'))) process.exit(0); } catch {}
}, 200).unref();
const log = (line) => fs.appendFileSync(path.join(fakeDir, 'spawns.log'), line + '\\n');
function spawnGrandchild() {
  if (!gcTag) return;
  // Attached grandchild: stays inside the job's process tree so the precise
  // cleanup must reap it (models a fixture service / headless browser).
  // NOTE: the marker rides inside the -e payload: node rejects trailing
  // CLI flags after -e with "bad option".
  spawn(process.execPath, ['-e', '/*' + gcTag + '*/setInterval(()=>{},500)'], { stdio: 'ignore' });
}
if (mode === 'steady') {
  let n = 0;
  const timer = setInterval(() => {
    n += 1;
    // Alternate tool and thinking lines: a thinking model is live progress.
    const line = n % 2 === 0
      ? { type: 'tool', tool: 'test-progress', step: n }
      : { type: 'reasoning', part: { text: 'thinking step ' + n } };
    console.log(JSON.stringify(line));
    if (n >= 10) { clearInterval(timer); setTimeout(() => process.exit(0), 100); }
  }, 150);
} else if (mode === 'cpu-busy') {
  // A genuinely busy long tool: no output for seconds, but CPU advances.
  // The watchdog must not mistake it for a stall.
  console.log(JSON.stringify({ session_id: 'ses_cpu_1' }));
  const end = Date.now() + 2500;
  while (Date.now() < end) { Math.sqrt(Math.random() * 999983); }
  console.log(JSON.stringify({ type: 'result', result: 'cpu busy round finished without output' }));
  setTimeout(() => process.exit(0), 200);
} else if (mode === 'io-wait') {
  // Quiet low-CPU wait inside the agreed tool limit, then finish alone.
  // The verdict must extend (not kill) while the tool is within limit.
  console.log(JSON.stringify({ session_id: 'ses_io_1' }));
  setTimeout(() => {
    console.log(JSON.stringify({ type: 'result', result: 'io wait finished alone' }));
    setTimeout(() => process.exit(0), 200);
  }, 2000);
} else if (mode === 'spam') {
  if (!args.includes('--session')) {
    console.log(JSON.stringify({ session_id: 'ses_spam_1' }));
    log('first');
    spawnGrandchild();
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      console.log(JSON.stringify({ type: 'log', msg: 'heartbeat' }));
      if (n >= 40) { clearInterval(timer); setInterval(() => {}, 1000); }
    }, 100);
  } else {
    const session = args[args.indexOf('--session') + 1];
    log('resume:' + session);
    fs.appendFileSync(path.join(fakeDir, 'partial.txt'), 'resumed\\n');
    console.log(JSON.stringify({ session_id: session }));
    console.log(JSON.stringify({ type: 'result', result: 'resumed round produced new steps and finished' }));
    setTimeout(() => process.exit(0), 200);
  }
} else if (!args.includes('--session')) {
  console.log(JSON.stringify({ session_id: 'ses_stall_1' }));
  console.log(JSON.stringify({ type: 'result', result: 'first round partial: browser check EXIT:1' }));
  fs.appendFileSync(path.join(fakeDir, 'partial.txt'), 'partial\\n');
  spawnGrandchild();
  log('first');
  setInterval(() => {}, 1000);
} else {
  const session = args[args.indexOf('--session') + 1];
  log('resume:' + session);
  fs.appendFileSync(path.join(fakeDir, 'partial.txt'), 'resumed\\n');
  if (mode === 'hang-always') {
    console.log(JSON.stringify({ session_id: session }));
    setInterval(() => {}, 1000);
  } else {
    console.log(JSON.stringify({ session_id: session }));
    console.log(JSON.stringify({ type: 'result', result: 'resumed round produced new steps and finished' }));
    setTimeout(() => process.exit(0), 200);
  }
}
`, 'utf8');
  fs.writeFileSync(
    cmd,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${runner}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${runner}" "$@"\n`,
    'utf8'
  );
  if (process.platform !== 'win32') fs.chmodSync(cmd, 0o755);
  return cmd;
}

function startStub({ job, onEvent, completions, resolveCompleted }) {
  const running = new Set();
  const state = { paused: false, suspected: false, completes: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/worker/connect') {
      return json(res, 200, { worker: { id: 'stall-test', acceptingJobs: true, status: 'online' } });
    }
    if (req.method === 'GET' && url.pathname === '/api/worker/reconcile') {
      return json(res, 200, { jobs: [] });
    }
    if (req.method === 'GET' && url.pathname === '/api/worker/claim') {
      const next = job.queue.shift() ?? null;
      if (next) running.add(next.id);
      return json(res, 200, { job: next, acceptingJobs: true, protocolVersion: 2, deliveryContract: '' });
    }
    const match = url.pathname.match(/^\/api\/worker\/jobs\/([^/]+)\/(start|events|heartbeat|complete|recover)$/);
    if (!match) return json(res, 404, { error: 'not found' });
    const [, jobId, action] = match;
    if (action === 'start') return json(res, 200, { ok: true });
    if (action === 'heartbeat') {
      if (job.failGateAfterSuspect && state.suspected
        && (!job.failGateJobs || job.failGateJobs.includes(jobId))) {
        return json(res, 500, { error: 'simulated gateway failure' });
      }
      return json(res, 200, { action: state.paused ? 'pause' : 'continue', status: 'running' });
    }
    if (action === 'recover') {
      if (job.failRecover) {
        let drained = '';
        req.on('data', (chunk) => { drained += chunk; });
        req.on('end', () => json(res, 500, { error: 'simulated recover failure' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        state.recovers = [...(state.recovers ?? []), JSON.parse(body)];
        json(res, 200, { ok: true, action: state.paused ? 'pause' : 'continue', status: 'running' });
      });
      return;
    }
    if (action === 'events') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        onEvent(jobId, payload);
        if (payload.kind === 'state' && payload.content.includes('疑似停滞')) {
          state.suspected = true;
          if (job.pauseAfterSuspect) state.paused = true;
        }
        if (payload.kind === 'state' && payload.content.includes('停滞证据不足') && job.pauseAfterUnknown) {
          state.paused = true;
        }
        if (payload.kind === 'state' && payload.content.includes('确认停滞') && job.pauseAfterConfirm) {
          state.paused = true;
        }
        json(res, 201, { ok: true });
      });
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const outcome = JSON.parse(body);
      completions.set(jobId, outcome);
      state.completes.push({ jobId, status: outcome?.status });
      running.delete(jobId);
      json(res, 200, { ok: true });
      resolveCompleted();
    });
  });
  return { server, state };
}

function makeJob(workspace, id, extra = {}) {
  return {
    id,
    runner: 'opencode',
    workspace,
    prompt: 'local stall test',
    permissions: { write: false, shell: false, ssh: false },
    options: {},
    session_id: null,
    ttl_at: null,
    ...extra,
  };
}

// Session-tool fixture for the verdict engine (OPENCODE_STALL_FAKE_SESSION):
// a tool call observed running since `start` (epoch ms).
function writeSessionFixture(dir, tools) {
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, JSON.stringify({ tools }), 'utf8');
  return file;
}
// start: null = unscoped fixture call, first seen during this round's grace;
// the short test toolLimitMs below then makes it a stuck tool.
const STUCK_TOOL = [{ callID: 'call_1', tool: 'bash', status: 'running', start: null }];

async function runWorker(dir, config, extraEnv) {
  const worker = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'worker.mjs'), config], {
    cwd: dir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AI_HUB_WORKER_EVENT_FLUSH_MS: '100', ...extraEnv },
  });
  let output = '';
  worker.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  worker.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  return { worker, output: () => output };
}

async function stopWorker(worker) {
  trace(`stopWorker enter exitCode=${worker.exitCode}`);
  if (worker.exitCode === null) {
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill('SIGTERM');
    const forced = new Promise((resolve) => {
      const timer = setTimeout(() => {
        trace('stopWorker SIGKILL fallback');
        worker.kill('SIGKILL');
        resolve();
      }, TERMINATION_TIMEOUT_MS);
      exited.finally(() => clearTimeout(timer));
    });
    await Promise.race([exited, forced]);
  }
  trace(`stopWorker done exitCode=${worker.exitCode}`);
}

async function cleanupDir(dir) {
  trace(`cleanupDir enter ${dir}`);
  try { fs.writeFileSync(path.join(dir, 'die'), ''); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 600));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      trace(`cleanupDir done ${dir}`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  trace(`cleanupDir done-final ${dir}`);
}

function setupDir(extraConfig = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-stall-recovery-'));
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  const fakeOpencode = writeFakeOpencode(dir);
  return { dir, workspace, fakeOpencode, extraConfig };
}

async function withServer(job, handler) {
  const completions = new Map();
  const events = [];
  let resolveCompleted;
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });
  const { server, state } = startStub({
    job,
    completions,
    resolveCompleted,
    onEvent: (jobId, payload) => events.push({ jobId, ...payload }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing stub address');
  try {
    await handler({ completions, events, state, completed, port: address.port });
  } finally {
    trace('withServer closing stub');
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    trace('withServer stub closed');
  }
}

function writeConfig(dir, port, workspace, fakeOpencode, stallOverride = {}) {
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({
    serverUrl: `http://127.0.0.1:${port}`,
    token: 'stall-test.token',
    workspaces: [{ path: workspace, deliveryMode: 'trust-cli' }],
    runners: ['opencode'],
    opencodeCommand: fakeOpencode,
    allowShell: false,
    allowSsh: false,
    maxConcurrent: 1,
    opencodeStall: {
      enabled: true,
      checkIntervalMs: 50,
      noOutputMs: 500,
      noProgressMs: 800,
      diagnoseGraceMs: 500,
      killGraceMs: 1000,
      toolLimitMs: 300,
      ...stallOverride,
    },
  }), 'utf8');
  return config;
}

async function waitFor(cond, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('stall resumes the same session once and completes with a real receipt', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = { queue: [makeJob(workspace, 'stall-job-1')], pauseAfterSuspect: false };
    await withServer(job, async ({ completions, events, completed, port }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      const fixture = writeSessionFixture(dir, STUCK_TOOL);
      const { worker, output } = await runWorker(dir, config, { STALL_FAKE_DIR: dir, OPENCODE_STALL_FAKE_SESSION: fixture });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`stall resume timed out\n${output()}`)), 20_000
          )),
        ]);
        const outcome = completions.get('stall-job-1');
        assert.equal(outcome?.status, 'done');
        assert.match(outcome?.result ?? '', /resumed round produced new steps/);
        const spawns = fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8').trim().split(/\r?\n/);
        assert.deepEqual(spawns, ['first', 'resume:ses_stall_1']);
        const partial = fs.readFileSync(path.join(dir, 'partial.txt'), 'utf8');
        assert.match(partial, /partial/);
        assert.match(partial, /resumed/);
        const states = events.filter((e) => e.kind === 'state').map((e) => e.content);
        assert.ok(states.some((c) => c.includes('疑似停滞')), 'missing suspect event');
        assert.ok(states.some((c) => c.includes('同 session 恢复中')), 'missing recovery event');
        assert.ok(states.some((c) => c.includes('恢复后出现新的有效步骤')), 'missing recovered-progress event');
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('pause during stall diagnosis never auto-resumes', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = { queue: [makeJob(workspace, 'stall-job-pause')], pauseAfterSuspect: true };
    await withServer(job, async ({ completions, completed, port }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      const { worker, output } = await runWorker(dir, config, { STALL_FAKE_DIR: dir });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`pause race timed out\n${output()}`)), 20_000
          )),
        ]);
        trace('pause test completed resolved');
        assert.equal(completions.get('stall-job-pause')?.status, 'paused');
        const spawns = fs.existsSync(path.join(dir, 'spawns.log'))
          ? fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8').trim().split(/\r?\n/)
          : [];
        assert.ok(spawns.every((line) => !line.startsWith('resume:')), 'must not resume after pause');
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('a second stall after one recovery stops with an explicit failure', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = { queue: [makeJob(workspace, 'stall-job-twice')], pauseAfterSuspect: false };
    await withServer(job, async ({ completions, completed, port }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      const fixture = writeSessionFixture(dir, STUCK_TOOL);
      const { worker, output } = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir, STALL_FAKE_MODE: 'hang-always', OPENCODE_STALL_FAKE_SESSION: fixture,
      });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`second stall timed out\n${output()}`)), 30_000
          )),
        ]);
        const outcome = completions.get('stall-job-twice');
        assert.equal(outcome?.status, 'failed');
        assert.match(outcome?.error ?? '', /预算耗尽/);
        const resumes = fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8')
          .trim().split(/\r?\n/).filter((line) => line.startsWith('resume:'));
        assert.equal(resumes.length, 1);
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('worker restart keeps the spent recovery budget', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = { queue: [makeJob(workspace, 'stall-job-restart')], pauseAfterSuspect: false };
    await withServer(job, async ({ completions, completed, port, state }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      const fixture = writeSessionFixture(dir, STUCK_TOOL);
      const env = {
        STALL_FAKE_DIR: dir, STALL_FAKE_MODE: 'hang-always', OPENCODE_STALL_FAKE_SESSION: fixture,
      };
      const first = await runWorker(dir, config, env);
      try {
        await waitFor(
          () => fs.existsSync(path.join(dir, 'spawns.log'))
            && fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8').includes('resume:'),
          15_000,
          'resume spawn'
        );
      } finally {
        await stopWorker(first.worker);
      }
      const second = await runWorker(dir, config, env);
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`restart recovery timed out\n${first.output()}\n---\n${second.output()}`)), 20_000
          )),
        ]);
        assert.equal(completions.get('stall-job-restart')?.status, 'interrupted');
        assert.equal(state.completes.filter((c) => c.jobId === 'stall-job-restart').length, 1);
        const resumes = fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8')
          .trim().split(/\r?\n/).filter((line) => line.startsWith('resume:'));
        assert.equal(resumes.length, 1, 'restart must not spend the budget twice');
      } finally {
        await stopWorker(second.worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('a normal steadily-progressing run is not mistaken for a stall', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = { queue: [makeJob(workspace, 'stall-job-steady')], pauseAfterSuspect: false };
    await withServer(job, async ({ completions, events, completed, port }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode, {
        noOutputMs: 2000, noProgressMs: 2000, diagnoseGraceMs: 500,
      });
      const { worker, output } = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir, STALL_FAKE_MODE: 'steady',
      });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`steady run timed out\n${output()}`)), 15_000
          )),
        ]);
        assert.equal(completions.get('stall-job-steady')?.status, 'done');
        const states = events.filter((e) => e.kind === 'state').map((e) => e.content);
        // A transient suspect during slow CLI startup may clear on first
        // progress; what must never happen is an actual recovery or block.
        assert.ok(!states.some((c) => c.includes('恢复')), 'steady progress must not trigger recovery');
        assert.ok(!states.some((c) => c.includes('阻塞')), 'steady progress must not block');
        assert.equal(fs.existsSync(path.join(dir, 'spawns.log')), false);
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('a cpu-busy silent long tool is diagnosed as alive, not killed', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = { queue: [makeJob(workspace, 'stall-job-cpubusy')], pauseAfterSuspect: false };
    await withServer(job, async ({ completions, events, completed, port }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      const { worker, output } = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir, STALL_FAKE_MODE: 'cpu-busy',
      });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`cpu-busy run timed out\n${output()}`)), 25_000
          )),
        ]);
        const outcome = completions.get('stall-job-cpubusy');
        assert.equal(outcome?.status, 'done');
        assert.match(outcome?.result ?? '', /cpu busy round finished/);
        const states = events.filter((e) => e.kind === 'state').map((e) => e.content);
        assert.ok(!states.some((c) => c.includes('同 session 恢复中')), 'cpu activity must prevent recovery');
        assert.ok(!states.some((c) => c.includes('确认停滞')), 'cpu activity must prevent confirmation');
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('identical repeated logs still count as no-progress and recover once', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = { queue: [makeJob(workspace, 'stall-job-spam')], pauseAfterSuspect: false };
    await withServer(job, async ({ completions, completed, port }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      const fixture = writeSessionFixture(dir, STUCK_TOOL);
      const { worker, output } = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir, STALL_FAKE_MODE: 'spam', OPENCODE_STALL_FAKE_SESSION: fixture,
      });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`spam run timed out\n${output()}`)), 25_000
          )),
        ]);
        assert.equal(completions.get('stall-job-spam')?.status, 'done');
        const spawns = fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8').trim().split(/\r?\n/);
        assert.ok(spawns.includes('first'), 'spam first round must log');
        assert.equal(spawns.filter((line) => line.startsWith('resume:')).length, 1);
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('gateway failure during stall handling blocks promptly with one receipt', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = {
      queue: [makeJob(workspace, 'stall-job-gatefail')],
      pauseAfterSuspect: false,
      failGateAfterSuspect: true,
    };
    await withServer(job, async ({ completions, completed, port, state }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      const fixture = writeSessionFixture(dir, STUCK_TOOL);
      const { worker, output } = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir, OPENCODE_STALL_FAKE_SESSION: fixture,
      });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`gate-fail run timed out (failure path must terminate)\n${output()}`)), 25_000
          )),
        ]);
        const outcome = completions.get('stall-job-gatefail');
        assert.equal(outcome?.status, 'blocked');
        assert.match(outcome?.error ?? '', /网关复核失败/);
        // Late exit of the detached old process must not produce a second
        // receipt, and no second executor may start.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        assert.equal(state.completes.filter((c) => c.jobId === 'stall-job-gatefail').length, 1);
        const spawns = fs.existsSync(path.join(dir, 'spawns.log'))
          ? fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8')
          : '';
        assert.ok(!spawns.includes('resume:'), 'gateway failure must not start a second executor');
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('pre-resume gateway failure blocks without a second executor', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = {
      queue: [makeJob(workspace, 'stall-job-norecover')],
      pauseAfterSuspect: false,
      failRecover: true,
    };
    await withServer(job, async ({ completions, completed, port, state }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      const fixture = writeSessionFixture(dir, STUCK_TOOL);
      const { worker, output } = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir, OPENCODE_STALL_FAKE_SESSION: fixture,
      });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`recover-fail run timed out\n${output()}`)), 25_000
          )),
        ]);
        const outcome = completions.get('stall-job-norecover');
        assert.equal(outcome?.status, 'blocked');
        assert.match(outcome?.error ?? '', /网关复核失败/);
        assert.equal(state.completes.filter((c) => c.jobId === 'stall-job-norecover').length, 1);
        const spawns = fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8');
        assert.ok(!spawns.includes('resume:'), 'failed recover gate must not spawn');
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('unprovable enumeration blocks instead of resuming', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = { queue: [makeJob(workspace, 'stall-job-noenum')], pauseAfterSuspect: false };
    await withServer(job, async ({ completions, completed, port }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      const fixture = writeSessionFixture(dir, STUCK_TOOL);
      const { worker, output } = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir,
        OPENCODE_STALL_FORCE_NO_ENUM: '1',
        OPENCODE_STALL_FAKE_SESSION: fixture,
      });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`no-enum run timed out\n${output()}`)), 25_000
          )),
        ]);
        const outcome = completions.get('stall-job-noenum');
        assert.equal(outcome?.status, 'blocked');
        assert.match(outcome?.error ?? '', /枚举|无法证明/);
        const spawns = fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8');
        assert.ok(!spawns.includes('resume:'), 'unprovable cleanup must not resume');
        // Review B2: the root CLI did exit, but the whole tree is not proven
        // stopped — the durable mutex must still be recorded.
        const spool = JSON.parse(fs.readFileSync(path.join(dir, 'worker-state.json'), 'utf8'));
        assert.ok(spool.stranded?.['stall-job-noenum'], 'exited root with unproven tree must persist a strand');
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('pause during cleanup never resumes', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = { queue: [makeJob(workspace, 'stall-job-pause2')], pauseAfterConfirm: true };
    await withServer(job, async ({ completions, completed, port }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      const fixture = writeSessionFixture(dir, STUCK_TOOL);
      const { worker, output } = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir, OPENCODE_STALL_FAKE_SESSION: fixture,
      });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`pause-confirm timed out\n${output()}`)), 25_000
          )),
        ]);
        assert.equal(completions.get('stall-job-pause2')?.status, 'paused');
        const spawns = fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8');
        assert.ok(!spawns.includes('resume:'), 'pause during cleanup must not resume');
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('tree cleanup reaps owned grandchildren and spares strangers', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  const tag = `st${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  const gcTag = `gc${tag}`;
  const unTag = `un${tag}`;
  const stranger = spawn(process.execPath, ['-e', '/*' + unTag + '*/setInterval(()=>{},500)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  try {
    const job = { queue: [makeJob(workspace, 'stall-job-tree')], pauseAfterSuspect: false };
    await withServer(job, async ({ completions, completed, port }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      const fixture = writeSessionFixture(dir, STUCK_TOOL);
      const { worker, output } = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir, STALL_GC_TAG: gcTag, OPENCODE_STALL_FAKE_SESSION: fixture,
      });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`tree run timed out\n${output()}`)), 30_000
          )),
        ]);
        assert.equal(completions.get('stall-job-tree')?.status, 'done');
        assert.equal(await cimHas(gcTag), false, 'owned grandchild must be reaped');
        assert.equal(await cimHas(unTag), true, 'unrelated process must survive');
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    try { stranger.kill('SIGKILL'); } catch {}
    await cleanupDir(dir);
  }
});

test('a quiet in-limit tool wait finishes alone without recovery', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = { queue: [makeJob(workspace, 'stall-job-iowait')], pauseAfterSuspect: false };
    await withServer(job, async ({ completions, events, completed, port }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode, { toolLimitMs: 60_000 });
      const fixture = writeSessionFixture(dir, [
        { callID: 'call_io', tool: 'sleep', status: 'running', start: null },
      ]);
      const { worker, output } = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir, STALL_FAKE_MODE: 'io-wait', OPENCODE_STALL_FAKE_SESSION: fixture,
      });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`io-wait run timed out\n${output()}`)), 20_000
          )),
        ]);
        const outcome = completions.get('stall-job-iowait');
        assert.equal(outcome?.status, 'done');
        assert.match(outcome?.result ?? '', /io wait finished alone/);
        const states = events.filter((e) => e.kind === 'state').map((e) => e.content);
        assert.ok(!states.some((c) => c.includes('同 session 恢复中')), 'in-limit wait must not recover');
        assert.ok(!states.some((c) => c.includes('确认停滞')), 'in-limit wait must not confirm');
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('a stale running part from a killed earlier round is not read as a stuck tool', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = { queue: [makeJob(workspace, 'stall-job-stale')], pauseAfterSuspect: false, pauseAfterUnknown: true };
    await withServer(job, async ({ completions, events, completed, port, state }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      // The only running row predates this round (a killed CLI never
      // finalizes its tool part): nothing in this round is proven stuck.
      const fixture = writeSessionFixture(dir, [
        { callID: 'call_old', tool: 'bash', status: 'running', start: Date.now() - 3_600_000 },
      ]);
      const { worker, output } = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir, OPENCODE_STALL_FAKE_SESSION: fixture,
      });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`stale-part run timed out\n${output()}`)), 25_000
          )),
        ]);
        // Unknown evidence: the run is NOT ended by the watchdog; only the
        // later user pause (via the regular heartbeat) stops it.
        const outcome = completions.get('stall-job-stale');
        assert.equal(outcome?.status, 'paused');
        const states = events.filter((e) => e.kind === 'state').map((e) => e.content);
        assert.ok(states.some((c) => c.includes('停滞证据不足') && c.includes('未结束执行')), 'missing unknown-evidence event');
        assert.ok(!states.some((c) => c.includes('确认停滞') || c.includes('停止旧执行')), 'unknown evidence must not end the run');
        assert.equal(state.completes.filter((c) => c.jobId === 'stall-job-stale').length, 1);
        const spawns = fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8');
        assert.ok(!spawns.includes('resume:'), 'a stale part must not trigger auto-resume');
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('quiet without session evidence neither kills nor auto-resumes', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = { queue: [makeJob(workspace, 'stall-job-noev')], pauseAfterSuspect: false, pauseAfterUnknown: true };
    await withServer(job, async ({ completions, events, completed, port, state }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      // No OPENCODE_STALL_FAKE_SESSION: the session query cannot prove any
      // tool is stuck (the fake CLI has no DB), so the run must keep going.
      const { worker, output } = await runWorker(dir, config, { STALL_FAKE_DIR: dir });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`no-evidence run timed out\n${output()}`)), 25_000
          )),
        ]);
        const outcome = completions.get('stall-job-noev');
        assert.equal(outcome?.status, 'paused');
        const states = events.filter((e) => e.kind === 'state').map((e) => e.content);
        assert.ok(states.some((c) => c.includes('停滞证据不足') && c.includes('未结束执行')), 'missing unknown-evidence event');
        assert.ok(!states.some((c) => c.includes('确认停滞') || c.includes('停止旧执行')), 'unknown evidence must not end the run');
        assert.equal(state.completes.filter((c) => c.jobId === 'stall-job-noev').length, 1);
        const spawns = fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8');
        assert.ok(!spawns.includes('resume:'), 'unknown quiet must not auto-resume');
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('near-expiry agreed deadline blocks recovery without a new executor', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const ttlAt = new Date(Date.now() + 30_000).toISOString().slice(0, 19).replace('T', ' ');
    const job = {
      queue: [makeJob(workspace, 'stall-job-ttl', { ttl_at: ttlAt })],
      pauseAfterSuspect: false,
    };
    await withServer(job, async ({ completions, completed, port }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      const fixture = writeSessionFixture(dir, STUCK_TOOL);
      const { worker, output } = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir, OPENCODE_STALL_FAKE_SESSION: fixture,
      });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`ttl run timed out\n${output()}`)), 25_000
          )),
        ]);
        const outcome = completions.get('stall-job-ttl');
        assert.equal(outcome?.status, 'blocked');
        assert.match(outcome?.error ?? '', /约定时限/);
        const spawns = fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8');
        assert.ok(!spawns.includes('resume:'), 'expiring TTL must not spawn');
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('crashed worker heals verified leftovers before the next dispatch', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = {
      queue: [makeJob(workspace, 'stall-job-s1')],
      pauseAfterSuspect: false,
      failGateAfterSuspect: true,
      failGateJobs: ['stall-job-s1'],
    };
    await withServer(job, async ({ completions, events, completed, port, state }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      const fixture = writeSessionFixture(dir, STUCK_TOOL);
      const first = await runWorker(dir, config, { STALL_FAKE_DIR: dir, OPENCODE_STALL_FAKE_SESSION: fixture });
      try {
        await Promise.race([
          completed,
          new Promise((_, reject) => setTimeout(
            () => reject(new Error(`strand setup timed out\n${first.output()}`)), 25_000
          )),
        ]);
        assert.equal(completions.get('stall-job-s1')?.status, 'blocked');
        // The strand record must capture the whole live tree (shell + node),
        // not just the root PID: the shell dies with the worker, the node
        // survives orphaned. POSIX runners spawn without a shell (the fake
        // CLI execs node), so there the node itself is the root.
        const spool = JSON.parse(fs.readFileSync(path.join(dir, 'worker-state.json'), 'utf8'));
        const record = spool.stranded?.['stall-job-s1'];
        assert.ok(record, 'strand record must persist after blocked handoff');
        const names = (record.tree ?? []).map((t) => t.name);
        if (process.platform === 'win32') {
          assert.ok(names.some((n) => /cmd\.exe/i.test(n ?? '')), `strand must track the shell, got ${JSON.stringify(names)}`);
        }
        assert.ok(names.some((n) => /node(\.exe)?/i.test(n ?? '')), `strand must track the node child, got ${JSON.stringify(names)}`);
      } finally {
        // Crash, not shutdown: SIGKILL skips all handlers (and may land
        // mid-save, leaving a stale state lock — the restarted worker must
        // still converge).
        if (first.worker.exitCode === null) {
          first.worker.kill('SIGKILL');
          await new Promise((resolve) => first.worker.once('exit', resolve));
        }
      }
      // Restarted worker, same state file: the shell is gone with the crash
      // but the node survivor must be terminated-and-verified before job-2
      // may start on the same workspace.
      const second = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir, OPENCODE_STALL_FAKE_SESSION: fixture,
      });
      try {
        job.queue.push(makeJob(workspace, 'stall-job-s2'));
        await waitFor(
          () => completions.has('stall-job-s2'),
          120_000,
          'healed redispatch'
        );
        assert.equal(completions.get('stall-job-s2')?.status, 'done');
        const states = events.filter((e) => e.kind === 'state').map((e) => e.content);
        assert.ok(
          states.some((c) => c.includes('残留对账') || c.includes('残留互斥解除')),
          'restart must reconcile the strand on the timeline'
        );
        // The mutex released only after verified death: job-2 ran a full
        // stall→resume cycle afterwards.
        const spawns = fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8').trim().split(/\r?\n/);
        assert.ok(spawns.filter((line) => line.startsWith('resume:')).length >= 1);
      } finally {
        await stopWorker(second.worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('unverifiable strand refuses new work on the same workspace', async () => {
  const { dir, workspace, fakeOpencode } = setupDir();
  try {
    const job = {
      queue: [makeJob(workspace, 'stall-job-u1'), makeJob(workspace, 'stall-job-u2')],
      pauseAfterSuspect: false,
      failGateAfterSuspect: true,
      failGateJobs: ['stall-job-u1'],
    };
    await withServer(job, async ({ completions, completed, port }) => {
      const config = writeConfig(dir, port, workspace, fakeOpencode);
      // Forced-off enumeration: the strand record stays identity-unknown,
      // so the next dispatch on the workspace must be refused, not resumed.
      const fixture = writeSessionFixture(dir, STUCK_TOOL);
      const { worker, output } = await runWorker(dir, config, {
        STALL_FAKE_DIR: dir, OPENCODE_STALL_FORCE_NO_ENUM: '1', OPENCODE_STALL_FAKE_SESSION: fixture,
      });
      try {
        await waitFor(
          () => completions.has('stall-job-u1') && completions.has('stall-job-u2'),
          40_000,
          'strand refusal without enumeration'
        );
        assert.equal(completions.get('stall-job-u1')?.status, 'blocked');
        const refused = completions.get('stall-job-u2');
        assert.equal(refused?.status, 'blocked');
        assert.match(refused?.error ?? '', /互斥/);
        const spawns = fs.readFileSync(path.join(dir, 'spawns.log'), 'utf8').trim().split(/\r?\n/);
        assert.deepEqual(spawns, ['first'], 'refused job must never spawn');
      } finally {
        await stopWorker(worker);
      }
    });
  } finally {
    await cleanupDir(dir);
  }
});

test('live snapshots observe newborns across cleanup windows', {
  skip: !['win32', 'linux'].includes(process.platform) ? 'no process-tree enumeration on this platform' : false,
}, async () => {
  // On Windows SIGTERM is instant, so a live forking cleanup either
  // genuinely succeeds or its timing is unstable second to second; the
  // newborn-BLOCKS logic itself is pinned deterministically by the injected
  // unit test. What is stable live: two consecutive snapshots of a forking
  // tree MUST show newborns — proving the final proof has something to
  // cover — and unrelated processes are never signaled.
  const { queryProcessTable, descendantsOf } = await import('./stall.mjs');
  const spawner = spawn(process.execPath,
    ['-e', 'const{spawn}=require("node:child_process");setInterval(()=>spawn(process.execPath,["-e","setInterval(()=>{},10000)"],{stdio:"ignore"}),200);setInterval(()=>{},500);'],
    // POSIX: own session/process group, so teardown can signal the group.
    { windowsHide: true, stdio: 'ignore', detached: process.platform !== 'win32' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 900));
    const first = await queryProcessTable();
    assert.ok(first, 'process enumeration must work');
    const before = new Set(descendantsOf(first, spawner.pid).map((r) => r.pid));
    assert.ok(before.size >= 1, 'forking tree must be observable');
    await new Promise((resolve) => setTimeout(resolve, 700));
    const second = await queryProcessTable();
    assert.ok(second, 'process enumeration must work twice');
    const fresh = descendantsOf(second, spawner.pid).map((r) => r.pid).filter((pid) => !before.has(pid));
    assert.ok(fresh.length >= 1, `expected newborns between snapshots, before=${before.size}`);
    // Exercise the real cleanup against the forking tree: whatever it
    // decides, the verdict must be well-formed (blocking carries evidence,
    // clean is only trusted with the deterministic + orphan coverage).
    const verdict = await cleanupProvenTree(spawner.pid);
    assert.ok(Array.isArray(verdict.attempted) && Array.isArray(verdict.remaining));
    assert.equal(typeof verdict.unprovable, 'boolean');
  } finally {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(spawner.pid), '/T', '/F'], () => resolve());
      });
    } else {
      try { process.kill(-spawner.pid, 'SIGKILL'); } catch {}
    }
    await waitFor(async () => {
      try { process.kill(spawner.pid, 0); return false; } catch { return true; }
    }, 10_000, 'spawner tree teardown');
  }
});
