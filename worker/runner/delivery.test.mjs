import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  capStatusShort,
  classifyDelivery,
  collectStructuredReceipt,
  deliveryCompletesJob,
  DEFAULT_RECONCILE_GRACE_MS,
  extractDeliveryDeclaration,
  extractRunnerUsage,
  formatLocalChangesSection,
  formatScratchSection,
  readScratchReceipts,
  RECEIPT_PATCH_MAX_CHARS,
  reconciliationDecision,
  repoDeliveryEvidence,
  resolvePatchBase,
  scratchDirForJob,
  snapshotRepo,
} from './delivery.mjs';

const clean = (head = 'a', ahead = 0) => ({
  head,
  dirty: false,
  dirtyFiles: [],
  ahead,
  fingerprint: `clean-${head}`,
});

test('dirty work introduced by the job is blocked', () => {
  const before = clean();
  const after = {
    ...clean(),
    dirty: true,
    dirtyFiles: ['src/a.ts'],
    fingerprint: 'dirty-a',
  };
  assert.equal(classifyDelivery(before, after, 0).state, 'blocked_local_changes');
});

test('a clean unpushed commit is blocked', () => {
  const before = clean('a', 0);
  const after = clean('b', 1);
  assert.equal(classifyDelivery(before, after, 0).state, 'blocked_unpushed');
});

test('a clean pushed commit is delivered', () => {
  const before = clean('a', 0);
  const after = clean('b', 0);
  assert.equal(classifyDelivery(before, after, 0).state, 'delivered');
});

test('pre-existing unchanged dirt does not falsely block a read-only job', () => {
  const before = {
    ...clean(),
    dirty: true,
    dirtyFiles: ['old.txt'],
    fingerprint: 'same-dirty',
  };
  assert.equal(classifyDelivery(before, { ...before }, 0).state, 'delivered');
});

test('only newly dirty files are attributed to the job', () => {
  const before = {
    ...clean(),
    dirty: true,
    dirtyFiles: ['old.txt'],
    fingerprint: 'dirty-before',
  };
  const after = {
    ...clean(),
    dirty: true,
    dirtyFiles: ['old.txt', 'new.txt'],
    fingerprint: 'dirty-after',
  };
  const delivery = classifyDelivery(before, after, 0);
  assert.equal(delivery.state, 'blocked_local_changes');
  assert.deepEqual(delivery.dirtyFiles, ['new.txt']);
});

test('changes to an already dirty path are treated as pre-existing workspace state', () => {
  const before = {
    ...clean(),
    dirty: true,
    dirtyFiles: ['old.txt'],
    fingerprint: 'dirty-before',
  };
  const after = { ...before, fingerprint: 'dirty-after' };
  assert.equal(classifyDelivery(before, after, 0).state, 'delivered');
});

test('a successful CLI delivery declaration takes priority over git dirt', () => {
  const before = clean();
  const after = {
    ...clean(),
    dirty: true,
    dirtyFiles: ['session.json'],
    fingerprint: 'background-write',
  };
  const delivery = classifyDelivery(before, after, 0, {
    declaration: { committed: true, pushed: true },
  });
  assert.equal(delivery.state, 'delivered');
  assert.equal(delivery.source, 'cli');
  assert.deepEqual(repoDeliveryEvidence(before, after), {
    git: {
      head: after.head,
      dirty: true,
      dirtyFiles: ['session.json'],
      ahead: after.ahead,
      behind: null,
      branch: null,
    },
    before: { head: before.head, dirty: false, ahead: before.ahead },
  });
});

