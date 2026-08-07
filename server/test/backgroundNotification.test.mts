import assert from 'node:assert/strict';
import test from 'node:test';
import {
  backgroundDedupeMinutes,
  decideBackgroundNotification,
} from '../src/agents/backgroundNotification.js';

const meta = {
  messageType: 'background-event',
  eventSource: 'quarter-hour-check',
  eventId: 'evt-1',
};

test('NO_OP is persisted for audit but suppressed from UI notification', () => {
  const value = decideBackgroundNotification('NO_OP：没有状态变化', meta);
  assert.equal(value.route, 'suppress');
  assert.equal(value.kind, 'no_op');
  assert.equal(value.descriptor?.eventId, 'evt-1');
});

test('only explicit allowed outcomes are promoted to main chat', () => {
  const value = decideBackgroundNotification(
    '[AI_HUB_NOTIFY] {"kind":"delivery_block","key":"task-7:unpushed"}\n代码已提交，但尚未推送。',
    meta,
  );
  assert.equal(value.route, 'main');
  assert.equal(value.kind, 'delivery_block');
  assert.equal(value.content, '代码已提交，但尚未推送。');
  assert.equal(value.key, 'quarter-hour-check:task-7:unpushed');
});

test('unmarked replies remain traceable in side channel without interrupting main', () => {
  const value = decideBackgroundNotification('需要再核查一下。', meta);
  assert.equal(value.route, 'side');
  assert.equal(value.kind, 'unclassified');
});

test('dedupe window is configurable and bounded', () => {
  const previous = process.env.AI_HUB_BACKGROUND_NOTIFY_DEDUPE_MINUTES;
  process.env.AI_HUB_BACKGROUND_NOTIFY_DEDUPE_MINUTES = '45';
  assert.equal(backgroundDedupeMinutes(), 45);
  process.env.AI_HUB_BACKGROUND_NOTIFY_DEDUPE_MINUTES = '99999';
  assert.equal(backgroundDedupeMinutes(), 1440);
  if (previous === undefined) delete process.env.AI_HUB_BACKGROUND_NOTIFY_DEDUPE_MINUTES;
  else process.env.AI_HUB_BACKGROUND_NOTIFY_DEDUPE_MINUTES = previous;
});
