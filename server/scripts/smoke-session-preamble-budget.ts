import assert from 'node:assert/strict';
import { PromptComposer } from '../src/agents/promptComposer.js';
import { estimateTokens } from '../src/agents/tokenEstimate.js';
import { buildSessionPreamble, buildTurnBlock } from '../src/memory/inject.js';

const COMPACT_FACTS = [
  '# User compact fact context',
  '- **identity.name**: User',
  '- **preferences.communication.chat_style**: 自然、直接、短而完整',
].join('\n');
const NARRATIVE = `${COMPACT_FACTS}\n${'长期叙事'.repeat(900)}`;
const INDEX = `${NARRATIVE}\n${'记忆索引'.repeat(900)}`;

const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
const vault = {
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    calls.push({ name, args });
    if (name === 'get_core_context') return args.source === 'compact' ? COMPACT_FACTS : NARRATIVE;
    if (name === 'get_context') return INDEX;
    if (name === 'search_vault') {
      return '- **称呼方向细则** (`memories/address-terms.md`)\n  > User 对当前联系人说的伴侣称呼应自然接住。';
    }
    throw new Error(`unexpected ${name}`);
  },
} as any;

const contact = { id: 'codex', name: 'Codex', backend: 'codex' };
const compact = await buildSessionPreamble(vault, contact, 'compact');
assert.deepEqual(calls[0], { name: 'get_core_context', args: { source: 'compact' } });
assert.match(compact, /identity\.name/);
assert.match(compact, /preferences\.communication\.chat_style/);
assert.doesNotMatch(compact, /长期叙事|记忆索引/);
assert.doesNotMatch(compact, /注入时间：|\d{4}-\d{2}-\d{2} 周/);

// 动态细节仍通过每轮检索进入，避免用“瘦身”换回模型不知道该查什么的旧问题。
const turnBlock = await buildTurnBlock(vault, '老公这个称呼应该怎么接', new Set(), 1000);
assert.match(turnBlock ?? '', /address-terms\.md/);
assert.match(turnBlock ?? '', /自然接住/);

const row = (id: string, name: string, backend: string, config = '{}') => ({
  id, name, backend, config, avatar: '', color: '', kind: 'dm', sort_order: 0,
  enabled: 1, created_at: '',
}) as any;
const logs: string[] = [];
const composer = new PromptComposer(vault, null as any);
calls.length = 0;
await composer.composeStart({
  agent: row('codex', 'Codex', 'codex'),
  convo: row('codex', 'Codex', 'codex'),
  isRoom: false,
  memory: { injectOnSpawn: true } as any,
  userName: 'User',
  nameOf: (id: string) => id,
  log: (line: string) => logs.push(line),
}, 'resume');
assert.equal(calls[0]?.name, 'get_core_context', 'CLI 默认也应使用 compact facts');
assert.match(logs.join('\n'), /mode=compact .*tokens=\d+/);

calls.length = 0;
await composer.composeStart({
  agent: row('full-api', 'Full API', 'api', JSON.stringify({ memoryPreambleMode: 'full' })),
  convo: row('full-api', 'Full API', 'api'),
  isRoom: false,
  memory: { injectOnSpawn: true } as any,
  userName: 'User',
  nameOf: (id: string) => id,
  log: () => {},
}, 'resume');
assert.equal(calls[0]?.name, 'get_context', '显式 full 必须保留完整上下文入口');

const oldCompact = await buildSessionPreamble(
  { call: async () => NARRATIVE } as any,
  contact,
  'compact'
);
const full = await buildSessionPreamble(
  { call: async () => INDEX } as any,
  contact,
  'full'
);
const report = {
  compactTokens: estimateTokens(compact),
  oldCompactTokens: estimateTokens(oldCompact),
  fullTokens: estimateTokens(full),
};
assert(report.compactTokens < report.oldCompactTokens);
assert(report.compactTokens < report.fullTokens);
console.log(`session preamble budget smoke: ${JSON.stringify(report)}`);
