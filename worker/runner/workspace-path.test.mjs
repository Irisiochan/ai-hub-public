import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  normalizeWorkspacePath,
  resolveStateFile,
  resolveWorkspaceTarget,
  workspaceContains,
  workspaceKey,
} from './workspace-path.mjs';

test('Windows comparison folds case, POSIX preserves it', () => {
  assert.equal(workspaceKey('C:/path/to/project', 'win32'), workspaceKey('C:/path/to/project', 'win32'));
  assert.notEqual(workspaceKey('/srv/AI-Dev', 'linux'), workspaceKey('/srv/ai-dev', 'linux'));
  assert.equal(normalizeWorkspacePath('E:/a//b/./c', 'win32'), path.win32.normalize('E:/a//b/./c'));
  assert.equal(normalizeWorkspacePath('/srv//ai-dev/./jobs', 'linux'), '/srv/ai-dev/jobs');
});

test('cross-platform roots never contain each other', () => {
  assert.equal(workspaceContains('C:/path/to/project', 'C:/path/to/project/jobs/x', 'win32'), true);
  assert.equal(workspaceContains('C:/path/to/project', 'C:/path/to/project/JOBS', 'win32'), true);
  assert.equal(workspaceContains('/srv/ai-dev/jobs', '/srv/ai-dev/jobs/task-1', 'linux'), true);
  assert.equal(workspaceContains('/srv/ai-dev/jobs', '/srv/AI-DEV/jobs/task-1', 'linux'), false);
  assert.equal(workspaceContains('C:/path/to/project', '/srv/ai-dev/jobs', 'win32'), false);
  assert.equal(workspaceContains('/srv/ai-dev/jobs', 'C:/path/to/project', 'linux'), false);
  assert.equal(workspaceContains('/srv', '/srv', 'linux'), true);
});

test('resolveWorkspaceTarget rejects escapes including via symlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-ws-'));
  try {
    const root = path.join(dir, 'root');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const inner = path.join(root, 'task-1');
    fs.mkdirSync(inner, { recursive: true });
    assert.equal(resolveWorkspaceTarget(root, inner), fs.realpathSync(inner));
    assert.throws(() => resolveWorkspaceTarget(root, outside), /outside allowlist/);
    if (process.platform !== 'win32') {
      const link = path.join(root, 'evil-link');
      try { fs.symlinkSync(outside, link); } catch { return; }
      assert.throws(() => resolveWorkspaceTarget(root, link), /realpath escapes/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stateFile resolves to an absolute path anchored at the config dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-state-'));
  try {
    const configPath = path.join(dir, 'etc', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const resolved = resolveStateFile(configPath, '/var/lib/ai-dev-worker/worker-state.json');
    assert.ok(path.isAbsolute(resolved) || resolved.startsWith('/'));
    assert.equal(resolved, '/var/lib/ai-dev-worker/worker-state.json');
    const relative = resolveStateFile(configPath, 'worker-state.json');
    assert.equal(relative, path.resolve(path.dirname(configPath), 'worker-state.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
