import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MERGE_VALIDATION_SUITES,
  StaleCandidateError,
  dashboardValidationSuites,
  mergeFailureReport,
  mergeValidationSuitesForRepo,
  parseReleaseEvidence,
  runMergeCloseJob,
  validateMergeArgs,
  verifyReleaseEvidence,
} from './merge-close-job.mjs';
import {
  DEFAULT_ENV_FILE,
  DEFAULT_HUB_URL,
  DEPLOY_SUPPORTED_REPO,
  findDeployFailEvidence,
  findDeployOkEvidence,
  loadEnvFileValues,
  parseEnvFileText,
  resolveBaseUrl,
  resolveDeployTokens,
  runRoomDeployJob,
  shaMatches,
  validateDeployArgs,
  waitDeployIdle,
  waitForDeployResult,
} from './room-deploy-job.mjs';

const ROOM = 'room-abc';
const TASK = 'tasks/ai-hub-vps-migration-restructure.md';

function evidenceFor(candidateSha, overrides = {}) {
  return JSON.stringify({
    roomId: ROOM,
    taskPath: TASK,
    candidateSha,
    reviewStatus: 'approved',
    reviewEvidenceId: 182,
    ...overrides,
  });
}

function mergeArgs(overrides = {}) {
  return validateMergeArgs({
    frozenSha: 'a'.repeat(40),
    baselineSha: 'b'.repeat(40),
    workingBranch: 'vps-migration-v2',
    releaseEvidence: evidenceFor('a'.repeat(40)),
    ...overrides,
  });
}

test('merge arg validation mirrors the ps1 gates', () => {
  const args = validateMergeArgs({
    frozenSha: 'A'.repeat(40),
    baselineSha: 'b'.repeat(40),
    workingBranch: 'codex/vps-development-migration',
    releaseEvidence: evidenceFor('a'.repeat(40)),
  });
  assert.equal(args.frozenSha, 'a'.repeat(40));
  assert.equal(args.remote, 'origin');
  assert.equal(args.targetBranch, 'master');
  assert.equal(args.repoId, 'ai-hub');
  assert.equal(validateMergeArgs({
    frozenSha: 'a'.repeat(40),
    baselineSha: 'b'.repeat(40),
    workingBranch: 'x',
    repoId: 'ai-hub',
    releaseEvidence: evidenceFor('a'.repeat(40)),
  }).repoId, 'ai-hub');
  assert.throws(() => validateMergeArgs({ frozenSha: 'a'.repeat(40), baselineSha: 'b'.repeat(40), workingBranch: 'x', repoId: '../evil', releaseEvidence: evidenceFor('a'.repeat(40)) }), /repoId/);
  assert.throws(() => validateMergeArgs({ frozenSha: 'abc', baselineSha: 'b'.repeat(40), workingBranch: 'x', releaseEvidence: evidenceFor('abc') }), /frozenSha/);
  assert.throws(() => validateMergeArgs({ frozenSha: 'a'.repeat(40), baselineSha: 'b'.repeat(40), workingBranch: '../evil', releaseEvidence: evidenceFor('a'.repeat(40)) }), /workingBranch/);
});

test('per-repo validation suites default to ai-hub and refuse unknown repos', () => {
  assert.equal(mergeValidationSuitesForRepo(undefined), MERGE_VALIDATION_SUITES);
  assert.equal(mergeValidationSuitesForRepo('ai-hub'), MERGE_VALIDATION_SUITES);
  assert.throws(() => mergeValidationSuitesForRepo('unknown-repo'), /no validation suites configured/);
});

