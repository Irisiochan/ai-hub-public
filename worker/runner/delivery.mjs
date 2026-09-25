import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_RECONCILE_GRACE_MS = 10 * 60_000;
export const MAX_RECEIPT_CHANGED_FILES = 50;
/** O6: per-file and total caps for runner self-written scratch receipts. */
export const SCRATCH_MAX_FILES = 5;
export const SCRATCH_MAX_BYTES = 20_000;

/**
 * O6: runner self-written receipt directory. Runners write their own receipt
 * backup here (local disk, no vault round-trip) instead of
 * tasks/worker-tail-<jobId>.md. `localAppData` override exists for tests.
 */
export function scratchDirForJob(jobId, localAppData) {
  const safeId = String(jobId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100) || 'unknown';
  const base = typeof localAppData === 'string' && localAppData
    ? localAppData
    : process.env.LOCALAPPDATA;
  if (base) return path.join(base, 'ai-hub-worker', 'scratch', safeId);
  return path.join(os.tmpdir(), 'ai-hub-worker-scratch', safeId);
}

/**
 * O6: collect runner self-written scratch receipts. Returns at most
 * SCRATCH_MAX_FILES text files (SCRATCH_MAX_BYTES total); binary/oversized
 * entries are skipped with a placeholder note.
 */
export async function readScratchReceipts(scratchDir) {
  const collected = [];
  let entries;
  try {
    entries = await fsp.readdir(scratchDir, { withFileTypes: true });
  } catch {
    return collected;
  }
  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
    .slice(0, SCRATCH_MAX_FILES);
  let remaining = SCRATCH_MAX_BYTES;
  for (const name of files) {
    if (remaining <= 0) break;
    try {
      const full = path.join(scratchDir, name);
      const stat = await fsp.stat(full);
      if (!stat.isFile() || stat.size > 100_000) {
        collected.push({ name, skipped: 'oversized/non-file' });
        continue;
      }
      const raw = await fsp.readFile(full, 'utf8');
      const slice = raw.slice(0, remaining);
      remaining -= slice.length;
      collected.push({ name, content: slice });
    } catch {
      collected.push({ name, skipped: 'unreadable' });
    }
  }
  return collected;
}

/** O6: render collected scratch receipts as a receipt-text section. */
export function formatScratchSection(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const parts = ['【runner 自写回执】（本地 scratch，非 vault）'];
  for (const entry of entries) {
    if (entry.skipped) {
      parts.push(`- ${entry.name}：（跳过：${entry.skipped}）`);
    } else {
      parts.push(`--- ${entry.name} ---`, entry.content);
    }
  }
  return parts.join('\n');
}

