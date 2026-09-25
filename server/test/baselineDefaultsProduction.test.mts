import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { productionBaselineReaders, resolveBaselineDefault } from '../src/roomTasks/baselineDefaults.js';

test('offline baseline uses receipt only when checkout and local master agree', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-baseline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'deployed');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/master', sha);
  git('remote', 'add', 'origin', 'file:///nonexistent/ai-hub.git');
  const receiptFile = path.join(dir, 'receipt.json');
  fs.writeFileSync(receiptFile, JSON.stringify({ commit: sha }));
  const readers = productionBaselineReaders({ repoDir: dir, receiptFile });
  assert.deepEqual(resolveBaselineDefault(readers), { ok: true, sha, source: 'deploy-receipt' });
  assert.equal(resolveBaselineDefault(productionBaselineReaders({ repoDir: dir, receiptFile, repoId: 'other' })).ok, false);

  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'unreleased');
  const unreleased = git('rev-parse', 'HEAD');
  assert.equal(resolveBaselineDefault(readers).ok, false);
  git('reset', '--hard', sha);
  git('update-ref', 'refs/remotes/origin/master', unreleased);
  assert.equal(resolveBaselineDefault(readers).ok, false);
});
