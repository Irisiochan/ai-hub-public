// Room execute auto-commit (User 2026-09-23): a runner that finishes the work,
// declares every test passing, but leaves it uncommitted used to end
// blocked_local_changes — review cannot pin a SHA, so a whole extra execute
// round went to "just commit it". The Worker now commits and pushes such a
// round itself. Anything short of the full condition keeps the blocked
// receipt exactly as before; review and the merge gate still judge the SHA.
import { spawn } from 'node:child_process';

const SENSITIVE_FILE_RE = /(^|\/)(\.env(\.[^/]*)?|id_rsa[^/]*|id_ed25519[^/]*|\.npmrc|\.netrc|credentials[^/]*)$|\.(pem|key|p12|pfx)$/i;
const BLOCKED_STATES = new Set(['blocked_local_changes', 'blocked_unpushed']);
const TRUNK_BRANCHES = new Set(['master', 'main']);

function git(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let settled = false;
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.once('error', (error) => {
      settled = true;
      resolve({ ok: false, stdout: '', stderr: String(error?.message ?? error) });
    });
    child.once('close', (code) => {
      if (settled) return;
      resolve({ ok: code === 0, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

/** Pure gate. `ok:false` carries the reason; `applicable:false` means the job never opted in. */
export function autoCommitEligibility({ job, delivery, declaration, before, after, exitCode }) {
  if (job?.options?.autoCommitOnPass !== true) return { ok: false, applicable: false, reason: 'not opted in' };
  if (job?.permissions?.write !== true) return { ok: false, applicable: false, reason: 'job has no write permission' };
  if (!BLOCKED_STATES.has(delivery?.state)) return { ok: false, applicable: false, reason: `delivery ${delivery?.state ?? 'unknown'}` };
  if (exitCode !== 0) return { ok: false, applicable: true, reason: `runner exited code=${exitCode}` };
  const tests = Array.isArray(declaration?.tests) ? declaration.tests : [];
  if (tests.length === 0) return { ok: false, applicable: true, reason: 'no declared tests' };
  const failing = tests.filter((test) => test.status !== 'pass');
  if (failing.length) {
    return { ok: false, applicable: true, reason: `declared tests not all pass: ${failing.map((test) => test.suite).slice(0, 5).join('; ')}` };
  }
  if (!before || before.dirty) return { ok: false, applicable: true, reason: 'workspace was not clean before the run' };
  if (!after?.branch) return { ok: false, applicable: true, reason: 'detached HEAD' };
  // Trunk only moves through the merge gate.
  if (TRUNK_BRANCHES.has(after.branch)) return { ok: false, applicable: true, reason: `on trunk branch ${after.branch}` };
  const sensitive = (after.dirtyFiles ?? []).filter((file) => SENSITIVE_FILE_RE.test(String(file).replaceAll('\\', '/')));
  if (sensitive.length) return { ok: false, applicable: true, reason: `sensitive-looking files: ${sensitive.slice(0, 5).join(', ')}` };
  return { ok: true, applicable: true, reason: 'all declared tests pass' };
}

export function autoCommitMessage({ job, declaration }) {
  const summary = String(declaration?.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const taskPath = String(job?.options?.taskPath ?? '').trim();
  return [
    summary || `room execute ${taskPath || job?.id || ''}`.trim(),
    '',
    'Auto-committed by the ai-hub Worker: the runner left its changes',
    'uncommitted and declared every test passing.',
    ...(taskPath ? [`Task: ${taskPath}`] : []),
    `Job: ${job?.id ?? 'unknown'}`,
    `Tests: ${(declaration?.tests ?? []).map((test) => test.suite).join('; ').slice(0, 800)}`,
  ].join('\n');
}

/**
 * Commit (when dirty) and push the current branch. Returns
 * { committed, pushed, sha, error? }; never throws. A failed push keeps the
 * commit (blocked_unpushed, same as a runner that committed but never pushed).
 */
export async function autoCommitAndPush(cwd, { job, declaration, after }) {
  let committed = false;
  if (after?.dirty) {
    const add = await git(cwd, ['add', '-A']);
    if (!add.ok) return { committed, pushed: false, sha: null, error: `git add failed: ${add.stderr.trim().slice(0, 300)}` };
    const email = await git(cwd, ['config', 'user.email']);
    const identity = email.ok && email.stdout.trim()
      ? []
      : ['-c', 'user.name=ai-hub-worker', '-c', 'user.email=ai-hub-worker@localhost'];
    const commit = await git(cwd, [...identity, 'commit', '-q', '-m', autoCommitMessage({ job, declaration })]);
    if (!commit.ok) {
      // Leave the tree as the runner left it: unstage what we staged.
      await git(cwd, ['reset', '-q']);
      return { committed, pushed: false, sha: null, error: `git commit failed: ${(commit.stderr || commit.stdout).trim().slice(0, 300)}` };
    }
    committed = true;
  }
  const head = await git(cwd, ['rev-parse', 'HEAD']);
  const sha = head.ok ? head.stdout.trim() : null;
  const push = await git(cwd, ['push', '-u', 'origin', 'HEAD']);
  if (!push.ok) return { committed, pushed: false, sha, error: `git push failed: ${push.stderr.trim().slice(0, 300)}` };
  return { committed, pushed: true, sha };
}
