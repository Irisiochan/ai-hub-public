import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// W2: install-vps-worker.sh "busy -> defer to pending" path, driven through
// the real shell script with injected hooks (FAKE_BUSY / NO_SYSTEMD /
// ALLOW_NONROOT). Needs bash + git + tar + install (present in Git Bash);
// otherwise the suite reports un-run instead of mocking the script.

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, 'install-vps-worker.sh');
const UPDATE_SH = path.resolve(here, 'update.sh');

function haveTool(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !haveTool('bash', ['--version']) || !haveTool('git', ['--version'])
  ? 'not run on this host: needs bash + git (Git Bash); run on the Linux VPS'
  : undefined;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@test',
};

function makeSrcRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-installer-src-'));
  execFileSync('git', ['init', '-b', 'master'], { cwd: repo, env: gitEnv, stdio: 'ignore' });
  for (const file of [
    'worker/worker.mjs',
    'worker/ai-dev-worker.service',
    'deploy/merge-close-job.mjs',
    'deploy/room-deploy-job.mjs',
    'shared/keys.mjs',
  ]) {
    fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), `// ${file}\n`);
  }
  execFileSync('git', ['add', '.'], { cwd: repo, env: gitEnv, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'release'], { cwd: repo, env: gitEnv, stdio: 'ignore' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/master', 'HEAD'], { cwd: repo, env: gitEnv, stdio: 'ignore' });
  return { repo, sha, short: sha.slice(0, 12) };
}

// The script runs under msys bash: backslash temp paths (C:\...) would be
// eaten as escapes by mktemp/tar, so hand it POSIX forms (/c/...) while
// node:fs keeps using the native forms.
function toPosix(p) {
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}

// One fresh ROOT per run: each execution flips `current` at most once, so the
// msys `mv -T` overwrite quirk on Windows never fires (on the Linux VPS the
// atomic replace works for repeated flips too).
function makeRun({ src, busy }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-installer-root-'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-installer-scratch-'));
  const pendingFile = path.join(scratch, 'pending-release.json');
  const env = {
    ...process.env,
    SRC_REPO: toPosix(src),
    ROOT: toPosix(root),
    UNIT_DST: toPosix(path.join(scratch, 'ai-dev-worker.service')),
    UNIT_BACKUP_DIR: toPosix(scratch),
    PENDING_FILE: toPosix(pendingFile),
    INSTALL_VPS_WORKER_ALLOW_NONROOT: '1',
    INSTALL_VPS_WORKER_NO_SYSTEMD: '1',
    INSTALL_VPS_WORKER_FAKE_BUSY: busy ? '1' : '0',
  };
  return {
    root, scratch, env, pendingFile,
    execute(args) {
      try {
        return { exitCode: 0, stdout: execFileSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' }) };
      } catch (error) {
        return {
          exitCode: Number(error?.status ?? 1),
          stdout: String(error?.stdout ?? '') + String(error?.stderr ?? ''),
        };
      }
    },
    readPending() {
      return JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    },
    seedPending(sha) {
      fs.writeFileSync(pendingFile, JSON.stringify({ sha, short: sha.slice(0, 12), reason: 'worker-busy' }));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(scratch, { recursive: true, force: true });
    },
  };
}