test('snapshotRepo records branch and behind while preserving null without an upstream', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-delivery-snapshot-'));
  const remote = path.join(root, 'remote.git');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  try {
    fs.mkdirSync(first);
    git(root, 'init', '--bare', remote);
    git(first, 'init', '--initial-branch=main');
    git(first, 'config', 'user.email', 'worker-test@example.invalid');
    git(first, 'config', 'user.name', 'Worker Test');
    fs.writeFileSync(path.join(first, 'tracked.txt'), 'one\n');
    git(first, 'add', 'tracked.txt');
    git(first, 'commit', '-m', 'first');

    const withoutUpstream = await snapshotRepo(first);
    assert.equal(withoutUpstream.branch, 'main');
    assert.equal(withoutUpstream.ahead, null);
    assert.equal(withoutUpstream.behind, null);

    git(first, 'remote', 'add', 'origin', remote);
    git(first, 'push', '-u', 'origin', 'main');
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(root, 'clone', remote, second);
    git(second, 'config', 'user.email', 'worker-test@example.invalid');
    git(second, 'config', 'user.name', 'Worker Test');
    fs.writeFileSync(path.join(second, 'tracked.txt'), 'two\n');
    git(second, 'add', 'tracked.txt');
    git(second, 'commit', '-m', 'second');
    git(second, 'push');
    git(first, 'fetch', 'origin');

    const behind = await snapshotRepo(first);
    assert.equal(behind.branch, 'main');
    assert.equal(behind.ahead, 0);
    assert.equal(behind.behind, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unpushed CLI delivery declaration stays blocked', () => {
  const delivery = classifyDelivery(clean('a'), clean('b', 1), 0, {
    declaration: { committed: true, pushed: false },
  });
  assert.equal(delivery.state, 'blocked_unpushed');
  assert.equal(delivery.source, 'cli');
});

test('trust-cli mode ignores background git dirt but honors an explicit unfinished declaration', () => {
  const after = {
    ...clean(),
    dirty: true,
    dirtyFiles: ['sessions/background.json'],
    fingerprint: 'managed-write',
  };
  assert.equal(
    classifyDelivery(clean(), after, 0, { deliveryMode: 'trust-cli' }).state,
    'delivered'
  );
  assert.equal(
    classifyDelivery(clean(), after, 0, {
      deliveryMode: 'trust-cli',
      declaration: { committed: false, pushed: false },
    }).state,
    'blocked_local_changes'
  );
});

test('delivery declarations are extracted from raw objects and final message JSON lines', () => {
  assert.deepEqual(
    extractDeliveryDeclaration({ delivery: { committed: true, pushed: true } }),
    { committed: true, pushed: true }
  );
  assert.deepEqual(
    extractDeliveryDeclaration('完成。\n{"delivery":{"committed":true,"pushed":false}}'),
    { committed: true, pushed: false }
  );
  assert.equal(
    extractDeliveryDeclaration('{"delivery":{"committed":false,"pushed":true}}'),
    null
  );
});

test('delivery declarations survive fenced multiline, prefixes, and provider content arrays', () => {
  const pretty = [
    '交付证据如下：',
    '```json',
    '{',
    '  "delivery": {',
    '    "committed": true,',
    '    "pushed": true,',
    '    "stage": "closed_loop"',
    '  }',
    '}',
    '```',
  ].join('\n');
  assert.equal(extractDeliveryDeclaration(pretty)?.stage, 'closed_loop');
  assert.deepEqual(
    extractDeliveryDeclaration({ content: [{ type: 'text', text: pretty }] }),
    { committed: true, pushed: true, stage: 'closed_loop' },
  );
});

test('a valid delivery declaration is retained when runner cleanup exits nonzero', () => {
  const delivery = classifyDelivery(clean('a'), clean('b', 0), 7, {
    declaration: { committed: true, pushed: true, stage: 'delivered_waiting_deploy' },
  });
  assert.equal(delivery.state, 'delivered');
  assert.equal(delivery.source, 'cli');
  assert.equal(delivery.runnerExitCode, 7);
  assert.equal(deliveryCompletesJob(delivery, 7), true);
  assert.equal(deliveryCompletesJob({ state: 'failed_clean', source: 'git' }, 7), false);
});

test('delivery declarations preserve the human delivery milestone evidence', () => {
  assert.deepEqual(
    extractDeliveryDeclaration({
      delivery: {
        committed: true,
        pushed: true,
        stage: 'online_waiting_validation',
        summary: '已上线，等待真实入口验收。',
        next_owner: 'Codex',
      },
    }),
    {
      committed: true,
      pushed: true,
      stage: 'online_waiting_validation',
      summary: '已上线，等待真实入口验收。',
      nextOwner: 'Codex',
    },
  );
});

test('waiting_review is accepted as a declared delivery stage', () => {
  assert.deepEqual(
    extractDeliveryDeclaration('{"delivery":{"committed":true,"pushed":false,"stage":"waiting_review","nextOwner":"claude-review"}}'),
    { committed: true, pushed: false, stage: 'waiting_review', nextOwner: 'claude-review' },
  );
});

test('structured delivery declarations preserve diffstat, changed files, and test conclusions', () => {
  assert.deepEqual(
    extractDeliveryDeclaration({
      delivery: {
        committed: true,
        pushed: false,
        diffstat: ' 3 files changed, 20 insertions(+), 2 deletions(-) ',
        changedFiles: ['server/src/a.ts', 'server/src/b.ts'],
        tests: [
          { suite: 'server npm test', status: 'PASS' },
          { suite: 'web npm test', pass: false, detail: 'one failure' },
          { suite: '', status: 'pass' },
        ],
      },
    }),
    {
      committed: true,
      pushed: false,
      diffstat: '3 files changed, 20 insertions(+), 2 deletions(-)',
      changedFiles: {
        files: ['server/src/a.ts', 'server/src/b.ts'],
        total: 2,
        truncated: false,
      },
      tests: [
        { suite: 'server npm test', status: 'pass' },
        { suite: 'web npm test', status: 'fail', detail: 'one failure' },
      ],
    },
  );
});

test('worker computes the canonical structured receipt from git and transports declared tests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-receipt-structured-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init', '--initial-branch=worker/test');
    git('config', 'user.email', 'worker-test@example.invalid');
    git('config', 'user.name', 'Worker Test');
    fs.writeFileSync(path.join(root, 'one.txt'), 'one\n');
    git('add', 'one.txt');
    git('commit', '-m', 'baseline');
    const before = await snapshotRepo(root);
    fs.writeFileSync(path.join(root, 'one.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(root, 'two.txt'), 'new\n');
    git('add', 'one.txt', 'two.txt');
    git('commit', '-m', 'change');
    const after = await snapshotRepo(root);
    const receipt = await collectStructuredReceipt(root, before, after, {
      committed: true,
      pushed: false,
      tests: [{ suite: 'worker npm test', status: 'pass' }],
    });
    assert.equal(receipt.branch, 'worker/test');
    assert.equal(receipt.head, after.head);
    assert.match(receipt.diffstat, /2 files changed/);
    assert.deepEqual(receipt.changedFiles, {
      files: ['one.txt', 'two.txt'],
      total: 2,
      truncated: false,
    });
    assert.deepEqual(receipt.tests, [{ suite: 'worker npm test', status: 'pass' }]);
    assert.match(receipt.patch, /^\+two$/m, 'raw diff travels with the receipt');
    assert.match(receipt.patch, /two\.txt/);
    assert.equal(receipt.patchChars, receipt.patch.length);
    assert.equal(receipt.patchTruncated, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a job that switched branches measures its receipt from the default-branch merge-base (2026-09-15 44-file artifact)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-receipt-branch-base-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-receipt-remote-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  const rev = (ref) => execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['init', '--bare', '--initial-branch=master', remote], { stdio: 'ignore' });
    git('init', '--initial-branch=master');
    git('config', 'user.email', 'worker-test@example.invalid');
    git('config', 'user.name', 'Worker Test');
    fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
    git('add', 'README.md');
    git('commit', '-m', 'base');
    git('remote', 'add', 'origin', remote);
    git('push', '-q', 'origin', 'master');
    const baseSha = rev('HEAD');
    // Pre-job state: the shared checkout sits on an unrelated task branch.
    git('switch', '-c', 'codex/other-task');
    fs.writeFileSync(path.join(root, 'other.txt'), 'unrelated\n');
    git('add', 'other.txt');
    git('commit', '-m', 'unrelated work on another branch');
    const before = await snapshotRepo(root);
    // The job branches from origin/master and commits one file.
    git('switch', '-c', 'feature/candidate', 'origin/master');
    fs.writeFileSync(path.join(root, 'feature.txt'), 'candidate\n');
    git('add', 'feature.txt');
    git('commit', '-m', 'candidate');
    const after = await snapshotRepo(root);
    assert.deepEqual(await resolvePatchBase(root, before.head, after.head), { sha: baseSha, kind: 'branch-base', ref: 'origin/master' });
    const receipt = await collectStructuredReceipt(root, before, after, null);
    assert.match(receipt.diffstat, /^1 file changed/);
    assert.deepEqual(receipt.changedFiles, { files: ['feature.txt'], total: 1, truncated: false });
    assert.equal(receipt.patchBase, baseSha);
    assert.equal(receipt.patchBaseKind, 'branch-base');
    assert.doesNotMatch(receipt.patch, /other\.txt/, 'the unrelated branch never leaks into the candidate diff');
    // A follow-up round on the same branch keeps the pre-job HEAD as base.
    fs.writeFileSync(path.join(root, 'feature.txt'), 'candidate v2\n');
    git('commit', '-am', 'round two');
    const after2 = await snapshotRepo(root);
    const receipt2 = await collectStructuredReceipt(root, after, after2, null);
    assert.equal(receipt2.patchBaseKind, 'round');
    assert.equal(receipt2.patchBase, after.head);
    assert.match(receipt2.diffstat, /^1 file changed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('D4b second-round patch includes first-round hunks and reports missing-base fallback', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-cumulative-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'base');
  const base = await snapshotRepo(root);
  fs.writeFileSync(path.join(root, 'first.txt'), 'first-round-hunk\n');
  git('add', '.'); git('commit', '-m', 'first');
  const first = await snapshotRepo(root);
  fs.writeFileSync(path.join(root, 'second.txt'), 'second-round-hunk\n');
  git('add', '.'); git('commit', '-m', 'second');
  const second = await snapshotRepo(root);
  const receipt = await collectStructuredReceipt(root, first, second, null, base.head);
  assert.match(receipt.patch, /first-round-hunk/);
  assert.match(receipt.patch, /second-round-hunk/);
  assert.equal(receipt.patchBase, base.head);
  assert.equal(receipt.patchBaseKind, 'task-baseline');
  assert.match(receipt.diffstat, /1 file changed/);
  assert.deepEqual(receipt.changedFiles.files, ['second.txt']);
  const unchanged = await collectStructuredReceipt(root, second, second, null, base.head);
  assert.equal(unchanged.patch, receipt.patch);
  for (const missing of ['f'.repeat(40), '--output=bad']) {
    const fallback = await collectStructuredReceipt(root, first, second, null, missing);
    assert.match(fallback.patchBaseFallback, /using round diff/);
    assert.equal(fallback.patchBase, first.head);
    assert.doesNotMatch(fallback.patch, /first-round-hunk/);
  }
  const ordinary = await collectStructuredReceipt(root, first, second, null);
  assert.equal(ordinary.patchBaseKind, 'round');
  assert.equal(ordinary.patchBaseFallback, undefined);
});

test('P3: patchSince collects the increment since the pinned candidate', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-delta-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'base');
  const base = await snapshotRepo(root);
  fs.writeFileSync(path.join(root, 'first.txt'), 'first-round-hunk\n');
  git('add', '.'); git('commit', '-m', 'first');
  const first = await snapshotRepo(root);
  fs.writeFileSync(path.join(root, 'second.txt'), 'second-round-hunk\n');
  git('add', '.'); git('commit', '-m', 'second');
  const second = await snapshotRepo(root);
  // Delta since the pinned first-round candidate: only the second hunk.
  const receipt = await collectStructuredReceipt(root, first, second, null, base.head, first.head);
  assert.doesNotMatch(receipt.patchDelta, /first-round-hunk/);
  assert.match(receipt.patchDelta, /second-round-hunk/);
  assert.equal(receipt.patchDeltaBase, first.head);
  assert.equal(receipt.patchSinceFallback, undefined);
  assert.equal(receipt.patchDeltaChars, receipt.patchDelta.length);
  assert.equal(receipt.patchDeltaTruncated, false);
  // Cumulative patch is untouched by the delta.
  assert.match(receipt.patch, /first-round-hunk/);
  assert.match(receipt.patch, /second-round-hunk/);
  // No patchSince requested: no delta fields at all.
  const plain = await collectStructuredReceipt(root, first, second, null, base.head);
  assert.equal(plain.patchDelta, undefined);
  assert.equal(plain.patchSinceFallback, undefined);
});

