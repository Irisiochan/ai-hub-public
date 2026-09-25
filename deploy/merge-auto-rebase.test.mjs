// Clean auto-rebase in merge-close-job.mjs (User 2026-09-21), against real git
// in a temp repo with a bare remote. Validation suites are stubbed at the exec
// seam (npm never runs); every git call is real.
// - clean replay with an identical candidate patch: pushed, reported as
//   rebase=identical with rebasedFrom=frozen;
// - conflict, or a replay whose patch changed: stale exactly as before, the
//   branch back on frozen and nothing pushed;
// - without --auto-rebase: stale exactly as before;
// - validation failure after a rebase: branch back on frozen.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeFailureReport, runMergeCloseJob, StaleCandidateError } from './merge-close-job.mjs';

const execFileAsync = promisify(execFile);
const TASK = 'tasks/drill.md';
const LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

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

/** Candidate edits line 5 of a.txt on `feature`; `advance` then moves master from a second clone. */
function fixture(t, advance) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-rebase-drill-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  git(work, 'init', '-b', 'master');
  identity(work);
  writeLines(path.join(work, 'a.txt'), LINES);
  fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
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
  const other = path.join(dir, 'other');
  git(dir, 'clone', remote, other);
  identity(other);
  advance(other);
  git(other, 'push', 'origin', 'master');
  const masterNow = git(other, 'rev-parse', 'HEAD');
  return { work, frozen, masterNow };
}

function execIn(cwd, { failSuite } = {}) {
  return async (command, args, opts) => {
    if (command === 'npm') {
      if (failSuite && args.includes(failSuite)) {
        const error = new Error(`${failSuite} failed`);
        error.code = 1;
        // execFile's rejection carries the child's output, as npm's would.
        error.stdout = `ok 1 - fine\nnot ok 2 - writes to home\n${'x'.repeat(5000)}\n# fail 1\n`;
        error.stderr = "Error: ENOENT: no such file or directory, mkdir '/home/ai-dev/.grok/sessions'\n";
        throw error;
      }
      return { stdout: '', stderr: '' };
    }
    return execFileAsync(command, args, { ...opts, cwd });
  };
}

function run(work, frozen, { autoRebase = true, failSuite, dryRun = false } = {}) {
  return runMergeCloseJob({
    frozenSha: frozen,
    workingBranch: 'feature',
    releaseEvidence: { taskPath: TASK, candidateSha: frozen, reviewStatus: 'approved', reviewEvidenceId: 7 },
    autoRebase,
  }, { exec: execIn(work, { failSuite }), verify: async () => ({ verified: true }), dryRun });
}

function remoteMaster(work) {
  return git(work, 'ls-remote', 'origin', 'refs/heads/master').split(/\s+/)[0];
}

const otherFile = (other) => {
  fs.writeFileSync(path.join(other, 'b.txt'), 'b changed on master\n');
  git(other, 'commit', '-am', 'unrelated master change');
};

test('clean identical replay is validated, pushed and reported', async (t) => {
  const { work, frozen, masterNow } = fixture(t, otherFile);
  const result = await run(work, frozen);
  assert.equal(result.ok, true);
  assert.equal(result.rebase, 'identical');
  assert.equal(result.rebasedFrom, frozen);
  assert.notEqual(result.head, frozen);
  assert.equal(result.tests.length, 6);
  assert.equal(remoteMaster(work), result.head);
  assert.equal(git(work, 'rev-parse', `${result.head}^`), masterNow, 'replayed directly onto the fetched master');
  assert.equal(result.baselineSha, masterNow);
});

test('conflicting master change reports stale and restores frozen', async (t) => {
  const { work, frozen, masterNow } = fixture(t, (other) => {
    const lines = [...LINES];
    lines[4] = 'line 5 master';
    writeLines(path.join(other, 'a.txt'), lines);
    git(other, 'commit', '-am', 'conflicting master change');
  });
  await assert.rejects(() => run(work, frozen), (error) => error instanceof StaleCandidateError);
  assert.equal(git(work, 'rev-parse', 'HEAD'), frozen);
  assert.equal(git(work, 'branch', '--show-current'), 'feature');
  assert.equal(git(work, 'status', '--porcelain'), '');
  assert.equal(remoteMaster(work), masterNow, 'nothing pushed');
});

