// R2-D D1+D3: review_submit patch 入口与机器闸（D1）+ 网关接受与回程（D3）。
// D1: strict/PC/request_changes 带 patch → 400；大小/行数/文件数/路径/敏感/解析 400；
//     通过后 candidate_sha 不变、review approved、事件 payload 带结构化 patch、review-patch 证据可被合入链读取。
// D3: closureCommand 带 b64/sha；mergedHeadOf 对 sha 不符/缺字段返回 null；done 后 merge-patched 事件与 after_merge 联动。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/platform/db.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import type { RoomTaskToolContext } from '../src/roomTasks/roomTaskStore.js';
import { RoomTaskStore, isSensitiveReviewPatchFile, mergedHeadOf } from '../src/roomTasks/roomTaskStore.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { boundedDeliveryMeta } from '../src/jobs/receiptFields.js';
import type { SseHub } from '../src/platform/sse.js';

const SHA = (ch: string) => ch.repeat(40);
const H = SHA('b');
const BASE = SHA('c');

const GOOD_PATCH = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,3 @@',
  ' line1',
  '-old',
  '+new',
  ' line3',
  '',
].join('\n');

const TEST_FILE_PATCH = [
  'diff --git a/test/a.test.ts b/test/a.test.ts',
  '--- a/test/a.test.ts',
  '+++ b/test/a.test.ts',
  '@@ -1,2 +1,2 @@',
  '-old',
  '+new',
  '',
].join('\n');

const OTHER_FILE_PATCH = [
  'diff --git a/b.ts b/b.ts',
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -1,2 +1,2 @@',
  '-old',
  '+new',
  '',
].join('\n');

const SENSITIVE_PATCH = [
  'diff --git a/deploy/merge-close-job.mjs b/deploy/merge-close-job.mjs',
  '--- a/deploy/merge-close-job.mjs',
  '+++ b/deploy/merge-close-job.mjs',
  '@@ -1,2 +1,2 @@',
  '-old',
  '+new',
  '',
].join('\n');

function setup(governance?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-r2d-d1-'));
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
  const dispatch: any = {
    dispatchToModule: () => ({ status: 'posted' as const }),
    publishFact: () => {},
  };
  const store = new RoomTaskStore(db, jobs, dispatch);
  return { dir, db, jobs, store, anchor, dispatch };
}

