import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureNodeModules, provisionWorkspace, taskSlugForWorkspace } from './provision.mjs';

// G04 supply tests use only local bare repos (plain paths, file backend):
// no network access anywhere in this file.

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 60_000,
  }).trim();
}

function makeSeed() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-seed-'));
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work, { recursive: true });
  git(['init'], work);
  fs.writeFileSync(path.join(work, 'README.md'), 'seed\n');
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'README.md'], work);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init'], work);
  const sha = git(['rev-parse', 'HEAD'], work);
  const seed = path.join(tmp, 'seed.git');
  git(['clone', '--bare', work, seed], tmp);
  const mirror = path.join(tmp, 'mirror.git');
  git(['clone', '--bare', work, mirror], tmp);
  return { tmp, sha, seed, mirror };
}

function vpsJob(workspace, { repoId = 'ai-hub', patchBase = null } = {}) {
  return {
    id: 'job-provision-1',
    workspace,
    options: {
      projectTarget: { repoId, platform: 'linux', workerId: 'vps-dev', workspace },
      ...(patchBase ? { patchBase } : {}),
    },
  };
}

test('provisions a missing fenced workspace: clone, baseSha checkout, task branch', () => {
  const { sha, seed, mirror } = makeSeed();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-root-'));
  const workspace = path.join(root, 'mytask', 'attempt-a1', 'ai-hub');
  const out = provisionWorkspace(vpsJob(workspace, { patchBase: sha }), {
    root,
    repos: { 'ai-hub': { url: seed, mirror } },
    // The bare seed repo has no server/web/worker subdirs; W1 install-path
    // coverage below uses mocked git+npm instead.
    provisionInstalls: { 'ai-hub': [] },
  });
  assert.equal(out.provisioned, true);
  assert.deepEqual(out.installed, []);
  assert.equal(out.branch, 'task/mytask');
  assert.equal(git(['rev-parse', 'HEAD'], workspace), sha);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace), 'task/mytask');
});

test('missing mirror is tolerated via --reference-if-able', () => {
  const { sha, seed, tmp } = makeSeed();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-root-'));
  const workspace = path.join(root, 'mytask', 'attempt-a2', 'ai-hub');
  const out = provisionWorkspace(vpsJob(workspace, { patchBase: sha }), {
    root,
    repos: { 'ai-hub': { url: seed, mirror: path.join(tmp, 'no-such-mirror.git') } },
    provisionInstalls: { 'ai-hub': [] },
  });
  assert.equal(out.provisioned, true);
  assert.equal(git(['rev-parse', 'HEAD'], workspace), sha);
});

test('existing workspace is left alone (no git invoked)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-root-'));
  const workspace = path.join(root, 'mytask', 'attempt-a3', 'ai-hub');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'keep.txt'), 'mine\n');
  let calls = 0;
  const out = provisionWorkspace(vpsJob(workspace), {
    root,
    repos: {},
    runGit: () => { calls += 1; },
  });
  assert.equal(out.provisioned, false);
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(path.join(workspace, 'keep.txt'), 'utf8'), 'mine\n');
});

test('refuses without a trusted repo mapping (and clones nothing)', () => {
  const { sha } = makeSeed();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-root-'));
  const workspace = path.join(root, 'mytask', 'attempt-a4', 'ai-hub');
  let calls = 0;
  assert.throws(
    () => provisionWorkspace(vpsJob(workspace, { repoId: 'unknown-repo', patchBase: sha }), {
      root,
      repos: { 'ai-hub': { url: 'x', mirror: 'y' } },
      runGit: () => { calls += 1; },
    }),
    /unknown-repo/,
  );
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(workspace), false);
});

test('refuses without baseSha (and clones nothing)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-root-'));
  const workspace = path.join(root, 'mytask', 'attempt-a5', 'ai-hub');
  let calls = 0;
  assert.throws(
    () => provisionWorkspace(vpsJob(workspace), {
      root,
      repos: { 'ai-hub': { url: 'x', mirror: 'y' } },
      runGit: () => { calls += 1; },
    }),
    /baseSha/,
  );
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(workspace), false);
});

