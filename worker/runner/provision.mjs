import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  isWindowsAbsolute,
  normalizeWorkspacePath,
  workspaceContains,
} from './workspace-path.mjs';

/**
 * G04 workspace supply: a job carrying a frozen `options.projectTarget`
 * whose workspace does not exist yet gets one clone attempt from the
 * trusted repo mapping in worker config (`repos`):
 *
 *   git clone --reference-if-able <mirror> <url> <workspace>
 *   git -C <workspace> checkout <baseSha>
 *   git -C <workspace> checkout -b task/<taskSlug>
 *   (per-repo) npm install in the configured subdirs (see below)
 *
 * Anything else (no frozen target, no repo mapping, missing/illegal
 * baseSha, target outside the G01 fence) throws with an explicit reason
 * so the claim is refused instead of spawning into a missing directory.
 * The G01 realpath containment in worker.mjs still runs after this and
 * covers the supplied tree (symlink escape inside the clone, etc.).
 *
 * W1 dependency supply: a fresh VPS clone has no node_modules, but the
 * ai-hub merge suites (`server npm run pretest`, `server npm test`,
 * `web npm test`, …) run npm against the checkout. So after clone the
 * configured subdirs get `npm ci` (lockfile present) or
 * `npm install --no-save --no-package-lock` (no lockfile, e.g. worker/,
 * which ships zero dependencies). The subdir list is per-repo:
 * `opts.provisionInstalls[repoId]` wins, then the repo entry's `install`
 * array in worker config, then DEFAULT_PROVISION_INSTALLS. Repos without
 * an entry (ai-dashboard — its merge set starts with its own `npm ci`)
 * install nothing, so dashboard supply behavior is unchanged.
 */

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

function sepOf(value) {
  return isWindowsAbsolute(String(value ?? '')) ? '\\' : '/';
}

export function frozenTargetOf(job) {
  const raw = job?.options?.projectTarget;
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
}

/**
 * First path segment of `workspace` below `root` (the fenced task slug),
 * or null when it cannot be derived safely. Both inputs are classified by
 * string form so POSIX pairs behave identically on any host.
 */
export function taskSlugForWorkspace(root, workspace) {
  const normRoot = normalizeWorkspacePath(root).replace(/[\\/]+$/, '');
  const normTarget = normalizeWorkspacePath(workspace).replace(/[\\/]+$/, '');
  if (!normRoot || !normTarget) return null;
  if (normTarget === normRoot) return null;
  if (!normTarget.startsWith(`${normRoot}${sepOf(workspace)}`)) return null;
  const rel = normTarget.slice(normRoot.length + 1);
  const first = rel.split(/[\\/]/).filter(Boolean)[0] ?? '';
  return SLUG_RE.test(first) ? first : null;
}

function defaultRunGit(args, cwd) {
  try {
    execFileSync('git', args, {
      cwd: cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 120_000,
    });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(-2000);
    throw new Error(`git ${String(args[0] ?? '')} failed: ${detail}`);
  }
}

function dirnameOf(value) {
  return isWindowsAbsolute(String(value ?? ''))
    ? path.win32.dirname(value)
    : path.posix.dirname(value);
}

function joinOf(workspace, ...parts) {
  return isWindowsAbsolute(String(workspace ?? ''))
    ? path.win32.join(workspace, ...parts)
    : path.posix.join(workspace, ...parts);
}

// W1: which checkout subdirs get an npm install after supply, per repo.
// ai-dashboard is deliberately absent: its merge validation set starts with
// its own `npm ci`, so supply installs nothing there (behavior unchanged).
const DEFAULT_PROVISION_INSTALLS = {
  'ai-hub': ['server', 'web', 'worker'],
};

const INSTALL_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_INSTALL_DIRS = 16;

