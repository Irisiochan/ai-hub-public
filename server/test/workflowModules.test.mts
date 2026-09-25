// Fixed workflow modules: migration, runtime, caps, takeover, reserve filter.
// Backend acceptance behavior for docs/workflow-modules-plan.md. No live
// provider calls; temp DBs only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type ContactRow, type Db } from '../src/platform/db.js';
import { AgentManager } from '../src/runtime/manager.js';
import {
  filterWorkflowRoomTargets,
  roomMentionsAll,
} from '../src/rooms/roomTargets.js';
import { buildWorkflowModulesView } from '../src/jobs/workflowModuleRoutes.js';
import { JobStore } from '../src/jobs/jobStore.js';
import {
  DEFAULT_MODULE_BINDINGS,
  isWorkflowRoomConfig,
  supportedEfforts,
  WorkflowModulesStore,
} from '../src/workflow/workflowModules.js';

function tempDb(): { dir: string; db: Db } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-wm-'));
  return { dir, db: openDb(path.join(dir, 'hub.db')) };
}

function seedContacts(db: Db): void {
  const insert = db.prepare(
    "INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', ?)",
  );
  insert.run('codex', 'Codex', 'codex', JSON.stringify({}));
  insert.run('muse', 'Sora', 'opencode-cli', JSON.stringify({}));
  insert.run('aye', '阿野', 'grok-cli', JSON.stringify({}));
  insert.run('claude', 'Claude', 'claude-cli', JSON.stringify({}));
  insert.run('outsider', 'Outsider', 'api', JSON.stringify({}));
  db.prepare(
    "INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-1', 'Room', 'room', 'room', ?)",
  ).run(JSON.stringify({
    members: ['codex', 'muse', 'aye', 'outsider'],
    coordination: { enabled: true, orchestrator: 'codex' },
    reactionRounds: 0,
  }));
}

function setup(): { dir: string; db: Db; jobs: JobStore } {
  const { dir, db } = tempDb();
  seedContacts(db);
  const jobs = new JobStore(db, { broadcast() {} } as never);
  return { dir, db, jobs };
}

