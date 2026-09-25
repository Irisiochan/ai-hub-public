import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  type HubConfig,
  type ContactRow,
  type Db,
  type GatewayTool,
  hubMcpBearerToken,
} from '../platform/index.js';
import type { VaultClient } from '../memory/index.js';
import {
  type JobStore,
  PROJECT_WRITE_GIT_GUARD,
  buildDelegateTools,
  type DelegationCfg,
} from '../jobs/index.js';
import {
  ClaudeCliBackend,
  CodexAppServerBackend,
  type CodexMcpServerConfig,
  contactHttpMcpServers,
  DirectApiBackend,
  DshHarnessBackend,
  GrokCliBackend,
  prepareGrokRuntimeHome,
  OpencodeCliBackend,
  KimiCliBackend,
  resolveTurnTimeouts,
  type AgentBackend,
} from '../backends/index.js';
import { contactConfig } from '../contacts/index.js';
import {
  delegateScopeForModule,
  sanitizeContactConfigForModule,
  signInvocationScope,
  moduleDelegationConfig,
  type DelegateScope,
  type ModuleTurnInvocation,
  parseRoomGovernance,
} from '../workflow/index.js';
import type { PromptComposer, PromptContext, StartPrompt } from '../prompt/index.js';
import {
  buildRoomTaskTools,
  roomTaskGuidance,
  ROOM_TASK_TOOL_NAMES,
  RoomTaskStore,
  type RoomTaskDispatcher,
  type RoomTaskStoreOptions,
} from '../roomTasks/index.js';
import {
  HEARTBEAT_GUIDANCE,
  buildCameraTool,
  type CameraSnapBroker,
  type TaobaoBridge,
  type HeartbeatActivity,
  buildTaobaoTools,
  taobaoGuidance,
  taobaoModeFor,
  taobaoToolNames,
  type TaobaoMode,
} from '../devices/index.js';

/** HUB_TOKEN 存在时为该联系人生成 hub-mcp 的 Authorization header。 */
function hubMcpAuthHeaders(contactId: string): Record<string, string> | undefined {
  const hubToken = process.env.HUB_TOKEN;
  return hubToken
    ? { Authorization: `Bearer ${hubMcpBearerToken(hubToken, contactId)}` }
    : undefined;
}

/**
 * Module-turn hub MCP headers: a signed invocation bearer scoped to
 * {contact, room, module, revision} instead of the contact-wide bearer.
 * The hub router re-verifies it per request (including SSE follow-ups) and
 * constrains delegate dispatch to the module scope. DM turns (no invocation)
 * keep the legacy per-contact bearer untouched.
 */
function hubHeadersForTurn(ctx: BackendBuildContext): Record<string, string> | undefined {
  const hubToken = process.env.HUB_TOKEN;
  if (!hubToken) return undefined;
  const invocation = ctx.moduleInvocation;
  if (invocation && ctx.isRoom) {
    const token = signInvocationScope(hubToken, {
      contactId: ctx.agent.id,
      roomId: ctx.convo.id,
      moduleId: invocation.moduleId,
      revision: invocation.revision,
      invocation,
    });
    if (token) return { Authorization: `Bearer ${token}` };
  }
  return hubMcpAuthHeaders(ctx.agent.id);
}

/** VAULT_TOKEN 存在时直接写入 memory-vault HTTP MCP 的 Authorization header。 */
function memoryVaultMcpAuthHeaders(): Record<string, string> | undefined {
  const vaultToken = process.env.VAULT_TOKEN;
  return vaultToken
    ? { Authorization: `Bearer ${vaultToken}` }
    : undefined;
}

export interface BackendBuildContext extends PromptContext {
  memberId: string;
  resumeToken: string | null;
  /**
   * Captured module invocation for workflow-room turns (immutable snapshot).
   * Null for DM and legacy turns. Backends must derive tool access, sandbox,
   * delegation scope and MCP credentials from it — never from contact flags
   * alone, and never by re-resolving the latest binding.
   */
  moduleInvocation?: ModuleTurnInvocation | null;
}

interface FactoryDeps {
  db: Db;
  config: HubConfig;
  vault: VaultClient | null;
  jobStore: JobStore | null;
  broker?: CameraSnapBroker;
  heartbeat?: HeartbeatActivity;
  taobao?: TaobaoBridge;
  prompts: PromptComposer;
  /** Delivery transport for task handoffs/callbacks (wired by the gateway root). */
  taskDispatch?: RoomTaskDispatcher | null;
  taskStoreOptions?: RoomTaskStoreOptions;
}

interface BuildInput {
  ctx: BackendBuildContext;
  cfg: Record<string, any>;
  prompt: StartPrompt;
  delegation: DelegationCfg;
  delegationOn: boolean;
  /** Module delegate scope; null when delegation is off or unscoped (DM). */
  delegateScope?: DelegateScope | null;
  /** Model-driven task tools (separate from the delegate allow flag; every module turn gets them). */
  roomTaskTools: GatewayTool[];
  heartbeatOn: boolean;
  /** Taobao policy for this contact, or null when the tools are not offered. */
  taobaoMode: TaobaoMode | null;
  deps: FactoryDeps;
  managedMcp: ManagedMcpConfig;
}

interface BackendBuilder {
  build(input: BuildInput): AgentBackend;
}

/** True when contact-level external MCP servers must be withheld this turn:
 * every workflow-room module turn runs isolated from the contact's external
 * tools (gateway-managed memory-vault/hub servers are unaffected). The
 * isolation applies to dispatching turns (plan/execute) and non-dispatch
 * turns alike — it is not a read-only marker and never removes authorized
 * delegate_to_worker dispatch. */
function restrictedExternalMcp(input: Pick<BuildInput, 'ctx'>): boolean {
  const invocation = input.ctx.moduleInvocation;
  return Boolean(input.ctx.isRoom && invocation);
}

