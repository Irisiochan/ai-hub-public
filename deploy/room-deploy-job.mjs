#!/usr/bin/env node
// Linux/Node port of deploy/room-deploy-job.ps1.
// Scope: ai-hub self-deploy only. This entry triggers and verifies the
// ai-hub gateway's own HTTP deploy channel; it must not be reused for
// other repos or turned into an SSH/direct-script deploy path.
// Credentials come from --env-file (default /etc/ai-dev-worker/deploy.env)
// or the process environment. Windows User-level env vars are NOT assumed.
// Same flow: no running room rounds -> wait idle -> trigger deploy ->
// wait (tolerating the gateway restart gap) -> deploy-ok + /api/health.
// Usage:
//   node deploy/room-deploy-job.mjs --sha <7-40hex> [--check-only]
//     [--timeout-seconds 900] [--poll-seconds 5]
//     [--repo ai-hub] [--env-file /etc/ai-dev-worker/deploy.env]

import { readFileSync, existsSync } from 'node:fs';

const SHA_RE = /^[0-9a-fA-F]{7,40}$/;
const DEPLOY_OK_RE = /^== deploy ok ([0-9a-fA-F]{7,40})[^\r\n]*==$/m;

// This Node entry only serves ai-hub self-deploy. Other repos must not
// reuse this channel.
export const DEPLOY_SUPPORTED_REPO = 'ai-hub';
export const DEFAULT_ENV_FILE = '/etc/ai-dev-worker/deploy.env';
export const DEFAULT_HUB_URL = 'http://127.0.0.1:3900';

export function validateDeployArgs(input) {
  const sha = String(input.sha ?? '').toLowerCase();
  if (!SHA_RE.test(sha)) throw new Error('sha must be a 7-40 character git SHA');
  const timeoutSeconds = input.timeoutSeconds === undefined ? 900 : Number(input.timeoutSeconds);
  const pollSeconds = input.pollSeconds === undefined ? 5 : Number(input.pollSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600) {
    throw new Error('timeoutSeconds must be within 10-3600');
  }
  if (!Number.isFinite(pollSeconds) || pollSeconds < 1 || pollSeconds > 60) {
    throw new Error('pollSeconds must be within 1-60');
  }
  const repo = String(input.repo ?? input.repoId ?? DEPLOY_SUPPORTED_REPO).trim().toLowerCase() || DEPLOY_SUPPORTED_REPO;
  if (repo !== DEPLOY_SUPPORTED_REPO) {
    throw new Error(`room-deploy-job.mjs only serves ai-hub self-deploy; got repo: ${repo}`);
  }
  const envFile = String(input.envFile ?? DEFAULT_ENV_FILE);
  if (!envFile || envFile.includes('\0') || envFile.length > 500 || envFile.startsWith('-')) {
    throw new Error('invalid envFile');
  }
  return { sha, checkOnly: input.checkOnly === true, timeoutSeconds, pollSeconds, repo, envFile };
}

