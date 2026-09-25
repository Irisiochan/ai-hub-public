// vps-dev worker release identity (W2: vps-dev release follows the deploy).
//
// The worker reports which release it runs (releaseSha, derived from the
// <sha12> release directory the installer flipped `current` to) and which
// deploy it still owes a switch to (pendingReleaseSha, from the pending
// record install-vps-worker.sh writes when the worker is busy). Both travel
// in the /api/worker/connect capabilities, so /api/workers exposes them and
// a post-deploy check can compare "gateway deploy SHA == vps-dev releaseSha"
// (prefix comparison: releaseSha may be the 12-char directory form on the
// VPS or the full 40-char form the PC launcher uses for its release dirs).
// Pure functions so they stay unit-testable without booting worker.mjs.

import fs from 'node:fs';
import path from 'node:path';

export const PENDING_RELEASE_DEFAULT = '/var/lib/ai-dev-worker/pending-release.json';
export const RELEASE_SHA_RE = /^[0-9a-f]{7,40}$/i;
// Release dir basename: install-vps-worker.sh uses <sha12>, the PC launcher
// (worker-launcher.ps1) uses the full 40-char sha. Nothing in between.
export const RELEASE_DIR_RE = /^(?:[0-9a-f]{12}|[0-9a-f]{40})$/i;

export function normalizeReleaseSha(value) {
  const sha = String(value ?? '').trim().toLowerCase();
  return RELEASE_SHA_RE.test(sha) ? sha : null;
}

// Release root layout: /opt/ai-hub-worker/<sha12> (VPS) or
// %LOCALAPPDATA%/ai-hub-worker/releases/<sha40> (PC). In a dev checkout the
// basename is 'worker' (or similar) and there is no release identity.
export function releaseShaFromRoot(releaseRoot, env = process.env) {
  const override = normalizeReleaseSha(env?.AI_HUB_WORKER_RELEASE);
  if (override) return override;
  if (!releaseRoot) return null;
  const base = path.basename(String(releaseRoot));
  return RELEASE_DIR_RE.test(base) ? base.toLowerCase() : null;
}

// The pending record is advisory: any read/parse problem means "no pending",
// never a worker crash. The ai-dev sandbox cannot write it (root-owned
// installer path does), but it must always be able to read it.
export function readPendingRelease(pendingFile = PENDING_RELEASE_DEFAULT, { readFile = fs.readFileSync } = {}) {
  const file = String(pendingFile ?? '').trim() || PENDING_RELEASE_DEFAULT;
  let raw;
  try {
    raw = readFile(file, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  const sha = normalizeReleaseSha(parsed?.sha ?? parsed?.commit);
  if (!sha) return null;
  return {
    sha,
    short: String(parsed?.short ?? sha.slice(0, 12)).toLowerCase(),
    requestedAt: typeof parsed?.requestedAt === 'string' ? parsed.requestedAt : null,
  };
}

export function buildWorkerReleaseInfo({ releaseRoot, env = process.env, pendingFile, readFile } = {}) {
  const file = String(
    pendingFile ?? env?.AI_HUB_WORKER_PENDING_FILE ?? PENDING_RELEASE_DEFAULT,
  ).trim() || PENDING_RELEASE_DEFAULT;
  const pending = readPendingRelease(file, { readFile: readFile ?? fs.readFileSync });
  return {
    releaseSha: releaseShaFromRoot(releaseRoot, env),
    pendingReleaseSha: pending?.sha ?? null,
  };
}
