// O5 drill: merge-close-job.ps1 against a temporary bare remote.
// - happy path pushes frozen:refs/heads/master without `git switch`
//   (master stays checked out in a linked worktree the whole time);
// - stale candidate (master moved past frozen) reports machine-readable
//   stale JSON and pushes nothing;
// - ledger self-check rejects forged/foreign release evidence (a local
//   self-check only, deliberately not called a hard gate);
// - server re-verification calls back to the gateway ledger with a bearer
//   and rejects evidence the ledger disagrees with.
// - baseline fix: the claimed -BaselineSha (candidate before.head) is never
//   asserted against frozen, so a rebased candidate passes; the receipt
//   baselineSha is computed live as merge-base(<remote>/<target>, frozen);
//   omitting -BaselineSha also merges; a candidate behind master is still
//   rejected as stale.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MERGE_VALIDATION_SUITES,
  resolveMergeRepoConfig,
  runMergeCloseJob,
  validateMergeArgs,
  validateMergeManifest,
} from './merge-close-job.mjs';

const execFileAsync = promisify(execFile);

const SCRIPT = path.resolve(import.meta.dirname, 'merge-close-job.ps1');
const PS = process.env.POWERSHELL ?? 'powershell';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

function runScript(cwd, args, opts = {}) {
  return spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], {
    cwd, encoding: 'utf8', timeout: 120_000,
    ...(opts.env ? { env: opts.env } : {}),
  });
}

function evidence(taskPath, candidateSha, reviewStatus = 'approved') {
  return JSON.stringify({ taskPath, candidateSha, reviewStatus, reviewEvidenceId: 7 });
}

function evidenceWithRoom(roomId, taskPath, candidateSha, reviewStatus = 'approved') {
  return JSON.stringify({ roomId, taskPath, candidateSha, reviewStatus, reviewEvidenceId: 7 });
}