function teardown(dir: string, db: Db): void {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

function optionsOf(db: Db, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT options FROM jobs WHERE id = ?').get(id) as { options: string };
  return JSON.parse(row.options) as Record<string, unknown>;
}

function setStatus(db: Db, id: string, status: string, error?: string): void {
  db.prepare("UPDATE jobs SET status = ?, error = ? WHERE id = ?").run(status, error ?? null, id);
}

test('legacy execute+fix counters migrate summed and never double count', () => {
  const { dir, db } = tempDb();
  try {
    seedContacts(db);
    const task = 'tasks/migrate-sum.md';
    const fp = 'a'.repeat(64);
    db.prepare(`INSERT INTO workflow_quality_streaks
      (profile_id, profile_version, task_path, stage, problem_fingerprint, primary_runner, primary_model, streak)
      VALUES ('protocol-b', 1, ?, 'execute', ?, 'opencode', 'opencode-go/muse-spark-1.3-contributor', 2)`)
      .run(task, fp);
    db.prepare(`INSERT INTO workflow_quality_streaks
      (profile_id, profile_version, task_path, stage, problem_fingerprint, primary_runner, primary_model, streak)
      VALUES ('protocol-b', 1, ?, 'fix', ?, 'opencode', 'opencode-go/muse-spark-1.3-contributor', 1)`)
      .run(task, fp);
    db.prepare(`INSERT INTO workflow_quality_events
      (job_id, profile_id, profile_version, stage, problem_fingerprint, quality, detail)
      VALUES ('legacy-job-1', 'protocol-b', 1, 'execute', ?, 'inadequate', 'old miss')`)
      .run(fp);
    const modules = new WorkflowModulesStore(db);
    const migrated = modules.migrateLegacy();
    assert.equal(migrated.implementation, 1);
    assert.equal(migrated.events, 1);
    assert.equal(modules.implStreak(task, fp), 3);
    // A migrated job id can never count twice in the new tables.
    const again = modules.record(
      { id: 'legacy-job-1' },
      { moduleId: 'execute', taskPath: task, problemFingerprint: fp },
      { quality: 'inadequate' },
    );
    assert.equal(again.counted, false);
    assert.equal(modules.implStreak(task, fp), 3);
    const repeat = modules.migrateLegacy();
    assert.equal(modules.implStreak(task, fp), 3);
    assert.deepEqual(repeat, { implementation: 0, review: 0, events: 0 },
      'migration is one-shot: re-polling never restores or duplicates counts');
  } finally {
    teardown(dir, db);
  }
});

test('implementation streak observations: 2 marks arbitration, 3 marks human; invoke never routes', () => {
  const { dir, db, jobs } = setup();
  try {
    const modules = jobs.workflowModules;
    const task = 'tasks/impl-two-three.md';
    const fp = 'e'.repeat(64);
    const first = modules.record(
      { id: 'impl-miss-1' },
      { moduleId: 'execute', taskPath: task, problemFingerprint: fp },
      { quality: 'inadequate' },
    );
    assert.equal(first.streak, 1);
    assert.equal(first.arbitrationActive, false);
    assert.equal(first.escalateToHuman, false);
    const second = modules.record(
      { id: 'impl-miss-2' },
      { moduleId: 'execute', taskPath: task, problemFingerprint: fp },
      { quality: 'inadequate' },
    );
    assert.equal(second.streak, 2);
    assert.equal(second.arbitrationActive, true);
    assert.equal(second.escalateToHuman, false);
    const third = modules.record(
      { id: 'impl-miss-3' },
      { moduleId: 'execute', taskPath: task, problemFingerprint: fp },
      { quality: 'inadequate' },
    );
    assert.equal(third.streak, 3);
    assert.equal(third.arbitrationActive, false);
    assert.equal(third.escalateToHuman, true);
    const invocation = modules.invoke('execute', task, fp);
    assert.equal(invocation.arbitrationActive, false, 'counters never route on their own');
    assert.equal(invocation.escalateToHuman, false);
  } finally {
    teardown(dir, db);
  }
});

test('review inadequates stay observations; binding swaps never route (no auto escalation)', () => {
  const { dir, db, jobs } = setup();
  try {
    const modules = jobs.workflowModules;
    const task = 'tasks/review-three.md';
    const fp = 'b'.repeat(64);
    for (let index = 1; index <= 3; index++) {
      const invocation = modules.invoke('review', task, fp);
      assert.equal(invocation.escalateToHuman, false, 'counters never route on their own');
      assert.equal(invocation.arbitrationActive, false);
      modules.record({ id: `review-miss-${index}` }, invocation, { quality: 'inadequate' });
    }
    assert.equal(modules.reviewStreak(task, fp), 3, 'observations are still counted');
    assert.equal(modules.invoke('review', task, fp).escalateToHuman, false);
    // Swapping the review binding (same task/problem) preserves the counter.
    const revision = modules.revision();
    const swapped = modules.setBinding(
      'review',
      { contactId: 'codex', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' },
      revision,
      'User',
    );
    assert.equal(swapped.ok, true);
    assert.equal(modules.reviewStreak(task, fp), 3);
    assert.equal(modules.invoke('review', task, fp).escalateToHuman, false);
  } finally {
    teardown(dir, db);
  }
});

test('module permissions clamp forged caller input; deploy alone keeps ssh', () => {
  const { dir, db, jobs } = setup();
  try {
    // Forged widening on a read-only module is clamped, never granted.
    const review = jobs.create({
      requestedBy: 'codex',
      runner: 'grok',
      workspace: 'C:/repo',
      prompt: 'Review-only diagnostic.',
      permissions: { write: true, shell: true, ssh: true },
      options: { routeClass: 'review' },
    });
    assert.ok(!('error' in review));
    if (!('error' in review)) {
      const perms = JSON.parse(review.job.permissions);
      assert.equal(perms.write, false);
      assert.equal(perms.ssh, false);
      assert.equal(perms.shell, true);
    }
    // Forged ssh on execute is clamped; deploy keeps its fixed ssh grant.
    const execute = jobs.create({
      requestedBy: 'codex',
      runner: 'opencode',
      workspace: 'C:/repo',
      prompt: 'Implement scope.',
      permissions: { write: true, shell: true, ssh: true },
      options: { routeClass: 'implement' },
    });
    assert.ok(!('error' in execute));
    if (!('error' in execute)) {
      assert.equal(JSON.parse(execute.job.permissions).ssh, false);
    }
    const deploy = jobs.create({
      requestedBy: 'codex',
      runner: 'codex',
      workspace: 'C:/repo',
      prompt: 'Deploy frozen SHA.',
      permissions: { write: false, shell: true, ssh: true },
      options: {
        routeClass: 'mechanical',
        dispatchSource: 'harness-auto',
        workflowModule: { moduleId: 'deploy' },
        closureKind: 'deploy',
        frozenSha: 'd'.repeat(40),
      },
    });
    assert.ok(!('error' in deploy));
    if (!('error' in deploy)) {
      const perms = JSON.parse(deploy.job.permissions);
      assert.equal(perms.ssh, true);
      assert.equal(perms.write, false);
      assert.equal(optionsOf(db, deploy.job.id).workflowModule
        && (optionsOf(db, deploy.job.id).workflowModule as { moduleId: string }).moduleId, 'deploy');
    }
    // Untrusted callers cannot reach merge/deploy/arbitration via stage games.
    const forged = jobs.create({
      requestedBy: 'codex',
      runner: 'codex',
      workspace: 'C:/repo',
      prompt: 'Ordinary work.',
      permissions: { write: true, shell: true, ssh: true },
      options: { routeClass: 'implement', workflowModule: { moduleId: 'deploy' } },
    });
    assert.ok(!('error' in forged));
    if (!('error' in forged)) {
      assert.equal(
        (optionsOf(db, forged.job.id).workflowModule as { moduleId: string }).moduleId,
        'execute',
      );
      assert.equal(JSON.parse(forged.job.permissions).ssh, false);
    }
  } finally {
    teardown(dir, db);
  }
});

test('contract view exposes modules, agents, jobs, audit with pool isolation', () => {
  const { dir, db, jobs } = setup();
  try {
    const created = jobs.create({
      requestedBy: 'codex',
      runner: 'opencode',
      workspace: 'C:/repo',
      prompt: 'Contract view job.',
      permissions: { write: true, shell: true, ssh: false },
      options: { routeClass: 'implement', problemFingerprint: 'c'.repeat(64) },
    });
    assert.ok(!('error' in created));
    if ('error' in created) return;
    const view = buildWorkflowModulesView(db, jobs, () => ({
      'credential:grok': { blocked: true, reason: 'grok auth expired' },
    }));
    assert.equal(typeof view.revision, 'number');
    assert.equal(view.modules.length, 7);
    const plan = view.modules.find((item) => item.id === 'plan')!;
    assert.deepEqual(plan.permissions, { write: false, shell: true, ssh: false });
    assert.deepEqual(plan.binding, DEFAULT_MODULE_BINDINGS.plan);
    assert.equal(plan.status, 'idle');
    const execute = view.modules.find((item) => item.id === 'execute')!;
    assert.equal(execute.status, 'running', 'active execute job marks its module running');
    assert.equal(view.agents.length, 5);
    assert.equal(view.audit.length >= 1, true);
    const listed = view.jobs.find((item) => item.id === created.job.id);
    assert.ok(listed, 'recent jobs are listed with module bindings');
    assert.equal(listed!.moduleId, 'execute');
    assert.equal(listed!.bindingRevision, view.revision);
    assert.equal(listed!.canTakeover, false, 'pending jobs are not takeover-eligible');
  } finally {
    teardown(dir, db);
  }
});

test('pool failure blocks only that credential pool; agents share pool status', () => {
  const { dir, db, jobs } = setup();
  try {
    const view = buildWorkflowModulesView(db, jobs, () => ({
      'credential:grok': { blocked: true, reason: 'grok quota/auth unavailable (login-expired)' },
    }));
    const review = view.modules.find((item) => item.id === 'review')!;
    assert.equal(review.status, 'blocked');
    assert.match(review.statusDetail ?? '', /login-expired/);
    const maintenance = view.modules.find((item) => item.id === 'maintenance')!;
    assert.equal(maintenance.status, 'blocked', 'same-credential modules share pool status');
    const execute = view.modules.find((item) => item.id === 'execute')!;
    assert.equal(execute.status, 'idle');
    const aye = view.agents.find((item) => item.contactId === 'aye')!;
    assert.match(aye.unavailableReason ?? '', /login-expired/);
    assert.equal(aye.quotaPool, 'credential:grok');
    const muse = view.agents.find((item) => item.contactId === 'muse')!;
    assert.equal(muse.unavailableReason, undefined);
    assert.ok(muse.models.some((model) => model.id === 'opencode-go/muse-spark-1.3-contributor'
      && model.efforts.includes('max')), 'Muse Spark 1.3 advertises max effort');
    const outsider = view.agents.find((item) => item.contactId === 'outsider')!;
    assert.deepEqual(outsider.compatibleModules, []);
    assert.match(outsider.unavailableReason ?? '', /cannot enforce/);
  } finally {
    teardown(dir, db);
  }
});

test('takeover resumes pipeline with clean lineage and fences the old attempt', () => {
  const { dir, db, jobs } = setup();
  try {
    const candidateSha = 'e'.repeat(40);
    const frozenSha = 'f'.repeat(40);
    const created = jobs.create({
      requestedBy: 'codex',
      runner: 'opencode',
      workspace: 'C:/repo',
      prompt: 'Implement bounded scope.',
      permissions: { write: true, shell: true, ssh: false },
      options: {
        routeClass: 'implement',
        taskPath: 'tasks/takeover.md',
        problemFingerprint: 'd'.repeat(64),
        candidateSha,
        frozenSha,
        parentJobId: 'parent-1',
        sourceReviewJobId: 'review-1',
      },
    });
    assert.ok(!('error' in created));
    if ('error' in created) return;
    const oldId = created.job.id;
    const oldPrompt = created.job.prompt;
    setStatus(db, oldId, 'failed', 'runner crashed');
    const first = jobs.takeover(oldId, 'User');
    assert.ok(!('error' in first));
    if ('error' in first) return;
    assert.equal(first.existing, undefined);
    const next = first.job;
    assert.notEqual(next.id, oldId);
    assert.equal(next.session_id, null, 'replacement starts a fresh session');
    const nextOptions = optionsOf(db, next.id) as Record<string, any>;
    assert.equal(nextOptions.takeoverOf, oldId);
    assert.equal(nextOptions.parentJobId, 'parent-1', 'lineage resumes at the pipeline source');
    assert.ok(!('parentJobId' in nextOptions) || nextOptions.parentJobId !== oldId);
    assert.equal(nextOptions.sourceReviewJobId, 'review-1');
    assert.equal(nextOptions.candidateSha, candidateSha, 'candidate SHA preserved');
    assert.equal(nextOptions.frozenSha, frozenSha);
    // Old payload untouched except fencing.
    const old = jobs.get(oldId)!;
    assert.equal(old.status, 'failed');
    assert.equal(old.prompt, oldPrompt, 'old attempt payload is never rolled back');
    assert.equal(jobs.workflowModules.isFenced(oldId), true);
    // Deterministic replay returns the same replacement.
    const replay = jobs.takeover(oldId, 'User');
    assert.ok(!('error' in replay));
    if (!('error' in replay)) {
      assert.equal(replay.existing, true);
      assert.equal(replay.job.id, next.id);
    }
    // Late callbacks for the fenced attempt are rejected, not just hidden.
    const lateComplete = jobs.complete(
      { ...old, status: 'running' } as never, 'done', 'late result', null,
    );
    assert.ok('error' in lateComplete);
    const lateDelivery = jobs.updateDelivery(oldId, 'worker', { stage: 'closed_loop' });
    assert.ok('error' in lateDelivery);
    const lateQuality = jobs.workflowModules.record(
      { id: oldId },
      { moduleId: 'execute', taskPath: 'tasks/takeover.md', problemFingerprint: 'd'.repeat(64) },
      { quality: 'inadequate' },
    );
    assert.equal(lateQuality.counted, false);
  } finally {
    teardown(dir, db);
  }
});

test('takeover refuses active and delivered attempts; deploy guards side effects', () => {
  const { dir, db, jobs } = setup();
  try {
    const running = jobs.create({
      requestedBy: 'codex',
      runner: 'opencode',
      workspace: 'C:/repo',
      prompt: 'Live attempt.',
      permissions: { write: true, shell: true, ssh: false },
      options: { routeClass: 'implement', problemFingerprint: 'e'.repeat(64) },
    });
    assert.ok(!('error' in running));
    if ('error' in running) return;
    const live = jobs.takeover(running.job.id, 'User');
    assert.ok('error' in live);
    if ('error' in live) assert.match(live.error, /pending|active|stop|fence|race/i);

    const deploy = jobs.create({
      requestedBy: 'codex',
      runner: 'codex',
      workspace: 'C:/repo',
      prompt: 'Deploy frozen SHA.',
      permissions: { write: false, shell: true, ssh: true },
      options: {
        routeClass: 'mechanical',
        dispatchSource: 'harness-auto',
        workflowModule: { moduleId: 'deploy' },
        closureKind: 'deploy',
        frozenSha: 'a'.repeat(40),
      },
    });
    assert.ok(!('error' in deploy));
    if ('error' in deploy) return;
    db.prepare("INSERT INTO workers (id, name, token_hash) VALUES ('pc', 'pc', 'x')").run();
    db.prepare("UPDATE jobs SET status = 'failed', worker_id = 'pc', session_id = 'sess-1', error = 'deploy exited 1' WHERE id = ?")
      .run(deploy.job.id);
    const uncertain = jobs.takeover(deploy.job.id, 'User');
    assert.ok('error' in uncertain);
    if ('error' in uncertain) assert.match(uncertain.error, /reconcile/);
    // A Git reconciliation proves code ancestry, not whether a deployment
    // operation ran. It must not authorize a second deployment.
    db.prepare("UPDATE jobs SET delivery_meta = ? WHERE id = ?").run(
      JSON.stringify({ reconciliation: { head: 'a'.repeat(40), mode: 'git-history' } }),
      deploy.job.id,
    );
    const reconciled = jobs.takeover(deploy.job.id, 'User');
    assert.ok('error' in reconciled);
    if ('error' in reconciled) assert.match(reconciled.error, /deployment|receipt/);
  } finally {
    teardown(dir, db);
  }
});

test('reserve filter never wakes unbound agents; intake stays on plan', () => {
  const members = [
    { id: 'codex', name: 'Codex' },
    { id: 'muse', name: 'Sora' },
    { id: 'outsider', name: 'Outsider' },
  ] as ContactRow[];
  assert.equal(roomMentionsAll('@all please check'), true);
  assert.equal(roomMentionsAll('@codex please check'), false);
  // @all cannot override the reserve: only the bound plan contact wakes.
  assert.deepEqual(
    filterWorkflowRoomTargets(members, '@all please check', new Set(['codex'])).map((item) => item.id),
    ['codex'],
  );
  // Unbound reserves never wake, even when explicitly named: the caller passes
  // only bound ids, so the named outsider is dropped pre-call.
  assert.deepEqual(
    filterWorkflowRoomTargets(members, '@outsider handle this', new Set(['codex', 'muse'])).map((item) => item.id),
    ['codex', 'muse'],
  );
  assert.deepEqual(filterWorkflowRoomTargets(members, '@all go', new Set()), []);
  assert.equal(isWorkflowRoomConfig({ coordination: { enabled: true } }), true);
  assert.equal(isWorkflowRoomConfig({ workflowEnabled: true }), true);
  assert.equal(isWorkflowRoomConfig({ members: ['codex'] }), false);
  assert.deepEqual(supportedEfforts('opencode', 'opencode-go/muse-spark-1.3-contributor').includes('max'), true);
});

test('manager routes workflow-room intake to plan and drops unbound host targets', async () => {
  const { dir, db } = tempDb();
  const sse = { broadcast() {} } as never;
  try {
    seedContacts(db);
    const jobs = new JobStore(db, sse);
    const config = {
      port: 3900,
      host: '127.0.0.1',
      dbPath: path.join(dir, 'hub.db'),
      agentsDir: path.join(dir, 'agents'),
      webDist: '',
      uploadsDir: path.join(dir, 'uploads'),
      claude: { cliPath: 'claude' },
      codex: { cliPath: 'codex', nativeCompact: { enabled: false } },
      grok: { cliPath: 'grok' },
      opencode: { cliPath: 'opencode' },
      api: { turnTimeoutMs: 5000 },
      memory: {
        mcpUrl: null, repoPath: null, injectOnSpawn: false, searchPerTurn: false,
        capture: false, maxTurnChars: 0, sessionMaxAgeHours: 0,
      },
      backup: { enabled: false, dir: '', intervalHours: 24, keep: 1 },
    };
    const manager = new AgentManager({ db, sse, config: config as never, vault: null, jobStore: jobs });
    const room = db.prepare("SELECT * FROM contacts WHERE id = 'room-1'").get() as ContactRow;
    const byId = (id: string) => db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow;

    // Ordinary intake, even @all / naming the executor, goes to plan only.
    const intake = manager.dispatchRoomMessageTracked(room, '@all @muse please implement this', {});
    assert.deepEqual(intake.targets, ['codex']);
    await manager.stopAll();
    await intake.completion;

    // Trusted host targeting of a bound member is kept with module isolation.
    const trusted = manager.dispatchRoomMessageTracked(room, 'execute this now', {
      targetOverride: [byId('muse')],
      capture: false,
      reactionRounds: 0,
      coordinationDomain: true,
      moduleId: 'execute',
    });
    assert.deepEqual(trusted.targets, ['muse']);
    await manager.stopAll();
    await trusted.completion;

    // Host targeting of an unbound reserve is dropped with a visible state.
    const dropped = manager.dispatchRoomMessageTracked(room, 'outsider go', {
      targetOverride: [byId('outsider')],
      capture: false,
      reactionRounds: 0,
      coordinationDomain: true,
      moduleId: 'execute',
    });
    assert.deepEqual(dropped.targets, []);
    await dropped.completion;
    const note = db.prepare(
      `SELECT content FROM messages WHERE contact_id = 'room-1' AND sender = 'system'
       AND json_extract(meta, '$.event') = 'workflow-module-unavailable'
       ORDER BY id DESC LIMIT 1`,
    ).get() as { content: string } | undefined;
    assert.ok(note, 'missing stage surfaces a specific room state');
    assert.match(note.content, /execute/);
    await manager.stopAll();
  } finally {
    teardown(dir, db);
  }
});