function runGit(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks = [];
    let settled = false;
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('error', () => {
      settled = true;
      resolve(null);
    });
    child.once('close', (code) => {
      if (settled) return;
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

function normalizeChangedFiles(value) {
  const rawFiles = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray(value.files) ? value.files : [];
  const files = [...new Set(rawFiles
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().replaceAll('\\', '/'))
    .filter(Boolean))];
  const declaredTotal = value && typeof value === 'object' && Number.isSafeInteger(value.total)
    ? Math.max(Number(value.total), files.length)
    : files.length;
  const total = Math.max(declaredTotal, files.length);
  return {
    files: files.slice(0, MAX_RECEIPT_CHANGED_FILES),
    total,
    truncated: total > MAX_RECEIPT_CHANGED_FILES || files.length > MAX_RECEIPT_CHANGED_FILES
      || (value && typeof value === 'object' && value.truncated === true),
  };
}

function normalizeTestConclusions(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const suite = typeof item.suite === 'string' ? item.suite.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    const rawStatus = typeof item.status === 'string'
      ? item.status.trim().toLowerCase()
      : typeof item.pass === 'boolean' ? (item.pass ? 'pass' : 'fail') : '';
    if (!suite || !['pass', 'fail'].includes(rawStatus)) return [];
    const detail = typeof item.detail === 'string' ? item.detail.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
    return [{ suite, status: rawStatus, ...(detail ? { detail } : {}) }];
  }).slice(0, 100);
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
  const [head, status, diff, aheadRaw, behindRaw, branchRaw, statusShortRaw] = await Promise.all([
    runGit(cwd, ['rev-parse', 'HEAD']),
    runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    runGit(cwd, ['diff', '--binary', 'HEAD']),
    runGit(cwd, ['rev-list', '--count', '@{upstream}..HEAD']),
    runGit(cwd, ['rev-list', '--count', 'HEAD..@{upstream}']),
    runGit(cwd, ['branch', '--show-current']),
    // O6: human-readable short status for blocked_local_changes receipt text
    // (the -z form above feeds dirtyFiles; this one feeds the 正文清单).
    runGit(cwd, ['status', '--short', '--untracked-files=all']),
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
    // Capped human-readable listing; null when git gave none.
    statusShort: capStatusShort(statusShortRaw),
    ahead: aheadRaw === null ? null : Number(aheadRaw.trim()) || 0,
    behind: behindRaw === null ? null : Number(behindRaw.trim()) || 0,
    branch: branchRaw?.trim() || null,
    fingerprint,
  };
}

/** O6: cap the human-readable status listing (80 lines / 6000 chars). */
export function capStatusShort(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const kept = lines.slice(0, 80).join('\n').slice(0, 6000);
  const truncated = lines.length > 80 || raw.length > 6000;
  return truncated ? `${kept}\n…（截断，共 ${lines.length} 行）` : kept;
}

/**
 * O6: blocked_local_changes receipt-text section. Carries the
 * `git status --short`原文 plus the parsed dirtyFiles list so reviewers and
 * the room controller can resume without asking the runner to re-report.
 */
export function formatLocalChangesSection(after) {
  const files = Array.isArray(after?.dirtyFiles) ? after.dirtyFiles.filter(Boolean) : [];
  if (!after && files.length === 0) return '';
  const short = typeof after?.statusShort === 'string' && after.statusShort.trim()
    ? after.statusShort
    : files.length ? files.map((file) => `?? ${file}`).join('\n') : '';
  if (!short && files.length === 0) return '';
  return [
    '【本地改动清单】（git status --short；blocked_local_changes）',
    short || '（工作区已干净：改动可能已被后续提交收走，按 reconcile 流程认领）',
    `dirtyFiles（${files.length}）：${files.slice(0, 50).join(', ') || '（无）'}`,
  ].join('\n');
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
    'waiting_review',
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
  const diffstat = typeof value.diffstat === 'string'
    ? value.diffstat.replace(/\s+/g, ' ').trim().slice(0, 1000)
    : '';
  const changedFiles = normalizeChangedFiles(value.changedFiles ?? value.changed_files);
  const tests = normalizeTestConclusions(value.tests ?? value.testResults ?? value.test_results);
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
    ...(diffstat ? { diffstat } : {}),
    ...(changedFiles.total > 0 ? { changedFiles } : {}),
    ...(tests.length > 0 ? { tests } : {}),
  };
}

/** Default-branch refs a job branch is measured against when the pre-job HEAD
 * is not an ancestor of the post-job HEAD (the job switched branches). */
export const PATCH_BASE_REFS = ['origin/master', 'origin/main'];

/**
 * Which commit the receipt diff is measured from. A round that continues on
 * the same line of history diffs from the pre-job HEAD ('round'). When the
 * job switched branches (2026-09-15 job e1755b61: pre-job HEAD sat on an
 * unrelated task branch, so before..after reported 44 files / 4079 deletions
 * for a six-file commit), the base is the merge-base with the default branch
 * ('branch-base'), so the receipt describes the candidate itself. If no
 * default-branch ref resolves, the pre-job HEAD stays the base and the kind
 * is flagged 'cross-branch' so reviewers know the numbers span branches.
 */
export async function resolvePatchBase(cwd, beforeHead, afterHead) {
  if (await isGitAncestor(cwd, beforeHead, afterHead)) return { sha: beforeHead, kind: 'round' };
  for (const ref of PATCH_BASE_REFS) {
    const base = await runGit(cwd, ['merge-base', ref, afterHead]);
    const sha = base?.trim();
    if (sha && /^[0-9a-f]{40}$/i.test(sha)) return { sha, kind: 'branch-base', ref };
  }
  return { sha: beforeHead, kind: 'cross-branch' };
}

