import assert from 'node:assert/strict';
import {
  appendQuoteToDraft,
  buildSideQuote,
  DIGEST_CHARS,
  FULL_CHARS,
  sideSourceLabel,
} from '../src/sideQuote.ts';
import { effectiveMessageOrigin } from '../src/messageSource.ts';

const base = {
  id: 10,
  contact_id: 'claude',
  sender: 'system',
  role: 'assistant',
  kind: 'text',
  content: 'ok',
  status: 'done',
  turn_id: null,
  meta: '{}',
  origin: 'side',
  created_at: '2026-07-29 11:30:00',
};

const receipt = {
  ...base,
  meta: JSON.stringify({ event: 'worker-receipt' }),
  content: '⚙ Worker 任务回执（网关自动通知，User 也看得到这条）\n任务 tasks/demo.md → done\n交付状态：全绿',
};
const dispatch = {
  ...base,
  meta: '{}',
  content: '⚡ AI Hub 自主事件分派\n来源：quarter-hour-check\n分类：backlog｜优先级：P2',
};

// —— 来源标签 ——
assert.equal(sideSourceLabel(receipt), '网关 · Worker 回执');
assert.equal(sideSourceLabel(dispatch), '网关 · quarter-hour-check · backlog · P2');
assert.equal(sideSourceLabel({ ...base, content: '随便一条' }), '网关事件');

// —— 引原文：逐行加前缀，正文一字不改 ——
const full = buildSideQuote(receipt, 'full');
assert.ok(
  full.split('\n').every((line) => line.startsWith('>')),
  'every quoted line must carry the blockquote prefix'
);
assert.ok(full.startsWith('> [副窗 · 网关 · Worker 回执 · '), 'header names the source');
assert.ok(full.includes('> 任务 tasks/demo.md → done'), 'full mode keeps the body verbatim');
assert.ok(full.includes('> 交付状态：全绿'), 'full mode keeps every line, not just the first');
// created_at 是 SQLite 的 UTC 裸时间戳；formatLocalTime 钉死 Asia/Shanghai，
// 所以 11:30Z 必须显示成 19:30，且不随跑测试这台机器的本地时区漂移。
assert.ok(full.includes('19:30'), 'header carries the Shanghai wall clock, not the raw UTC row');

// —— 引摘要：对齐 server sideChannel.ts 的 compact(text, 200) ——
const digest = buildSideQuote(receipt, 'digest');
assert.equal(digest.split('\n').length, 2, 'digest collapses the body onto one line');
assert.ok(digest.includes('⚙ Worker 任务回执'), 'digest still shows what it came from');
const longRow = { ...base, content: '甲'.repeat(DIGEST_CHARS + 80) };
const longDigest = buildSideQuote(longRow, 'digest').split('\n')[1];
assert.equal(longDigest, `> ${'甲'.repeat(DIGEST_CHARS)}…`, 'digest cuts at DIGEST_CHARS');

// —— 超长原文：截断且写明总量，不静默丢 ——
const huge = { ...base, content: '乙'.repeat(FULL_CHARS + 500) };
const hugeQuote = buildSideQuote(huge, 'full');
assert.ok(
  hugeQuote.includes(`（原文共 ${FULL_CHARS + 500} 字，此处只引前 ${FULL_CHARS} 字，完整内容在副窗）`),
  'truncation must state the real total instead of dropping silently'
);
assert.ok(
  hugeQuote.length < (FULL_CHARS + 500) * 2,
  'truncated quote must not carry the whole original anyway'
);

// —— 关键回归：引用块不能被重新判成副窗消息 ——
// 前缀让 automationDescriptor 的 ^⚡ / ^[后台事件] 判断落空，否则这条会从主窗消失。
for (const source of [dispatch, receipt]) {
  const quoted = {
    ...base,
    sender: 'user',
    role: 'user',
    origin: 'main',
    meta: '{}',
    content: `${buildSideQuote(source, 'full')}\n\n按这个派单给阿野`,
  };
  assert.equal(
    effectiveMessageOrigin(quoted),
    'main',
    'a quoted machine payload must stay in the main window'
  );
}

const foldedQuote = {
  ...base,
  sender: 'user',
  role: 'user',
  origin: 'main',
  meta: '{}',
  content: buildSideQuote(
    { ...base, content: '[后台事件] 自主事件分派 · 来源 timer · system' },
    'full'
  ),
};
assert.equal(
  effectiveMessageOrigin(foldedQuote),
  'main',
  'quoting an already-folded row must not bounce it back to the side window'
);

// —— 草稿追加而不是覆盖 ——
assert.equal(appendQuoteToDraft('', '> a'), '> a\n\n');
assert.equal(appendQuoteToDraft('写了一半', '> a'), '写了一半\n\n> a\n\n');
assert.equal(
  appendQuoteToDraft('写了一半\n\n\n', '> a'),
  '写了一半\n\n> a\n\n',
  'trailing whitespace in the draft is normalised, not doubled'
);
assert.ok(
  appendQuoteToDraft('已有引用\n\n> 旧', '> 新').endsWith('> 旧\n\n> 新\n\n'),
  'a second quote appends below the first'
);

console.log('side quote tests passed');
