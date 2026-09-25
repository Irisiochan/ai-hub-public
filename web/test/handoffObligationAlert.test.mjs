import assert from 'node:assert/strict';
import {
  ROOM_TASKS_OPEN_EVENT,
  createRecoveryWatcher,
  firstUnresolvedTask,
  matchRecovery,
  parseHandoffObligationMeta,
  recoveryEvidenceText,
  summarizeRecovery,
} from '../src/roomTasks/handoffObligation.ts';

assert.equal(ROOM_TASKS_OPEN_EVENT, 'room-tasks:open');

assert.deepEqual(parseHandoffObligationMeta('{}'), null);
assert.deepEqual(parseHandoffObligationMeta('not json'), null);
assert.deepEqual(
  parseHandoffObligationMeta(JSON.stringify({ handoffObligation: true, taskIds: [] })),
  null,
);
assert.deepEqual(
  parseHandoffObligationMeta(JSON.stringify({ handoffObligation: true })),
  null,
);
assert.deepEqual(
  parseHandoffObligationMeta(JSON.stringify({
    handoffObligation: true,
    taskIds: ['task-a', 'task-b'],
    failedTurnId: 'turn-1',
  })),
  { taskIds: ['task-a', 'task-b'], failedTurnId: 'turn-1' },
);
assert.deepEqual(
  parseHandoffObligationMeta(JSON.stringify({ handoffObligation: true, taskIds: ['task-a'] })),
  { taskIds: ['task-a'] },
);
// Old fields never grant a match: only the gateway-written marker counts.
assert.deepEqual(
  parseHandoffObligationMeta(JSON.stringify({ handoffObligation: false, taskIds: ['task-a'] })),
  null,
);

const recoveries = [
  { turnId: 'turn-1', recovered: false, evidence: [] },
  { turnId: 'turn-2', recovered: true, evidence: [{ eventId: 9, kind: 'handoff-created' }] },
];
assert.equal(matchRecovery(recoveries, 'turn-1')?.recovered, false);
assert.equal(matchRecovery(recoveries, 'turn-2')?.recovered, true);
assert.equal(matchRecovery(recoveries, 'turn-9'), undefined);
assert.equal(matchRecovery([], 'turn-1'), undefined);
assert.equal(matchRecovery(undefined, 'turn-1'), undefined);
// No reliable turn association -> unconfirmed, never borrows another failed
// turn's recovery on the same task.
assert.equal(matchRecovery(recoveries, undefined), undefined);

assert.equal(recoveryEvidenceText(undefined), '');
assert.equal(recoveryEvidenceText([]), '');
assert.equal(
  recoveryEvidenceText([{ eventId: 9, kind: 'handoff-created' }, { eventId: 12, kind: 'execution-started' }]),
  'handoff-created#9、execution-started#12',
);

// Whole-box verdict: every associated task must confirm, otherwise the
// unresolved alarm stays with per-item details.
assert.deepEqual(summarizeRecovery([]), { recovered: false, recoveredCount: 0, total: 0 });
assert.deepEqual(
  summarizeRecovery([
    { taskId: 'a', taskPath: 'tasks/a.md', state: 'recovered', evidence: '' },
    { taskId: 'b', taskPath: 'tasks/b.md', state: 'recovered', evidence: '' },
  ]),
  { recovered: true, recoveredCount: 2, total: 2 },
);
assert.deepEqual(
  summarizeRecovery([
    { taskId: 'a', taskPath: 'tasks/a.md', state: 'recovered', evidence: '' },
    { taskId: 'b', taskPath: 'tasks/b.md', state: 'pending', evidence: '' },
  ]),
  { recovered: false, recoveredCount: 1, total: 2 },
);
assert.deepEqual(
  summarizeRecovery([
    { taskId: 'a', taskPath: 'tasks/a.md', state: 'recovered', evidence: '' },
    { taskId: 'b', taskPath: 'tasks/b.md', state: 'unknown', evidence: '' },
  ]),
  { recovered: false, recoveredCount: 1, total: 2 },
);
assert.equal(
  firstUnresolvedTask([
    { taskId: 'a', taskPath: 'tasks/a.md', state: 'recovered', evidence: '' },
    { taskId: 'b', taskPath: 'tasks/b.md', state: 'unknown', evidence: '' },
  ])?.taskId,
  'b',
);
assert.equal(
  firstUnresolvedTask([
    { taskId: 'a', taskPath: 'tasks/a.md', state: 'recovered', evidence: '' },
  ]),
  undefined,
);

// Watcher lifecycle: recovery that lands DURING the mount flips the box
// without remount; polling stops once the whole box confirms.
{
  let loads = 0;
  const snapshots = [];
  const watcher = createRecoveryWatcher({
    intervalMs: 5,
    load: async () => {
      loads += 1;
      // First loads: nothing recovered yet; later loads: all confirmed.
      if (loads < 3) return [{ taskId: 'a', taskPath: 'tasks/a.md', state: 'pending', evidence: '' }];
      return [{ taskId: 'a', taskPath: 'tasks/a.md', state: 'recovered', evidence: 'handoff-created#9' }];
    },
    onUpdate: (snapshot) => {
      snapshots.push(snapshot);
    },
  });
  watcher.start();
  const deadline = Date.now() + 2000;
  while (
    snapshots.length === 0 ||
    !snapshots[snapshots.length - 1].summary.recovered
  ) {
    if (Date.now() > deadline) throw new Error('watcher never observed the mid-mount recovery');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(loads >= 3, 'watcher kept polling while unconfirmed');
  assert.equal(snapshots[snapshots.length - 1].summary.recovered, true);
  const pollsAfterRecover = loads;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(loads, pollsAfterRecover, 'polling stops once the whole box confirms');
  watcher.stop();
}

// Watcher never flips on partial recovery and stop() halts polling.
{
  let loads = 0;
  const snapshots = [];
  const watcher = createRecoveryWatcher({
    intervalMs: 5,
    load: async () => {
      loads += 1;
      return [
        { taskId: 'a', taskPath: 'tasks/a.md', state: 'recovered', evidence: '' },
        { taskId: 'b', taskPath: 'tasks/b.md', state: 'pending', evidence: '' },
      ];
    },
    onUpdate: (snapshot) => {
      snapshots.push(snapshot);
    },
  });
  watcher.start();
  const deadline = Date.now() + 2000;
  while (snapshots.length < 2) {
    if (Date.now() > deadline) throw new Error('watcher did not poll');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(snapshots.every((snapshot) => snapshot.summary.recovered === false));
  watcher.stop();
  const frozen = loads;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(loads, frozen, 'stop() halts polling');
}

console.log('handoff obligation alert contracts passed: meta parsing, recovery matching, evidence text');
