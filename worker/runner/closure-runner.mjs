import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killRunnerTree } from './runner.mjs';

// Deterministic mechanical-closure runner (WP-C). The server stamps
// job.options.closureCommand; the worker executes it directly without any
// model, and the receipt is the raw script stdout/stderr.

export const CLOSURE_OUTPUT_MAX = 200_000;
const CLOSURE_TRUNC_HEAD = 100_000;
const CLOSURE_TRUNC_TAIL = 100_000;

export function isClosureJob(job) {
  try {
    const options = job?.options ?? {};
    return Boolean(options?.closureCommand)
      && options?.dispatchSource === 'explicit-release'
      && (options.closureCommand.kind === 'merge' || options.closureCommand.kind === 'deploy');
  } catch {
    return false;
  }
}

export function selectClosureTarget(closureCommand, platform = process.platform) {
  if (platform === 'win32') return closureCommand.win;
  return closureCommand.posix;
}

export function truncateClosureOutput(text) {
  const input = typeof text === 'string' ? text : String(text ?? '');
  if (input.length <= CLOSURE_OUTPUT_MAX) return { text: input, truncated: false };
  const head = input.slice(0, CLOSURE_TRUNC_HEAD);
  const tail = input.slice(-CLOSURE_TRUNC_TAIL);
  return {
    text: `${head}\n…（截断，共 ${input.length} 字符，保留头尾各 ${CLOSURE_TRUNC_HEAD} 字符）\n${tail}`,
    truncated: true,
  };
}

function quoteArg(arg) {
  const text = String(arg ?? '');
  if (text === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\"'\"'")}'`;
}

export function formatClosureResult({ kind, file, args, exitCode, durationMs, stdout, stderr }) {
  const out = truncateClosureOutput(stdout ?? '');
  const err = truncateClosureOutput(stderr ?? '');
  const command = [file, ...(args ?? []).map(quoteArg)].join(' ');
  return [
    `【closure ${kind} raw receipt】exit=${exitCode} durationMs=${durationMs}`,
    `command: ${command}`,
    '--- stdout ---',
    out.text || '(empty)',
    '--- stderr ---',
    err.text || '(empty)',
  ].join('\n');
}

/** Last JSON object in text (scripts print a final success report). Scans
 * brace-balanced candidates in reverse and returns the first that parses. */
export function extractLastJsonReport(text) {
  const input = String(text ?? '');
  if (!input.includes('{')) return null;
  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of input.matchAll(fenced)) candidates.push(match[1]);
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(input.slice(start, index + 1));
        start = -1;
      }
    }
  }
  for (const raw of candidates.reverse()) {
    const candidate = String(raw).trim();
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* not this candidate */ }
  }
  return null;
}

/**
 * Deterministic delivery derivation from the script's final JSON report.
 * Success never trusts the exit code alone: merge needs ok:true+lane merge,
 * deploy needs ok:true. Anything else is a failed job with no delivered claim.
 */
export function deriveClosureDelivery({ kind, exitCode, scriptReport }) {
  const report = scriptReport && typeof scriptReport === 'object' && !Array.isArray(scriptReport)
    ? scriptReport
    : null;
  const exit = Number(exitCode) || 0;
  if (exit !== 0 || !report) {
    return {
      jobStatus: 'failed',
      delivery: {
        state: 'failed_clean',
        declared: {
          stage: kind === 'merge' ? 'delivered_waiting_deploy' : 'closed_loop',
          committed: false,
          pushed: false,
        },
        receipt: {
          ...(report ? { scriptReport: report } : {}),
          scriptExitCode: exit,
        },
      },
    };
  }
  if (kind === 'merge') {
    if (report.ok === true && report.lane === 'merge') {
      return {
        jobStatus: 'done',
        delivery: {
          state: 'delivered',
          declared: {
            stage: 'delivered_waiting_deploy',
            committed: true,
            pushed: true,
            summary: 'closure merge script reported ok',
            nextOwner: 'harness-deploy',
          },
          receipt: { scriptReport: report, scriptExitCode: exit },
        },
      };
    }
    return {
      jobStatus: 'failed',
      delivery: {
        state: 'failed_clean',
        declared: { stage: 'delivered_waiting_deploy', committed: false, pushed: false },
        receipt: { scriptReport: report, scriptExitCode: exit },
      },
    };
  }
  if (report.ok === true) {
    return {
      jobStatus: 'done',
      delivery: {
        state: 'delivered',
        declared: {
          stage: 'closed_loop',
          committed: true,
          pushed: true,
          summary: 'closure deploy script reported ok',
        },
        receipt: { scriptReport: report, scriptExitCode: exit },
      },
    };
  }
  return {
    jobStatus: 'failed',
    delivery: {
      state: 'failed_clean',
      declared: { stage: 'closed_loop', committed: false, pushed: false },
      receipt: { scriptReport: report, scriptExitCode: exit },
    },
  };
}