/** SSH allowance for the spawned child: module turns without ssh stay
 * scrubbed (agent sockets removed); DM and legacy turns are unchanged. */
function sshAllowedFor(ctx: BackendBuildContext): boolean {
  const invocation = ctx.moduleInvocation;
  return !ctx.isRoom || !invocation ? true : invocation.permissions.ssh === true;
}

function workspace(input: BuildInput, allowProjectAccess: boolean): { cwd: string; access: Record<string, any> } {
  const { cfg, ctx, deps } = input;
  if (ctx.moduleInvocation) {
    // Room turns delegate approved project work to the Worker. Their own
    // scratch/MCP files live outside the deployed checkout and are isolated
    // from other rooms, tasks and binding revisions.
    const key = crypto.createHash('sha256').update(`${ctx.convo.id}:${ctx.memberId}`).digest('hex').slice(0, 24);
    const cwd = path.resolve(path.dirname(deps.config.dbPath), 'agents', 'workflow', key);
    fs.mkdirSync(cwd, { recursive: true });
    cfg.cwd = cwd;
    return { cwd, access: {} };
  }
  const access = cfg.projectAccess ?? {};
  if (access.enabled && !allowProjectAccess) {
    throw new Error(`${ctx.agent.backend} 后端暂不支持项目写权限，先在设置里关掉再聊`);
  }
  const cwd = access.enabled
    ? path.resolve(String(access.workspace ?? ''))
    : path.resolve(deps.config.agentsDir, cfg.cwd ?? ctx.agent.id);
  if (access.enabled && (!access.workspace || path.parse(cwd).root === cwd || !fs.existsSync(cwd))) {
    throw new Error('项目写权限已开启，但 workspace 无效、是磁盘根目录或不存在');
  }
  fs.mkdirSync(cwd, { recursive: true });
  return { cwd, access };
}

class ClaudeBuilder implements BackendBuilder {
  build(input: BuildInput): AgentBackend {
    const { cfg, ctx, deps, delegation, delegationOn, heartbeatOn, taobaoMode, managedMcp } = input;
    const { cwd, access } = workspace(input, true);
    const writeTools = access.enabled
      ? ['Read', 'Grep', 'Glob', 'Write', 'Edit', ...(access.allowShell ? ['Bash'] : [])]
      : [];
    const allowedTools = [...new Set([...(cfg.allowedTools ?? []), ...writeTools])];
    const disallowedTools = (cfg.disallowedTools ?? []).filter((tool: string) => !writeTools.includes(tool));
    let preamble = input.prompt.preamble;
    if (access.enabled) {
      ctx.log(`PROJECT WRITE ENABLED: ${cwd} (shell=${!!access.allowShell})`);
      preamble = [preamble, PROJECT_WRITE_GIT_GUARD].join('\n');
    }
    const memoryMcpOn = !!deps.vault && ctx.memory.injectOnSpawn;
    if (memoryMcpOn) allowedTools.push('mcp__memory-vault__*');
    // Module turns never inherit the contact's external MCP servers;
    // gateway-managed memory/hub servers are still attached below.
    const externalMcpBase = restrictedExternalMcp(input) ? undefined : cfg.mcpConfig;
    if (restrictedExternalMcp(input)) {
      ctx.log(`module capability: external contact MCP servers withheld for this module turn (module ${input.ctx.moduleInvocation?.moduleId ?? 'unknown'}); authorized dispatch is unaffected`);
    }
    const mcpConfig = managedMcp.write({
      base: externalMcpBase,
      cwd,
      cwdName: cfg.cwd,
      includeMemoryVault: memoryMcpOn,
      includeHub: delegationOn || heartbeatOn || !!ctx.moduleInvocation,
      hubHeaders: hubHeadersForTurn(ctx),
    });
    if (delegationOn) {
      allowedTools.push('mcp__hub__*');
      preamble = deps.prompts.withDelegation(preamble, delegation, 'mcp__hub__', ctx.log);
      ctx.log('worker delegation enabled (mcp hub tools)');
    } else if (ctx.moduleInvocation) {
      // Room task tools (task_get / task_accept / review_submit / ...) ride the
      // same hub MCP server for every module turn, including the modules that
      // never dispatch Worker jobs (review / arbitration / merge / deploy).
      // The gateway authorizes each call per turn; the CLI allowlist only
      // decides whether the call reaches the gateway at all. Without this
      // entry every mcp__hub__* call becomes a permission prompt, which
      // claudePermissionDecision denies ("聊天模式没开放").
      allowedTools.push('mcp__hub__*');
      ctx.log(`room task tools allowed (claude hub MCP, module ${ctx.moduleInvocation.moduleId})`);
    }
    if (heartbeatOn) {
      allowedTools.push('mcp__hub__camera_snap');
      preamble = [preamble, HEARTBEAT_GUIDANCE].filter(Boolean).join('\n');
      ctx.log('companion heartbeat enabled (claude hub MCP camera_snap)');
    }
    if (taobaoMode) {
      allowedTools.push(...taobaoToolNames(taobaoMode).map((name) => `mcp__hub__${name}`));
      preamble = [preamble, taobaoGuidance(taobaoMode)].filter(Boolean).join('\n');
      ctx.log(`heartbeat taobao bridge enabled (claude hub MCP taobao_* mode=${taobaoMode})`);
    }
    const timeouts = resolveTurnTimeouts(deps.config.claude, cfg);
    return new ClaudeCliBackend({
      cliPath: cfg.cliPath ?? deps.config.claude.cliPath,
      cwd,
      model: cfg.model ?? undefined,
      effort: cfg.effort ?? undefined,
      allowedTools: allowedTools.length ? allowedTools : undefined,
      disallowedTools: disallowedTools.length ? disallowedTools : undefined,
      appendSystemPrompt: [cfg.appendSystemPrompt, preamble].filter(Boolean).join('\n') || undefined,
      permissionMode: cfg.permissionMode ?? undefined,
      mcpConfig,
      sshAllowed: sshAllowedFor(input.ctx),
      turnIdleTimeoutMs: timeouts.idleTimeoutMs,
      turnHardTimeoutMs: timeouts.hardTimeoutMs,
      log: ctx.log,
    });
  }
}

