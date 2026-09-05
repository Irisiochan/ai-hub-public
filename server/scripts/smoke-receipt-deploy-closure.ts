import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type JobRow } from '../src/db.js';
import { ensureAutomaticClosureJob, strictReviewDecision } from '../src/workers/closureAutomation.js';
import { JobStore } from '../src/workers/jobStore.js';
import { formatWorkerReceiptPreview } from '../src/workers/receiptPreview.js';
import { ensureAutomaticReviewJob } from '../src/workers/reviewAutomation.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-receipt-closure-'));
const db = openDb(path.join(dir, 'test.db'));
const store = new JobStore(db, { broadcast() {} } as any);
const baseline = 'a'.repeat(40);
let shaIndex = 1;

function structuredMeta(branch: string, head: string, stage: string, pushed: boolean): string {
  const tests = [
    'server npm run pretest',
    'server npm test',
    'web npm test',
    'smoke:deploy-drain',
    'smoke:turn-timeouts',
    'smoke:review-auto-batch',
    'smoke:deploy-resume',
    'smoke:receipt-deploy-closure',
  ].map((suite) => ({ suite, status: 'pass' }));
  return JSON.stringify({
    before: { head: baseline, dirty: false, ahead: 0 },
    declared: {
      committed: true,
      pushed,
      stage,
      summary: 'validation passed',
      nextOwner: 'claude-review',
      diffstat: '2 files changed, 10 insertions(+), 1 deletion(-)',
      changedFiles: { files: ['server/src/a.ts', 'server/test/a.test.mts'], total: 2, truncated: false },
      tests,
    },
    git: { branch, head, ahead: pushed ? 0 : 1, behind: 0, dirty: false, dirtyFiles: [] },
    receipt: {
      branch,
      head,
      diffstat: '2 files changed, 10 insertions(+), 1 deletion(-)',
      changedFiles: { files: ['server/src/a.ts', 'server/test/a.test.mts'], total: 2, truncated: false },
      tests,
    },
  });
}

function createParent(taskPath: string): JobRow {
  const frozen = shaIndex.toString(16).padStart(40, 'b');
  shaIndex += 1;
  const created = store.create({
    requestedBy: 'claude',
    runner: 'codex',
    workspace: 'C:/path/to/project',
    prompt: `实现 ${taskPath}\nRAW-RESULT-MUST-NOT-BE-IN-REVIEW-PROMPT`,
    permissions: { write: true, shell: true, ssh: false },
    options: { routeClass: 'implement', taskPath },
  });
  if ('error' in created) throw new Error(created.error);
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(created.job.id);
  store.complete(
    store.get(created.job.id)!,
    'blocked',
    `implementation evidence\n${'RAW-DUMP-SENTINEL'.repeat(800)}`,
    null,
    'blocked_unpushed',
    structuredMeta(`worker/${taskPath.slice(6, -3)}`, frozen, 'waiting_review', false),
  );
  return store.get(created.job.id)!;
}

function finishReview(parent: JobRow, result: string): JobRow {
  const review = ensureAutomaticReviewJob(store, parent).job;
  if (!review) throw new Error('review job was not created');
  assert.match(review.prompt, /源实现单回执 preview/);
  assert.match(review.prompt, /结构化字段（harness 原样搬运）/);
  assert.match(review.prompt, /opt-in recall/);
  assert.doesNotMatch(review.prompt, /RAW-DUMP-SENTINEL/);
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(review.id);
  store.complete(review, 'done', result, null, 'delivered', JSON.stringify({
    declared: { committed: false, pushed: false, stage: 'closed_loop', summary: result, nextOwner: 'claude' },
  }));
  return store.get(review.id)!;
}

