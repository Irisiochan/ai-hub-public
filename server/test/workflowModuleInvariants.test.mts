// Independent integration acceptance checks owned by the root reviewer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../src/platform/db.js';
import { WorkflowModulesStore, DEFAULT_MODULE_BINDINGS, supportedEfforts } from '../src/workflow/workflowModules.js';
import { modelCatalog, rememberModelCatalog } from '../src/contacts/modelCatalog.js';
import { JobStore } from '../src/jobs/jobStore.js';

function withDb(run: (db: Db, modules: WorkflowModulesStore) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-module-invariants-'));
  const db = openDb(path.join(dir, 'hub.db'));
  try {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')")
      .run('codex', 'Codex', 'codex');
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')")
      .run('muse', 'Sora', 'opencode-cli');
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')")
      .run('aye', '阿野', 'grok-cli');
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')")
      .run('claude', 'Claude', 'claude-cli');
    const modules = new WorkflowModulesStore(db);
    modules.ensureSchema(); modules.ensureSeeded();
    run(db, modules);
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('ai-hub-module-invariants-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('real contact backend names resolve to runner ids and Muse max is bindable', () => withDb((_db, modules) => {
  assert.equal(modules.validateBinding('execute', { ...DEFAULT_MODULE_BINDINGS.execute, reasoning: 'max' }).ok, true,
    'opencode-cli contact maps to opencode runner; it is not an unsupported backend');
}));

test('an arbitrary Codex model id does not count as an advertised compatible model', () => withDb((_db, modules) => {
  assert.equal(modules.validateBinding('plan', { ...DEFAULT_MODULE_BINDINGS.plan, model: 'nonexistent-model-typo' }).ok, false);
}));

test('deploy rejects adapters whose read-only restrictions remove the required terminal', () => withDb((_db, modules) => {
  assert.equal(modules.validateBinding('deploy', DEFAULT_MODULE_BINDINGS.deploy).ok, true);
  for (const binding of [DEFAULT_MODULE_BINDINGS.execute, DEFAULT_MODULE_BINDINGS.review,
    { contactId: 'claude', runner: 'claude', model: 'claude-opus-4-6', reasoning: 'high' }]) {
    const result = modules.validateBinding('deploy', binding);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /permissions; binding incompatible/i);
  }
}));

test('module efforts respect model metadata and reuse observed catalogs without provider calls', () => withDb((_db, modules) => {
  assert.ok(supportedEfforts('grok', 'grok-4.6').includes('high'));
  assert.equal(modules.validateBinding('plan', { ...DEFAULT_MODULE_BINDINGS.plan, model: 'gpt-5.5', reasoning: 'ultra' }).ok, false);
  const original = modelCatalog('codex-cli').models;
  try {
    rememberModelCatalog('codex-cli', [{ id: 'gpt-future', label: 'Future', supportedReasoningEfforts: [{ id: 'medium', label: 'medium' }] }]);
    assert.equal(modules.validateBinding('plan', { ...DEFAULT_MODULE_BINDINGS.plan, model: 'gpt-future', reasoning: 'medium' }).ok, true);
    assert.equal(modules.validateBinding('plan', { ...DEFAULT_MODULE_BINDINGS.plan, model: 'gpt-future', reasoning: 'high' }).ok, false);
  } finally { rememberModelCatalog('codex-cli', original); }
}));

test('implementation counters are observations only; infrastructure and model revision do not reset them', () => withDb((_db, modules) => {
  const task = 'tasks/four-rounds.md'; const fingerprint = '1'.repeat(64);
  for (let index = 1; index <= 5; index++) {
    const invocation = modules.invoke('execute', task, fingerprint);
    assert.equal(invocation.arbitrationActive, false, 'no automatic arbitration routing');
    assert.equal(invocation.escalateToHuman, false, 'no automatic human escalation');
    modules.record({ id: `attempt-${index}` }, invocation, { quality: 'inadequate' });
  }
  assert.equal(modules.implStreak(task, fingerprint), 5, 'observations are still counted');
  modules.record({ id: 'quota-failure' }, modules.invoke('execute', task, fingerprint), { quality: 'infrastructure' });
  assert.equal(modules.implStreak(task, fingerprint), 5);
  const changed = modules.setBinding('execute', { ...DEFAULT_MODULE_BINDINGS.plan }, modules.revision(), 'User');
  assert.equal(changed.ok, true);
  assert.equal(modules.implStreak(task, fingerprint), 5, 'a hot swap preserves the task problem counter');
  assert.equal(modules.invoke('execute', task, fingerprint).escalateToHuman, false);
}));

