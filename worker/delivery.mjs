import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('error', () => resolve(null));
    child.once('exit', (code) => {
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null);
    });
  });
}

export async function isGitAncestor(cwd, ancestor, descendant = 'HEAD') {
  if (typeof ancestor !== 'string' || !/^[0-9a-f]{7,64}$/i.test(ancestor)) return false;
  const result = await runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return result !== null;
}

function statusFiles(raw) {
  return raw
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.length > 3 ? entry.slice(3) : entry)
    .filter(Boolean);
}

function untrackedFingerprint(cwd, rawStatus) {
  const bits = [];
  for (const entry of rawStatus.split('\0').filter((item) => item.startsWith('?? '))) {
    const relative = entry.slice(3);
    try {
      const stat = fs.statSync(path.resolve(cwd, relative));
      bits.push(`${relative}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      bits.push(`${relative}:missing`);
    }
  }
  return bits.sort().join('\n');
}

export async function snapshotRepo(cwd) {
  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside?.trim() !== 'true') return null;
  const [head, status, diff, aheadRaw] = await Promise.all([
    runGit(cwd, ['rev-parse', 'HEAD']),
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    runGit(cwd, ['diff', '--binary', 'HEAD']),
    runGit(cwd, ['rev-list', '--count', '@{upstream}..HEAD']),
  ]);
  if (head === null || status === null || diff === null) return null;
  const fingerprint = crypto
    .createHash('sha256')
    .update(status)
    .update('\0')
    .update(diff)
    .update('\0')
    .update(untrackedFingerprint(cwd, status))
    .digest('hex');
  return {
    head: head.trim(),
    dirty: status.length > 0,
    dirtyFiles: statusFiles(status),
    ahead: aheadRaw === null ? null : Number(aheadRaw.trim()) || 0,
    fingerprint,
  };
}

export function classifyDelivery(before, after, exitCode) {
  if (!after) {
    return {
      state: exitCode === 0 ? 'unknown' : 'failed_clean',
      changed: false,
      dirtyFiles: [],
      head: null,
      ahead: null,
    };
  }
  const changed = !before
    || before.head !== after.head
    || before.fingerprint !== after.fingerprint;
  if (changed && after.dirty) {
    return {
      state: 'blocked_local_changes',
      changed,
      dirtyFiles: after.dirtyFiles,
      head: after.head,
      ahead: after.ahead,
    };
  }
  const newUnpushedCommit = changed
    && before?.head !== after.head
    && (after.ahead === null || after.ahead > (before?.ahead ?? 0));
  if (newUnpushedCommit) {
    return {
      state: 'blocked_unpushed',
      changed,
      dirtyFiles: [],
      head: after.head,
      ahead: after.ahead,
    };
  }
  return {
    state: exitCode === 0 ? 'delivered' : 'failed_clean',
    changed,
    dirtyFiles: after.dirtyFiles,
    head: after.head,
    ahead: after.ahead,
  };
}

export function reconciliationDecision(delivery, current, ancestorIncluded) {
  if (!delivery || !['blocked_local_changes', 'blocked_unpushed'].includes(delivery.state)) {
    return { ready: false, reason: 'unsupported delivery state' };
  }
  if (!current) return { ready: false, reason: 'workspace is not a git repository' };
  if (current.dirty) return { ready: false, reason: 'workspace still has local changes' };
  if (current.ahead === null) return { ready: false, reason: 'workspace has no upstream' };
  if (current.ahead !== 0) return { ready: false, reason: 'workspace still has unpushed commits' };
  if (!delivery.head || !ancestorIncluded) {
    return { ready: false, reason: 'blocked commit is not in current history' };
  }
  if (delivery.state === 'blocked_local_changes' && current.head === delivery.head) {
    return { ready: false, reason: 'local changes disappeared without a follow-up commit' };
  }
  return { ready: true, reason: 'follow-up commit is clean, retained, and synchronized upstream' };
}