function resolveProvisionInstalls(repoId, reposEntry, opts) {
  const overrides = opts?.provisionInstalls;
  const hasOverride = overrides && typeof overrides === 'object' && !Array.isArray(overrides)
    && Object.hasOwn(overrides, repoId);
  const raw = hasOverride
    ? overrides[repoId]
    : (reposEntry && Array.isArray(reposEntry.install)
      ? reposEntry.install
      : (reposEntry && reposEntry.install !== undefined ? reposEntry.install : undefined));
  const list = raw !== undefined ? raw : (DEFAULT_PROVISION_INSTALLS[repoId] ?? []);
  if (!Array.isArray(list)) {
    throw new Error(`provision install 配置非法（repoId=${repoId} 的 install 需为数组），拒绝供给`);
  }
  if (list.length > MAX_INSTALL_DIRS) {
    throw new Error(`provision install 配置非法（repoId=${repoId} 至多 ${MAX_INSTALL_DIRS} 个目录），拒绝供给`);
  }
  for (const dir of list) {
    if (typeof dir !== 'string' || !INSTALL_DIR_RE.test(dir)) {
      throw new Error(`provision install 目录非法（repoId=${repoId}：${String(dir ?? '')}），拒绝供给`);
    }
  }
  return [...list];
}

function defaultRunNpm(args, cwd) {
  try {
    execFileSync('npm', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      // A cold `npm ci` on server+web downloads hundreds of MB; the git
      // 120s budget does not apply here.
      timeout: 600_000,
    });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(-2000);
    throw new Error(`npm ${String(args[0] ?? '')} failed in ${cwd}: ${detail}`);
  }
}

/**
 * PC worktree supply gap: a worktree-style checkout (e.g. `git worktree add`)
 * carries no node_modules, so a claim landing on one would run the merge
 * suites against missing dependencies. When any of the repo's install dirs
 * lacks node_modules, install just those dirs with the exact VPS-supply
 * semantics (lockfile → `npm ci`, else lockfile-less `npm install`).
 * Returns `{ installed: [...] }`; throws with the refusal reason on bad
 * config or npm failure (fail closed, like the clone supply above).
 */
export function ensureNodeModules(workspace, opts = {}) {
  const target = String(workspace ?? '');
  const exists = opts.exists ?? fs.existsSync;
  const runNpm = opts.runNpm ?? defaultRunNpm;
  const repoId = String(opts.repoId ?? '').trim();
  if (!target) throw new Error('workspace 必填，拒绝补装依赖');
  if (!repoId) throw new Error(`缺少 repoId，拒绝为 ${target} 补装依赖`);
  const repos = opts.repos && typeof opts.repos === 'object' ? opts.repos : {};
  const installs = resolveProvisionInstalls(repoId, repos[repoId], opts);
  const installed = [];
  for (const dir of installs) {
    const cwd = joinOf(target, dir);
    if (exists(joinOf(target, dir, 'node_modules'))) continue;
    const lockfile = joinOf(target, dir, 'package-lock.json');
    const args = exists(lockfile)
      ? ['ci', '--no-audit', '--no-fund']
      : ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund'];
    try {
      runNpm(args, cwd);
    } catch (error) {
      throw new Error(`worktree 依赖补装失败（repoId=${repoId}，dir=${dir}）：${String(error?.message ?? error).slice(-1500)}`);
    }
    installed.push(dir);
  }
  return { installed };
}

/**
 * Ensure `job.workspace` exists, provisioning it once from the trusted
 * mirror when the job carries a frozen projectTarget. Returns
 * `{ provisioned: false }` when the workspace already exists,
 * `{ provisioned: true, workspace, branch, baseSha, repoId }` after a
 * supply. Throws with the refusal reason otherwise.
 */
