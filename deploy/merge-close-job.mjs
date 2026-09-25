#!/usr/bin/env node
// Linux/Node port of deploy/merge-close-job.ps1 (lane-A merge/push runner).
// Same gates: frozen SHA + baseline ancestry + clean tree + target drift +
// ff-only merge + validation set + push + remote SHA verification.
// This entry serves ai-hub and ai-dashboard repos via --repo / --repo-dir,
// plus any other repo carrying its own .ai-hub-merge.json manifest under
// --repo-dir (no --repo): explicit --repo keeps the built-in mapping, a
// manifest declares repoId/targetBranch/suites, otherwise ai-hub default.
// Usage:
//   node deploy/merge-close-job.mjs --frozen-sha <40hex> --release-evidence <json> \
//     --working-branch <name> [--baseline-sha <40hex>] [--remote origin] \
//     [--target-branch master] [--repo ai-hub] [--gateway-url <url>] \
//     [--env-file /etc/ai-dev-worker/deploy.env] \
//     [--repo-dir <path, required when --repo ai-dashboard>] [--auto-rebase]
//     [--review-patch-b64 <base64> --review-patch-sha256 <hex>] [--dry-run]

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_ENV_FILE, DEFAULT_HUB_URL, loadEnvFileValues } from './room-deploy-job.mjs';

const execFileAsync = promisify(execFile);
const ROOM_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
// Per-repo trunk, kept next to the per-repo validation suites below: both are
// facts about the repo the gate is judging.
const DEFAULT_TARGET_BRANCH_BY_REPO = {
  'ai-hub': 'master',
  'ai-dashboard': 'main',
};
const TASK_PATH_RE = /^tasks\/[^/\\]{1,100}\.md$/;

const SHA40_RE = /^[0-9a-fA-F]{40}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,120}$/;
const REMOTE_RE = /^[A-Za-z0-9._-]{1,80}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,80}$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;
// R3: in-repo merge manifest (<repo>/.ai-hub-merge.json). Only two commands
// may appear; args are spawned as an array (never re-shelled) and still
// reject newlines and `..` fail-closed.
const MERGE_MANIFEST_FILE = '.ai-hub-merge.json';
const MANIFEST_COMMANDS = new Set(['npm', 'node']);
const SUITE_RE = /^[A-Za-z0-9._: /-]{1,120}$/;
const MANIFEST_MAX_SUITES = 32;
// R2-D: same ceiling as the gateway (REVIEW_PATCH_MAX_CHARS). The script
// re-checks sha256 + size; file/sensitive/path gates stay server-side.
const REVIEW_PATCH_MAX_CHARS = 8000;

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseReviewPatchArgs(input) {
  const b64 = input.reviewPatchB64 ?? input.review_patch_b64 ?? input.reviewPatchB64Raw;
  const sha = input.reviewPatchSha256 ?? input.review_patch_sha256;
  const hasB64 = b64 !== undefined && b64 !== null && String(b64) !== '';
  const hasSha = sha !== undefined && sha !== null && String(sha) !== '';
  if (!hasB64 && !hasSha) return null;
  if (!hasB64 || !hasSha) {
    throw new Error('review patch requires both --review-patch-b64 and --review-patch-sha256');
  }
  const shaHex = String(sha).trim().toLowerCase();
  if (!SHA256_RE.test(shaHex)) throw new Error('review patch sha256 must be 64 hex chars');
  let text;
  try {
    text = Buffer.from(String(b64), 'base64').toString('utf8');
  } catch {
    throw new Error('review patch base64 does not decode');
  }
  if (!text || text.length > REVIEW_PATCH_MAX_CHARS) {
    throw new Error(`review patch size rejected: ${text?.length ?? 0} chars (limit ${REVIEW_PATCH_MAX_CHARS})`);
  }
  if (sha256Hex(text) !== shaHex) {
    throw new Error('review patch sha256 mismatch');
  }
  return { text, b64: String(b64), sha256: shaHex };
}

/** Patch-application failure: reported as patch:'failed' with a reason. */
export class ReviewPatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReviewPatchError';
    this.patchFailed = true;
  }
}

function validateRepoDir(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const dir = String(raw).trim();
  if (dir.includes('\0')) throw new Error('invalid repoDir');
  if (dir.length > 500) throw new Error('invalid repoDir');
  if (dir.startsWith('-')) throw new Error('invalid repoDir');
  return dir;
}

