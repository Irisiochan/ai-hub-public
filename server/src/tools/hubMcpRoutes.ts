import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router, type Request, type Response } from 'express';
import { buildDelegateTools, type DelegationCfg, type JobStore } from '../jobs/index.js';
import {
  buildRoomTaskTools,
  RoomTaskStore,
  type RoomTaskDispatcher,
  type RoomTaskStoreOptions,
  getTurn,
} from '../roomTasks/index.js';
import {
  delegateScopeForModule,
  verifyInvocationScope,
  moduleDelegationConfig,
  type DelegateScope,
  type InvocationScope,
  WORKFLOW_MODULES,
} from '../workflow/index.js';
import { contactConfig } from '../contacts/index.js';
import {
  type ContactRow,
  type Db,
  type HubLogger,
  hubMcpAuthMode,
  hubMcpBearerMatches,
} from '../platform/index.js';
import {
  buildCameraTool,
  buildTaobaoTools,
  taobaoModeFor,
  type CameraSnapBroker,
  type TaobaoBridge,
  type HeartbeatActivity,
} from '../devices/index.js';

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
  heartbeat?: HeartbeatActivity;
  taobao?: TaobaoBridge;
  taskDispatch?: RoomTaskDispatcher | null;
  taskStoreOptions?: RoomTaskStoreOptions;
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
    scopeKey: string;
    server: McpServer;
    transport: SSEServerTransport;
  }>();

  type Identity =
    | { kind: 'contact' }
    | { kind: 'invocation'; scope: InvocationScope };

  const scopeKeyFor = (contactId: string, scope: InvocationScope | null): string =>
    scope
      ? `mod:${scope.roomId}:${scope.moduleId}:${scope.revision}:${contactId}:${scope.nonce}`
      : `dm:${contactId}`;

  const authenticate = (contactId: string, req: Request, res: Response): Identity | null => {
    if (mode !== 'disabled'
      && hubMcpBearerMatches(auth.hubToken!, contactId, req.header('authorization'))) {
      return { kind: 'contact' };
    }
    // Module-turn invocation bearer: scoped to {contact, room, module,
    // revision}, re-verified per request including SSE follow-ups. It must
    // name the URL contact; anything else fails closed.
    const scope = verifyInvocationScope(auth.hubToken, req.header('authorization'));
    if (scope && scope.contactId === contactId) {
      const room = db.prepare("SELECT kind, enabled FROM contacts WHERE id = ?").get(scope.roomId) as { kind: string; enabled: number } | undefined;
      if (!room || room.kind !== 'room' || room.enabled !== 1) { res.status(403).json({ error: 'module room unavailable' }); return null; }
      // Origin-turn binding: when the bearer carries the nonce of the turn
      // that generated it, that turn must still be active with exact
      // room/contact/module match. A stale prior-turn token used during (or
      // after) a newer turn is rejected here — never upgraded to the latest
      // turn. Bearers without a nonce predate turn binding; they proceed to
      // the tool layer, where mutations still require a valid turn.
      const originTurnId = scope.invocation?.turnId;
      if (typeof originTurnId === 'string' && originTurnId) {
        const turn = getTurn(originTurnId);
        const exact = turn
          && turn.roomId === scope.roomId
          && turn.contactId === scope.contactId
          && turn.moduleId === scope.moduleId
          && (!turn.taskId || turn.taskId === scope.invocation?.taskId)
          && (!turn.handoffId || turn.handoffId === scope.invocation?.handoffId)
          && (!turn.callbackJobId || turn.callbackJobId === scope.invocation?.callbackJobId);
        if (!exact) {
          auth.logger?.warn({
            component: 'hub-mcp',
            contactId,
            roomId: scope.roomId,
            moduleId: scope.moduleId,
            mode,
          }, 'hub-mcp stale origin turn rejected');
          if (mode !== 'disabled') {
            res.status(401).json({
              jsonrpc: '2.0',
              error: { code: -32001, message: 'origin turn expired; task calls with this credential are rejected' },
              id: null,
            });
            return null;
          }
        }
      }
      return { kind: 'invocation', scope };
    }
    if (mode !== 'disabled') {
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
        return null;
      }
    }
    return { kind: 'contact' };
  };

  const authorizedContact = (contactId: string, res: Response, identity: Identity): ContactRow | null => {
    const contact = db
      .prepare("SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'")
      .get(contactId) as ContactRow | undefined;
    const cfg = contact ? contactConfig(contact) : null;
    const delegation: DelegationCfg = cfg?.delegation ?? {};
    const heartbeatOn = cfg?.heartbeat?.enabled === true;
    if (!contact || (identity.kind === 'contact' && delegation.enabled !== true && !heartbeatOn)) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: '这个联系人没有开启 Worker 委派或心跳' },
        id: null,
      });
      return null;
    }
    return contact;
  };

  /** Delegate scope for an invocation identity; null keeps contact behavior. */
  const delegateScopeFor = (contact: ContactRow, identity: Identity): DelegateScope | null => {
    if (identity.kind !== 'invocation') return null;
    const scope = delegateScopeForModule(identity.scope.moduleId);
    if (identity.scope.invocation) return { ...scope, invocation: identity.scope.invocation };
    let invocation: DelegateScope['invocation'] = null;
    try {
      const binding = jobs.workflowModules.bindings()[identity.scope.moduleId as never] as
        | { contactId: string; runner: string; model: string; reasoning: string }
        | undefined;
      const definition = WORKFLOW_MODULES.find((item) => item.id === identity.scope.moduleId);
      if (binding && definition && binding.contactId === contact.id && jobs.workflowModules.revision() === identity.scope.revision) {
        invocation = {
          moduleId: identity.scope.moduleId,
          binding: { ...binding },
          revision: identity.scope.revision,
          permissions: { ...definition.permissions },
        };
      }
    } catch {
      invocation = null;
    }
    return { allow: scope.allow && invocation !== null, routeClasses: scope.routeClasses, invocation };
  };

  const createServer = (contact: ContactRow, identity: Identity): McpServer => {
    const cfg = contactConfig(contact);
    const server = new McpServer({ name: 'ai-hub', version: '0.1.0' });
    const scope = delegateScopeFor(contact, identity);
    const delegation: DelegationCfg = scope?.invocation ? moduleDelegationConfig(scope.invocation) : cfg.delegation ?? {};
    const heartbeatOn = identity.kind === 'contact' && cfg.heartbeat?.enabled === true;
    // Invocation-scoped calls are threaded to the originating room so task
    // threads and anchors stay in the room, not the agent DM.
    const originChatId = identity.kind === 'invocation' ? identity.scope.roomId : contact.id;
    // Module turns no longer dispatch via delegate_to_worker (room-host marker
    // authority is retired; execution goes through execution_start with an
    // accepted handoff). Scoped callers keep worker_job_status (read) plus the
    // task tools below; DMs keep the legacy delegate set.
    const gatewayTools = (scope ? scope.allow : delegation.enabled === true)
      ? buildDelegateTools(jobs, db, contact.id, delegation, originChatId, auth.logger, scope, new RoomTaskStore(db, jobs, null))
        .filter((tool) => !scope || ['worker_job_status'].includes(tool.name))
      : [];
    // Model-driven task tools are independent of the delegate allow flag and
    // visible on both transports: reviewers and merge/deploy turns must reach
    // review_submit/release_execute/task_get. Each call is authorized against
    // the durable ledger plus the server-verified turn context below; DM
    // bearers carry no room context and their task tools refuse.
    // Argument-supplied room/task/module identity grants nothing.
    const invocationScope = identity.kind === 'invocation' ? identity.scope : null;
    const taskToolContext = invocationScope
      ? {
        roomId: invocationScope.roomId,
        moduleId: invocationScope.moduleId,
        ...(invocationScope.invocation?.taskId ? { taskId: invocationScope.invocation.taskId } : {}),
        ...(invocationScope.invocation?.handoffId ? { handoffId: invocationScope.invocation.handoffId } : {}),
        ...(invocationScope.invocation?.callbackJobId ? { callbackJobId: invocationScope.invocation.callbackJobId } : {}),
        ...(invocationScope.invocation?.turnId ? { turnId: invocationScope.invocation.turnId } : {}),
      }
      : null;
    gatewayTools.push(...buildRoomTaskTools(
      db, jobs, contact.id,
      extras.taskDispatch ?? null,
      extras.taskStoreOptions ?? {},
      taskToolContext,
    ));
    if (heartbeatOn && extras.broker && extras.heartbeat) {
      gatewayTools.push(buildCameraTool(extras.broker, extras.heartbeat, db, contact.id));
    }
    const taobaoMode = identity.kind === 'contact' && extras.taobao && extras.heartbeat ? taobaoModeFor(cfg) : null;
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
    const identity = authenticate(contactId, req, res);
    if (!identity) return;
    const contact = authorizedContact(contactId, res, identity);
    if (!contact) return;

    const server = createServer(contact, identity);
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
    const identity = authenticate(contactId, req, res);
    if (!identity) return;
    const contact = authorizedContact(contactId, res, identity);
    if (!contact) return;

    const server = createServer(contact, identity);
    const messageEndpoint = `/api/hub-mcp/${encodeURIComponent(contactId)}/messages`;
    const transport = new SSEServerTransport(messageEndpoint, res);
    const sessionId = transport.sessionId;
    sseSessions.set(sessionId, { contactId, scopeKey: scopeKeyFor(contactId, identity.kind === 'invocation' ? identity.scope : null), server, transport });
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
    const identity = authenticate(contactId, req, res);
    if (!identity) return;
    if (!authorizedContact(contactId, res, identity)) return;

    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const session = sseSessions.get(sessionId);
    // Follow-ups re-verify the bearer AND must match the session's scope:
    // a DM bearer cannot drive a module-scoped session and vice versa.
    const followupKey = scopeKeyFor(contactId, identity.kind === 'invocation' ? identity.scope : null);
    if (!session || session.contactId !== contactId || session.scopeKey !== followupKey) {
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
