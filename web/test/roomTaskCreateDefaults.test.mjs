import assert from 'node:assert/strict';
import { defaultRepoId, defaultWorkspaceFor, needsPcSelected, taskSlugOf } from '../src/roomTasks/roomTaskDefaults.ts';

const targets = [
  { repoId: 'ai-hub', platform: 'linux', workerId: 'vps-dev', workspace: '/srv/ai-dev/jobs' },
  { repoId: 'ai-dashboard', platform: 'linux', workerId: 'vps-dev', workspace: '/srv/ai-dev/jobs' },
];

// 有映射默认 VPS 围栏工作区
assert.equal(defaultWorkspaceFor('ai-hub', 'tasks/vps-full-closure.md', targets), '/srv/ai-dev/jobs/vps-full-closure');
assert.equal(defaultRepoId(targets), 'ai-hub');
// 未映射回退 null（调用方走 PC）
assert.equal(defaultWorkspaceFor('unknown', 'tasks/x.md', targets), null);
assert.equal(defaultWorkspaceFor('ai-hub', 'tasks/x.md', []), null);
assert.equal(defaultRepoId([]), '');
// 非法 task_path 推导不出工作区
assert.equal(defaultWorkspaceFor('ai-hub', 'tasks/../escape.md', targets), null);
assert.equal(defaultWorkspaceFor('ai-hub', '', targets), null);
assert.equal(taskSlugOf('tasks/demo.md'), 'demo');
assert.equal(taskSlugOf('tasks/../escape.md'), null);
// PC 能力声明
assert.equal(needsPcSelected({ camera: false, taobao: false, ssh: false, win32: false }), false);
assert.equal(needsPcSelected({ camera: true, taobao: false, ssh: false, win32: false }), true);
assert.equal(needsPcSelected({ camera: false, taobao: false, ssh: true, win32: false }), true);
console.log('room task create defaults passed: vps default, pc fallback, needs-pc flags');
