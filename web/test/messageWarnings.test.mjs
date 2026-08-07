import assert from 'node:assert/strict';
import { isOutputLengthLimit, outputLimitWarning } from '../src/messageWarnings.ts';

assert.equal(
  outputLimitWarning(JSON.stringify({ usage: { output: 8192, finishReason: 'length' } })),
  '达到输出上限，正文可能未写完'
);
assert.equal(
  outputLimitWarning(JSON.stringify({ usage: { finishReason: 'MAX_TOKENS' } })),
  '达到输出上限，正文可能未写完',
  'raw Gemini MAX_TOKENS should still warn if it ever leaks unnormalized'
);
assert.equal(outputLimitWarning(JSON.stringify({ usage: { finishReason: 'stop' } })), null);
assert.equal(outputLimitWarning('not-json'), null);
assert.equal(isOutputLengthLimit('length'), true);
assert.equal(isOutputLengthLimit('max_tokens'), true);
assert.equal(isOutputLengthLimit('stop'), false);
console.log('message warning checks passed');