test('ai-dashboard suites require --repo-dir and thread it into --prefix', () => {
  assert.throws(() => mergeValidationSuitesForRepo('ai-dashboard'), /repoDir/);
  assert.throws(() => dashboardValidationSuites(undefined), /repoDir/);
  const suites = mergeValidationSuitesForRepo('ai-dashboard', '/srv/ai-dev/workspaces/x');
  assert.equal(suites.length, 4);
  const commands = suites.map((s) => s.args.join(' '));
  assert.match(commands[0], /^ci --prefix \/srv\/ai-dev\/workspaces\/x$/);
  assert.match(commands[1], /^run typecheck --prefix \/srv\/ai-dev\/workspaces\/x$/);
  assert.match(commands[2], /^test --prefix \/srv\/ai-dev\/workspaces\/x$/);
  assert.match(commands[3], /^run smoke --prefix \/srv\/ai-dev\/workspaces\/x$/);
  for (const suite of suites) {
    assert.equal(suite.command, 'npm');
    assert.ok(suite.args.includes('/srv/ai-dev/workspaces/x'));
  }
  // Different repo dirs produce different prefixes: no hardcoded path.
  const other = mergeValidationSuitesForRepo('ai-dashboard', '/srv/ai-dev/workspaces/y');
  assert.ok(!other[0].args.includes('/srv/ai-dev/workspaces/x'));
  assert.ok(other[0].args.includes('/srv/ai-dev/workspaces/y'));
});

test('ai-dashboard requires repoDir at arg validation time', () => {
  assert.throws(() => validateMergeArgs({
    frozenSha: 'a'.repeat(40),
    baselineSha: 'b'.repeat(40),
    workingBranch: 'x',
    repoId: 'ai-dashboard',
    releaseEvidence: evidenceFor('a'.repeat(40)),
  }), /repoDir/);
  const args = validateMergeArgs({
    frozenSha: 'a'.repeat(40),
    baselineSha: 'b'.repeat(40),
    workingBranch: 'x',
    repoId: 'ai-dashboard',
    repoDir: '/srv/ai-dev/workspaces/x',
    releaseEvidence: evidenceFor('a'.repeat(40)),
  });
  assert.equal(args.repoDir, '/srv/ai-dev/workspaces/x');
});

test('deploy arg validation and sha matching mirror the ps1', () => {
  const args = validateDeployArgs({ sha: 'ABC1234' });
  assert.equal(args.sha, 'abc1234');
  assert.throws(() => validateDeployArgs({ sha: 'zzz' }), /sha must be/);
  assert.equal(shaMatches('abcdef123456', 'abcdef1'), true);
  assert.equal(shaMatches('abcdef1', 'abcdef123456'), true);
  assert.equal(shaMatches('abcdef1', '1234567'), false);
});

test('room-deploy-job only serves ai-hub self-deploy', () => {
  assert.equal(DEPLOY_SUPPORTED_REPO, 'ai-hub');
  assert.equal(validateDeployArgs({ sha: 'abc1234' }).repo, 'ai-hub');
  assert.equal(validateDeployArgs({ sha: 'abc1234', repo: 'ai-hub' }).repo, 'ai-hub');
  assert.throws(() => validateDeployArgs({ sha: 'abc1234', repo: 'ai-dashboard' }), /only serves ai-hub/);
  assert.throws(() => validateDeployArgs({ sha: 'abc1234', repo: 'other' }), /only serves ai-hub/);
});

test('deploy defaults: env file path and VPS-local hub URL', () => {
  assert.equal(DEFAULT_ENV_FILE, '/etc/ai-dev-worker/deploy.env');
  assert.equal(DEFAULT_HUB_URL, 'http://127.0.0.1:3900');
  assert.equal(validateDeployArgs({ sha: 'abc1234' }).envFile, '/etc/ai-dev-worker/deploy.env');
  assert.equal(resolveBaseUrl({}), 'http://127.0.0.1:3900');
  assert.equal(resolveBaseUrl({ AI_HUB_URL: 'http://example:3900/' }), 'http://example:3900');
});

