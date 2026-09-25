// Worker capability card: a cheap self-probe reported beside
// releaseSha/pendingReleaseSha in the /api/worker/connect heartbeat
// capabilities, so the gateway can refuse dispatch BEFORE a job starts
// (see server/src/jobs/capabilityCard.ts + docs/ARCHITECTURE.md).
//
// Card shape (all four fields always present):
//   {
//     runners: { <runner>: { ok, checkedAt, error? } },
//     workspaceWritable: boolean,
//     npmCacheWritable: boolean,
//     configVisible: boolean,
//   }
//
// Probes never throw and never take the worker offline: any failure is
// recorded in the card itself. Pure/testable functions take all I/O as
// injected deps; only refreshCapabilityCard touches the real environment.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CAPABILITY_PROBE_INTERVAL_MINUTES_DEFAULT = 60;
export const CAPABILITY_PROBE_INTERVAL_MINUTES_MIN = 1;
export const CAPABILITY_PROBE_INTERVAL_MINUTES_MAX = 24 * 60;
export const RUNNER_PROBE_TIMEOUT_MS = 10_000;
export const VPS_WORKER_CONFIG_PATH = '/etc/ai-dev-worker/config.json';

/** Re-probe interval for the card; `capabilityProbeIntervalMinutes` in worker config (default 60). */
export function resolveCapabilityProbeIntervalMs(cfg = {}, env = process.env) {
  const raw = cfg?.capabilityProbeIntervalMinutes ?? env?.AI_HUB_CAPABILITY_PROBE_MINUTES;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) return CAPABILITY_PROBE_INTERVAL_MINUTES_DEFAULT * 60_000;
  const clamped = Math.min(
    Math.max(Math.floor(minutes), CAPABILITY_PROBE_INTERVAL_MINUTES_MIN),
    CAPABILITY_PROBE_INTERVAL_MINUTES_MAX,
  );
  return clamped * 60_000;
}

function errorDetail(error, limit = 300) {
  const text = String(error?.stderr ?? error?.message ?? error ?? '').trim();
  return text.slice(-limit) || 'unknown error';
}

/** Cheapest liveness proof per runner: `<command> --version` with a short timeout. */
export function defaultRunnerProbeCommand(runner, cfg = {}, platform = process.platform) {
  const field = `${runner}Command`;
  const configured = typeof cfg?.[field] === 'string' && cfg[field].trim() ? cfg[field].trim() : null;
  if (configured) return configured;
  if (platform === 'win32') {
    if (runner === 'claude') return 'claude.cmd';
    if (runner === 'codex') return 'codex.cmd';
    if (runner === 'opencode') return 'opencode.cmd';
    return runner;
  }
  return runner;
}

// Node refuses to execFile a .cmd/.bat shim without a shell (EINVAL since the
// CVE-2024-27980 fix), which made every win32 runner probe read ok=false. Run
// the shim through cmd with one verbatim command line, as stall.mjs does.
export function versionProbeSpawnSpec(command, platform = process.platform) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
    return { file: command, args: ['--version'], options: {} };
  }
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `""${command}" --version"`],
    options: { windowsVerbatimArguments: true },
  };
}

function defaultExecVersion(command, { timeout = RUNNER_PROBE_TIMEOUT_MS } = {}) {
  const spec = versionProbeSpawnSpec(command);
  execFileSync(spec.file, spec.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    ...spec.options,
  });
}

export function probeRunner(runner, { command, execVersion = defaultExecVersion } = {}) {
  const checkedAt = new Date().toISOString();
  try {
    execVersion(command ?? runner);
    return { ok: true, checkedAt };
  } catch (error) {
    return { ok: false, checkedAt, error: errorDetail(error) };
  }
}

export function probeRunners(runners, deps = {}) {
  const out = {};
  for (const runner of Array.isArray(runners) ? runners : []) {
    const name = String(runner ?? '').trim();
    if (!name) continue;
    out[name] = probeRunner(name, {
      command: defaultRunnerProbeCommand(name, deps.cfg, deps.platform),
      execVersion: deps.execVersion,
    });
  }
  return out;
}