test('P3: patchSince falls back without failing on bad bases', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-delta-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  git('add', '.'); git('commit', '-m', 'base');
  const base = await snapshotRepo(root);
  fs.writeFileSync(path.join(root, 'next.txt'), 'next\n');
  git('add', '.'); git('commit', '-m', 'next');
  const next = await snapshotRepo(root);
  // Unknown object.
  const missing = await collectStructuredReceipt(root, base, next, null, null, 'f'.repeat(40));
  assert.equal(missing.patchDelta, undefined);
  assert.match(missing.patchSinceFallback, /unavailable/);
  assert.equal(missing.requestedPatchSince, 'f'.repeat(40));
  // Malformed base.
  const bad = await collectStructuredReceipt(root, base, next, null, null, '--output=bad');
  assert.equal(bad.patchDelta, undefined);
  assert.match(bad.patchSinceFallback, /invalid/);
  // Valid commit but not an ancestor of HEAD (time runs backwards here).
  const reversed = await collectStructuredReceipt(root, next, base, null, null, next.head);
  assert.equal(reversed.patchDelta, undefined);
  assert.match(reversed.patchSinceFallback, /not an ancestor/);
});

test('a rebase round keeps trunk noise out of the cumulative patch and reports the replay (2026-09-21 15-file artifact)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-rebase-round-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-rebase-remote-'));
  t.after(() => { for (const dir of [root, remote]) fs.rmSync(dir, { recursive: true, force: true }); });
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['init', '--bare', '--initial-branch=master', remote], { stdio: 'ignore' });
  git('init', '--initial-branch=master');
  git('config', 'user.email', 'worker-test@example.invalid');
  git('config', 'user.name', 'Worker Test');
  fs.writeFileSync(path.join(root, 'doc.md'), 'one\ntwo\nthree\n');
  git('add', '.'); git('commit', '-m', 'base');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'master');
  const baseline = await snapshotRepo(root);
  git('switch', '-c', 'docs/candidate');
  fs.appendFileSync(path.join(root, 'doc.md'), 'candidate-hunk\n');
  git('commit', '-am', 'candidate');
  const candidate = await snapshotRepo(root);
  // Someone else's work lands on trunk, touching the same file above the hunk.
  git('switch', 'master');
  fs.writeFileSync(path.join(root, 'upstream.txt'), 'upstream-noise\n');
  fs.writeFileSync(path.join(root, 'doc.md'), 'zero\none\ntwo\nthree\n');
  git('add', '.'); git('commit', '-m', 'upstream');
  git('push', '-q', 'origin', 'master');
  git('switch', 'docs/candidate');
  git('rebase', 'origin/master');
  const rebased = await snapshotRepo(root);
  const receipt = await collectStructuredReceipt(root, candidate, rebased, null, baseline.head, candidate.head);
  assert.equal(receipt.patchBaseKind, 'task-baseline-rebased');
  assert.match(receipt.patch, /candidate-hunk/);
  assert.doesNotMatch(receipt.patch, /upstream-noise/, 'trunk commits are not the task patch');
  assert.equal(receipt.patchDeltaKind, 'rebase-identical');
  assert.equal(receipt.patchDelta, '');
  assert.equal(receipt.patchSinceFallback, undefined);
  // A rebase that also changes the candidate reports the series difference.
  fs.appendFileSync(path.join(root, 'doc.md'), 'post-rebase-fix\n');
  git('commit', '-am', 'fix on top of the rebase');
  const fixed = await snapshotRepo(root);
  const changed = await collectStructuredReceipt(root, candidate, fixed, null, baseline.head, candidate.head);
  assert.equal(changed.patchDeltaKind, 'rebase-range-diff');
  assert.match(changed.patchDelta, /fix on top of the rebase/);
  assert.doesNotMatch(changed.patch, /upstream-noise/);
  // Before any rebase the task baseline stays the cumulative base.
  const plain = await collectStructuredReceipt(root, baseline, candidate, null, baseline.head);
  assert.equal(plain.patchBaseKind, 'task-baseline');
});

