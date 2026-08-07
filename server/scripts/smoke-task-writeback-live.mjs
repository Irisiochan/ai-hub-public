import assert from 'node:assert/strict';
import {
  ownTaskUpdateText,
  reviewTaskWritebackWithDeepSeek,
} from '../dist/memory/taskWriteback.js';

if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  throw new Error('DEEPSEEK_API_KEY is required for the live shadow smoke');
}

async function reviewWithOnePendingRetry(text) {
  const first = await reviewTaskWritebackWithDeepSeek(text);
  return first.decision === 'pending'
    ? reviewTaskWritebackWithDeepSeek(text)
    : first;
}

const positiveText = '项目 Alpha 的验收要过几天再做，改到 8 月 10 日。';
const positiveOwnText = ownTaskUpdateText(positiveText);
assert.equal(positiveOwnText, positiveText);
const positive = await reviewWithOnePendingRetry(positiveOwnText);
assert.equal(positive.decision, 'candidate');
assert.equal(positive.action, 'reschedule');
assert.ok((positive.confidence ?? 0) >= 0.9);
assert.ok(positive.taskQuery);

const deterministicRejects = [
  '> 同事说项目 Alpha 已经完成了',
  '同事说他计划把项目 Alpha 改到下周。',
  '我没说要把项目 Alpha 改期。',
];
for (const text of deterministicRejects) {
  assert.equal(ownTaskUpdateText(text), null, `must stop before LLM review: ${text}`);
}

const reviewedRejects = [
  '我还没完成项目 Alpha。',
  '这破事什么时候能搞定啊，哈哈。',
];
const rejects = [];
for (const text of reviewedRejects) {
  const ownText = ownTaskUpdateText(text);
  assert.ok(ownText);
  const review = await reviewWithOnePendingRetry(ownText);
  assert.notEqual(review.decision, 'candidate', `must not become a write candidate: ${text}`);
  rejects.push({ text, decision: review.decision, confidence: review.confidence });
}

console.log(JSON.stringify({
  ok: true,
  mode: 'shadow-no-vault-write',
  positive: {
    decision: positive.decision,
    action: positive.action,
    confidence: positive.confidence,
    taskQuery: positive.taskQuery,
    due: positive.due,
  },
  deterministicRejects: deterministicRejects.length,
  reviewedRejects: rejects,
}));