export function validateMergeArgs(input) {
  const frozenSha = String(input.frozenSha ?? '').toLowerCase();
  // Claimed baseline = the candidate job's before.head evidence baked at
  // release time. Optional and informational only: a rebase rewrites history,
  // so it is routinely NOT an ancestor of frozen. Recorded, never asserted.
  const baselineSha = String(input.baselineSha ?? '').toLowerCase();
  const workingBranch = String(input.workingBranch ?? '');
  const remote = String(input.remote ?? 'origin');
  // R3 priority: an explicit --repo wins and keeps the existing mapping
  // below (it never reads a manifest). Otherwise a repoDir carrying
  // .ai-hub-merge.json declares its own repoId/targetBranch/suites; with
  // neither, the historical ai-hub default applies byte-for-byte.
  const explicitRepoRaw = input.repoId ?? input.repo;
  const hasExplicitRepo = explicitRepoRaw !== undefined && explicitRepoRaw !== null
    && String(explicitRepoRaw).trim() !== '';
  const explicitTargetBranchRaw = input.targetBranch;
  // Present-but-empty keeps the historical verdict: String('') fails the
  // branch check below instead of silently becoming the default.
  const hasExplicitTarget = explicitTargetBranchRaw !== undefined && explicitTargetBranchRaw !== null;
  const explicitTargetBranch = hasExplicitTarget ? String(explicitTargetBranchRaw) : '';
  const repoDir = validateRepoDir(input.repoDir ?? input.repo_dir);
  const resolved = resolveMergeRepoConfig({
    explicitRepo: hasExplicitRepo ? String(explicitRepoRaw) : null,
    repoDir,
    explicitTargetBranch: hasExplicitTarget ? explicitTargetBranch : null,
  });
  const { repoId: normalizedRepo, targetBranch } = resolved;
  if (!SHA40_RE.test(frozenSha)) throw new Error('frozenSha must be a 40 character git SHA');
  if (baselineSha && !SHA40_RE.test(baselineSha)) {
    throw new Error('claimed baselineSha is not a 40 character git SHA');
  }
  if (!BRANCH_RE.test(workingBranch) || workingBranch.startsWith('-') || workingBranch.startsWith('/')
    || workingBranch.endsWith('/') || workingBranch.includes('..') || workingBranch.includes('//')) {
    throw new Error('invalid workingBranch');
  }
  if (!REMOTE_RE.test(remote) || remote.startsWith('-')) throw new Error('invalid remote');
  if (!BRANCH_RE.test(targetBranch) || targetBranch.startsWith('-') || targetBranch.startsWith('/')
    || targetBranch.endsWith('/') || targetBranch.includes('..') || targetBranch.includes('//')) {
    throw new Error('invalid targetBranch');
  }
  const repoDirValidated = repoDir;
  const releaseEvidence = parseReleaseEvidence(input.releaseEvidence ?? input.release_evidence, frozenSha);
  const gatewayUrl = String(input.gatewayUrl ?? input.gateway_url ?? '').trim().replace(/\/$/, '');
  const envFile = String(input.envFile ?? input.env_file ?? DEFAULT_ENV_FILE).trim() || DEFAULT_ENV_FILE;
  const reviewPatch = parseReviewPatchArgs(input);
  return {
    frozenSha, baselineSha, workingBranch, remote, targetBranch,
    repoId: normalizedRepo, repoDir: repoDirValidated, releaseEvidence, gatewayUrl, envFile,
    manifest: resolved.manifest === true,
    manifestCwd: resolved.manifestCwd ?? null,
    suites: resolved.suites,
    verifyToken: input.verifyToken ?? null,
    requireServerVerify: input.requireServerVerify === true,
    autoRebase: input.autoRebase === true,
    ...(reviewPatch ? {
      reviewPatchText: reviewPatch.text,
      reviewPatchB64: reviewPatch.b64,
      reviewPatchSha256: reviewPatch.sha256,
    } : {}),
  };
}

/**
 * Gate L, step 1 — local self-check of the --release-evidence argument.
 * release_execute bakes these facts from the ledger, but the argument itself
 * is only a claim, so this is a self-check, never the binding gate; the
 * binding check is verifyReleaseEvidence's bearer callback below.
 * Evidence is REQUIRED: a merge entry that can push master with no ledger
 * claim at all is exactly the fail-open gate WP-A closed on the ps1 side.
 */
export function parseReleaseEvidence(raw, frozenSha) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    throw new Error('releaseEvidence (--release-evidence) is required; refusing to merge without ledger evidence');
  }
  let evidence = raw;
  if (typeof raw === 'string') {
    try {
      evidence = JSON.parse(raw);
    } catch (error) {
      throw new Error(`releaseEvidence is not valid JSON: ${String(error.message ?? error).slice(0, 200)}`);
    }
  }
  if (!evidence || typeof evidence !== 'object') throw new Error('releaseEvidence must be a JSON object');
  const candidateSha = String(evidence.candidateSha ?? '').toLowerCase();
  if (candidateSha !== String(frozenSha ?? '').toLowerCase()) {
    throw new Error(`ledger self-check rejected: evidence candidate ${evidence.candidateSha} != frozen ${frozenSha}`);
  }
  const reviewStatus = String(evidence.reviewStatus ?? '');
  if (reviewStatus !== 'approved') {
    throw new Error(`ledger self-check rejected: review status '${reviewStatus}' is not approved`);
  }
  const taskPath = String(evidence.taskPath ?? '');
  if (!TASK_PATH_RE.test(taskPath)) {
    throw new Error(`ledger self-check rejected: bad task path '${taskPath}'`);
  }
  const roomId = String(evidence.roomId ?? '');
  if (roomId && !ROOM_ID_RE.test(roomId)) {
    throw new Error(`server re-verification rejected: bad room id '${roomId}'`);
  }
  return { candidateSha, reviewStatus, taskPath, roomId, reviewEvidenceId: evidence.reviewEvidenceId ?? null };
}