async function callOk(fx: ReturnType<typeof setup>, actor: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) {
  const { db, jobs, dispatch } = fx;
  const turn = beginRoomTurn(db, { ...ctx, contactId: actor });
  try {
    const tool = buildRoomTaskTools(db, jobs, actor, dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === name)!;
    const result = await tool.exec({ room_id: 'r1', task_path: 'tasks/r1.md', ...args });
    assert.equal(result.ok, true, `${name}: ${result.text}`);
    return JSON.parse(result.text);
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

async function callFail(fx: ReturnType<typeof setup>, actor: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) {
  const { db, jobs, dispatch } = fx;
  const turn = beginRoomTurn(db, { ...ctx, contactId: actor });
  try {
    const tool = buildRoomTaskTools(db, jobs, actor, dispatch as never, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
      .find((item) => item.name === name)!;
    const result = await tool.exec({ room_id: 'r1', task_path: 'tasks/r1.md', ...args });
    assert.equal(result.ok, false, `${name} should fail`);
    return result.text;
  } finally {
    endRoomTurn(db, turn.turnId, 'test');
  }
}

async function finishImpl(fx: ReturnType<typeof setup>, changedFiles: string[] = ['a.ts']) {
  const { dir, db, jobs, store, anchor } = fx;
  // Linux-style workspace: Windows tmp dirs would trip the PC-workspace gate
  // (same regex as projectTargets.ts). DB files stay on the real tmp dir.
  const workspace = '/tmp/ai-hub-r2d-d1-work';
  const created = await callOk(fx, 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'R2D-D1', requirements: 'req', workspace, anchor_message_id: anchor,
  });
  const taskId: string = created.task.id;
  await callOk(fx, 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_pass', { to_module: 'execute', note: 'go' });
  const started = await callOk(fx, 'muse', { roomId: 'r1', moduleId: 'execute', taskId }, 'execution_start', {
    module: 'execute', expected_revision: store.getTask('r1', 'tasks/r1.md')!.revision,
    workspace, objective: 'impl',
  });
  const implJobId: string = started.job.id;
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(implJobId);
  const outcome = jobs.complete(jobs.get(implJobId)!, 'done', 'simulated done', null, 'delivered', boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat/r1', head: H,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: changedFiles, total: changedFiles.length },
      tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'r1' },
  }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  store.handleJobFinished(jobs.get(implJobId)!, { finalAttempt: true, actor: 'muse' });
  return { taskId, implJobId };
}

async function reviewArgs(fx: ReturnType<typeof setup>, taskId: string, implJobId: string, extra: Record<string, unknown> = {}) {
  return {
    module: 'review', candidate_job_id: implJobId, candidate_sha: H,
    verdict: 'approve', findings: 'all green',
    ...extra,
  };
}

test('D1: strict 房带 patch → 400', async (t) => {
  const fx = setup();
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const workspace = '/tmp/ai-hub-r2d-d1-strict';
  const created = await callOk(fx, 'codex', { roomId: 'r1', moduleId: 'plan' }, 'task_create', {
    title: 'R2D-D1', requirements: 'req', workspace, anchor_message_id: fx.anchor,
  });
  const taskId: string = created.task.id;
  const h1 = await callOk(fx, 'codex', { roomId: 'r1', moduleId: 'plan', taskId }, 'task_handoff', {
    actor_module: 'plan', to_module: 'execute', request: 'impl', evidence_refs: [],
  });
  const execCtx: RoomTaskToolContext = { roomId: 'r1', moduleId: 'execute', taskId, handoffId: h1.handoff.id };
  await callOk(fx, 'muse', execCtx, 'task_accept', {});
  const started = await callOk(fx, 'muse', execCtx, 'execution_start', {
    module: 'execute', expected_revision: fx.store.getTask('r1', 'tasks/r1.md')!.revision,
    workspace, objective: 'impl', return_to_module: 'plan', return_mode: 'notify',
  });
  const implJobId: string = started.job.id;
  fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(implJobId);
  const outcome = fx.jobs.complete(fx.jobs.get(implJobId)!, 'done', 'simulated done', null, 'delivered', boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'feat/r1', head: H,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 },
      tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false, summary: 'r1' },
  }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  fx.store.handleJobFinished(fx.jobs.get(implJobId)!, { finalAttempt: true, actor: 'muse' });
  const h2 = await callOk(fx, 'muse', execCtx, 'task_handoff', {
    actor_module: 'execute', to_module: 'review', request: 'review', evidence_refs: [implJobId],
  });
  const reviewCtx: RoomTaskToolContext = { roomId: 'r1', moduleId: 'review', taskId, handoffId: h2.handoff.id };
  await callOk(fx, 'aye', reviewCtx, 'task_accept', {});
  const text = await callFail(fx, 'aye', reviewCtx, 'review_submit',
    { module: 'review', candidate_job_id: implJobId, candidate_sha: H, verdict: 'approve', findings: 'all green', patch: GOOD_PATCH });
  assert.match(text, /strict/);
});

test('D1: PC 工作区带 patch → 400', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx);
  fx.db.prepare('UPDATE room_tasks SET approved_workspace = ? WHERE id = ?').run('C:\\pc\\work', taskId);
  fx.db.prepare('UPDATE jobs SET workspace = ? WHERE id = ?').run('C:\\pc\\work', implJobId);
  const text = await callFail(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), patch: GOOD_PATCH });
  assert.match(text, /PC 工作区暂不支持评审补丁/);
});

test('D1: REQUEST_CHANGES 带 patch → 400', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx);
  const text = await callFail(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), verdict: 'request_changes', findings: 'MUST fix', patch: GOOD_PATCH });
  assert.match(text, /只在 verdict=approve/);
});

test('D1: 补丁超 8000 字符 → 400', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx);
  const text = await callFail(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), patch: 'x'.repeat(8001) });
  assert.match(text, /大小超限/);
});

test('D1: 补丁增删超 40 行 → 400', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx);
  const lines = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,50 +1,50 @@'];
  for (let i = 0; i < 25; i += 1) {
    lines.push(`-old${i}`);
    lines.push(`+new${i}`);
  }
  const text = await callFail(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), patch: lines.join('\n') });
  assert.match(text, /增删合计超限/);
});