// Stub gateway ledger: serves one room-task view for server re-verification.
// NOTE: runScript uses spawnSync, which blocks this process's event loop, so
// an in-process stub could never answer the script's callback. The stub runs
// as a separate node process instead (like the real gateway).
const STUB_SRC = `
const http = require('node:http');
const [portArg, candidateSha, reviewStatus, statusArg] = process.argv.slice(2);
const status = Number(statusArg || 200);
const server = http.createServer((req, res) => {
  process.stdout.write('HIT ' + req.url + ' ' + req.headers.authorization + '\\n');
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ task: { candidate_sha: candidateSha, review_status: reviewStatus } }));
});
server.listen(Number(portArg), '127.0.0.1', () => {
  process.stdout.write('READY ' + server.address().port + '\\n');
});
`;
function stubLedger(t, { candidateSha, reviewStatus, status = 200 }) {  const stubFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-stub-')), 'stub.cjs');
  t.after(() => { fs.rmSync(path.dirname(stubFile), { recursive: true, force: true }); });
  fs.writeFileSync(stubFile, STUB_SRC);
  const child = spawn(process.execPath, [stubFile, '0', candidateSha, reviewStatus, String(status)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill(); } catch { /* already exited */ } });
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('stub ledger did not start')), 15000);
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      const m = /READY (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ base: `http://127.0.0.1:${m[1]}`, output: () => out });
      }
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-merge-drill-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-b', 'master');
  git(work, 'config', 'user.email', 'drill@example.com');
  git(work, 'config', 'user.name', 'drill');
  git(work, 'config', 'commit.gpgsign', 'false');
  // No-op validation suite (the script runs these via npm; keep them trivial).
  const serverPkg = { name: 'server', private: true, scripts: { pretest: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"', 'smoke:deploy-drain': 'node -e "process.exit(0)"', 'smoke:turn-timeouts': 'node -e "process.exit(0)"', 'smoke:deploy-resume': 'node -e "process.exit(0)"' } };
  const webPkg = { name: 'web', private: true, scripts: { test: 'node -e "process.exit(0)"' } };
  fs.mkdirSync(path.join(work, 'server'), { recursive: true });
  fs.mkdirSync(path.join(work, 'web'), { recursive: true });
  fs.writeFileSync(path.join(work, 'server', 'package.json'), JSON.stringify(serverPkg));
  fs.writeFileSync(path.join(work, 'web', 'package.json'), JSON.stringify(webPkg));
  fs.writeFileSync(path.join(work, 'a.txt'), 'base\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'base');
  git(work, 'init', '--bare', remote);
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-u', 'origin', 'master');
  const base = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'a.txt'), 'base\nfeature\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'feature');
  const frozen = git(work, 'rev-parse', 'HEAD');
  // Hold master in a linked worktree: the old `git switch master` flow fails
  // here ("already used by worktree"); the new flow must not care.
  git(work, 'worktree', 'add', path.join(dir, 'holder'), 'master');
  return { dir, remote, work, base, frozen };
}

test('O5: worktree-safe push with ledger evidence, master held elsewhere', (t) => {
  const { work, base, frozen } = fixture(t);
  const r = runScript(work, [
    '-FrozenSha', frozen, '-BaselineSha', base, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidence('tasks/drill.md', frozen),
  ]);
  assert.equal(r.status, 0, `script failed: ${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, true);
  assert.equal(out.head.toLowerCase(), frozen.toLowerCase());
  assert.equal(out.tests.length, 6);
  assert.ok(out.tests.every((s) => s.status === 'pass'));
  const pushed = git(work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
  assert.equal(pushed.toLowerCase(), frozen.toLowerCase());
});

test('O5: stale candidate reports stale JSON and pushes nothing', (t) => {
  const fx = fixture(t);
  const { work, remote, base, frozen } = fx;
  // Advance master past the candidate from a second clone.
  const other = path.join(fx.dir, 'other');
  git(fx.dir, 'clone', remote, other);
  git(other, 'config', 'user.email', 'drill@example.com');
  git(other, 'config', 'user.name', 'drill');
  git(other, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(other, 'a.txt'), 'base\nother\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-m', 'advance master');
  git(other, 'push', 'origin', 'master');
  const masterNow = git(other, 'rev-parse', 'HEAD');
  assert.notEqual(masterNow.toLowerCase(), frozen.toLowerCase());
  const r = runScript(work, [
    '-FrozenSha', frozen, '-BaselineSha', base, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidence('tasks/drill.md', frozen),
  ]);
  assert.notEqual(r.status, 0, 'stale merge must fail');
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, false);
  assert.equal(out.stale, true);
  assert.equal(out.masterSha.toLowerCase(), masterNow.toLowerCase());
  const pushed = git(work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
  assert.equal(pushed.toLowerCase(), masterNow.toLowerCase(), 'remote master untouched by stale run');
});

test('O5: ledger self-check rejects mismatched evidence', (t) => {
  const { work, base, frozen } = fixture(t);
  const badCandidate = runScript(work, [
    '-FrozenSha', frozen, '-BaselineSha', base, '-WorkingBranch', 'feature',
    '-ReleaseEvidence', evidence('tasks/drill.md', 'b'.repeat(40)),
  ]);
  assert.notEqual(badCandidate.status, 0);
  assert.match(badCandidate.stdout, /ledger self-check rejected/);
  const unapproved = runScript(work, [
    '-FrozenSha', frozen, '-BaselineSha', base, '-WorkingBranch', 'feature',
    '-ReleaseEvidence', evidence('tasks/drill.md', frozen, 'changes_requested'),
  ]);
  assert.notEqual(unapproved.status, 0);
  assert.match(unapproved.stdout, /ledger self-check rejected/);
});

test('O5: server re-verification passes when the ledger agrees', async (t) => {
  const { work, base, frozen } = fixture(t);
  const stub = await stubLedger(t, { candidateSha: frozen, reviewStatus: 'approved' });
  const r = runScript(work, [
    '-FrozenSha', frozen, '-BaselineSha', base, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidenceWithRoom('r1', 'tasks/drill.md', frozen),
    '-GatewayUrl', stub.base, '-VerifyToken', 'test-token',
  ]);
  assert.equal(r.status, 0, `script failed: ${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, true);
  // The stub child's stdout arrives on this loop only after the blocking
  // runScript returns; poll briefly instead of asserting synchronously.
  const hitRe = /HIT \/api\/room-tasks\/r1\/drill\.md Bearer test-token/;
  const deadline = Date.now() + 10000;
  while (!hitRe.test(stub.output()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(stub.output(), hitRe);
  const pushed = git(work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
  assert.equal(pushed.toLowerCase(), frozen.toLowerCase());
});

test('O5: server re-verification rejects evidence the ledger disagrees with', async (t) => {
  const { work, base, frozen } = fixture(t);
  const stub = await stubLedger(t, { candidateSha: 'c'.repeat(40), reviewStatus: 'approved' });
  const r = runScript(work, [
    '-FrozenSha', frozen, '-BaselineSha', base, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidenceWithRoom('r1', 'tasks/drill.md', frozen),
    '-GatewayUrl', stub.base, '-VerifyToken', 'test-token',
  ]);
  assert.notEqual(r.status, 0, 'ledger-disputed merge must fail');
  assert.match(r.stdout, /server re-verification rejected/);
  const pushed = git(work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
  assert.equal(pushed.toLowerCase(), base.toLowerCase(), 'remote master untouched by disputed run');
});

test('O5: server re-verification rejects unapproved ledger review', async (t) => {
  const { work, base, frozen } = fixture(t);
  const stub = await stubLedger(t, { candidateSha: frozen, reviewStatus: 'changes_requested' });
  const r = runScript(work, [
    '-FrozenSha', frozen, '-BaselineSha', base, '-WorkingBranch', 'feature',
    '-ReleaseEvidence', evidenceWithRoom('r1', 'tasks/drill.md', frozen),
    '-GatewayUrl', stub.base, '-VerifyToken', 'test-token',
  ]);
  assert.notEqual(r.status, 0, 'unapproved merge must fail');
  assert.match(r.stdout, /server re-verification rejected/);
});

test('baseline fix: rebased candidate whose claimed baseline is not an ancestor still merges', (t) => {
  // Faithful replay of the 23c55a07 failure: before.head (claimed baseline)
  // is the pre-rebase head, which the rebased frozen history no longer
  // contains. The gate must not assert baseline→frozen ancestry.
  const fx = fixture(t);
  const { work, frozen: preRebase } = fx;
  const other = path.join(fx.dir, 'other');
  git(fx.dir, 'clone', fx.remote, other);
  git(other, 'config', 'user.email', 'drill@example.com');
  git(other, 'config', 'user.name', 'drill');
  git(other, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(other, 'b.txt'), 'master advance\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-m', 'advance master');
  git(other, 'push', 'origin', 'master');
  git(work, 'fetch', 'origin');
  git(work, 'rebase', 'origin/master');
  const frozen = git(work, 'rev-parse', 'HEAD');
  assert.notEqual(frozen.toLowerCase(), preRebase.toLowerCase(), 'rebase must rewrite the candidate head');
  const preIsAncestor = spawnSync('git', ['merge-base', '--is-ancestor', preRebase, frozen], { cwd: work });
  assert.notEqual(preIsAncestor.status, 0, 'claimed baseline must not be an ancestor (rebase case)');
  // Snapshot the expected baseline BEFORE the script runs: a successful run
  // pushes frozen to origin/master, after which merge-base would trivially be
  // frozen itself.
  const expectedBaseline = git(work, 'merge-base', 'origin/master', frozen);
  const r = runScript(work, [
    '-FrozenSha', frozen, '-BaselineSha', preRebase, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidence('tasks/drill.md', frozen),
  ]);
  assert.equal(r.status, 0, `rebased candidate must pass: ${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, true);
  assert.equal(out.head.toLowerCase(), frozen.toLowerCase());
  assert.equal(out.baselineSha.toLowerCase(), expectedBaseline.toLowerCase());
  assert.equal((out.claimedBaselineSha ?? '').toLowerCase(), preRebase.toLowerCase());
  const pushed = git(work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
  assert.equal(pushed.toLowerCase(), frozen.toLowerCase());
});

test('baseline fix: -BaselineSha omitted still merges with computed baseline', (t) => {
  const { work, frozen } = fixture(t);
  // Same ordering caveat as above: snapshot before the push.
  const expectedBaseline = git(work, 'merge-base', 'origin/master', frozen);
  const r = runScript(work, [
    '-FrozenSha', frozen, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidence('tasks/drill.md', frozen),
  ]);
  assert.equal(r.status, 0, `omitted baseline must pass: ${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, true);
  assert.equal(out.baselineSha.toLowerCase(), expectedBaseline.toLowerCase());
  const pushed = git(work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
  assert.equal(pushed.toLowerCase(), frozen.toLowerCase());
});

test('fail-closed: gateway unreachable with roomId evidence fails without push', (t) => {
  const { work, base, frozen } = fixture(t);
  const r = runScript(work, [
    '-FrozenSha', frozen, '-BaselineSha', base, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidenceWithRoom('r1', 'tasks/drill.md', frozen),
    '-GatewayUrl', 'http://127.0.0.1:1', '-VerifyToken', 'test-token',
  ]);
  assert.notEqual(r.status, 0, 'unreachable gateway must fail closed');
  assert.match(r.stdout, /server re-verification rejected/);
  const pushed = git(work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
  assert.equal(pushed.toLowerCase(), base.toLowerCase(), 'remote master untouched by fail-closed run');
});

test('fail-closed: gateway 5xx with roomId evidence fails without push', async (t) => {
  const { work, base, frozen } = fixture(t);
  const stub = await stubLedger(t, { candidateSha: frozen, reviewStatus: 'approved', status: 500 });
  const r = runScript(work, [
    '-FrozenSha', frozen, '-BaselineSha', base, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidenceWithRoom('r1', 'tasks/drill.md', frozen),
    '-GatewayUrl', stub.base, '-VerifyToken', 'test-token',
  ]);
  assert.notEqual(r.status, 0, '5xx gateway must fail closed');
  assert.match(r.stdout, /server re-verification rejected/);
  const pushed = git(work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
  assert.equal(pushed.toLowerCase(), base.toLowerCase(), 'remote master untouched by fail-closed run');
});

test('fail-closed: roomId evidence without bearer fails', (t) => {
  const { work, frozen } = fixture(t);
  // Explicit empty -VerifyToken disables the machine env fallback (the test
  // host may carry a User-level AI_HUB_TOKEN); child process env is stripped
  // as well. Either way the script must refuse without a bearer.
  const env = { ...process.env };
  delete env.AI_HUB_TOKEN;
  delete env.AI_HUB_URL;
  const r = runScript(work, [
    '-FrozenSha', frozen, '-BaselineSha', frozen, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidenceWithRoom('r1', 'tasks/drill.md', frozen),
    '-GatewayUrl', 'http://127.0.0.1:1', '-VerifyToken', '',
  ], { env });
  assert.notEqual(r.status, 0, 'missing bearer must fail closed');
  assert.match(r.stdout, /server re-verification rejected: no bearer/);
});

test('fail-closed: evidence without roomId allows local self-check, -RequireServerVerify forces failure', (t) => {
  const { work, base, frozen } = fixture(t);
  const ok = runScript(work, [
    '-FrozenSha', frozen, '-BaselineSha', base, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidence('tasks/drill.md', frozen),
  ]);
  assert.equal(ok.status, 0, `roomId-less manual use must still pass: ${ok.stdout}${ok.stderr}`);
  const fx2 = fixture(t);
  const forced = runScript(fx2.work, [
    '-FrozenSha', fx2.frozen, '-BaselineSha', fx2.base, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidence('tasks/drill.md', fx2.frozen),
    '-RequireServerVerify',
  ]);
  assert.notEqual(forced.status, 0, '-RequireServerVerify must fail without roomId');
  assert.match(forced.stdout, /server re-verification rejected/);
});

// R3: .ai-hub-merge.json manifest (User 2026-09-22): a non-ai-hub checkout
// declares its own repoId/trunk/validation set. Priority is identical in
// both entries: explicit --repo/-Repo keeps the built-in mapping; otherwise
// the manifest under --repo-dir/-RepoDir (invalid refuses fail-closed,
// never falls back); otherwise the ai-hub default.
function manifestFixture(t, manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-merge-manifest-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-b', 'master');
  git(work, 'config', 'user.email', 'drill@example.com');
  git(work, 'config', 'user.name', 'drill');
  git(work, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(work, 'a.txt'), 'base\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'base');
  git(work, 'init', '--bare', remote);
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-u', 'origin', 'master');
  // The manifest lives on trunk, like a real repo declaring its own gate.
  if (manifest !== null && manifest !== undefined) {
    fs.writeFileSync(path.join(work, '.ai-hub-merge.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    git(work, 'add', '.ai-hub-merge.json');
    git(work, 'commit', '-m', 'declare merge manifest');
    git(work, 'push', 'origin', 'master');
  }
  const base = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'a.txt'), 'base\nfeature\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'feature');
  const frozen = git(work, 'rev-parse', 'HEAD');
  git(work, 'worktree', 'add', path.join(dir, 'holder'), 'master');
  return { dir, remote, work, base, frozen };
}

function manifestArgs(fx, extra = []) {
  return [
    '-FrozenSha', fx.frozen, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidence('tasks/drill.md', fx.frozen),
    '-RepoDir', fx.work,
    ...extra,
  ];
}

test('R3 ps1: manifest repo runs its own suites and pushes', (t) => {
  const fx = manifestFixture(t, {
    repoId: 'pet-daily', targetBranch: 'master',
    validation: [{ suite: 'manifest self-check', command: 'node', args: ['-e', 'process.exit(0)'] }],
  });
  const r = runScript(fx.work, manifestArgs(fx));
  assert.equal(r.status, 0, `script failed: ${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, true);
  assert.equal(out.repoId, 'pet-daily');
  assert.equal(out.manifest, true);
  assert.equal(out.tests.length, 1);
  assert.equal(out.tests[0].suite, 'manifest self-check');
  const pushed = git(fx.work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
  assert.equal(pushed.toLowerCase(), fx.frozen.toLowerCase());
});

test('R3 ps1: illegal manifest refuses fail-closed without push', (t) => {
  const fx = manifestFixture(t, {
    repoId: 'pet-daily', targetBranch: 'master',
    validation: [{ suite: 'evil', command: 'bash', args: ['-c', 'exit 0'] }],
  });
  const r = runScript(fx.work, manifestArgs(fx));
  assert.notEqual(r.status, 0, 'illegal manifest must fail');
  assert.match(r.stdout, /merge manifest/);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, false);
  assert.equal(out.manifest, false);
  const pushed = git(fx.work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
  assert.equal(pushed.toLowerCase(), fx.base.toLowerCase(), 'remote master untouched by refused run');
});

test('R3 ps1: no manifest with -RepoDir keeps the ai-hub default', (t) => {
  const fx = manifestFixture(t, null);
  // Same no-op ai-hub suite shape as fixture(): the default path must still
  // run server/web suites from the workspace.
  const serverPkg = { name: 'server', private: true, scripts: { pretest: 'node -e "process.exit(0)"', test: 'node -e "process.exit(0)"', 'smoke:deploy-drain': 'node -e "process.exit(0)"', 'smoke:turn-timeouts': 'node -e "process.exit(0)"', 'smoke:deploy-resume': 'node -e "process.exit(0)"' } };
  const webPkg = { name: 'web', private: true, scripts: { test: 'node -e "process.exit(0)"' } };
  fs.mkdirSync(path.join(fx.work, 'server'), { recursive: true });
  fs.mkdirSync(path.join(fx.work, 'web'), { recursive: true });
  fs.writeFileSync(path.join(fx.work, 'server', 'package.json'), JSON.stringify(serverPkg));
  fs.writeFileSync(path.join(fx.work, 'web', 'package.json'), JSON.stringify(webPkg));
  git(fx.work, 'add', '-A');
  git(fx.work, 'commit', '-m', 'ai-hub suite shape');
  fx.frozen = git(fx.work, 'rev-parse', 'HEAD');
  const r = runScript(fx.work, manifestArgs(fx));
  assert.equal(r.status, 0, `script failed: ${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, true);
  assert.equal(out.repoId, 'ai-hub');
  assert.equal(out.manifest, false);
  assert.equal(out.tests.length, 6);
});

test('R3 ps1: explicit -Repo wins over a manifest', (t) => {
  const fx = manifestFixture(t, {
    repoId: 'pet-daily', targetBranch: 'master',
    validation: [{ suite: 'boom', command: 'node', args: ['-e', 'process.exit(1)'] }],
  });
  // Without -Repo the failing manifest suite would stop the merge.
  const refused = runScript(fx.work, manifestArgs(fx));
  assert.notEqual(refused.status, 0, 'manifest suites apply without explicit -Repo');
  // Explicit -Repo keeps the built-in mapping instead: the ai-hub fixture
  // shape from fixture() passes even though the manifest would fail.
  const fx2 = fixture(t);
  fs.writeFileSync(path.join(fx2.work, '.ai-hub-merge.json'), JSON.stringify({
    repoId: 'pet-daily', targetBranch: 'master',
    validation: [{ suite: 'boom', command: 'node', args: ['-e', 'process.exit(1)'] }],
  }));
  git(fx2.work, 'add', '.ai-hub-merge.json');
  git(fx2.work, 'commit', '-m', 'manifest that must be ignored');
  fx2.frozen = git(fx2.work, 'rev-parse', 'HEAD');
  const r = runScript(fx2.work, [
    '-FrozenSha', fx2.frozen, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidence('tasks/drill.md', fx2.frozen),
    '-Repo', 'ai-hub', '-RepoDir', fx2.work,
  ]);
  assert.equal(r.status, 0, `explicit -Repo must ignore the manifest: ${r.stdout}${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, true);
  assert.equal(out.repoId, 'ai-hub');
  assert.equal(out.manifest, false);
  assert.equal(out.tests.length, 6);
  const unknown = runScript(fx2.work, [
    '-FrozenSha', fx2.frozen, '-WorkingBranch', 'feature',
    '-Remote', 'origin', '-TargetBranch', 'master',
    '-ReleaseEvidence', evidence('tasks/drill.md', fx2.frozen),
    '-Repo', 'other-repo',
  ]);
  assert.notEqual(unknown.status, 0, 'unknown explicit repo must fail');
  assert.match(unknown.stdout, /no validation suites configured/);
});

test('R3 mjs: repo resolution priority — explicit repo, manifest, default', (t) => {
  assert.equal(resolveMergeRepoConfig({}).repoId, 'ai-hub');
  assert.equal(resolveMergeRepoConfig({}).suites, MERGE_VALIDATION_SUITES);
  assert.equal(resolveMergeRepoConfig({}).manifest, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-merge-resolve-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, '.ai-hub-merge.json'), JSON.stringify({
    repoId: 'pet-daily', targetBranch: 'master',
    validation: [{ suite: 's', command: 'node', args: ['-e', '1'] }],
  }));
  const viaManifest = resolveMergeRepoConfig({ repoDir: dir });
  assert.equal(viaManifest.repoId, 'pet-daily');
  assert.equal(viaManifest.targetBranch, 'master');
  assert.equal(viaManifest.manifest, true);
  assert.equal(viaManifest.suites.length, 1);
  assert.equal(viaManifest.manifestCwd, dir);
  // Explicit --repo never reads the manifest.
  const explicit = resolveMergeRepoConfig({ explicitRepo: 'ai-hub', repoDir: dir });
  assert.equal(explicit.manifest, false);
  assert.equal(explicit.suites, MERGE_VALIDATION_SUITES);
  // Explicit --target-branch wins over the manifest trunk.
  assert.equal(resolveMergeRepoConfig({ repoDir: dir, explicitTargetBranch: 'release' }).targetBranch, 'release');
  assert.equal(resolveMergeRepoConfig({ repoDir: dir }).targetBranch, 'master');
  assert.throws(() => resolveMergeRepoConfig({ explicitRepo: 'nope' }), /no validation suites configured/);
  assert.throws(() => resolveMergeRepoConfig({ explicitRepo: '../evil' }), /repoId/);
  // validateMergeArgs threads the same resolution through.
  const ev = evidence('tasks/drill.md', 'a'.repeat(40));
  const parsed = validateMergeArgs({ frozenSha: 'a'.repeat(40), workingBranch: 'x', releaseEvidence: ev, repoDir: dir });
  assert.equal(parsed.repoId, 'pet-daily');
  assert.equal(parsed.manifest, true);
  assert.equal(parsed.manifestCwd, dir);
  assert.equal(parsed.suites.length, 1);
  const plain = validateMergeArgs({ frozenSha: 'a'.repeat(40), workingBranch: 'x', releaseEvidence: ev });
  assert.equal(plain.repoId, 'ai-hub');
  assert.equal(plain.manifest, false);
});

test('R3 mjs: illegal manifests throw fail-closed', () => {
  const good = { repoId: 'pet-daily', targetBranch: 'master', validation: [{ suite: 's', command: 'npm', args: ['test'] }] };
  assert.equal(validateMergeManifest(good, 'test').repoId, 'pet-daily');
  const bad = [
    [null, /must be a JSON object/],
    ['x', /must be a JSON object/],
    [{}, /repoId/],
    [{ ...good, repoId: '../evil' }, /repoId/],
    [{ ...good, targetBranch: '../evil' }, /targetBranch/],
    [{ ...good, targetBranch: '' }, /targetBranch/],
    [{ ...good, validation: [] }, /non-empty array/],
    [{ ...good, validation: 'x' }, /non-empty array/],
    [{ ...good, validation: [{ suite: 's', command: 'bash', args: ['x'] }] }, /command/],
    [{ ...good, validation: [{ suite: 's', command: 'npm', args: [] }] }, /args/],
    [{ ...good, validation: [{ suite: 's', command: 'npm', args: 'test' }] }, /args/],
    [{ ...good, validation: [{ suite: 's', command: 'npm', args: ['a', '..'] }] }, /args/],
    [{ ...good, validation: [{ suite: 's', command: 'npm', args: ['a\nb'] }] }, /args/],
    [{ ...good, validation: [{ suite: 's\nx', command: 'npm', args: ['t'] }] }, /suite/],
    [{ ...good, validation: [{ suite: '', command: 'npm', args: ['t'] }] }, /suite/],
    [{ ...good, validation: [{ suite: 's', command: 'npm', args: [7] }] }, /args/],
  ];
  for (const [doc, re] of bad) {
    assert.throws(() => validateMergeManifest(doc, 'test'), re, `must reject ${JSON.stringify(doc)}`);
  }
});

test('R3 mjs: true-git manifest run pushes and reports repoId', async (t) => {
  const fx = manifestFixture(t, {
    repoId: 'pet-daily', targetBranch: 'master',
    validation: [{ suite: 'manifest self-check', command: 'node', args: ['-e', 'process.exit(0)'] }],
  });
  const cwdExec = (command, cmdArgs, opts) => execFileAsync(command, cmdArgs, { ...(opts ?? {}), cwd: fx.work });
  const result = await runMergeCloseJob(
    { frozenSha: fx.frozen, workingBranch: 'feature', releaseEvidence: evidence('tasks/drill.md', fx.frozen), repoDir: fx.work },
    { exec: cwdExec, verify: async () => ({ verified: false }) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.repoId, 'pet-daily');
  assert.equal(result.manifest, true);
  assert.equal(result.tests.length, 1);
  const pushed = git(fx.work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
  assert.equal(pushed.toLowerCase(), fx.frozen.toLowerCase());
});

test('R3 mjs: true-git illegal manifest refuses without push', async (t) => {
  const fx = manifestFixture(t, 'not json{{{');
  const cwdExec = (command, cmdArgs, opts) => execFileAsync(command, cmdArgs, { ...(opts ?? {}), cwd: fx.work });
  await assert.rejects(
    runMergeCloseJob(
      { frozenSha: fx.frozen, workingBranch: 'feature', releaseEvidence: evidence('tasks/drill.md', fx.frozen), repoDir: fx.work },
      { exec: cwdExec, verify: async () => ({ verified: false }) },
    ),
    /merge manifest/,
  );
  const pushed = git(fx.work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
  assert.equal(pushed.toLowerCase(), fx.base.toLowerCase(), 'remote master untouched by refused run');
});
