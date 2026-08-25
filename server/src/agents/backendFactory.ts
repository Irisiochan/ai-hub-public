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
} from './gatewayTools.js';
import { GrokCliBackend } from './grokCli.js';
import { hubMcpBearerToken } from '../middleware/hubMcpAuth.js';
import type { PromptComposer, PromptContext, StartPrompt } from './promptComposer.js';
import type { AgentBackend } from './types.js';

/** HUB_TOKEN 存在时为该联系人生成 hub-mcp 的 Authorization header。 */
function hubMcpAuthHeaders(contactId: string): Record<string, string> | undefined {
  const hubToken = process.env.HUB_TOKEN;
  return hubToken
    ? { Authorization: `Bearer ${hubMcpBearerToken(hubToken, contactId)}` }
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
  prompts: PromptComposer;
}

interface BuildInput {
  ctx: BackendBuildContext;
  cfg: Record<string, any>;
  prompt: StartPrompt;
  delegation: DelegationCfg;
  delegationOn: boolean;
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
    const { cfg, ctx, deps, delegation, delegationOn, managedMcp } = input;
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
      includeHub: delegationOn,
    });
    if (delegationOn) {
      allowedTools.push('mcp__hub__*');
      preamble = deps.prompts.withDelegation(preamble, delegation, 'mcp__hub__', ctx.log);
      ctx.log('worker delegation enabled (mcp hub tools)');
    }
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
      turnTimeoutMs: deps.config.claude.turnTimeoutMs,
      log: ctx.log,
    });
  }
}

class CodexBuilder implements BackendBuilder {
  build(input: BuildInput): AgentBackend {
    const { cfg, ctx, deps, delegation, delegationOn } = input;
    const { cwd, access } = workspace(input, true);
    let preamble = input.prompt.preamble;
    if (access.enabled) {
      ctx.log(`PROJECT WRITE ENABLED: ${cwd}`);
      preamble = [preamble, PROJECT_WRITE_GIT_GUARD].join('\n');
    }
    let mcpServers;
    if (delegationOn) {
      const host = ['0.0.0.0', '::'].includes(deps.config.host) ? '127.0.0.1' : deps.config.host;
      mcpServers = [{
        name: 'hub',
        url: `http://${host}:${deps.config.port}/api/hub-mcp/${encodeURIComponent(ctx.agent.id)}`,
        enabledTools: ['delegate_to_worker', 'worker_job_status', 'worker_job_cancel', 'worker_job_update_delivery'],
        required: true,
        defaultToolsApprovalMode: 'approve' as const,
        httpHeaders: hubMcpAuthHeaders(ctx.agent.id),
      }];
      preamble = deps.prompts.withDelegation(preamble, delegation, 'mcp__hub__', ctx.log);
      ctx.log('worker delegation enabled (codex hub MCP)');
    }
    return new CodexAppServerBackend({
      cliPath: cfg.cliPath ?? deps.config.codex.cliPath,
      cwd,
      model: cfg.model ?? undefined,
      effort: cfg.effort ?? undefined,
      developerInstructions: [cfg.developerInstructions, preamble].filter(Boolean).join('\n') || undefined,
      mcpServers,
      sandbox: access.enabled ? 'workspace-write' : 'read-only',
      nativeCompact: deps.config.codex.nativeCompact,
      turnTimeoutMs: deps.config.codex.turnTimeoutMs,
      log: ctx.log,
    });
  }
}

class GrokBuilder implements BackendBuilder {
  build(input: BuildInput): AgentBackend {
    const { cfg, ctx, deps, delegation, delegationOn } = input;
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
      turnTimeoutMs: deps.config.grok.turnTimeoutMs,
      log: ctx.log,
    });
  }
}

class ApiBuilder implements BackendBuilder {
  build(input: BuildInput): AgentBackend {
    const { cfg, ctx, deps, delegation, delegationOn } = input;
    let preamble = input.prompt.preamble;
    let extraTools;
    if (delegationOn) {
      extraTools = buildDelegateTools(
        deps.jobStore!, deps.db, ctx.agent.id, delegation, ctx.convo.id
      );
      preamble = deps.prompts.withDelegation(preamble, delegation, '', ctx.log);
      ctx.log('worker delegation enabled (native tools)');
    }
    const provider = cfg.provider === 'anthropic'
      ? 'anthropic'
      : cfg.provider === 'gemini' ? 'gemini' : 'openai-compat';
    const systemPrompt = [cfg.systemPrompt, preamble].filter(Boolean).join('\n');
    if (cfg.harness?.enabled === true) {
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
      extraTools,
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
      servers['memory-vault'] = {
        type: 'http',
        url: config.memory.mcpUrl,
        ...(process.env.VAULT_TOKEN ? { headers: { Authorization: 'Bearer ${VAULT_TOKEN}' } } : {}),
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
    api: new ApiBuilder(),
    room: { build: () => { throw new Error('room 不能直接启动后端'); } },
  };

  constructor(private readonly deps: FactoryDeps) {}

  async build(ctx: BackendBuildContext): Promise<AgentBackend> {
    const cfg = contactConfig(ctx.agent) as Record<string, any>;
    const prompt = await this.deps.prompts.composeStart(ctx, ctx.resumeToken);
    const delegation: DelegationCfg = cfg.delegation ?? {};
    const delegationOn = delegation.enabled === true && !!this.deps.jobStore;
    const builder = this.builders[ctx.agent.backend];
    if (!builder) throw new Error(`backend "${ctx.agent.backend}" 不认识`);
    return builder.build({
      ctx,
      cfg,
      prompt,
      delegation,
      delegationOn,
      deps: this.deps,
      managedMcp: new ManagedMcpConfig(this.deps, ctx.agent, ctx.log),
    });
  }
}
