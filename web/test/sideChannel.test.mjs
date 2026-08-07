import assert from 'node:assert/strict';
import { messagesForChannel, shouldMarkSideUnread } from '../src/sideChannel.ts';
import { automationDescriptor, effectiveMessageOrigin, isManualUserMessage } from '../src/messageSource.ts';

const main = {
  id: 1,
  contact_id: 'codex',
  sender: 'user',
  role: 'user',
  kind: 'text',
  content: 'hello',
  status: 'done',
  turn_id: null,
  meta: '{}',
  origin: 'main',
  created_at: '2026-07-27 07:00:00',
};
const side = {
  ...main,
  id: 2,
  sender: 'system',
  content: 'automation',
  origin: 'side',
};
const metadataSide = {
  ...main,
  id: 3,
  meta: JSON.stringify({
    messageType: 'background-event',
    eventSource: 'quarter-hour-check',
    eventId: 'event-3',
    eventCategory: 'backlog',
    eventPriority: 2,
  }),
};
const legacySide = {
  ...main,
  id: 4,
  content: '⚡ AI Hub 自主事件分派\n来源：legacy-timer\n分类：system｜优先级：P1',
};


const all = [main, side, metadataSide, legacySide];
assert.deepEqual(messagesForChannel(all, 'main').map((message) => message.id), [1]);
assert.deepEqual(messagesForChannel(all, 'side').map((message) => message.id), [2, 3, 4]);
assert.equal(effectiveMessageOrigin(metadataSide), 'side');
assert.equal(automationDescriptor(metadataSide)?.eventSource, 'quarter-hour-check');
assert.equal(automationDescriptor(legacySide)?.eventSource, 'legacy-timer');
assert.equal(isManualUserMessage(main), true, 'manual user input remains a user bubble');
assert.equal(isManualUserMessage(metadataSide), false, 'metadata prevents automation from impersonating User');

assert.equal(
  shouldMarkSideUnread(side, 'codex', 'main'),
  true,
  'side traffic should light the gray dot while the main window is open'
);
assert.equal(
  shouldMarkSideUnread(side, 'codex', 'side'),
  false,
  'side traffic is already read while its window is open'
);
assert.equal(
  shouldMarkSideUnread(side, 'claude', 'side'),
  true,
  'opening another contact side window must not clear this contact'
);
assert.equal(
  shouldMarkSideUnread(metadataSide, 'codex', 'main'),
  true,
  'metadata-classified background traffic lights the side unread marker'
);
assert.equal(
  shouldMarkSideUnread(main, null, 'main'),
  false,
  'main conversation messages never affect the side gray dot'
);

console.log('side channel tests passed');
