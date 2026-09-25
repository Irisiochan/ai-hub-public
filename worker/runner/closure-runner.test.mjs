import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CLOSURE_OUTPUT_MAX,
  closureNotStartedFailure,
  closureResumeFailure,
  deriveClosureDelivery,
  extractLastJsonReport,
  formatClosureResult,
  isClosureJob,
  resolveClosureScript,
  runClosureScript,
  selectClosureTarget,
  truncateClosureOutput,
} from './closure-runner.mjs';

const MERGE_REPORT = (head) => ({
  ok: true,
  lane: 'merge',
  branch: 'master',
  head,
  tests: [
    { suite: 'server npm run pretest', status: 'pass' },
    { suite: 'server npm test', status: 'pass' },
  ],
});

test('closure result uses the fixed raw-receipt format', () => {
  const text = formatClosureResult({
    kind: 'merge',
    file: 'deploy/merge-close-job.ps1',
    args: ['-FrozenSha', 'a'.repeat(40), '-ReleaseEvidence', '{"roomId":"r"}'],
    exitCode: 0,
    durationMs: 123,
    stdout: '{"ok":true}',
    stderr: '',
  });
  assert.match(text, /【closure merge raw receipt】exit=0 durationMs=123/);
  assert.match(text, /command: deploy\/merge-close-job\.ps1/);
  assert.match(text, /-ReleaseEvidence/);
  assert.match(text, /--- stdout ---/);
  assert.match(text, /--- stderr ---/);
  assert.match(text, /"ok":true/);
});

test('merge success derives delivered_waiting_deploy', () => {
  const head = 'b'.repeat(40);
  const report = MERGE_REPORT(head);
  const stdout = `some log\n${JSON.stringify(report)}\n`;
  const found = extractLastJsonReport(stdout);
  assert.deepEqual(found, report);
  const derived = deriveClosureDelivery({ kind: 'merge', exitCode: 0, scriptReport: found });
  assert.equal(derived.jobStatus, 'done');
  assert.equal(derived.delivery.state, 'delivered');
  assert.equal(derived.delivery.declared.stage, 'delivered_waiting_deploy');
  assert.equal(derived.delivery.declared.committed, true);
  assert.equal(derived.delivery.declared.pushed, true);
  assert.equal(derived.delivery.declared.nextOwner, 'harness-deploy');
  assert.equal(derived.delivery.receipt.scriptReport.head, head);
  assert.equal(derived.delivery.receipt.scriptExitCode, 0);
});

test('deploy success derives closed_loop', () => {
  const report = { ok: true, mode: 'deploy', result: 'deployed', targetSha: 'c'.repeat(40) };
  const derived = deriveClosureDelivery({ kind: 'deploy', exitCode: 0, scriptReport: report });
  assert.equal(derived.jobStatus, 'done');
  assert.equal(derived.delivery.state, 'delivered');
  assert.equal(derived.delivery.declared.stage, 'closed_loop');
});

test('non-zero exit or missing JSON never declares delivered', () => {
  const head = 'b'.repeat(40);
  const okReport = MERGE_REPORT(head);
  const failedExit = deriveClosureDelivery({ kind: 'merge', exitCode: 1, scriptReport: okReport });
  assert.equal(failedExit.jobStatus, 'failed');
  assert.notEqual(failedExit.delivery.state, 'delivered');
  const noJson = deriveClosureDelivery({ kind: 'merge', exitCode: 0, scriptReport: null });
  assert.equal(noJson.jobStatus, 'failed');
  assert.notEqual(noJson.delivery.state, 'delivered');
  const badReport = deriveClosureDelivery({ kind: 'merge', exitCode: 0, scriptReport: { ok: false, lane: 'merge' } });
  assert.equal(badReport.jobStatus, 'failed');
});

test('oversized stdout is kept head/tail with a truncation mark', () => {
  const big = `x`.repeat(CLOSURE_OUTPUT_MAX + 10_000);
  const { text, truncated } = truncateClosureOutput(big);
  assert.equal(truncated, true);
  assert.ok(text.length < big.length);
  assert.match(text, /截断/);
  const formatted = formatClosureResult({
    kind: 'merge', file: 'deploy/merge-close-job.ps1', args: [],
    exitCode: 0, durationMs: 1, stdout: big, stderr: big,
  });
  assert.match(formatted, /截断/);
});