test('D1: 补丁超 3 文件 → 400', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx, ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts']);
  const patch = ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts'].map((f) => [
    `diff --git a/${f} b/${f}`,
    `--- a/${f}`,
    `+++ b/${f}`,
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n')).join('\n');
  const text = await callFail(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), patch });
  assert.match(text, /文件数超限/);
});

test('D1: 补丁文件不在 changedFiles 且非测试 → 400', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx, ['a.ts']);
  const text = await callFail(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), patch: OTHER_FILE_PATCH });
  assert.match(text, /不在候选 changedFiles/);
});

test('D1: 补丁触碰敏感路径 → 400', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx, ['deploy/merge-close-job.mjs']);
  const text = await callFail(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), patch: SENSITIVE_PATCH });
  assert.match(text, /敏感路径/);
});

test('D1: 敏感清单覆盖这些文件的当前位置（文件搬家不能悄悄丢保护）', () => {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  for (const file of [
    'worker/runner/closure-runner.mjs',
    'worker/runner/provision.mjs',
    'server/src/jobs/closureAutomation.ts',
    'server/src/workflow/workflowModules.ts',
    'server/src/platform/middleware/auth.ts',
    'server/src/platform/middleware/closureAuth.ts',
    'server/src/platform/middleware/hubMcpAuth.ts',
    'server/src/roomTasks/roomTaskStore.ts',
    'deploy/merge-close-job.mjs',
  ]) {
    assert.ok(fs.existsSync(path.join(repo, file)), `${file} moved: update REVIEW_PATCH_SENSITIVE and this list`);
    assert.equal(isSensitiveReviewPatchFile(file), true, `${file} must stay review-patch sensitive`);
  }
});

test('D1: 补丁无法严格解析 → 400', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx);
  const badAb = [
    'diff --git a/a.ts b/b.ts',
    '--- a/a.ts',
    '+++ b/b.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
  const text = await callFail(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), patch: badAb });
  assert.match(text, /严格解析|不一致/);
  const noHeader = await callFail(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), patch: 'just some text' });
  assert.match(noHeader, /缺少 diff --git/);
});

test('D1: 补丁新增文件 → 400', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx, ['a.ts']);
  const added = [
    'diff --git a/a.ts b/a.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/a.ts',
    '@@ -0,0 +1 @@',
    '+new',
  ].join('\n');
  const text = await callFail(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), patch: added });
  assert.match(text, /不得新增\/删除\/重命名/);
});

test('D1: 通过后 candidate_sha 不变、review approved、patch 落账', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx, ['a.ts']);
  const review = await callOk(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), patch: GOOD_PATCH });
  const task = fx.store.getTask('r1', 'tasks/r1.md')!;
  assert.equal(task.candidate_sha?.toLowerCase(), H.toLowerCase(), 'candidate_sha 不推进');
  assert.equal(task.candidate_job_id, implJobId);
  assert.equal(task.review_status, 'approved');
  const event = fx.db.prepare(
    "SELECT payload FROM room_task_events WHERE task_id = ? AND kind = 'review-approved' ORDER BY id DESC LIMIT 1",
  ).get(taskId) as { payload: string };
  const payload = JSON.parse(event.payload) as {
    patch?: { sha256: string; chars: number; lines: number; files: string[] };
    patchEvidenceId?: number;
  };
  assert.ok(payload.patch, '事件 payload 带结构化 patch');
  assert.equal(payload.patch!.files.join(','), 'a.ts');
  assert.equal(payload.patch!.chars, GOOD_PATCH.length);
  assert.equal(payload.patch!.lines, 2);
  assert.match(payload.patch!.sha256, /^[0-9a-f]{64}$/i);
  assert.ok(typeof payload.patchEvidenceId === 'number', '事件 payload 记 review-patch 证据 id');
  const stored = fx.db.prepare(
    'SELECT body FROM room_task_evidence WHERE id = ? AND task_id = ?',
  ).get(payload.patchEvidenceId, taskId) as { body: string };
  assert.equal(stored.body, GOOD_PATCH, 'review-patch 证据 body 为补丁原文，可被合入链读取');
  const reviewBody = fx.db.prepare(
    'SELECT body FROM room_task_evidence WHERE id = ?',
  ).get(review.evidenceId) as { body: string };
  assert.ok(reviewBody.body.includes(GOOD_PATCH.slice(0, 20)), 'review 证据正文含补丁原文');
});

