import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  classifyDelivery,
  collectStructuredReceipt,
  deliveryCompletesJob,
  DEFAULT_RECONCILE_GRACE_MS,
  extractDeliveryDeclaration,
  reconciliationDecision,
  repoDeliveryEvidence,
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
