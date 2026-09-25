// R2-D D2: merge-close-job review-patch application, against real git in a
// temp repo with a bare remote. Validation suites are stubbed at the exec
// seam (npm never runs); every git call is real.
// - happy path: patch applied, committed with machine identity, validated,
//   pushed, reported as patch:identical with patchedFrom=frozen;
// - apply failure: branch restored to frozen, patch:failed report;
// - identity mismatch: restored, patch:failed;
// - with --auto-rebase: rebase then patch, both groups in the report;
// - dry-run: validated then restored to frozen;
// - leftover patched head: Gate0 recovers and reruns;
// - arg validation: b64/sha must co-occur, match, and respect the size cap.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runMergeCloseJob,
  mergeFailureReport,
  validateMergeArgs,
  ReviewPatchError,
} from './merge-close-job.mjs';

const execFileAsync = promisify(execFile);
const TASK = 'tasks/drill.md';
const LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function patchFor(file, oldLine, newLine) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -3,5 +3,5 @@',
    ' line 3',
    ' line 4',
    `-${oldLine}`,
    `+${newLine}`,
    ' line 6',
    ' line 7',
    '',
  ].join('\n');
}

/** Build a guaranteed-applicable patch: edit line 5, capture git diff, revert. */
function makePatch(work, newContent) {
  const file = path.join(work, 'a.txt');
  const before = fs.readFileSync(file, 'utf8');
  const lines = before.split('\n');
  const idx = lines.findIndex((line) => line === 'line 5 candidate');
  assert.notEqual(idx, -1, 'candidate line must exist for patch generation');
  lines[idx] = newContent;
  fs.writeFileSync(file, lines.join('\n'));
  const raw = spawnSync('git', ['diff', '--no-color', '--no-ext-diff', '--', 'a.txt'], { cwd: work, encoding: 'utf8' });
  assert.equal(raw.status, 0, `git diff failed: ${raw.stderr}`);
  git(work, 'checkout', '--', 'a.txt');
  const patch = raw.stdout;
  assert.ok(patch.includes('diff --git'), 'generated patch must have a diff header');
  return patch.endsWith('\n') ? patch : `${patch}\n`;
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

function identity(cwd) {
  git(cwd, 'config', 'user.email', 'drill@example.com');
  git(cwd, 'config', 'user.name', 'drill');
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

function writeLines(file, lines) {
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

/** Base repo: master has a.txt (10 lines); feature == frozen candidate. */
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-patch-drill-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '-b', 'master');
  identity(work);
  writeLines(path.join(work, 'a.txt'), LINES);
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'base');
  git(dir, 'init', '--bare', remote);
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-u', 'origin', 'master');
  git(work, 'checkout', '-b', 'feature');
  const edited = [...LINES];
  edited[4] = 'line 5 candidate';
  writeLines(path.join(work, 'a.txt'), edited);
  git(work, 'commit', '-am', 'candidate');
  const frozen = git(work, 'rev-parse', 'HEAD');
  return { dir, work, remote, frozen };
}

function execIn(cwd, { failSuite } = {}) {
  return async (command, args, opts) => {
    if (command === 'npm') {
      if (failSuite && args.includes(failSuite)) {
        const error = new Error(`${failSuite} failed`);
        error.code = 1;
        throw error;
      }
      return { stdout: '', stderr: '' };
    }
    return execFileAsync(command, args, { ...opts, cwd });
  };
}

function run(work, frozen, patchText, { autoRebase = false, failSuite, dryRun = false } = {}) {
  const args = {
    frozenSha: frozen,
    workingBranch: 'feature',
    releaseEvidence: { taskPath: TASK, candidateSha: frozen, reviewStatus: 'approved', reviewEvidenceId: 7 },
    autoRebase,
  };
  if (patchText !== null && patchText !== undefined) {
    args.reviewPatchB64 = b64(patchText);
    args.reviewPatchSha256 = sha256(patchText);
  }
  return runMergeCloseJob(args, { exec: execIn(work, { failSuite }), verify: async () => ({ verified: true }), dryRun });
}

