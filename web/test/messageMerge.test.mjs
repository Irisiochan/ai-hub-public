import assert from 'node:assert/strict';
import {
  appendMessageDelta,
  mergeIncomingMessage,
  mergeMessageRows,
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
  '开头先显示。',
  'a complete row must not overwrite already streamed visible text with a shorter/non-prefix body'
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

const afterLateChunk = appendMessageDelta([mergeIncomingMessage(afterFirstChunk[0], completedMissingPrefix)], 42, '继续。');
assert.equal(afterLateChunk[0].content, '开头先显示。继续。');

const resyncedRows = mergeMessageRows(afterLateChunk, [{ ...base, content: '', status: 'streaming' }]);
assert.equal(
  resyncedRows[0].content,
  '开头先显示。继续。',
  'a resync with the not-yet-persisted streaming row must not clear accumulated text'
);

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
