/**
 * W3 VPS-default routing: baseline_sha defaults + PC-capability declarations.
 *
 * User 建账缺省 baseline_sha 时按顺序取：
 *   (a) 部署回执 `/var/lib/ai-hub/deploy-receipt.json` 的 commit —— 但必须先
 *       校验它是 `origin/master` 的祖先或等于 master，否则视为未部署的 SHA，
 *       回退 (b) 并记 `baseline-fallback` 事件；
 *   (b) `git ls-remote origin master`；
 *   两者都取不到才报错要求手填。
 *
 * 本模块的决策函数是纯的（readers 全部注入），单测不碰 git/文件；
 * 生产 readers 在文件底部，用 spawnSync + 文件读取实现。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type BaselineSource = 'manual' | 'deploy-receipt' | 'ls-remote';

/** PC-only 能力声明（建账请求体 + 表单字段名，snake_case 与现有风格一致）。 */
export const PC_CAPABILITIES = ['camera', 'taobao', 'ssh', 'win32'] as const;
export type PcCapability = (typeof PC_CAPABILITIES)[number];

const SHA40_RE = /^[0-9a-f]{40}$/i;
const SHA40_64_RE = /^[0-9a-f]{40,64}$/i;

/**
 * 归一化建账请求里的 PC 能力声明。接受 `{ needs_camera: true, ... }`
 * 形态；未知键忽略，返回命中的能力名（去重、按 PC_CAPABILITIES 定序）。
 */
export function parseNeedsPc(input: unknown): PcCapability[] {
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const out: PcCapability[] = [];
  for (const name of PC_CAPABILITIES) {
    if (record[`needs_${name}`] === true) out.push(name);
  }
  return out;
}

/** 从 task_path `tasks/<slug>.md` 取任务 slug；非法返回 null。 */
export function taskSlugOf(taskPath: string): string | null {
  const match = /^tasks\/([^/\\]{1,100})\.md$/i.exec(String(taskPath ?? '').trim());
  if (!match) return null;
  const slug = match[1].trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(slug) && !/^review-[0-9a-f]{7,64}$/i.test(slug)
    ? slug
    : null;
}

export interface BaselineReaders {
  /** 部署回执的 commit（小写）；缺文件/非法时返回 null。 */
  readReceiptCommit: () => string | null;
  /** 远端 master SHA（小写）；取不到时返回 null。 */
  readMasterSha: () => string | null;
  /** receipt 是否祖先或等于 master；git 失败一律按 false（fail closed）。 */
  isAncestorOrEqual: (receipt: string, master: string) => boolean;
}

export type BaselineResolution =
  | { ok: true; sha: string; source: Exclude<BaselineSource, 'manual'>; fellBackFromReceipt?: string }
  | { ok: false; error: string };

/**
 * 缺省 baseline 决策（调用方已确认：手动 SHA 为空且任务在 VPS 围栏内）。
 * - receipt 命中且为 master 祖先或等于 master → deploy-receipt；
 * - receipt 是未部署/非祖先 SHA → 回退 ls-remote（fellBackFromReceipt 带上原值，调用方记事件）；
 * - 两者都无 → error（要求手填）。
 * - receipt 有但 master 取不到 → 无法验证“已部署”，同样 error（fail closed）。
 */
export function resolveBaselineDefault(readers: BaselineReaders): BaselineResolution {
  const receipt = readers.readReceiptCommit();
  const master = readers.readMasterSha();
  if (receipt) {
    if (!master) {
      return {
        ok: false,
        error: '部署回执有 commit 但远端 master 不可读，无法验证它已部署；请手填 baseline_sha（目标仓库主干的 40 位 SHA）',
      };
    }
    if (receipt.toLowerCase() === master.toLowerCase()) {
      return { ok: true, sha: receipt.toLowerCase(), source: 'deploy-receipt' };
    }
    let ancestor = false;
    try {
      ancestor = readers.isAncestorOrEqual(receipt.toLowerCase(), master.toLowerCase());
    } catch {
      ancestor = false;
    }
    if (ancestor) {
      return { ok: true, sha: receipt.toLowerCase(), source: 'deploy-receipt' };
    }
    return { ok: true, sha: master.toLowerCase(), source: 'ls-remote', fellBackFromReceipt: receipt.toLowerCase() };
  }
  if (master) {
    return { ok: true, sha: master.toLowerCase(), source: 'ls-remote' };
  }
  return {
    ok: false,
    error: '取不到默认 baseline（部署回执与远端 master 均不可读）；请手填 baseline_sha（目标仓库主干的 40 位 SHA）',
  };
}

// ── production readers (git + file) ──────────────────────────────────────