test('busy worker without --force defers to pending and exits 0 (no suicide)', { skip: SKIP }, () => {
  const { repo, sha } = makeSrcRepo();
  const run = makeRun({ src: repo, busy: true });
  try {
    const result = run.execute([sha]);
    assert.equal(result.exitCode, 0, `deferral must not fail the deploy:\n${result.stdout}`);
    assert.match(result.stdout, /PENDING/, 'must print the PENDING marker');
    const pending = run.readPending();
    assert.equal(pending.sha, sha);
    assert.equal(pending.reason, 'worker-busy');
    assert.ok(pending.requestedAt, 'pending record carries a timestamp');
    assert.equal(fs.existsSync(path.join(run.root, sha.slice(0, 12))), false, 'no release dir flipped while busy');
    assert.equal(fs.existsSync(path.join(run.root, 'current')), false, 'current symlink untouched while busy');
  } finally {
    run.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('idle worker installs, flips current and clears a matching pending', { skip: SKIP }, () => {
  const { repo, sha, short } = makeSrcRepo();
  const run = makeRun({ src: repo, busy: false });
  try {
    run.seedPending(sha);
    const result = run.execute([sha]);
    assert.equal(result.exitCode, 0, `idle install must succeed:\n${result.stdout}`);
    assert.match(result.stdout, /CURRENT .* -> /);
    assert.match(result.stdout, /PENDING_CLEARED/);
    assert.match(result.stdout, /DRYRUN systemctl restart/, 'no real systemctl in test mode');
    assert.equal(fs.existsSync(run.pendingFile), false, 'matching pending is consumed');
    const currentPath = path.join(run.root, 'current');
    if (fs.lstatSync(currentPath).isSymbolicLink()) {
      assert.equal(toPosix(fs.readlinkSync(currentPath)), toPosix(path.join(run.root, short)));
    } else {
      // msys ln -s without symlink privilege materializes a directory copy
      // instead of a link (Linux VPS: always a real symlink). Prove the flip
      // by content identity in that case.
      assert.equal(
        fs.readFileSync(path.join(currentPath, 'worker', 'worker.mjs'), 'utf8'),
        fs.readFileSync(path.join(run.root, short, 'worker', 'worker.mjs'), 'utf8'),
      );
    }
    assert.ok(fs.existsSync(path.join(run.root, short, 'worker', 'worker.mjs')));
  } finally {
    run.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('successful install clears a stale pending for a different sha (no rollback)', { skip: SKIP }, () => {
  const { repo, sha: shaA } = makeSrcRepo();
  // Second reviewed commit on origin/master: the "new deploy" sha. Touch
  // worker/worker.mjs so the msys directory-copy fallback can tell A/B apart
  // by content (Linux VPS always uses a real `current` symlink).
  fs.writeFileSync(path.join(repo, 'worker', 'worker.mjs'), '// worker/worker.mjs v2\n');
  fs.writeFileSync(path.join(repo, 'shared', 'keys.mjs'), '// shared/keys.mjs v2\n');
  execFileSync('git', ['add', '.'], { cwd: repo, env: gitEnv, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'release-2'], { cwd: repo, env: gitEnv, stdio: 'ignore' });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/master', 'HEAD'], { cwd: repo, env: gitEnv, stdio: 'ignore' });
  const shaB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  assert.notEqual(shaA, shaB, 'need two distinct shas for the stale-pending case');
  const run = makeRun({ src: repo, busy: false });
  const shortB = shaB.slice(0, 12);
  const currentPointsAtB = () => {
    const currentPath = path.join(run.root, 'current');
    if (fs.lstatSync(currentPath).isSymbolicLink()) {
      return toPosix(fs.readlinkSync(currentPath)) === toPosix(path.join(run.root, shortB));
    }
    return fs.readFileSync(path.join(currentPath, 'worker', 'worker.mjs'), 'utf8')
      === fs.readFileSync(path.join(run.root, shortB, 'worker', 'worker.mjs'), 'utf8');
  };
  try {
    run.seedPending(shaA);
    const result = run.execute([shaB]);
    assert.equal(result.exitCode, 0, `idle install of B must succeed:\n${result.stdout}`);
    assert.match(result.stdout, /CURRENT .* -> /);
    assert.match(result.stdout, /PENDING_CLEARED/);
    assert.equal(fs.existsSync(run.pendingFile), false, 'stale pending A must be gone after B lands');
    assert.ok(currentPointsAtB(), 'current must point at B after install');
    // A later timer retry must be a no-op, never flip current back to A.
    const retry = run.execute(['--retry-pending']);
    assert.equal(retry.exitCode, 0, `retry after clear must succeed:\n${retry.stdout}`);
    assert.match(retry.stdout, /NO_PENDING/);
    assert.ok(!/CURRENT .* -> /.test(retry.stdout), 'no CURRENT flip on NO_PENDING retry');
    assert.ok(currentPointsAtB(), 'current still points at B after retry');
    assert.equal(fs.existsSync(path.join(run.root, shaA.slice(0, 12), 'worker', 'worker.mjs')), false, 'stale sha A must never be exported');
  } finally {
    run.cleanup();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('--retry-pending with no record is a no-op; busy keeps it, idle consumes it', { skip: SKIP }, () => {
  const { repo, sha } = makeSrcRepo();
  try {
    const empty = makeRun({ src: repo, busy: false });
    try {
      const result = empty.execute(['--retry-pending']);
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /NO_PENDING/);
    } finally {
      empty.cleanup();
    }
    const busy = makeRun({ src: repo, busy: true });
    try {
      busy.seedPending(sha);
      const result = busy.execute(['--retry-pending']);
      assert.equal(result.exitCode, 0, `retry while busy must defer, not fail:\n${result.stdout}`);
      assert.match(result.stdout, /PENDING/);
      assert.equal(busy.readPending().sha, sha, 'pending survives a busy retry');
      assert.equal(fs.existsSync(path.join(busy.root, 'current')), false);
    } finally {
      busy.cleanup();
    }
    const idle = makeRun({ src: repo, busy: false });
    try {
      idle.seedPending(sha);
      const result = idle.execute(['--retry-pending']);
      assert.equal(result.exitCode, 0, `idle retry must install:\n${result.stdout}`);
      assert.match(result.stdout, /CURRENT .* -> /);
      assert.equal(fs.existsSync(idle.pendingFile), false, 'idle retry consumes pending');
    } finally {
      idle.cleanup();
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('update.sh calls the installer only after the deploy-ok marker, never --force', () => {
  const source = fs.readFileSync(UPDATE_SH, 'utf8');
  const okAt = source.indexOf('== deploy ok');
  const installerAt = source.indexOf('install-vps-worker.sh');
  assert.ok(okAt !== -1 && installerAt !== -1, 'update.sh must keep the deploy-ok line and the follow-up call');
  assert.ok(okAt < installerAt, 'follow-up runs strictly after deploy-ok (receipt first, switch second)');
  const tail = source.slice(installerAt);
  assert.ok(!/--force/.test(tail), 'update.sh must never pass --force: the closure job is a live child');
  assert.match(source, /AI_HUB_SKIP_VPS_WORKER_FOLLOWUP/, 'follow-up stays skippable');
});