class CodexBuilder implements BackendBuilder {
  build(input: BuildInput): AgentBackend {
    const { cfg, ctx, deps, delegation, delegationOn, heartbeatOn, taobaoMode } = input;
    const { cwd, access } = workspace(input, true);
    let preamble = input.prompt.preamble;
    if (access.enabled) {
      ctx.log(`PROJECT WRITE ENABLED: ${cwd}`);
      preamble = [preamble, PROJECT_WRITE_GIT_GUARD].join('\n');
    }
    const mcpServers: CodexMcpServerConfig[] = restrictedExternalMcp(input)
      ? []
      : contactHttpMcpServers(cfg.mcpConfig, cwd, cfg.allowedTools);
    if (restrictedExternalMcp(input)) {
      ctx.log(`module capability: external contact MCP servers withheld for this module turn (module ${input.ctx.moduleInvocation?.moduleId ?? 'unknown'}); authorized dispatch is unaffected`);
    }
    const memoryMcpOn = !!deps.vault && !!ctx.memory?.injectOnSpawn && !!deps.config.memory.mcpUrl;
    if (memoryMcpOn) {
      mcpServers.push({
        name: 'memory_vault',
        url: deps.config.memory.mcpUrl!,
        required: false,
        defaultToolsApprovalMode: 'auto',
        httpHeaders: memoryVaultMcpAuthHeaders(),
      });
      ctx.log('memory vault MCP enabled (codex auto-approve)');
    }
    if (delegationOn || heartbeatOn || ctx.moduleInvocation) {
      const host = ['0.0.0.0', '::'].includes(deps.config.host) ? '127.0.0.1' : deps.config.host;
      // Task tools are enumerated per action and are independent of the
      // delegate allow flag: reviewers and merge/deploy turns must see
      // review_submit/release_execute/task_get even though delegate_to_worker
      // stays withheld from them.
      const enabledTools = [
        ...(delegationOn
          ? (ctx.moduleInvocation ? ['delegate_to_worker', 'worker_job_status']
            : ['delegate_to_worker', 'worker_job_status', 'worker_job_cancel', 'worker_job_update_delivery'])
          : (ctx.moduleInvocation ? ['worker_job_status'] : [])),
        ...(ctx.moduleInvocation || delegationOn ? [...ROOM_TASK_TOOL_NAMES] : []),
        ...(heartbeatOn ? ['camera_snap'] : []),
        ...(taobaoMode ? taobaoToolNames(taobaoMode) : []),
      ];
      mcpServers.push({
        name: 'hub',
        url: `http://${host}:${deps.config.port}/api/hub-mcp/${encodeURIComponent(ctx.agent.id)}`,
        enabledTools,
        required: true,
        defaultToolsApprovalMode: 'approve' as const,
        httpHeaders: hubHeadersForTurn(ctx),
      });
      if (delegationOn) {
        preamble = deps.prompts.withDelegation(preamble, delegation, 'mcp__hub__', ctx.log);
        ctx.log('worker delegation enabled (codex hub MCP)');
      }
      if (heartbeatOn) {
        preamble = [preamble, HEARTBEAT_GUIDANCE].filter(Boolean).join('\n');
        ctx.log('companion heartbeat enabled (codex hub MCP camera_snap)');
      }
      if (taobaoMode) {
        preamble = [preamble, taobaoGuidance(taobaoMode)].filter(Boolean).join('\n');
        ctx.log(`heartbeat taobao bridge enabled (codex hub MCP taobao_* mode=${taobaoMode})`);
      }
    }
    const timeouts = resolveTurnTimeouts(deps.config.codex, cfg);
    return new CodexAppServerBackend({
      cliPath: cfg.cliPath ?? deps.config.codex.cliPath,
      cwd,
      model: cfg.model ?? undefined,
      effort: cfg.effort ?? undefined,
      developerInstructions: [cfg.developerInstructions, preamble].filter(Boolean).join('\n') || undefined,
      mcpServers: mcpServers.length ? mcpServers : undefined,
      sandbox: access.enabled ? 'workspace-write' : 'read-only',
      sshAllowed: sshAllowedFor(ctx),
      nativeCompact: deps.config.codex.nativeCompact,
      turnIdleTimeoutMs: timeouts.idleTimeoutMs,
      turnHardTimeoutMs: timeouts.hardTimeoutMs,
      log: ctx.log,
    });
  }
}