test('D1: 测试文件补丁可通过（不在 changedFiles）', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx, ['a.ts']);
  const review = await callOk(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), patch: TEST_FILE_PATCH });
  assert.ok(review.evidenceId, '测试文件补丁应通过');
});

// ── D3 ───────────────────────────────────────────────────────────────

const PATCHED = SHA('e');
const MERGE_SUITES = [
  'server npm run pretest', 'server npm test', 'web npm test',
  'smoke:deploy-drain', 'smoke:turn-timeouts', 'smoke:deploy-resume',
].map((suite) => ({ suite, status: 'pass' as const }));

function patchSha(patch: string): string {
  return crypto.createHash('sha256').update(patch, 'utf8').digest('hex');
}

function mergeJobsOf(fx: ReturnType<typeof setup>, taskId: string) {
  return fx.store.linkedJobs(taskId).filter((job) => {
    try { return (JSON.parse(job.options) as { closureKind?: unknown }).closureKind === 'merge'; } catch { return false; }
  });
}

test('D3: APPROVE 带 patch 直启合入，closureCommand 带 b64/sha（posix 有、win 无）', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx, ['a.ts']);
  const review = await callOk(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), patch: GOOD_PATCH });
  assert.ok(review.autoRelease?.jobId, `expected direct merge start, got ${JSON.stringify(review.autoRelease)}`);
  const merges = mergeJobsOf(fx, taskId);
  assert.equal(merges.length, 1);
  const options = JSON.parse(merges[0].options) as {
    closureCommand: { posix: { args: string[] }; win: { args: string[] } };
  };
  const posix = options.closureCommand.posix.args;
  const b64Idx = posix.indexOf('--review-patch-b64');
  const shaIdx = posix.indexOf('--review-patch-sha256');
  assert.notEqual(b64Idx, -1, 'posix 带 --review-patch-b64');
  assert.notEqual(shaIdx, -1, 'posix 带 --review-patch-sha256');
  assert.equal(Buffer.from(posix[b64Idx + 1], 'base64').toString('utf8'), GOOD_PATCH);
  assert.equal(posix[shaIdx + 1].toLowerCase(), patchSha(GOOD_PATCH));
  assert.ok(!options.closureCommand.win.args.includes('--review-patch-b64'), 'win ps1 不加补丁参数');
});

test('D3: mergedHeadOf 对 sha 不符/缺字段返回 null', () => {
  const sha = patchSha(GOOD_PATCH);
  const good = { head: PATCHED, patchedFrom: H, patch: 'identical', patchSha256: sha };
  assert.equal(mergedHeadOf(good, H, sha), PATCHED.toLowerCase());
  assert.equal(mergedHeadOf(good, H, SHA('f').repeat(1).slice(0, 40) + '0'.repeat(24)), null, 'sha 不符 → null');
  assert.equal(mergedHeadOf(good, H, null), null, '缺 expected → null');
  assert.equal(mergedHeadOf({ head: PATCHED, patchedFrom: H, patch: 'identical' }, H, sha), null, '缺 patchSha256 → null');
  assert.equal(mergedHeadOf({ head: PATCHED, patch: 'identical', patchSha256: sha }, H, sha), null, '缺 patchedFrom → null');
  assert.equal(mergedHeadOf({ head: PATCHED, patchedFrom: SHA('d'), patch: 'identical', patchSha256: sha }, H, sha), null, 'patchedFrom 非法 → null');
  // rebase 叠加：patchedFrom 为 rebase 后 head 时接受。
  const rebased = SHA('d');
  const stacked = {
    head: PATCHED, patchedFrom: rebased, patch: 'identical', patchSha256: sha,
    rebase: 'identical', rebasedFrom: H,
  };
  assert.equal(mergedHeadOf(stacked, H, sha), PATCHED.toLowerCase());
  assert.equal(mergedHeadOf(stacked, H, patchSha(TEST_FILE_PATCH)), null, '叠加但 sha 不符 → null');
});

