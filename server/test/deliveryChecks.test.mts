import assert from 'node:assert/strict';
import { buildDeliveryChecks } from '../src/workers/deliveryChecks.js';

const job = (permissions: Record<string, unknown>, options: Record<string, unknown> = {}) => ({
  permissions: JSON.stringify(permissions),
  options: JSON.stringify(options),
});

const delivery = (overrides: Record<string, unknown> = {}) => ({
  declared: {
    committed: true,
    pushed: false,
    stage: 'delivered_waiting_deploy',
  },
  git: {
    head: 'bbbbbbbb',
    dirty: false,
    dirtyFiles: [],
    ahead: 1,
    behind: 0,
    branch: 'review-checks',
  },
  before: { head: 'aaaaaaaa', dirty: false, ahead: 0 },
  ...overrides,
});

function check(
  id: string,
  deliveryState: string,
  value: Record<string, unknown>,
  permissions: Record<string, unknown> = { write: true, shell: true, ssh: false },
  options: Record<string, unknown> = { routeClass: 'implement' },
) {
  const found = buildDeliveryChecks(job(permissions, options), deliveryState, value)
    .find((item) => item.id === id);
  assert.ok(found, `missing check ${id}`);
  return found;
}

assert.equal(
  check(
    'readonly-claims-write',
    'delivered',
    delivery({ declared: { committed: true, pushed: true, stage: 'closed_loop' } }),
    { write: true, shell: false, ssh: false },
    { routeClass: 'review' },
  ).pass,
  false,
  'review/recon routes cannot claim a write even if write permission was accidentally true',
);

assert.equal(
  check(
    'readonly-claims-deploy-stage',
    'blocked_local_changes',
    delivery({ declared: { committed: false, pushed: false, stage: 'online_waiting_validation' } }),
    { write: false, shell: false, ssh: false },
  ).pass,
  false,
);

assert.equal(
  check(
    'pushed-but-ahead',
    'delivered',
    delivery({
      declared: { committed: true, pushed: true, stage: 'closed_loop' },
      git: { head: 'bbbbbbbb', dirty: false, dirtyFiles: [], ahead: 2, behind: 0, branch: 'main' },
    }),
  ).pass,
  false,
);

assert.equal(
  check(
    'committed-but-no-new-commit',
    'delivered',
    delivery({
      declared: { committed: true, pushed: true, stage: 'closed_loop' },
      git: { head: 'aaaaaaaa', dirty: false, dirtyFiles: [], ahead: 0, behind: 0, branch: 'main' },
    }),
  ).pass,
  false,
);

assert.equal(
  check(
    'declared-vs-git-changed',
    'blocked_local_changes',
    delivery({
      declared: { committed: false, pushed: false, blocker: 'validation failed' },
      git: { head: 'aaaaaaaa', dirty: false, dirtyFiles: [], ahead: 0, behind: 0, branch: 'main' },
    }),
  ).pass,
  false,
);

assert.equal(
  check(
    'blocked-missing-stage',
    'blocked_unpushed',
    delivery({ declared: { committed: true, pushed: false } }),
  ).pass,
  false,
);

const allPassing = buildDeliveryChecks(
  job({ write: true, shell: true, ssh: false }, { routeClass: 'implement' }),
  'blocked_unpushed',
  delivery(),
);
assert.equal(allPassing.length, 6);
assert.ok(allPassing.every((item) => item.pass && !item.skipped));

const legacy = buildDeliveryChecks(
  job({ write: true, shell: true, ssh: false }, { routeClass: 'implement' }),
  'delivered',
  { state: 'delivered', declared: { committed: true, pushed: true, stage: 'closed_loop' } },
);
for (const id of ['pushed-but-ahead', 'committed-but-no-new-commit', 'declared-vs-git-changed']) {
  const item = legacy.find((candidate) => candidate.id === id);
  assert.equal(item?.pass, true);
  assert.equal(item?.skipped, true, `${id} must skip old runner payloads without git/before evidence`);
}

console.log('[PASS] worker delivery contradiction checks and old-runner skips');