test('refuses an illegal baseSha without touching git', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-root-'));
  const workspace = path.join(root, 'mytask', 'attempt-a6', 'ai-hub');
  let calls = 0;
  assert.throws(
    () => provisionWorkspace(vpsJob(workspace, { patchBase: 'not-a-sha' }), {
      root,
      repos: { 'ai-hub': { url: 'x', mirror: 'y' } },
      runGit: () => { calls += 1; },
    }),
    /baseSha/,
  );
  assert.equal(calls, 0);
});

test('refuses a target outside the fence without writing anything', () => {
  const { sha, seed, mirror } = makeSeed();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-root-'));
  const outside = path.join(path.dirname(root), 'provision-escape-target');
  let calls = 0;
  assert.throws(
    () => provisionWorkspace(vpsJob(outside, { patchBase: sha }), {
      root,
      repos: { 'ai-hub': { url: seed, mirror } },
      runGit: () => { calls += 1; },
    }),
    /围栏/,
  );
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(outside), false);
});

test('missing workspace without a frozen target keeps the old refusal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-root-'));
  const workspace = path.join(root, 'mytask', 'attempt-a7', 'ai-hub');
  assert.throws(
    () => provisionWorkspace({ id: 'j', workspace, options: {} }, { root, repos: {} }),
    /workspace does not exist/,
  );
});

test('taskSlugForWorkspace derives the first fenced segment only', () => {
  const root = path.join(os.tmpdir(), 'provision-slug-root');
  const join = (...parts) => path.join(...parts);
  assert.equal(
    taskSlugForWorkspace(root, join(root, 'mytask', 'attempt-1', 'ai-hub')),
    'mytask',
  );
  assert.equal(taskSlugForWorkspace(root, root), null);
  assert.equal(taskSlugForWorkspace(root, join(root, '..', 'evil')), null);
  assert.equal(taskSlugForWorkspace(root, join(root, 'bad slug!', 'a', 'b')), null);
});

// ── W1: per-repo post-clone dependency install (mocked git+npm, no network) ──

const W1_SHA = 'b'.repeat(40);

function mockSupply() {
  const gitCalls = [];
  const npmCalls = [];
  return {
    gitCalls,
    npmCalls,
    mkOpts(extra = {}) {
      return {
        mkdir: () => {},
        runGit: (args, cwd) => { gitCalls.push([args, cwd ?? null]); },
        runNpm: (args, cwd) => { npmCalls.push([args, cwd]); },
        ...extra,
      };
    },
  };
}

// A fake supplied tree on disk so lockfile detection sees a realistic
// layout; `exists` still reports the workspace itself as missing so supply runs.
function makeW1Tree(root, task, repoId, { lockfiles = ['server', 'web'] } = {}) {
  const workspace = path.join(root, task, 'attempt-w1', repoId);
  for (const dir of ['server', 'web', 'worker']) {
    fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  }
  for (const dir of lockfiles) {
    fs.writeFileSync(path.join(workspace, dir, 'package-lock.json'), '{}\n');
  }
  return workspace;
}

function w1Exists(workspace) {
  return (p) => (p === workspace ? false : fs.existsSync(p));
}

test('W1: ai-hub supply installs server/web/worker (ci where locked, plain install where not)', () => {
  const supply = mockSupply();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-w1-root-'));
  const workspace = makeW1Tree(root, 'w1task', 'ai-hub');
  const out = provisionWorkspace(vpsJob(workspace, { repoId: 'ai-hub', patchBase: W1_SHA }), {
    ...supply.mkOpts({ exists: w1Exists(workspace) }),
    root,
    repos: { 'ai-hub': { url: 'u', mirror: 'm' } },
  });
  assert.equal(supply.gitCalls.length, 3);
  assert.deepEqual(supply.gitCalls[0][0].slice(0, 2), ['clone', '--reference-if-able']);
  assert.deepEqual(supply.npmCalls, [
    [['ci', '--no-audit', '--no-fund'], path.join(workspace, 'server')],
    [['ci', '--no-audit', '--no-fund'], path.join(workspace, 'web')],
    [['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund'], path.join(workspace, 'worker')],
  ]);
  assert.deepEqual(out.installed, ['server', 'web', 'worker']);
});

