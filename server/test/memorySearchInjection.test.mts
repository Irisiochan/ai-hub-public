import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTurnBlock,
  extractKeywordPlan,
  parseVaultSearchResults,
} from '../src/memory/inject.js';

function result(...hits: Array<[string, string, string?]>): string {
  return [
    `找到 ${hits.length} 个匹配：`,
    '',
    ...hits.flatMap(([title, path, snippet]) => [
      `- **${title}** (\`${path}\`)`,
      ...(snippet ? [`  > ${snippet}`] : []),
    ]),
  ].join('\n');
}

class FakeVault {
  calls: string[] = [];
  constructor(private responses: Record<string, string>) {}
  async call(_name: string, args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '');
    this.calls.push(query);
    return this.responses[query] ?? `没有找到包含 '${query}' 的内容。`;
  }
}

test('full terms always precede three-character fallback fragments', () => {
  const plan = extractKeywordPlan('还有 vault 检索命中质量🫡');
  assert.deepEqual(plan.primary, ['检索命中质量', 'vault']);
  assert.deepEqual(plan.fragments, ['检索命', '中质量']);
  assert.deepEqual(plan.all, ['检索命中质量', 'vault', '检索命', '中质量']);
});

test('search parser keeps one bounded snippet per result', () => {
  const parsed = parseVaultSearchResults(result(
    ['相关任务', 'tasks/search.md', '第一条相关说明'],
    ['另一条', 'memories/other.md'],
  ));
  assert.deepEqual(parsed, [
    { title: '相关任务', path: 'tasks/search.md', snippet: '第一条相关说明' },
    { title: '另一条', path: 'memories/other.md', snippet: '' },
  ]);
});

test('multi-term AND runs first and snippets stay inside the unchanged budget', async () => {
  const vault = new FakeVault({
    '检索命中质量 vault': result(
      ['修 vault 检索命中质量', 'tasks/search.md', '真实机制与验收标准'],
    ),
    '检索命中质量': result(['修 vault 检索命中质量', 'tasks/search.md']),
    vault: result(
      ['修 vault 检索命中质量', 'tasks/search.md'],
      ['Vault 命中质量复盘', 'memories/relevance.md', '排序不能再依赖路径字典序'],
    ),
    检索命: result(['检索测试', 'projects/search-test.md', '对照记录']),
  });
  const block = await buildTurnBlock(vault as never, '还有 vault 检索命中质量🫡', new Set(), 240);

  assert.equal(vault.calls[0], '检索命中质量 vault');
  assert.match(block ?? '', /真实机制与验收标准/);
  assert.match(block ?? '', /memories\/relevance\.md/);
  assert.ok((block?.length ?? 0) <= 240);
});

test('fallback results rotate across keywords instead of one keyword taking all slots', async () => {
  const vault = new FakeVault({
    alpha: result(
      ['A1', 'memories/a1.md'],
      ['A2', 'memories/a2.md'],
      ['A3', 'memories/a3.md'],
    ),
    bravo: result(['B1', 'tasks/b1.md']),
    charlie: result(['C1', 'projects/c1.md']),
  });
  const block = await buildTurnBlock(vault as never, 'alpha bravo charlie', new Set(), 500);

  assert.deepEqual(vault.calls, ['charlie alpha bravo', 'charlie', 'alpha', 'bravo']);
  assert.match(block ?? '', /memories\/a1\.md/);
  assert.match(block ?? '', /tasks\/b1\.md/);
  assert.match(block ?? '', /projects\/c1\.md/);
  assert.doesNotMatch(block ?? '', /memories\/a2\.md/);
});

test('title-only fallback never exceeds maxChars', async () => {
  const vault = new FakeVault({
    keyword: result(['A very long but valid title', 'memories/path.md', 'x'.repeat(80)]),
  });
  const block = await buildTurnBlock(vault as never, 'keyword', new Set(), 70);
  assert.ok((block?.length ?? 0) <= 70);
  assert.doesNotMatch(block ?? '', /> x/);
});