test('receipt patch is capped and flagged when the diff is large', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-receipt-patch-cap-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.email', 'worker-test@example.invalid');
    git('config', 'user.name', 'Worker Test');
    fs.writeFileSync(path.join(root, 'big.txt'), 'seed\n');
    git('add', 'big.txt');
    git('commit', '-m', 'baseline');
    const before = await snapshotRepo(root);
    fs.writeFileSync(path.join(root, 'big.txt'), `${'x'.repeat(80)}\n`.repeat(8000));
    git('commit', '-am', 'big');
    const after = await snapshotRepo(root);
    const receipt = await collectStructuredReceipt(root, before, after, null);
    assert.equal(receipt.patch.length, RECEIPT_PATCH_MAX_CHARS);
    assert.ok(receipt.patchChars > RECEIPT_PATCH_MAX_CHARS);
    assert.equal(receipt.patchTruncated, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OpenCode text parts carry the delivery declaration (2026-09-14 lost-tests regression)', () => {
  const part = {
    type: 'text',
    part: {
      text: 'Validation: all pass.\n\n```json\n{"delivery":{"committed":true,"pushed":true,"stage":"waiting_review","tests":[{"suite":"tsc --noEmit","status":"pass"}]}}\n```',
    },
  };
  const declaration = extractDeliveryDeclaration(part);
  assert.equal(declaration?.committed, true);
  assert.equal(declaration?.stage, 'waiting_review');
  assert.deepEqual(declaration?.tests, [{ suite: 'tsc --noEmit', status: 'pass' }]);
});

