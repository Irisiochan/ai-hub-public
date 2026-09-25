import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExecutionAttemptWorkspace,
  buildTaskWorkspace,
  checkProjectTargetClaim,
  classifyTargetWorkspace,
  enforceDispatchTarget,
  matchWorkspaceTarget,
  resolveProjectTarget,
} from '../src/jobs/projectTargets.js';

// G02: the mapping comes ONLY from config. There are no built-in targets:
// with no (or empty) config every lookup misses and PC flows pass through.
const TEST_TARGETS = {
  'ai-dashboard': {
    repoId: 'ai-dashboard',
    platform: 'linux' as const,
    workerId: 'vps-dev',
    workspace: '/srv/ai-dev/jobs',
    runners: ['codex', 'opencode'],
    ssh: false,
    shell: true,
  },
};

test('no config resolves nothing (no built-in worker/workspace defaults)', () => {
  assert.equal(resolveProjectTarget('ai-dashboard'), null);
  assert.equal(resolveProjectTarget('ai-dashboard', {}), null);
  assert.equal(resolveProjectTarget('ai-dashboard', { projectTargets: {} }), null);
  assert.equal(matchWorkspaceTarget('/srv/ai-dev/jobs/task-1'), null);
  assert.equal(matchWorkspaceTarget('/srv/ai-dev/jobs/task-1', {}), null);
  assert.equal(classifyTargetWorkspace('/srv/ai-dev/jobs/task-1'), null);
  assert.throws(() => buildTaskWorkspace('ai-dashboard', 'task-1'), /unknown repoId/);
  // Dispatch without config never freezes: PC passthrough, never a mismatch.
  const passthrough = enforceDispatchTarget({
    workspace: '/srv/ai-dev/jobs/task-1', workerId: null, runner: 'codex', ssh: false,
  });
  assert.equal(passthrough.ok, true);
  if (passthrough.ok) assert.equal(passthrough.projectTarget, null);
});

test('resolve reads worker/workspace/runners/ssh from config only', () => {
  const target = resolveProjectTarget('ai-dashboard', TEST_TARGETS);
  assert.equal(target?.platform, 'linux');
  assert.equal(target?.workerId, 'vps-dev');
  assert.equal(target?.workspace, '/srv/ai-dev/jobs');
  assert.deepEqual(target?.requiredCapabilities.runners, ['codex', 'opencode']);
  assert.equal(target?.requiredCapabilities.ssh, false);
  assert.equal(target?.baseSha, null);
  assert.equal(resolveProjectTarget('unknown-repo', TEST_TARGETS), null);
  assert.equal(resolveProjectTarget('', TEST_TARGETS), null);
});

test('invalid config entries are dropped, never defaulted', () => {
  const bad = {
    'no-runners': {
      repoId: 'no-runners', platform: 'linux', workerId: 'vps-dev',
      workspace: '/srv/ai-dev/jobs', runners: [], ssh: false,
    },
    'no-worker': {
      repoId: 'no-worker', platform: 'linux', workerId: '',
      workspace: '/srv/ai-dev/jobs', runners: ['codex'], ssh: false,
    },
  };
  assert.equal(resolveProjectTarget('no-runners', bad), null);
  assert.equal(resolveProjectTarget('no-worker', bad), null);
});

test('match resolves mapped workspaces and never PC paths or URLs', () => {
  assert.equal(matchWorkspaceTarget('/srv/ai-dev/jobs', TEST_TARGETS)?.repoId, 'ai-dashboard');
  assert.equal(
    matchWorkspaceTarget('/srv/ai-dev/jobs/task-1/attempt-2/ai-dashboard', TEST_TARGETS)?.workerId,
    'vps-dev',
  );
  assert.equal(matchWorkspaceTarget('C:/work/ai-dashboard', TEST_TARGETS), null);
  assert.equal(matchWorkspaceTarget('https://github.com/x/y.git', TEST_TARGETS), null);
  assert.equal(matchWorkspaceTarget('/srv', TEST_TARGETS), null);
  assert.equal(matchWorkspaceTarget('/srv/ai-dev/other', TEST_TARGETS), null);
});

