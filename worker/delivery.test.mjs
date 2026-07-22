import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDelivery, reconciliationDecision } from './delivery.mjs';

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
