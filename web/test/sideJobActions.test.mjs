import assert from 'node:assert/strict';
import {
  buildReworkPrompt,
  buildFollowupPrompt,
  defaultClosableTaskPath,
  followupIdempotencyKey,
  isTailTaskPath,
  isActionableReceiptJob,
  loadHandledReceiptIds,
  pendingReceiptCards,
  reworkIdempotencyKey,
  saveHandledReceiptIds,
  taskPathCandidates,
  vaultTaskAlreadySettled,
  visibleJobsForContact,
  workerReceiptJobId,
} from '../src/sideJobActions.ts';

const receipt = {
  id: 42,
  origin: 'side',
  kind: 'text',
  meta: JSON.stringify({ event: 'worker-receipt', jobId: 'job-123' }),
  content: '验收失败：按钮没有可见报错',
};

assert.equal(workerReceiptJobId(receipt), null, 'legacy side receipts no longer expose action cards');
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

const roomReceipt = {
  ...receipt,
  id: 43,
  origin: 'main',
  meta: JSON.stringify({ roomHost: { receipt: { jobId: 'job-room-receipt' } } }),
};
const secondRoomReceipt = {
  ...roomReceipt,
  id: 44,
  meta: JSON.stringify({ roomHost: { receipt: { jobId: 'job-room-second' } } }),
};
const receiptJobs = [
  { id: 'job-room-receipt' },
  { id: 'job-room-second' },
];
assert.deepEqual(
  pendingReceiptCards([receipt, roomReceipt, secondRoomReceipt], receiptJobs),
  [
    { message: roomReceipt, job: receiptJobs[0] },
    { message: secondRoomReceipt, job: receiptJobs[1] },
  ],
  'only structured receipts with a matching loaded job are actionable',
);
assert.deepEqual(
  pendingReceiptCards([roomReceipt, secondRoomReceipt], receiptJobs, new Set([43])),
  [{ message: secondRoomReceipt, job: receiptJobs[1] }],
  'a successfully handled receipt leaves the pending entry',
);
assert.deepEqual(pendingReceiptCards([roomReceipt], []), [], 'a receipt without job data has no action card');

const closedLoopJob = {
  id: 'job-room-receipt',
  delivery_summary: { state: 'closed_loop', label: '已闭环', summary: '', nextOwner: '', needsUserDecision: false },
};
assert.equal(isActionableReceiptJob(closedLoopJob), false);
assert.deepEqual(
  pendingReceiptCards([roomReceipt], [closedLoopJob]),
  [],
  'closed-loop receipts leave the pending pin bar',
);
assert.equal(
  isActionableReceiptJob({ id: 'job-open', delivery_summary: { state: 'online_waiting_validation', label: '已上线，等待验收', summary: '', nextOwner: '', needsUserDecision: false } }),
  true,
);

const memoryStorage = {
  data: {},
  getItem(key) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null; },
  setItem(key, value) { this.data[key] = String(value); },
};
saveHandledReceiptIds('cmrhxny03', new Set([43, 44]), memoryStorage);
assert.deepEqual([...loadHandledReceiptIds('cmrhxny03', memoryStorage)].sort((a, b) => a - b), [43, 44]);
assert.deepEqual(
  pendingReceiptCards([roomReceipt, secondRoomReceipt], receiptJobs, loadHandledReceiptIds('cmrhxny03', memoryStorage)),
  [],
  'persisted handled ids survive a remount-style reload',
);

const roomId = 'cmrhxny03';
const chengReceiptJob = {
  id: 'job-room-receipt',
  origin_contact_id: 'claude',
  requested_by: 'claude',
  status: 'blocked',
};
const unrelatedJob = {
  id: 'job-unrelated',
  origin_contact_id: 'codex',
  requested_by: 'codex',
  status: 'blocked',
};
const legacyRoomJobs = [chengReceiptJob, unrelatedJob].filter(
  (job) =>
    job.origin_contact_id === roomId ||
    (!job.origin_contact_id && job.requested_by === roomId && new Set(['pending']).has(job.status)),
);
assert.deepEqual(
  pendingReceiptCards([roomReceipt], legacyRoomJobs),
  [],
  'the old contact-origin predicate drops a room receipt whose job originated from claude',
);

const visibleRoomJobs = visibleJobsForContact(
  roomId,
  [roomReceipt],
  [chengReceiptJob, unrelatedJob],
  new Set(['pending']),
);
assert.deepEqual(
  visibleRoomJobs.map((job) => job.id),
  ['job-room-receipt'],
  'the receipt-linked claude job is visible without leaking an unrelated job',
);
assert.ok(
  pendingReceiptCards([roomReceipt], visibleRoomJobs).length >= 1,
  'the visible receipt job contributes a pending action card',
);
assert.ok(
  visibleRoomJobs.find((job) => job.id === workerReceiptJobId(roomReceipt)),
  'MessageList can find the receipt job and mount SideJobActions',
);

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

class FakeApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
assert.equal(vaultTaskAlreadySettled(new FakeApiError('任务不是 open 状态，未执行置 done', 409)), true);
assert.equal(vaultTaskAlreadySettled(new FakeApiError('任务读取失败：文件不存在', 404)), true);
assert.equal(vaultTaskAlreadySettled(new FakeApiError('尾巴任务不能从回执快捷按钮关闭，请在任务账本单独处理', 409)), false);
assert.equal(vaultTaskAlreadySettled(new Error('任务不是 open 状态，未执行置 done')), false);

console.log('side worker receipt action checks passed');