class GrokBuilder implements BackendBuilder {
  build(input: BuildInput): AgentBackend {
    const { cfg, ctx, deps, delegation, delegationOn, heartbeatOn, taobaoMode, managedMcp } = input;
    const { cwd } = workspace(input, false);
    let preamble = input.prompt.preamble;
    const memoryMcpOn = !!deps.vault && ctx.memory.injectOnSpawn;
    const allowRules: string[] = [];
    if (memoryMcpOn) allowRules.push('MCPTool(memory-vault__*)');
    if (delegationOn) {
      allowRules.push('MCPTool(hub__*)');
      preamble = deps.prompts.withDelegation(preamble, delegation, 'hub__', ctx.log);
      ctx.log('worker delegation enabled (grok hub MCP)');
    } else if (ctx.moduleInvocation) {
      // Task tools ride the hub MCP for non-dispatch module turns as well;
      // the router (not the allow-list) enforces the per-turn tool set.
      allowRules.push('MCPTool(hub__*)');
      ctx.log('room task tools enabled (grok hub MCP)');
    }
    if (heartbeatOn) {
      allowRules.push('MCPTool(hub__camera_snap)');
      preamble = [preamble, HEARTBEAT_GUIDANCE].filter(Boolean).join('\n');
      ctx.log('companion heartbeat enabled (grok hub MCP camera_snap)');
    }
    if (taobaoMode) {
      allowRules.push(...taobaoToolNames(taobaoMode).map((name) => `MCPTool(hub__${name})`));
      preamble = [preamble, taobaoGuidance(taobaoMode)].filter(Boolean).join('\n');
      ctx.log(`heartbeat taobao bridge enabled (grok hub MCP taobao_* mode=${taobaoMode})`);
    }
    const hubHeaders = hubHeadersForTurn(ctx);
    const runtimeHome = ctx.isRoom && ctx.moduleInvocation
      ? prepareGrokRuntimeHome({
        cwd,
        servers: {
          hub: {
            url: `http://${['0.0.0.0', '::'].includes(deps.config.host) ? '127.0.0.1' : deps.config.host}:${deps.config.port}/api/hub-mcp/${ctx.agent.id}`,
            headers: hubHeaders,
          },
          ...(memoryMcpOn && deps.config.memory.mcpUrl ? { 'memory-vault': {
            url: deps.config.memory.mcpUrl,
            headers: memoryVaultMcpAuthHeaders(),
          } } : {}),
        },
      }) : undefined;
    if (!runtimeHome) managedMcp.writeGrok({
      cwd,
      includeHub: delegationOn || heartbeatOn || !!ctx.moduleInvocation,
      hubHeaders,
      // Module turns never touch the long-lived user config (see writeGrok).
      allowUserRefresh: ctx.moduleInvocation && ctx.isRoom ? false : undefined,
    });
    const timeouts = resolveTurnTimeouts(deps.config.grok, cfg);
    return new GrokCliBackend({
      cliPath: cfg.cliPath ?? deps.config.grok.cliPath,
      cwd,
      runtimeHome,
      model: cfg.model ?? undefined,
      allowRules,
      effort: cfg.effort ?? undefined,
      disallowedTools: ['search_replace', 'run_terminal_command'],
      // 聊天联系人拿不到项目写权限（上面 workspace(input, false)），改文件和跑命令的
      // 工具又被 --disallowed-tools 整个摘掉，剩下能批的只有只读工具和 vault/hub 两个
      // MCP。不开的话 search_tool / use_tool 这类内置元工具会落到 headless 的确认弹窗，
      // 没人点 → 整轮 stop_reason=cancelled（2026-07-31 阿野写记忆库就是这么断的）。
      alwaysApprove: true,
      preamble: [cfg.appendSystemPrompt, preamble].filter(Boolean).join('\n') || undefined,
      sshAllowed: sshAllowedFor(ctx),
      turnIdleTimeoutMs: timeouts.idleTimeoutMs,
      turnHardTimeoutMs: timeouts.hardTimeoutMs,
      log: ctx.log,
    });
  }
}

class OpencodeBuilder implements BackendBuilder {
  build(input: BuildInput): AgentBackend {
    const { cfg, ctx, deps, delegation, delegationOn, heartbeatOn, taobaoMode, managedMcp } = input;
    const { cwd } = workspace(input, false);
    let preamble = [
      cfg.appendSystemPrompt,
      input.prompt.preamble,
      ...(heartbeatOn ? [HEARTBEAT_GUIDANCE] : []),
      ...(taobaoMode ? [taobaoGuidance(taobaoMode)] : []),
    ].filter(Boolean).join('\n');
    if (delegationOn) preamble = deps.prompts.withDelegation(preamble, delegation, 'hub_', ctx.log);
    const planVault = ctx.moduleInvocation?.moduleId === 'plan' && !!deps.vault && !!ctx.memory?.injectOnSpawn;
    const hubOn = heartbeatOn || delegationOn || !!ctx.moduleInvocation;
    const configPath = hubOn
      ? managedMcp.writeOpencode({ cwd, hubHeaders: hubHeadersForTurn(ctx), includeMemoryVault: planVault })
      : undefined;
    if (heartbeatOn) ctx.log('companion heartbeat enabled (opencode hub MCP camera_snap)');
    if (ctx.moduleInvocation) ctx.log('room task tools enabled (opencode hub MCP)');
    if (taobaoMode) ctx.log(`heartbeat taobao bridge enabled (opencode hub MCP taobao_* mode=${taobaoMode})`);
    const timeouts = resolveTurnTimeouts(deps.config.opencode, cfg);
    return new OpencodeCliBackend({
      cliPath: cfg.cliPath ?? deps.config.opencode.cliPath,
      cwd,
      model: cfg.model || undefined,
      variant: cfg.effort || undefined,
      preamble: preamble || undefined,
      configPath,
      ...(ctx.moduleInvocation ? { permission: {
        '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
        bash: 'deny', edit: 'deny', task: 'deny', skill: 'deny', external_directory: 'deny',
        ...((delegationOn || !!ctx.moduleInvocation) ? { 'hub_*': 'allow' } : {}),
        ...(planVault ? { 'memory-vault_*': 'allow' } : {}),
      } } : {}),
      sshAllowed: sshAllowedFor(ctx),
      turnIdleTimeoutMs: timeouts.idleTimeoutMs,
      turnHardTimeoutMs: timeouts.hardTimeoutMs,
      log: ctx.log,
    });
  }
}

