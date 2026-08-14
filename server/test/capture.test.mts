import assert from 'node:assert/strict';
import { detectTrigger, isSystemReceipt, stripQuotedLines } from '../src/memory/capture.js';

/**
 * 副窗「引到主窗」会把机器原文以 `> ` 引用块塞进 User 的消息。引用的不是她说的话，
 * 不能进记忆捕捉——否则就是 pitfalls-triage-worker 里「元数据认不全机器消息」那一发
 * 在写入侧的翻版：摘要档引用凑不齐 isSystemReceipt 需要的三个子串，光靠那道闸拦不住。
 */

const receipt = [
  '⚙ Worker 任务回执',
  '任务 tasks/demo.md → done',
  '提醒我明天复查',
  '交付状态：全绿',
].join('\n');

const legacyReceipt = receipt.replace(
  '⚙ Worker 任务回执',
  '⚙ Worker 任务回执（网关自动通知，User 也看得到这条）',
);

const quotedDigest = [
  '> [副窗 · 网关 · Worker 回执 · 2026-07-29 19:30]',
  '> ⚙ Worker 任务回执 任务 tasks/demo.md → done 提醒我明天复查…',
].join('\n');

assert.equal(isSystemReceipt(receipt), true, 'a full receipt is still caught by the metadata-free gate');
assert.equal(isSystemReceipt(legacyReceipt), true, 'historical receipt headers remain classified');
assert.equal(
  isSystemReceipt('Worker 任务回执 · 网关自动通知 · 交付状态：全绿'),
  false,
  'the obsolete three-substring fallback must not classify arbitrary prose as a receipt'
);
assert.equal(
  isSystemReceipt(quotedDigest),
  false,
  'the digest quote drops the substrings isSystemReceipt needs — this is why stripping matters'
);

assert.equal(detectTrigger(quotedDigest), null, 'quoted machine text must never trigger capture');
assert.equal(
  detectTrigger(`${quotedDigest}\n\n按这个派单给阿野`),
  null,
  'quote plus a neutral instruction stays silent'
);
assert.equal(
  detectTrigger(`${quotedDigest}\n\n记一下这个验收结论`),
  '承诺与待办',
  'her own words next to a quote still trigger normally'
);
assert.equal(detectTrigger('记一下这个验收结论'), '承诺与待办', 'plain messages are unaffected');
assert.equal(detectTrigger(receipt), null, 'an unquoted receipt is still filtered');

assert.equal(stripQuotedLines('> a\n  > b\nc'), 'c', 'indented quote lines are stripped too');
assert.equal(stripQuotedLines('> only quoted'), '', 'a quote-only message leaves nothing of her own');
assert.equal(stripQuotedLines('没有引用'), '没有引用', 'ordinary text passes through untouched');

console.log('capture tests passed');
