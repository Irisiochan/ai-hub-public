// Receipt field fallbacks: a declaration embedded in the stored result text
// (old worker releases never scanned the joined OpenCode result) feeds the
// review/merge gates per field, only where delivery_meta carries neither a
// receipt value nor a declared value. Git-collected receipt facts always win.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declarationFromResultText, structuredReceiptFields } from '../src/jobs/receiptFields.js';

const fencedResult = [
  'Done. Verification summary above.',
  '',
  '```json',
  '{"delivery":{"committed":true,"pushed":true,"stage":"waiting_review","diffstat":"6 files changed, 81 insertions(+), 6 deletions(-)","changedFiles":["worker/runner.mjs","worker/runner.test.mjs"],"tests":[{"suite":"npm test --prefix worker","status":"pass"},{"suite":"npm run build --prefix server","status":"pass"}]}}',
  '```',
].join('\r\n');

test('declarationFromResultText reads the last fenced delivery declaration', () => {
  const declared = declarationFromResultText(fencedResult);
  assert.equal(declared?.committed, true);
  assert.equal(Array.isArray(declared?.tests) ? declared.tests.length : 0, 2);
  assert.equal(declarationFromResultText('no declaration here {"x":1}'), null);
  assert.equal(declarationFromResultText('{"delivery":{"committed":"yes"}}'), null, 'non-boolean fields are not a declaration');
});

test('structuredReceiptFields falls back to the embedded declaration only for missing fields', () => {
  const job = {
    delivery_meta: JSON.stringify({
      state: 'delivered',
      source: 'git',
      receipt: {
        branch: 'room-workflow-direct-loop',
        head: '3e1ecbc98368b9b672fd08bdcfcc2ce795cc34df',
        diffstat: '44 files changed, 802 insertions(+), 4079 deletions(-)',
        changedFiles: { files: ['README.md'], total: 44, truncated: false },
        tests: [],
      },
    }),
    result: fencedResult,
  };
  const fields = structuredReceiptFields(job);
  assert.equal(fields.head, '3e1ecbc98368b9b672fd08bdcfcc2ce795cc34df');
  assert.equal(fields.diffstat, '44 files changed, 802 insertions(+), 4079 deletions(-)', 'git-collected diffstat wins');
  assert.equal(fields.changedFiles?.total, 44);
  assert.deepEqual(fields.tests, [
    { suite: 'npm test --prefix worker', status: 'pass' },
    { suite: 'npm run build --prefix server', status: 'pass' },
  ]);
});

test('declared fields win, but a stage-only declared block does not hide the embedded tests', () => {
  const withTests = {
    delivery_meta: JSON.stringify({
      state: 'delivered',
      source: 'cli',
      declared: { committed: true, pushed: true, tests: [{ suite: 'declared suite', status: 'fail' }] },
      receipt: { head: 'abc', tests: [] },
    }),
    result: fencedResult,
  };
  assert.deepEqual(structuredReceiptFields(withTests).tests, [{ suite: 'declared suite', status: 'fail' }]);
  // 2026-09-15: the deploy event rewrote the candidate's declared block to
  // stage/summary/nextOwner only, which used to disable the fallback entirely.
  const stageOnly = {
    delivery_meta: JSON.stringify({
      state: 'delivered',
      source: 'git',
      declared: { stage: 'online_waiting_validation', summary: 'deployed', nextOwner: 'plan' },
      receipt: { head: 'abc', diffstat: '44 files changed', changedFiles: { files: ['a'], total: 44, truncated: false }, tests: [] },
    }),
    result: fencedResult,
  };
  const fields = structuredReceiptFields(stageOnly);
  assert.equal(fields.diffstat, '44 files changed');
  assert.equal(fields.tests?.length, 2);
});

test('no declaration anywhere leaves tests null', () => {
  const job = { delivery_meta: JSON.stringify({ receipt: { head: 'abc', tests: [] } }), result: 'plain text only' };
  assert.equal(structuredReceiptFields(job).tests, null);
  assert.equal(structuredReceiptFields({ delivery_meta: null }).tests, null);
});