test('an honest committed=false declaration on an untouched workspace is delivered, not blocked', () => {
  const before = { ...clean(), dirty: true, dirtyFiles: ['package-lock.json'], fingerprint: 'same' };
  const untouched = classifyDelivery(before, { ...before }, 0, {
    declaration: { committed: false, pushed: false },
  });
  assert.equal(untouched.state, 'delivered');
  assert.equal(untouched.source, 'cli');
  const touched = classifyDelivery(before, { ...before, dirtyFiles: ['package-lock.json', 'a.ts'], fingerprint: 'changed' }, 0, {
    declaration: { committed: false, pushed: false },
  });
  assert.equal(touched.state, 'blocked_local_changes');
});

test('runner failure with no local changes is a clean failure', () => {
  const before = clean();
  assert.equal(classifyDelivery(before, { ...before }, 1).state, 'failed_clean');
});

test('blocked local changes reconcile only after a clean pushed follow-up commit', () => {
  const delivery = { state: 'blocked_local_changes', head: 'a' };
  assert.equal(reconciliationDecision(delivery, clean('b', 0), true).ready, true);
  assert.equal(reconciliationDecision(delivery, clean('a', 0), true).ready, false);
});

test('blocked unpushed commit reconciles after that same commit is pushed', () => {
  const delivery = { state: 'blocked_unpushed', head: 'b' };
  assert.equal(reconciliationDecision(delivery, clean('b', 0), true).ready, true);
});