class KimiBuilder implements BackendBuilder {
  build(input: BuildInput): AgentBackend {
    const { cfg, ctx, deps, delegation, delegationOn, heartbeatOn, taobaoMode } = input;
    const { cwd } = workspace(input, false);
    let preamble = [
      cfg.appendSystemPrompt,
      input.prompt.preamble,
      ...(heartbeatOn ? [HEARTBEAT_GUIDANCE] : []),
      ...(taobaoMode ? [taobaoGuidance(taobaoMode)] : []),
    ].filter(Boolean).join('\n');
    if (delegationOn) preamble = deps.prompts.withDelegation(preamble, delegation, '', ctx.log);
    // kimi print mode has no hub MCP writer yet; DM contact still gets preamble/AGENTS.md.
    if (heartbeatOn) ctx.log('companion heartbeat guidance injected (kimi-cli; no hub MCP bridge yet)');
    if (taobaoMode) ctx.log(`heartbeat taobao guidance injected (kimi-cli; no hub MCP bridge yet, mode=${taobaoMode})`);
    if (ctx.moduleInvocation) ctx.log('room task guidance present (kimi-cli; tools via kimi native, no hub MCP)');
    const timeouts = resolveTurnTimeouts(deps.config.kimi, cfg);
    return new KimiCliBackend({
      cliPath: cfg.cliPath ?? deps.config.kimi.cliPath,
      cwd,
      model: cfg.model || undefined,
      effort: cfg.effort ?? undefined,
      preamble: preamble || undefined,
      sshAllowed: sshAllowedFor(ctx),
      turnIdleTimeoutMs: timeouts.idleTimeoutMs,
      turnHardTimeoutMs: timeouts.hardTimeoutMs,
      // Inherit service-user HOME / KIMI_CODE_HOME from the hub process env (VPS:
      // HOME=/var/lib/ai-hub/home, KIMI_CODE_HOME=/var/lib/ai-hub/home/.kimi-code).
      log: ctx.log,
    });
  }
}

class ApiBuilder implements BackendBuilder {
  build(input: BuildInput): AgentBackend {
    const { cfg, ctx, deps, delegation, delegationOn, delegateScope, roomTaskTools, heartbeatOn, taobaoMode } = input;
    let preamble = input.prompt.preamble;
    const extraTools: GatewayTool[] = [];
    if (roomTaskTools.length) {
      extraTools.push(...roomTaskTools);
      ctx.log('room task tools enabled (native tools)');
    }
    if (delegationOn) {
      extraTools.push(...buildDelegateTools(
        deps.jobStore!, deps.db, ctx.agent.id, delegation, ctx.convo.id, undefined,
        delegateScope ?? undefined, new RoomTaskStore(deps.db, deps.jobStore!, null),
      ));
      preamble = deps.prompts.withDelegation(preamble, delegation, '', ctx.log);
      ctx.log('worker delegation enabled (native tools)');
    }
    const harnessOn = cfg.harness?.enabled === true;
    if (!harnessOn && heartbeatOn && deps.broker && deps.heartbeat) {
      extraTools.push(buildCameraTool(deps.broker, deps.heartbeat, deps.db, ctx.agent.id));
      preamble = [preamble, HEARTBEAT_GUIDANCE].filter(Boolean).join('\n');
      ctx.log('companion heartbeat enabled (api native camera_snap)');
    }
    if (!harnessOn && taobaoMode && deps.taobao && deps.heartbeat) {
      extraTools.push(...buildTaobaoTools(deps.taobao, deps.heartbeat, deps.db, ctx.agent.id, taobaoMode));
      preamble = [preamble, taobaoGuidance(taobaoMode)].filter(Boolean).join('\n');
      ctx.log(`heartbeat taobao bridge enabled (api native taobao_* mode=${taobaoMode})`);
    }
    const provider = cfg.provider === 'anthropic'
      ? 'anthropic'
      : cfg.provider === 'gemini' ? 'gemini' : 'openai-compat';
    const systemPrompt = [cfg.systemPrompt, preamble].filter(Boolean).join('\n');
    if (harnessOn) {
      if (provider !== 'openai-compat') {
        throw new Error('DSH harness 当前只支持 DeepSeek openai-compatible 联系人');
      }
      if (delegationOn) {
        throw new Error('DSH harness 已有自己的工具链，先关闭 AI Hub worker delegation');
      }
      if (cfg.projectAccess?.enabled) {
        throw new Error('DSH harness 使用独立沙箱 workspace，不能同时开启项目写权限');
      }
      const apiKey = cfg.apiKey || (cfg.apiKeyRef ? process.env[cfg.apiKeyRef] ?? '' : '');
      if (!apiKey) throw new Error('DSH harness 缺少 DeepSeek API key');
      return new DshHarnessBackend({
        command: cfg.harness.command,
        home: cfg.harness.home,
        workspace: cfg.harness.workspace,
        port: cfg.harness.port,
        model: cfg.model ?? '',
        apiKey,
        baseUrl: cfg.baseUrl ?? 'https://api.deepseek.com/v1/chat/completions',
        systemPrompt: systemPrompt || undefined,
        turnTimeoutMs: deps.config.api.turnTimeoutMs,
        log: ctx.log,
      });
    }
    return new DirectApiBackend({
      provider,
      baseUrl: cfg.baseUrl ?? (
        provider === 'anthropic'
          ? 'https://api.anthropic.com/v1/messages'
          : provider === 'gemini'
            ? 'https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse'
            : 'https://api.openai.com/v1/chat/completions'
      ),
      apiKey: cfg.apiKey || (cfg.apiKeyRef ? process.env[cfg.apiKeyRef] ?? '' : ''),
      model: cfg.model ?? '',
      visionModel: cfg.visionModel || undefined,
      supportsImages: typeof cfg.supportsImages === 'boolean' ? cfg.supportsImages : undefined,
      promptCache: cfg.promptCache === 'off' ? 'off' : 'auto',
      systemPrompt: systemPrompt || undefined,
      memoryPreamble: input.prompt.memoryPreamble || undefined,
      staticPromptTokens: deps.prompts.staticTokens(systemPrompt, input.prompt.memoryPreamble),
      maxHistoryMessages: cfg.maxHistoryMessages ?? 60,
      historyTokenBudget: Math.max(Number(cfg.historyTokenBudget ?? 8000), 2048),
      minRecentTurns: Math.max(Number(cfg.minRecentTurns ?? 6), 1),
      summaryMaxTokens: Math.max(Number(cfg.summaryMaxTokens ?? 3000), 256),
      historySummaryStrategy: cfg.historySummaryStrategy === 'off'
        ? 'off' : cfg.historySummaryStrategy === 'external' ? 'external' : 'extractive',
      maxTokens: cfg.maxTokens ?? 8192,
      contextWindowTokens: Math.max(Number(cfg.contextWindowTokens ?? 128_000), 0),
      turnTimeoutMs: deps.config.api.turnTimeoutMs,
      db: deps.db,
      uploadsDir: deps.config.uploadsDir,
      contactId: ctx.convo.id,
      memberId: ctx.memberId,
      log: ctx.log,
      vault: ctx.memory.injectOnSpawn ? deps.vault ?? undefined : undefined,
      extraTools: extraTools.length ? extraTools : undefined,
      roomMode: ctx.isRoom ? { selfId: ctx.agent.id, nameOf: ctx.nameOf } : undefined,
    });
  }
}

