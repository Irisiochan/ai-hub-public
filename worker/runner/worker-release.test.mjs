import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkerReleaseInfo,
  normalizeReleaseSha,
  readPendingRelease,
  releaseShaFromRoot,
} from './worker-release.mjs';

test('normalizeReleaseSha accepts 7-40 hex, lowercases, rejects garbage', () => {
  assert.equal(normalizeReleaseSha('ABC1234'), 'abc1234');
  assert.equal(normalizeReleaseSha('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(normalizeReleaseSha('zzz'), null);
  assert.equal(normalizeReleaseSha(''), null);
  assert.equal(normalizeReleaseSha(null), null);
  assert.equal(normalizeReleaseSha('abc'), null, 'shorter than 7 hex is not a sha');
});

test('releaseShaFromRoot reads the <sha12> (VPS) or <sha40> (PC launcher) release dir, null in a checkout', () => {
  assert.equal(releaseShaFromRoot('/opt/ai-hub-worker/9d71607abc12'), '9d71607abc12');
  const full = '11583cec75f6ecfbdd89963d22c5829b7b378de1';
  assert.equal(releaseShaFromRoot(['C:', 'Users', 'x', 'AppData', 'Local', 'ai-hub-worker', 'releases', full].join(String.fromCharCode(92))), full);
  assert.equal(releaseShaFromRoot(`/opt/ai-hub-worker/${full.toUpperCase()}`), full);
  assert.equal(releaseShaFromRoot('/opt/ai-hub-worker/9d71607abc'), null);
  assert.equal(releaseShaFromRoot('/opt/ai-hub-worker/9d71607abc1234'), null);
  assert.equal(releaseShaFromRoot('/opt/ai-hub-worker/9D71607ABC12'), '9d71607abc12');
  assert.equal(releaseShaFromRoot('/repo/worker'), null);
  assert.equal(releaseShaFromRoot(''), null);
  assert.equal(
    releaseShaFromRoot('/repo/worker', { AI_HUB_WORKER_RELEASE: 'd11dc47' }),
    'd11dc47',
    'env override wins for packaged/test layouts',
  );
  assert.equal(releaseShaFromRoot('/opt/ai-hub-worker/9d71607abc12', { AI_HUB_WORKER_RELEASE: 'zzz' }), '9d71607abc12');
});

test('readPendingRelease returns the sha or null, never throws', () => {
  const readFile = () => JSON.stringify({ sha: 'd11dc47767fd', short: 'd11dc47767fd', requestedAt: '2026-09-22T00:00:00Z' });
  const pending = readPendingRelease('/x/pending-release.json', { readFile });
  assert.equal(pending?.sha, 'd11dc47767fd');
  assert.equal(pending?.requestedAt, '2026-09-22T00:00:00Z');
  const missing = () => { const error = new Error('no such file'); error.code = 'ENOENT'; throw error; };
  assert.equal(readPendingRelease('/x/missing.json', { readFile: missing }), null);
  assert.equal(readPendingRelease('/x/bad.json', { readFile: () => 'not json' }), null);
  assert.equal(readPendingRelease('/x/empty.json', { readFile: () => '{}' }), null);
  assert.equal(readPendingRelease('/x/nosha.json', { readFile: () => '{"reason":"worker-busy"}' }), null);
});

test('buildWorkerReleaseInfo exposes releaseSha + pendingReleaseSha for /api/workers', () => {
  const info = buildWorkerReleaseInfo({
    releaseRoot: '/opt/ai-hub-worker/9d71607abc12',
    env: {},
    pendingFile: '/x/pending.json',
    readFile: () => JSON.stringify({ sha: 'BB183E01AE69' }),
  });
  assert.equal(info.releaseSha, '9d71607abc12');
  assert.equal(info.pendingReleaseSha, 'bb183e01ae69');
  const idle = buildWorkerReleaseInfo({
    releaseRoot: '/opt/ai-hub-worker/9d71607abc12',
    env: {},
    pendingFile: '/x/pending.json',
    readFile: () => { throw new Error('ENOENT'); },
  });
  assert.equal(idle.releaseSha, '9d71607abc12');
  assert.equal(idle.pendingReleaseSha, null);
  const pendingPath = buildWorkerReleaseInfo({
    releaseRoot: '/repo/worker',
    env: { AI_HUB_WORKER_PENDING_FILE: '/custom/pending.json' },
    readFile: (file) => {
      assert.equal(file, '/custom/pending.json');
      throw new Error('ENOENT');
    },
  });
  assert.equal(pendingPath.releaseSha, null);
  assert.equal(pendingPath.pendingReleaseSha, null);
});
