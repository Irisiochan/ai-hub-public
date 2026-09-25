import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildRunnerSpec,
  defaultRunnerCommand,
  killRunnerTree,
  spawnOptionsForRunner,
} from './runner/runner.mjs';
import { resolveWorkspaceTarget } from './runner/workspace-path.mjs';

const baseJob = {
  id: 'job-vps-1',
  workspace: '/srv/ai-dev/jobs/ai-dashboard',
  prompt: 'do the work',
  deliveryContract: 'SERVER DELIVERY CONTRACT',
  permissions: { write: true, shell: true, ssh: false },
  options: {},
};

test('Linux defaults drop .cmd and spawn detached without a shell', () => {
  assert.equal(defaultRunnerCommand('codex', 'linux'), 'codex');
  assert.equal(defaultRunnerCommand('claude', 'linux'), 'claude');
  assert.equal(defaultRunnerCommand('opencode', 'linux'), 'opencode');
  assert.equal(defaultRunnerCommand('codex', 'win32'), 'codex.cmd');
  const opts = spawnOptionsForRunner('linux');
  assert.deepEqual(opts, { shell: false, windowsHide: false, detached: true });
  assert.deepEqual(spawnOptionsForRunner('win32'), { shell: true, windowsHide: true, detached: false });
});

test('Linux runner specs use bare commands and keep the workspace', () => {
  for (const runner of ['codex', 'opencode', 'claude']) {
    const spec = buildRunnerSpec({ ...baseJob, runner }, {}, { platform: 'linux' });
    assert.ok(!String(spec.command).endsWith('.cmd'), `${runner} must not use .cmd on linux`);
  }
  const spec = buildRunnerSpec({ ...baseJob, runner: 'opencode' }, {}, { platform: 'linux' });
  assert.equal(spec.args[spec.args.indexOf('--dir') + 1], '/srv/ai-dev/jobs/ai-dashboard');
});

test('killRunnerTree prefers the process group on POSIX', () => {
  const calls = [];
  const realKill = process.kill;
  process.kill = ((pid, signal) => { calls.push([pid, signal]); });
  try {
    const mode = killRunnerTree({ pid: 12345, kill: () => { throw new Error('must not direct-kill first'); } }, 'linux');
    assert.equal(mode, 'group-sigterm');
    assert.deepEqual(calls, [[-12345, 'SIGTERM']]);
    assert.equal(killRunnerTree({ pid: null }, 'linux'), 'no-pid');
  } finally {
    process.kill = realKill;
  }
});

test('killRunnerTree escalates to group SIGKILL on POSIX when asked', () => {
  const calls = [];
  const realKill = process.kill;
  process.kill = ((pid, signal) => { calls.push([pid, signal]); });
  try {
    const mode = killRunnerTree({ pid: 12345, kill: () => { throw new Error('must not direct-kill first'); } }, 'linux', 'SIGKILL');
    assert.equal(mode, 'group-sigkill');
    assert.deepEqual(calls, [[-12345, 'SIGKILL']]);
  } finally {
    process.kill = realKill;
  }
});

test('killRunnerTree signal matrix: win32 goes direct, unknown signals fold to SIGTERM', () => {
  const realKill = process.kill;
  try {
    // win32 SIGTERM: direct child kill, no process-group signalling.
    {
      const groupCalls = [];
      const directCalls = [];
      process.kill = ((pid, signal) => { groupCalls.push([pid, signal]); });
      const mode = killRunnerTree({ pid: 4242, kill: (sig) => { directCalls.push(sig); } }, 'win32');
      assert.equal(mode, 'direct-sigterm');
      assert.deepEqual(groupCalls, []);
      assert.deepEqual(directCalls, ['SIGTERM']);
    }
    // win32 SIGKILL: direct child kill with SIGKILL.
    {
      const directCalls = [];
      process.kill = (() => { throw new Error('win32 must not group-kill'); });
      const mode = killRunnerTree({ pid: 4242, kill: (sig) => { directCalls.push(sig); } }, 'win32', 'SIGKILL');
      assert.equal(mode, 'direct-sigkill');
      assert.deepEqual(directCalls, ['SIGKILL']);
    }
    // Unknown/garbage signal folds to SIGTERM (never an unhandled kill).
    {
      const calls = [];
      process.kill = ((pid, signal) => { calls.push([pid, signal]); });
      const mode = killRunnerTree({ pid: 9999, kill: () => {} }, 'linux', 'SIGSTOP');
      assert.equal(mode, 'group-sigterm');
      assert.deepEqual(calls, [[-9999, 'SIGTERM']]);
    }
  } finally {
    process.kill = realKill;
  }
});

