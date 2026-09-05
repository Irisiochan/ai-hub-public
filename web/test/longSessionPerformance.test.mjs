import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_CACHED_MESSAGES_PER_CONTACT,
  MAX_RECENT_MESSAGE_IDS,
  MAX_RENDERED_MESSAGES,
  MessageDeltaBatcher,
  applyMessageDeltaBatch,
  rememberRecentMessageId,
  selectMessageWindow,
  trimMessageCache,
  windowBoundaryForMessage,
} from '../src/messagePerformance.ts';

const message = (id, content = `message ${id}`) => ({
  id,
  contact_id: 'contact-a',
  sender: id % 2 ? 'agent-a' : 'user',
  role: id % 2 ? 'assistant' : 'user',
  kind: 'text',
  content,
  status: id === 1000 ? 'streaming' : 'done',
  turn_id: id % 2 ? `turn-${id}` : null,
  meta: '{}',
  origin: 'main',
  created_at: '2026-09-01T00:00:00.000Z',
});

const thousand = Array.from({ length: 1000 }, (_, index) => message(index + 1));
const latest = selectMessageWindow(thousand, null);
assert.equal(latest.messages.length, MAX_RENDERED_MESSAGES);
assert.deepEqual([latest.messages[0].id, latest.messages.at(-1).id], [801, 1000]);
assert.equal(latest.hasEarlier, true);
assert.equal(latest.hasLater, false);

const older = selectMessageWindow(thousand, latest.messages[0].id);
assert.deepEqual([older.messages[0].id, older.messages.at(-1).id], [601, 800]);
assert.equal(older.hasEarlier, true);
assert.equal(older.hasLater, true);

const receiptBoundary = windowBoundaryForMessage(thousand, 450);
const receiptWindow = selectMessageWindow(thousand, receiptBoundary);
assert.equal(receiptWindow.messages.some((row) => row.id === 450), true);

const oversized = Array.from({ length: 1250 }, (_, index) => message(index + 1));
const trimmed = trimMessageCache(oversized);
assert.equal(trimmed.length, MAX_CACHED_MESSAGES_PER_CONTACT);
assert.deepEqual([trimmed[0].id, trimmed.at(-1).id], [251, 1250]);

let scheduled = null;
let flushes = 0;
const aggregatedDeltas = new Map();
const batcher = new MessageDeltaBatcher(
  (batches) => {
    flushes += 1;
    for (const batch of batches) {
      for (const [messageId, text] of batch.deltas) {
        aggregatedDeltas.set(messageId, (aggregatedDeltas.get(messageId) ?? '') + text);
      }
    }
  },
  (callback) => {
    scheduled = callback;
    return 1;
  },
  () => { scheduled = null; },
);
for (let batch = 0; batch < 20; batch += 1) {
  for (let index = 0; index < 50; index += 1) {
    batcher.add({ contactId: 'contact-a', messageId: 1000, text: 'x' });
  }
  assert.equal(typeof scheduled, 'function');
  scheduled();
}
assert.equal(flushes, 20, '50 deltas per paint batch must produce 20 rather than 1000 state updates');
assert.equal(aggregatedDeltas.get(1000).length, 1000, 'delta text order/content must be preserved');
const updated = applyMessageDeltaBatch(thousand, aggregatedDeltas);
assert.equal(updated.at(-1).content.endsWith('x'.repeat(1000)), true);
assert.equal(updated[0], thousand[0], 'unchanged message references must remain stable for React.memo');

batcher.add({ contactId: 'contact-a', messageId: 1000, text: 'late' });
batcher.discard('contact-a', 1000);
batcher.flushNow();
assert.equal(flushes, 20, 'a terminal full row must discard buffered chunks for the same message');
batcher.close();

const recentIds = new Map();
for (let index = 0; index < MAX_RECENT_MESSAGE_IDS + 20; index += 1) {
  rememberRecentMessageId(recentIds, `contact-a:${index}`);
}
assert.equal(recentIds.size, MAX_RECENT_MESSAGE_IDS);
assert.equal(recentIds.has('contact-a:0'), false);

const root = path.resolve(import.meta.dirname, '..');
const listSource = fs.readFileSync(path.join(root, 'src/components/chat/MessageList.tsx'), 'utf8');
assert.match(listSource, /new MutationObserver/, 'read sentinels must share one persistent observer');
assert.doesNotMatch(
  listSource,
  /\}, \[messages, props\.onVisibleThrough, scrollRef\]\);/,
  'streaming changes must not rebuild every read observer subscription',
);

const baseline = {
  historyMessages: 1000,
  deltaEvents: 1000,
  stateUpdates: 1000,
  timelineRowsVisited: 1_000_000,
  maxRenderedMessages: 1000,
  observerSetups: 1000,
};
const optimized = {
  historyMessages: 1000,
  deltaEvents: 1000,
  stateUpdates: flushes,
  timelineRowsVisited: MAX_RENDERED_MESSAGES * flushes,
  maxRenderedMessages: latest.messages.length,
  observerSetups: 1,
};
console.log(JSON.stringify({ longSessionSmoke: { baseline, optimized } }));
