import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeBacklogSweepConfig,
  parseVaultSearchHits,
  planBacklogSweep,
} from './triage-core.mjs';

const SEARCH_RESULT = [
  '找到 2 个匹配：',
  '',
  '- **[需求] 自主派单只进 inbox 不进 tasks** (`inbox/2026-07-30_req-autonomous-routing.md`)  [需求, ai-hub, 待拆分]',
  '  > 前端观察：新版自主派单只写 inbox',
  '- **[需求] 副窗验收按钮缺少「打回」** (`inbox/2026-08-01_req-side-channel-reject.md`)  [需求, ai-hub, 待拆分]',
].join('\n');

test('默认开启，不需要生产配置里显式打开', () => {
  const config = normalizeBacklogSweepConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.query, '待拆分需求');
  assert.equal(config.renagHours, 72);
});

test('显式关掉才关', () => {
  assert.equal(normalizeBacklogSweepConfig({ enabled: false }).enabled, false);
});

test('非法时刻直接拒绝，不静默取默认值', () => {
  assert.throws(() => normalizeBacklogSweepConfig({ atHour: 25 }), /backlogSweep\.atHour/);
});

test('只认 search_vault 的条目行，正文引用行不算', () => {
  const hits = parseVaultSearchHits(SEARCH_RESULT);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].path, 'inbox/2026-07-30_req-autonomous-routing.md');
  assert.match(hits[1].title, /副窗验收按钮/);
});

test('没有待拆分需求就闭嘴', () => {
  const plan = planBacklogSweep({ text: '没有找到包含 \'待拆分需求\' 的内容。', previous: null });
  assert.equal(plan.emit, false);
  assert.equal(plan.hits.length, 0);
});

test('第一次扫到就出声，并要求给拆分提案而不是自行建任务', () => {
  const plan = planBacklogSweep({ text: SEARCH_RESULT, previous: null, now: 1_000_000 });
  assert.equal(plan.emit, true);
  assert.equal(plan.reason, 'first sweep');
  assert.match(plan.summary, /2 条待拆分需求/);
  assert.match(plan.summary, /不要自行 add_task/);
  assert.match(plan.summary, /inbox\/2026-08-01_req-side-channel-reject\.md/);
  assert.equal(plan.state, `${plan.digest}:1000000`);
});

test('清单没变且还在冷却窗口内不重复打扰', () => {
  const first = planBacklogSweep({ text: SEARCH_RESULT, previous: null, now: 0 });
  const plan = planBacklogSweep({
    text: SEARCH_RESULT,
    previous: first.state,
    now: 71 * 3_600_000,
  });
  assert.equal(plan.emit, false);
  assert.match(plan.reason, /re-nag window/);
});

test('清单没变但攒过久要再提醒一次——攒着不拆不能永远安静', () => {
  const first = planBacklogSweep({ text: SEARCH_RESULT, previous: null, now: 0 });
  const plan = planBacklogSweep({
    text: SEARCH_RESULT,
    previous: first.state,
    now: 73 * 3_600_000,
  });
  assert.equal(plan.emit, true);
  assert.equal(plan.reason, 're-nag window elapsed');
});

test('新增一条需求立刻出声，不等冷却', () => {
  const first = planBacklogSweep({ text: SEARCH_RESULT, previous: null, now: 0 });
  const grown = `${SEARCH_RESULT}\n- **[需求] 第三条** (\`inbox/2026-08-01_req-third.md\`)  [需求]`;
  const plan = planBacklogSweep({ text: grown, previous: first.state, now: 60_000 });
  assert.equal(plan.emit, true);
  assert.equal(plan.reason, 'request list changed');
});

test('坏掉的历史状态当成没扫过，而不是崩掉', () => {
  const plan = planBacklogSweep({ text: SEARCH_RESULT, previous: 'garbage', now: 5 });
  assert.equal(plan.emit, true);
  assert.equal(plan.reason, 'first sweep');
});

test('条目数受 maxItems 限制，别把整个 inbox 灌进提示词', () => {
  const many = Array.from({ length: 30 }, (_, index) =>
    `- **[需求] 第 ${index} 条** (\`inbox/req-${index}.md\`)`).join('\n');
  const plan = planBacklogSweep({
    text: many,
    previous: null,
    config: normalizeBacklogSweepConfig({ maxItems: 5 }),
  });
  assert.equal(plan.hits.length, 5);
  assert.match(plan.summary, /5 条待拆分需求/);
});