test('deploy credentials resolve from env with --env-file fallback', () => {
  assert.deepEqual(parseEnvFileText('# comment\n\nAI_HUB_TOKEN=abc\nAI_HUB_DEPLOY_TOKEN="def"\nINVALID-LINE\n'), {
    AI_HUB_TOKEN: 'abc',
    AI_HUB_DEPLOY_TOKEN: 'def',
  });
  const fromFile = resolveDeployTokens({ envFile: '/x', env: {}, fileValues: { AI_HUB_TOKEN: 'f1', AI_HUB_DEPLOY_TOKEN: 'f2' } });
  assert.equal(fromFile.hubToken, 'f1');
  assert.equal(fromFile.deployToken, 'f2');
  const envWins = resolveDeployTokens({ envFile: '/x', env: { AI_HUB_TOKEN: 'e1', AI_HUB_DEPLOY_TOKEN: 'e2' }, fileValues: { AI_HUB_TOKEN: 'f1', AI_HUB_DEPLOY_TOKEN: 'f2' } });
  assert.equal(envWins.hubToken, 'e1');
  assert.equal(envWins.deployToken, 'e2');
  const missingFile = loadEnvFileValues('/nonexistent-path-for-test', {
    exists: () => false,
    readFile: () => { throw new Error('must not read'); },
  });
  assert.deepEqual(missingFile, {});
});

test('deploy-ok evidence uses the last marker line', () => {
  const tail = 'noise\n== deploy ok abc1234 extra ==\nmore\n== deploy ok def5678 ==\n';
  const evidence = findDeployOkEvidence(tail);
  assert.equal(evidence?.sha, 'def5678');
  assert.equal(findDeployOkEvidence('no markers here'), null);
});

test('waitForDeployResult rides out the post-trigger start gap to the target receipt', async () => {
  // 2026-09-24 incident (job c59934ed): the first status poll ~394ms after
  // POST still showed running=false with the previous round's
  // `== deploy ok 7027cdd ==`; the old checker returned at once and failed
  // on the stale receipt while the real deploy wrote its own ok ~26s later.
  const oldTail = '== deploy ok 7027cdd 2026-09-24T08:00:00Z ==';
  const target = 'eef9144';
  const startTail = `${oldTail}\n== deploy start 2026-09-24T08:58:00Z ==`;
  const doneTail = `${startTail}\n== deploy ok ${target} 2026-09-24T08:58:22Z ==`;
  const snapshots = [
    { running: false, tail: oldTail },
    { running: true, tail: startTail },
    { running: false, tail: doneTail },
  ];
  let calls = 0;
  const fetchImpl = async () => {
    const snapshot = snapshots[Math.min(calls, snapshots.length - 1)];
    calls += 1;
    return { ok: true, json: async () => ({ ...snapshot }) };
  };
  const status = await waitForDeployResult('token', {
    targetSha: target, baselineTail: oldTail,
    timeoutSeconds: 60, pollSeconds: 0, startedAt: Date.now(), fetchImpl,
  });
  assert.equal(calls, 3, 'the stale idle snapshot must not stop the wait');
  assert.equal(status.running, false);
  assert.equal(findDeployOkEvidence(status.tail)?.sha, target);
});

test('waitForDeployResult never accepts the previous deploy-ok and times out fail-closed', async () => {
  const oldTail = '== deploy ok 7027cdd 2026-09-24T08:00:00Z ==';
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ running: false, tail: oldTail }) };
  };
  await assert.rejects(
    () => waitForDeployResult('token', {
      targetSha: 'eef9144', baselineTail: oldTail,
      timeoutSeconds: 1, pollSeconds: 0, startedAt: Date.now(), fetchImpl,
    }),
    /deploy log does not contain deploy ok for eef9144/,
  );
  assert.ok(calls >= 2, `must keep polling past the stale idle snapshot (calls=${calls})`);
});

test('waitForDeployResult fails closed on a fresh deploy-fail, not on the previous round failure', async () => {
  const baseline = '== deploy fail (rolled back to 1111111, service healthy) ==';
  const freshFail = `${baseline}\n== deploy start 2026-09-24T08:58:00Z ==\n== deploy fail (rolled back to 2222222, service healthy) ==`;
  const snapshots = [
    { running: false, tail: baseline },
    { running: false, tail: freshFail },
  ];
  let calls = 0;
  const fetchImpl = async () => {
    const snapshot = snapshots[Math.min(calls, snapshots.length - 1)];
    calls += 1;
    return { ok: true, json: async () => ({ ...snapshot }) };
  };
  assert.equal(findDeployFailEvidence(baseline)?.line, baseline);
  await assert.rejects(
    () => waitForDeployResult('token', {
      targetSha: 'eef9144', baselineTail: baseline,
      timeoutSeconds: 60, pollSeconds: 0, startedAt: Date.now(), fetchImpl,
    }),
    /deployment failed for eef9144/,
  );
  assert.equal(calls, 2, 'the old fail line alone must not fail the new round');
});

