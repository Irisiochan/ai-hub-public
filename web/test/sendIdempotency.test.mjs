import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import {
  buildMessageRequestBody,
  createMessageIdempotencyKey,
  persistedSendResultFromError,
  prepareMessageSendAttempt,
} from '../src/sendIdempotency.ts';

assert.equal(
  createMessageIdempotencyKey(() => 'fixed-uuid'),
  'message:fixed-uuid'
);

let keySequence = 0;
const createKey = () => `message:key-${++keySequence}`;
const image = { name: 'same-object.png' };
const first = prepareMessageSendAttempt(null, 'codex', 'hello', [image], createKey);
const retry = prepareMessageSendAttempt(first, 'codex', 'hello', [image], createKey);
assert.equal(retry, first, 'a failed retry of the same payload reuses its key');
assert.equal(keySequence, 1);
const edited = prepareMessageSendAttempt(retry, 'codex', 'hello edited', [image], createKey);
assert.notEqual(edited.idempotencyKey, first.idempotencyKey);
assert.equal(keySequence, 2);
const afterSuccess = prepareMessageSendAttempt(null, 'codex', 'hello', [image], createKey);
assert.notEqual(afterSuccess.idempotencyKey, first.idempotencyKey);

const jsonBody = buildMessageRequestBody('json message', [], 'message:json-key');
assert.equal(typeof jsonBody, 'string');
assert.deepEqual(JSON.parse(jsonBody), {
  content: 'json message',
  idempotencyKey: 'message:json-key',
});

const file = new File([Buffer.from('89504e470d0a1a0a', 'hex')], 'tiny.png', {
  type: 'image/png',
});
const formBody = buildMessageRequestBody('form message', [file], 'message:form-key');
assert.ok(formBody instanceof FormData);
assert.equal(formBody.get('content'), 'form message');
assert.equal(formBody.get('idempotencyKey'), 'message:form-key');
assert.equal(formBody.get('images').name, 'tiny.png');

assert.deepEqual(
  persistedSendResultFromError({
    error: 'queue full',
    messageId: 42,
    persisted: true,
    queued: false,
  }),
  {
    error: 'queue full',
    messageId: 42,
    persisted: true,
    queued: false,
  },
  'queue-full with a persisted id resolves as sent instead of triggering another send'
);
assert.equal(
  persistedSendResultFromError({ error: 'queue full', persisted: false }),
  null
);

console.log('message send idempotency checks passed');
