/**
 * API 默认工具 schema 体积基线（可复现、无上游调用）。
 * CLI 实际 MCP schema 由客户端展开，网关侧另有 mcp config bytes 日志。
 */
import assert from 'node:assert/strict';
import { estimateToolSchemaTokens } from '../src/agents/conversationSummary.js';
import { estimateTokens } from '../src/agents/tokenEstimate.js';

const MEMORY_TOOLS = [
  {
    name: 'search_vault',
    description:
      '在当前用户的共享记忆库中按关键词搜索（多个词空格分隔，AND 逻辑），返回匹配的文件清单。',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description: '读取记忆库中某个文件的全文。path 是相对路径，例如 "memories/user-profile.md"。',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对于记忆库根目录的路径' } },
      required: ['path'],
    },
  },
];

const DELEGATE_SAMPLE = [
  {
    name: 'delegate_worker',
    description: '把长任务派给 PC Worker。'.repeat(8),
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        cwd: { type: 'string' },
        runner: { type: 'string' },
      },
      required: ['prompt'],
    },
  },
];

const memoryOnly = estimateToolSchemaTokens(MEMORY_TOOLS);
const withDelegate = estimateToolSchemaTokens([...MEMORY_TOOLS, ...DELEGATE_SAMPLE]);

assert.ok(memoryOnly > 20 && memoryOnly < 800, `默认记忆工具 schema 应精简，当前 ~${memoryOnly} tok`);
assert.ok(withDelegate > memoryOnly, '加入委派工具后 schema 应更大');
assert.ok(
  withDelegate - memoryOnly > 30,
  '委派工具应带来可观测的 schema 增量'
);

// 对照：整份 get_context 量级远大于工具 schema（说明裁 schema 的 ROI 低于裁历史/preamble）
const fakeFullCtx = '# FULL\n' + '记忆段落。'.repeat(400);
const fullCtxTok = estimateTokens(fakeFullCtx);
assert.ok(fullCtxTok > memoryOnly * 3, 'full 记忆前缀通常远重于默认工具 schema');

console.log(
  `tool schema smoke: memoryOnly~${memoryOnly} withDelegate~${withDelegate} fullCtxSample~${fullCtxTok}`
);
console.log('tool schema tokens smoke: ok');