/**
 * Gate L, step 2 — server re-verification against the live ledger.
 *
 * Hard gate whenever the evidence carries a roomId (i.e. it came from
 * release_execute): no bearer, unreachable gateway, timeout, non-2xx, or a
 * body without task.candidate_sha all throw. Failing open here would let an
 * execution seat point --gateway-url at a dead address and merge anything.
 *
 * Bearer, in order: explicit verifyToken > AI_HUB_TOKEN in the process env >
 * AI_HUB_TOKEN in --env-file (default /etc/ai-dev-worker/deploy.env). There is
 * deliberately no Windows User-env store here: the VPS worker runs as a
 * nologin system user with no per-user environment to read.
 */
export async function verifyReleaseEvidence(args, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  fileValues,
  timeoutMs = 15_000,
} = {}) {
  const evidence = args.releaseEvidence;
  const gateway = (args.gatewayUrl || env.AI_HUB_URL || DEFAULT_HUB_URL).replace(/\/$/, '');
  if (!evidence.roomId) {
    if (args.requireServerVerify) {
      throw new Error('server re-verification rejected: evidence has no roomId (--require-server-verify)');
    }
    return { verified: false, gateway, reason: 'evidence has no roomId (local self-check only, not a hard gate)' };
  }
  const file = fileValues ?? loadEnvFileValues(args.envFile);
  const token = String(args.verifyToken || env.AI_HUB_TOKEN || file.AI_HUB_TOKEN || '');
  if (!token) {
    throw new Error(`server re-verification rejected: no bearer (AI_HUB_TOKEN in env or ${args.envFile})`);
  }
  const taskFile = evidence.taskPath.replace(/^tasks\//, '');
  const url = `${gateway}/api/room-tasks/${encodeURIComponent(evidence.roomId)}/${encodeURIComponent(taskFile)}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`server re-verification rejected: gateway ${gateway} failed: ${String(error.message ?? error).slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`server re-verification rejected: gateway ${gateway} answered HTTP ${response.status}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`server re-verification rejected: gateway ${gateway} returned a non-JSON ledger body`);
  }
  const liveCandidate = String(body?.task?.candidate_sha ?? '').toLowerCase();
  const liveReview = String(body?.task?.review_status ?? '');
  if (!liveCandidate) {
    throw new Error(`server re-verification rejected: gateway ${gateway} ledger returned no candidate_sha for this task`);
  }
  if (liveCandidate !== args.frozenSha) {
    throw new Error(`server re-verification rejected: ledger candidate ${liveCandidate} != frozen ${args.frozenSha}`);
  }
  if (liveReview !== 'approved') {
    throw new Error(`server re-verification rejected: ledger review status '${liveReview}' is not approved`);
  }
  return { verified: true, gateway, candidateSha: liveCandidate, reviewStatus: liveReview };
}

export const MERGE_VALIDATION_SUITES = [
  { suite: 'server npm run pretest', command: 'npm', args: ['run', 'pretest', '--prefix', 'server'] },
  { suite: 'server npm test', command: 'npm', args: ['test', '--prefix', 'server'] },
  { suite: 'web npm test', command: 'npm', args: ['test', '--prefix', 'web'] },
  { suite: 'smoke:deploy-drain', command: 'npm', args: ['run', 'smoke:deploy-drain', '--prefix', 'server'] },
  { suite: 'smoke:turn-timeouts', command: 'npm', args: ['run', 'smoke:turn-timeouts', '--prefix', 'server'] },
  { suite: 'smoke:deploy-resume', command: 'npm', args: ['run', 'smoke:deploy-resume', '--prefix', 'server'] },
];

// ai-dashboard validation set. The npm --prefix target is never hardcoded:
// callers must pass --repo-dir and it is threaded through here.
export function dashboardValidationSuites(repoDir) {
  const dir = validateRepoDir(repoDir);
  if (!dir) {
    throw new Error('repoDir (--repo-dir) is required for repo ai-dashboard; refusing to run with a hardcoded path');
  }
  return [
    { suite: 'ai-dashboard npm ci', command: 'npm', args: ['ci', '--prefix', dir] },
    { suite: 'ai-dashboard npm run typecheck', command: 'npm', args: ['run', 'typecheck', '--prefix', dir] },
    { suite: 'ai-dashboard npm test', command: 'npm', args: ['test', '--prefix', dir] },
    { suite: 'ai-dashboard npm run smoke', command: 'npm', args: ['run', 'smoke', '--prefix', dir] },
  ];
}

// G03 per-repo validation config. Each repo pins its own suite list; an
// unmapped repo throws instead of silently running another repo's suites.
const VALIDATION_SUITES_BY_REPO = {
  'ai-hub': MERGE_VALIDATION_SUITES,
};

export function mergeValidationSuitesForRepo(repoId, repoDir) {
  const raw = String(repoId ?? 'ai-hub').trim().toLowerCase() || 'ai-hub';
  if (raw === 'ai-dashboard') return dashboardValidationSuites(repoDir);
  const suites = VALIDATION_SUITES_BY_REPO[raw];
  if (!suites) {
    throw new Error(`no validation suites configured for repo: ${String(repoId ?? '').trim() || '(empty)'}; refusing to run another repo's suites`);
  }
  return suites;
}

// R3: in-repo merge manifest. A non-ai-hub checkout declares its own
// identity, trunk and validation set in <repoDir>/.ai-hub-merge.json:
//   {"repoId":"pet-daily","targetBranch":"master",
//    "validation":[{"suite":"npm test","command":"npm","args":["test"]}]}
// Anything malformed refuses the merge fail-closed: silently falling back to
// another repo's suites would validate the wrong thing and push anyway.
export function validateMergeManifest(obj, sourceLabel) {
  const label = String(sourceLabel ?? MERGE_MANIFEST_FILE);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`merge manifest ${label} must be a JSON object`);
  }
  const repoId = String(obj.repoId ?? '').trim();
  if (!REPO_RE.test(repoId)) {
    throw new Error(`merge manifest ${label}: repoId must match /^[A-Za-z0-9._-]{1,80}$/`);
  }
  const targetBranch = String(obj.targetBranch ?? '').trim();
  if (!BRANCH_RE.test(targetBranch) || targetBranch.startsWith('-') || targetBranch.startsWith('/')
    || targetBranch.endsWith('/') || targetBranch.includes('..') || targetBranch.includes('//')) {
    throw new Error(`merge manifest ${label}: invalid targetBranch`);
  }
  const validation = obj.validation;
  if (!Array.isArray(validation) || validation.length === 0 || validation.length > MANIFEST_MAX_SUITES) {
    throw new Error(`merge manifest ${label}: validation must be a non-empty array (max ${MANIFEST_MAX_SUITES})`);
  }
  const suites = validation.map((item, index) => {
    const where = `${label} validation[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`merge manifest ${where} must be an object`);
    }
    const suite = String(item.suite ?? '').trim();
    if (!SUITE_RE.test(suite)) {
      throw new Error(`merge manifest ${where}: suite must be 1-120 chars without newlines`);
    }
    const command = String(item.command ?? '').trim();
    if (!MANIFEST_COMMANDS.has(command)) {
      throw new Error(`merge manifest ${where}: command must be one of npm, node`);
    }
    const args = item.args;
    if (!Array.isArray(args) || args.length === 0 || args.length > 64) {
      throw new Error(`merge manifest ${where}: args must be a non-empty string array`);
    }
    for (const arg of args) {
      if (typeof arg !== 'string' || arg === '' || arg.length > 1000
        || arg.includes('\n') || arg.includes('\r') || arg.includes('\0') || arg.includes('..')) {
        throw new Error(`merge manifest ${where}: args entries must be strings without newlines or '..'`);
      }
    }
    return { suite, command, args: [...args] };
  });
  return { repoId: repoId.toLowerCase(), targetBranch, suites };
}

export function readMergeManifest(repoDir) {
  const dir = validateRepoDir(repoDir);
  if (!dir) return null;
  const manifestPath = path.join(dir, MERGE_MANIFEST_FILE);
  let text;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw new Error(`merge manifest ${manifestPath} is not readable: ${String(error.message ?? error).slice(0, 200)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`merge manifest ${manifestPath} is not valid JSON: ${String(error.message ?? error).slice(0, 200)}`);
  }
  return { ...validateMergeManifest(parsed, manifestPath), manifestPath, manifestCwd: dir };
}

