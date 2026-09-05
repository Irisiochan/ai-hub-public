import assert from 'node:assert/strict';
import { buildTurnBlock, wrapTurnText, type VaultSearchHit } from '../src/memory/inject.js';

const TURN_DAY = '2026-08-18';

function searchResult(hit: VaultSearchHit): string {
  return [
    '找到 1 个匹配：',
    '',
    `- **${hit.title}** (\`${hit.path}\`)`,
    ...(hit.snippet ? [`  > ${hit.snippet}`] : []),
  ].join('\n');
}

async function render(hit: VaultSearchHit, maxChars = 1_200): Promise<string> {
  const vault = {
    async call(): Promise<string> {
      return searchResult(hit);
    },
  };
  return await buildTurnBlock(vault as never, 'fixture keyword', new Set(), maxChars, TURN_DAY) ?? '';
}

async function expectLabel(
  name: string,
  hit: VaultSearchHit,
  expected: string | RegExp,
): Promise<void> {
  const block = await render(hit);
  if (typeof expected === 'string') assert.ok(block.includes(expected), `${name}: ${block}`);
  else assert.match(block, expected, name);
}

const futureWording = await render({
  title: '示例活动演唱会 VIP 合影',
  path: 'diary/2026-08-08.md',
  snippet: '8/15 准备买 399 VIP 票（含 1v1 合影）',
});
assert.match(futureWording, /（记于 2026-08-08）/);
assert.match(futureWording, /【已发生 · 2026-08-15】/);

const completed = await render({
  title: '示例活动演唱会完成记录',
  path: 'diary/2026-08-15.md',
  snippet: '8/15 已看完演唱会，1v1 合影已拍完',
});
assert.match(completed, /已看完演唱会，1v1 合影已拍完.*【已发生 · 2026-08-15】/);
assert.doesNotMatch(completed, /准备去|待办/);

for (const [name, hit, expected] of [
  ['ISO date', { title: '活动', path: 'memories/a.md', snippet: '2026-08-17 已结束' }, '【已发生 · 2026-08-17】'],
  ['slash date', { title: '活动', path: 'memories/a.md', snippet: '2026/8/18 当天见' }, '【当天】'],
  ['path year for yearless slash', { title: '活动', path: 'diary/2025-08-01.md', snippet: '8/15 见面' }, '【已发生 · 2025-08-15】'],
  ['turn year for Chinese date', { title: '活动', path: 'memories/a.md', snippet: '8月20日见面' }, '【即将到来 · 2天后】'],
  ['past interval', { title: '假期', path: 'diary/2026-08-01.md', snippet: '8/10–8/15 在旅行' }, '【已发生 · 2026-08-15】'],
  ['near future interval', { title: '假期', path: 'memories/a.md', snippet: '8/20–8/25 去旅行' }, '【即将到来 · 2天后】'],
  ['far future interval', { title: '假期', path: 'memories/a.md', snippet: '9/10–9/20 去旅行' }, '【未来 · 2026-09-10】'],
  ['ongoing interval', { title: '假期', path: 'memories/a.md', snippet: '8/10–8/20 在旅行' }, '【进行中】'],
  ['anchored 今天', { title: '流水', path: 'diary/2026-08-15.md', snippet: '今天完成' }, '【已发生 · 2026-08-15】'],
  ['anchored 明天', { title: '流水', path: 'diary/2026-08-17.md', snippet: '明天完成' }, '【当天】'],
  ['anchored 昨天', { title: '流水', path: 'diary/2026-08-18.md', snippet: '昨天完成' }, '【已发生 · 2026-08-17】'],
  ['anchored 今晚', { title: '流水', path: 'diary/2026-08-20.md', snippet: '今晚见面' }, '【即将到来 · 2天后】'],
  ['unanchored relative time', { title: '流水', path: 'memories/a.md', snippet: '明天见面' }, '【相对时间，勿当成本轮】'],
  ['birthday recurrence', { title: 'User 生日 2001-08-04', path: 'memories/profile.md', snippet: '生日每年庆祝' }, '【每年重复，勿当一次性已过期】'],
  ['anniversary recurrence', { title: '周年', path: 'memories/a.md', snippet: '2026-05-20 是纪念日' }, '【每年重复，勿当一次性已过期】'],
  ['yearly date recurrence', { title: '固定日', path: 'memories/a.md', snippet: '每年 8月4日' }, '【每年重复，勿当一次性已过期】'],
  ['fact recurrence', { title: '生日 fact', path: 'memories/facts/identity.birthday.md', snippet: 'recurring: yearly' }, '【每年重复，勿当一次性已过期】'],
  ['latest snippet date', { title: '行程', path: 'memories/a.md', snippet: '8/10 出发，8/25 回来' }, '【即将到来 · 7天后】'],
] satisfies Array<[string, VaultSearchHit, string]>) {
  await expectLabel(name, hit, expected);
}

const factMetadata = await render({
  title: '工作事实', path: 'memories/facts/work.job.md', snippet: 'valid_from: 2020-01-01',
});
assert.doesNotMatch(factMetadata, /【已发生|【当天|【即将到来|【未来/);

const invalidDate = await render({
  title: '非法日期', path: 'memories/a.md', snippet: '02-31 不存在',
});
assert.doesNotMatch(invalidDate, /【已发生|【当天|【即将到来|【未来/);

const pathOnly = await render({
  title: '只有路径日期', path: 'diary/2026-08-15.md', snippet: '没有正文日期',
});
assert.match(pathOnly, /（记于 2026-08-15）/);
assert.doesNotMatch(pathOnly, /【已发生|【当天|【即将到来|【未来/);

const budget = await render({
  title: '预算内日期条目', path: 'diary/2026-08-08.md', snippet: `8/15 ${'很长'.repeat(40)}`,
}, 72);
assert.ok(budget.length <= 72, `budget exceeded: ${budget.length}/72`);

const wrapped = wrapTurnText('本轮正文', futureWording);
assert.match(wrapped, /带【已发生】标记的内容不要当作待办；引用记忆中的日期事件前先对 TURN_TIME 核对时态。/);
assert.ok(wrapped.indexOf('本轮正文') < wrapped.indexOf('带【已发生】'));

process.stdout.write(`${JSON.stringify({
  ok: true,
  turnDay: TURN_DAY,
  assertions: 27,
  fixtureLabel: '【已发生 · 2026-08-15】',
  budget: `${budget.length}/72`,
}, null, 2)}\n`);
