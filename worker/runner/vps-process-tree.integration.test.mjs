import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { killRunnerTree } from './runner.mjs';

// G01 Linux parent/child/grandchild integration: a detached parent (its own
// process group, as runRunnerOnce spawns on POSIX) raises a child and a
// grandchild in the same group; killRunnerTree must end the whole tree, not
// just the direct child. POSIX-only: on win32 this reports un-run instead of
// mocking a process group that Windows does not have.

const POSIX_ONLY = process.platform === 'win32'
  ? 'not run on this host: POSIX process groups do not exist on win32; run on the Linux VPS'
  : undefined;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('group SIGTERM ends a real parent/child/grandchild tree', { skip: POSIX_ONLY }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-proctree-'));
  const pidFile = (name) => path.join(dir, `${name}.pid`);
  // Each level writes its pid file then idles; children inherit the parent's
  // process group (no detached flag below the root).
  const idleScript = (name, next) => `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    fs.writeFileSync(${JSON.stringify(pidFile(name))}, String(process.pid));
    ${next ? `const next = spawn(process.execPath, [${JSON.stringify(next)}], { stdio: 'ignore' }); next.unref();` : ''}
    setInterval(() => {}, 1000);
  `;
  const grandchild = path.join(dir, 'grandchild.cjs');
  const child = path.join(dir, 'child.cjs');
  fs.writeFileSync(grandchild, idleScript('grandchild', null));
  fs.writeFileSync(child, idleScript('child', grandchild));

  const parent = spawn(
    process.execPath,
    ['-e', idleScript('parent', child)],
    { detached: true, stdio: 'ignore' },
  );
  parent.unref();
  const tree = { pid: parent.pid, kill: (sig) => parent.kill(sig) };
  try {
    await waitFor(
      () => ['parent', 'child', 'grandchild'].every((n) => fs.existsSync(pidFile(n))),
      10_000,
      'all three generations to start',
    );
    const pids = ['parent', 'child', 'grandchild'].map((n) => Number(fs.readFileSync(pidFile(n), 'utf8')));
    assert.ok(pids.every(Number.isInteger));
    assert.ok(pids.every(alive), 'all three generations must be alive before the kill');

    const mode = killRunnerTree(tree, 'linux');
    assert.equal(mode, 'group-sigterm');
    await waitFor(() => pids.every((pid) => !alive(pid)), 10_000, 'the whole tree to exit');
  } finally {
    try { killRunnerTree(tree, process.platform, 'SIGKILL'); } catch {}
    try { parent.kill('SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
