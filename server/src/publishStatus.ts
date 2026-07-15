import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RepoPublishStatus {
  id: 'app' | 'memory';
  name: string;
  available: boolean;
  branch?: string;
  currentCommit?: string;
  remoteCommit?: string;
  matchesRemote?: boolean;
  dirty?: boolean;
  error?: string;
}

async function git(repoPath: string, args: string[], timeout = 5_000): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  return stdout.trim();
}

export async function inspectRepo(
  id: RepoPublishStatus['id'],
  name: string,
  repoPath: string | null
): Promise<RepoPublishStatus> {
  if (!repoPath) return { id, name, available: false, error: '未配置仓库路径' };
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    return { id, name, available: false, error: '仓库路径不可用' };
  }
  try {
    const [branch, currentCommit, porcelain] = await Promise.all([
      git(repoPath, ['branch', '--show-current']),
      git(repoPath, ['rev-parse', 'HEAD']),
      git(repoPath, ['status', '--porcelain']),
    ]);
    const ref = `refs/heads/${branch || 'master'}`;
    let remoteCommit = '';
    let remoteError = '';
    try {
      remoteCommit = (await git(repoPath, ['ls-remote', 'origin', ref], 8_000)).split(/\s+/)[0] ?? '';
      if (!remoteCommit) remoteError = `origin 没有 ${ref}`;
    } catch {
      remoteError = '远端检查失败（网络或 Git 凭据不可用）';
    }
    return {
      id,
      name,
      available: true,
      branch: branch || '(detached)',
      currentCommit,
      remoteCommit: remoteCommit || undefined,
      matchesRemote: remoteCommit ? currentCommit === remoteCommit : undefined,
      dirty: porcelain.length > 0,
      error: remoteError || undefined,
    };
  } catch {
    return {
      id,
      name,
      available: false,
      error: '仓库检查失败',
    };
  }
}
