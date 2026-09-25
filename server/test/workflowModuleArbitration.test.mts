import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type JobRow } from '../src/platform/db.js';
import { JobStore } from '../src/jobs/jobStore.js';

// Retired automatic arbitration/rework chain: no streak count routes to
// arbitration, escalates to User, or dispatches fixes. Arbitration is an
// explicit read-only module the model hands off to; quality counters stay
// observations. This file pins the observation accounting that remains.

function fixture(run: (ctx: any) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-module-arbitration-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const jobs = new JobStore(db, { broadcast() {} } as any);
  const taskPath = 'tasks/four-round-fix.md'; const fingerprint = 'f'.repeat(64);
  const baseline = 'a'.repeat(40);
  let candidate = 0;
  function finished(job: JobRow, status: string, result: string, state: string, meta: any) {
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(job.id);
    const complete = jobs.complete(jobs.get(job.id)!, status, result, null, state, JSON.stringify(meta));
    assert.ok(!('error' in complete)); return jobs.get(job.id)!;
  }
  function waiting(existing?: JobRow) {
    const made = existing ? { job: existing } : jobs.create({ requestedBy: 'User', runner: 'opencode', workspace: dir,
      prompt: 'Implement the approved small fix.', permissions: { write: true, shell: true, ssh: false },
      options: { routeClass: 'implement', taskPath, problemFingerprint: fingerprint } });
    assert.ok(!('error' in made)); if ('error' in made) throw Error(made.error);
    const head = (++candidate).toString(16).padStart(40, 'b');
    return finished(made.job, 'blocked', 'Candidate implementation and tests ready.', 'blocked_unpushed', {
      before: { head: baseline }, declared: { stage: 'waiting_review', committed: true, pushed: false },
      receipt: { branch: 'worker/four-round-fix', head, diffstat: '1 file changed',
        changedFiles: { files: ['fix.ts'], total: 1, truncated: false }, tests: [{ suite: 'targeted regression', status: 'pass' }] },
    });
  }
  try { run({ db, jobs, taskPath, fingerprint, waiting, finished }); }
  finally {
    jobs.stopOutOfBandResolver(); db.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('ai-hub-module-arbitration-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('repeated implementation failures never auto-route; arbitration stays explicit and read-only', () => fixture(({ jobs, taskPath, fingerprint, waiting }: any) => {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const parent = waiting();
    jobs.workflowModules.record(
      { id: parent.id },
      { moduleId: 'execute', taskPath, problemFingerprint: fingerprint },
      { quality: 'inadequate', detail: `independent review REQUEST_CHANGES #${attempt}` },
    );
    const invocation = jobs.workflowModules.invoke('execute', taskPath, fingerprint);
    assert.equal(invocation.arbitrationActive, false, 'no automatic arbitration routing');
    assert.equal(invocation.escalateToHuman, false, 'no automatic human escalation');
    assert.equal(invocation.moduleId, 'execute');
  }
  assert.equal(jobs.workflowModules.implStreak(taskPath, fingerprint), 5, 'observations are still counted');
  // The arbitration module itself resolves explicitly with read-only policy.
  const arbitration = jobs.workflowModules.invoke('arbitration', taskPath, fingerprint);
  assert.equal(arbitration.moduleId, 'arbitration');
  assert.equal(arbitration.permissions.write, false);
}));

test('validated review approval clears the problem fingerprint; arbitration verdict does not', () => fixture(({ jobs, taskPath, fingerprint }: any) => {
  for (let index = 0; index < 3; index++) jobs.workflowModules.record({ id: `failed-${index}` }, { moduleId: 'execute', taskPath, problemFingerprint: fingerprint }, { quality: 'inadequate' });
  jobs.workflowModules.record({ id: 'arbitration-verdict' }, { moduleId: 'arbitration', taskPath, problemFingerprint: fingerprint }, { quality: 'success' });
  assert.equal(jobs.workflowModules.implStreak(taskPath, fingerprint), 3, 'an arbitration verdict is not implementation acceptance');
  jobs.workflowModules.record({ id: 'independent-approve' }, { moduleId: 'review', taskPath, problemFingerprint: fingerprint }, { quality: 'success' });
  assert.equal(jobs.workflowModules.implStreak(taskPath, fingerprint), 0, 'only independent review APPROVE clears');
}));

test('duplicate quality records never double count a failure', () => fixture(({ jobs, taskPath, fingerprint, waiting }: any) => {
  const parent = waiting();
  const first = jobs.workflowModules.record(
    { id: parent.id }, { moduleId: 'execute', taskPath, problemFingerprint: fingerprint }, { quality: 'inadequate' });
  assert.equal(first.counted, true);
  const replay = jobs.workflowModules.record(
    { id: parent.id }, { moduleId: 'execute', taskPath, problemFingerprint: fingerprint }, { quality: 'inadequate' });
  assert.equal(replay.counted, false);
  assert.equal(jobs.workflowModules.implStreak(taskPath, fingerprint), 1);
}));
