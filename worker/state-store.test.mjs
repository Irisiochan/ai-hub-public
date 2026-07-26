import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadState, saveLauncherState, saveWorkerSpool } from './state-store.mjs';

test('legacy active spool migrates into versioned jobs map', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-state-test-'));
  const file = path.join(dir, 'worker-state.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      active: { job: { id: 'job-1' }, outcome: null },
      events: [{ jobId: 'job-1' }],
    }));
    const state = loadState(file);
    assert.equal(state.version, 2);
    assert.equal(state.jobs['job-1'].job.id, 'job-1');
    assert.equal(state.events.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launcher and worker updates preserve each other in one state file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-state-test-'));
  const file = path.join(dir, 'worker-state.json');
  try {
    saveLauncherState(file, { state: 'online', launcherPid: 10 });
    saveWorkerSpool(file, {
      jobs: { 'job-2': { job: { id: 'job-2' }, phase: 'running' } },
      events: [{ jobId: 'job-2', payload: { kind: 'log' } }],
    });
    saveLauncherState(file, { state: 'restarting', launcherPid: 10 });
    const state = loadState(file);
    assert.equal(state.launcher.state, 'restarting');
    assert.equal(state.jobs['job-2'].phase, 'running');
    assert.equal(state.events[0].jobId, 'job-2');
    assert.equal(fs.existsSync(`${file}.lock`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