/** Create+delete a temp file inside `dir`; true only when both succeed. */
export function probeWritableDir(dir, { writeFile = fs.writeFileSync, unlink = fs.unlinkSync, random = Math.random } = {}) {
  try {
    const target = String(dir ?? '').trim();
    if (!target) return false;
    const probe = path.join(target, `.ai-hub-wprobe-${process.pid}-${Math.floor(random() * 1e9)}`);
    writeFile(probe, 'ai-hub capability probe', 'utf8');
    unlink(probe);
    return true;
  } catch {
    return false;
  }
}

/** Every configured workspace root must accept a temp file (no roots = false). */
export function probeWorkspaceWritable(roots, deps = {}) {
  const list = (Array.isArray(roots) ? roots : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry?.path))
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  if (list.length === 0) return false;
  return list.every((root) => probeWritableDir(root, deps));
}

export function resolveNpmCacheDir(env = process.env, home = os.homedir()) {
  const configured = String(env?.npm_config_cache ?? '').trim();
  if (configured) return configured;
  return path.join(String(home ?? os.tmpdir()), '.npm');
}

export function probeNpmCacheWritable(npmCacheDir, deps = {}) {
  return probeWritableDir(npmCacheDir, deps);
}

function canReadFile(file, { readFile = fs.readFileSync } = {}) {
  try {
    readFile(file, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function existsPath(file, { exists = fs.existsSync } = {}) {
  try {
    return exists(file);
  } catch {
    return false;
  }
}

/**
 * Own worker config readable AND the VPS-side /etc/ai-dev-worker/config.json
 * readable-or-absent (a PC host has no such file; absence is not a failure).
 */
export function probeConfigVisible(configPath, {
  vpsConfigPath = VPS_WORKER_CONFIG_PATH,
  readFile = fs.readFileSync,
  exists = fs.existsSync,
} = {}) {
  if (!canReadFile(configPath, { readFile })) return false;
  if (!existsPath(vpsConfigPath, { exists })) return true;
  return canReadFile(vpsConfigPath, { readFile });
}

export function buildCapabilityCard({ runners = {}, workspaceWritable = false, npmCacheWritable = false, configVisible = false } = {}) {
  const runnerEntries = {};
  for (const [name, entry] of Object.entries(runners ?? {})) {
    const key = String(name);
    const ok = entry?.ok === true;
    runnerEntries[key] = {
      ok,
      checkedAt: typeof entry?.checkedAt === 'string' ? entry.checkedAt : new Date(0).toISOString(),
      ...(ok ? {} : { error: String(entry?.error ?? 'probe failed').slice(0, 300) }),
    };
  }
  return {
    runners: runnerEntries,
    workspaceWritable: workspaceWritable === true,
    npmCacheWritable: npmCacheWritable === true,
    configVisible: configVisible === true,
  };
}

/**
 * Full refresh against the live environment (parallel runner probes).
 * Never throws: total failure still yields an all-false card.
 */
export async function refreshCapabilityCard(cfg = {}, {
  configPath = null,
  workspaceRoots = [],
  npmCacheDir = null,
  platform = process.platform,
  execVersion = defaultExecVersion,
  writeFile = fs.writeFileSync,
  unlink = fs.unlinkSync,
  readFile = fs.readFileSync,
  exists = fs.existsSync,
} = {}) {
  try {
    const runners = Array.isArray(cfg?.runners) && cfg.runners.length > 0 ? cfg.runners : ['codex'];
    const io = { writeFile, unlink };
    const [runnerEntries, workspaceWritable, npmCacheWritable, configVisible] = await Promise.all([
      (async () => probeRunners(runners, { cfg, platform, execVersion }))(),
      (async () => probeWorkspaceWritable(workspaceRoots, io))(),
      (async () => probeNpmCacheWritable(npmCacheDir ?? resolveNpmCacheDir(), io))(),
      (async () => (configPath ? probeConfigVisible(configPath, { readFile, exists }) : false))(),
    ]);
    return buildCapabilityCard({ runners: runnerEntries, workspaceWritable, npmCacheWritable, configVisible });
  } catch {
    return buildCapabilityCard({});
  }
}