class ManagedMcpConfig {
  constructor(private readonly deps: FactoryDeps, private readonly agent: ContactRow, private readonly log: (m: string) => void) {}

  write(opts: {
    base: string | undefined;
    cwd: string;
    cwdName: string | undefined;
    includeMemoryVault: boolean;
    includeHub: boolean;
    hubHeaders?: Record<string, string>;
  }): string | undefined {
    let servers: Record<string, unknown> = {};
    if (opts.base) {
      try {
        const raw = opts.base.trim().startsWith('{')
          ? opts.base
          : fs.readFileSync(this.resolve(opts.base, opts.cwd), 'utf-8');
        servers = { ...(JSON.parse(raw).mcpServers ?? {}) };
      } catch (error: any) {
        this.log(`base mcp config unreadable (${error.message}) - using gateway MCP defaults`);
      }
    }
    const { config } = this.deps;
    if (opts.includeMemoryVault && config.memory.mcpUrl) {
      const headers = memoryVaultMcpAuthHeaders();
      servers['memory-vault'] = {
        type: 'http',
        url: config.memory.mcpUrl,
        ...(headers ? { headers } : {}),
      };
    }
    if (opts.includeHub) {
      const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
      const headers = opts.hubHeaders ?? hubMcpAuthHeaders(this.agent.id);
      servers.hub = {
        type: 'http',
        url: `http://${host}:${config.port}/api/hub-mcp/${this.agent.id}`,
        ...(headers ? { headers } : {}),
      };
    }
    if (Object.keys(servers).length === 0) return opts.base;
    // 生成物不能落在代码检出里：M1.5 之后 systemd 用 ProtectSystem=strict 把
    // /opt/ai-hub 挂成只读，只有 data 目录（DB 所在处）与 /var/lib/ai-hub 可写。
    // 写进 agentsDir 会以 EROFS 打挂后端启动。CLI 只吃绝对路径，放哪儿都行。
    const dir = path.resolve(path.dirname(config.dbPath), 'agents', opts.cwdName ?? this.agent.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'mcp.gateway.json');
    const body = JSON.stringify({ mcpServers: servers }, null, 2);
    fs.writeFileSync(file, body, 'utf-8');
    this.log(`mcp config written servers=${Object.keys(servers).length} bytes=${body.length} ~tokens=${Math.ceil(body.length / 4)} file=${path.basename(file)}`);
    return file;
  }

  writeOpencode(opts: { cwd: string; hubHeaders?: Record<string, string>; includeMemoryVault?: boolean }): string {
    const basePath = path.join(opts.cwd, 'opencode.json');
    let base: Record<string, any> = {};
    if (fs.existsSync(basePath)) {
      try {
        base = JSON.parse(fs.readFileSync(basePath, 'utf-8'));
      } catch (error: any) {
        this.log(`base opencode config unreadable (${error.message}) - using heartbeat MCP defaults`);
      }
    }
    const host = ['0.0.0.0', '::'].includes(this.deps.config.host) ? '127.0.0.1' : this.deps.config.host;
    const headers = opts.hubHeaders ?? hubMcpAuthHeaders(this.agent.id);
    const body = JSON.stringify({
      ...base,
      mcp: {
        ...(base.mcp && typeof base.mcp === 'object' ? base.mcp : {}),
        ...(opts.includeMemoryVault && this.deps.config.memory.mcpUrl ? { 'memory-vault': {
          type: 'remote', url: this.deps.config.memory.mcpUrl, enabled: true, oauth: false,
          ...(memoryVaultMcpAuthHeaders() ? { headers: memoryVaultMcpAuthHeaders() } : {}),
        } } : {}),
        hub: {
          type: 'remote',
          url: `http://${host}:${this.deps.config.port}/api/hub-mcp/${this.agent.id}`,
          enabled: true,
          oauth: false,
          ...(headers ? { headers } : {}),
        },
      },
    }, null, 2);
    const dir = opts.cwd.includes(`${path.sep}workflow${path.sep}`) ? opts.cwd
      : path.resolve(path.dirname(this.deps.config.dbPath), 'agents', this.agent.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'opencode.gateway.json');
    fs.writeFileSync(file, body, { encoding: 'utf-8', mode: 0o600 });
    this.log(`opencode config written heartbeatMcp=true bytes=${body.length} ~tokens=${Math.ceil(body.length / 4)} file=${path.basename(file)}`);
    return file;
  }

