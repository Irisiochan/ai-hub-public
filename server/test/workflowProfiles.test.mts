import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type JobRow } from '../src/db.js';
import { buildDelegateTools } from '../src/agents/gatewayTools.js';
import { JobStore } from '../src/workers/jobStore.js';
import {
  WorkflowProfileStore,
  problemFingerprint,
  workflowFingerprint,
} from '../src/workers/workflowProfiles.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-workflow-profiles-'));
const db = openDb(path.join(dir, 'test.db'));

try {
  const store = new WorkflowProfileStore(db);
  assert.equal(store.state().active.id, 'protocol-a');

  const preview = store.preview('protocol-b', 1);
  assert.ok(!('error' in preview));
  assert.ok(preview.changes.some((change) => change.stage === 'execute'));
  assert.equal(preview.validation.ok, true);

  const switched = store.switchTo('protocol-b', 1, 'test');
  assert.ok(!('error' in switched));
  assert.equal(switched.active.id, 'protocol-b');
  assert.equal(store.audit(5)[0]?.action, 'switch');

  const fingerprint = problemFingerprint('same problem', 'tasks/demo.md');
  const primary = store.snapshot({ stage: 'execute', taskPath: 'tasks/demo.md', problemFingerprint: fingerprint });
  assert.equal(primary.selected.runner, 'grok');
  assert.equal(primary.selected.model, 'grok-4.6');
  assert.equal(primary.fallbackActive, false);
  assert.match(primary.workflowFingerprint, /^[a-f0-9]{64}$/);

  const qualityJob = (id: string) => ({
    id,
    options: JSON.stringify({ workflow: primary }),
  } as JobRow);
  assert.deepEqual(store.record(qualityJob('job-infrastructure'), { quality: 'infrastructure', detail: '529' }), {
    counted: false,
    reason: 'infrastructure failures do not affect quality streaks',
  });
  assert.deepEqual(store.record(qualityJob('job-infrastructure'), { quality: 'inadequate' }), {
    counted: false,
    reason: 'job quality already recorded',
    quality: 'infrastructure',
  });
  assert.equal(store.record(qualityJob('job-poor-1'), { quality: 'inadequate' }).streak, 1);
  assert.equal(store.record(qualityJob('job-poor-2'), { quality: 'inadequate' }).streak, 2);
  const third = store.record(qualityJob('job-poor-3'), { quality: 'inadequate' });
  assert.equal(third.streak, 3);
  assert.equal(third.fallbackActive, true);

  const fallback = store.snapshot({ stage: 'execute', taskPath: 'tasks/demo.md', problemFingerprint: fingerprint });
  assert.equal(fallback.selected.runner, 'codex');
  assert.equal(fallback.selected.model, 'gpt-5.6-sol');
  assert.equal(fallback.selected.reasoning, 'medium');
  assert.notEqual(fallback.workflowFingerprint, primary.workflowFingerprint);

  const changedProblem = store.snapshot({
    stage: 'execute',
    taskPath: 'tasks/demo.md',
    problemFingerprint: 'b'.repeat(64),
  });
  assert.equal(changedProblem.fallbackActive, false);
  assert.equal(changedProblem.selected.runner, 'grok');

  const reviewFingerprint = 'e'.repeat(64);
  const review = store.snapshot({ stage: 'review', taskPath: 'tasks/review.md', problemFingerprint: reviewFingerprint });
  assert.equal(review.selected.runner, 'codex');
  for (const id of ['review-poor-1', 'review-poor-2', 'review-poor-3']) {
    store.record({ id, options: JSON.stringify({ workflow: review }) } as JobRow, { quality: 'inadequate' });
  }
  const reviewFallback = store.snapshot({
    stage: 'review',
    taskPath: 'tasks/review.md',
    problemFingerprint: reviewFingerprint,
  });
  assert.equal(reviewFallback.selected.runner, 'claude');
  assert.equal(reviewFallback.selected.model, 'claude-opus-4-7');
  assert.equal(reviewFallback.selected.reasoning, 'high');

  store.record(qualityJob('job-success'), { quality: 'success' });
  const reset = store.snapshot({ stage: 'execute', taskPath: 'tasks/demo.md', problemFingerprint: fingerprint });
  assert.equal(reset.fallbackActive, false);
  assert.equal(reset.selected.runner, 'grok');

  const jobs = new JobStore(db, { broadcast: () => {} } as never);
  const delegate = buildDelegateTools(jobs, db, 'codex', {
    workspaces: ['C:\\repo'],
    allowShell: true,
  }).find((tool) => tool.name === 'delegate_to_worker')!;
  const delegated = await delegate.exec({
    route_class: 'implement',
    workspace: 'C:\\repo',
    prompt: 'Implement the same bounded issue.',
    problem_fingerprint: fingerprint,
  });
  assert.equal(delegated.ok, true);
  const firstDelegated = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as JobRow;
  const firstOptions = JSON.parse(firstDelegated.options);
  assert.equal(firstDelegated.runner, 'grok');
  assert.equal(firstOptions.model, 'grok-4.6');
  assert.equal(JSON.parse(firstDelegated.permissions).shell, true, 'Grok coding execution needs terminal access');
  jobs.workflowProfiles.record(firstDelegated, { quality: 'inadequate' });
  jobs.workflowProfiles.record({ ...firstDelegated, id: 'delegated-poor-2' }, { quality: 'inadequate' });
  jobs.workflowProfiles.record({ ...firstDelegated, id: 'delegated-poor-3' }, { quality: 'inadequate' });
  const fallbackDelegated = await delegate.exec({
    route_class: 'implement',
    workspace: 'C:\\repo',
    prompt: 'Retry the same bounded issue.',
    problem_fingerprint: fingerprint,
  });
  assert.equal(fallbackDelegated.ok, true);
  const secondDelegated = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as JobRow;
  const secondOptions = JSON.parse(secondDelegated.options);
  assert.equal(secondDelegated.runner, 'codex');
  assert.equal(secondOptions.model, 'gpt-5.6-sol');
  assert.equal(secondOptions.reasoning, 'medium');
  assert.equal(secondOptions.workflow.fallbackActive, true);

  const { workflowFingerprint: _originalFingerprint, ...primaryInput } = primary;
  const v3ChangedByProfile = workflowFingerprint({
    ...primaryInput,
    profileId: 'protocol-a',
    profileVersion: 1,
  });
  assert.notEqual(v3ChangedByProfile, primary.workflowFingerprint);

  const rolledBack = store.rollback('test');
  assert.ok(!('error' in rolledBack));
  assert.equal(rolledBack.active.id, 'protocol-a');
  assert.equal(store.audit(5)[0]?.action, 'rollback');

  const pinnedPlanHash = 'c'.repeat(64);
  const pinnedSnapshot = {
    ...primary,
    taskPath: 'tasks/pinned.md',
    problemFingerprint: pinnedPlanHash,
  };
  const { workflowFingerprint: _pinnedOld, ...pinnedInput } = pinnedSnapshot;
  pinnedSnapshot.workflowFingerprint = workflowFingerprint(pinnedInput);
  db.prepare(
    "INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-test', 'Room', 'api', 'room', '{}')"
  ).run();
  const pinnedFingerprint = 'd'.repeat(64);
  db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
     VALUES ('room-test', 'room-host', 'user', 'text', 'dispatch', 'done', ?, 'main', ?)`
  ).run(JSON.stringify({
    roomHost: {
      workflow: pinnedSnapshot,
      coordination: {
        kind: 'execution',
        taskPath: 'tasks/pinned.md',
        branch: 'codex/pinned',
        workspace: 'C:\\repo',
        planHash: pinnedPlanHash,
        executor: 'codex',
      },
    },
  }), `coordination:v2:tasks/pinned.md:${pinnedFingerprint}`);
  const pinnedDelegate = buildDelegateTools(jobs, db, 'codex', {
    workspaces: ['C:\\repo'],
    allowShell: true,
  }, 'room-test').find((tool) => tool.name === 'delegate_to_worker')!;
  const pinnedOutcome = await pinnedDelegate.exec({
    route_class: 'implement',
    workspace: 'C:\\repo',
    prompt: [
      '[AI_HUB_COORDINATION_V2]',
      'taskPath=tasks/pinned.md',
      `planHash=${pinnedPlanHash}`,
      `fingerprint=${pinnedFingerprint}`,
    ].join('\n'),
    problem_fingerprint: pinnedPlanHash,
  });
  assert.equal(pinnedOutcome.ok, true);
  const pinnedJob = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as JobRow;
  assert.equal(pinnedJob.runner, 'grok', 'in-flight room dispatch keeps its pre-switch Profile B snapshot');
  assert.equal(JSON.parse(pinnedJob.options).workflow.profileId, 'protocol-b');

  console.log('workflow profile tests: ok');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
