import assert from 'node:assert/strict';
import {
  isWindowsWorkspace,
  normalizeWorkspace,
  workspaceAllowed,
} from '../src/jobs/jobStore.js';

// G01: path.win32.isAbsolute('/srv/...') is true (rooted on current drive),
// which misclassified every POSIX workspace as Windows. Classification must
// follow the string form, never host path semantics.
assert.equal(isWindowsWorkspace('/srv/ai-dev/jobs/task-1'), false);
assert.equal(isWindowsWorkspace('/opt/ai-hub'), false);
assert.equal(isWindowsWorkspace('  /srv/ai-dev/jobs  '), false);
assert.equal(isWindowsWorkspace('C:/path/to/project'), true);
assert.equal(isWindowsWorkspace('C:/path/to/project/jobs'), true);
assert.equal(isWindowsWorkspace('C:\\path\\to\\project'), true);
assert.equal(isWindowsWorkspace('\\\\host\\share\\ai-hub'), true);
assert.equal(isWindowsWorkspace('relative/path'), false);

// POSIX workspaces keep POSIX normalization (no win32 backslash rewrite).
assert.equal(normalizeWorkspace('/srv/ai-dev/jobs'), '/srv/ai-dev/jobs');
assert.equal(normalizeWorkspace('C:/path/to/project'), 'C:\\path\\to\\project');

// Containment follows the fix: POSIX pairs match, cross-platform pairs never do.
assert.equal(workspaceAllowed('/srv/ai-dev/jobs/task-1', ['/srv/ai-dev/jobs']), true);
assert.equal(workspaceAllowed('/srv/ai-dev/other', ['/srv/ai-dev/jobs']), false);
assert.equal(workspaceAllowed('/srv/ai-dev/jobs', ['C:/path/to/project']), false);
assert.equal(workspaceAllowed('C:/path/to/project/jobs/x', ['C:/path/to/project']), true);

console.log('vpsWorkspacePlatform: G01 isWindowsWorkspace classification OK');
