import assert from 'node:assert/strict';
import { isActiveRoomTask, taskFileOf, taskStatusText } from '../src/roomTasks/roomTasks.ts';

assert.equal(taskFileOf('tasks/demo.md'), 'demo.md');
assert.equal(taskFileOf('demo.md'), 'demo.md');
assert.equal(taskStatusText('open'), '待处理');
assert.equal(taskStatusText('in_progress'), '执行中');
assert.equal(taskStatusText('in_review'), '评审/发布中');
assert.equal(taskStatusText('blocked'), '受阻');
assert.equal(taskStatusText('closed'), '已关闭');
assert.equal(taskStatusText('dropped'), '已丢弃');
assert.equal(taskStatusText('weird'), 'weird');
assert.equal(isActiveRoomTask('in_progress'), true);
assert.equal(isActiveRoomTask('blocked'), true);
assert.equal(isActiveRoomTask('closed'), false);
assert.equal(isActiveRoomTask('dropped'), false);
console.log('room tasks UI contracts passed: file mapping and status text');
