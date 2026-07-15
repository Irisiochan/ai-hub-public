import assert from 'node:assert/strict';
import { clipCaptureText, detectTrigger, maybeCapture } from '../src/memory/capture.js';

assert.equal(detectTrigger('明天下午三点见'), '时间与计划');
assert.equal(detectTrigger('答应我别忘了这件事'), '承诺与待办');

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
const writes: Write[] = [];
const fakeVault = {
  write: async (tool: string, args: Record<string, unknown>) => {
    writes.push({ tool, args });
    return 'ok';
  },
};

// Reply-only trigger words must never create a self-echo inbox item.
await maybeCapture(
  fakeVault as never,
  { id: 'reply-echo-test', name: '示例助手' },
  '翻下我的档案',
  '你明天有个待办，长期偏好也在这里',
  () => {}
);
assert.equal(writes.length, 0);

// Room capture is attributed to the room, stores User's raw text once, and
// omits an empty pseudo-reply section.
await maybeCapture(
  fakeVault as never,
  { id: 'room-capture-test', name: '重大会议' },
  '明天下午三点开会',
  '',
  () => {}
);
await maybeCapture(
  fakeVault as never,
  { id: 'room-capture-test', name: '重大会议' },
  '明天下午三点开会',
  '',
  () => {}
);
assert.equal(writes.length, 1, 'same room should be rate-limited to one capture');
assert.deepEqual((writes[0].args.tags as string[]).slice(0, 2), ['hub-auto', 'room-capture-test']);
assert.match(String(writes[0].args.content), /\*\*User\*\*：明天下午三点开会/);
assert.doesNotMatch(String(writes[0].args.content), /\*\*重大会议\*\*：/);

console.log('capture smoke: ok');