/**
 * R3 repo resolution, single priority shared by both entries:
 * explicit --repo → the existing mapping (never a manifest); else
 * repoDir/.ai-hub-merge.json when present (invalid → throw, never fall
 * back); else the historical ai-hub default. An explicit --target-branch
 * always wins over the manifest and the per-repo default.
 */
export function resolveMergeRepoConfig({ explicitRepo = null, repoDir = null, explicitTargetBranch = null } = {}) {
  if (explicitRepo !== null && explicitRepo !== undefined && String(explicitRepo).trim() !== '') {
    const raw = String(explicitRepo).trim();
    if (!REPO_RE.test(raw)) throw new Error('invalid repoId');
    const normalizedRepo = raw.toLowerCase();
    const targetBranch = explicitTargetBranch
      ?? DEFAULT_TARGET_BRANCH_BY_REPO[normalizedRepo] ?? 'master';
    return {
      repoId: normalizedRepo, targetBranch,
      suites: mergeValidationSuitesForRepo(normalizedRepo, repoDir),
      manifest: false, manifestCwd: null,
    };
  }
  const dir = validateRepoDir(repoDir);
  if (dir) {
    const manifest = readMergeManifest(dir);
    if (manifest) {
      return {
        repoId: manifest.repoId,
        targetBranch: explicitTargetBranch ?? manifest.targetBranch,
        suites: manifest.suites, manifest: true, manifestCwd: manifest.manifestCwd,
      };
    }
  }
  return {
    repoId: 'ai-hub',
    targetBranch: explicitTargetBranch ?? DEFAULT_TARGET_BRANCH_BY_REPO['ai-hub'] ?? 'master',
    suites: MERGE_VALIDATION_SUITES, manifest: false, manifestCwd: null,
  };
}