try {
  const parent = createParent('tasks/receipt.md');
  const preview = formatWorkerReceiptPreview(parent);
  assert.match(preview, /^branch：worker\/receipt$/m);
  assert.match(preview, /^diffstat：2 files changed, 10 insertions\(\+\), 1 deletion\(-\)$/m);
  assert.match(preview, /^changedFiles：2 个：server\/src\/a\.ts, server\/test\/a\.test\.mts$/m);
  assert.match(preview, /server npm run pretest=PASS/);

  const legacy = { ...parent, delivery_meta: '{}' };
  const legacyPreview = formatWorkerReceiptPreview(legacy);
  assert.match(legacyPreview, /^branch：未报告$/m);
  assert.match(legacyPreview, /^diffstat：未报告$/m);
  assert.match(legacyPreview, /^changedFiles：未报告$/m);
  assert.match(legacyPreview, /^测试结论：未报告$/m);

  const approveReview = finishReview(parent, 'APPROVE: scope, diff, and validation are clean');
  assert.equal(strictReviewDecision(approveReview), 'approve');
  const firstMerge = ensureAutomaticClosureJob(store, approveReview);
  const repeatedMerge = ensureAutomaticClosureJob(store, approveReview);
  assert.equal(firstMerge.status, 'created');
  assert.equal(repeatedMerge.status, 'existing');
  assert.equal(firstMerge.job?.id, repeatedMerge.job?.id);
  assert.equal(firstMerge.job?.idempotency_key, `merge:v1:${parent.id}`);
  assert.match(firstMerge.job?.prompt ?? '', /merge-close-job\.ps1/);
  assert.match(firstMerge.job?.prompt ?? '', /smoke:deploy-resume/);
  assert.equal(JSON.parse(firstMerge.job!.options).routeClass, 'mechanical');
  assert.deepEqual(JSON.parse(firstMerge.job!.permissions), { write: true, shell: true, ssh: false });
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE idempotency_key = ?").get(`merge:v1:${parent.id}`) as { count: number }).count,
    1,
  );

  const merge = firstMerge.job!;
  const frozenSha = JSON.parse(merge.options).frozenSha as string;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(merge.id);
  store.complete(
    store.get(merge.id)!,
    'done',
    'lane A validation and push passed',
    null,
    'delivered',
    structuredMeta('master', frozenSha, 'delivered_waiting_deploy', true),
  );
  const firstDeploy = ensureAutomaticClosureJob(store, store.get(merge.id)!);
  const repeatedDeploy = ensureAutomaticClosureJob(store, store.get(merge.id)!);
  assert.equal(firstDeploy.status, 'created');
  assert.equal(repeatedDeploy.status, 'existing');
  assert.equal(firstDeploy.job?.idempotency_key, `deploy:v1:${frozenSha}`);
  assert.match(firstDeploy.job?.prompt ?? '', /room-deploy-job\.ps1/);
  assert.match(firstDeploy.job?.prompt ?? '', /prepareDeployDrain/);
  assert.deepEqual(JSON.parse(firstDeploy.job!.permissions), { write: false, shell: true, ssh: true });

  const rejectedParent = createParent('tasks/rejected.md');
  const rejectedReview = finishReview(rejectedParent, 'REQUEST_CHANGES: missing edge-case coverage');
  assert.equal(strictReviewDecision(rejectedReview), 'request_changes');
  assert.equal(ensureAutomaticClosureJob(store, rejectedReview).status, 'rejected');
  assert.equal(store.getByIdempotencyKey(`merge:v1:${rejectedParent.id}`), undefined);

  const ambiguousParent = createParent('tasks/ambiguous.md');
  const ambiguousReview = finishReview(ambiguousParent, 'Looks good overall, but needs owner judgment.');
  assert.equal(strictReviewDecision(ambiguousReview), 'ambiguous');
  assert.equal(ensureAutomaticClosureJob(store, ambiguousReview).status, 'rejected');
  assert.equal(store.getByIdempotencyKey(`merge:v1:${ambiguousParent.id}`), undefined);

  console.log('[PASS] structured receipt preview and fail-closed idempotent merge/deploy closure jobs');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
