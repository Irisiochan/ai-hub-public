import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router } from 'express';
import { z } from 'zod';
import { buildDelegateTools, type DelegationCfg } from '../agents/gatewayTools.js';
import { contactConfig } from '../agents/configSchemas.js';
import type { ContactRow, Db } from '../db.js';
import type { HubLogger } from '../logger.js';
import { hubMcpAuthMode, hubMcpBearerMatches } from '../middleware/hubMcpAuth.js';
import type { JobStore } from '../workers/jobStore.js';

/**
 * Per-contact MCP endpoint (`/api/hub-mcp/:contactId`) exposing the PC-worker
 * delegate tools to CLI backends. Claude CLI contacts get it merged into
 * their --mcp-config by the manager; Codex app-server gets per-process
 * mcp_servers.hub overrides, so no global config.toml edit is needed.
 * Stateless streamable-http: one server+transport per POST.
 * Identity = URL contactId + per-contact HMAC bearer（见 middleware/hubMcpAuth.ts；
 * session auth 对本前缀的豁免仅指 hub session cookie 不适用，不再等于无认证）。
 */

const INPUT_SHAPES = {
  delegate_to_worker: {
    route_class: z.enum(['implement', 'fix', 'review', 'recon', 'mechanical']).describe(
      '默认 runner/model/effort 由当前 Workflow Profile 决定；偏离必须显式传非空 runner_override_reason。'
    ),
    runner: z.enum(['claude', 'codex', 'grok']).optional().describe('可选；不填时按 route_class 默认路由表推出'),
    runner_override_reason: z.string().optional().describe('偏离默认 runner 时必填的非空理由；会写入 job 元数据'),
    workspace: z.string().describe('PC 上的项目路径，必须在白名单内'),
    prompt: z.string().describe('自包含的任务描述（目标/约束/验收标准）'),
    write: z.boolean().optional().describe('是否允许修改文件；默认 true，只读任务必须显式 false'),
    shell: z.boolean().optional().describe(
      '是否允许执行 shell 命令。codex 自动为 true；claude 不填就完全拿不到 Bash，只要 prompt 里含构建、测试、git 或部署任何一项就必须显式传 true'
    ),
    ssh: z.boolean().optional().describe('是否允许 SSH/VPS 操作；联系人 delegation.allowSsh 也必须开启'),
    priority: z.number().optional().describe('-10~10，默认 0'),
    model: z.string().optional().describe(
      '覆盖当前 Workflow Profile 的模型。Claude 固定版本写 Opus 4.7 或 claude-opus-4-7；指定版本时禁止用 opus/sonnet 泛化。Codex 如 gpt-5.6-sol'
    ),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional().describe('推理强度；不填时按当前 Workflow Profile'),
    problem_fingerprint: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe('同一问题稳定 sha256；用于三轮质量熔断'),
  },
  worker_job_status: {
    job_id: z.string().describe('delegate_to_worker 返回的任务 id'),
    result_offset: z.number().int().min(0).optional().describe('完整回执起始字符 offset；默认 0'),
    result_limit: z.number().int().min(1).max(12000).optional().describe('本页字符数；默认 4000，最大 12000'),
  },
  worker_job_cancel: {
    job_id: z.string().describe('要取消的任务 id'),
  },
  worker_job_update_delivery: {
    job_id: z.string().describe('delegate_to_worker 返回的任务 id'),
    stage: z.enum([
      'delivered_waiting_deploy',
      'online_waiting_validation',
      'closed_loop',
      'user_decision',
      'rework_required',
    ]).describe('新的交付结论'),
    summary: z.string().optional().describe('给人看的交付结论'),
    next_owner: z.string().optional().describe('下一步唯一负责人'),
    blocker: z.string().optional().describe('可选阻塞原因'),
  },
} as Record<string, z.ZodRawShape>;

export interface HubMcpAuthOptions {
  hubToken?: string;
  /** HUB_MCP_AUTH_MODE：warn = 只审计不拒绝（存量客户端迁移窗口）；默认 enforce。 */
  envMode?: string;
  logger?: HubLogger;
}

export function hubMcpRouter(db: Db, jobs: JobStore, auth: HubMcpAuthOptions = {}): Router {
  const r = Router();
  const mode = hubMcpAuthMode(auth.hubToken, auth.envMode);

  r.post('/hub-mcp/:contactId', async (req, res) => {
    const contactId = req.params.contactId;
    if (mode !== 'disabled' && !hubMcpBearerMatches(auth.hubToken!, contactId, req.header('authorization'))) {
      // 审计：伪造/缺失凭证的调用方、来源与声称身份都要留痕
      auth.logger?.warn({
        component: 'hub-mcp',
        contactId,
        remoteAddress: req.ip || req.socket.remoteAddress || 'unknown',
        hasAuthorization: Boolean(req.header('authorization')),
        mode,
      }, mode === 'enforce' ? 'hub-mcp bearer rejected' : 'hub-mcp bearer missing/invalid (warn mode, allowed)');
      if (mode === 'enforce') {
        return res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'missing or invalid hub-mcp bearer for this contact' },
          id: null,
        });
      }
    }
    const contact = db
      .prepare("SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'")
      .get(contactId) as ContactRow | undefined;
    const delegation: DelegationCfg = contact
      ? contactConfig(contact).delegation
      : {};
    if (!contact || delegation.enabled !== true) {
      return res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: '这个联系人没有开启 Worker 委派' },
        id: null,
      });
    }

    const server = new McpServer({ name: 'ai-hub', version: '0.1.0' });
    for (const tool of buildDelegateTools(jobs, db, contact.id, delegation, contact.id, auth.logger)) {
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
