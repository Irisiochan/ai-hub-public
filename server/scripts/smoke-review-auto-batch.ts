import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchCoordinationRoomHost } from '../src/agents/coordinationRoom.js';
import { openDb, type ContactRow, type JobRow, type MessageRow } from '../src/db.js';
import { attachWorkerCompletion } from '../src/server.js';
import { JobStore } from '../src/workers/jobStore.js';
import {
  ensureAutomaticReviewJob,
  isWaitingReviewGate,
  nextReviewBatchWallClockDelay,
  ReviewBatchCoordinator,
} from '../src/workers/reviewAutomation.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-review-auto-batch-'));
const db = openDb(path.join(dir, 'test.db'));
const broadcasts: unknown[] = [];
const sse = { broadcast: (_event: string, row: unknown) => broadcasts.push(row) } as any;
const store = new JobStore(db, sse);
const dispatches: Array<{ text: string; options: any }> = [];
const logger = { info() {}, warn() {}, error() {} } as any;

try {
  db.prepare("INSERT INTO contacts (id, name, kind, backend, config) VALUES ('room', '会议室', 'room', 'api', ?)")
    .run(JSON.stringify({ members: ['claude', 'codex'], coordination: { enabled: true, orchestrator: 'claude' } }));
  db.prepare("INSERT INTO contacts (id, name, kind, backend) VALUES ('claude', 'Claude', 'dm', 'claude-cli')").run();
  db.prepare("INSERT INTO contacts (id, name, kind, backend) VALUES ('codex', 'Codex', 'dm', 'codex')").run();
  const room = db.prepare("SELECT * FROM contacts WHERE id = 'room'").get() as ContactRow;
  const claude = db.prepare("SELECT * FROM contacts WHERE id = 'claude'").get() as ContactRow;
  const codex = db.prepare("SELECT * FROM contacts WHERE id = 'codex'").get() as ContactRow;
  const manager = {
    imageRoomMembers: (value: ContactRow) => value.id === room.id ? [claude, codex] : [],
    dispatchRoomMessageTracked: (_room: ContactRow, text: string, options: any) => {
      dispatches.push({ text, options });
      return { completion: Promise.resolve({ normal: { spoke: 1 }, reactions: [] }) };
    },
    get: () => ({ enqueue: () => 'queued' }),
  } as any;
  const config = {
    memory: { repoPath: null },
    reviewBatch: { size: 1, intervalMinutes: 30 },
  } as any;

  attachWorkerCompletion({ db, store, jobStore: store, manager, logger, sse, vault: null, config } as any);

  const createRunning = (
    prompt: string,
    options: Record<string, unknown>,
    requestedBy = 'claude',
  ): JobRow => {
    const created = store.create({
      requestedBy,
      runner: 'codex',
      workspace: 'C:/ai-hub-codex',
      prompt,
      permissions: { write: true, shell: true, ssh: false },
      options,
    });
    if ('error' in created) throw new Error(created.error);
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(created.job.id);
    return store.get(created.job.id)!;
  };

  const finish = async (
    job: JobRow,
    declaredStage: string,
    result = 'implementation tests PASS',
  ): Promise<JobRow> => {
    store.complete(
      job,
      declaredStage === 'waiting_review' ? 'blocked' : 'done',
      result,
      null,
      declaredStage === 'waiting_review' ? 'blocked_unpushed' : 'delivered',
      JSON.stringify({
        head: 'abcdef123456',
        ahead: declaredStage === 'waiting_review' ? 1 : 0,
        declared: {
          committed: true,
          pushed: declaredStage !== 'waiting_review',
          stage: declaredStage,
          summary: result,
          nextOwner: declaredStage === 'waiting_review' ? 'claude-review' : '无需后续动作',
        },
      }),
    );
    await store.drainOutbox();
    return store.get(job.id)!;
  };

  // Gate hit: one deterministic review job, receipt persisted but no room wake.
  const parentOne = createRunning('实现一号', { routeClass: 'implement', taskPath: 'tasks/one.md' });
  await finish(parentOne, 'waiting_review');
  const terminalOne = store.get(parentOne.id)!;
  assert.equal(isWaitingReviewGate(terminalOne), true);
  const reviewKeyOne = `review:v1:${parentOne.id}:blocked`;
  const reviewOne = store.getByIdempotencyKey(reviewKeyOne)!;
  assert.ok(reviewOne, 'matching gate creates a review job');
  const reviewOneOptions = JSON.parse(reviewOne.options);
  assert.equal(reviewOne.requested_by, 'claude');
  assert.equal(reviewOneOptions.routeClass, 'review');
  assert.equal(reviewOneOptions.parentJobId, parentOne.id);
  assert.equal(reviewOneOptions.dispatchSource, 'harness-auto');
  assert.equal(reviewOne.runner, reviewOneOptions.workflow.selected.runner);
  assert.equal(dispatches.length, 0, 'pooled implementation receipt must not wake the room');
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE idempotency_key = ? AND json_extract(meta, '$.roomHost.reviewBatch.status') = 'pending'")
      .get(`receipt:v1:${parentOne.id}`) as { count: number }).count,
    1,
  );

  // Idempotency replay and routeClass=review recursion guard.
  assert.equal(ensureAutomaticReviewJob(store, terminalOne).job?.id, reviewOne.id);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE idempotency_key = ?').get(reviewKeyOne) as { count: number }).count,
    1,
  );
  assert.equal(ensureAutomaticReviewJob(store, reviewOne).status, 'not-eligible');

  // Non-match keeps the old wake behavior and does not create review work.
  const decisionJob = createRunning('凭据审批场景', { routeClass: 'implement', taskPath: 'tasks/decision.md' }, 'codex');
  await finish(decisionJob, 'user_decision', 'awaiting exact target approval');
  assert.equal(store.getByIdempotencyKey(`review:v1:${decisionJob.id}:done`), undefined);
  assert.equal(dispatches.length, 1);
  assert.match(dispatches[0].text, /Worker 任务回执/);

  // Harness-auto review terminal receipt is pooled too, and never creates a child review.
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(reviewOne.id);
  await finish(store.get(reviewOne.id)!, 'closed_loop', 'APPROVE: scope and validation are clean');
  assert.equal(ensureAutomaticReviewJob(store, store.get(reviewOne.id)!).status, 'not-eligible');
  assert.equal(dispatches.length, 2, 'one completed review decision reaches the configured threshold');
  const firstBatchWake = dispatches[1];
  assert.deepEqual(firstBatchWake.options.targetOverride.map((member: ContactRow) => member.id), ['claude']);
  assert.equal(firstBatchWake.options.reactionRounds, 0);
  assert.equal(firstBatchWake.options.coordinationDomain, true);
  assert.match(firstBatchWake.text, /Review 攒批裁决/);
  assert.match(firstBatchWake.text, new RegExp(parentOne.id));
  assert.match(firstBatchWake.text, new RegExp(reviewOne.id));
  assert.match(firstBatchWake.text, /APPROVE/);
  assert.match(firstBatchWake.text, /worker_job_status/);

  // routeClass=fix follows the same gate; its parent receipt does not wake before review completes.
  const parentTwo = createRunning('实现二号', { routeClass: 'fix', taskPath: 'tasks/two.md' });
  await finish(parentTwo, 'waiting_review', 'fix tests PASS');
  assert.equal(dispatches.length, 2, 'implementation receipt alone must not trigger a decision batch');
  const reviewTwo = store.getByIdempotencyKey(`review:v1:${parentTwo.id}:blocked`)!;
  assert.ok(reviewTwo);
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(reviewTwo.id);
  await finish(reviewTwo, 'closed_loop', 'APPROVE: fix is clean');
  assert.equal(dispatches.length, 3, 'completed fix review adds exactly one batch wake');
  assert.match(dispatches[2].text, new RegExp(parentTwo.id));
  assert.match(dispatches[2].text, new RegExp(reviewTwo.id));
  const flushedRows = db.prepare(
    "SELECT * FROM messages WHERE json_extract(meta, '$.roomHost.reviewBatch.status') = 'flushed' AND json_extract(meta, '$.roomHost.reviewBatch.parentJobId') = ? ORDER BY id"
  ).all(parentOne.id) as MessageRow[];
  assert.equal(flushedRows.length, 2);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE idempotency_key LIKE 'review-batch:v1:%'").get() as { count: number }).count,
    2,
  );

  // Crash-style replay: same receipt set produces the same flush key and no second wake/message.
  for (const row of flushedRows) {
    const meta = JSON.parse(row.meta);
    meta.roomHost.reviewBatch.status = 'pending';
    db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), row.id);
  }
  const replayCoordinator = new ReviewBatchCoordinator({ db, sse, manager, logger }, config.reviewBatch);
  assert.equal(replayCoordinator.flushNow('manual'), 2);
  assert.equal(dispatches.length, 3, 'duplicate batch key must not wake twice');
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE idempotency_key LIKE 'review-batch:v1:%'").get() as { count: number }).count,
    2,
  );

  // Flush failure fail-opens the already persisted receipt instead of dropping it.
  const failOpenKey = 'receipt:v1:fail-open-smoke';
  const pooled = dispatchCoordinationRoomHost({ db, sse, manager, logger }, {
    targetId: 'claude',
    content: '@claude fail-open receipt',
    kind: 'receipt',
    idempotencyKey: failOpenKey,
    skipWake: true,
    meta: {
      receipt: { jobId: 'fail-open-smoke', status: 'blocked', deliveryState: 'blocked_unpushed' },
      reviewBatch: {
        version: 1,
        status: 'pending',
        jobId: 'fail-open-smoke',
        parentJobId: 'fail-open-smoke',
        routeClass: 'implement',
        jobStatus: 'blocked',
        deliveryState: 'blocked_unpushed',
        reviewConclusion: '等待自动 review 结论',
      },
    },
  });
  assert.equal(pooled.status, 'posted');
  const beforeFailOpenWake = dispatches.length;
  db.prepare("UPDATE contacts SET config = ? WHERE id = 'room'")
    .run(JSON.stringify({ members: ['claude', 'codex'], coordination: { enabled: false, orchestrator: 'claude' } }));
  const failOpenCoordinator = new ReviewBatchCoordinator({ db, sse, manager, logger }, { size: 100, intervalMinutes: 30 });
  assert.equal(failOpenCoordinator.flushNow('timer'), 0);
  assert.equal(dispatches.length, beforeFailOpenWake + 1, 'flush failure wakes the stored receipt directly');
  const failOpenRow = db.prepare('SELECT * FROM messages WHERE idempotency_key = ?').get(failOpenKey) as MessageRow;
  assert.equal(JSON.parse(failOpenRow.meta).roomHost.reviewBatch.status, 'fail_open');

  assert.equal(
    nextReviewBatchWallClockDelay(30, Date.parse('2026-08-28T11:05:40.000Z')),
    24 * 60_000 + 20_000,
  );
  assert.ok(broadcasts.length > 0);
  console.log('[PASS] deterministic review gate, skip-wake batching, idempotent flush, and fail-open fallback');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
