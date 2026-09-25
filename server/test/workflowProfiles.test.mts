import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type JobRow } from '../src/platform/db.js';
import { buildDelegateTools } from '../src/jobs/delegateTools.js';
import { JobStore } from '../src/jobs/jobStore.js';
import {
  WorkflowProfileStore,
  problemFingerprint,
  workflowFingerprint,
} from '../src/workflow/workflowProfiles.js';

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
  assert.equal(primary.selected.runner, 'opencode');
  assert.equal(primary.selected.model, 'opencode-go/muse-spark-1.3-contributor');
  assert.equal(primary.selected.reasoning, 'high');
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
  const overrideJob = (id: string) => ({
    id,
    runner: 'claude',
    options: JSON.stringify({ workflow: primary, runnerSource: 'override' }),
  } as JobRow);
  for (const id of ['override-poor-1', 'override-poor-2', 'override-poor-3']) {
    assert.deepEqual(store.record(overrideJob(id), { quality: 'inadequate' }), {
      counted: false,
      reason: 'manual runner overrides do not affect profile quality streaks',
    });
  }
  const afterOverrides = store.snapshot({
    stage: 'execute',
    taskPath: 'tasks/demo.md',
    problemFingerprint: fingerprint,
  });
  assert.equal(afterOverrides.fallbackActive, false);
  assert.equal(afterOverrides.selected.runner, 'opencode');
  assert.equal(store.record(qualityJob('job-poor-1'), { quality: 'inadequate' }).streak, 1);
  const second = store.record(qualityJob('job-poor-2'), { quality: 'inadequate' });
  assert.equal(second.streak, 2);
  assert.equal(second.upgradeActive, true);
  assert.equal(second.escalateToHuman, false);

  const upgraded = store.snapshot({ stage: 'execute', taskPath: 'tasks/demo.md', problemFingerprint: fingerprint });
  assert.equal(upgraded.selected.runner, 'codex');
  assert.equal(upgraded.selected.model, 'gpt-6-astra');
  assert.equal(upgraded.escalateToHuman, false);

  const selfReport = store.record(qualityJob('job-self-success'), { quality: 'success' });
  assert.equal(selfReport.counted, false);
  const stillUpgraded = store.snapshot({
    stage: 'execute',
    taskPath: 'tasks/demo.md',
    problemFingerprint: fingerprint,
  });
  assert.equal(stillUpgraded.selected.runner, 'codex');
  assert.equal(stillUpgraded.escalateToHuman, false);

  const third = store.record(qualityJob('job-poor-3'), { quality: 'inadequate' });
  assert.equal(third.streak, 3);
  assert.equal(third.fallbackActive, true);
  assert.equal(third.escalateToHuman, true);

  const escalated = store.snapshot({ stage: 'execute', taskPath: 'tasks/demo.md', problemFingerprint: fingerprint });
  assert.equal(escalated.selected.runner, 'codex');
  assert.equal(escalated.selected.model, 'gpt-6-astra');
  assert.equal(escalated.escalateToHuman, true);
  assert.equal(escalated.fallbackActive, true);

  const changedProblem = store.snapshot({
    stage: 'execute',
    taskPath: 'tasks/demo.md',
    problemFingerprint: 'b'.repeat(64),
  });
  assert.equal(changedProblem.fallbackActive, false);
  assert.equal(changedProblem.selected.runner, 'opencode');

  const reviewFingerprint = 'e'.repeat(64);
  const review = store.snapshot({ stage: 'review', taskPath: 'tasks/review.md', problemFingerprint: reviewFingerprint });
  assert.equal(review.selected.runner, 'grok');
  for (const id of ['review-poor-1', 'review-poor-2', 'review-poor-3']) {
    store.record({ id, options: JSON.stringify({ workflow: review }) } as JobRow, { quality: 'inadequate' });
  }
  const reviewEscalated = store.snapshot({
    stage: 'review',
    taskPath: 'tasks/review.md',
    problemFingerprint: reviewFingerprint,
  });
  assert.equal(reviewEscalated.selected.runner, 'grok');
  assert.equal(reviewEscalated.selected.model, 'grok-4.6');
  assert.equal(reviewEscalated.escalateToHuman, true);

  const fixFp = 'f'.repeat(64);
  const execMiss = store.snapshot({ stage: 'execute', taskPath: 'tasks/fix-loop.md', problemFingerprint: fixFp });
  store.record({ id: 'exec-miss', options: JSON.stringify({ workflow: execMiss }) } as JobRow, { quality: 'inadequate' });
  const fixAfterOne = store.snapshot({ stage: 'fix', taskPath: 'tasks/fix-loop.md', problemFingerprint: fixFp });
  assert.equal(fixAfterOne.selected.runner, 'opencode');
  store.record({ id: 'fix-miss', options: JSON.stringify({ workflow: fixAfterOne }) } as JobRow, { quality: 'inadequate' });
  const fixUpgraded = store.snapshot({ stage: 'fix', taskPath: 'tasks/fix-loop.md', problemFingerprint: fixFp });
  assert.equal(fixUpgraded.selected.runner, 'codex');
  assert.equal(fixUpgraded.escalateToHuman, false);
  const executeSeesFix = store.snapshot({ stage: 'execute', taskPath: 'tasks/fix-loop.md', problemFingerprint: fixFp });
  assert.equal(executeSeesFix.selected.runner, 'codex', 'execute cannot bypass the combined implementation streak by changing stage');

  store.record({
    id: 'job-success',
    options: JSON.stringify({
      workflow: store.snapshot({
        stage: 'review',
        taskPath: 'tasks/demo.md',
        problemFingerprint: fingerprint,
      }),
    }),
  } as JobRow, { quality: 'success' });
  const reset = store.snapshot({ stage: 'execute', taskPath: 'tasks/demo.md', problemFingerprint: fingerprint });
  assert.equal(reset.fallbackActive, false);
  assert.equal(reset.selected.runner, 'opencode');

  const jobs = new JobStore(db, { broadcast: () => {} } as never);
  const delegate = buildDelegateTools(jobs, db, 'codex', {
    workspaces: ['C:\\repo'],
    allowShell: true,
    maxOpenJobs: 10,
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
  assert.equal(firstDelegated.runner, 'opencode');
  assert.equal(firstOptions.model, 'opencode-go/muse-spark-1.3-contributor');
  assert.equal(JSON.parse(firstDelegated.permissions).shell, true, 'OpenCode coding execution needs terminal access');
  // Rationale (model-driven workflow): delegation routes via the execute
  // module binding; quality counters are observations only and never divert
  // to arbitration or escalate to User. Next-module decisions belong to
  // explicit model handoffs (task_handoff), not to streak math.
  const moduleInvocation = { moduleId: 'execute' as const, taskPath: '', problemFingerprint: fingerprint };
  jobs.workflowModules.record({ id: 'delegated-poor-1' }, moduleInvocation, { quality: 'inadequate' });
  jobs.workflowModules.record({ id: 'delegated-poor-2' }, moduleInvocation, { quality: 'inadequate' });
  jobs.workflowModules.record({ id: 'delegated-poor-3' }, moduleInvocation, { quality: 'inadequate' });
  const stillPrimary = await delegate.exec({
    route_class: 'implement',
    workspace: 'C:\\repo',
    prompt: 'Retry the same bounded issue after three Sora misses.',
    problem_fingerprint: fingerprint,
  });
  assert.equal(stillPrimary.ok, true);
  const thirdJob = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as JobRow;
  assert.equal(thirdJob.runner, 'opencode', 'three inadequates stay on the primary binding');
  jobs.workflowModules.record({ id: 'delegated-poor-4' }, moduleInvocation, { quality: 'inadequate' });
  const stillPrimaryAfterFour = await delegate.exec({
    route_class: 'implement',
    workspace: 'C:\\repo',
    prompt: 'Retry the same bounded issue after four Sora misses.',
    problem_fingerprint: fingerprint,
  });
  assert.equal(stillPrimaryAfterFour.ok, true);
  const fourthJob = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as JobRow;
  assert.equal(fourthJob.runner, 'opencode', 'no automatic arbitration upgrade on the fourth miss');
  assert.equal(JSON.parse(fourthJob.options).workflowModule.arbitrationActive, false);
  jobs.workflowModules.record({ id: 'delegated-poor-5' }, moduleInvocation, { quality: 'inadequate' });
  const stillPrimaryAfterFive = await delegate.exec({
    route_class: 'implement',
    workspace: 'C:\\repo',
    prompt: 'Retry the same bounded issue.',
    problem_fingerprint: fingerprint,
  });
  assert.equal(stillPrimaryAfterFive.ok, true, 'no automatic human escalation on the fifth miss');
  const policyStillPrimary = jobs.create({
    requestedBy: 'codex',
    runner: 'opencode',
    workspace: 'C:\\repo',
    prompt: 'Retry the same bounded issue.',
    permissions: { write: true, shell: true, ssh: false },
    options: {
      routeClass: 'implement',
      runnerSource: 'policy',
      problemFingerprint: fingerprint,
    },
  });
  assert.ok(!('error' in policyStillPrimary), 'direct creates are never streak-gated');
  const overrideDelegated = await delegate.exec({
    route_class: 'implement',
    runner: 'codex',
    runner_override_reason: 'User decided to use codex for this attempt',
    workspace: 'C:\\repo',
    prompt: 'User chose codex for the same bounded issue.',
    problem_fingerprint: fingerprint,
  });
  assert.equal(overrideDelegated.ok, true);
  const secondDelegated = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as JobRow;
  const secondOptions = JSON.parse(secondDelegated.options);
  assert.equal(secondDelegated.runner, 'codex');
  assert.equal(secondOptions.runnerSource, 'override');
  assert.equal(secondOptions.workflowModule.escalateToHuman, false);

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
  // Rationale: the room-host marker authority is retired. A marker prompt is
  // inert text for DM delegates: dispatch follows the ordinary contact
  // rules and the current module binding, never a persisted dispatch row.
  // History rows below stay readable; they grant nothing.
  const pinnedModuleRevision = jobs.workflowModules.revision();
  db.prepare(
    "INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-test', 'Room', 'api', 'room', '{}')"
  ).run();
  const pinnedFingerprint = 'd'.repeat(64);
  db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
     VALUES ('room-test', 'room-host', 'user', 'text', 'dispatch', 'done', ?, 'main', ?)`
  ).run(JSON.stringify({
    roomHost: {
      workflowModule: {
        moduleId: 'execute',
        bindingRevision: pinnedModuleRevision,
        taskPath: 'tasks/pinned.md',
        problemFingerprint: pinnedPlanHash,
      },
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
    maxOpenJobs: 10,
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
  assert.equal(pinnedOutcome.ok, true, 'marker text dispatches as an ordinary DM task');
  const pinnedJob = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as JobRow;
  assert.equal(pinnedJob.runner, 'opencode', 'ordinary routing follows the current execute binding');
  assert.equal(JSON.parse(pinnedJob.options).workflowModule.moduleId, 'execute');

  console.log('workflow profile tests: ok');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