test('runRoomDeployJob survives the post-trigger start gap and reports deployed', async () => {
  const oldTail = '== deploy ok 7027cdd 2026-09-24T08:00:00Z ==';
  const target = 'eef9144';
  const startTail = `${oldTail}\n== deploy start 2026-09-24T08:58:00Z ==`;
  const doneTail = `${startTail}\n== deploy ok ${target} 2026-09-24T08:58:22Z ==`;
  const postTrigger = [
    { running: false, tail: oldTail },
    { running: true, tail: startTail },
    { running: false, tail: doneTail },
  ];
  let statusCalls = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/api/system/deploy') && init?.method === 'POST') {
      return { ok: true, status: 202 };
    }
    if (String(url).includes('/api/system/deploy/status')) {
      statusCalls += 1;
      if (statusCalls === 1) return { ok: true, json: async () => ({ running: false, tail: oldTail }) };
      const snapshot = postTrigger[Math.min(statusCalls - 2, postTrigger.length - 1)];
      return { ok: true, json: async () => ({ ...snapshot }) };
    }
    if (String(url).includes('/messages')) return { ok: true, json: async () => ({ messages: [] }) };
    if (String(url).includes('/api/contacts')) {
      return { ok: true, json: async () => ({ contacts: [{ kind: 'room', id: 'room-abc' }] }) };
    }
    if (String(url).includes('/api/health')) return { ok: true, json: async () => ({ status: 'ok' }) };
    throw new Error(`unexpected fetch: ${url}`);
  };
  const result = await runRoomDeployJob(
    { sha: target, timeoutSeconds: 30, pollSeconds: 1 },
    { fetchImpl, hubToken: 'hub', deployToken: 'deploy' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.result, 'deployed');
  assert.equal(result.targetSha, target);
  assert.match(result.deployOkLine, new RegExp(`== deploy ok ${target}`));
  assert.ok(statusCalls >= 4, `must poll past the stale post-trigger snapshot (statusCalls=${statusCalls})`);
});
test('waitDeployIdle tolerates the restart gap then fails past tolerance', async () => {
  const failed = async () => { throw new Error('socket hang up'); };
  await assert.rejects(
    waitDeployIdle('token', { running: true, tail: 't' }, {
      timeoutSeconds: 60, pollSeconds: 0, startedAt: Date.now(), fetchImpl: failed,
      tolerateRestartGap: true, unreachableToleranceSeconds: 0,
    }),
    /deployment did not finish|hub unreachable/,
  );
  let calls = 0;
  const flapping = async () => {
    calls += 1;
    if (calls === 1) throw new Error('socket hang up');
    return { ok: true, json: async () => ({ running: false, tail: '== deploy ok abc1234 ==' }) };
  };
  const done = await waitDeployIdle('token', { running: true, tail: '' }, {
    timeoutSeconds: 60, pollSeconds: 0, startedAt: Date.now(), fetchImpl: flapping,
    tolerateRestartGap: true, unreachableToleranceSeconds: 30,
  });
  assert.equal(done.running, false);
});


test('Gate L self-check: evidence is mandatory and must match the frozen candidate', () => {
  // A Linux merge entry that can run without ledger evidence is a fail-open
  // gate — the whole point of WP-A on the ps1 side.
  assert.throws(() => mergeArgs({ releaseEvidence: undefined }), /releaseEvidence .* is required/);
  assert.throws(() => mergeArgs({ releaseEvidence: '' }), /releaseEvidence .* is required/);
  assert.throws(() => mergeArgs({ releaseEvidence: 'not json' }), /not valid JSON/);
  assert.throws(() => mergeArgs({ releaseEvidence: evidenceFor('c'.repeat(40)) }), /evidence candidate/);
  assert.throws(
    () => mergeArgs({ releaseEvidence: evidenceFor('a'.repeat(40), { reviewStatus: 'request_changes' }) }),
    /is not approved/,
  );
  assert.throws(
    () => mergeArgs({ releaseEvidence: evidenceFor('a'.repeat(40), { taskPath: '../etc/passwd' }) }),
    /bad task path/,
  );
  assert.throws(
    () => mergeArgs({ releaseEvidence: evidenceFor('a'.repeat(40), { roomId: 'room id/../x' }) }),
    /bad room id/,
  );
  const parsed = parseReleaseEvidence(evidenceFor('a'.repeat(40)), 'A'.repeat(40));
  assert.equal(parsed.roomId, ROOM);
  assert.equal(parsed.taskPath, TASK);
});

