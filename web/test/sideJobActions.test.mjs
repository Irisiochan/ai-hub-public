import assert from 'node:assert/strict';
import {
  buildReworkPrompt,
  buildFollowupPrompt,
  defaultClosableTaskPath,
  followupIdempotencyKey,
  isTailTaskPath,
  reworkIdempotencyKey,
  taskPathCandidates,
  workerReceiptJobId,
} from '../src/sideJobActions.ts';

const receipt = {
  id: 42,
  origin: 'side',
  kind: 'text',
  meta: JSON.stringify({ event: 'worker-receipt', jobId: 'job-123' }),
  content: '验收失败：按钮没有可见报错',
};

assert.equal(workerReceiptJobId(receipt), 'job-123');
assert.equal(workerReceiptJobId({ ...receipt, origin: 'main' }), null);
assert.equal(workerReceiptJobId({
  ...receipt,
  origin: 'main',
  meta: JSON.stringify({ roomHost: { receipt: { jobId: 'job-room-receipt' } } }),
}), 'job-room-receipt');
assert.equal(workerReceiptJobId({
  ...receipt,
  origin: 'main',
  meta: JSON.stringify({ roomHost: { coordination: { jobId: 'job-room-coordination' } } }),
}), 'job-room-coordination');
assert.equal(workerReceiptJobId({
  ...receipt,
  origin: 'main',
  meta: JSON.stringify({ roomHost: { receipt: { requestedBy: 'codex' } } }),
}), null);
assert.equal(workerReceiptJobId({
  ...receipt,
  origin: 'main',
  meta: JSON.stringify({ roomHost: { coordination: { taskPath: 'tasks/demo.md' } } }),
}), null);
assert.equal(workerReceiptJobId({ ...receipt, meta: '{broken' }), null);
assert.equal(workerReceiptJobId({ ...receipt, meta: JSON.stringify({ event: 'other', jobId: 'job-123' }) }), null);

assert.equal(reworkIdempotencyKey('job-123', 42), 'rework-job-123-42');
const prompt = buildReworkPrompt({ prompt: '实现副窗操作按钮' }, receipt);
assert.match(prompt, /实现副窗操作按钮/);
assert.match(prompt, /验收失败：按钮没有可见报错/);
assert.match(prompt, /直接返工/);

const followupInput = { instruction: '补一个移动端确认框', runner: 'codex', workspace: 'C:/path/to/project' };
const followup = buildFollowupPrompt(followupInput, receipt);
assert.match(followup, /补一个移动端确认框/);
assert.match(followup, /验收失败：按钮没有可见报错/);
assert.equal(
  followupIdempotencyKey('job-123', 42, followupInput),
  followupIdempotencyKey('job-123', 42, { ...followupInput }),
  'same followup payload must keep one idempotency key'
);
assert.notEqual(
  followupIdempotencyKey('job-123', 42, followupInput),
  followupIdempotencyKey('job-123', 42, { ...followupInput, instruction: '另一单' })
);

const taskJob = { prompt: '实现 tasks/main-work.md；部署尾巴 tasks/deploy-main-work.md' };
assert.deepEqual(taskPathCandidates(taskJob, receipt), ['tasks/main-work.md', 'tasks/deploy-main-work.md']);
assert.equal(defaultClosableTaskPath(taskJob, receipt), 'tasks/main-work.md');
assert.equal(isTailTaskPath('tasks/worker-tail-demo.md'), true);
assert.equal(isTailTaskPath('tasks/deploy-demo.md'), true);
assert.equal(isTailTaskPath('tasks/main-work.md'), false);

console.log('side worker receipt action checks passed');
