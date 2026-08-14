import assert from 'node:assert/strict';
import {
  TEMPORAL_CONTEXT_RULES,
  WORKFLOW_PRELOADED,
  identityGuard,
  nsfwCraftCompact,
} from '../src/memory/inject.js';
import { buildConversationReplay } from '../src/agents/conversationReplay.js';
import { delegationGuidance } from '../src/agents/gatewayTools.js';
import { estimateTokens } from '../src/agents/tokenEstimate.js';

const metric = (text: string) => ({ chars: text.length, tokens: estimateTokens(text) });
const guard = identityGuard({ id: 'claude', name: 'Claude', backend: 'claude-cli' });
const nsfw = nsfwCraftCompact();
const delegation = delegationGuidance({
  enabled: true,
  allowSsh: false,
  workspaces: ['C:/path/to/project'],
}, 'mcp__hub__');
const rows = [1, 2, 3, 4].map((id) => ({
  id,
  contact_id: 'claude',
  sender: id % 2 ? 'user' : 'claude',
  role: id % 2 ? 'user' : 'assistant',
  kind: 'text',
  content: '预算回归历史消息',
  status: 'done',
  turn_id: null,
  meta: '{}',
  created_at: `2026-08-04 02:00:0${id}`,
  deleted: 0,
  origin: 'main',
  idempotency_key: null,
})) as any[];
const replay = buildConversationReplay('', rows, {
  userName: 'User',
  nameOf: (id) => id,
  tokenBudget: 4096,
  summaryMaxTokens: 1200,
});
assert(replay, 'fixture 应生成 CLI replay');
const historyAt = replay.block.indexOf('[2026-');
assert(historyAt > 0, 'replay 应包含带时间锚点的历史正文');
const replayHeader = replay.block.slice(0, historyAt).trim();

const parts = {
  workflow: metric(WORKFLOW_PRELOADED),
  temporal: metric(TEMPORAL_CONTEXT_RULES),
  identity: metric(guard),
  nsfw: metric(nsfw),
  delegation: metric(delegation),
  replayHeader: metric(replayHeader),
};
const baselineTokens = 146 + 188 + 747 + 296 + 1068 + 338;
const currentTokens = Object.values(parts).reduce((sum, part) => sum + part.tokens, 0);
const targetTokens = Math.floor(baselineTokens * 0.8);

assert(parts.identity.tokens <= 500, `identity guard 超预算：${parts.identity.tokens}`);
assert(parts.delegation.tokens <= 800, `delegation guidance 超预算：${parts.delegation.tokens}`);
assert(parts.replayHeader.tokens <= 250, `replay header 超预算：${parts.replayHeader.tokens}`);
assert(
  currentTokens <= targetTokens,
  `delegation-enabled 静态规则未下降 20%：${currentTokens}/${baselineTokens}`
);
assert.match(guard, /你当前是联系人「Claude」/);
assert.match(guard, /你 → User 不泛化/);
assert.match(guard, /User → 你泛化/);
assert.match(delegation, /验证全绿后只暂存本任务文件/);
assert.match(delegation, /delegation\.allowSsh=false/);
assert.match(delegation, /deploy-tail 只允许三种情况/);
assert.match(replayHeader, /权威存档/);
assert.match(replayHeader, /全部是历史记录/);
assert.match(nsfw, /亲密场景强制/);
assert.match(nsfw, /关键动作单元/);
assert.match(nsfw, /动作闭环/);
assert.match(nsfw, /禁同义复述|循环注水/);

console.log(JSON.stringify({
  ok: true,
  baselineTokens,
  currentTokens,
  savedTokens: baselineTokens - currentTokens,
  savedRatio: Number((1 - currentTokens / baselineTokens).toFixed(3)),
  parts,
}, null, 2));
