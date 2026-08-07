import assert from 'node:assert/strict';
import {
  countsAsUnread,
  incrementReadStateForIncoming,
  unreadHydrationAfter,
} from '../src/unreadState.ts';

const base = {
  id: 101,
  contact_id: 'codex',
  sender: 'codex',
  role: 'assistant',
  kind: 'text',
  content: 'new reply',
  status: 'done',
  turn_id: null,
  meta: '{}',
  origin: 'main',
  created_at: '2026-08-02 04:00:00',
};

assert.equal(countsAsUnread(base), true);
assert.equal(countsAsUnread({ ...base, kind: 'thinking' }), false);
assert.equal(
  countsAsUnread({ ...base, sender: 'user', role: 'user' }),
  false,
  'manual User messages never create unread badges'
);

const first = incrementReadStateForIncoming(undefined, base, false);
assert.deepEqual(first, {
  origin: 'main',
  lastReadMessageId: 0,
  firstUnreadId: 101,
  unreadCount: 1,
});
assert.equal(
  incrementReadStateForIncoming(first, base, true),
  first,
  'an SSE update for an existing streaming row must not double count'
);
assert.equal(unreadHydrationAfter({ ...first, unreadCount: 80 }, [152, 153]), 0);
assert.equal(unreadHydrationAfter(first, [100, 101, 102]), null);

console.log('unread state tests passed');
