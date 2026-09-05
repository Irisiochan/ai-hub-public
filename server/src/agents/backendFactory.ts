import fs from 'node:fs';
import path from 'node:path';
import type { HubConfig } from '../config.js';
import type { ContactRow, Db } from '../db.js';
import type { VaultClient } from '../memory/vaultClient.js';
import type { JobStore } from '../workers/jobStore.js';
import { ClaudeCliBackend } from './claudeCli.js';
import { CodexAppServerBackend } from './codexAppServer.js';
import { contactConfig } from './configSchemas.js';
import { DirectApiBackend } from './directApi.js';
import { DshHarnessBackend } from './dshHarness.js';
import {
  PROJECT_WRITE_GIT_GUARD,
  buildDelegateTools,
  type DelegationCfg,
  type GatewayTool,
} from './gatewayTools.js';
import { GrokCliBackend } from './grokCli.js';
import { OpencodeCliBackend } from './opencodeCli.js';
import { resolveTurnTimeouts } from './turnTimeouts.js';
import { hubMcpBearerToken } from '../middleware/hubMcpAuth.js';
import type { PromptComposer, PromptContext, StartPrompt } from './promptComposer.js';
import type { AgentBackend } from './types.js';
import { HEARTBEAT_GUIDANCE, buildCameraTool } from './cameraTool.js';
import type { CameraSnapBroker } from '../workers/cameraSnap.js';
import type { TaobaoBridge } from '../workers/taobaoBridge.js';
import type { CompanionHeartbeat } from './companionHeartbeat.js';
import { buildTaobaoTools, taobaoGuidance, taobaoModeFor, taobaoToolNames, type TaobaoMode } from './taobaoTools.js';

/** HUB_TOKEN 存在时为该联系人生成 hub-mcp 的 Authorization header。 */
function hubMcpAuthHeaders(contactId: string): Record<string, string> | undefined {
  const hubToken = process.env.HUB_TOKEN;
  return hubToken
    ? { Authorization: `Bearer ${hubMcpBearerToken(hubToken, contactId)}` }
    : undefined;
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
}

interface FactoryDeps {
  db: Db;
  config: HubConfig;
  vault: VaultClient | null;
  jobStore: JobStore | null;
  broker?: CameraSnapBroker;
  heartbeat?: CompanionHeartbeat;
  taobao?: TaobaoBridge;
  prompts: PromptComposer;
}

interface BuildInput {
  ctx: BackendBuildContext;
  cfg: Record<string, any>;
  prompt: StartPrompt;
  delegation: DelegationCfg;
  delegationOn: boolean;
  heartbeatOn: boolean;
  /** Taobao policy for this contact, or null when the tools are not offered. */
  taobaoMode: TaobaoMode | null;
  deps: FactoryDeps;
  managedMcp: ManagedMcpConfig;
}

interface BackendBuilder {
  build(input: BuildInput): AgentBackend;
}

