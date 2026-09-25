import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { autoCommitAndPush, autoCommitEligibility, autoCommitMessage } from './auto-commit.mjs';
import { snapshotRepo } from './delivery.mjs';

const PASS = [{ suite: 'node --test', status: 'pass' }];
const JOB = { id: 'job-1', permissions: { write: true }, options: { autoCommitOnPass: true, taskPath: 'tasks/x.md' } };
const CLEAN = { dirty: false, branch: 'feat', dirtyFiles: [] };
const DIRTY = { dirty: true, branch: 'feat', dirtyFiles: ['src/a.js'] };
const gate = (over = {}) => autoCommitEligibility({
  job: JOB, delivery: { state: 'blocked_local_changes' }, declaration: { tests: PASS },
  before: CLEAN, after: DIRTY, exitCode: 0, ...over,
});

test('gate: full condition passes', () => {
  assert.deepEqual(gate(), { ok: true, applicable: true, reason: 'all declared tests pass' });
});

test('gate: not applicable without opt-in, write permission, or a blocked state', () => {
  assert.equal(gate({ job: { ...JOB, options: {} } }).applicable, false);
  assert.equal(gate({ job: { ...JOB, permissions: { write: false } } }).applicable, false);
  assert.equal(gate({ delivery: { state: 'delivered' } }).applicable, false);
});

test('gate: refuses anything short of every declared test passing on a clean feature branch', () => {
  assert.match(gate({ exitCode: 1 }).reason, /code=1/);
  assert.match(gate({ declaration: {} }).reason, /no declared tests/);
  assert.match(gate({ declaration: { tests: [...PASS, { suite: 'web', status: 'fail' }] } }).reason, /not all pass: web/);
  assert.match(gate({ before: DIRTY }).reason, /not clean/);
  assert.match(gate({ before: null }).reason, /not clean/);
  assert.match(gate({ after: { ...DIRTY, branch: null } }).reason, /detached/);
  assert.match(gate({ after: { ...DIRTY, branch: 'master' } }).reason, /trunk/);
  assert.match(gate({ after: { ...DIRTY, dirtyFiles: ['src/a.js', 'deploy/.env.local'] } }).reason, /sensitive/);
  assert.match(gate({ after: { ...DIRTY, dirtyFiles: ['keys\\id_ed25519'] } }).reason, /sensitive/);
  for (const result of [gate({ exitCode: 1 }), gate({ after: { ...DIRTY, branch: 'main' } })]) {
    assert.equal(result.ok, false);
    assert.equal(result.applicable, true);
  }
});

test('message names the summary, task, job and tests', () => {
  const message = autoCommitMessage({ job: JOB, declaration: { summary: 'Add  thing\nnow', tests: PASS } });
  assert.match(message, /^Add thing now\n/);
  assert.match(message, /Task: tasks\/x\.md/);
  assert.match(message, /Job: job-1/);
  assert.match(message, /Tests: node --test/);
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-auto-commit-'));
  // Temp dirs stay under os.tmpdir(); no recursive delete by policy.
  void t;
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', remote);
  git(root, 'init', '-q', work);
  git(work, 'config', 'user.name', 'test');
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'core.hooksPath', path.join(root, 'hooks'));
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'checkout', '-q', '-b', 'session/feat');
  git(work, 'remote', 'add', 'origin', remote);
  return { root, remote, work };
}

test('commit+push: dirty feature branch lands on origin with the auto message', async (t) => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.work, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(fx.work, 'b.txt'), 'new\n');
  const after = await snapshotRepo(fx.work);
  assert.equal(after.dirty, true);
  const result = await autoCommitAndPush(fx.work, { job: JOB, declaration: { summary: 'round', tests: PASS }, after });
  assert.equal(result.committed, true);
  assert.equal(result.pushed, true, result.error);
  assert.equal(result.sha, git(fx.work, 'rev-parse', 'HEAD'));
  assert.equal(git(fx.remote, 'rev-parse', 'refs/heads/session/feat'), result.sha);
  assert.equal(git(fx.work, 'status', '--porcelain'), '');
  assert.match(git(fx.work, 'log', '-1', '--format=%B'), /Auto-committed by the ai-hub Worker/);
});

test('commit refused by a hook: tree is left exactly as the runner left it', async (t) => {
  const fx = fixture(t);
  fs.mkdirSync(path.join(fx.root, 'hooks'));
  fs.writeFileSync(path.join(fx.root, 'hooks', 'pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 });
  const head = git(fx.work, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(fx.work, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(fx.work, 'b.txt'), 'new\n');
  const after = await snapshotRepo(fx.work);
  const result = await autoCommitAndPush(fx.work, { job: JOB, declaration: { tests: PASS }, after });
  assert.equal(result.committed, false);
  assert.equal(result.pushed, false);
  assert.match(result.error, /git commit failed: hook says no/);
  assert.equal(git(fx.work, 'rev-parse', 'HEAD'), head);
  assert.equal(git(fx.work, 'diff', '--cached', '--name-only'), '');
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: fx.work, encoding: 'utf8', windowsHide: true });
  assert.deepEqual(status.split('\n').filter(Boolean).sort(), [' M a.txt', '?? b.txt']);
});

test('push failure keeps the commit and reports it', async (t) => {
  const fx = fixture(t);
  git(fx.work, 'remote', 'set-url', 'origin', path.join(fx.root, 'missing.git'));
  fs.writeFileSync(path.join(fx.work, 'a.txt'), 'two\n');
  const after = await snapshotRepo(fx.work);
  const result = await autoCommitAndPush(fx.work, { job: JOB, declaration: { tests: PASS }, after });
  assert.equal(result.committed, true);
  assert.equal(result.pushed, false);
  assert.match(result.error, /git push failed/);
  assert.equal(result.sha, git(fx.work, 'rev-parse', 'HEAD'));
});