test('reconciliation rejects dirty, unpushed, detached, and rewritten states', () => {
  const delivery = { state: 'blocked_local_changes', head: 'a' };
  assert.equal(reconciliationDecision(delivery, { ...clean('b'), dirty: true }, true).ready, false);
  assert.equal(reconciliationDecision(delivery, clean('b', 1), true).ready, false);
  assert.equal(reconciliationDecision(delivery, { ...clean('b'), ahead: null }, true).ready, false);
  assert.equal(reconciliationDecision(delivery, clean('b', 0), false).ready, false);
});

test('an old blocked delivery self-heals once the workspace is clean and synchronized', () => {
  const delivery = { state: 'blocked_local_changes', head: 'a' };
  const decision = reconciliationDecision(delivery, clean('a', 0), false, {
    blockedForMs: DEFAULT_RECONCILE_GRACE_MS,
  });
  assert.equal(decision.ready, true);
  assert.equal(decision.mode, 'clean-timeout-fallback');
});

test('the clean fallback does not unlock a fresh blocked delivery', () => {
  const delivery = { state: 'blocked_local_changes', head: 'a' };
  const decision = reconciliationDecision(delivery, clean('a', 0), false, {
    blockedForMs: DEFAULT_RECONCILE_GRACE_MS - 1,
  });
  assert.equal(decision.ready, false);
});