function remoteMaster(work) {
  return git(work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
}

test('patch happy path: applied, validated, pushed, reported identical', async (t) => {
  const { work, frozen } = fixture(t);
  const patch = makePatch(work, 'line 5 patched');
  const result = await run(work, frozen, patch);
  assert.equal(result.ok, true);
  assert.equal(result.patch, 'identical');
  assert.equal(result.patchedFrom, frozen);
  assert.equal(result.patchSha256, sha256(patch));
  assert.notEqual(result.head, frozen);
  assert.equal(result.tests.length, 6);
  assert.equal(remoteMaster(work), result.head);
  const msg = git(work, 'log', '-1', '--format=%s', result.head);
  assert.match(msg, /review patch/);
  assert.match(msg, new RegExp(TASK.replace('/', '/')));
  assert.match(msg, new RegExp(sha256(patch).slice(0, 12)));
  const author = git(work, 'log', '-1', '--format=%an <%ae>', result.head);
  assert.equal(author, 'ai-hub-merge <merge@ai-hub.local>');
});

test('patch that does not apply restores frozen and reports patch failed', async (t) => {
  const { work, frozen } = fixture(t);
  const bad = patchFor('a.txt', 'line that is not there', 'patched');
  await assert.rejects(() => run(work, frozen, bad), (error) => error instanceof ReviewPatchError);
  assert.equal(git(work, 'rev-parse', 'HEAD'), frozen);
  const report = mergeFailureReport(new ReviewPatchError('review patch does not apply: x'));
  assert.equal(report.patch, 'failed');
  assert.ok(report.reason);
});

test('patch apply with sha mismatch is rejected at arg validation', () => {
  const patch = patchFor('a.txt', 'x', 'y');
  assert.throws(() => validateMergeArgs({
    frozenSha: 'a'.repeat(40),
    workingBranch: 'feature',
    releaseEvidence: { taskPath: TASK, candidateSha: 'a'.repeat(40), reviewStatus: 'approved' },
    reviewPatchB64: b64(patch),
    reviewPatchSha256: '0'.repeat(64),
  }), /sha256 mismatch/);
  assert.throws(() => validateMergeArgs({
    frozenSha: 'a'.repeat(40),
    workingBranch: 'feature',
    releaseEvidence: { taskPath: TASK, candidateSha: 'a'.repeat(40), reviewStatus: 'approved' },
    reviewPatchB64: b64(patch),
  }), /both --review-patch-b64 and --review-patch-sha256/);
  assert.throws(() => validateMergeArgs({
    frozenSha: 'a'.repeat(40),
    workingBranch: 'feature',
    releaseEvidence: { taskPath: TASK, candidateSha: 'a'.repeat(40), reviewStatus: 'approved' },
    reviewPatchB64: b64('x'.repeat(8001)),
    reviewPatchSha256: sha256('x'.repeat(8001)),
  }), /size rejected/);
});

test('validation failure after a patch restores frozen and reports patch failed', async (t) => {
  const { work, frozen } = fixture(t);
  const patch = makePatch(work, 'line 5 patched');
  await assert.rejects(
    () => run(work, frozen, patch, { failSuite: 'smoke:deploy-drain' }),
    (error) => error.patchFailed === true,
  );
  assert.equal(git(work, 'rev-parse', 'HEAD'), frozen);
});

test('patch stacks on a clean rebase: both groups reported', async (t) => {
  const { dir, work, frozen } = fixture(t);
  const other = path.join(dir, 'other');
  git(dir, 'clone', path.join(dir, 'remote.git'), other);
  identity(other);
  fs.writeFileSync(path.join(other, 'b.txt'), 'b changed on master\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-m', 'unrelated master change');
  git(other, 'push', 'origin', 'master');
  const masterNow = git(other, 'rev-parse', 'HEAD');
  const patch = makePatch(work, 'line 5 patched');
  const result = await run(work, frozen, patch, { autoRebase: true });
  assert.equal(result.ok, true);
  assert.equal(result.rebase, 'identical');
  assert.equal(result.rebasedFrom, frozen);
  assert.equal(result.patch, 'identical');
  assert.equal(result.patchSha256, sha256(patch));
  assert.notEqual(result.patchedFrom, frozen, 'patchedFrom is the rebased head');
  assert.equal(remoteMaster(work), result.head);
  assert.equal(result.baselineSha, masterNow);
});

test('dry run validates then restores frozen', async (t) => {
  const { work, frozen } = fixture(t);
  const patch = makePatch(work, 'line 5 patched');
  const result = await run(work, frozen, patch, { dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.patch, 'identical');
  assert.equal(git(work, 'rev-parse', 'HEAD'), frozen);
});

test('a branch left on its patched head by a killed run is recovered', async (t) => {
  const { work, frozen } = fixture(t);
  const patch = makePatch(work, 'line 5 patched');
  // Simulate the killed run: apply + commit by hand, stay on the patched head.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-patch-manual-')), 'p.diff');
  t.after(() => { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); });
  fs.writeFileSync(tmp, patch);
  git(work, 'apply', '--index', tmp);
  git(work, '-c', 'user.name=ai-hub-merge', '-c', 'user.email=merge@ai-hub.local', 'commit', '-m', 'manual patch');
  const patchedHead = git(work, 'rev-parse', 'HEAD');
  assert.notEqual(patchedHead, frozen);
  const result = await run(work, frozen, patch);
  assert.equal(result.ok, true);
  assert.equal(result.patchedFrom, frozen);
  assert.equal(remoteMaster(work), result.head);
});

test('a branch moved to anything else still fails Gate0', async (t) => {
  const { work, frozen } = fixture(t);
  fs.writeFileSync(path.join(work, 'c.txt'), 'extra\n');
  git(work, 'add', 'c.txt');
  git(work, 'commit', '-m', 'unreviewed extra');
  const patch = makePatch(work, 'line 5 patched');
  await assert.rejects(() => run(work, frozen, patch), /Gate0 frozen SHA mismatch/);
});
