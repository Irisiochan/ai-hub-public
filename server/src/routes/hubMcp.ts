import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router, type Request, type Response } from 'express';
import { buildDelegateTools, type DelegationCfg } from '../agents/gatewayTools.js';
import { contactConfig } from '../agents/configSchemas.js';
import type { ContactRow, Db } from '../db.js';
import type { HubLogger } from '../logger.js';
import { hubMcpAuthMode, hubMcpBearerMatches } from '../middleware/hubMcpAuth.js';
import type { JobStore } from '../workers/jobStore.js';
import { buildCameraTool } from '../agents/cameraTool.js';
import { buildTaobaoTools, taobaoModeFor } from '../agents/taobaoTools.js';
import type { CameraSnapBroker } from '../workers/cameraSnap.js';
import type { TaobaoBridge } from '../workers/taobaoBridge.js';
import type { CompanionHeartbeat } from '../agents/companionHeartbeat.js';

/**
 * Per-contact MCP endpoint (`/api/hub-mcp/:contactId`) exposing the PC-worker
 * delegate tools to CLI backends. Claude CLI contacts get it merged into
 * their --mcp-config by the manager; Codex app-server gets per-process
 * mcp_servers.hub overrides, so no global config.toml edit is needed.
 * Streamable HTTP remains stateless (one server+transport per POST). The same
 * URL also accepts legacy HTTP+SSE GETs for OpenCode; its follow-up messages
 * are posted to `/api/hub-mcp/:contactId/messages`.
 * Identity = URL contactId + per-contact HMAC bearer（见 middleware/hubMcpAuth.ts；
 * session auth 对本前缀的豁免仅指 hub session cookie 不适用，不再等于无认证）。
 */

export interface HubMcpAuthOptions {
  hubToken?: string;
  /** HUB_MCP_AUTH_MODE：warn = 只审计不拒绝（存量客户端迁移窗口）；默认 enforce。 */
  envMode?: string;
  logger?: HubLogger;
}

export interface HubMcpExtras {
  broker?: CameraSnapBroker;
  heartbeat?: CompanionHeartbeat;
  taobao?: TaobaoBridge;
}

export function hubMcpRouter(
  db: Db,
  jobs: JobStore,
  auth: HubMcpAuthOptions = {},
  extras: HubMcpExtras = {},
): Router {
  const r = Router();
  const mode = hubMcpAuthMode(auth.hubToken, auth.envMode);
  const sseSessions = new Map<string, {
    contactId: string;
    server: McpServer;
    transport: SSEServerTransport;
  }>();

  const authenticate = (contactId: string, req: Request, res: Response): boolean => {
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
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'missing or invalid hub-mcp bearer for this contact' },
          id: null,
        });
        return false;
      }
    }
    return true;
  };

  const authorizedContact = (contactId: string, res: Response): ContactRow | null => {
    const contact = db
      .prepare("SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'")
      .get(contactId) as ContactRow | undefined;
    const cfg = contact ? contactConfig(contact) : null;
    const delegation: DelegationCfg = cfg?.delegation ?? {};
    const heartbeatOn = cfg?.heartbeat?.enabled === true;
    if (!contact || (delegation.enabled !== true && !heartbeatOn)) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: '这个联系人没有开启 Worker 委派或心跳' },
        id: null,
      });
      return null;
    }
    return contact;
  };

  const createServer = (contact: ContactRow): McpServer => {
    const cfg = contactConfig(contact);
    const delegation: DelegationCfg = cfg.delegation ?? {};
    const heartbeatOn = cfg.heartbeat?.enabled === true;
    const server = new McpServer({ name: 'ai-hub', version: '0.1.0' });
    const gatewayTools = delegation.enabled === true
      ? buildDelegateTools(jobs, db, contact.id, delegation, contact.id, auth.logger)
      : [];
    if (heartbeatOn && extras.broker && extras.heartbeat) {
      gatewayTools.push(buildCameraTool(extras.broker, extras.heartbeat, db, contact.id));
    }
    const taobaoMode = extras.taobao && extras.heartbeat ? taobaoModeFor(cfg) : null;
    if (taobaoMode) {
      gatewayTools.push(...buildTaobaoTools(extras.taobao!, extras.heartbeat!, db, contact.id, taobaoMode));
    }
    for (const tool of gatewayTools) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputSchema },
        async (input: Record<string, unknown>) => {
          const out = await tool.exec(input ?? {});
          return {
            content: [
              { type: 'text' as const, text: out.text },
              ...(out.image
                ? [{ type: 'image' as const, data: out.image.data, mimeType: out.image.mimeType }]
                : []),
            ],
            isError: !out.ok,
          };
        }
      );
    }
    return server;
  };

  r.post('/hub-mcp/:contactId', async (req, res) => {
    const contactId = req.params.contactId;
    if (!authenticate(contactId, req, res)) return;
    const contact = authorizedContact(contactId, res);
    if (!contact) return;

    const server = createServer(contact);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // OpenCode 1.18.x 仍使用 MCP 2024-11-05 HTTP+SSE transport。
  r.get('/hub-mcp/:contactId', async (req, res) => {
    const contactId = req.params.contactId;
    if (!authenticate(contactId, req, res)) return;
    const contact = authorizedContact(contactId, res);
    if (!contact) return;

    const server = createServer(contact);
    const messageEndpoint = `/api/hub-mcp/${encodeURIComponent(contactId)}/messages`;
    const transport = new SSEServerTransport(messageEndpoint, res);
    const sessionId = transport.sessionId;
    sseSessions.set(sessionId, { contactId, server, transport });
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      sseSessions.delete(sessionId);
      void server.close();
    };
    transport.onclose = cleanup;
    transport.onerror = (error) => {
      auth.logger?.warn({ component: 'hub-mcp', contactId, sessionId, error: String(error) }, 'hub-mcp SSE transport error');
    };
    res.on('close', () => {
      cleanup();
      void transport.close();
    });
    await server.connect(transport);
  });

  r.post('/hub-mcp/:contactId/messages', async (req, res) => {
    const contactId = req.params.contactId;
    if (!authenticate(contactId, req, res)) return;
    if (!authorizedContact(contactId, res)) return;

    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const session = sseSessions.get(sessionId);
    if (!session || session.contactId !== contactId) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No matching SSE transport found for sessionId' },
        id: null,
      });
    }
    await session.transport.handlePostMessage(req, res, req.body);
  });

  r.delete('/hub-mcp/:contactId', (_req, res) => res.status(405).end());

  return r;
}
