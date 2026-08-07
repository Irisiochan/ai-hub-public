import assert from 'node:assert/strict';
import {
  appendMessageDelta,
  createTrailingMessageReconciler,
  mergeIncomingMessage,
  mergeMessageRows,
  shouldReconcileMessagesAfterStatus,
} from '../src/messageMerge.ts';

const base = {
  id: 42,
  contact_id: 'contact-a',
  sender: 'agent-a',
  role: 'assistant',
  kind: 'text',
  content: '',
  status: 'streaming',
  turn_id: 'turn-a',
  meta: '{}',
  created_at: '2026-07-19T00:00:00.000Z',
};

const afterFirstChunk = appendMessageDelta([{ ...base }], 42, '开头先显示。');
assert.equal(afterFirstChunk[0].content, '开头先显示。');

const completedMissingPrefix = {
  ...base,
  content: '后面才有。',
  status: 'done',
};
assert.equal(
  mergeIncomingMessage(afterFirstChunk[0], completedMissingPrefix).content,
  '后面才有。',
  'a terminal row is authoritative even when its content is shorter or not a prefix of local deltas'
);

const completedWithPrefix = {
  ...base,
  content: '开头先显示。后面才有。',
  status: 'done',
};
assert.equal(
  mergeIncomingMessage(afterFirstChunk[0], completedWithPrefix).content,
  '开头先显示。后面才有。',
  'a complete row that extends streamed text should be accepted'
);

const afterLateChunk = appendMessageDelta(afterFirstChunk, 42, '继续。');
assert.equal(afterLateChunk[0].content, '开头先显示。继续。');

const resyncedRows = mergeMessageRows(afterLateChunk, [{ ...base, content: '', status: 'streaming' }]);
assert.equal(
  resyncedRows[0].content,
  '开头先显示。继续。',
  'a resync with the not-yet-persisted streaming row must not clear accumulated text'
);

for (const status of ['done', 'error', 'interrupted']) {
  const terminal = {
    ...base,
    content: `服务端终态：${status}`,
    status,
    meta: JSON.stringify({ status, usage: { output: 42 } }),
  };
  assert.deepEqual(
    mergeIncomingMessage(
      { ...afterLateChunk[0], meta: '{"localOnly":true}' },
      terminal
    ),
    terminal,
    `${status} must replace local content, meta and status as one authoritative row`
  );
}

const completedRow = {
  ...base,
  content: '服务端完整终态。',
  status: 'done',
  meta: '{"usage":{"output":8}}',
};
assert.deepEqual(
  mergeIncomingMessage(completedRow, {
    ...base,
    content: '旧流式快照。',
    status: 'streaming',
    meta: '{}',
  }),
  completedRow,
  'a stale streaming response must not regress a terminal SSE row'
);

assert.equal(
  shouldReconcileMessagesAfterStatus('thinking', 'idle', afterLateChunk),
  true,
  'busy → idle with a local streaming row needs a server reconciliation'
);
assert.equal(
  shouldReconcileMessagesAfterStatus('tool:search_vault', 'error', afterLateChunk),
  true,
  'tool → error with a local streaming row needs a server reconciliation'
);
assert.equal(
  shouldReconcileMessagesAfterStatus('streaming', 'idle', [completedRow]),
  false,
  'no reconciliation is needed once every local row is terminal'
);
assert.equal(
  shouldReconcileMessagesAfterStatus('idle', 'idle', afterLateChunk),
  false,
  'an idle snapshot without a busy transition must not create a refetch loop'
);

const pendingLoads = [];
let loadCount = 0;
const trailingReconcile = createTrailingMessageReconciler(() => {
  loadCount += 1;
  return new Promise((resolve) => pendingLoads.push(resolve));
});
const firstReconcile = trailingReconcile('contact-a');
await Promise.resolve();
assert.equal(loadCount, 1);
const terminalReconcile = trailingReconcile('contact-a');
const duplicateTerminalReconcile = trailingReconcile('contact-a');
assert.equal(terminalReconcile, firstReconcile);
assert.equal(duplicateTerminalReconcile, firstReconcile);
pendingLoads.shift()();
await Promise.resolve();
await Promise.resolve();
assert.equal(
  loadCount,
  2,
  'a request received during an in-flight stale GET must force one trailing GET'
);
pendingLoads.shift()();
await firstReconcile;
assert.equal(loadCount, 2, 'multiple pending requests should coalesce into one trailing GET');

// User message edit → save & regenerate: SSE/resync must accept rewritten text
// (not only pure appends). Previously non-prefix rewrites were treated as stale
// stream snapshots and the old content was kept.
const userBase = {
  id: 7,
  contact_id: 'contact-a',
  sender: 'user',
  role: 'user',
  kind: 'text',
  content: 'gem新消息一条prompt token情况，符合预期吗？',
  status: 'done',
  turn_id: null,
  meta: '{}',
  created_at: '2026-07-19T00:00:00.000Z',
};

const editedRewrite = {
  ...userBase,
  content: 'gemini新消息一条prompt token情况，符合预期吗？',
  meta: '{"edited":1}',
};
assert.equal(
  mergeIncomingMessage(userBase, editedRewrite).content,
  editedRewrite.content,
  'user rewrite (non-prefix) must replace stored content'
);

const editedShorten = {
  ...userBase,
  content: 'gemini新消息',
  meta: '{"edited":1}',
};
assert.equal(
  mergeIncomingMessage(userBase, editedShorten).content,
  editedShorten.content,
  'user shorten must replace stored content'
);

const editedAppend = {
  ...userBase,
  content: userBase.content + ' 再补一句',
  meta: '{"edited":1}',
};
assert.equal(
  mergeIncomingMessage(userBase, editedAppend).content,
  editedAppend.content,
  'user append edit must replace stored content'
);

const resyncedEdit = mergeMessageRows([userBase], [editedRewrite]);
assert.equal(
  resyncedEdit[0].content,
  editedRewrite.content,
  'loadMessages/resync after edit must not keep pre-edit user text'
);

console.log('message merge tests passed');
