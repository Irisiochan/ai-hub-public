import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listenOnFetchSafePort } from './test-http.mjs';

const TERMINATION_TIMEOUT_MS = 5_000;

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

test('worker runs two different workspaces concurrently without external model access', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-worker-integration-'));
  const workspaceA = path.join(dir, 'workspace-a');
  const workspaceB = path.join(dir, 'workspace-b');
  fs.mkdirSync(workspaceA);
  fs.mkdirSync(workspaceB);
  const fakeRunner = path.join(dir, 'fake-runner.mjs');
  const fakeClaude = path.join(dir, process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude');
  fs.writeFileSync(fakeRunner, `
process.stdin.resume();
setTimeout(() => {
  console.log(JSON.stringify({ type: 'result', result: 'local fake runner done', session_id: 'fake_session' }));
}, 450);
setTimeout(() => process.exit(0), 500);
`, 'utf8');
  fs.writeFileSync(
    fakeClaude,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${fakeRunner}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${fakeRunner}" "$@"\n`,
    'utf8'
  );
  if (process.platform !== 'win32') fs.chmodSync(fakeClaude, 0o755);

  const jobs = [
    {
      id: 'job-a',
      runner: 'claude',
      workspace: workspaceA,
      prompt: 'local fake A',
      permissions: { write: false, shell: false, ssh: false },
      options: {},
      session_id: null,
    },
    {
      id: 'job-b',
      runner: 'claude',
      workspace: workspaceB,
      prompt: 'local fake B',
      permissions: { write: false, shell: false, ssh: false },
      options: {},
      session_id: null,
    },
  ];
  const queued = [...jobs];
  const running = new Set();
  const completions = new Map();
  const failedEventJobs = new Set();
  let maxRunning = 0;
  let resolveCompleted;
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/worker/connect') {
      return json(res, 200, {
        worker: { id: 'local-test', acceptingJobs: true, status: running.size ? 'busy' : 'online' },
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/worker/reconcile') {
      return json(res, 200, { jobs: [] });
    }
    if (req.method === 'GET' && url.pathname === '/api/worker/claim') {
      const job = queued.shift() ?? null;
      return json(res, 200, {
        job,
        acceptingJobs: true,
        protocolVersion: 2,
        deliveryContract: 'LOCAL TEST DELIVERY CONTRACT',
      });
    }
    const match = url.pathname.match(/^\/api\/worker\/jobs\/([^/]+)\/(start|events|heartbeat|complete)$/);
    if (!match) return json(res, 404, { error: 'not found' });
    const [, jobId, action] = match;
    if (action === 'start') {
      running.add(jobId);
      maxRunning = Math.max(maxRunning, running.size);
      return json(res, 200, { ok: true });
    }
    if (action === 'events') {
      if (!failedEventJobs.has(jobId)) {
        failedEventJobs.add(jobId);
        return json(res, 503, { error: 'local transient event failure' });
      }
      return json(res, 201, { ok: true });
    }
    if (action === 'heartbeat') return json(res, 200, { action: 'continue', status: 'running' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const outcome = JSON.parse(body);
      completions.set(jobId, outcome);
      running.delete(jobId);
      json(res, 200, { ok: true, status: outcome.status });
      if (completions.size === jobs.length) resolveCompleted();
    });
  });

  await listenOnFetchSafePort(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing local test server address');
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({
    serverUrl: `http://127.0.0.1:${address.port}`,
    token: 'local-test.token',
    workspaces: [
      { path: workspaceA, deliveryMode: 'trust-cli' },
      { path: workspaceB, deliveryMode: 'trust-cli' },
    ],
    runners: ['claude'],
    claudeCommand: fakeClaude,
    allowShell: false,
    allowSsh: false,
    maxConcurrent: 2,
  }), 'utf8');

  const worker = spawn(process.execPath, [path.join(import.meta.dirname, 'worker.mjs'), config], {
    cwd: dir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AI_HUB_WORKER_EVENT_FLUSH_MS: '100' },
  });
  let output = '';
  worker.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  worker.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });

  let completionTimer;
  const timedOut = new Promise((_, reject) => {
    completionTimer = setTimeout(
      () => reject(new Error(`local worker integration timed out\n${output}`)),
      10_000
    );
  });
  try {
    await Promise.race([completed, timedOut]);
    assert.equal(maxRunning, 2);
    assert.equal(completions.get('job-a')?.status, 'done');
    assert.equal(completions.get('job-b')?.status, 'done');
    assert.equal(completions.get('job-a')?.delivery?.state, 'delivered');
    assert.equal(completions.get('job-b')?.delivery?.state, 'delivered');
    const stateFile = path.join(dir, 'worker-state.json');
    const replayDeadline = Date.now() + 4_000;
    let queuedEvents = Number.POSITIVE_INFINITY;
    while (Date.now() < replayDeadline) {
      try {
        queuedEvents = JSON.parse(fs.readFileSync(stateFile, 'utf8')).events.length;
      } catch {}
      if (failedEventJobs.size === 2 && queuedEvents === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(failedEventJobs.size, 2);
    assert.equal(queuedEvents, 0);
  } finally {
    clearTimeout(completionTimer);
    if (worker.exitCode === null) {
      const exited = new Promise((resolve) => worker.once('exit', resolve));
      worker.kill('SIGTERM');
      const forced = new Promise((resolve) => {
        const timer = setTimeout(() => {
          worker.kill('SIGKILL');
          resolve();
        }, TERMINATION_TIMEOUT_MS);
        exited.finally(() => clearTimeout(timer));
      });
      await Promise.race([exited, forced]);
    }
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
