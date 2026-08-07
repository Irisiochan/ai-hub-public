import assert from 'node:assert/strict';
import {
  clipCaptureText,
  detectTrigger,
  maybeCapture,
  reviewCaptureWithDeepSeek,
  type CaptureReviewer,
} from '../src/memory/capture.js';
import { captureEvalCases, dirtyHubAutoCases, trueTaskCases } from './capture-eval-cases.js';

assert.equal(dirtyHubAutoCases.length, 5, 'eval corpus has 5 dirty hub-auto samples (false positives)');
assert.equal(trueTaskCases.length, 2, 'eval corpus has 2 true task samples (codex-0734, codex-1403)');
assert.equal(captureEvalCases.length, 7);

assert.equal(detectTrigger('明天下午三点见'), '时间与计划');
assert.equal(detectTrigger('答应我别忘了这件事'), '承诺与待办');
assert.equal(detectTrigger('说好了明天去'), '时间与计划');
assert.equal(detectTrigger('还说好舒服'), null);
assert.equal(detectTrigger('说好了吗'), null);
assert.equal(
  detectTrigger('⚙ Worker 任务回执（网关自动通知，User 也看得到这条） 任务 abc → done 交付状态：delivered'),
  null
);

for (const text of [
  '翻下我的档案，说说你对我的了解',
  'review我们的项目，有什么能优化的？',
  '怎么还不休息？',
  '好吧好吧，该睡觉了',
  '检查记忆库近期运行是否产生了脏数据',
  '细说！',
]) {
  assert.equal(detectTrigger(text), null, `low-value chat should not trigger: ${text}`);
}

const clipped = clipCaptureText('x'.repeat(6100));
assert.match(clipped, /已保留前 6000 字/);
assert.ok(clipped.length > 6000);

type Write = { tool: string; args: Record<string, unknown> };
function makeVault() {
  const writes: Write[] = [];
  return {
    writes,
    vault: {
      write: async (tool: string, args: Record<string, unknown>) => {
        writes.push({ tool, args });
        return 'ok' as const;
      },
    },
  };
}

const acceptReviewer: CaptureReviewer = async () => ({
  decision: 'capture',
  confidence: 0.95,
  category: 'commitment',
  subject: '测试',
  due: null,
  isCommitment: true,
});

for (const item of dirtyHubAutoCases) {
  const { writes, vault } = makeVault();
  let reviewed = false;
  await maybeCapture(
    vault as never,
    { id: `dirty-${item.id}`, name: item.contactName },
    item.text,
    '',
    () => {},
    async () => {
      reviewed = true;
      return {
        decision: 'reject',
        confidence: 0.02,
        category: 'other',
        subject: null,
        due: null,
        isCommitment: false,
      };
    }
  );
  assert.equal(writes.length, 0, `${item.id} must not enter inbox`);
  if (item.id === 'aye-1427') {
    assert.equal(reviewed, false, 'worker receipt must be stopped before LLM review');
  }
}

for (const item of trueTaskCases) {
  const { writes, vault } = makeVault();
  await maybeCapture(
    vault as never,
    { id: `eval-${item.id}`, name: item.contactName },
    item.text,
    '',
    () => {},
    acceptReviewer
  );
  assert.equal(writes.length, 1, `${item.id} should enter inbox`);
  assert.equal(writes[0].tool, 'write_inbox');
  assert.ok((writes[0].args.tags as string[]).includes('llm-reviewed'));
}

// Reply-only trigger words must never create a self-echo inbox item.
{
  const { writes, vault } = makeVault();
  await maybeCapture(
    vault as never,
    { id: 'reply-echo-test', name: '示例助手' },
    '翻下我的档案',
    '你明天有个待办，长期偏好也在这里',
    () => {},
    acceptReviewer
  );
  assert.equal(writes.length, 0);
}

// API outages and low-confidence decisions degrade to a review-pending inbox item.
{
  const { writes, vault } = makeVault();
  await maybeCapture(
    vault as never,
    { id: 'llm-pending-test', name: '示例助手' },
    '提醒我有空处理一下',
    '',
    () => {},
    async () => ({
      decision: 'pending',
      confidence: null,
      category: null,
      subject: null,
      due: null,
      isCommitment: null,
      detail: 'test outage',
    })
  );
  assert.equal(writes.length, 1);
  assert.ok((writes[0].args.tags as string[]).includes('llm-review-pending'));
}

for (const review of [
  { json: { should_capture: true, confidence: 0.79, category: 'commitment', subject: 'x', due: null, is_commitment: true }, expected: 'pending' },
  { json: { should_capture: false, confidence: 0.21, category: 'other', subject: 'x', due: null, is_commitment: false }, expected: 'pending' },
  { json: { should_capture: false, confidence: 0.2, category: 'other', subject: 'x', due: null, is_commitment: false }, expected: 'reject' },
  { json: { should_capture: true, confidence: 0.8, category: 'commitment', subject: 'x', due: null, is_commitment: true }, expected: 'capture' },
] as const) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(review.json) } }],
  }), { status: 200 })) as typeof fetch;
  process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
  try {
    const result = await reviewCaptureWithDeepSeek('提醒我明天处理', '承诺与待办');
    assert.equal(result.decision, review.expected, `confidence threshold failed for ${review.expected}`);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.DEEPSEEK_API_KEY;
  }
}

// Room capture is attributed to the room, stores User's raw text once, and
// omits an empty pseudo-reply section.
{
  const { writes, vault } = makeVault();
  await maybeCapture(
    vault as never,
    { id: 'room-capture-test', name: '重大会议' },
    '明天下午三点开会',
    '',
    () => {},
    acceptReviewer
  );
  await maybeCapture(
    vault as never,
    { id: 'room-capture-test', name: '重大会议' },
    '明天下午三点开会',
    '',
    () => {},
    acceptReviewer
  );
  assert.equal(writes.length, 1, 'same room should be rate-limited to one capture');
  assert.deepEqual((writes[0].args.tags as string[]).slice(0, 2), ['hub-auto', 'room-capture-test']);
  assert.match(String(writes[0].args.content), /\*\*User\*\*：明天下午三点开会/);
  assert.doesNotMatch(String(writes[0].args.content), /\*\*重大会议\*\*：/);
}

console.log('capture smoke: ok');