test('claimed baseline is optional and never asserted against frozen', () => {
  // 2026-09-16: two merge rounds died because the claimed before.head of an
  // older candidate was asserted as an ancestor of a rebased frozen SHA.
  assert.equal(mergeArgs({ baselineSha: '' }).baselineSha, '');
  assert.throws(() => mergeArgs({ baselineSha: 'nope' }), /claimed baselineSha/);
});

test('server re-verification is fail-closed whenever the evidence carries a roomId', async () => {
  const args = mergeArgs();
  await assert.rejects(
    () => verifyReleaseEvidence(args, { env: {}, fileValues: {}, fetchImpl: async () => { throw new Error('unused'); } }),
    /no bearer/,
  );
  const env = { AI_HUB_TOKEN: 'tok' };
  await assert.rejects(
    () => verifyReleaseEvidence(args, { env, fileValues: {}, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }),
    /gateway .* failed/,
  );
  await assert.rejects(
    () => verifyReleaseEvidence(args, { env, fileValues: {}, fetchImpl: async () => ({ ok: false, status: 502 }) }),
    /HTTP 502/,
  );
  await assert.rejects(
    () => verifyReleaseEvidence(args, { env, fileValues: {}, fetchImpl: async () => ({ ok: true, json: async () => ({ task: {} }) }) }),
    /no candidate_sha/,
  );
  await assert.rejects(
    () => verifyReleaseEvidence(args, {
      env,
      fileValues: {},
      fetchImpl: async () => ({ ok: true, json: async () => ({ task: { candidate_sha: 'c'.repeat(40), review_status: 'approved' } }) }),
    }),
    /ledger candidate/,
  );
  await assert.rejects(
    () => verifyReleaseEvidence(args, {
      env,
      fileValues: {},
      fetchImpl: async () => ({ ok: true, json: async () => ({ task: { candidate_sha: 'a'.repeat(40), review_status: 'pending' } }) }),
    }),
    /review status/,
  );

  let seenUrl = null;
  let seenAuth = null;
  const ok = await verifyReleaseEvidence(args, {
    env: {},
    // no process env token: the bearer comes from --env-file, because the VPS
    // worker is a nologin user with no per-user environment.
    fileValues: { AI_HUB_TOKEN: 'from-env-file' },
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenAuth = init.headers.Authorization;
      return { ok: true, json: async () => ({ task: { candidate_sha: 'a'.repeat(40), review_status: 'approved' } }) };
    },
  });
  assert.equal(ok.verified, true);
  assert.equal(seenAuth, 'Bearer from-env-file');
  // Loopback by default: no tailnet address baked into the Linux entry.
  assert.equal(seenUrl, `http://127.0.0.1:3900/api/room-tasks/${ROOM}/ai-hub-vps-migration-restructure.md`);
});

test('evidence without a roomId is a manual run unless --require-server-verify', async () => {
  const manual = mergeArgs({ releaseEvidence: evidenceFor('a'.repeat(40), { roomId: '' }) });
  const result = await verifyReleaseEvidence(manual, { env: {}, fileValues: {} });
  assert.equal(result.verified, false);
  await assert.rejects(
    () => verifyReleaseEvidence({ ...manual, requireServerVerify: true }, { env: {}, fileValues: {} }),
    /no roomId/,
  );
});