export function closureResumeFailure(kind) {
  return closureNotStartedFailure(kind, 'closure job 不支持续跑，请 task_retry');
}

const CLOSURE_SCRIPT_RE = /^deploy\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|ps1)$/;

/**
 * Resolve a closure script against the worker's OWN release tree, never the
 * job workspace.
 *
 * The job workspace is the repo under test: an ai-dashboard checkout has no
 * deploy/merge-close-job.mjs at all, so workspace-relative resolution made
 * every VPS merge fail with ENOENT. And where it did "work" — an ai-hub
 * candidate on the PC — it ran the candidate's own copy of the gate script,
 * i.e. the code being judged supplied its own judge. The release tree is what
 * the launcher/installer exported from a reviewed ref, so the gate comes from
 * there. cwd stays the job workspace: git and npm still act on the repo under
 * test.
 *
 * The shape is an allowlist (`deploy/<name>.mjs|.ps1`, one segment, no `..`),
 * not a sanitiser, so nothing stamped into options can reach outside deploy/.
 */
export function resolveClosureScript(file, releaseRoot, { exists = fs.existsSync } = {}) {
  const rel = String(file ?? '').replace(/\\/g, '/');
  if (!CLOSURE_SCRIPT_RE.test(rel)) {
    return { ok: false, reason: `closure script must be deploy/<name>.mjs|.ps1, got '${String(file ?? '')}'` };
  }
  if (!releaseRoot) {
    return { ok: false, reason: 'worker release root unknown; refusing to resolve closure script from the job workspace' };
  }
  const resolved = path.join(releaseRoot, ...rel.split('/'));
  if (!exists(resolved)) {
    return {
      ok: false,
      reason: `closure script ${rel} not found in worker release ${releaseRoot}; `
        + 'the release export must include deploy/ (launcher git archive / install-vps-worker.sh)',
    };
  }
  return { ok: true, path: resolved };
}

/** Failed-clean result for a closure that never started (resume refused,
 * script unresolvable). Same raw-receipt shape as a real run. */
export function closureNotStartedFailure(kind, reason) {
  const result = [
    `【closure ${kind} raw receipt】exit=1 durationMs=0`,
    'command: (not started)',
    '--- stdout ---',
    '(empty)',
    '--- stderr ---',
    reason,
  ].join('\n');
  return {
    status: 'failed',
    result,
    error: reason,
    delivery: {
      state: 'failed_clean',
      declared: { stage: kind === 'merge' ? 'delivered_waiting_deploy' : 'closed_loop', committed: false, pushed: false },
      receipt: { scriptExitCode: 1 },
    },
  };
}

/**
 * Spawn the closure script. Args are passed as an array (no shell string
 * join, no quote rebuilding). Windows runs the ps1 via powershell,
 * POSIX runs the .mjs via node. Captures stdout/stderr fully (caller
 * truncates for display); kills on timeoutMs.
 */
export function runClosureScript({ file, args, cwd, env, timeoutMs, nodeForTest }) {
  const isWin = process.platform === 'win32';
  let command;
  let spawnArgs;
  if (nodeForTest) {
    // Test hook: run a fake .mjs directly under node regardless of platform.
    command = nodeForTest;
    spawnArgs = [file, ...(args ?? [])];
  } else if (isWin) {
    command = 'powershell';
    spawnArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...(args ?? [])];
  } else {
    command = 'node';
    spawnArgs = [file, ...(args ?? [])];
  }
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(command, spawnArgs, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        exitCode: 1, stdout: '', stderr: String(error?.message ?? error),
        durationMs: Date.now() - startedAt, timedOut: false,
      });
      return;
    }
    const timer = timeoutMs && Number.isFinite(timeoutMs)
      ? setTimeout(() => {
        timedOut = true;
        try { killRunnerTree(child); } catch {}
        setTimeout(() => { try { killRunnerTree(child, process.platform, 'SIGKILL'); } catch {} }, 5_000).unref?.();
      }, timeoutMs)
      : null;
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: 1, stdout, stderr: stderr + String(error?.message ?? error),
        durationMs: Date.now() - startedAt, timedOut: false,
      });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : (Number.isInteger(code) ? code : 1),
        stdout,
        stderr: timedOut ? `${stderr}\nclosure timeout after ${timeoutMs}ms` : stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

export function resolveClosureDisplayArgs(target) {
  return { file: target.file, args: [...(target.args ?? [])] };
}