test('killRunnerTree falls back to a direct kill when the process group is gone', () => {
  const realKill = process.kill;
  const directCalls = [];
  // ESRCH: the group leader already exited; the tree kill must still reach
  // the direct child handle instead of silently succeeding.
  process.kill = (() => { const error = new Error('no such process'); error.code = 'ESRCH'; throw error; });
  try {
    const mode = killRunnerTree({ pid: 7777, kill: (sig) => { directCalls.push(sig); } }, 'linux');
    assert.equal(mode, 'direct-sigterm-fallback');
    assert.deepEqual(directCalls, ['SIGTERM']);
  } finally {
    process.kill = realKill;
  }
});

test('per-claim realpath gate refuses junction-style escapes before any runner is built', () => {
  // A Windows junction (or POSIX symlink) inside the allowlist that resolves
  // outside it takes the exact same code path: realpath(target) escapes
  // realpath(root). The injected realpath stands in for filesystem I/O only;
  // the containment verdict comes from the real resolveWorkspaceTarget.
  const outsideReal = 'E:\\outside';
  const fakeRealpath = (p) => {
    if (p === 'C:/path/to/project') return 'C:\\path\\to\\project';
    if (p === 'C:/path/to/project/junction-task') return outsideReal;
    throw new Error(`unexpected realpath input: ${p}`);
  };
  assert.throws(
    () => resolveWorkspaceTarget('C:/path/to/project', 'C:/path/to/project/junction-task', { realpath: fakeRealpath }),
    /realpath escapes/,
  );
  const symlinkRealpath = (p) => {
    if (p === '/srv/ai-dev/jobs') return '/srv/ai-dev/jobs';
    if (p === '/srv/ai-dev/jobs/link-task') return '/srv/elsewhere';
    throw new Error(`unexpected realpath input: ${p}`);
  };
  assert.throws(
    () => resolveWorkspaceTarget('/srv/ai-dev/jobs', '/srv/ai-dev/jobs/link-task', { realpath: symlinkRealpath }),
    /realpath escapes/,
  );
  // Fail closed: a missing path (ENOENT from realpath) must refuse the claim,
  // never let execute() proceed to buildRunnerSpec/spawn.
  const enoent = () => { const error = new Error('no such file'); error.code = 'ENOENT'; throw error; };
  assert.throws(
    () => resolveWorkspaceTarget('/srv/ai-dev/jobs', '/srv/ai-dev/jobs/gone', { realpath: enoent }),
    /no such file/,
  );
  // Cross-platform root/target pairs are refused before any I/O at all.
  let ioCount = 0;
  const counting = (p) => { ioCount += 1; return p; };
  assert.throws(
    () => resolveWorkspaceTarget('C:/path/to/project', '/srv/ai-dev/jobs/task-1', { realpath: counting }),
    /outside allowlist/,
  );
  assert.equal(ioCount, 0);
});

test('cancel/timeout/shutdown all route through killRunnerTree, never a bare child.kill', () => {
  // worker.mjs has module-level side effects (config load + worker boot), so
  // this pins the real call chain statically: every runner-tree kill site
  // must go through the group-aware choke point, and the per-claim realpath
  // gate must sit before any runner creation.
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
  const source = fs.readFileSync(workerPath, 'utf8');
  assert.match(source, /import \{[^}]*buildRunnerSpec,[^}]*killRunnerTree,[^}]*supportsResume[^}]*\} from '\.\/runner\/runner\.mjs'/);
  assert.match(source, /resolveWorkspaceTarget\(workspace\.path, job\.workspace\)/);
  // No bare child.kill survived G01: heartbeat cancel, gate cancel, stall
  // timeout escalation and shutdown handlers all use killRunnerTree.
  assert.equal((source.match(/child\.kill\(/g) ?? []).length, 0);
  const killSites = (source.match(/killRunnerTree\(child[^)]*\)/g) ?? []).length;
  assert.ok(killSites >= 6, `expected >=6 killRunnerTree(child…) sites, found ${killSites}`);
  // SIGKILL escalation after the SIGTERM grace window.
  assert.match(source, /killRunnerTree\(child, process\.platform, 'SIGKILL'\)/);
  // Ordering: the realpath gate in execute() precedes every runner launch.
  // execute() gates first, then reaches runRunnerOnce; inside runRunnerOnce
  // the spec is built before the child is spawned. Textual order pins the
  // intra-function half; the gate-to-launch half is pinned via the call sites.
  const gateAt = source.indexOf('resolveWorkspaceTarget(workspace.path, job.workspace)');
  const firstLaunchAfterGate = source.indexOf('await runRunnerOnce({', gateAt);
  const specAt = source.indexOf('const spec = buildRunnerSpec(job, cfg)');
  const spawnAt = source.indexOf('const child = spawn(spec.command');
  assert.ok(gateAt !== -1 && firstLaunchAfterGate !== -1 && specAt !== -1 && spawnAt !== -1);
  assert.ok(gateAt < firstLaunchAfterGate, 'realpath gate must precede the runner launch');
  assert.ok(specAt < spawnAt, 'runner spec must be built before the child is spawned');
});
