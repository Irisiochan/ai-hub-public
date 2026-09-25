import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { readWorkflowPools } from '../src/workflow/workflowPools.js';

test('zero remaining Grok quota blocks its pool even when telemetry is available; other pools continue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-module-pools-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const jobs = new JobStore(db, { broadcast() {} } as any);
  try {
    const sources = { claude: () => ({ available: false, reason: 'error' as const }), codex: () => null,
      grok: () => ({ available: true, weekly: { remainingPct: 0, resetsAt: '2090-01-01T00:00:00Z' } }) };
    const pools = readWorkflowPools(db, sources);
    assert.equal(pools['credential:grok'].blocked, true);
    assert.equal(pools['credential:claude'], undefined, 'telemetry transport error does not prove failed credentials');
    assert.equal(pools['credential:codex'], undefined);
    jobs.setWorkflowPoolResolver((runner) => readWorkflowPools(db, sources)[`credential:${runner}`]?.reason ?? null);
    const review = jobs.create({ requestedBy: 'User', runner: 'grok', workspace: dir, prompt: 'Read-only review.',
      permissions: { write: false, shell: true, ssh: false }, options: { workflowStage: 'review', runnerSource: 'policy' } });
    assert.ok(!('error' in review)); if ('error' in review) throw Error(review.error);
    assert.equal(review.job.status, 'blocked', 'exhausted job is terminal and available for manual takeover, never run');
    assert.match(review.job.error!, /^workflow-pool:/);
    const plan = jobs.create({ requestedBy: 'User', runner: 'codex', workspace: dir, prompt: 'Plan the authorized work.',
      permissions: { write: false, shell: true, ssh: false }, options: { workflowStage: 'plan', runnerSource: 'policy' } });
    assert.ok(!('error' in plan)); if ('error' in plan) throw Error(plan.error);
    assert.equal(plan.job.status, 'pending');
    assert.equal(readWorkflowPools(db, { ...sources, grok: () => ({ available: true, weekly: { remainingPct: 0, resetsAt: '2000-01-01T00:00:00Z' } }) })['credential:grok'], undefined,
      'a stale depleted window past its reset is not a permanent block');
  } finally {
    jobs.stopOutOfBandResolver(); db.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('ai-hub-module-pools-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