function defaultReceiptFile(): string {
  return process.env.AI_HUB_DEPLOY_RECEIPT ?? '/var/lib/ai-hub/deploy-receipt.json';
}

/** 网关自身检出的仓库根目录：显式 env 优先，否则从本文件向上找 .git。 */
export function resolveBaselineRepoDir(explicit?: string): string {
  const env = typeof explicit === 'string' && explicit.trim()
    ? explicit.trim()
    : (process.env.AI_HUB_BASELINE_REPO_DIR ?? '').trim();
  if (env) return env;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    try {
      if (fs.statSync(path.join(dir, '.git')).isDirectory() || fs.statSync(path.join(dir, '.git')).isFile()) {
        return dir;
      }
    } catch { /* keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function readDeployReceiptCommit(receiptFile: string = defaultReceiptFile()): string | null {
  let raw = '';
  try {
    raw = fs.readFileSync(receiptFile, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const commit = (parsed as Record<string, unknown>).commit;
  if (typeof commit !== 'string' || !SHA40_64_RE.test(commit.trim())) return null;
  return commit.trim().toLowerCase();
}

function runGit(repoDir: string, args: string[], timeoutMs: number): { ok: boolean; stdout: string } {
  try {
    // The production checkout is owned by root while the gateway runs as ai-hub.
    // Trust only this explicitly selected checkout for read-only Git queries.
    const result = spawnSync('git', ['-c', `safe.directory=${path.resolve(repoDir)}`, ...args], { cwd: repoDir, encoding: 'utf8', timeout: timeoutMs });
    if (result.error) return { ok: false, stdout: '' };
    return { ok: result.status === 0, stdout: String(result.stdout ?? '') };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/** Offline fallback: accept the receipt only when the deployed checkout and
 * its deployment-maintained master ref both point at that exact commit. */
export function gitVerifiedLocalBaseline(repoDir: string, receipt: string | null): string | null {
  if (!receipt || !SHA40_RE.test(receipt)) return null;
  const head = runGit(repoDir, ['rev-parse', '--verify', 'HEAD'], 5_000);
  const master = runGit(repoDir, ['rev-parse', '--verify', 'refs/remotes/origin/master'], 5_000);
  const headSha = head.stdout.trim().toLowerCase();
  const masterSha = master.stdout.trim().toLowerCase();
  return head.ok && master.ok && headSha === receipt && masterSha === receipt ? receipt : null;
}

export function gitLsRemoteMaster(repoDir: string = resolveBaselineRepoDir()): string | null {
  const result = runGit(repoDir, ['ls-remote', 'origin', 'master'], 15_000);
  if (!result.ok) return null;
  const sha = result.stdout.split(/[\s\t]+/)[0]?.trim() ?? '';
  return SHA40_RE.test(sha) ? sha.toLowerCase() : null;
}

export function gitIsAncestorOrEqual(repoDir: string, receipt: string, master: string): boolean {
  if (!SHA40_64_RE.test(receipt) || !SHA40_RE.test(master)) return false;
  if (receipt.toLowerCase() === master.toLowerCase()) return true;
  const direct = runGit(repoDir, ['merge-base', '--is-ancestor', receipt, master], 15_000);
  if (direct.ok) return true;
  // master 对象本地可能没有（ls-remote 不带对象）：fetch 一次再判；
  // 仍失败则 fail closed（调用方回退 ls-remote）。
  const fetched = runGit(repoDir, ['fetch', 'origin', master], 30_000);
  if (!fetched.ok) return false;
  return runGit(repoDir, ['merge-base', '--is-ancestor', receipt, master], 15_000).ok;
}

/** 生产默认 readers：只在缺省 baseline 的建账路径上调用，无缓存。 */
export function productionBaselineReaders(options: { receiptFile?: string; repoDir?: string; repoId?: string } = {}): BaselineReaders {
  // This gateway checkout and deploy receipt describe ai-hub only. Other
  // repositories need their own verified source or an explicit manual SHA.
  if (options.repoId && options.repoId !== 'ai-hub') {
    return { readReceiptCommit: () => null, readMasterSha: () => null, isAncestorOrEqual: () => false };
  }
  const receiptFile = options.receiptFile ?? defaultReceiptFile();
  const repoDir = options.repoDir ?? resolveBaselineRepoDir();
  return {
    readReceiptCommit: () => readDeployReceiptCommit(receiptFile),
    readMasterSha: () => gitLsRemoteMaster(repoDir)
      ?? gitVerifiedLocalBaseline(repoDir, readDeployReceiptCommit(receiptFile)),
    isAncestorOrEqual: (receipt, master) => gitIsAncestorOrEqual(repoDir, receipt, master),
  };
}