test('W1: ai-dashboard supply installs nothing (its merge set runs its own npm ci)', () => {
  const supply = mockSupply();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-w1-root-'));
  const workspace = makeW1Tree(root, 'w1task', 'ai-dashboard');
  const out = provisionWorkspace(vpsJob(workspace, { repoId: 'ai-dashboard', patchBase: W1_SHA }), {
    ...supply.mkOpts({ exists: w1Exists(workspace) }),
    root,
    repos: { 'ai-dashboard': { url: 'u', mirror: 'm' } },
  });
  assert.equal(supply.gitCalls.length, 3);
  assert.deepEqual(supply.npmCalls, []);
  assert.deepEqual(out.installed, []);
});

test('W1: repo entry install list overrides the default', () => {
  const supply = mockSupply();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-w1-root-'));
  const workspace = makeW1Tree(root, 'w1task', 'ai-hub');
  const out = provisionWorkspace(vpsJob(workspace, { repoId: 'ai-hub', patchBase: W1_SHA }), {
    ...supply.mkOpts({ exists: w1Exists(workspace) }),
    root,
    repos: { 'ai-hub': { url: 'u', mirror: 'm', install: ['web'] } },
  });
  assert.deepEqual(supply.npmCalls, [
    [['ci', '--no-audit', '--no-fund'], path.join(workspace, 'web')],
  ]);
  assert.deepEqual(out.installed, ['web']);
});

test('W1: opts.provisionInstalls overrides entry and default (explicit [] disables)', () => {
  const supply = mockSupply();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-w1-root-'));
  const workspace = makeW1Tree(root, 'w1task', 'ai-hub');
  const out = provisionWorkspace(vpsJob(workspace, { repoId: 'ai-hub', patchBase: W1_SHA }), {
    ...supply.mkOpts({ exists: w1Exists(workspace) }),
    root,
    repos: { 'ai-hub': { url: 'u', mirror: 'm', install: ['server'] } },
    provisionInstalls: { 'ai-hub': [] },
  });
  assert.deepEqual(supply.npmCalls, []);
  assert.deepEqual(out.installed, []);
});

test('W1: illegal install dir refuses before cloning anything', () => {
  const supply = mockSupply();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-w1-root-'));
  const workspace = path.join(root, 'w1task', 'attempt-w1', 'ai-hub');
  assert.throws(
    () => provisionWorkspace(vpsJob(workspace, { repoId: 'ai-hub', patchBase: W1_SHA }), {
      ...supply.mkOpts(),
      root,
      repos: { 'ai-hub': { url: 'u', mirror: 'm', install: ['../evil'] } },
    }),
    /目录非法/,
  );
  assert.deepEqual(supply.gitCalls, []);
  assert.deepEqual(supply.npmCalls, []);
  assert.equal(fs.existsSync(workspace), false);
});

test('W1: non-array install config refuses before cloning anything', () => {
  const supply = mockSupply();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-w1-root-'));
  const workspace = path.join(root, 'w1task', 'attempt-w1', 'ai-hub');
  assert.throws(
    () => provisionWorkspace(vpsJob(workspace, { repoId: 'ai-hub', patchBase: W1_SHA }), {
      ...supply.mkOpts(),
      root,
      repos: { 'ai-hub': { url: 'u', mirror: 'm', install: 'server' } },
    }),
    /配置非法/,
  );
  assert.deepEqual(supply.gitCalls, []);
});