test('a planning/arbitration success is not independent implementation acceptance', () => withDb((_db, modules) => {
  const task = 'tasks/arbitration-verdict.md'; const fingerprint = '2'.repeat(64);
  for (let index = 0; index < 4; index++) {
    modules.record({ id: `failed-${index}` }, modules.invoke('execute', task, fingerprint), { quality: 'inadequate' });
  }
  modules.record({ id: 'arbitration-verdict' }, modules.invoke('arbitration', task, fingerprint), { quality: 'success' });
  assert.equal(modules.implStreak(task, fingerprint), 4, 'only independent review of corrected implementation clears the counter');
}));

test('implementation self-report cannot consume the later independent quality decision', () => withDb((_db, modules) => {
  const invocation = modules.invoke('execute', 'tasks/self-report.md', '4'.repeat(64));
  modules.record({ id: 'self-reported-done' }, invocation, { quality: 'success' });
  const independent = modules.record({ id: 'self-reported-done' }, invocation, { quality: 'inadequate', detail: 'independent review REQUEST_CHANGES' });
  assert.equal(independent.counted, true, 'self-report must not reserve the deduplication key for acceptance');
  assert.equal(modules.implStreak(invocation.taskPath, invocation.problemFingerprint), 1);
}));

test('legacy migration never resurrects an implementation streak cleared by independent review', () => withDb((db, modules) => {
  const task = 'tasks/migrated.md'; const fingerprint = '3'.repeat(64);
  db.prepare(`INSERT INTO workflow_quality_streaks
    (profile_id, profile_version, task_path, stage, problem_fingerprint, primary_runner, primary_model, streak)
    VALUES ('protocol-b', 1, ?, 'execute', ?, 'opencode', 'opencode-go/muse-spark-1.3-contributor', 4)`)
    .run(task, fingerprint);
  modules.migrateLegacy();
  assert.equal(modules.implStreak(task, fingerprint), 4);
  modules.record({ id: 'independent-approve' }, modules.invoke('review', task, fingerprint), { quality: 'success' });
  assert.equal(modules.implStreak(task, fingerprint), 0);
  modules.migrateLegacy();
  assert.equal(modules.implStreak(task, fingerprint), 0, 'polling the UI or restarting the server must not restore old failure counts');
}));

test('task authorization may narrow a writable module; job creation must never widen it', () => withDb((db, _modules) => {
  const jobs = new JobStore(db, { broadcast() {} } as never);
  const result = jobs.create({
    requestedBy: 'User', runner: 'codex', workspace: 'C:/test-workspace', prompt: 'Only inspect this workspace.',
    permissions: { write: false, shell: true, ssh: false },
    options: { workflowStage: 'execute', runnerSource: 'override', runnerOverrideReason: 'read-only inspection test', model: 'gpt-6-astra', reasoning: 'high' },
  });
  // A runner/module that cannot operate at this narrower ceiling may reject;
  // granting write permission is never an acceptable fallback.
  if (!('error' in result)) assert.equal(JSON.parse(result.job.permissions).write, false);
}));

test('a new job records the live module binding and no hardcoded profile snapshot', () => withDb((db, modules) => {
  // Profile B hardcodes plan = gpt-6-astra/high; the live binding is rebound away from it.
  const rebound = modules.setBinding('plan', { ...DEFAULT_MODULE_BINDINGS.plan, reasoning: 'medium' }, modules.revision(), 'User');
  assert.equal(rebound.ok, true);
  const jobs = new JobStore(db, { broadcast() {} } as never);
  const result = jobs.create({
    requestedBy: 'User', runner: 'codex', workspace: 'C:/test-workspace', prompt: 'Read the plan inputs.',
    permissions: { write: false, shell: true, ssh: false },
    options: { workflowStage: 'plan', runnerSource: 'policy', workflow: { selected: { runner: 'codex', model: 'stale', reasoning: 'high' } } },
  });
  assert.ok(!('error' in result), 'error' in result ? result.error : '');
  const options = JSON.parse(result.job.options);
  assert.equal(options.workflow, undefined);
  assert.equal(options.reasoning, 'medium');
  assert.deepEqual(options.workflowModule.selected, modules.bindings().plan);
}));

test('invalid binding or stale compare-and-swap leaves config and audit unchanged',() => withDb((_db, modules) => {
  const original = modules.bindings(); const revision = modules.revision(); const audit = modules.audit().length;
  const invalid = modules.setBinding('plan', { ...DEFAULT_MODULE_BINDINGS.plan, reasoning: 'not-an-effort' }, revision, 'User');
  assert.equal(invalid.ok, false); assert.equal(modules.revision(), revision);
  assert.equal(modules.audit().length, audit); assert.deepEqual(modules.bindings(), original);
  const stale = modules.setBinding('plan', { ...DEFAULT_MODULE_BINDINGS.plan, reasoning: 'medium' }, revision - 1, 'User');
  assert.equal(stale.ok, false); assert.equal(modules.revision(), revision);
  assert.equal(modules.audit().length, audit);
}));