function workspace(input: BuildInput, allowProjectAccess: boolean): { cwd: string; access: Record<string, any> } {
  const { cfg, ctx, deps } = input;
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
    const mcpConfig = managedMcp.write({
      base: cfg.mcpConfig,
      cwd,
      cwdName: cfg.cwd,
      includeMemoryVault: memoryMcpOn,
      includeHub: delegationOn || heartbeatOn,
    });
    if (delegationOn) {
      allowedTools.push('mcp__hub__*');
      preamble = deps.prompts.withDelegation(preamble, delegation, 'mcp__hub__', ctx.log);
      ctx.log('worker delegation enabled (mcp hub tools)');
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
    let mcpServers;
    if (delegationOn || heartbeatOn) {
      const host = ['0.0.0.0', '::'].includes(deps.config.host) ? '127.0.0.1' : deps.config.host;
      const enabledTools = [
        ...(delegationOn
          ? ['delegate_to_worker', 'worker_job_status', 'worker_job_cancel', 'worker_job_update_delivery']
          : []),
        ...(heartbeatOn ? ['camera_snap'] : []),
        ...(taobaoMode ? taobaoToolNames(taobaoMode) : []),
      ];
      mcpServers = [{
        name: 'hub',
        url: `http://${host}:${deps.config.port}/api/hub-mcp/${encodeURIComponent(ctx.agent.id)}`,
        enabledTools,
        required: true,
        defaultToolsApprovalMode: 'approve' as const,
        httpHeaders: hubMcpAuthHeaders(ctx.agent.id),
      }];
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
      mcpServers,
      sandbox: access.enabled ? 'workspace-write' : 'read-only',
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
    managedMcp.writeGrok({ cwd, includeHub: delegationOn || heartbeatOn });
    const timeouts = resolveTurnTimeouts(deps.config.grok, cfg);
    return new GrokCliBackend({
      cliPath: cfg.cliPath ?? deps.config.grok.cliPath,
      cwd,
      model: cfg.model ?? undefined,
      allowRules,
      disallowedTools: ['search_replace', 'run_terminal_command'],
      // 聊天联系人拿不到项目写权限（上面 workspace(input, false)），改文件和跑命令的
      // 工具又被 --disallowed-tools 整个摘掉，剩下能批的只有只读工具和 vault/hub 两个
      // MCP。不开的话 search_tool / use_tool 这类内置元工具会落到 headless 的确认弹窗，
      // 没人点 → 整轮 stop_reason=cancelled（2026-07-31 阿野写记忆库就是这么断的）。
      alwaysApprove: true,
      preamble: [cfg.appendSystemPrompt, preamble].filter(Boolean).join('\n') || undefined,
      turnIdleTimeoutMs: timeouts.idleTimeoutMs,
      turnHardTimeoutMs: timeouts.hardTimeoutMs,
      log: ctx.log,
    });
  }
}

class OpencodeBuilder implements BackendBuilder {
  build(input: BuildInput): AgentBackend {
    const { cfg, ctx, deps, heartbeatOn, taobaoMode, managedMcp } = input;
    const { cwd } = workspace(input, false);
    const preamble = [
      cfg.appendSystemPrompt,
      input.prompt.preamble,
      ...(heartbeatOn ? [HEARTBEAT_GUIDANCE] : []),
      ...(taobaoMode ? [taobaoGuidance(taobaoMode)] : []),
    ].filter(Boolean).join('\n');
    const configPath = heartbeatOn ? managedMcp.writeOpencode({ cwd }) : undefined;
    if (heartbeatOn) ctx.log('companion heartbeat enabled (opencode hub MCP camera_snap)');
    if (taobaoMode) ctx.log(`heartbeat taobao bridge enabled (opencode hub MCP taobao_* mode=${taobaoMode})`);
    const timeouts = resolveTurnTimeouts(deps.config.opencode, cfg);
    return new OpencodeCliBackend({
      cliPath: cfg.cliPath ?? deps.config.opencode.cliPath,
      cwd,
      model: cfg.model || undefined,
      variant: cfg.effort || undefined,
      preamble: preamble || undefined,
      configPath,
      turnIdleTimeoutMs: timeouts.idleTimeoutMs,
      turnHardTimeoutMs: timeouts.hardTimeoutMs,
      log: ctx.log,
    });
  }
}

class ApiBuilder implements BackendBuilder {
  build(input: BuildInput): AgentBackend {
    const { cfg, ctx, deps, delegation, delegationOn, heartbeatOn, taobaoMode } = input;
    let preamble = input.prompt.preamble;
    const extraTools: GatewayTool[] = [];
    if (delegationOn) {
      extraTools.push(...buildDelegateTools(
        deps.jobStore!, deps.db, ctx.agent.id, delegation, ctx.convo.id
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
        turnTimeoutMs: deps.config.claude.turnTimeoutMs,
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
      turnTimeoutMs: deps.config.claude.turnTimeoutMs,
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
      const headers = hubMcpAuthHeaders(this.agent.id);
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

  writeOpencode(opts: { cwd: string }): string {
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
    const headers = hubMcpAuthHeaders(this.agent.id);
    const body = JSON.stringify({
      ...base,
      mcp: {
        ...(base.mcp && typeof base.mcp === 'object' ? base.mcp : {}),
        hub: {
          type: 'remote',
          url: `http://${host}:${this.deps.config.port}/api/hub-mcp/${this.agent.id}`,
          enabled: true,
          oauth: false,
          ...(headers ? { headers } : {}),
        },
      },
    }, null, 2);
    const dir = path.resolve(path.dirname(this.deps.config.dbPath), 'agents', this.agent.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'opencode.gateway.json');
    fs.writeFileSync(file, body, { encoding: 'utf-8', mode: 0o600 });
    this.log(`opencode config written heartbeatMcp=true bytes=${body.length} ~tokens=${Math.ceil(body.length / 4)} file=${path.basename(file)}`);
    return file;
  }

  writeGrok(opts: { cwd: string; includeHub: boolean }): string | undefined {
    const dir = path.join(opts.cwd, '.grok');
    const file = path.join(dir, 'config.toml');
    try {
      return this.writeGrokProject(file, opts.includeHub);
    } catch (error: any) {
      const code = typeof error?.code === 'string' ? error.code : 'unknown';
      this.log(`grok project config unavailable (${code}: ${error?.message ?? error}) - continuing without project config`);
      if (!opts.includeHub) return undefined;
      try {
        return this.refreshMatchingGrokUserConfig();
      } catch (fallbackError: any) {
        const fallbackCode = typeof fallbackError?.code === 'string' ? fallbackError.code : 'unknown';
        this.log(`grok user config refresh unavailable (${fallbackCode}: ${fallbackError?.message ?? fallbackError}) - backend will use existing Grok config`);
        return undefined;
      }
    }
  }

  private writeGrokProject(file: string, includeHub: boolean): string | undefined {
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
    const headers = hubMcpAuthHeaders(this.agent.id);
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
    api: new ApiBuilder(),
    room: { build: () => { throw new Error('room 不能直接启动后端'); } },
  };

  constructor(private readonly deps: FactoryDeps) {}

  async build(ctx: BackendBuildContext): Promise<AgentBackend> {
    const cfg = contactConfig(ctx.agent) as Record<string, any>;
    const prompt = await this.deps.prompts.composeStart(ctx, ctx.resumeToken);
    const delegation: DelegationCfg = cfg.delegation ?? {};
    const delegationOn = delegation.enabled === true && !!this.deps.jobStore;
    const heartbeatOn = cfg.heartbeat?.enabled === true
      && !!this.deps.broker
      && !!this.deps.heartbeat;
    const taobaoMode = heartbeatOn && this.deps.taobao ? taobaoModeFor(cfg) : null;
    const builder = this.builders[ctx.agent.backend];
    if (!builder) throw new Error(`backend "${ctx.agent.backend}" 不认识`);
    return builder.build({
      ctx,
      cfg,
      prompt,
      delegation,
      delegationOn,
      heartbeatOn,
      taobaoMode,
      deps: this.deps,
      managedMcp: new ManagedMcpConfig(this.deps, ctx.agent, ctx.log),
    });
  }
}