test('closure target selects win/posix without string拼接', () => {
  const cmd = {
    kind: 'merge',
    win: { file: 'deploy/merge-close-job.ps1', args: ['-FrozenSha', 'a'] },
    posix: { file: 'deploy/merge-close-job.mjs', args: ['--frozen-sha', 'a'] },
    timeoutMs: 1000,
  };
  assert.deepEqual(selectClosureTarget(cmd, 'win32'), cmd.win);
  assert.deepEqual(selectClosureTarget(cmd, 'linux'), cmd.posix);
  assert.equal(isClosureJob({ options: { closureCommand: cmd, dispatchSource: 'explicit-release' } }), true);
  assert.equal(isClosureJob({ options: { closureCommand: cmd, dispatchSource: 'harness-auto' } }), false);
  assert.equal(isClosureJob({ options: {} }), false);
});

test('runClosureScript captures a fake script JSON and exit code', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-runner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fake.mjs');
  const head = 'd'.repeat(40);
  fs.writeFileSync(script, `console.log(JSON.stringify(${JSON.stringify(MERGE_REPORT(head))}));\nprocess.exit(0);\n`);
  const out = await runClosureScript({
    file: script,
    args: [],
    cwd: dir,
    env: {},
    timeoutMs: 15_000,
    nodeForTest: process.execPath,
  });
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /"lane":"merge"/);
  const report = extractLastJsonReport(out.stdout);
  assert.equal(report?.head, head);
  const failScript = path.join(dir, 'fail.mjs');
  fs.writeFileSync(failScript, `console.error('boom');\nprocess.exit(3);\n`);
  const failed = await runClosureScript({
    file: failScript, args: [], cwd: dir, env: {}, timeoutMs: 15_000, nodeForTest: process.execPath,
  });
  assert.equal(failed.exitCode, 3);
  assert.match(failed.stderr, /boom/);
});

test('closure scripts resolve from the worker release, never from the job workspace', () => {
  const release = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-release-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-workspace-'));
  try {
    fs.mkdirSync(path.join(release, 'deploy'));
    fs.writeFileSync(path.join(release, 'deploy', 'merge-close-job.mjs'), '// released gate\n');
    // The repo under test has its own (possibly edited) copy; it must be ignored.
    fs.mkdirSync(path.join(workspace, 'deploy'));
    fs.writeFileSync(path.join(workspace, 'deploy', 'merge-close-job.mjs'), '// candidate gate\n');

    const ok = resolveClosureScript('deploy/merge-close-job.mjs', release);
    assert.equal(ok.ok, true);
    assert.equal(ok.path, path.join(release, 'deploy', 'merge-close-job.mjs'));
    assert.match(fs.readFileSync(ok.path, 'utf8'), /released gate/);
    // Windows separators in a stamped path still land in the same place.
    assert.equal(resolveClosureScript('deploy\\merge-close-job.mjs', release).path, ok.path);

    // Missing from the release = fail closed with the reason, no fallback to cwd.
    const missing = resolveClosureScript('deploy/room-deploy-job.mjs', release);
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /not found in worker release/);
    assert.equal(resolveClosureScript('deploy/merge-close-job.mjs', '').ok, false, 'no release root, no resolution');
  } finally {
    fs.rmSync(release, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('closure script path is an allowlisted shape, not a sanitised string', () => {
  const exists = () => true;
  for (const bad of [
    '../deploy/merge-close-job.mjs',
    'deploy/../worker/worker.mjs',
    'deploy/sub/merge-close-job.mjs',
    '/etc/passwd',
    'C:/Windows/system32/cmd.exe',
    'worker/worker.mjs',
    'deploy/merge-close-job.sh',
    'deploy/.hidden.mjs',
    '',
    null,
  ]) {
    const r = resolveClosureScript(bad, '/release', { exists });
    assert.equal(r.ok, false, `must refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(resolveClosureScript('deploy/merge-close-job.ps1', '/release', { exists }).ok, true);
});

test('not-started closure failure keeps the raw receipt shape, resume refusal reuses it', () => {
  const refused = closureNotStartedFailure('merge', 'closure script deploy/x.mjs not found in worker release /r');
  assert.equal(refused.status, 'failed');
  assert.equal(refused.delivery.state, 'failed_clean');
  assert.equal(refused.delivery.declared.stage, 'delivered_waiting_deploy');
  assert.equal(refused.delivery.receipt.scriptExitCode, 1);
  assert.match(refused.result, /command: \(not started\)/);
  assert.match(refused.result, /not found in worker release/);
  assert.equal(closureNotStartedFailure('deploy', 'x').delivery.declared.stage, 'closed_loop');
  const resumed = closureResumeFailure('merge');
  assert.equal(resumed.error, 'closure job 不支持续跑，请 task_retry');
  assert.match(resumed.result, /command: \(not started\)/);
});