test('merge run is worktree-safe: no switch, live baseline, stale reported not pushed', async () => {
  const frozen = 'a'.repeat(40);
  const master = 'd'.repeat(40);
  const calls = [];
  const makeExec = ({ ancestor }) => async (command, cmdArgs) => {
    calls.push([command, ...cmdArgs].join(' '));
    if (command !== 'git') return { stdout: '' };
    const [sub, ...rest] = cmdArgs;
    if (sub === 'rev-parse' && rest[0] === '--is-inside-work-tree') return { stdout: 'true\n' };
    if (sub === 'rev-parse' && rest[0] === 'HEAD') return { stdout: `${frozen}\n` };
    if (sub === 'rev-parse') return { stdout: `${master}\n` };
    if (sub === 'status') return { stdout: '' };
    if (sub === 'branch') return { stdout: 'vps-migration-v2\n' };
    if (sub === 'merge-base' && rest[0] === '--is-ancestor') {
      if (ancestor) return { stdout: '' };
      const error = new Error('not an ancestor');
      error.code = 1;
      throw error;
    }
    if (sub === 'merge-base') return { stdout: `${'e'.repeat(40)}\n` };
    if (sub === 'ls-remote') return { stdout: `${frozen}\trefs/heads/master\n` };
    return { stdout: '' };
  };

  const result = await runMergeCloseJob(
    { frozenSha: frozen, baselineSha: 'b'.repeat(40), workingBranch: 'vps-migration-v2', releaseEvidence: evidenceFor(frozen) },
    { exec: makeExec({ ancestor: true }), dryRun: true, verify: async () => ({ verified: true }) },
  );
  assert.equal(result.ok, true);
  // Computed live off the fetched remote ref, not the claimed before.head.
  assert.equal(result.baselineSha, 'e'.repeat(40));
  assert.equal(result.claimedBaselineSha, 'b'.repeat(40));
  assert.equal(result.taskPath, TASK);
  assert.ok(!calls.some((line) => line.startsWith('git switch')), 'must never switch branches');
  assert.ok(!calls.some((line) => line.startsWith('git merge --ff-only')), 'must never check out and merge');
  assert.ok(!calls.some((line) => line.includes('refs/heads/master') && line.startsWith('git rev-parse')),
    'local refs/heads/master is never read — a provisioned clone may not have it');

  calls.length = 0;
  await assert.rejects(
    () => runMergeCloseJob(
      { frozenSha: frozen, baselineSha: '', workingBranch: 'vps-migration-v2', releaseEvidence: evidenceFor(frozen) },
      { exec: makeExec({ ancestor: false }), verify: async () => ({ verified: true }) },
    ),
    (error) => {
      assert.ok(error instanceof StaleCandidateError);
      const report = mergeFailureReport(error);
      assert.equal(report.stale, true);
      assert.equal(report.masterSha, master);
      assert.equal(report.taskPath, TASK);
      return true;
    },
  );
  assert.ok(!calls.some((line) => line.startsWith('git push')), 'a stale candidate is never pushed');
});

test('runMergeCloseJob refuses to start when server re-verification fails', async () => {
  await assert.rejects(
    () => runMergeCloseJob(
      { frozenSha: 'a'.repeat(40), baselineSha: '', workingBranch: 'x', releaseEvidence: evidenceFor('a'.repeat(40)) },
      {
        exec: async () => { throw new Error('git must not run before Gate L passes'); },
        verify: async () => { throw new Error('server re-verification rejected: gateway unreachable'); },
      },
    ),
    /server re-verification rejected/,
  );
});

test('target branch defaults per repo; an explicit --target-branch wins', () => {
  // ai-dashboard's trunk is main: defaulting it to master fetched a ref that
  // does not exist and killed the merge before any gate ran.
  const dash = mergeArgs({ repoId: 'ai-dashboard', repoDir: '/srv/ai-dev/jobs/t/a/ai-dashboard' });
  assert.equal(dash.targetBranch, 'main');
  assert.equal(mergeArgs().targetBranch, 'master', 'ai-hub keeps master');
  assert.equal(
    mergeArgs({ repoId: 'ai-dashboard', repoDir: '/srv/x', targetBranch: 'release' }).targetBranch,
    'release',
  );
  assert.equal(mergeArgs({ repoId: 'ai-dashboard', repoDir: '/srv/x' }).repoId, 'ai-dashboard');
});