test('nested roots resolve to the deepest one regardless of config order', () => {
  // 2026-09-23: ai-dashboard declared first at /srv/ai-dev/jobs swallowed every
  // ai-hub slug; deepest root wins either way round.
  const hub = { ...TEST_TARGETS['ai-dashboard'], repoId: 'ai-hub' };
  const dash = TEST_TARGETS['ai-dashboard'];
  for (const targets of [
    { 'ai-dashboard': { ...dash, workspace: '/srv/ai-dev/jobs/ai-dashboard' }, 'ai-hub': hub },
    { 'ai-hub': hub, 'ai-dashboard': { ...dash, workspace: '/srv/ai-dev/jobs/ai-dashboard' } },
  ]) {
    assert.equal(matchWorkspaceTarget('/srv/ai-dev/jobs/ai-hub-capability-card', targets)?.repoId, 'ai-hub');
    assert.equal(matchWorkspaceTarget('/srv/ai-dev/jobs/ai-dashboard/task-1', targets)?.repoId, 'ai-dashboard');
    assert.equal(matchWorkspaceTarget('/srv/ai-dev/jobs/ai-dashboard', targets)?.repoId, 'ai-dashboard');
    assert.equal(matchWorkspaceTarget('/srv/ai-dev/jobs/ai-dashboard-x', targets)?.repoId, 'ai-hub');
  }
});

test('enforceDispatchTarget freezes worker/runner/ssh per attempt', () => {
  const frozen = enforceDispatchTarget({
    workspace: '/srv/ai-dev/jobs/task-1/attempt-1/ai-dashboard',
    workerId: 'vps-dev', runner: 'codex', ssh: false,
  }, TEST_TARGETS);
  assert.equal(frozen.ok, true);
  if (frozen.ok) assert.equal(frozen.projectTarget?.repoId, 'ai-dashboard');

  const unpinned = enforceDispatchTarget({
    workspace: '/srv/ai-dev/jobs', workerId: null, runner: 'codex', ssh: false,
  }, TEST_TARGETS);
  assert.equal(unpinned.ok, false);
  if (!unpinned.ok) assert.match(unpinned.error, /vps-dev/);

  const wrongRunner = enforceDispatchTarget({
    workspace: '/srv/ai-dev/jobs', workerId: 'vps-dev', runner: 'claude', ssh: false,
  }, TEST_TARGETS);
  assert.equal(wrongRunner.ok, false);

  const sshAsk = enforceDispatchTarget({
    workspace: '/srv/ai-dev/jobs', workerId: 'vps-dev', runner: 'opencode', ssh: true,
  }, TEST_TARGETS);
  assert.equal(sshAsk.ok, false);
  if (!sshAsk.ok) assert.match(sshAsk.error, /deploy-tail/);

  const pcFlow = enforceDispatchTarget({
    workspace: 'C:/path/to/project', workerId: null, runner: 'codex', ssh: false,
  }, TEST_TARGETS);
  assert.equal(pcFlow.ok, true);
  if (pcFlow.ok) assert.equal(pcFlow.projectTarget, null);
});

test('checkProjectTargetClaim isolates frozen attempts to the mapped worker', () => {
  const frozen = JSON.stringify({
    projectTarget: {
      repoId: 'ai-dashboard', platform: 'linux', workerId: 'vps-dev',
      workspace: '/srv/ai-dev/jobs/task-1/attempt-1/ai-dashboard',
      requiredCapabilities: { runners: ['codex', 'opencode'], shell: true, ssh: false },
      baseSha: null,
    },
  });
  assert.equal(
    checkProjectTargetClaim({ options: frozen, workerId: 'vps-dev', runner: 'codex', ssh: false }).ok,
    true,
  );
  const pcClaim = checkProjectTargetClaim({ options: frozen, workerId: 'pc-User', runner: 'codex', ssh: false });
  assert.equal(pcClaim.ok, false);
  if (!pcClaim.ok) assert.match(pcClaim.reason, /vps-dev/);

  const wrongRunner = checkProjectTargetClaim({ options: frozen, workerId: 'vps-dev', runner: 'claude', ssh: false });
  assert.equal(wrongRunner.ok, false);

  const sshClaim = checkProjectTargetClaim({ options: frozen, workerId: 'vps-dev', runner: 'opencode', ssh: true });
  assert.equal(sshClaim.ok, false);

  const missingPin = checkProjectTargetClaim({
    options: JSON.stringify({ projectTarget: { repoId: 'ai-dashboard' } }),
    workerId: 'vps-dev', runner: 'codex', ssh: false,
  });
  assert.equal(missingPin.ok, false);
});

