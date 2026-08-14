import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_RECONCILE_GRACE_MS = 10 * 60_000;

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
  const [head, status, diff, aheadRaw, behindRaw, branchRaw] = await Promise.all([
    runGit(cwd, ['rev-parse', 'HEAD']),
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    runGit(cwd, ['diff', '--binary', 'HEAD']),
    runGit(cwd, ['rev-list', '--count', '@{upstream}..HEAD']),
    runGit(cwd, ['rev-list', '--count', 'HEAD..@{upstream}']),
    runGit(cwd, ['branch', '--show-current']),
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
    behind: behindRaw === null ? null : Number(behindRaw.trim()) || 0,
    branch: branchRaw?.trim() || null,
    fingerprint,
  };
}

export function repoDeliveryEvidence(before, after) {
  return {
    git: after ? {
      head: after.head,
      dirty: after.dirty,
      dirtyFiles: [...after.dirtyFiles],
      ahead: after.ahead ?? null,
      behind: after.behind ?? null,
      branch: after.branch ?? null,
    } : null,
    before: before ? {
      head: before.head,
      dirty: before.dirty,
      ahead: before.ahead ?? null,
    } : null,
  };
}

function normalizeDeliveryDeclaration(value) {
  if (!value || typeof value !== 'object') return null;
  const { committed, pushed } = value;
  if (typeof committed !== 'boolean' || typeof pushed !== 'boolean') return null;
  if (pushed && !committed) return null;
  const allowedStages = new Set([
    'delivered_waiting_deploy',
    'online_waiting_validation',
    'closed_loop',
    'user_decision',
    'rework_required',
  ]);
  const stage = typeof value.stage === 'string'
    ? value.stage.trim().toLowerCase().replace(/-/g, '_')
    : '';
  const summary = typeof value.summary === 'string' ? value.summary.trim().slice(0, 500) : '';
  const nextOwner = typeof value.nextOwner === 'string'
    ? value.nextOwner.trim().slice(0, 100)
    : typeof value.next_owner === 'string' ? value.next_owner.trim().slice(0, 100) : '';
  const blocker = typeof value.blocker === 'string' ? value.blocker.trim().slice(0, 100) : '';
  return {
    committed,
    pushed,
    ...(allowedStages.has(stage) ? { stage } : {}),
    ...(summary ? { summary } : {}),
    ...(nextOwner ? { nextOwner } : {}),
    ...(value.needsUserDecision === true || value.needs_user_decision === true
      ? { needsUserDecision: true }
      : {}),
    ...(blocker ? { blocker } : {}),
  };
}

export function extractDeliveryDeclaration(value) {
  if (Array.isArray(value)) {
    for (const item of [...value].reverse()) {
      const declaration = extractDeliveryDeclaration(item);
      if (declaration) return declaration;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const direct = normalizeDeliveryDeclaration(value.delivery);
    if (direct) return direct;
    for (const key of ['content', 'message', 'result', 'output', 'text']) {
      const declaration = extractDeliveryDeclaration(value[key]);
      if (declaration) return declaration;
    }
  }
  if (typeof value !== 'string') return null;

  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of value.matchAll(fenced)) candidates.push(match[1]);

  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }
  candidates.push(...value.split(/\r?\n/), value);
  for (const rawCandidate of candidates.reverse()) {
    const candidate = rawCandidate.trim();
    if (!candidate || candidate === '```' || candidate.startsWith('```')) continue;
    try {
      const parsed = JSON.parse(candidate);
      const declaration = extractDeliveryDeclaration(parsed);
      if (declaration) return declaration;
    } catch {}
  }
  return null;
}

function declarationResult(after, exitCode, declaration, deliveryMode) {
  if (!declaration) return null;
  const state = declaration.committed
    ? declaration.pushed ? 'delivered' : 'blocked_unpushed'
    : 'blocked_local_changes';
  return {
    state,
    changed: declaration.committed || !declaration.pushed,
    dirtyFiles: state === 'blocked_local_changes' ? (after?.dirtyFiles ?? []) : [],
    head: after?.head ?? null,
    ahead: after?.ahead ?? null,
    deliveryMode,
    source: 'cli',
    declared: declaration,
    ...(exitCode !== 0 ? { runnerExitCode: exitCode } : {}),
  };
}

