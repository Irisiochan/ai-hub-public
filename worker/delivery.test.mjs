import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyDelivery,
  DEFAULT_RECONCILE_GRACE_MS,
  extractDeliveryDeclaration,
  reconciliationDecision,
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