export function provisionWorkspace(job, opts = {}) {
  const workspace = String(job?.workspace ?? '');
  const exists = opts.exists ?? fs.existsSync;
  if (workspace && exists(workspace)) return { provisioned: false, workspace };
  const frozen = frozenTargetOf(job);
  if (!frozen) {
    // PC exception path shares the gateway's machine-readable refusal line:
    // `capability-reject: <workerId> workspace=missing <path>`.
    const workerId = String(opts.workerId ?? '').trim();
    if (workerId) throw new Error(`capability-reject: ${workerId} workspace=missing ${workspace}`);
    throw new Error(`workspace does not exist: ${workspace}`);
  }
  const root = String(opts.root ?? '');
  if (!root || !workspaceContains(root, workspace)) {
    throw new Error(`workspace 不在围栏内，拒绝供给：${workspace}（root=${root || '（未知）'}）`);
  }
  const repoId = String(frozen.repoId ?? '').trim();
  if (!repoId) throw new Error(`VPS job 缺少 projectTarget.repoId，拒绝供给 ${workspace}`);
  const repos = opts.repos && typeof opts.repos === 'object' ? opts.repos : {};
  const entry = repos[repoId];
  const url = entry && typeof entry.url === 'string' ? entry.url.trim() : '';
  const mirror = entry && typeof entry.mirror === 'string' ? entry.mirror.trim() : '';
  if (!url || !mirror) {
    throw new Error(`没有 repoId=${repoId} 的可信映射（config.repos 需 url + mirror），拒绝供给 ${workspace}`);
  }
  // G02 freezes no second baseline beside baseline_sha: the base commit
  // reaches the worker as options.patchBase (task baseline_sha).
  const baseSha = String(job?.options?.patchBase ?? frozen.baseSha ?? '').trim();
  if (!SHA_RE.test(baseSha)) {
    throw new Error(`baseSha 缺失或非法（options.patchBase 需 40/64 位 hex），拒绝供给 ${workspace}（repoId=${repoId}）`);
  }
  const taskSlug = taskSlugForWorkspace(root, workspace);
  if (!taskSlug) {
    throw new Error(`无法从围栏路径派生任务 slug，拒绝供给 ${workspace}`);
  }
  // Fail fast before any side effect: an illegal install list must refuse
  // the claim without cloning anything.
  const installs = resolveProvisionInstalls(repoId, entry, opts);
  const branch = `task/${taskSlug}`;
  const mkdir = opts.mkdir ?? ((dir) => fs.mkdirSync(dir, { recursive: true }));
  const runGit = opts.runGit ?? defaultRunGit;
  const runNpm = opts.runNpm ?? defaultRunNpm;
  // String-level containment already passed, so creating the parent chain
  // cannot write outside the fence; the post-clone realpath check in
  // worker.mjs re-verifies the tree itself.
  mkdir(dirnameOf(workspace));
  runGit(['clone', '--reference-if-able', mirror, url, workspace]);
  runGit(['checkout', baseSha], workspace);
  runGit(['checkout', '-b', branch], workspace);
  const installed = [];
  try {
    for (const dir of installs) {
      const cwd = joinOf(workspace, dir);
      const lockfile = joinOf(workspace, dir, 'package-lock.json');
      // npm ci is strict and reproducible; without a lockfile (worker/ ships
      // zero deps and no lockfile) a plain install must not write one —
      // an untracked package-lock.json would trip the merge Gate0
      // "validation dirtied the workspace" check. node_modules/ is gitignored.
      const args = exists(lockfile)
        ? ['ci', '--no-audit', '--no-fund']
        : ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund'];
      runNpm(args, cwd);
      installed.push(dir);
    }
  } catch (error) {
    // Leave no half-supplied tree behind: the next claim must see "missing"
    // and retry supply from scratch instead of spawning into a clone
    // without dependencies.
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch { /* cleanup is best-effort; the throw below carries the reason */ }
    throw new Error(`provision 依赖安装失败（repoId=${repoId}），拒绝供给 ${workspace}：${String(error?.message ?? error).slice(-1500)}`);
  }
  return { provisioned: true, workspace, branch, baseSha, repoId, installed };
}
