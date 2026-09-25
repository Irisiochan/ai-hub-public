// WP-C: merge/deploy mechanical closure becomes a deterministic job whose
// receipt is the raw script stdout. releaseExecute must stamp closureCommand
// (args identical to the fixed prompt command); the deploy gate prefers
// delivery_meta.receipt.scriptReport and rejects with an itemized message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { buildRoomTaskTools } from '../src/roomTasks/roomTaskTools.js';
import { beginRoomTurn, endRoomTurn } from '../src/roomTasks/turnAttribution.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import type { RoomTaskToolContext } from '../src/roomTasks/roomTaskStore.js';
import { buildDeployClosureCommand, buildMergeClosureCommand } from '../src/jobs/closureAutomation.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { boundedDeliveryMeta } from '../src/jobs/receiptFields.js';
import type { SseHub } from '../src/platform/sse.js';

const SHA = (ch: string) => ch.repeat(40);
const H2 = SHA('b');
const BASE = SHA('c');
const MERGE_SUITES = [
  'server npm run pretest', 'server npm test', 'web npm test',
  'smoke:deploy-drain', 'smoke:turn-timeouts', 'smoke:deploy-resume',
].map((suite) => ({ suite, status: 'pass' as const }));

function setup(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-closure-cmd-'));
  const db = openDb(path.join(dir, 'hub.db'));
  t.after(() => { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const sse = { broadcast: () => {} } as unknown as SseHub;
  const jobs = new JobStore(db, sse);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')").run(id, id, backend);
  }
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-a', 'room-a', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse', 'aye'] }));
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-a::merge', 'm', 'codex', 'module-binding', ?)")
    .run(JSON.stringify({}));
  // Minimal module bindings for merge/deploy/release flow.
  jobs.workflowModules.setBinding('merge', { contactId: 'codex', runner: 'codex', model: 'm', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  jobs.workflowModules.setBinding('deploy', { contactId: 'codex', runner: 'codex', model: 'm', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  jobs.workflowModules.setBinding('execute', { contactId: 'muse', runner: 'opencode', model: 'm', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  jobs.workflowModules.setBinding('review', { contactId: 'aye', runner: 'grok', model: 'm', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  jobs.workflowModules.setBinding('plan', { contactId: 'codex', runner: 'codex', model: 'm', reasoning: 'high' }, jobs.workflowModules.revision(), 'User');
  const anchor = Number(db.prepare(`INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
    VALUES ('room-a', 'user', 'user', 'text', 'User: approve closure', 'done', '{}', 'main')`).run().lastInsertRowid);
  const dispatch: any = { dispatchToModule: () => ({ status: 'posted' as const }) };
  const store = new RoomTaskStore(db, jobs, dispatch);
  const call = async (actor: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) => {
    const turn = beginRoomTurn(db, { ...ctx, contactId: actor });
    try {
      const tool = buildRoomTaskTools(db, jobs, actor, dispatch, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
        .find((item) => item.name === name)!;
      const result = await tool.exec({ room_id: 'room-a', task_path: 'tasks/closure.md', ...args });
      assert.equal(result.ok, true, `${name}: ${result.text}`);
      return JSON.parse(result.text);
    } finally { endRoomTurn(db, turn.turnId, 'test'); }
  };
  const failCall = async (actor: string, ctx: RoomTaskToolContext, name: string, args: Record<string, unknown>) => {
    const turn = beginRoomTurn(db, { ...ctx, contactId: actor });
    try {
      const tool = buildRoomTaskTools(db, jobs, actor, dispatch, { readVaultTask: () => null }, { ...ctx, turnId: turn.turnId })
        .find((item) => item.name === name)!;
      const result = await tool.exec({ room_id: 'room-a', task_path: 'tasks/closure.md', ...args });
      assert.equal(result.ok, false, `${name} should fail`);
      return result.text;
    } finally { endRoomTurn(db, turn.turnId, 'test'); }
  };
  const finish = (jobId: string, status: 'done' | 'failed', meta: string, resultText = `simulated ${status}`) => {
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
    const outcome = jobs.complete(jobs.get(jobId)!, status, resultText, status === 'failed' ? 'boom' : null,
      status === 'done' ? 'delivered' : 'failed', meta);
    assert.ok(!('error' in outcome), `complete failed: ${JSON.stringify(outcome)}`);
    return jobs.get(jobId)!;
  };
  return { dir, db, jobs, store, dispatch, anchor, call, failCall, finish };
}

test('builders produce deterministic closure commands', () => {
  const evidence = { roomId: 'room-a', taskPath: 'tasks/closure.md', candidateSha: H2, reviewStatus: 'approved', reviewEvidenceId: 7 };
  const merge = buildMergeClosureCommand({
    taskPath: 'tasks/closure.md', branch: 'codex/w', frozenSha: H2, baselineSha: BASE, releaseEvidence: evidence,
  });
  assert.equal(merge.kind, 'merge');
  assert.equal(merge.win.file, 'deploy/merge-close-job.ps1');
  assert.equal(merge.posix.file, 'deploy/merge-close-job.mjs');
  assert.equal(merge.timeoutMs, 45 * 60 * 1000);
  assert.ok(merge.win.args.includes(H2));
  assert.ok(merge.win.args.includes('codex/w'));
  const evidenceArg = merge.win.args[merge.win.args.indexOf('-ReleaseEvidence') + 1];
  assert.ok(evidenceArg.includes(H2), 'ReleaseEvidence JSON kept verbatim');
  // The Linux lane carries the same evidence: merge-close-job.mjs refuses to
  // run without it, so the VPS can never push master unverified.
  const posixEvidence = merge.posix.args[merge.posix.args.indexOf('--release-evidence') + 1];
  assert.equal(posixEvidence, evidenceArg, 'posix lane gets the identical evidence JSON');
  // ai-hub candidates (no frozen VPS target, no workspace passthrough) carry
  // no repo args: the script's ai-hub default is exactly right for them.
  assert.ok(!merge.posix.args.includes('--repo'));
  assert.ok(!merge.posix.args.includes('--repo-dir'));
  assert.ok(!merge.win.args.includes('-RepoDir'));
  // R3: without a frozen target the gateway stamps the candidate workspace as
  // a directory only (never --repo), so a non-ai-hub checkout resolves its
  // own .ai-hub-merge.json and checkouts without one keep the ai-hub default.
  const ws = buildMergeClosureCommand({
    taskPath: 'tasks/closure.md', branch: 'codex/w', frozenSha: H2, baselineSha: BASE, releaseEvidence: evidence,
    repoDir: 'C:/work/pet-daily',
  });
  assert.ok(!ws.posix.args.includes('--repo'), 'workspace passthrough never adds --repo');
  assert.equal(ws.posix.args[ws.posix.args.indexOf('--repo-dir') + 1], 'C:/work/pet-daily');
  assert.equal(ws.win.args[ws.win.args.indexOf('-RepoDir') + 1], 'C:/work/pet-daily');
  assert.ok(!ws.win.args.includes('-Repo'), 'win lane gets a directory, not a repo tag');
  // A VPS candidate names its repo and checkout, or the gate would run the
  // ai-hub suites (`npm --prefix server`) inside an ai-dashboard clone.
  const dir = '/srv/ai-dev/jobs/fix-x/attempt-1a2b3c4d/ai-dashboard';
  const vps = buildMergeClosureCommand({
    taskPath: 'tasks/closure.md', branch: 'task/fix-x', frozenSha: H2, baselineSha: BASE, releaseEvidence: evidence,
    repo: { repoId: 'ai-dashboard', repoDir: dir },
  });
  const a = vps.posix.args;
  assert.equal(a[a.indexOf('--repo') + 1], 'ai-dashboard');
  assert.equal(a[a.indexOf('--repo-dir') + 1], dir);
  assert.ok(!vps.win.args.includes('--repo'), 'the ps1 lane is untouched');
  const hubRepo = buildMergeClosureCommand({
    taskPath: 'tasks/closure.md', branch: 'codex/w', frozenSha: H2, baselineSha: BASE, releaseEvidence: evidence,
    repo: { repoId: 'ai-hub', repoDir: '/x' },
  });
  assert.ok(!hubRepo.posix.args.includes('--repo'), 'an explicit ai-hub target adds nothing');
  const deploy = buildDeployClosureCommand({ frozenSha: H2 });
  assert.equal(deploy.kind, 'deploy');
  assert.equal(deploy.win.file, 'deploy/room-deploy-job.ps1');
  assert.equal(deploy.posix.file, 'deploy/room-deploy-job.mjs');
  assert.equal(deploy.timeoutMs, 20 * 60 * 1000);
  assert.ok(deploy.win.args.includes(H2));
});

test('release_execute stamps closureCommand identical to the prompt command', async (t) => {
  const fx = setup(t);
  const created = await fx.call('codex', { roomId: 'room-a', moduleId: 'plan' }, 'task_create', {
    title: 'closure', requirements: 'closure req', workspace: fx.dir, anchor_message_id: fx.anchor,
  });
  const taskId = created.task.id;
  const handoff = await fx.call('codex', { roomId: 'room-a', moduleId: 'plan', taskId }, 'task_handoff', {
    to_module: 'execute', request: 'do',
  });
  const execCtx: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'execute', taskId, handoffId: handoff.handoff.id };
  await fx.call('muse', execCtx, 'task_accept', {});
  const started = await fx.call('muse', execCtx, 'execution_start', {
    module: 'execute', expected_revision: fx.store.getTask('room-a', 'tasks/closure.md')!.revision,
    workspace: fx.dir, objective: 'impl', return_mode: 'notify', return_to_module: 'plan',
  });
  fx.finish(started.job.id, 'done', boundedDeliveryMeta({
    receipt: {
      branch: 'codex/w', head: H2, diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 }, tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false },
  }));
  fx.store.handleJobFinished(fx.jobs.get(started.job.id)!, { finalAttempt: true });
  const toReview = await fx.call('muse', execCtx, 'task_handoff', { to_module: 'review', request: 'review' });
  const reviewCtx: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'review', taskId, handoffId: toReview.handoff.id };
  await fx.call('aye', reviewCtx, 'task_accept', {});
  await fx.call('aye', reviewCtx, 'review_submit', {
    module: 'review', candidate_job_id: started.job.id, candidate_sha: H2,
    verdict: 'approve', findings: 'looks good, all green',
  });
  const toMerge = await fx.call('aye', reviewCtx, 'task_handoff', { to_module: 'merge', request: 'merge it' });
  const mergeCtx: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'merge', taskId, handoffId: toMerge.handoff.id };
  await fx.call('codex', mergeCtx, 'task_accept', {});
  const released = await fx.call('codex', mergeCtx, 'release_execute', {
    kind: 'merge', return_to_module: 'deploy', return_mode: 'notify',
    expected_revision: fx.store.getTask('room-a', 'tasks/closure.md')!.revision,
  });
  const mergeJob = fx.jobs.get(released.job.id)!;
  const options = JSON.parse(mergeJob.options);
  assert.ok(options.closureCommand, 'merge job carries closureCommand');
  assert.equal(options.closureCommand.kind, 'merge');
  assert.equal(options.closureCommand.win.file, 'deploy/merge-close-job.ps1');
  assert.equal(options.dispatchSource, 'explicit-release');
  assert.match(mergeJob.prompt, /Worker 将直接执行 closureCommand，不经模型/);
  // Args must match the fixed prompt command (prompt carries the PowerShell
  // rendering; closureCommand carries the same values as spawn args).
  for (const fragment of [H2, 'codex/w', '"roomId":"room-a"', `"candidateSha":"${H2}"`]) {
    assert.ok(mergeJob.prompt.includes(fragment), `prompt carries ${fragment}`);
  }
  const winArgs: string[] = options.closureCommand.win.args;
  assert.ok(winArgs.includes(H2));
  assert.ok(winArgs.includes('codex/w'));
  const evidenceRaw = winArgs[winArgs.indexOf('-ReleaseEvidence') + 1];
  const evidence = JSON.parse(evidenceRaw);
  assert.equal(evidence.roomId, 'room-a');
  assert.equal(evidence.candidateSha, H2);
  assert.equal(evidence.taskPath, 'tasks/closure.md');
  assert.equal(options.closureCommand.timeoutMs, 45 * 60 * 1000);
});

test('deploy gate prefers scriptReport and itemizes missing proof', async (t) => {
  const fx = setup(t);
  const created = await fx.call('codex', { roomId: 'room-a', moduleId: 'plan' }, 'task_create', {
    title: 'closure', requirements: 'closure req', workspace: fx.dir, anchor_message_id: fx.anchor,
  });
  const taskId = created.task.id;
  const handoff = await fx.call('codex', { roomId: 'room-a', moduleId: 'plan', taskId }, 'task_handoff', {
    to_module: 'execute', request: 'do',
  });
  const execCtx: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'execute', taskId, handoffId: handoff.handoff.id };
  await fx.call('muse', execCtx, 'task_accept', {});
  const started = await fx.call('muse', execCtx, 'execution_start', {
    module: 'execute', expected_revision: fx.store.getTask('room-a', 'tasks/closure.md')!.revision,
    workspace: fx.dir, objective: 'impl', return_mode: 'notify', return_to_module: 'plan',
  });
  fx.finish(started.job.id, 'done', boundedDeliveryMeta({
    receipt: {
      branch: 'codex/w', head: H2, diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 }, tests: [{ suite: 'unit', status: 'pass' }],
    },
    before: { head: BASE },
    declared: { stage: 'delivered', committed: false, pushed: false },
  }));
  fx.store.handleJobFinished(fx.jobs.get(started.job.id)!, { finalAttempt: true });
  const toReview = await fx.call('muse', execCtx, 'task_handoff', { to_module: 'review', request: 'review' });
  const reviewCtx: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'review', taskId, handoffId: toReview.handoff.id };
  await fx.call('aye', reviewCtx, 'task_accept', {});
  await fx.call('aye', reviewCtx, 'review_submit', {
    module: 'review', candidate_job_id: started.job.id, candidate_sha: H2,
    verdict: 'approve', findings: 'looks good, all green',
  });
  const toMerge = await fx.call('aye', reviewCtx, 'task_handoff', { to_module: 'merge', request: 'merge it' });
  const mergeCtx: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'merge', taskId, handoffId: toMerge.handoff.id };
  await fx.call('codex', mergeCtx, 'task_accept', {});
  const released = await fx.call('codex', mergeCtx, 'release_execute', {
    kind: 'merge', return_to_module: 'deploy', return_mode: 'notify',
    expected_revision: fx.store.getTask('room-a', 'tasks/closure.md')!.revision,
  });
  const mergeJob = fx.jobs.get(released.job.id)!;
  // Worker finished deterministically: raw stdout JSON becomes scriptReport.
  const scriptReport = {
    ok: true, lane: 'merge', branch: 'master', head: H2,
    tests: MERGE_SUITES,
  };
  const rawStdout = `log line\n${JSON.stringify(scriptReport)}\n`;
  const mergeDoneMeta = boundedDeliveryMeta({
    state: 'delivered',
    receipt: {
      branch: 'codex/w', head: H2,
      diffstat: '1 file changed, 1 insertion(+)',
      changedFiles: { files: ['a.ts'], total: 1 }, tests: MERGE_SUITES,
      scriptReport, scriptExitCode: 0,
    },
    declared: { stage: 'delivered_waiting_deploy', committed: true, pushed: true, nextOwner: 'harness-deploy' },
  });
  fx.finish(mergeJob.id, 'done', mergeDoneMeta, rawStdout);
  fx.store.handleJobFinished(fx.jobs.get(mergeJob.id)!, { finalAttempt: true });
  const toDeploy = await fx.call('codex', mergeCtx, 'task_handoff', { to_module: 'deploy', request: 'deploy it' });
  const deployCtx: RoomTaskToolContext = { roomId: 'room-a', moduleId: 'deploy', taskId, handoffId: toDeploy.handoff.id };
  await fx.call('codex', deployCtx, 'task_accept', {});

  // Missing proof: corrupt the merge receipt head BEFORE any deploy release
  // exists (no natural-key replay yet): the gate must itemize and hint
  // ls-remote. W0: once a deploy for this SHA is published, a repeat call
  // with any caller key replays it instead of re-running the gate.
  fx.db.prepare('UPDATE jobs SET delivery_meta = ? WHERE id = ?').run(
    boundedDeliveryMeta({
      state: 'delivered',
      receipt: {
        branch: 'codex/w', head: H2,
        diffstat: '1 file changed, 1 insertion(+)',
        changedFiles: { files: ['a.ts'], total: 1 }, tests: MERGE_SUITES,
        scriptReport: { ok: true, lane: 'merge', branch: 'master', head: SHA('d'), tests: MERGE_SUITES },
        scriptExitCode: 0,
      },
      declared: { stage: 'delivered_waiting_deploy', committed: true, pushed: true },
    }),
    mergeJob.id,
  );
  const bad = await fx.failCall('codex', deployCtx, 'release_execute', {
    kind: 'deploy', return_to_module: 'plan', return_mode: 'notify',
    expected_revision: fx.store.getTask('room-a', 'tasks/closure.md')!.revision,
    idempotency_key: `deploy-bad-${Date.now()}`,
  });
  assert.match(bad, /合并回执缺/);
  assert.match(bad, /git ls-remote origin refs\/heads\/master/);
  // Restore the good proof and publish the deploy for real.
  fx.db.prepare('UPDATE jobs SET delivery_meta = ? WHERE id = ?').run(mergeDoneMeta, mergeJob.id);
  const deployed = await fx.call('codex', deployCtx, 'release_execute', {
    kind: 'deploy', return_to_module: 'plan', return_mode: 'notify',
    expected_revision: fx.store.getTask('room-a', 'tasks/closure.md')!.revision,
  });
  const deployJob = fx.jobs.get(deployed.job.id)!;
  const deployOptions = JSON.parse(deployJob.options);
  assert.equal(deployOptions.closureCommand.kind, 'deploy');
  assert.equal(deployOptions.closureCommand.win.file, 'deploy/room-deploy-job.ps1');

  // W0 deploy replay: same SHA with a fresh caller key returns the published
  // deploy instead of draining + restarting the gateway a second time.
  const deployedAgain = await fx.call('codex', deployCtx, 'release_execute', {
    kind: 'deploy', return_to_module: 'plan', return_mode: 'notify',
    expected_revision: fx.store.getTask('room-a', 'tasks/closure.md')!.revision,
    idempotency_key: `deploy-again-${Date.now()}`,
  });
  assert.equal(deployedAgain.job.id, deployJob.id, 'deploy natural key replays across caller keys');
  assert.equal(deployedAgain.existing, true);
});
