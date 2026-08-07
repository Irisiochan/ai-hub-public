import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/api.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');

assert.match(
  source,
  /const open = \(reconcileAfterOpen = false\)/,
  'opening a replacement EventSource must carry explicit reconciliation intent'
);
assert.match(
  source,
  /const shouldResync = hadError \|\| resyncOnOpen;/,
  'both error recovery and clean subscription refresh must reconcile'
);
assert.match(
  source,
  /refresh: \(\) => open\(true\)/,
  'changing contact subscriptions must reconcile after the new stream opens'
);
assert.match(
  source,
  /readyState === EventSource\.CLOSED\) open\(true\)/,
  'a closed stream restored from the background must reconcile after opening'
);
assert.equal(
  app.match(/shouldReconcileMessagesAfterStatus\(/g)?.length,
  2,
  'both contact snapshots and live terminal status events must check for streaming rows'
);
assert.match(app, /onStatus: handleStatus/, 'live status events must use the guarded reconcile handler');
assert.match(
  app,
  /\}, \[handleStatus, resync, upsertMessage\]\);/,
  'the EventSource effect must depend only on stable callbacks'
);
assert.match(
  app,
  /lastSubscriptionRef\.current === selectedId/,
  'the initial render must not immediately reopen an equivalent subscription'
);

console.log('event connection reconciliation checks passed');
