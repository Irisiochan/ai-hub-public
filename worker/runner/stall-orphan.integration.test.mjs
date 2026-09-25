import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { cleanupProvenTree, inspectProcessHistory, queryProcessTable } from './stall.mjs';

test('real orphan is held after parent exit and cleaned only with its captured identity', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async () => {
  // Child has an independent auto-stop deadline even if the test crashes.
  const parent = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    console.log('ready');
    process.stdin.once('data',()=>{
      const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),20000)'],{detached:true,stdio:'ignore',windowsHide:true});
      console.log(child.pid); child.unref(); process.exit(0);
    });
  `], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  parent.stdout.on('data', (c) => { output += c; });
  const exited = once(parent, 'exit');
  while (!output.includes('ready')) await new Promise((r) => setTimeout(r, 20));
  const before = await queryProcessTable();
  const identity = before.find((r) => r.pid === parent.pid);
  assert.ok(identity?.created);
  parent.stdin.end('spawn');
  await exited;
  const childPid = Number(output.trim().split(/\s+/).at(-1));
  try {
    const after = await queryProcessTable();
    const orphan = after.find((r) => r.pid === childPid);
    assert.ok(orphan);
    assert.equal(orphan.ppid, parent.pid);
    assert.equal(inspectProcessHistory(after, [identity]).unprovable, true);
    // With a separately captured child identity, root exit does not hide it.
    const verdict = await cleanupProvenTree(parent.pid, { known: [identity, orphan] });
    assert.equal(verdict.unprovable, false);
    assert.deepEqual(verdict.remaining, []);
    assert.ok(verdict.attempted.includes(childPid));
  } finally {
    if (parent.exitCode === null) parent.kill();
    // No blind PID kill: the orphan has its own bounded lifetime.
  }
});

test('linux: a dead session leader\'s reparented orphan is still found and reaped', {
  skip: process.platform !== 'linux', timeout: 30_000,
}, async () => {
  // The Worker spawns POSIX runners detached (own session). When the runner
  // dies its children reparent away, so only session membership ties them
  // back; a stranger outside the session must never be touched.
  const stranger = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),20000)'], { stdio: 'ignore' });
  const parent = spawn(process.execPath, ['-e', `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),20000)'],{stdio:'ignore'});
    console.log(child.pid); child.unref(); process.exit(0);
  `], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  parent.stdout.on('data', (c) => { output += c; });
  await once(parent, 'exit');
  const childPid = Number(output.trim());
  try {
    const rows = await queryProcessTable();
    const orphan = rows.find((r) => r.pid === childPid);
    assert.ok(orphan, 'orphan must be enumerable');
    assert.notEqual(orphan.ppid, parent.pid, 'linux reparents orphans');
    assert.equal(orphan.sid, parent.pid);
    const verdict = await cleanupProvenTree(parent.pid);
    assert.equal(verdict.unprovable, false);
    assert.deepEqual(verdict.attempted, [childPid]);
    assert.deepEqual(verdict.remaining, [], JSON.stringify(verdict));
    assert.ok(!verdict.attempted.includes(stranger.pid));
  } finally {
    try { stranger.kill('SIGKILL'); } catch {}
  }
});
