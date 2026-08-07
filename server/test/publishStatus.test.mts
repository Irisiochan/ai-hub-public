import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectRepo } from '../src/publishStatus.js';

test('uses a sanitized publish snapshot without reading repository metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-publish-'));
  const snapshot = path.join(dir, 'status.json');
  fs.writeFileSync(snapshot, JSON.stringify({
    available: true,
    branch: 'master',
    currentCommit: 'abc123',
    remoteCommit: 'abc123',
    matchesRemote: true,
    dirty: false,
  }));

  const result = await inspectRepo('app', 'app repo', path.join(dir, 'unreadable-repo'), snapshot);
  assert.deepEqual(result, {
    id: 'app',
    name: 'app repo',
    available: true,
    branch: 'master',
    currentCommit: 'abc123',
    remoteCommit: 'abc123',
    matchesRemote: true,
    dirty: false,
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rejects malformed snapshots and preserves the normal fallback', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-publish-'));
  const snapshot = path.join(dir, 'status.json');
  fs.writeFileSync(snapshot, JSON.stringify({ available: true, currentCommit: 'abc123' }));

  const result = await inspectRepo('memory', 'memory repo', null, snapshot);
  assert.equal(result.available, false);
  assert.equal(result.error, '未配置仓库路径');
  fs.rmSync(dir, { recursive: true, force: true });
});