async function git(args, exec = execFileAsync) {
  try {
    const { stdout } = await exec('git', args, { maxBuffer: 16 * 1024 * 1024 });
    return String(stdout ?? '').trim();
  } catch (error) {
    throw new Error(`git ${args.join(' ')} failed: ${String(error.stderr ?? error.message ?? error).slice(0, 2000)}`);
  }
}

async function isAncestor(ancestor, descendant, exec) {
  try {
    await exec('git', ['merge-base', '--is-ancestor', ancestor, descendant], { maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/** Thrown for a candidate master has moved past: machine-readable, never a
 * push. The gateway auto-passes the task back to execute with a rebase note. */
export class StaleCandidateError extends Error {
  constructor(taskPath, frozen, masterSha, targetBranch) {
    super(`stale candidate: ${targetBranch}=${masterSha} is not an ancestor of frozen ${frozen}; rebase onto ${masterSha}`);
    this.name = 'StaleCandidateError';
    this.stale = true;
    this.taskPath = taskPath;
    this.frozen = frozen;
    this.masterSha = masterSha;
  }
}

// Same idea as `git patch-id` (and worker/delivery.mjs patchIdentity): blob
// ids and hunk positions move with the base, the changed lines do not.
export function patchIdentity(patch) {
  return String(patch ?? '').split('\n')
    .filter((line) => !line.startsWith('index '))
    .map((line) => line.startsWith('@@') ? '@@' : line)
    .join('\n');
}

/**
 * Clean mechanical rebase of a stale candidate (User 2026-09-21: a pure
 * rebase no longer costs an execute round plus a full re-review). Replays
 * oldFork..frozen onto the fetched target; succeeds only when git applies it
 * without conflict AND the candidate's own patch is identical afterwards.
 * Anything else restores the branch to frozen and returns null, so the caller
 * reports stale exactly as before. Validation still runs on the new head.
 */
export async function tryCleanRebase(args, remoteTarget, exec = execFileAsync) {
  const frozen = args.frozenSha;
  const restore = async () => {
    try { await exec('git', ['rebase', '--abort'], { maxBuffer: 1024 * 1024 }); } catch { /* no rebase in progress */ }
    try { await exec('git', ['reset', '--hard', frozen], { maxBuffer: 1024 * 1024 }); } catch { /* Gate0 reports it next run */ }
  };
  let oldFork;
  let oldPatch;
  try {
    oldFork = (await git(['merge-base', remoteTarget, frozen], exec)).toLowerCase();
    oldPatch = await git(['diff', '--no-color', '--no-ext-diff', '--binary', oldFork, frozen], exec);
  } catch {
    return null;
  }
  try {
    await git(['-c', 'user.name=ai-hub-merge', '-c', 'user.email=merge@ai-hub.local',
      'rebase', '--no-autostash', '--onto', remoteTarget, oldFork], exec);
  } catch {
    await restore();
    return null;
  }
  try {
    const head = (await git(['rev-parse', 'HEAD'], exec)).toLowerCase();
    const newPatch = await git(['diff', '--no-color', '--no-ext-diff', '--binary', remoteTarget, head], exec);
    if (head === frozen || patchIdentity(oldPatch) !== patchIdentity(newPatch)) {
      await restore();
      return null;
    }
    return { head, rebasedFrom: frozen, restore };
  } catch {
    await restore();
    return null;
  }
}

/**
 * A run killed mid-validation (timeout, worker restart) leaves the working
 * branch on its rebased head. When that head is exactly frozen's patch
 * replayed onto some other base, put the branch back on frozen so the rerun
 * starts from the ledger's SHA; anything else stays a Gate0 mismatch.
 */
async function leftoverCleanRebase(args, currentHead, exec) {
  try {
    await git(['fetch', args.remote, args.targetBranch], exec);
    const target = `refs/remotes/${args.remote}/${args.targetBranch}`;
    const frozenFork = await git(['merge-base', target, args.frozenSha], exec);
    const headFork = await git(['merge-base', target, currentHead], exec);
    const [frozenPatch, headPatch] = await Promise.all([
      git(['diff', '--no-color', '--no-ext-diff', '--binary', frozenFork, args.frozenSha], exec),
      git(['diff', '--no-color', '--no-ext-diff', '--binary', headFork, currentHead], exec),
    ]);
    if (patchIdentity(frozenPatch) !== patchIdentity(headPatch)) return false;
    await git(['reset', '--hard', args.frozenSha], exec);
    return true;
  } catch {
    return false;
  }
}

/**
 * R2-D: a run killed after the review patch was applied leaves the branch on
 * the patched head. When parent..head is exactly this run's patch (patchIdentity)
 * and the parent is frozen (or frozen's clean rebase), reset to frozen so the
 * rerun starts from the ledger's SHA; anything else stays a Gate0 mismatch.
 */
async function leftoverReviewPatch(args, currentHead, exec) {
  if (!args.reviewPatchText) return false;
  try {
    const parent = (await git(['rev-parse', `${currentHead}^`], exec)).toLowerCase();
    const diff = await git(['diff', '--no-color', '--no-ext-diff', '--binary', parent, currentHead], exec);
    if (patchIdentity(diff) !== patchIdentity(args.reviewPatchText.trimEnd())) return false;
    if (parent === args.frozenSha) {
      await git(['reset', '--hard', args.frozenSha], exec);
      return true;
    }
    if (args.autoRebase) {
      await git(['fetch', args.remote, args.targetBranch], exec);
      const target = `refs/remotes/${args.remote}/${args.targetBranch}`;
      const frozenFork = await git(['merge-base', target, args.frozenSha], exec);
      const parentFork = await git(['merge-base', target, parent], exec);
      const [frozenPatch, parentPatch] = await Promise.all([
        git(['diff', '--no-color', '--no-ext-diff', '--binary', frozenFork, args.frozenSha], exec),
        git(['diff', '--no-color', '--no-ext-diff', '--binary', parentFork, parent], exec),
      ]);
      if (patchIdentity(frozenPatch) !== patchIdentity(parentPatch)) return false;
      await git(['reset', '--hard', args.frozenSha], exec);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * R2-D: apply the review-approved patch after Gate0 + stale/rebase (head is
 * fixed) and before the validation set. Strict `git apply --check --index`
 * (no --3way, no --reject, no fuzz), machine-identity commit, then
 * patchIdentity核对逐字一致. Any failure restores pre-patch and throws ReviewPatchError.
 */
async function applyReviewPatch(args, prePatchHead, exec = execFileAsync) {
  const patchText = args.reviewPatchText;
  // git apply needs a trailing newline; identity is compared trimmed (git()
  // trims stdout, so the produced diff has none).
  const fileText = patchText.endsWith('\n') ? patchText : `${patchText}\n`;
  const identityWanted = patchIdentity(patchText.trimEnd());
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-review-patch-')), 'patch.diff');
  try {
    fs.writeFileSync(tmpFile, fileText, 'utf8');
    try {
      await git(['apply', '--check', '--index', tmpFile], exec);
    } catch (error) {
      throw new ReviewPatchError(`review patch does not apply: ${String(error.message ?? error).slice(0, 500)}`);
    }
    try {
      await git(['apply', '--index', tmpFile], exec);
    } catch (error) {
      try { await git(['reset', '--hard', prePatchHead], exec); } catch { /* Gate0 reports next run */ }
      throw new ReviewPatchError(`review patch apply failed: ${String(error.message ?? error).slice(0, 500)}`);
    }
    const taskPath = args.releaseEvidence?.taskPath ?? 'tasks/unknown.md';
    const evidenceId = args.releaseEvidence?.reviewEvidenceId ?? 'unknown';
    const message = `review patch ${args.reviewPatchSha256.slice(0, 12)} for ${taskPath} (review-evidence:${evidenceId}, patch-sha256:${args.reviewPatchSha256})`;
    try {
      await git(['-c', 'user.name=ai-hub-merge', '-c', 'user.email=merge@ai-hub.local',
        'commit', '-m', message], exec);
    } catch (error) {
      try { await git(['reset', '--hard', prePatchHead], exec); } catch { /* Gate0 reports next run */ }
      throw new ReviewPatchError(`review patch commit failed: ${String(error.message ?? error).slice(0, 500)}`);
    }
    const head = (await git(['rev-parse', 'HEAD'], exec)).toLowerCase();
    const produced = await git(['diff', '--no-color', '--no-ext-diff', '--binary', prePatchHead, head], exec);
    if (patchIdentity(produced) !== identityWanted) {
      try { await git(['reset', '--hard', prePatchHead], exec); } catch { /* Gate0 reports next run */ }
      throw new ReviewPatchError('review patch identity mismatch after apply');
    }
    return {
      head,
      patchedFrom: prePatchHead.toLowerCase(),
      patchSha256: args.reviewPatchSha256,
      restore: async () => {
        try { await git(['reset', '--hard', prePatchHead], exec); } catch { /* Gate0 reports next run */ }
      },
    };
  } finally {
    try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch { /* temp cleanup best-effort */ }
  }
}

export async function runMergeCloseJob(rawArgs, {
  exec = execFileAsync,
  dryRun = false,
  verify = verifyReleaseEvidence,
  verifyOptions,
} = {}) {
  const args = validateMergeArgs(rawArgs);
  const serverVerification = await verify(args, verifyOptions);
  const tests = [];
  // R3: manifest suites run with cwd=repoDir (the manifest's own checkout);
  // the built-in ai-hub/dashboard sets keep the historical cwd behavior.
  const suiteCwd = args.manifestCwd ?? undefined;
  const run = async (suite, command, cmdArgs) => {
    if (dryRun) {
      tests.push({ suite, status: 'pass', dryRun: true });
      return;
    }
    try {
      await exec(command, cmdArgs, { maxBuffer: 64 * 1024 * 1024, ...(suiteCwd ? { cwd: suiteCwd } : {}) });
    } catch (error) {
      tests.push({ suite, status: 'fail' });
      const failure = new Error(`${suite} failed with exit code ${error.code ?? 'unknown'}`);
      // The receipt is this script's stdout: without the suite's own output
      // a gate failure that only reproduces inside the Worker unit is blind.
      failure.output = suiteFailureExcerpt(error.stdout, error.stderr);
      failure.tests = [...tests];
      throw failure;
    }
    tests.push({ suite, status: 'pass' });
  };
  if ((await git(['rev-parse', '--is-inside-work-tree'], exec)) !== 'true') {
    throw new Error('workspace is not a git work tree');
  }
  const dirty = await git(['status', '--porcelain=v1', '--untracked-files=all'], exec);
  if (dirty) throw new Error(`Gate0 rejected dirty workspace:\n${dirty}`);
  const currentBranch = await git(['branch', '--show-current'], exec);
  if (currentBranch !== args.workingBranch) {
    throw new Error(`Gate0 branch mismatch: expected ${args.workingBranch}, got ${currentBranch}`);
  }
  const currentHead = (await git(['rev-parse', 'HEAD'], exec)).toLowerCase();
  if (currentHead !== args.frozenSha
    && !(args.reviewPatchText && await leftoverReviewPatch(args, currentHead, exec))
    && !(args.autoRebase && await leftoverCleanRebase(args, currentHead, exec))) {
    throw new Error(`Gate0 frozen SHA mismatch: expected ${args.frozenSha}, got ${currentHead}`);
  }
  // No claimed-baseline ancestry assertion, ever: before.head and the merge
  // baseline are different concepts, and any rebased candidate dies under such
  // an assertion (2026-09-16 burned two merge rounds on exactly that).
  await git(['fetch', args.remote, args.targetBranch], exec);
  // Freshness comes from the just-fetched remote-tracking ref. The local
  // refs/heads/<target> may legitimately lag or not exist at all — a
  // provisioned VPS workspace is a fresh clone sitting on task/<slug> — so it
  // is never read. Ancestry + push + ls-remote carry the safety.
  const remoteTarget = (await git(['rev-parse', `refs/remotes/${args.remote}/${args.targetBranch}`], exec)).toLowerCase();
  let head = args.frozenSha;
  let rebased = null;
  if (!(await isAncestor(remoteTarget, args.frozenSha, exec))) {
    rebased = args.autoRebase ? await tryCleanRebase(args, remoteTarget, exec) : null;
    if (!rebased) throw new StaleCandidateError(args.releaseEvidence.taskPath, args.frozenSha, remoteTarget, args.targetBranch);
    head = rebased.head;
  }
  let pushed = false;
  let patched = null;
  try {
    // R2-D: Gate0 → stale/rebase 判定（head 定下来之后）→ 应用补丁 → 验证集 → push.
    if (args.reviewPatchText) {
      patched = await applyReviewPatch(args, head, exec);
      head = patched.head;
    }
    // Live computation, not the claimed before.head: the head's fork point
    // off the current remote target.
    const computedBaseline = (await git(['merge-base', remoteTarget, head], exec)).toLowerCase();
    // Validation runs on the head in place: no `git switch` to the target
    // branch (a linked worktree cannot check out a branch another checkout
    // holds), so the working branch is never switched.
    for (const step of args.suites) await run(step.suite, step.command, step.args);
    const dirtyAfter = await git(['status', '--porcelain=v1', '--untracked-files=all'], exec);
    if (dirtyAfter) throw new Error(`validation dirtied the workspace:\n${dirtyAfter}`);
    if (!dryRun) {
      // Direct ref update: no checkout, no merge commit, no force. A remote that
      // moved since fetch fails as non-fast-forward, which is retried, never forced.
      await git(['push', args.remote, `${head}:refs/heads/${args.targetBranch}`], exec);
      pushed = true;
      const remoteLine = await git(['ls-remote', args.remote, `refs/heads/${args.targetBranch}`], exec);
      const pushedSha = String(remoteLine.split(/\s+/)[0] ?? '').toLowerCase();
      if (pushedSha !== head) throw new Error(`remote verification mismatch: expected ${head}, got ${pushedSha}`);
    }
    if (dryRun && patched) await patched.restore();
    if (rebased && dryRun) await rebased.restore();
    return {
      ok: true, lane: 'merge', branch: args.targetBranch, head,
      // A clean replay reports where it came from; the gateway accepts the
      // new head for the approved frozen candidate only with both fields.
      ...(rebased ? { rebasedFrom: rebased.rebasedFrom, rebase: 'identical' } : {}),
      // R2-D: patched head is accepted only with all three fields + matching
      // APPROVE patch sha (gateway side). With a rebase underneath both groups ride.
      ...(patched ? { patchedFrom: patched.patchedFrom, patch: 'identical', patchSha256: patched.patchSha256 } : {}),
      baselineSha: computedBaseline, claimedBaselineSha: args.baselineSha,
      taskPath: args.releaseEvidence.taskPath, serverVerified: serverVerification.verified === true,
      remote: args.remote, targetBranch: args.targetBranch, repo: args.repoId,
      repoId: args.repoId, manifest: args.manifest === true, tests,
    };
  } catch (error) {
    // A failed run after a rebase/patch puts the branch back on frozen, so a
    // rerun still passes Gate0 against the ledger. Patch failures report
    // patch:'failed' with a reason via mergeFailureReport.
    if (patched && !pushed) await patched.restore();
    if (rebased && !pushed) await rebased.restore();
    if (patched && !pushed && !(error instanceof StaleCandidateError) && !error.patchFailed) {
      error.patchFailed = true;
    }
    throw error;
  }
}

function parseCli(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--frozen-sha') { out.frozenSha = next; i += 1; }
    else if (flag === '--baseline-sha') { out.baselineSha = next; i += 1; }
    else if (flag === '--working-branch') { out.workingBranch = next; i += 1; }
    else if (flag === '--remote') { out.remote = next; i += 1; }
    else if (flag === '--target-branch') { out.targetBranch = next; i += 1; }
    else if (flag === '--repo') { out.repoId = next; i += 1; }
    else if (flag === '--repo-dir') { out.repoDir = next; i += 1; }
    else if (flag === '--release-evidence') { out.releaseEvidence = next; i += 1; }
    else if (flag === '--gateway-url') { out.gatewayUrl = next; i += 1; }
    else if (flag === '--env-file') { out.envFile = next; i += 1; }
    else if (flag === '--require-server-verify') { out.requireServerVerify = true; }
    else if (flag === '--auto-rebase') { out.autoRebase = true; }
    else if (flag === '--review-patch-b64') { out.reviewPatchB64 = next; i += 1; }
    else if (flag === '--review-patch-sha256') { out.reviewPatchSha256 = next; i += 1; }
    else if (flag === '--dry-run') { out.dryRun = true; }
  }
  return out;
}

const FAILURE_LINE_RE = /^(not ok\b|\s*error:|.*\b\w*Error\b|.*\bERR_[A-Z_]+|\s*✖)/;
const FAILURE_LINES_MAX = 20;
const FAILURE_TAIL_CHARS = 3000;

/** Failing lines first (node:test "not ok", error messages), then the raw
 * tail, bounded so a noisy suite cannot flood the receipt. */
export function suiteFailureExcerpt(stdout, stderr) {
  const text = [stdout, stderr].map((part) => String(part ?? '')).filter(Boolean).join('\n');
  if (!text.trim()) return '';
  const failing = text.split(/\r?\n/).filter((line) => FAILURE_LINE_RE.test(line))
    .slice(0, FAILURE_LINES_MAX).map((line) => line.slice(0, 300));
  const tail = text.length > FAILURE_TAIL_CHARS ? `…${text.slice(-FAILURE_TAIL_CHARS)}` : text;
  return failing.length ? `${failing.join('\n')}\n--- tail ---\n${tail}` : tail;
}

export function mergeFailureReport(error) {
  const stale = error instanceof StaleCandidateError;
  const patchFailed = !stale && (error instanceof ReviewPatchError || error?.patchFailed === true);
  return {
    ok: false,
    lane: 'merge',
    stale,
    ...(stale ? { taskPath: error.taskPath, frozen: error.frozen, masterSha: error.masterSha } : {}),
    ...(patchFailed ? { patch: 'failed', reason: String(error.message ?? error).slice(0, 500) } : {}),
    error: error.message,
    ...(error?.output ? { output: error.output } : {}),
    tests: Array.isArray(error?.tests) ? error.tests : [],
  };
}

if (process.argv[1]?.endsWith('merge-close-job.mjs')) {
  const cli = parseCli(process.argv.slice(2));
  runMergeCloseJob(cli, { dryRun: cli.dryRun === true })
    .then((result) => { console.log(JSON.stringify(result)); process.exit(0); })
    .catch((error) => { console.log(JSON.stringify(mergeFailureReport(error))); process.exit(1); });
}