/** Fork point of `commit` from the default branch; null when no trunk ref resolves. */
async function trunkForkPoint(cwd, commit) {
  for (const ref of PATCH_BASE_REFS) {
    const sha = (await runGit(cwd, ['merge-base', ref, commit]))?.trim().toLowerCase();
    if (sha && /^[0-9a-f]{40}$/.test(sha)) return { sha, ref };
  }
  return null;
}

// Same idea as `git patch-id`: blob ids and hunk positions move with the base,
// the changed lines themselves do not.
function patchIdentity(patch) {
  return patch.split('\n')
    .filter((line) => !line.startsWith('index '))
    .map((line) => line.startsWith('@@') ? '@@' : line)
    .join('\n');
}

/**
 * A rebase round (2026-09-21 task ai-hub-room-workflow-doc-batch1: merge-stale
 * sent a one-file docs candidate back for a rebase). The old candidate is not
 * an ancestor of the new HEAD, so `since..HEAD` would be trunk noise. Compare
 * what each candidate adds on top of its own trunk fork point instead:
 * identical means a clean replay (empty delta, 'rebase-identical'); otherwise
 * the delta is `git range-diff` of the two series. Null when there is no trunk
 * ref or either side is not a branch off it.
 */
async function rebaseDelta(cwd, since, head) {
  const [oldFork, newFork] = await Promise.all([trunkForkPoint(cwd, since), trunkForkPoint(cwd, head)]);
  if (!oldFork || !newFork || oldFork.sha === since || newFork.sha === head) return null;
  const [oldPatch, newPatch] = await Promise.all([
    runGit(cwd, ['diff', '--no-color', '--no-ext-diff', oldFork.sha, since]),
    runGit(cwd, ['diff', '--no-color', '--no-ext-diff', newFork.sha, head]),
  ]);
  if (oldPatch === null || newPatch === null) return null;
  if (patchIdentity(oldPatch) === patchIdentity(newPatch)) return { delta: '', kind: 'rebase-identical' };
  const rangeDiff = await runGit(cwd, ['range-diff', '--no-color', `${oldFork.sha}..${since}`, `${newFork.sha}..${head}`]);
  return rangeDiff === null ? null : { delta: rangeDiff, kind: 'rebase-range-diff' };
}

/**
 * Build the one structured receipt source. Git facts are collected by the thin
 * harness; test conclusions are transported from the runner declaration
 * without model summarization.
 */
