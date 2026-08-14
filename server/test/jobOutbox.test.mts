import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type JobRow } from '../src/db.js';
import { JobStore, OUTBOX_MAX_ATTEMPTS } from '../src/workers/jobStore.js';
import type { SseHub } from '../src/sse.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-job-outbox-'));
const db = openDb(path.join(tempDir, 'hub.db'));
const sse = { broadcast() {} } as unknown as SseHub;

interface OutboxRowView {
  job_id: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  meta: string;
  last_error: string | null;
}

function outboxRow(jobId: string): OutboxRowView | undefined {
  return db.prepare('SELECT * FROM job_outbox WHERE job_id = ?').get(jobId) as OutboxRowView | undefined;
}

function createRunning(store: JobStore, prompt: string): JobRow {
  const created = store.create({
    requestedBy: 'codex',
    runner: 'codex',
    workspace: 'C:/ai-hub-codex',
    prompt,
    permissions: { write: true, shell: true, ssh: false },
  });
  if ('error' in created) throw new Error(created.error);
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(created.job.id);
  return store.get(created.job.id)!;
}

try {
  // ── 崩溃点：terminal commit 后、callback 前 ──
  // scheduleOutboxDrain 置空 = 进程在触发内存回调前死掉。outbox 行必须已随
  // 终态同事务落库，重启后由新进程重放，恰好一次。
  const storeA = new JobStore(db, sse);
  (storeA as unknown as { scheduleOutboxDrain(): void }).scheduleOutboxDrain = () => {};
  const job1 = createRunning(storeA, 'crash before callback');
  const first = storeA.complete(job1, 'done', 'ok', null, 'delivered', '{}');
  assert.deepEqual(first, { status: 'done', changed: true });
  const pending = outboxRow(job1.id);
  assert.equal(pending?.status, 'pending', '终态提交必须与 outbox 入队同事务落库');

  const duplicate = storeA.complete(storeA.get(job1.id)!, 'done', 'ok', null);
  assert.deepEqual(duplicate, { status: 'done', changed: false });
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM job_outbox WHERE job_id = ?').get(job1.id) as { c: number }).c,
    1,
    '终态重试不得产生第二条 outbox 行'
  );

  // “重启”：同一 db 上的新 JobStore + handler
  const calls: string[] = [];
  const storeB = new JobStore(db, sse);
  storeB.onFinished = (job) => { calls.push(job.id); };
  await storeB.drainOutbox();
  assert.deepEqual(calls, [job1.id], '重启后必须恰好补发一次');
  assert.equal(outboxRow(job1.id)?.status, 'done');
  await storeB.drainOutbox();
  assert.deepEqual(calls, [job1.id], '已结 outbox 行必须幂等');

  // ── 可恢复失败：指数退避后重试成功 ──
  (storeB as unknown as { scheduleOutboxDrain(): void }).scheduleOutboxDrain = () => {};
  const job2 = createRunning(storeB, 'flaky receipt');
  let attempts2 = 0;
  storeB.onFinished = (job, ctx) => {
    if (job.id !== job2.id) return;
    attempts2 += 1;
    if (attempts2 === 1) {
      assert.equal(ctx.finalAttempt, false);
      throw new Error('room temporarily down');
    }
  };
  storeB.complete(job2, 'done', 'ok', null);
  assert.ok(await storeB.drainOutboxOnce());
  const afterFailure = outboxRow(job2.id);
  assert.equal(afterFailure?.status, 'pending');
  assert.equal(afterFailure?.attempts, 1);
  assert.ok(afterFailure!.next_attempt_at > Date.now(), '失败后必须带退避时间');
  assert.match(afterFailure?.last_error ?? '', /temporarily down/);
  assert.equal(await storeB.drainOutboxOnce(), false, '未到期的行不得被重放');
  assert.ok(await storeB.drainOutboxOnce(Date.now() + 61_000));
  assert.equal(outboxRow(job2.id)?.status, 'done');
  assert.equal(attempts2, 2);

  // ── 永久失败：退避打满后进入可观测 dead-letter ──
  const job3 = createRunning(storeB, 'permanently failing');
  const finals: boolean[] = [];
  storeB.onFinished = (job, ctx) => {
    if (job.id !== job3.id) return;
    finals.push(ctx.finalAttempt);
    throw new Error('permanent failure');
  };
  storeB.complete(job3, 'done', 'ok', null);
  let clock = Date.now();
  for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i += 1) {
    clock += 40 * 60_000;
    await storeB.drainOutboxOnce(clock);
  }
  assert.equal(outboxRow(job3.id)?.status, 'dead');
  assert.equal(finals.length, OUTBOX_MAX_ATTEMPTS);
  assert.equal(finals[0], false);
  assert.equal(finals.at(-1), true, '末次尝试必须以 finalAttempt 通知 handler');
  assert.ok((storeB.outboxCounts().dead ?? 0) >= 1, 'dead-letter 必须可观测');

  // ── 步骤进度（如 tailDone）跨重试持久化 ──
  const job4 = createRunning(storeB, 'meta steps');
  const seenMeta: unknown[] = [];
  storeB.onFinished = (job, ctx) => {
    if (job.id !== job4.id) return;
    seenMeta.push(ctx.meta.tailDone ?? null);
    if (!ctx.meta.tailDone) {
      ctx.setMeta({ tailDone: true });
      throw new Error('receipt failed after tail step');
    }
  };
  storeB.complete(job4, 'done', 'ok', null);
  clock += 40 * 60_000;
  await storeB.drainOutboxOnce(clock);
  clock += 40 * 60_000;
  await storeB.drainOutboxOnce(clock);
  assert.deepEqual(seenMeta, [null, true], '已完成步骤不得在重试时重跑');
  assert.equal(outboxRow(job4.id)?.status, 'done');

  // ── 启动补偿：缺 outbox 行且缺回执的终态 job 被补；已有回执的不补 ──
  const job5 = createRunning(storeB, 'pre-migration terminal without receipt');
  db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(job5.id);
  db.prepare('DELETE FROM job_outbox WHERE job_id = ?').run(job5.id);
  const job6 = createRunning(storeB, 'pre-migration terminal with receipt');
  db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(job6.id);
  db.prepare('DELETE FROM job_outbox WHERE job_id = ?').run(job6.id);
  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room', '会议室', 'room', 'room', '{}')`
  ).run();
  db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
     VALUES ('room', 'room-host', 'user', 'text', '回执', 'done', '{}', 'main', ?)`
  ).run(`receipt:v1:${job6.id}`);
  storeB.onFinished = null;
  const backfilled = storeB.startOutboxProcessor(60 * 60_000);
  storeB.stopOutboxProcessor();
  assert.equal(backfilled, 1, '只补缺回执的终态 job');
  assert.ok(outboxRow(job5.id), '缺回执的终态 job 必须被补偿入队');
  assert.equal(outboxRow(job6.id), undefined, '已有回执的 job 不得重复入队');

  console.log('job outbox tests: ok');
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
