import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router } from 'express';
import { z } from 'zod';
import { buildDelegateTools, type DelegationCfg } from '../agents/gatewayTools.js';
import type { ContactRow, Db } from '../db.js';
import type { JobStore } from '../workers/jobStore.js';

/**
 * Per-contact MCP endpoint (`/api/hub-mcp/:contactId`) exposing the PC-worker
 * delegate tools to CLI backends. Claude CLI contacts get it merged into
 * their --mcp-config by the manager; Codex app-server gets per-process
 * mcp_servers.hub overrides, so no global config.toml edit is needed.
 * Stateless streamable-http: one server+transport per POST, identity comes
 * from the URL (gateway binds the tailnet, same trust level as the rest of
 * the HTTP API).
 */

const INPUT_SHAPES = {
  delegate_to_worker: {
    runner: z.enum(['claude', 'codex', 'grok']).describe('本机执行方'),
    workspace: z.string().describe('PC 上的项目路径，必须在白名单内'),
    prompt: z.string().describe('自包含的任务描述（目标/约束/验收标准）'),
    shell: z.boolean().optional().describe('是否允许执行 shell 命令（codex 必须 true）'),
    priority: z.number().optional().describe('-10~10，默认 0'),
    model: z.string().optional().describe(
      '覆盖 Worker 默认模型。Claude 固定版本写 Opus 4.6 或 claude-opus-4-6；指定版本时禁止用 opus/sonnet 泛化。Codex 如 gpt-5.6-sol'
    ),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('推理强度'),
  },
  worker_job_status: {
    job_id: z.string().describe('delegate_to_worker 返回的任务 id'),
  },
  worker_job_cancel: {
    job_id: z.string().describe('要取消的任务 id'),
  },
} as Record<string, z.ZodRawShape>;

export function hubMcpRouter(db: Db, jobs: JobStore): Router {
  const r = Router();

  r.post('/hub-mcp/:contactId', async (req, res) => {
    const contact = db
      .prepare("SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'")
      .get(req.params.contactId) as ContactRow | undefined;
    const delegation: DelegationCfg = contact
      ? JSON.parse(contact.config || '{}').delegation ?? {}
      : {};
    if (!contact || delegation.enabled !== true) {
      return res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: '这个联系人没有开启 Worker 委派' },
        id: null,
      });
    }

    const server = new McpServer({ name: 'ai-hub', version: '0.1.0' });
    for (const tool of buildDelegateTools(jobs, db, contact.id, delegation)) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: INPUT_SHAPES[tool.name] },
        async (input: Record<string, unknown>) => {
          const out = await tool.exec(input ?? {});
          return { content: [{ type: 'text' as const, text: out.text }], isError: !out.ok };
        }
      );
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // stateless：不支持 GET 流和 DELETE 会话
  r.get('/hub-mcp/:contactId', (_req, res) => res.status(405).end());
  r.delete('/hub-mcp/:contactId', (_req, res) => res.status(405).end());

  return r;
}