export function shaMatches(expected, observed) {
  const a = String(expected ?? '').toLowerCase();
  const b = String(observed ?? '').toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

export function findDeployOkEvidence(tail) {
  const matches = String(tail ?? '').match(new RegExp(DEPLOY_OK_RE.source, 'gm'));
  if (!matches || matches.length === 0) return null;
  const line = matches[matches.length - 1];
  const sha = /== deploy ok ([0-9a-fA-F]{7,40})/.exec(line)?.[1]?.toLowerCase() ?? null;
  return sha ? { sha, line } : null;
}

const DEPLOY_FAIL_RE = /^== deploy fail[^\r\n]*==$/m;
const DEPLOY_START_RE = /^== deploy start [^\r\n]*==$/m;

export function findDeployFailEvidence(tail) {
  const matches = String(tail ?? '').match(new RegExp(DEPLOY_FAIL_RE.source, 'gm'));
  if (!matches || matches.length === 0) return null;
  return { line: matches[matches.length - 1] };
}

// Kind of the last terminal/start marker in a deploy tail: the gateway's
// update.sh appends `== deploy start ==` first and exactly one of
// `== deploy ok ... ==` / `== deploy fail ... ==` per round, so the last of
// the three tells which round the tail ends in.
function lastDeployMarkerKind(tail) {
  const text = String(tail ?? '');
  const lastIndexOfMatch = (re) => {
    const all = text.match(new RegExp(re.source, 'gm'));
    if (!all || all.length === 0) return -1;
    return text.lastIndexOf(all[all.length - 1]);
  };
  const start = lastIndexOfMatch(DEPLOY_START_RE);
  const ok = lastIndexOfMatch(DEPLOY_OK_RE);
  const fail = lastIndexOfMatch(DEPLOY_FAIL_RE);
  const latest = Math.max(start, ok, fail);
  if (latest < 0) return 'none';
  if (latest === fail) return 'fail';
  if (latest === ok) return 'ok';
  return 'start';
}

// Minimal dotenv-style parser: KEY=VALUE lines, '#' comments, blank lines
// ignored, optional single/double quotes stripped. No variable expansion,
// no shell execution.
export function parseEnvFileText(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadEnvFileValues(envFile, { readFile = readFileSync, exists = existsSync } = {}) {
  if (!envFile) return {};
  try {
    if (!exists(envFile)) return {};
    return parseEnvFileText(readFile(envFile, 'utf8'));
  } catch {
    return {};
  }
}

// Credential resolution order: explicit overrides > process env > --env-file.
// Never touches Windows User-level stores; on VPS the file default is
// /etc/ai-dev-worker/deploy.env.
export function resolveDeployTokens({ envFile = DEFAULT_ENV_FILE, env = process.env, fileValues } = {}) {
  const file = fileValues ?? loadEnvFileValues(envFile);
  const hub = env.AI_HUB_TOKEN || file.AI_HUB_TOKEN || '';
  const deploy = env.AI_HUB_DEPLOY_TOKEN || file.AI_HUB_DEPLOY_TOKEN || '';
  return { hubToken: hub, deployToken: deploy };
}

export function resolveBaseUrl(env = process.env) {
  return (env.AI_HUB_URL || DEFAULT_HUB_URL).replace(/\/$/, '');
}

function baseUrl() {
  return resolveBaseUrl(process.env);
}

async function hubGet(pathname, token, fetchImpl = fetch) {
  const res = await fetchImpl(`${baseUrl()}${pathname}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${String(detail).slice(0, 2000)}`);
  }
  return res.json();
}

async function hubGetOrNullOnTransportError(pathname, token, fetchImpl = fetch) {
  try {
    return await hubGet(pathname, token, fetchImpl);
  } catch (error) {
    // HTTP errors carry a status and must fail; only transport failures
    // (no HTTP response, e.g. gateway restart gap) return null.
    if (/^HTTP \d+/.test(String(error.message))) throw error;
    return null;
  }
}

export async function assertNoRunningRoomRounds(hubToken, fetchImpl = fetch) {
  const contacts = await hubGet('/api/contacts', hubToken, fetchImpl);
  const rooms = (contacts.contacts ?? []).filter((c) => c?.kind === 'room');
  if (rooms.length === 0) throw new Error('no enabled room contact found');
  const running = [];
  for (const room of rooms) {
    let after = 0;
    for (;;) {
      const page = await hubGet(
        `/api/contacts/${encodeURIComponent(String(room.id))}/messages?origin=all&after=${after}&limit=1000`,
        hubToken, fetchImpl,
      );
      const messages = page.messages ?? [];
      for (const message of messages) {
        if (String(message.sender) !== 'room-host') continue;
        let meta;
        try {
          meta = typeof message.meta === 'string' ? JSON.parse(message.meta) : message.meta;
        } catch {
          throw new Error(`room-host message ${message.id} has invalid meta JSON`);
        }
        if (String(meta?.roomHost?.status) === 'running') running.push(String(message.id));
      }
      if (messages.length < 1000) break;
      const nextAfter = Number(messages[messages.length - 1].id);
      if (!Number.isFinite(nextAfter) || nextAfter <= after) throw new Error(`room message pagination stalled after id ${after}`);
      after = nextAfter;
    }
  }
  if (running.length > 0) throw new Error(`room-host round is running; message id(s): ${running.join(', ')}`);
}

export async function waitDeployIdle(deployToken, status, { timeoutSeconds, pollSeconds, startedAt = Date.now(), fetchImpl = fetch, tolerateRestartGap = false, unreachableToleranceSeconds = 30 }) {
  let current = status;
  let unreachableSince = null;
  for (;;) {
    if (!current.running) return current;
    if ((Date.now() - startedAt) / 1000 >= timeoutSeconds) {
      throw new Error(`deployment did not finish within ${timeoutSeconds} seconds\n${String(current.tail ?? '')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
    if (!tolerateRestartGap) {
      current = await hubGet('/api/system/deploy/status', deployToken, fetchImpl);
      continue;
    }
    const next = await hubGetOrNullOnTransportError('/api/system/deploy/status', deployToken, fetchImpl);
    if (next === null) {
      const elapsed = (Date.now() - startedAt) / 1000;
      if (unreachableSince === null) unreachableSince = elapsed;
      else if (elapsed - unreachableSince >= unreachableToleranceSeconds) {
        throw new Error(`hub unreachable for more than ${unreachableToleranceSeconds} seconds while waiting for deployment`);
      }
      continue;
    }
    unreachableSince = null;
    current = next;
  }
}

// Post-trigger wait for THIS round's receipt. After POST /api/system/deploy
// returns 202 the gateway still needs a moment to create the deploy.request
// file / systemd unit and for update.sh to append `== deploy start ==`; a
// status poll inside that gap reports running=false with the previous
// round's tail. Returning on the first idle snapshot (or treating the stale
// `== deploy ok <old> ==` as this round's receipt) is the start-receipt
// race: it failed job c59934ed ~394ms after trigger on the old 7027cdd line
// while the real deploy wrote its own ok ~26s later. So unlike
// waitDeployIdle, an idle snapshot alone never stops this wait: success
// needs the target SHA's deploy-ok AND an idle deployment; a deploy-fail
// marker appended after the pre-trigger snapshot fails closed; anything
// else — including the stale idle snapshot — keeps polling until the overall
// timeout (fail closed) or a persistent transport gap (fail closed, HTTP
// errors still fail fast).
export async function waitForDeployResult(deployToken, { targetSha, baselineTail = '', timeoutSeconds, pollSeconds, startedAt = Date.now(), fetchImpl = fetch, unreachableToleranceSeconds = 30 }) {
  const baseline = String(baselineTail ?? '');
  const target = String(targetSha ?? '').toLowerCase();
  let lastTail = baseline;
  let unreachableSince = null;
  for (;;) {
    if ((Date.now() - startedAt) / 1000 >= timeoutSeconds) {
      throw new Error(`deploy log does not contain deploy ok for ${target}\n${lastTail}`);
    }
    const status = await hubGetOrNullOnTransportError('/api/system/deploy/status', deployToken, fetchImpl);
    if (status === null) {
      const elapsed = (Date.now() - startedAt) / 1000;
      if (unreachableSince === null) unreachableSince = elapsed;
      else if (elapsed - unreachableSince >= unreachableToleranceSeconds) {
        throw new Error(`hub unreachable for more than ${unreachableToleranceSeconds} seconds while waiting for deployment`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
      continue;
    }
    unreachableSince = null;
    lastTail = String(status.tail ?? '');
    const evidence = findDeployOkEvidence(lastTail);
    if (evidence && shaMatches(target, evidence.sha) && !status.running) return status;
    // A fail marker only counts when the tail advanced past the pre-trigger
    // snapshot: the previous round's fail line may still sit in the window
    // while the new round has not appended anything yet.
    if (lastTail !== baseline && lastDeployMarkerKind(lastTail) === 'fail') {
      throw new Error(`deployment failed for ${target}\n${lastTail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

export async function runRoomDeployJob(rawArgs, { fetchImpl = fetch, hubToken, deployToken, envFile } = {}) {
  const startedAt = Date.now();
  const args = validateDeployArgs(rawArgs);
  const resolved = resolveDeployTokens({ envFile: envFile ?? args.envFile, env: process.env });
  const hub = hubToken ?? process.env.AI_HUB_TOKEN ?? resolved.hubToken;
  const deploy = deployToken ?? process.env.AI_HUB_DEPLOY_TOKEN ?? resolved.deployToken;
  if (!hub) throw new Error(`AI_HUB_TOKEN not set (checked environment and --env-file ${args.envFile})`);
  if (!deploy) throw new Error(`AI_HUB_DEPLOY_TOKEN not set (checked environment and --env-file ${args.envFile})`);
  await assertNoRunningRoomRounds(hub, fetchImpl);
  let status = await hubGet('/api/system/deploy/status', deploy, fetchImpl);
  if (args.checkOnly) {
    status = await waitDeployIdle(deploy, status, { timeoutSeconds: args.timeoutSeconds, pollSeconds: args.pollSeconds, startedAt, fetchImpl });
    const evidence = findDeployOkEvidence(status.tail);
    const health = await hubGet('/api/health', '', fetchImpl);
    if (String(health.status) !== 'ok') throw new Error(`health check failed: ${JSON.stringify(health).slice(0, 500)}`);
    const result = evidence && shaMatches(args.sha, evidence.sha) ? 'already-online' : 'check-only';
    return { ok: true, mode: 'check-only', result, targetSha: args.sha, deployOkLine: evidence?.line ?? null, health: String(health.status) };
  }
  if (status.running) throw new Error(`another deployment is already running\n${String(status.tail ?? '')}`);
  const existing = findDeployOkEvidence(status.tail);
  if (existing && shaMatches(args.sha, existing.sha)) {
    const health = await hubGet('/api/health', '', fetchImpl);
    if (String(health.status) !== 'ok') throw new Error(`health check failed: ${JSON.stringify(health).slice(0, 500)}`);
    return { ok: true, mode: 'deploy', result: 'already-online', targetSha: args.sha, deployOkLine: existing.line, health: String(health.status) };
  }
  const trigger = await fetchImpl(`${baseUrl()}/api/system/deploy`, {
    method: 'POST', headers: { Authorization: `Bearer ${deploy}` },
  });
  if (!trigger.ok) throw new Error(`HTTP ${trigger.status}: ${(await trigger.text().catch(() => trigger.statusText)).slice(0, 2000)}`);
  // Snapshot the pre-trigger tail so the post-trigger wait can tell this
  // round's markers apart from the previous round's receipt. The wait below
  // never accepts the stale idle snapshot: even the first running=false
  // keeps polling until the target SHA's own deploy-ok (plus idle), an
  // explicit deploy-fail, the timeout, or a persistent gateway gap.
  const baselineTail = String(status.tail ?? '');
  status = await waitForDeployResult(deploy, {
    targetSha: args.sha, baselineTail,
    timeoutSeconds: args.timeoutSeconds, pollSeconds: args.pollSeconds, startedAt, fetchImpl,
  });
  const evidence = findDeployOkEvidence(status.tail);
  if (!evidence || !shaMatches(args.sha, evidence.sha)) {
    throw new Error(`deploy log does not contain deploy ok for ${args.sha}\n${String(status.tail ?? '')}`);
  }
  const health = await hubGet('/api/health', '', fetchImpl);
  if (String(health.status) !== 'ok') throw new Error(`health check failed: ${JSON.stringify(health).slice(0, 500)}`);
  return {
    ok: true, mode: 'deploy', result: 'deployed', targetSha: args.sha,
    deployOkLine: evidence.line, health: String(health.status),
    elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };
}

function parseCli(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--sha') { out.sha = next; i += 1; }
    else if (flag === '--check-only') { out.checkOnly = true; }
    else if (flag === '--timeout-seconds') { out.timeoutSeconds = Number(next); i += 1; }
    else if (flag === '--poll-seconds') { out.pollSeconds = Number(next); i += 1; }
    else if (flag === '--repo') { out.repo = next; i += 1; }
    else if (flag === '--env-file') { out.envFile = next; i += 1; }
  }
  return out;
}

if (process.argv[1]?.endsWith('room-deploy-job.mjs')) {
  const cli = parseCli(process.argv.slice(2));
  runRoomDeployJob(cli, { envFile: cli.envFile })
    .then((result) => { console.log(JSON.stringify(result)); process.exit(0); })
    .catch((error) => { console.log(`[room-deploy-job] failed: ${error.message}`); process.exit(1); });
}