export async function collectStructuredReceipt(cwd, before, after, declaration, requestedPatchBase, requestedPatchSince) {
  const normalized = normalizeDeliveryDeclaration(declaration) ?? {};
  let diffstat = '';
  let changedFiles = [];
  let rawPatch = null;
  let patchBase = null;
  if (before?.head && after?.head && before.head !== after.head) {
    patchBase = await resolvePatchBase(cwd, before.head, after.head);
  }
  if (patchBase && patchBase.sha !== after.head) {
    const [rawDiffstat, rawFiles, patchText] = await Promise.all([
      runGit(cwd, ['diff', '--shortstat', patchBase.sha, after.head]),
      runGit(cwd, ['diff', '--name-only', '-z', patchBase.sha, after.head]),
      runGit(cwd, ['diff', '--no-color', '--no-ext-diff', patchBase.sha, after.head]),
    ]);
    diffstat = rawDiffstat?.replace(/\s+/g, ' ').trim() ?? '';
    changedFiles = rawFiles ? rawFiles.split('\0').filter(Boolean) : [];
    rawPatch = patchText;
  } else if (after?.dirty) {
    const [rawDiffstat, patchText] = await Promise.all([
      runGit(cwd, ['diff', '--shortstat', 'HEAD']),
      runGit(cwd, ['diff', '--no-color', '--no-ext-diff', 'HEAD']),
    ]);
    diffstat = rawDiffstat?.replace(/\s+/g, ' ').trim() ?? '';
    changedFiles = after.dirtyFiles ?? [];
    rawPatch = patchText;
  }

  // Statistics describe this attempt; only the review patch is cumulative.
  let patchBaseFallback = null;
  if (requestedPatchBase != null) {
    const valid = typeof requestedPatchBase === 'string' && /^[0-9a-f]{40}$/i.test(requestedPatchBase);
    const commit = valid ? await runGit(cwd, ['rev-parse', '--verify', `${requestedPatchBase}^{commit}`]) : null;
    // After a rebase the branch forks from a newer trunk commit than the task
    // baseline; diffing from the baseline would hand reviewers everyone else's
    // merged work (15 files / 39k chars for a one-file candidate). The fork
    // point is then the base: fork..HEAD is exactly what a ff merge adds.
    let cumulativeBase = { sha: requestedPatchBase, kind: 'task-baseline' };
    const fork = commit && after?.head ? await trunkForkPoint(cwd, after.head) : null;
    if (fork && fork.sha !== after.head && fork.sha !== requestedPatchBase.toLowerCase()
      && await isGitAncestor(cwd, requestedPatchBase, fork.sha)) {
      cumulativeBase = { sha: fork.sha, kind: 'task-baseline-rebased' };
    }
    const cumulative = commit && after?.head
      ? await runGit(cwd, ['diff', '--no-color', '--no-ext-diff', cumulativeBase.sha, after.head]) : null;
    if (cumulative !== null) {
      rawPatch = cumulative;
      patchBase = cumulativeBase;
    } else {
      patchBaseFallback = valid ? 'task baseline unavailable; using round diff' : 'invalid task baseline; using round diff';
    }
  }
  const declaredFiles = normalized.changedFiles ?? null;
  const files = changedFiles.length > 0
    ? normalizeChangedFiles(changedFiles)
    : declaredFiles;
  // P3 review delta: an extra `patchSince..HEAD` diff so reviewers read the
  // increment since the last pinned candidate instead of re-reading the
  // cumulative patch. Same char cap as the cumulative patch; any unusable
  // base falls back to "no delta" with a marker — never throws.
  let rawDelta = null;
  let patchDeltaBase = null;
  let patchDeltaKind = null;
  let patchSinceFallback = null;
  if (requestedPatchSince != null) {
    const since = typeof requestedPatchSince === 'string' ? requestedPatchSince.trim().toLowerCase() : '';
    const valid = /^[0-9a-f]{40}$/i.test(since);
    const commit = valid ? await runGit(cwd, ['rev-parse', '--verify', `${since}^{commit}`]) : null;
    if (!commit) {
      patchSinceFallback = valid ? 'candidate baseline unavailable; no delta collected' : 'invalid candidate baseline; no delta collected';
    } else if (!after?.head) {
      patchSinceFallback = 'no HEAD; no delta collected';
    } else if (!(await isGitAncestor(cwd, since, after.head))) {
      const rebased = await rebaseDelta(cwd, since, after.head);
      if (rebased) {
        rawDelta = rebased.delta;
        patchDeltaBase = since;
        patchDeltaKind = rebased.kind;
      } else {
        patchSinceFallback = 'candidate baseline is not an ancestor of HEAD; no delta collected';
      }
    } else {
      const deltaText = await runGit(cwd, ['diff', '--no-color', '--no-ext-diff', since, after.head]);
      if (deltaText === null) {
        patchSinceFallback = 'delta collection failed; no delta collected';
      } else {
        rawDelta = deltaText;
        patchDeltaBase = since;
      }
    }
  }
  return {
    branch: after?.branch ?? null,
    head: after?.head ?? null,
    diffstat: diffstat || normalized.diffstat || null,
    changedFiles: files?.total > 0 ? files : null,
    tests: normalized.tests ?? [],
    ...(patchBase ? { patchBase: patchBase.sha, patchBaseKind: patchBase.kind } : {}),
    ...(patchBaseFallback ? { patchBaseFallback, requestedPatchBase: String(requestedPatchBase).slice(0, 80) } : {}),
    ...(rawPatch ? {
      patch: rawPatch.slice(0, RECEIPT_PATCH_MAX_CHARS),
      patchChars: rawPatch.length,
      patchTruncated: rawPatch.length > RECEIPT_PATCH_MAX_CHARS,
    } : {}),
    ...(rawDelta !== null ? {
      patchDelta: rawDelta.slice(0, RECEIPT_PATCH_MAX_CHARS),
      patchDeltaChars: rawDelta.length,
      patchDeltaTruncated: rawDelta.length > RECEIPT_PATCH_MAX_CHARS,
      patchDeltaBase,
      ...(patchDeltaKind ? { patchDeltaKind } : {}),
    } : {}),
    ...(patchSinceFallback ? { patchSinceFallback, requestedPatchSince: String(requestedPatchSince).slice(0, 80) } : {}),
  };
}