test('checkProjectTargetClaim leaves non-target jobs untouched', () => {
  assert.equal(checkProjectTargetClaim({ options: '{}', workerId: 'pc-User', runner: 'codex', ssh: false }).ok, true);
  assert.equal(checkProjectTargetClaim({ options: null, workerId: 'pc-User', runner: 'codex', ssh: false }).ok, true);
  assert.equal(checkProjectTargetClaim({ options: 'not-json', workerId: 'pc-User', runner: 'codex', ssh: false }).ok, true);
  assert.equal(
    checkProjectTargetClaim({ options: { projectTarget: null }, workerId: 'pc-User', runner: 'codex', ssh: false }).ok,
    true,
  );
});

test('fence: task workspace is <root>/<taskSlug>, attempts derive <task>/<attempt>/<repo>', () => {
  assert.equal(buildTaskWorkspace('ai-dashboard', 'task-1', TEST_TARGETS), '/srv/ai-dev/jobs/task-1');
  assert.throws(() => buildTaskWorkspace('ai-dashboard', 'bad slug', TEST_TARGETS), /task slug/);
  assert.throws(() => buildTaskWorkspace('ai-dashboard', 'review-abcdef1234', TEST_TARGETS), /reserved/);
  assert.throws(() => buildTaskWorkspace('nope', 'task-1', TEST_TARGETS), /unknown repoId/);

  const execDir = buildExecutionAttemptWorkspace(
    '/srv/ai-dev/jobs/task-1', 'attempt-2', 'ai-dashboard', TEST_TARGETS,
  );
  assert.equal(execDir, '/srv/ai-dev/jobs/task-1/attempt-2/ai-dashboard');
  const segs = execDir.slice('/srv/ai-dev/jobs/'.length).split('/');
  assert.equal(segs.length, 3);
  assert.deepEqual([segs[0], segs[2]], ['task-1', 'ai-dashboard']);

  // The mapped root itself is never an attempt parent; nested attempts never nest further.
  assert.throws(
    () => buildExecutionAttemptWorkspace('/srv/ai-dev/jobs', 'attempt-2', 'ai-dashboard', TEST_TARGETS),
    /task workspace/,
  );
  assert.throws(
    () => buildExecutionAttemptWorkspace(
      '/srv/ai-dev/jobs/task-1/attempt-2/ai-dashboard', 'attempt-3', 'ai-dashboard', TEST_TARGETS,
    ),
    /task workspace/,
  );
  assert.throws(
    () => buildExecutionAttemptWorkspace('/srv/ai-dev/jobs/task-1', 'review-abcdef1234', 'ai-dashboard', TEST_TARGETS),
    /reserved/,
  );
  assert.throws(
    () => buildExecutionAttemptWorkspace('/srv/ai-dev/jobs/task-1', 'attempt-2', 'nope', TEST_TARGETS),
    /unknown repoId/,
  );
});

test('classify rejects dot segments, over-depth, and non-slug names', () => {
  assert.equal(classifyTargetWorkspace('/srv/ai-dev/jobs/task-1/../x', TEST_TARGETS), null);
  assert.equal(classifyTargetWorkspace('/srv/ai-dev/jobs/task 1', TEST_TARGETS), null);
  const deep = `/srv/ai-dev/jobs/${Array.from({ length: 7 }, (_, i) => `s${i}`).join('/')}`;
  assert.equal(classifyTargetWorkspace(deep, TEST_TARGETS), null);
  const fenced = classifyTargetWorkspace('/srv/ai-dev/jobs/task-1', TEST_TARGETS);
  assert.equal(fenced?.depth, 1);
  assert.deepEqual(fenced?.segments, ['task-1']);
});