  writeGrok(opts: { cwd: string; includeHub: boolean; hubHeaders?: Record<string, string>; allowUserRefresh?: boolean }): string | undefined {
    const dir = path.join(opts.cwd, '.grok');
    const file = path.join(dir, 'config.toml');
    try {
      return this.writeGrokProject(file, opts.includeHub, opts.hubHeaders);
    } catch (error: any) {
      const code = typeof error?.code === 'string' ? error.code : 'unknown';
      this.log(`grok project config unavailable (${code}: ${error?.message ?? error}) - continuing without project config`);
      if (!opts.includeHub) return undefined;
      if (opts.allowUserRefresh === false) {
        // Module turns never persist any bearer into the long-lived user
        // config: an invocation-scoped token would expire there and break
        // later turns, and a contact bearer would silently drop scoping.
        this.log('module turn: skipping grok user config refresh so no bearer is persisted outside the turn');
        return undefined;
      }
      try {
        return this.refreshMatchingGrokUserConfig();
      } catch (fallbackError: any) {
        const fallbackCode = typeof fallbackError?.code === 'string' ? fallbackError.code : 'unknown';
        this.log(`grok user config refresh unavailable (${fallbackCode}: ${fallbackError?.message ?? fallbackError}) - backend will use existing Grok config`);
        return undefined;
      }
    }
  }

  private writeGrokProject(file: string, includeHub: boolean, hubHeaders?: Record<string, string>): string | undefined {
    const dir = path.dirname(file);
    const start = '# >>> AI Hub managed MCP: hub';
    const end = '# <<< AI Hub managed MCP: hub';
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    const managedBlock = new RegExp(
      `${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n?`,
      'g',
    );
    const hadManagedBlock = managedBlock.test(original);
    managedBlock.lastIndex = 0;
    const base = original.replace(managedBlock, '').trimEnd();
    if (!includeHub) {
      if (hadManagedBlock) fs.writeFileSync(file, base ? `${base}\n` : '', { encoding: 'utf-8', mode: 0o600 });
      return undefined;
    }
    if (/^\s*\[mcp_servers\.hub(?:\.[^\]]+)?\]\s*$/m.test(base)) {
      this.log('project grok config already defines mcp_servers.hub - preserving user-managed server');
      return file;
    }
    const host = ['0.0.0.0', '::'].includes(this.deps.config.host) ? '127.0.0.1' : this.deps.config.host;
    const headers = hubHeaders ?? hubMcpAuthHeaders(this.agent.id);
    const lines = [
      start,
      '[mcp_servers.hub]',
      `url = ${JSON.stringify(`http://${host}:${this.deps.config.port}/api/hub-mcp/${this.agent.id}`)}`,
      'enabled = true',
      ...(headers ? ['', '[mcp_servers.hub.headers]', `Authorization = ${JSON.stringify(headers.Authorization)}`] : []),
      end,
    ];
    fs.mkdirSync(dir, { recursive: true });
    const body = `${base ? `${base}\n\n` : ''}${lines.join('\n')}\n`;
    fs.writeFileSync(file, body, { encoding: 'utf-8', mode: 0o600 });
    this.log(`grok project config written heartbeatMcp=true bytes=${body.length} ~tokens=${Math.ceil(body.length / 4)}`);
    return file;
  }

  /**
   * Production keeps /opt/ai-hub read-only, so a legacy Grok contact may be
   * unable to create <cwd>/.grok/config.toml. If the user-level config already
   * belongs to this exact contact, refresh only that server's URL and bearer.
   * A config for another contact is never overwritten.
   */
  private refreshMatchingGrokUserConfig(): string | undefined {
    const home = process.env.HOME?.trim();
    if (!home) {
      this.log('grok user config refresh skipped: HOME is not set');
      return undefined;
    }
    const file = path.join(home, '.grok', 'config.toml');
    if (!fs.existsSync(file)) {
      this.log('grok user config refresh skipped: config.toml not found');
      return undefined;
    }

    const original = fs.readFileSync(file, 'utf-8');
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const lines = original.split(/\r?\n/);
    const section = (header: string): { start: number; end: number } | undefined => {
      const start = lines.findIndex((line) => line.trim() === header);
      if (start < 0) return undefined;
      let end = start + 1;
      while (end < lines.length && !/^\s*\[/.test(lines[end]!)) end += 1;
      return { start, end };
    };
    const hub = section('[mcp_servers.hub]');
    if (!hub) {
      this.log('grok user config refresh skipped: mcp_servers.hub not found');
      return undefined;
    }
    const urlLine = lines.slice(hub.start + 1, hub.end).find((line) => /^\s*url\s*=/.test(line));
    if (!urlLine || !urlLine.includes(`/api/hub-mcp/${this.agent.id}`)) {
      this.log('grok user config refresh skipped: hub server belongs to another contact');
      return undefined;
    }

    const host = ['0.0.0.0', '::'].includes(this.deps.config.host) ? '127.0.0.1' : this.deps.config.host;
    const url = `http://${host}:${this.deps.config.port}/api/hub-mcp/${this.agent.id}`;
    const urlIndex = lines.findIndex((line, index) => index > hub.start && index < hub.end && /^\s*url\s*=/.test(line));
    lines[urlIndex] = `url = ${JSON.stringify(url)}`;

    const headers = hubMcpAuthHeaders(this.agent.id);
    if (headers) {
      const headerSection = section('[mcp_servers.hub.headers]');
      if (headerSection) {
        const authIndex = lines.findIndex((line, index) => (
          index > headerSection.start && index < headerSection.end && /^\s*Authorization\s*=/.test(line)
        ));
        const authLine = `Authorization = ${JSON.stringify(headers.Authorization)}`;
        if (authIndex >= 0) lines[authIndex] = authLine;
        else lines.splice(headerSection.end, 0, authLine);
      } else {
        if (lines.at(-1) !== '') lines.push('');
        lines.push('[mcp_servers.hub.headers]', `Authorization = ${JSON.stringify(headers.Authorization)}`, '');
      }
    }

    const body = lines.join(eol);
    if (body !== original) fs.writeFileSync(file, body, { encoding: 'utf-8', mode: 0o600 });
    this.log(`grok user config refreshed for contact=${this.agent.id} bytes=${body.length} ~tokens=${Math.ceil(body.length / 4)}`);
    return file;
  }

  private resolve(file: string, cwd: string): string {
    if (path.isAbsolute(file)) return file;
    const cwdRelative = path.resolve(cwd, file);
    return fs.existsSync(cwdRelative) ? cwdRelative : path.resolve(file);
  }
}

