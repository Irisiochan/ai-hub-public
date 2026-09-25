// Loop guards from the 2026-09-14 VPS-migration incident: 24 plan->execute
// rounds, 24 distinct problem fingerprints, zero independent reviews.
// Covers: stable per-task fingerprint, the execute-rounds-before-review cap,
// REQUEST_CHANGES counted against the implementation problem, raw patch
// reads through execution_get, and delivery_meta never sliced into bad JSON.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { buildDelegateTools } from '../src/jobs/delegateTools.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { EXECUTE_ROUNDS_BEFORE_REVIEW, RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import type { RoomTaskToolContext } from '../src/roomTasks/roomTaskStore.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { boundedDeliveryMeta, DELIVERY_META_MAX_CHARS, receiptPatch } from '../src/jobs/receiptFields.js';
import type { SseHub } from '../src/platform/sse.js';

const SHA = (ch: string) => ch.repeat(40);

test('D1: completion -> review -> repair -> review -> merge without plan turns', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-direct-loop-'));
  const db = openDb(path.join(dir, 'hub.db'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const jobs = new JobStore(db, { broadcast: () => {} } as unknown as SseHub);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(id, id, backend);
  }
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('direct', 'direct', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse', 'aye'] }));
  const anchor = Number(db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
    VALUES ('direct', 'user', 'user', 'text', 'Implement D1', 'done', '{}', 'main')`).run().lastInsertRowid);
  const wakes: string[] = [];
  const dispatch = {
    dispatchToModule(_room: string, module: string) {
      wakes.push(module);
      return { status: 'posted' as const };
    },
  };
  const store = new RoomTaskStore(db, jobs, dispatch);
  const calls: string[] = [];
  const room = { room_id: 'direct', task_path: 'tasks/direct.md' };
  const call = async (ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>, allowed = true) => {
    const actor = ctx.moduleId === 'execute' ? 'muse' : ctx.moduleId === 'review' ? 'aye' : 'codex';
    const turn = beginRoomTurn(db, { ...ctx, contactId: actor });
    calls.push(ctx.moduleId);
    try {
      const tool = buildRoomTaskTools(db, jobs, actor, dispatch, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
        .find((item) => item.name === name)!;
      const result = await tool.exec({ ...room, ...args });
      assert.equal(result.ok, allowed, `${name}: ${result.text}`);
      return allowed ? JSON.parse(result.text) : result.text;
    } finally { endRoomTurn(db, turn.turnId, 'test'); }
  };
  const created = await call({ roomId: 'direct', moduleId: 'plan' }, 'task_create', {
    title: 'D1', requirements: 'Direct review and repair', workspace: dir, anchor_message_id: anchor,
  });
  const taskId = created.task.id;
  const initial = await call({ roomId: 'direct', moduleId: 'plan', taskId }, 'task_handoff', {
    to_module: 'execute', request: 'Implement the first candidate',
  });
  calls.length = 0;
  wakes.length = 0;
  let exec: RoomTaskToolContext = { roomId: 'direct', moduleId: 'execute', taskId, handoffId: initial.handoff.id };
  const execute = async (head: string, createdAt: string, explicitReturn = false) => {
    const accepted = await call(exec, 'task_accept', {});
    const started = await call(exec, 'execution_start', {
      module: 'execute', expected_revision: accepted.task.revision, workspace: dir, objective: 'Implement candidate',
      ...(explicitReturn ? { return_to_module: 'review' } : {}),
    });
    assert.equal(JSON.parse(jobs.get(started.job.id)!.options).roomTaskReturn, 'review');
    db.prepare("UPDATE jobs SET status = 'running', created_at = ? WHERE id = ?").run(createdAt, started.job.id);
    const finished = jobs.complete(jobs.get(started.job.id)!, 'done', 'implementation done', null, 'delivered',
      boundedDeliveryMeta({ receipt: {
        head, branch: 'codex/d1', diffstat: '1 file changed', changedFiles: { files: ['a.ts'], total: 1 },
        tests: [{ suite: 'unit', status: 'pass' }],
      } }));
    assert.ok(!('error' in finished));
    store.handleJobFinished(jobs.get(started.job.id)!, { finalAttempt: true });
    const task = store.getTask('direct', room.task_path)!;
    assert.ok(task.active_handoff_id, 'completion creates the registered review handoff');
    const review: RoomTaskToolContext = { roomId: 'direct', moduleId: 'review', taskId, handoffId: task.active_handoff_id! };
    await call(review, 'task_accept', {});
    return { id: started.job.id, review };
  };
  const a = await execute(SHA('a'), '2026-09-15 10:00:00');
  assert.equal(store.getTask('direct', room.task_path)!.candidate_job_id, null);
  const verdict = (ctx: RoomTaskToolContext, id: string, head: string, result: string, allowed = true) => call(ctx, 'review_submit', {
    module: 'review', candidate_job_id: id, candidate_sha: head, verdict: result,
    findings: 'M1: cover repair; pass criterion: direct-loop test passes',
  }, allowed);
  const rejected = await verdict(a.review, a.id, SHA('a'), 'request_changes');
  assert.equal(rejected.task.candidate_job_id, a.id);
  const repair = await call(a.review, 'task_handoff', { to_module: 'execute', request: 'M1: cover repair; direct-loop test must pass' });
  exec = { ...exec, handoffId: repair.handoff.id };
  const b = await execute(SHA('b'), '2026-09-15 10:00:01', true);
  assert.equal(store.getTask('direct', room.task_path)!.candidate_sha, SHA('a'), 'completion alone does not pin');
  const approved = await verdict(b.review, b.id, SHA('b'), 'approve');
  assert.equal(approved.task.candidate_job_id, b.id, 'review directly promotes B without candidate submission');
  assert.equal(approved.task.review_status, 'approved');
  assert.equal(store.executeRoundsSinceReview(taskId), 0);
  const events = db.prepare("SELECT actor FROM room_task_events WHERE task_id = ? AND kind = 'candidate-submitted'").all(taskId);
  assert.deepEqual(events, [{ actor: 'aye' }, { actor: 'aye' }]);
  const before = store.getTask('direct', room.task_path)!;
  assert.match(await verdict(b.review, a.id, SHA('a'), 'approve', false), /更旧/);
  assert.deepEqual(store.getTask('direct', room.task_path), before, 'rejected review must not mutate the pin or verdict');
  // Older jobs are refused even when the commit matches the pin.
  db.prepare('UPDATE jobs SET delivery_meta = ? WHERE id = ?').run(jobs.get(b.id)!.delivery_meta, a.id);
  assert.match(await verdict(b.review, a.id, SHA('b'), 'request_changes', false), /更旧/);
  // No arbitrary ordering of random UUIDs for jobs created within one second.
  db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run(jobs.get(b.id)!.created_at, a.id);
  await verdict(b.review, a.id, SHA('b'), 'approve');
  await verdict(b.review, b.id, SHA('b'), 'approve');
  await verdict(b.review, b.id, SHA('b'), 'approve'); // same-job re-review
  const merge = await call(b.review, 'task_handoff', { to_module: 'merge', request: 'APPROVE: merge reviewed candidate' });
  assert.equal(merge.handoff.to_module, 'merge');
  assert.equal(calls.filter((module) => module === 'plan').length, 0);
  assert.deepEqual(wakes, ['review', 'execute', 'review', 'merge']);
});

test('delivery_meta drops the raw patch instead of slicing JSON', () => {
  const fullPatch = '\u0001'.repeat(600_000);
  const cumulative = boundedDeliveryMeta({ before: { head: SHA('a') }, receipt: {
    patch: fullPatch, patchBase: SHA('a'), patchBaseKind: 'task-baseline',
  } });
  assert.equal(receiptPatch({ delivery_meta: cumulative })?.patch, fullPatch);
  assert.equal(receiptPatch({ delivery_meta: cumulative })?.patchBase, SHA('a'));
  const small = boundedDeliveryMeta({ state: 'delivered', receipt: { head: SHA('a'), patch: 'diff --git a b' } });
  assert.equal(receiptPatch({ delivery_meta: small })?.patch, 'diff --git a b');
  const huge = boundedDeliveryMeta({
    state: 'delivered',
    head: SHA('a'),
    receipt: { head: SHA('a'), patch: '"\\'.repeat(DELIVERY_META_MAX_CHARS), patchChars: 999_999 },
  });
  assert.ok(huge.length <= DELIVERY_META_MAX_CHARS);
  const parsed = JSON.parse(huge);
  assert.equal(parsed.receipt.patch, undefined);
  assert.equal(parsed.receipt.head, SHA('a'));
  const view = receiptPatch({ delivery_meta: huge });
  assert.equal(view?.dropped, true);
  assert.equal(view?.chars, 999_999);
});

test('worker_job_status pages the worker-captured raw diff', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-status-patch-'));
  const db = openDb(path.join(dir, 'hub.db'));
  t.after(() => {
    try { db.close(); } catch { /* closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const store = new JobStore(db, { broadcast: () => {} } as unknown as SseHub);
  const created = store.create({
    requestedBy: 'codex', runner: 'codex', workspace: 'C:/path/to/project', prompt: 'patch recall',
    permissions: { write: true, shell: true, ssh: false },
  });
  if ('error' in created) throw new Error(created.error);
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(created.job.id);
  const patch = `diff --git a/x.ts b/x.ts\n${'+line\n'.repeat(1_000)}`;
  store.complete(store.get(created.job.id)!, 'done', 'summary only', null, 'delivered',
    boundedDeliveryMeta({ state: 'delivered', receipt: { head: SHA('d'), patch, patchChars: patch.length, patchTruncated: false } }));
  const status = buildDelegateTools(store, db, 'codex', {
    enabled: true, workspaces: ['C:/path/to/project'], runners: ['codex'], allowShell: true,
  }).find((tool) => tool.name === 'worker_job_status')!;
  const page1 = await status.exec({ job_id: created.job.id, section: 'patch', result_limit: 4_000 });
  assert.equal(page1.ok, true, page1.text);
  assert.match(page1.text, /diff --git a\/x\.ts/);
  assert.match(page1.text, /section="patch", result_offset=4000/);
  const plain = await status.exec({ job_id: created.job.id });
  assert.match(plain.text, /summary only/);
  assert.doesNotMatch(plain.text, /diff --git/);

  const noPatch = store.create({
    requestedBy: 'codex', runner: 'codex', workspace: 'C:/path/to/project', prompt: 'no patch',
    permissions: { write: false, shell: true, ssh: false },
  });
  if ('error' in noPatch) throw new Error(noPatch.error);
  const missing = await status.exec({ job_id: noPatch.job.id, section: 'patch' });
  assert.equal(missing.ok, false);
  assert.match(missing.text, /没有 Worker 采集的 diff/);
});

test('room task loop guards', { timeout: 120_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-loop-guards-'));
  const db = openDb(path.join(dir, 'hub.db'));
  t.after(() => {
    try { db.close(); } catch { /* closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sse = { broadcast: () => {} } as unknown as SseHub;
  const jobs = new JobStore(db, sse);
  for (const [id, name, backend] of [
    ['codex', 'Codex', 'codex'], ['muse', 'Muse', 'opencode-cli'], ['aye', '阿野', 'grok-cli'],
  ] as const) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(id, name, backend);
  }
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-a', 'room-a', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse', 'aye'] }));
  const anchorId = Number(db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('room-a', 'user', 'user', 'text', 'User：批准做 loop-demo', 'done', '{}', 'main')`,
  ).run().lastInsertRowid);
  const store = new RoomTaskStore(db, jobs, null);

  const call = async (contactId: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) => {
    const turn = beginRoomTurn(db, {
      roomId: ctx.roomId, contactId, moduleId: ctx.moduleId,
      ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
      ...(ctx.handoffId ? { handoffId: ctx.handoffId } : {}),
    });
    try {
      const tool = buildRoomTaskTools(db, jobs, contactId, null, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
        .find((item) => item.name === name)!;
      assert.ok(tool, `${name} exists`);
      return await tool.exec(args);
    } finally {
      endRoomTurn(db, turn.turnId, 'test');
    }
  };
  const ok = async (contactId: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>): Promise<any> => {
    const out = await call(contactId, ctx, name, args);
    assert.equal(out.ok, true, `${name} should succeed: ${out.text.slice(0, 400)}`);
    return JSON.parse(out.text);
  };
  const refuse = async (contactId: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) => {
    const out = await call(contactId, ctx, name, args);
    assert.equal(out.ok, false, `${name} should refuse`);
    return out.text;
  };

  const room = { room_id: 'room-a', task_path: 'tasks/loop-demo.md' };
  const created = await ok('codex', { roomId: 'room-a', moduleId: 'plan' }, 'task_create', {
    ...room, title: 'loop demo', requirements: '原始需求：修好 G02。', workspace: dir, anchor_message_id: anchorId,
  });
  const taskId: string = created.task.id;
  const plan: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'plan', taskId };

  const finish = (jobId: string, head: string, patch?: string) => {
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
    const meta = boundedDeliveryMeta({
      state: 'delivered',
      receipt: {
        branch: 'feat', head, diffstat: '1 file changed', changedFiles: { files: ['a.ts'], total: 1 },
        tests: [{ suite: 'unit', status: 'pass' }],
        ...(patch ? { patch, patchChars: patch.length, patchTruncated: false,
          patchBase: SHA('e'), patchBaseKind: 'task-baseline' } : {}),
      },
      declared: { committed: true, pushed: true, stage: 'waiting_review' },
    });
    const outcome = jobs.complete(jobs.get(jobId)!, 'done', 'done', null, 'delivered', meta);
    assert.ok(!('error' in outcome));
    store.handleJobFinished(jobs.get(jobId)!, { finalAttempt: true });
  };

  // One plan -> execute -> plan round, each with differently worded objectives.
  const executeRound = async (n: number, from: { contact: string; ctx: RoomTaskToolContext }) => {
    const handoff = await ok(from.contact, from.ctx, 'task_handoff', {
      ...room, to_module: 'execute', request: `第 ${n} 片：换个说法再做一遍`,
    });
    const exec: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'execute', taskId, handoffId: handoff.handoff.id };
    const accepted = await ok('muse', exec, 'task_accept', room);
    const started = await ok('muse', exec, 'execution_start', {
      ...room, module: 'execute', expected_revision: accepted.task.revision, workspace: dir,
      objective: `第 ${n} 片目标，措辞每轮都不同 ${'!'.repeat(n)}`, return_to_module: 'execute', return_mode: 'notify',
    });
    finish(started.job.id, SHA(String(n)), `diff --git a/a.ts b/a.ts\n+round ${n}\n`);
    const back = await ok('muse', exec, 'task_handoff', { ...room, to_module: 'plan', request: `第 ${n} 片完成` });
    await ok('codex', { ...plan, handoffId: back.handoff.id }, 'task_accept', room);
    return started.job.id as string;
  };

  const jobIds: string[] = [];
  for (let n = 1; n <= EXECUTE_ROUNDS_BEFORE_REVIEW; n += 1) {
    jobIds.push(await executeRound(n, { contact: 'codex', ctx: plan }));
  }
  assert.equal(store.executeRoundsSinceReview(taskId), EXECUTE_ROUNDS_BEFORE_REVIEW);

  // Stable problem identity across re-worded rounds.
  const fingerprints = new Set(jobIds.map((id) => JSON.parse(jobs.get(id)!.options).problemFingerprint));
  assert.equal(fingerprints.size, 1, 'rewording the objective must not mint a new problem');
  const fingerprint = [...fingerprints][0] as string;

  // Execute prompt tells the implementer not to file pre-review deploy-tails.
  assert.match(jobs.get(jobIds[0])!.prompt, /不要登记 deploy-tail/);

  // The 4th plan -> execute handoff is refused; review stays open.
  const capped = await refuse('codex', plan, 'task_handoff', { ...room, to_module: 'execute', request: '再来一片' });
  assert.match(capped, /已执行 3 轮/);

  // Plan reads the raw diff directly instead of asking for a retelling.
  const patchPage = await ok('codex', plan, 'execution_get', { ...room, job_id: jobIds[2], section: 'patch' });
  assert.equal(patchPage.receiptPage.kind, 'patch');
  assert.equal(patchPage.receiptPage.patchBase, SHA('e'));
  assert.equal(patchPage.receiptPage.patchBaseKind, 'task-baseline');
  assert.match(patchPage.receiptPage.page, /\+round 3/);

  // Review REQUEST_CHANGES is an implementation failure on the same problem.
  const toReview = await ok('codex', plan, 'task_handoff', { ...room, to_module: 'review', request: '独立评审第 3 片' });
  const review: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'review', taskId, handoffId: toReview.handoff.id };
  await ok('aye', review, 'task_accept', room);
  await ok('aye', review, 'review_submit', {
    ...room, module: 'review', candidate_job_id: jobIds[2], candidate_sha: SHA('3'),
    verdict: 'request_changes', findings: 'M1: 固定根断言缺证据；通过条件：补测试。', evidence_refs: [jobIds[2]],
  });
  assert.equal(jobs.workflowModules.implStreak('tasks/loop-demo.md', fingerprint), 1);
  assert.equal(store.executeRoundsSinceReview(taskId), 0, 'a review verdict resets the round counter');

  // After the verdict the fix round may proceed.
  const fixId = await executeRound(4, { contact: 'aye', ctx: review });
  assert.equal(JSON.parse(jobs.get(fixId)!.options).problemFingerprint, fingerprint);
});
