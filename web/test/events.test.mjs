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
assert.match(
  app,
  /onStatus: \(status\) => \{\s*deltaBatcher\.flushNow\(\);\s*handleStatus\(status\);/,
  'live status events must flush pending deltas before using the guarded reconcile handler'
);
assert.match(app, /onDelta: \(delta\) => deltaBatcher\.add\(delta\)/, 'streaming deltas must use the bounded batcher');
assert.match(
  app,
  /\}, \[applyHeartbeat, handleStatus, resync, upsertMessage\]\);/,
  'the EventSource effect must depend only on stable callbacks'
);
assert.match(
  app,
  /lastSubscriptionRef\.current === selectedId/,
  'the initial render must not immediately reopen an equivalent subscription'
);
assert.match(app, /onWorker: workerState\.applyWorker/, 'the existing global stream must feed worker state');
assert.match(app, /onJobMessage: workerState\.applyJobMessage/, 'execution logs must use that same stream');
assert.match(app, /onJob: \(job: WorkerJob\) => \{\s*workerState\.applyJob\(job\);/,
  'job state must update before optional sound handling');
assert.match(app, /onReconnect: \(\) => \{[\s\S]*?workerState\.reconcile\(\)/,
  'reconnect and visibility recovery must reconcile the shared worker state');

console.log('event connection reconciliation checks passed');