test('W1: npm failure removes the half-supplied tree so the next claim retries supply', () => {
  const supply = mockSupply();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-w1-root-'));
  const workspace = makeW1Tree(root, 'w1task', 'ai-hub');
  const failing = supply.mkOpts({ exists: w1Exists(workspace) });
  failing.runNpm = (args, cwd) => {
    supply.npmCalls.push([args, cwd]);
    if (String(cwd).endsWith(`${path.sep}web`)) throw new Error('registry down');
  };
  assert.throws(
    () => provisionWorkspace(vpsJob(workspace, { repoId: 'ai-hub', patchBase: W1_SHA }), {
      ...failing,
      root,
      repos: { 'ai-hub': { url: 'u', mirror: 'm' } },
    }),
    /依赖安装失败/,
  );
  assert.equal(fs.existsSync(workspace), false);
});

// ── 能力卡 T6: PC worktree 缺 node_modules 时补装（与 VPS 供给路径同款）──

function makeWorktree(root, task, repoId, { present = [], lockfiles = ['server', 'web'] } = {}) {
  const workspace = path.join(root, task, 'attempt-pc', repoId);
  for (const dir of ['server', 'web', 'worker']) {
    fs.mkdirSync(path.join(workspace, dir), { recursive: true });
    if (lockfiles.includes(dir)) {
      fs.writeFileSync(path.join(workspace, dir, 'package-lock.json'), '{}\n');
    }
    if (present.includes(dir)) {
      fs.mkdirSync(path.join(workspace, dir, 'node_modules'), { recursive: true });
    }
  }
  return workspace;
}

test('T6 PC worktree 缺 node_modules 时补 npm ci（同款参数：有锁 ci、无锁 plain install）', () => {
  const npmCalls = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-t6-root-'));
  const workspace = makeWorktree(root, 'pctask', 'ai-hub', { present: ['server'] });
  const out = ensureNodeModules(workspace, {
    repoId: 'ai-hub',
    repos: { 'ai-hub': { url: 'u', mirror: 'm' } },
    runNpm: (args, cwd) => { npmCalls.push([args, cwd]); },
  });
  assert.deepEqual(npmCalls, [
    [['ci', '--no-audit', '--no-fund'], path.join(workspace, 'web')],
    [['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund'], path.join(workspace, 'worker')],
  ]);
  assert.deepEqual(out.installed, ['web', 'worker']);
});

test('T6 worktree 依赖齐全时不跑 npm（纯 stat，无副作用）', () => {
  let calls = 0;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-t6-root-'));
  const workspace = makeWorktree(root, 'pctask', 'ai-hub', { present: ['server', 'web', 'worker'] });
  const out = ensureNodeModules(workspace, {
    repoId: 'ai-hub',
    repos: { 'ai-hub': { url: 'u', mirror: 'm' } },
    runNpm: () => { calls += 1; },
  });
  assert.deepEqual(out.installed, []);
  assert.equal(calls, 0);
});

test('T6 worktree 补装失败直接抛因（fail closed，缺哪个 dir 写清）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-t6-root-'));
  const workspace = makeWorktree(root, 'pctask', 'ai-hub', { present: [] });
  assert.throws(
    () => ensureNodeModules(workspace, {
      repoId: 'ai-hub',
      repos: { 'ai-hub': { url: 'u', mirror: 'm' } },
      runNpm: () => { throw new Error('registry down'); },
    }),
    /worktree 依赖补装失败.*dir=server/,
  );
});

test('PC 工作区缺失时失败原因用 capability-reject 同一格式', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-t6-root-'));
  const workspace = path.join(root, 'pctask', 'attempt-pc', 'ai-hub');
  assert.throws(
    () => provisionWorkspace({ id: 'j', workspace, options: {} }, { root, repos: {}, workerId: 'vps-dev' }),
    /capability-reject: vps-dev workspace=missing /,
  );
  try {
    provisionWorkspace({ id: 'j', workspace, options: {} }, { root, repos: {}, workerId: 'vps-dev' });
    assert.fail('must throw');
  } catch (error) {
    assert.equal(error.message, `capability-reject: vps-dev workspace=missing ${workspace}`);
  }
});
