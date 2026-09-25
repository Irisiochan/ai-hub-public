// End to end through the real worker.mjs: a fake runner edits a git
// workspace, leaves it uncommitted, and declares its tests. The opted-in
// all-pass round is committed+pushed by the Worker; a failing round stays
// blocked_local_changes with the skip reason recorded.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function repo(dir, name) {
  const remote = path.join(dir, `${name}.git`);
  const work = path.join(dir, name);
  git(dir, 'init', '-q', '--bare', remote);
  git(dir, 'init', '-q', work);
  git(work, 'config', 'user.name', 'test');
  git(work, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'checkout', '-q', '-b', 'session/feat');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', '-u', 'origin', 'session/feat');
  return { remote, work };
}

test('worker auto-commits an opted-in all-pass execute round and leaves a failing one blocked', async () => {
  // Temp dir stays under os.tmpdir(); no recursive delete by policy.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-auto-commit-int-'));
  const pass = repo(dir, 'ws-pass');
  const fail = repo(dir, 'ws-fail');
  const baseHead = git(pass.work, 'rev-parse', 'HEAD');
  const fakeRunner = path.join(dir, 'fake-runner.mjs');
  const fakeClaude = path.join(dir, process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude');
  fs.writeFileSync(fakeRunner, `
import fs from 'node:fs';
import path from 'node:path';
process.stdin.resume();
const failing = path.basename(process.cwd()) === 'ws-fail';
fs.writeFileSync('a.txt', 'two\\n');
fs.writeFileSync('b.txt', 'new\\n');
const delivery = {
  committed: false, pushed: false, summary: 'fake execute round',
  tests: [{ suite: 'unit', status: 'pass' }, ...(failing ? [{ suite: 'web', status: 'fail' }] : [])],
};
setTimeout(() => {
  console.log(JSON.stringify({ type: 'result', result: 'done ' + JSON.stringify({ delivery }), session_id: 'fake_session' }));
}, 200);
setTimeout(() => process.exit(0), 250);
`, 'utf8');
  fs.writeFileSync(fakeClaude, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fakeRunner}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fakeRunner}" "$@"\n`, 'utf8');
  if (process.platform !== 'win32') fs.chmodSync(fakeClaude, 0o755);

  const job = (id, workspace) => ({
    id, runner: 'claude', workspace, prompt: `fake execute ${id}`,
    permissions: { write: true, shell: false, ssh: false },
    options: { autoCommitOnPass: true, taskPath: 'tasks/auto.md' },
    session_id: null,
  });
  const jobs = [job('job-pass', pass.work), job('job-fail', fail.work)];
  const queued = [...jobs];
  const completions = new Map();
  const events = [];
  let resolveCompleted;
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/worker/connect') {
      return json(res, 200, { worker: { id: 'local-test', acceptingJobs: true, status: 'online' } });
    }
    if (req.method === 'GET' && url.pathname === '/api/worker/reconcile') return json(res, 200, { jobs: [] });
    if (req.method === 'GET' && url.pathname === '/api/worker/claim') {
      return json(res, 200, { job: queued.shift() ?? null, acceptingJobs: true, protocolVersion: 2, deliveryContract: 'LOCAL TEST' });
    }
    const match = url.pathname.match(/^\/api\/worker\/jobs\/([^/]+)\/(start|events|heartbeat|complete)$/);
    if (!match) return json(res, 404, { error: 'not found' });
    const [, jobId, action] = match;
    if (action === 'start') return json(res, 200, { ok: true });
    if (action === 'heartbeat') return json(res, 200, { action: 'continue', status: 'running' });
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      if (action === 'events') {
        events.push({ jobId, ...parsed });
        return json(res, 201, { ok: true });
      }
      completions.set(jobId, parsed);
      json(res, 200, { ok: true, status: parsed.status });
      if (completions.size === jobs.length) resolveCompleted();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({
    serverUrl: `http://127.0.0.1:${port}`,
    token: 'local-test.token',
    workspaces: [{ path: pass.work, deliveryMode: 'git-check' }, { path: fail.work, deliveryMode: 'git-check' }],
    runners: ['claude'],
    claudeCommand: fakeClaude,
    allowShell: false,
    allowSsh: false,
    maxConcurrent: 2,
  }), 'utf8');
  const worker = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'worker.mjs'), config], {
    cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AI_HUB_WORKER_EVENT_FLUSH_MS: '100' },
  });
  let output = '';
  worker.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  worker.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  let timer;
  try {
    await Promise.race([completed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`auto-commit integration timed out\n${output}`)), 20_000);
    })]);
    const passed = completions.get('job-pass');
    assert.equal(passed.status, 'done', JSON.stringify(passed));
    assert.equal(passed.delivery.state, 'delivered');
    assert.equal(passed.delivery.autoCommit.pushed, true);
    const head = git(pass.work, 'rev-parse', 'HEAD');
    assert.notEqual(head, baseHead);
    assert.equal(passed.delivery.autoCommit.sha, head);
    assert.equal(git(pass.remote, 'rev-parse', 'refs/heads/session/feat'), head);
    assert.equal(git(pass.work, 'status', '--porcelain'), '');
    assert.equal(passed.delivery.receipt.head, head);

    const failed = completions.get('job-fail');
    assert.equal(failed.status, 'blocked', JSON.stringify(failed));
    assert.equal(failed.delivery.state, 'blocked_local_changes');
    assert.match(failed.delivery.autoCommit.skipped, /not all pass: web/);
    assert.equal(git(fail.work, 'rev-parse', 'HEAD'), git(fail.remote, 'rev-parse', 'refs/heads/session/feat'));
    assert.notEqual(git(fail.work, 'status', '--porcelain'), '');
  } finally {
    clearTimeout(timer);
    if (worker.exitCode === null) {
      const exited = new Promise((resolve) => worker.once('exit', resolve));
      worker.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(() => { worker.kill('SIGKILL'); resolve(); }, 5_000))]);
    }
    await new Promise((resolve) => server.close(resolve));
  }
});