/** Raw diff travels with the receipt so reviewers never depend on model retelling. */
export const RECEIPT_PATCH_MAX_CHARS = 600_000;

function usageNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageFromObject(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const pick = (...keys) => {
    for (const key of keys) {
      const hit = usageNumber(node[key]);
      if (hit !== null) return hit;
    }
    return null;
  };
  const input = pick('input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens');
  const output = pick('output_tokens', 'completion_tokens', 'outputTokens', 'completionTokens');
  if (input === null || output === null) return null;
  let cache = pick(
    'cache_read_input_tokens', 'cached_input_tokens', 'prompt_cache_hit_tokens',
    'cacheReadTokens', 'cachedInputTokens',
  );
  if (cache === null) {
    const details = node.prompt_tokens_details ?? node.promptTokensDetails;
    if (details && typeof details === 'object' && !Array.isArray(details)) {
      cache = usageNumber(details.cached_tokens ?? details.cachedTokens);
    }
  }
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cache !== null ? { cacheReadTokens: cache } : {}),
  };
}

/**
 * P1 cost ledger: pull runner-reported token usage out of one streamed JSON
 * line. Shape-based (never fabricated): claude stream-json `result.usage`
 * (input_tokens/output_tokens/cache_read_input_tokens, cf server
 * claudeCli.ts), codex exec --json usage blocks, and the OpenAI/Gemini
 * prompt/completion/cached shapes. Returns null when the line carries no
 * usable usage — the caller keeps the field empty. Not live-verified per
 * runner here (no runner credentials in this environment); see RECEIPT.
 */
export function extractRunnerUsage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  // OpenCode `run --format json` (observed 1.18.29): one step_finish per model
  // step, `part.tokens = { input, output, reasoning, cache: { read, write } }`.
  // These are per-step, not cumulative, so the caller must sum them.
  if (data.type === 'step_finish') {
    const tokens = data.part?.tokens;
    const input = usageNumber(tokens?.input);
    const output = usageNumber(tokens?.output);
    if (input === null || output === null) return null;
    const cache = usageNumber(tokens?.cache?.read);
    return {
      inputTokens: input,
      outputTokens: output + (usageNumber(tokens?.reasoning) ?? 0),
      ...(cache !== null ? { cacheReadTokens: cache } : {}),
      perStep: true,
    };
  }
  const direct = usageFromObject(data.usage);
  if (direct) return direct;
  for (const key of ['result', 'message', 'item', 'data', 'delta', 'output']) {
    const node = data[key];
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    const nested = usageFromObject(node.usage ?? node.message?.usage ?? node);
    if (nested) return nested;
  }
  return null;
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
    // OpenCode streams final text as {type:'text', part:{text}}.
    for (const key of ['content', 'message', 'result', 'output', 'text', 'part']) {
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

function declarationResult(before, after, exitCode, declaration, deliveryMode) {
  if (!declaration) return null;
  // A read-only/evidence round honestly declaring committed=false has nothing
  // to deliver when git confirms the workspace is untouched.
  const untouched = Boolean(before && after
    && before.head === after.head && before.fingerprint === after.fingerprint);
  const state = declaration.committed
    ? declaration.pushed ? 'delivered' : 'blocked_unpushed'
    : !declaration.pushed && untouched ? 'delivered' : 'blocked_local_changes';
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
  const declared = declarationResult(before, after, exitCode, declaration, deliveryMode);
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