export class BackendFactory {
  private readonly builders: Record<ContactRow['backend'], BackendBuilder> = {
    'claude-cli': new ClaudeBuilder(),
    codex: new CodexBuilder(),
    'grok-cli': new GrokBuilder(),
    'opencode-cli': new OpencodeBuilder(),
    'kimi-cli': new KimiBuilder(),
    api: new ApiBuilder(),
    room: { build: () => { throw new Error('room 不能直接启动后端'); } },
  };

  constructor(private readonly deps: FactoryDeps) {}

  async build(ctx: BackendBuildContext): Promise<AgentBackend> {
    const rawCfg = contactConfig(ctx.agent) as Record<string, any>;
    // Module invocation governs this turn: intersect contact flags with the
    // module policy (read-only turns never inherit project write access),
    // gate delegation to the module scope, and scope MCP credentials.
    // DM and legacy turns (no invocation) keep exact legacy behavior.
    const invocation = (ctx.isRoom ? ctx.moduleInvocation : null) ?? null;
    // Confused-deputy guard: the captured invocation always belongs to this
    // turn's agent. A mismatched binding never builds a backend.
    if (invocation && invocation.binding.contactId !== ctx.agent.id) {
      throw new Error(
        `module invocation contact ${invocation.binding.contactId} does not match turn agent ${ctx.agent.id}; refusing the turn`,
      );
    }
    let cfg = rawCfg;
    if (invocation) {
      const sanitized = sanitizeContactConfigForModule(rawCfg, invocation, ctx.agent.backend);
      cfg = sanitized.cfg;
      for (const note of sanitized.notes) ctx.log(`module capability: ${note}`);
    }
    const composedPrompt = await this.deps.prompts.composeStart(ctx, ctx.resumeToken);
    // O7: task guidance follows room governance (open rooms get the short
    // pass-based spec; strict rooms keep the legacy ritual text).
    const roomGovernance = ((): 'strict' | 'open' => {
      try {
        if (!invocation || !ctx.isRoom) return 'strict';
        return parseRoomGovernance(JSON.parse(ctx.convo.config || '{}'));
      } catch {
        return 'strict';
      }
    })();
    const prompt = invocation
      ? { ...composedPrompt, preamble: [composedPrompt.preamble, roomTaskGuidance(roomGovernance)].filter(Boolean).join('\n') }
      : composedPrompt;
    const delegation: DelegationCfg = invocation ? moduleDelegationConfig(invocation) : cfg.delegation ?? {};
    let delegationOn = delegation.enabled === true && !!this.deps.jobStore;
    let delegateScope: DelegateScope | null = null;
    if (invocation) {
      const scope = delegateScopeForModule(invocation.moduleId);
      if (!scope.allow) {
        delegationOn = false;
        ctx.log(
          `module ${invocation.moduleId} never dispatches worker jobs from a turn: ` +
          `worker delegation tools withheld for this turn`,
        );
      } else {
        delegateScope = { allow: true, routeClasses: scope.routeClasses, invocation };
        ctx.log(
          `module ${invocation.moduleId} delegation scope: ${scope.routeClasses.join('/')}` +
          (invocation.workspace ? ` workspace=${invocation.workspace}` : '') +
          (invocation.taskPath ? ` task=${invocation.taskPath}` : ''),
        );
      }
    }
    const heartbeatOn = !invocation && cfg.heartbeat?.enabled === true
      && !!this.deps.broker
      && !!this.deps.heartbeat;
    const taobaoMode = heartbeatOn && this.deps.taobao ? taobaoModeFor(cfg) : null;
    // Room task tools are independent of the delegate allow flag: every
    // module turn (including review/arbitration/merge/deploy) must see
    // task_get/review_submit/release_execute. The store authorizes each call.
    const roomTaskTools: GatewayTool[] = this.deps.jobStore
      ? buildRoomTaskTools(
        this.deps.db,
        this.deps.jobStore,
        ctx.agent.id,
        this.deps.taskDispatch ?? null,
        this.deps.taskStoreOptions ?? {},
        // Trusted per-turn context: room session + captured module (+ pinned
        // task when this turn was handoff/callback-woken) + the origin-turn
        // nonce bound at turn start. DM/legacy turns get none and their task
        // tools refuse. Never from caller arguments.
        invocation && ctx.isRoom
          ? {
            roomId: ctx.convo.id,
            moduleId: invocation.moduleId,
            ...(invocation.taskId ? { taskId: invocation.taskId } : {}),
            ...(invocation.handoffId ? { handoffId: invocation.handoffId } : {}),
            ...(invocation.callbackJobId ? { callbackJobId: invocation.callbackJobId } : {}),
            ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
          }
          : null,
      )
      : [];
    if (invocation && roomTaskTools.length) {
      ctx.log(`room task tools enabled (native, module ${invocation.moduleId})`);
    }
    const builder = this.builders[ctx.agent.backend];
    if (!builder) throw new Error(`backend "${ctx.agent.backend}" 不认识`);
    return builder.build({
      ctx,
      cfg,
      prompt,
      delegation,
      delegationOn,
      delegateScope,
      roomTaskTools,
      heartbeatOn,
      taobaoMode,
      deps: this.deps,
      managedMcp: new ManagedMcpConfig(this.deps, ctx.agent, ctx.log),
    });
  }
}