test('D3: merge done（identical 补丁）记 merge-patched，after_merge=done 自动收口', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx, ['a.ts']);
  const review = await callOk(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), after_merge: 'done', patch: GOOD_PATCH });
  const merges = mergeJobsOf(fx, taskId);
  assert.equal(merges.length, 1);
  const mergeJobId = merges[0].id;
  const sha = patchSha(GOOD_PATCH);
  fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(mergeJobId);
  const scriptReport = {
    ok: true, lane: 'merge', branch: 'master', head: PATCHED,
    patchedFrom: H, patch: 'identical', patchSha256: sha, tests: MERGE_SUITES,
  };
  const outcome = fx.jobs.complete(fx.jobs.get(mergeJobId)!, 'done', `log\n${JSON.stringify(scriptReport)}\n`, null, 'delivered',
    boundedDeliveryMeta({
      state: 'delivered',
      receipt: {
        branch: 'feat/r1', head: PATCHED,
        diffstat: '1 file changed, 1 insertion(+)',
        changedFiles: { files: ['a.ts'], total: 1 }, tests: MERGE_SUITES,
        scriptReport, scriptExitCode: 0,
      },
      declared: { stage: 'delivered_waiting_deploy', committed: true, pushed: true },
    }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  fx.store.handleJobFinished(fx.jobs.get(mergeJobId)!, { finalAttempt: true, actor: 'codex' });
  const kinds = (fx.db.prepare('SELECT kind FROM room_task_events WHERE task_id = ? ORDER BY id ASC').all(taskId) as Array<{ kind: string }>)
    .map((row) => row.kind);
  assert.ok(kinds.includes('merge-patched'), `expected merge-patched, got ${kinds.join(',')}`);
  const patchedEvent = fx.db.prepare(
    "SELECT payload FROM room_task_events WHERE task_id = ? AND kind = 'merge-patched' ORDER BY id DESC LIMIT 1",
  ).get(taskId) as { payload: string };
  const payload = JSON.parse(patchedEvent.payload) as {
    jobId: string; from: string; to: string; patchSha256: string; evidenceId: number;
  };
  assert.equal(payload.jobId, mergeJobId);
  assert.equal(payload.from, H.toLowerCase());
  assert.equal(payload.to, PATCHED.toLowerCase());
  assert.equal(payload.patchSha256, sha);
  assert.equal(payload.evidenceId, review.evidenceId);
  assert.equal(fx.store.getTask('r1', 'tasks/r1.md')!.status, 'closed', 'after_merge=done 照常收口');
  assert.ok(kinds.includes('auto-closed'), kinds.join(','));
});

test('D3: merge 报告 sha 与批准不一致时不收口（按失败路径唤醒评审）', async (t) => {
  const fx = setup('open');
  t.after(() => { fx.db.close(); fs.rmSync(fx.dir, { recursive: true, force: true }); });
  const { taskId, implJobId } = await finishImpl(fx, ['a.ts']);
  await callOk(fx, 'aye', { roomId: 'r1', moduleId: 'review', taskId }, 'review_submit',
    { ...(await reviewArgs(fx, taskId, implJobId)), after_merge: 'done', patch: GOOD_PATCH });
  const merges = mergeJobsOf(fx, taskId);
  const mergeJobId = merges[0].id;
  fx.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(mergeJobId);
  const badReport = {
    ok: true, lane: 'merge', branch: 'master', head: PATCHED,
    patchedFrom: H, patch: 'identical', patchSha256: patchSha(TEST_FILE_PATCH), tests: MERGE_SUITES,
  };
  const outcome = fx.jobs.complete(fx.jobs.get(mergeJobId)!, 'done', `log\n${JSON.stringify(badReport)}\n`, null, 'delivered',
    boundedDeliveryMeta({
      state: 'delivered',
      receipt: {
        branch: 'feat/r1', head: PATCHED,
        diffstat: '1 file changed, 1 insertion(+)',
        changedFiles: { files: ['a.ts'], total: 1 }, tests: MERGE_SUITES,
        scriptReport: badReport, scriptExitCode: 0,
      },
      declared: { stage: 'delivered_waiting_deploy', committed: true, pushed: true },
    }));
  assert.ok(!('error' in outcome), JSON.stringify(outcome));
  fx.store.handleJobFinished(fx.jobs.get(mergeJobId)!, { finalAttempt: true, actor: 'codex' });
  const kinds = (fx.db.prepare('SELECT kind FROM room_task_events WHERE task_id = ? ORDER BY id ASC').all(taskId) as Array<{ kind: string }>)
    .map((row) => row.kind);
  assert.ok(!kinds.includes('merge-patched'), `sha 不符不得记 merge-patched, got ${kinds.join(',')}`);
  assert.ok(!kinds.includes('auto-closed'), kinds.join(','));
  assert.notEqual(fx.store.getTask('r1', 'tasks/r1.md')!.status, 'closed');
});