test('O6: blocked receipt text carries status --short plus dirtyFiles', () => {
  const section = formatLocalChangesSection({
    dirty: true,
    dirtyFiles: ['src/a.ts', 'src/b.ts'],
    statusShort: ' M src/a.ts\n?? src/b.ts',
  });
  assert.match(section, /git status --short/);
  assert.match(section, /M src\/a\.ts/);
  assert.match(section, /dirtyFiles（2）：src\/a\.ts, src\/b\.ts/);
});

test('O6: statusShort falls back to dirtyFiles when git gave none', () => {
  const section = formatLocalChangesSection({ dirty: true, dirtyFiles: ['x.ts'], statusShort: '' });
  assert.match(section, /\?\? x\.ts/);
  assert.equal(formatLocalChangesSection(null), '');
});

test('O6: capStatusShort truncates long listings', () => {
  assert.equal(capStatusShort(''), '');
  const long = Array.from({ length: 200 }, (_, i) => ` M f${i}.ts`).join('\n');
  const capped = capStatusShort(long);
  assert.match(capped, /截断，共 200 行/);
  assert.ok(capped.length < long.length);
});

test('O6: scratch receipts round-trip through the per-job dir', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-scratch-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const dir = scratchDirForJob('job-1', root);
  assert.equal(dir, path.join(root, 'ai-hub-worker', 'scratch', 'job-1'));
  assert.deepEqual(await readScratchReceipts(dir), []);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'receipt.md'), '# done\nall green\n');
  const entries = await readScratchReceipts(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'receipt.md');
  assert.match(entries[0].content, /all green/);
  const section = formatScratchSection(entries);
  assert.match(section, /runner 自写回执/);
  assert.match(section, /all green/);
  assert.equal(formatScratchSection([]), '');
  assert.equal(scratchDirForJob('../../evil').includes('..'), false);
});

test('P1: extractRunnerUsage passes through known usage shapes, never invents', () => {
  // claude stream-json result shape (cf server claudeCli.ts usage fields).
  assert.deepEqual(
    extractRunnerUsage({ type: 'result', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 } }),
    { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 },
  );
  // codex exec --json style nested message usage.
  assert.deepEqual(
    extractRunnerUsage({ type: 'turn.completed', message: { usage: { input_tokens: 7, output_tokens: 3 } } }),
    { inputTokens: 7, outputTokens: 3 },
  );
  // OpenAI-style prompt/completion + cached details.
  assert.deepEqual(
    extractRunnerUsage({ usage: { prompt_tokens: 11, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } } }),
    { inputTokens: 11, outputTokens: 5, cacheReadTokens: 2 },
  );
  // camelCase passthrough.
  assert.deepEqual(
    extractRunnerUsage({ result: { usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 } } }),
    { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 },
  );
  // No usable numbers anywhere: leave the field empty, never zero-fill.
  assert.equal(extractRunnerUsage({ type: 'text', part: { text: 'hello' } }), null);
  assert.equal(extractRunnerUsage({ usage: { input_tokens: 10 } }), null);
  assert.equal(extractRunnerUsage({ usage: { input_tokens: -1, output_tokens: 2 } }), null);
  assert.equal(extractRunnerUsage(null), null);
  assert.equal(extractRunnerUsage('usage'), null);
});

test('P1: OpenCode step_finish tokens are read as a per-step reading', () => {
  // Line shape captured from `opencode run --format json` 1.18.29.
  assert.deepEqual(
    extractRunnerUsage({
      type: 'step_finish',
      part: { type: 'step-finish', tokens: { total: 12546, input: 12414, output: 11, reasoning: 8, cache: { write: 0, read: 113 } }, cost: 0.001245426 },
    }),
    { inputTokens: 12414, outputTokens: 19, cacheReadTokens: 113, perStep: true },
  );
  assert.equal(extractRunnerUsage({ type: 'step_finish', part: { tokens: { input: 5 } } }), null);
});
