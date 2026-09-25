// Min-closure-2 (User 2026-09-23): plan hands the whole W series to the
// gateway via `task_pass sequence`; each proven merge starts the next
// block's execute Worker directly (return_to review, no review/plan wake).
// The last block falls back to after_merge (or a plan wake when undeclared);
// the three-round gate halts with a plan wake; direct-start failure falls
// back to the review wake. Strict rooms keep the manual path.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import type { RoomTaskToolContext } from '../src/roomTasks/roomTaskStore.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { boundedDeliveryMeta } from '../src/jobs/receiptFields.js';
import type { SseHub } from '../src/platform/sse.js';

const SHA = (ch: string) => ch.repeat(40);
const A = SHA('a');
const B = SHA('b');
const BASE = SHA('c');
const MERGE_SUITES = [
  'server npm run pretest', 'server npm test', 'web npm test',
  'smoke:deploy-drain', 'smoke:turn-timeouts', 'smoke:deploy-resume',
].map((suite) => ({ suite, status: 'pass' as const }));

const SEQ2 = [
  { label: 'W0', objective: '做 W0：地基接口' },
  { label: 'W1', objective: '做 W1：上层装配' },
];

function setup(governance?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-seq-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const jobs = new JobStore(db, { broadcast: () => {} } as unknown as SseHub);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(id, id, backend);
  }
  const cfg: Record<string, unknown> = { workflowEnabled: true, members: ['codex', 'muse', 'aye'] };
  if (governance !== undefined) cfg.governance = governance;
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('r1', 'r1', 'room', 'room', ?)")
    .run(JSON.stringify(cfg));
  const anchor = Number(db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
    VALUES ('r1', 'user', 'user', 'text', 'ok', 'done', '{}', 'main')`).run().lastInsertRowid);
  const wakes: Array<{ module: string; contact: string }> = [];
  const facts: number[] = [];
  const dispatch = {
    dispatchToModule: (roomId: string, module: string, toContact: string) => {
      wakes.push({ module, contact: toContact });
      return { status: 'posted' as const };
    },
    publishFact: (messageId: number) => { facts.push(messageId); },
  };
  const store = new RoomTaskStore(db, jobs, dispatch as never);
  return { dir, db, jobs, store, anchor, dispatch, wakes, facts };
}

async function call(fx: ReturnType<typeof setup>, taskPath: string, actor: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) {
  const { db, jobs, dispatch } = fx;
  const turn = beginRoomTurn(db, { ...ctx, contactId: actor });
  try {
    const tool = buildRoomTaskTools(db, jobs, actor, dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === name)!;
    const result = await tool.exec({ room_id: 'r1', task_path: taskPath, ...args });
    assert.equal(result.ok, true, `${name}: ${result.text}`);
    return JSON.parse(result.text);
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

async function failCall(fx: ReturnType<typeof setup>, taskPath: string, actor: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) {
  const { db, jobs, dispatch } = fx;
  const turn = beginRoomTurn(db, { ...ctx, contactId: actor });
  try {
    const tool = buildRoomTaskTools(db, jobs, actor, dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === name)!;
    const result = await tool.exec({ room_id: 'r1', task_path: taskPath, ...args });
    assert.equal(result.ok, false, `${name} should fail`);
    return result.text;
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

/** plan 建账并用带 sequence 的 task_pass 直启首块；返回 taskId + 首块 jobId。 */
async function startSequence(fx: ReturnType<typeof setup>, taskPath: string, sequence: Array<Record<string, unknown>>, extraPass: Record<string, unknown> = {}) {
  const { dir, store, anchor } = fx;
  const created = await call(fx, taskPath, 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'SEQ', requirements: 'req', workspace: dir, anchor_message_id: anchor,
  });
  const taskId: string = created.task.id;
  const passed = await call(fx, taskPath, 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', {
    to_module: 'execute', note: '首块直启', auto_start: true,
    expected_revision: store.getTask('r1', taskPath)!.revision,
    sequence, ...extraPass,
  });
  assert.ok(passed.job?.id, `expected first-block job, got ${JSON.stringify(passed)}`);
  return { taskId, jobId: passed.job.id as string };
}

/** 完成一个 execute 块（done + 终态折叠），返回 jobId。 */
function finishExecute(fx: ReturnType<typeof setup>, jobId: string, head: string) {
  const { db, jobs, store } = fx;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
  const outcome = jobs.complete(jobs.get(jobId)!, 'done', 'simulated done', null, 'delivered', boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat/seq', head,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'seq' },
  }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  store.handleJobFinished(jobs.get(jobId)!, { finalAttempt: true, actor: 'muse' });
  return jobId;
}

/** review APPROVE（可选 after_merge）→ 直启 merge；返回 merge jobId。 */
async function approveToMerge(fx: ReturnType<typeof setup>, taskPath: string, taskId: string, candidateJobId: string, head: string, afterMerge?: string) {
  await call(fx, taskPath, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: candidateJobId, candidate_sha: head,
    verdict: 'approve', findings: 'all green',
    ...(afterMerge ? { after_merge: afterMerge } : {}),
  });
  const merges = fx.store.linkedJobs(taskId).filter((job) => {
    try { return (JSON.parse(job.options) as { closureKind?: unknown }).closureKind === 'merge'; } catch { return false; }
  });
  assert.equal(merges.length, 1, 'APPROVE must have started the merge job');
  return merges[0].id;
}

/** 完成 merge（确定性脚本报告 head == 候选），返回 handleJobFinished 结果。 */
function finishMerge(fx: ReturnType<typeof setup>, mergeJobId: string, reportHead: string) {
  const { db, jobs, store } = fx;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(mergeJobId);
  const report = { ok: true, lane: 'merge', branch: 'master', head: reportHead, tests: MERGE_SUITES };
  const outcome = jobs.complete(jobs.get(mergeJobId)!, 'done', `log\n${JSON.stringify(report)}\n`, null, 'delivered',
    boundedDeliveryMeta({
      state: 'delivered',
      receipt: {
        branch: 'feat/seq', head: reportHead,
        diffstat: '1 file changed, 1 insertion(+)',
        changedFiles: { files: ['a.ts'], total: 1 }, tests: MERGE_SUITES,
        scriptReport: report, scriptExitCode: 0,
      },
      declared: { stage: 'delivered_waiting_deploy', committed: true, pushed: true },
    }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  return store.handleJobFinished(jobs.get(mergeJobId)!, { finalAttempt: true, actor: 'codex' });
}

/** 本任务下非收口的新 execute job（排除已知 id）。 */
function freshExecuteJobs(fx: ReturnType<typeof setup>, taskId: string, exclude: string[]) {
  return fx.store.linkedJobs(taskId).filter((job) => {
    if (exclude.includes(job.id)) return false;
    try {
      const options = JSON.parse(job.options) as { closureKind?: unknown };
      return !options.closureKind;
    } catch { return false; }
  });
}

function wakesOf(fx: ReturnType<typeof setup>, module: string): number {
  return fx.wakes.filter((w) => w.module === module).length;
}

function eventPayload(fx: ReturnType<typeof setup>, taskId: string, kind: string): Record<string, unknown> | null {
  const row = fx.db.prepare('SELECT payload FROM room_task_events WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
    .get(taskId, kind) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as Record<string, unknown> : null;
}

function hasEvent(fx: ReturnType<typeof setup>, taskId: string, kind: string): boolean {
  return eventPayload(fx, taskId, kind) !== null;
}

function callbackReturn(fx: ReturnType<typeof setup>, jobId: string): string | null {
  const row = fx.db.prepare('SELECT return_module FROM room_task_callbacks WHERE job_id = ?').get(jobId) as { return_module: string } | undefined;
  return row?.return_module ?? null;
}

function seqState(fx: ReturnType<typeof setup>, taskPath: string): { items: Array<{ label: string }>; index: number } | null {
  const task = fx.store.getTask('r1', taskPath)!;
  if (!task.sequence_json) return null;
  return { items: JSON.parse(task.sequence_json), index: Number(task.sequence_index) };
}

test('T1 sequence 首块直启：task_pass 带 sequence 起首块 job 并落账 index=0', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  assert.equal(fx.store.getWakeBudget('r1'), 40, 'wakeBudget 默认值不动');
  const { taskId, jobId } = await startSequence(fx, 'tasks/seq.md', SEQ2);
  const job = fx.jobs.get(jobId)!;
  assert.match(job.prompt, /做 W0/, '首块 job 跑的是 sequence[0].objective');
  assert.equal(callbackReturn(fx, jobId), 'review', '首块完成回 review');
  const state = seqState(fx, 'tasks/seq.md');
  assert.ok(state, '账本记录 sequence 全文');
  assert.deepEqual(state!.items.map((item) => item.label), ['W0', 'W1']);
  assert.equal(state!.index, 0, '当前 index=0');
  const started = eventPayload(fx, taskId, 'sequence-started');
  assert.ok(started, '记 sequence-started 事件');
  assert.equal(started!.total, 2);
  assert.equal(started!.index, 0);
  // 首项 objective 与 objective 参数不一致时拒绝。
  const created = await call(fx, 'tasks/seq-b.md', 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'SEQB', requirements: 'req', workspace: fx.dir, anchor_message_id: fx.anchor,
  });
  const otherId: string = created.task.id;
  const text = await failCall(fx, 'tasks/seq-b.md', 'codex', { roomId: 'r1', moduleId: 'plan', taskId: otherId }, 'task_pass', {
    to_module: 'execute', note: 'x', auto_start: true,
    expected_revision: fx.store.getTask('r1', 'tasks/seq-b.md')!.revision,
    objective: '不一样的目标',
    sequence: SEQ2,
  });
  assert.match(text, /sequence 首项 objective/);
});

test('T2 sequence 合入通过自动派第二块：index=1 job 起 review/plan 未唤醒', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, jobId } = await startSequence(fx, 'tasks/seq.md', SEQ2);
  finishExecute(fx, jobId, A);
  const mergeId = await approveToMerge(fx, 'tasks/seq.md', taskId, jobId, A);
  const reviewBefore = wakesOf(fx, 'review');
  const planBefore = wakesOf(fx, 'plan');
  finishMerge(fx, mergeId, A);
  const fresh = freshExecuteJobs(fx, taskId, [jobId]);
  assert.equal(fresh.length, 1, '第二块 execute job 已直启');
  assert.match(fresh[0].prompt, /做 W1/, '第二块跑的是 sequence[1].objective');
  assert.equal(callbackReturn(fx, fresh[0].id), 'review', '第二块完成回 review');
  assert.equal(seqState(fx, 'tasks/seq.md')!.index, 1, '账本 index=1');
  assert.equal(wakesOf(fx, 'review'), reviewBefore, 'review 席未被唤醒');
  assert.equal(wakesOf(fx, 'plan'), planBefore, 'plan 席未被唤醒');
  const started = eventPayload(fx, taskId, 'sequence-next-started');
  assert.ok(started, '记 sequence-next-started 事件');
  assert.equal(started!.index, 1);
  assert.equal(started!.label, 'W1');
  assert.equal(started!.jobId, fresh[0].id);
  const fact = fx.db.prepare("SELECT content FROM messages WHERE meta LIKE '%room-task-sequence-next-auto-start%'").get() as { content: string } | undefined;
  assert.ok(fact?.content.includes('【序列直接启动】'), fact?.content);
  // 重放同一 merge 终态不再起第二遍。
  finishMerge(fx, mergeId, A);
  assert.equal(freshExecuteJobs(fx, taskId, [jobId]).length, 1, '重放不重复直启');
  assert.equal(wakesOf(fx, 'review'), reviewBefore);
});

test('T3a sequence 最后一块 after_merge=deploy 走部署收口', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, jobId } = await startSequence(fx, 'tasks/seq.md', [{ label: 'W0', objective: '做 W0' }]);
  finishExecute(fx, jobId, A);
  const mergeId = await approveToMerge(fx, 'tasks/seq.md', taskId, jobId, A, 'deploy');
  const reviewBefore = wakesOf(fx, 'review');
  finishMerge(fx, mergeId, A);
  const deploys = fx.store.linkedJobs(taskId).filter((job) => {
    try { return (JSON.parse(job.options) as { closureKind?: unknown }).closureKind === 'deploy'; } catch { return false; }
  });
  assert.equal(deploys.length, 1, '最后一块按 after_merge=deploy 收口');
  assert.equal(wakesOf(fx, 'review'), reviewBefore, 'review 席不被唤醒');
  assert.ok(hasEvent(fx, taskId, 'sequence-completed'), '记 sequence-completed 事件');
  assert.equal(seqState(fx, 'tasks/seq.md'), null, '序列随收口清空');
});

test('T3b sequence 最后一块无声明唤醒 plan', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, jobId } = await startSequence(fx, 'tasks/seq.md', [{ label: 'W0', objective: '做 W0' }]);
  finishExecute(fx, jobId, A);
  const mergeId = await approveToMerge(fx, 'tasks/seq.md', taskId, jobId, A);
  const reviewBefore = wakesOf(fx, 'review');
  const planBefore = wakesOf(fx, 'plan');
  finishMerge(fx, mergeId, A);
  assert.equal(wakesOf(fx, 'plan'), planBefore + 1, '无声明时唤醒 plan');
  assert.equal(wakesOf(fx, 'review'), reviewBefore, 'review 席不被唤醒');
  assert.ok(hasEvent(fx, taskId, 'sequence-completed'), '记 sequence-completed 事件');
  assert.equal(seqState(fx, 'tasks/seq.md'), null, '序列随收口清空');
  assert.equal(fx.store.getTask('r1', 'tasks/seq.md')!.holder_module, 'plan', '棒回到 plan');
});

test('T4 sequence REQUEST_CHANGES 返修 APPROVE 后继续下一块', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, jobId } = await startSequence(fx, 'tasks/seq.md', SEQ2);
  finishExecute(fx, jobId, A);
  const review = await call(fx, 'tasks/seq.md', 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit', {
    module: 'review', candidate_job_id: jobId, candidate_sha: A,
    verdict: 'request_changes', findings: 'MUST-1 修空指针；通过条件：单测覆盖该分支且全绿',
  });
  const repairId: string = review.autoPass.jobId;
  assert.ok(repairId, 'REQUEST_CHANGES 走现有直启返修');
  finishExecute(fx, repairId, A);
  const mergeId = await approveToMerge(fx, 'tasks/seq.md', taskId, repairId, A);
  const reviewBefore = wakesOf(fx, 'review');
  const planBefore = wakesOf(fx, 'plan');
  finishMerge(fx, mergeId, A);
  const fresh = freshExecuteJobs(fx, taskId, [jobId, repairId]);
  assert.equal(fresh.length, 1, '返修 APPROVE 合入后序列继续到下一块');
  assert.match(fresh[0].prompt, /做 W1/);
  assert.equal(seqState(fx, 'tasks/seq.md')!.index, 1);
  assert.equal(wakesOf(fx, 'review'), reviewBefore, 'review 席未被唤醒');
  assert.equal(wakesOf(fx, 'plan'), planBefore, 'plan 席未被唤醒');
});

test('T5 sequence 三轮闸触发停序列唤醒 plan 并记 halted', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, jobId } = await startSequence(fx, 'tasks/seq.md', SEQ2);
  finishExecute(fx, jobId, A);
  const mergeId = await approveToMerge(fx, 'tasks/seq.md', taskId, jobId, A);
  // 模拟 verdict 之后又攒满 3 轮 execute：闸门在派下一块时触发。
  for (let i = 0; i < 3; i += 1) {
    fx.db.prepare("INSERT INTO room_task_events (task_id, kind, actor, module, payload) VALUES (?, 'execution-started', 'muse', 'execute', ?)")
      .run(taskId, JSON.stringify({ jobId: `seed-${i}` }));
  }
  const reviewBefore = wakesOf(fx, 'review');
  const planBefore = wakesOf(fx, 'plan');
  finishMerge(fx, mergeId, A);
  assert.equal(freshExecuteJobs(fx, taskId, [jobId]).length, 0, '三轮闸触发时不派下一块');
  assert.equal(wakesOf(fx, 'plan'), planBefore + 1, '唤醒 plan 接管');
  assert.equal(wakesOf(fx, 'review'), reviewBefore, 'review 席不被唤醒');
  const halted = eventPayload(fx, taskId, 'sequence-halted');
  assert.ok(halted, '记 sequence-halted 事件');
  assert.match(String(halted!.reason), /3/);
  assert.equal(seqState(fx, 'tasks/seq.md'), null, '停序列后清空');
});

test('T6 sequence 直启失败回退唤醒 review 并记 fallback', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, jobId } = await startSequence(fx, 'tasks/seq.md', SEQ2);
  finishExecute(fx, jobId, A);
  const mergeId = await approveToMerge(fx, 'tasks/seq.md', taskId, jobId, A);
  // 撤掉 execute 绑定：下一块无可用快照，直启失败。
  fx.db.prepare("UPDATE contacts SET enabled = 0 WHERE id = 'muse'").run();
  const reviewBefore = wakesOf(fx, 'review');
  finishMerge(fx, mergeId, A);
  assert.equal(freshExecuteJobs(fx, taskId, [jobId]).length, 0, '直启失败不起 phantom job');
  assert.equal(wakesOf(fx, 'review'), reviewBefore + 1, '回退现行为：唤醒 review 席');
  const fallback = eventPayload(fx, taskId, 'sequence-next-fallback');
  assert.ok(fallback, '记 sequence-next-fallback 事件');
  assert.equal(fallback!.index, 1);
  assert.equal(fallback!.label, 'W1');
  assert.ok(!hasEvent(fx, taskId, 'sequence-next-started'), '失败时不记 started');
});

test('T7 sequence 覆盖与清空', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId } = await startSequence(fx, 'tasks/seq.md', SEQ2);
  assert.ok(hasEvent(fx, taskId, 'sequence-started'));
  // 首块 job 先终态（仅沉淀回执，不送审），后续覆盖/清空走纯交棒断言。
  const firstJobs = freshExecuteJobs(fx, taskId, []);
  assert.equal(firstJobs.length, 1);
  finishExecute(fx, firstJobs[0].id, A);
  // 同一参数再传即替换。
  await call(fx, 'tasks/seq.md', 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', {
    to_module: 'execute', note: '覆盖序列',
    sequence: [{ label: 'W0b', objective: '重做 W0' }, { label: 'W1b', objective: '重做 W1' }, { label: 'W2b', objective: '加做 W2' }],
  });
  const replaced = eventPayload(fx, taskId, 'sequence-replaced');
  assert.ok(replaced, '覆盖记 sequence-replaced 事件');
  assert.equal(replaced!.total, 3);
  assert.deepEqual(seqState(fx, 'tasks/seq.md')!.items.map((item) => item.label), ['W0b', 'W1b', 'W2b']);
  assert.equal(seqState(fx, 'tasks/seq.md')!.index, 0, '覆盖后 index 归零');
  // 裸 task_pass 到 plan 接回棒并清空。
  await call(fx, 'tasks/seq.md', 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', {
    to_module: 'plan', note: 'plan 接管',
  });
  assert.equal(seqState(fx, 'tasks/seq.md'), null, '裸 pass 到 plan 清空序列');
  const cleared = eventPayload(fx, taskId, 'sequence-cleared');
  assert.ok(cleared, '清空记 sequence-cleared 事件');
  assert.equal(cleared!.reason, 'pass-to-plan');
  // 重设后 task_block 清空。
  await call(fx, 'tasks/seq.md', 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', {
    to_module: 'execute', note: '重设序列', sequence: SEQ2,
  });
  assert.ok(seqState(fx, 'tasks/seq.md'), '重设后序列恢复');
  await call(fx, 'tasks/seq.md', 'codex', { roomId: 'r1', moduleId: 'execute', taskId }, 'task_block', {
    note: '外部依赖缺失，受阻停下',
  });
  assert.equal(seqState(fx, 'tasks/seq.md'), null, 'task_block 清空序列');
  // blocked 后交棒即恢复 open：重设后 task_done 清空。
  await call(fx, 'tasks/seq.md', 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', {
    to_module: 'execute', note: '恢复后重设', sequence: SEQ2,
  });
  assert.ok(seqState(fx, 'tasks/seq.md'), '恢复后序列可重设');
  await call(fx, 'tasks/seq.md', 'codex', { roomId: 'r1', moduleId: 'execute', taskId }, 'task_done', {
    note: '完工收口',
  });
  assert.equal(seqState(fx, 'tasks/seq.md'), null, 'task_done 清空序列');
  assert.equal(fx.store.getTask('r1', 'tasks/seq.md')!.status, 'closed');
});