export function classifyDelivery(before, after, exitCode, options = {}) {
  const deliveryMode = options.deliveryMode === 'trust-cli' ? 'trust-cli' : 'git-check';
  const declaration = normalizeDeliveryDeclaration(options.declaration);
  const declared = declarationResult(after, exitCode, declaration, deliveryMode);
  if (declared) return declared;
  if (deliveryMode === 'trust-cli') {
    return {
      state: exitCode === 0 ? 'delivered' : 'failed_clean',
      changed: false,
      dirtyFiles: [],
      head: after?.head ?? null,
      ahead: after?.ahead ?? null,
      deliveryMode,
      source: declaration ? 'exit-code' : 'trust-cli',
      ...(declaration ? { declared: declaration } : {}),
    };
  }
  if (!after) {
    return {
      state: exitCode === 0 ? 'unknown' : 'failed_clean',
      changed: false,
      dirtyFiles: [],
      head: null,
      ahead: null,
      deliveryMode,
      source: 'git',
    };
  }
  const changed = !before
    || before.head !== after.head
    || before.fingerprint !== after.fingerprint;
  const beforeDirtyFiles = new Set(before?.dirtyFiles ?? []);
  const jobDirtyFiles = after.dirtyFiles.filter((file) => !beforeDirtyFiles.has(file));
  if (changed && jobDirtyFiles.length > 0) {
    return {
      state: 'blocked_local_changes',
      changed,
      dirtyFiles: jobDirtyFiles,
      head: after.head,
      ahead: after.ahead,
      deliveryMode,
      source: 'git',
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
      deliveryMode,
      source: 'git',
    };
  }
  return {
    state: exitCode === 0 ? 'delivered' : 'failed_clean',
    changed,
    dirtyFiles: after.dirtyFiles,
    head: after.head,
    ahead: after.ahead,
    deliveryMode,
    source: 'git',
  };
}

export function deliveryCompletesJob(delivery, exitCode) {
  return exitCode === 0 || (delivery?.state === 'delivered' && delivery?.source === 'cli');
}

export function reconciliationDecision(delivery, current, ancestorIncluded, options = {}) {
  if (!delivery || !['blocked_local_changes', 'blocked_unpushed'].includes(delivery.state)) {
    return { ready: false, reason: 'unsupported delivery state' };
  }
  if (!current) return { ready: false, reason: 'workspace is not a git repository' };
  if (current.dirty) return { ready: false, reason: 'workspace still has local changes' };
  if (current.ahead === null) return { ready: false, reason: 'workspace has no upstream' };
  if (current.ahead !== 0) return { ready: false, reason: 'workspace still has unpushed commits' };
  const graceMs = Number.isFinite(options.graceMs)
    ? Math.max(Number(options.graceMs), 0)
    : DEFAULT_RECONCILE_GRACE_MS;
  const blockedForMs = Number.isFinite(options.blockedForMs)
    ? Math.max(Number(options.blockedForMs), 0)
    : 0;
  if (blockedForMs >= graceMs) {
    return {
      ready: true,
      mode: 'clean-timeout-fallback',
      reason: `workspace stayed blocked for ${Math.floor(blockedForMs / 60_000)}m and is now clean and synchronized`,
    };
  }
  if (!delivery.head || !ancestorIncluded) {
    return { ready: false, reason: 'blocked commit is not in current history' };
  }
  if (delivery.state === 'blocked_local_changes' && current.head === delivery.head) {
    return { ready: false, reason: 'local changes disappeared without a follow-up commit' };
  }
  return {
    ready: true,
    mode: 'git-history',
    reason: 'follow-up commit is clean, retained, and synchronized upstream',
  };
}