test('a replay whose own patch changed is stale, not merged', async (t) => {
  // Master edits line 3: git replays line 5 cleanly, but the candidate hunk's
  // context now carries master's line, so it is no longer the reviewed patch.
  const { work, frozen, masterNow } = fixture(t, (other) => {
    const lines = [...LINES];
    lines[2] = 'line 3 master';
    writeLines(path.join(other, 'a.txt'), lines);
    git(other, 'commit', '-am', 'nearby master change');
  });
  await assert.rejects(() => run(work, frozen), (error) => error instanceof StaleCandidateError);
  assert.equal(git(work, 'rev-parse', 'HEAD'), frozen);
  assert.equal(remoteMaster(work), masterNow);
});

test('without --auto-rebase a stale candidate is reported as before', async (t) => {
  const { work, frozen, masterNow } = fixture(t, otherFile);
  await assert.rejects(() => run(work, frozen, { autoRebase: false }), (error) => error instanceof StaleCandidateError);
  assert.equal(git(work, 'rev-parse', 'HEAD'), frozen);
  assert.equal(remoteMaster(work), masterNow);
});

test('validation failure after a rebase puts the branch back on frozen', async (t) => {
  const { work, frozen, masterNow } = fixture(t, otherFile);
  await assert.rejects(() => run(work, frozen, { failSuite: 'smoke:deploy-drain' }), /smoke:deploy-drain failed/);
  assert.equal(git(work, 'rev-parse', 'HEAD'), frozen);
  assert.equal(git(work, 'status', '--porcelain'), '');
  assert.equal(remoteMaster(work), masterNow);
});

test('a failing suite keeps its failing lines and output tail in the report', async (t) => {
  const { work, frozen } = fixture(t, () => {});
  let report;
  await assert.rejects(() => run(work, frozen, { failSuite: 'pretest' }), (error) => {
    report = mergeFailureReport(error);
    return true;
  });
  assert.equal(report.error, 'server npm run pretest failed with exit code 1');
  assert.deepEqual(report.tests, [{ suite: 'server npm run pretest', status: 'fail' }]);
  assert.match(report.output, /^not ok 2 - writes to home$/m);
  assert.match(report.output, /mkdir '\/home\/ai-dev\/\.grok\/sessions'/);
  assert.match(report.output, /# fail 1/, 'tail survives');
  assert.ok(report.output.length < 4500, 'bounded excerpt');
});

test('dry run reports the rebase but leaves the branch on frozen', async (t) => {
  const { work, frozen, masterNow } = fixture(t, otherFile);
  const result = await run(work, frozen, { dryRun: true });
  assert.equal(result.rebase, 'identical');
  assert.equal(git(work, 'rev-parse', 'HEAD'), frozen);
  assert.equal(remoteMaster(work), masterNow);
});

test('a branch left on its clean rebase by a killed run is recovered', async (t) => {
  const { work, frozen, masterNow } = fixture(t, otherFile);
  git(work, 'fetch', 'origin', 'master');
  git(work, 'rebase', 'origin/master');
  assert.notEqual(git(work, 'rev-parse', 'HEAD'), frozen);
  const result = await run(work, frozen);
  assert.equal(result.ok, true);
  assert.equal(result.rebasedFrom, frozen);
  assert.equal(remoteMaster(work), result.head);
});

test('a branch moved to anything else still fails Gate0', async (t) => {
  const { work, frozen } = fixture(t, otherFile);
  fs.writeFileSync(path.join(work, 'c.txt'), 'extra\n');
  git(work, 'add', 'c.txt');
  git(work, 'commit', '-m', 'unreviewed extra');
  await assert.rejects(() => run(work, frozen), /Gate0 frozen SHA mismatch/);
});
