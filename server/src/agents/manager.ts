import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HubConfig, MemoryConfig } from '../config.js';
import { attachmentPathsForMessages, hardDeleteMessages } from '../attachments.js';
import {
  deactivateSession,
  getActiveSession,
  getLastSeen,
  saveSession,
  setLastSeen,
  type ContactRow,
  type Db,
  type MessageRow,
} from '../db.js';
import { maybeCapture } from '../memory/capture.js';
import {
  PREAMBLE_UNAVAILABLE,
  buildSessionPreamble,
  buildTurnBlock,
  wrapTurnText,
} from '../memory/inject.js';
import type { VaultClient } from '../memory/vaultClient.js';
import { getUserProfile } from '../routes/user.js';
import type { SseHub } from '../sse.js';
import type { JobStore } from '../workers/jobStore.js';
import { ClaudeCliBackend } from './claudeCli.js';
import { CodexAppServerBackend } from './codexAppServer.js';
import { touchConversationSummary } from './conversationSummary.js';
import { DirectApiBackend } from './directApi.js';
import { GrokCliBackend } from './grokCli.js';
import { GROK_HUB_ALLOW_RULE, syncManagedGrokHubMcpConfig } from './grokMcpConfig.js';
import {
  PROJECT_WRITE_GIT_GUARD,
  buildDelegateTools,
  delegationGuidance,
  type DelegationCfg,
} from './gatewayTools.js';
import type { AgentBackend, TurnHandle } from './types.js';

export function managedHubMcpConfig(url: string): Record<string, unknown> {
  return {
    type: 'http',
    url,
    headers: { Authorization: 'Bearer ${HUB_MCP_TOKEN}' },
  };
}

export type RoomTurnOutcome = 'spoke' | 'silent' | 'error';

type QueueItem =
  | { kind: 'dm'; userMessageId: number; text: string; enqueuedAt: number }
  // 群聊回合：出队时才构建增量 transcript；reaction = 接话轮（可 [PASS] 沉默）
  | { kind: 'room-turn'; mode: 'normal' | 'reaction'; enqueuedAt: number; resolve: (r: RoomTurnOutcome) => void };

const PASS_RE = /^[\s（(【\[]*(pass|不接话|沉默|skip)[\s）)】\]。.!～~]*$/i;

function stableFinalText(streamedText: string, finalText: string): string {
  if (!streamedText) return finalText;
  if (!finalText || streamedText.startsWith(finalText)) return streamedText;
  if (finalText.startsWith(streamedText)) return finalText;
  return streamedText;
}

const QUEUE_CAP = 5;
const CRASH_LOCKOUT = 3;
const CRASH_WINDOW_MS = 5 * 60_000;

interface Deps {
  db: Db;
  sse: SseHub;
  config: HubConfig;
  vault: VaultClient | null;
  jobStore: JobStore | null;
}

/**
 * 一个"某成员在某会话里"的运行时。DM 时 convo === agent；
 * 群聊时 convo 是 room 行、agent 是成员联系人（各成员独立会话互不拖累）。
 */
export class AgentRuntime {
  private queue: QueueItem[] = [];
  private running = false;
  private backend: AgentBackend | null = null;
  private backendStartedAt = 0;
  private sessionInputTokens = 0;
  private rolloverAfterTurn = false;
  private currentHandle: TurnHandle | null = null;
  private crashes: number[] = [];
  private seenMemoryPaths = new Set<string>();
  state = 'idle';

  constructor(private convo: ContactRow, private agent: ContactRow, private deps: Deps) {}

  private get isRoom(): boolean {
    return this.convo.id !== this.agent.id;
  }

  private get memberId(): string {
    return this.isRoom ? this.agent.id : '';
  }

  /** 记忆配置：全局 < 成员自己的 < 群覆盖 */
  private memCfg(): MemoryConfig {
    const agentCfg = JSON.parse(this.agent.config || '{}');
    const convoCfg = JSON.parse(this.convo.config || '{}');
    return {
      ...this.deps.config.memory,
      ...(agentCfg.memory ?? {}),
      ...(this.isRoom ? convoCfg.memory ?? {} : {}),
    };
  }

  async updateAgent(row: ContactRow): Promise<void> {
    this.agent = row;
    if (!this.isRoom) this.convo = row;
    if (this.backend) {
      await this.backend.stop();
      this.backend = null;
    }
  }

  updateConvo(row: ContactRow): void {
    if (this.isRoom) this.convo = row;
  }

  enqueue(item: { userMessageId: number; text: string }): 'queued' | 'full' {
    if (this.queue.length >= QUEUE_CAP) return 'full';
    this.queue.push({ kind: 'dm', ...item, enqueuedAt: Date.now() });
    void this.run();
    return 'queued';
  }

  /** 群聊回合：编排器 await 结果（spoke/silent/error），实现顺序发言与接话轮。 */
  runRoomTurn(mode: 'normal' | 'reaction'): Promise<RoomTurnOutcome> {
    return new Promise((resolve) => {
      this.queue.push({ kind: 'room-turn', mode, enqueuedAt: Date.now(), resolve });
      void this.run();
    });
  }

  interrupt(): void {
    void this.currentHandle?.interrupt();
  }

  async reset(): Promise<void> {
    this.queue = [];
    await this.backend?.stop();
    this.backend = null;
    this.crashes = [];
    deactivateSession(this.deps.db, this.convo.id, this.isRoom ? this.memberId : undefined);
    this.setState('idle');
  }

  async stop(): Promise<void> {
    await this.backend?.stop();
    this.backend = null;
  }

  private log(msg: string): void {
    const tag = this.isRoom ? `${this.convo.name}·${this.agent.name}` : this.agent.name;
    console.log(`  [${tag}] ${msg}`);
  }

  /** Display name of the speaking agent (room member or DM contact). */
  get agentName(): string {
    return this.agent.name;
  }

  private setState(state: string, detail?: string): void {
    this.state = state;
    this.deps.sse.broadcast('status', {
      contactId: this.convo.id,
      state,
      detail,
      // Room turns must always carry the member display name — UI must never
      // fall back to the room title (e.g. 「会议室 思考中」).
      member: this.isRoom ? this.agent.name : undefined,
    });
  }

  /** 发言人显示名：user → 当前用户资料名，其余查联系人表。 */
  private nameOf(sender: string): string {
    if (sender === 'user') return getUserProfile(this.deps.db).name;
    if (sender === this.agent.id) return this.agent.name;
    const row = this.deps.db.prepare('SELECT name FROM contacts WHERE id = ?').get(sender) as
      | { name: string }
      | undefined;
    return row?.name ?? sender;
  }

  private insertMessage(fields: {
    role: string;
    kind: string;
    content: string;
    status: string;
    turnId: string | null;
    meta?: unknown;
  }): MessageRow {
    const { db } = this.deps;
    const r = db
      .prepare(
        `INSERT INTO messages (contact_id, sender, role, kind, content, status, turn_id, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.convo.id,
        this.agent.id,
        fields.role,
        fields.kind,
        fields.content,
        fields.status,
        fields.turnId,
        JSON.stringify(fields.meta ?? {})
      );
    return db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(Number(r.lastInsertRowid)) as MessageRow;
  }

  private updateMessage(id: number, content: string, status: string, meta?: unknown): MessageRow {
    const { db } = this.deps;
    if (meta !== undefined) {
      db.prepare('UPDATE messages SET content = ?, status = ?, meta = ? WHERE id = ?').run(
        content,
        status,
        JSON.stringify(meta),
        id
      );
    } else {
      db.prepare('UPDATE messages SET content = ?, status = ? WHERE id = ?').run(content, status, id);
    }
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        await this.processTurn(item);
      }
    } finally {
      this.running = false;
    }
  }

  private lockedOut(): boolean {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    return this.crashes.length >= CRASH_LOCKOUT;
  }

  private recordCrash(): void {
    this.crashes.push(Date.now());
  }

  /** 群聊身份框架：进 system prompt，讲清群规（@ 不召唤、带名字前缀等）。 */
  private roomFraming(): string {
    if (!this.isRoom) return '';
    const cfg = JSON.parse(this.convo.config || '{}');
    const memberIds: string[] = cfg.members ?? [];
    const names = memberIds.map((id) => this.nameOf(id));
    const userName = getUserProfile(this.deps.db).name;
    return [
      '',
      `# 群聊模式：「${this.convo.name}」`,
      `成员：${names.join('、')}；用户：${userName}。你是其中的「${this.agent.name}」。`,
      '- 你收到的群消息带「名字：」前缀标明发言人；你自己发言直接说内容，不要加前缀。',
      '- 群里 @某人 不会自动召唤对方。想让谁跟进就直接说出来，由用户决定叫谁。',
      '- 群聊节奏：简短、有自己观点、不复读别人说过的，不用每条都接。',
      '- 每轮发言后有"接话轮"：你会看到其他成员刚说的话，可以自然接话、反驳、补充；',
      '  没什么想说的就只回 [PASS]（会被网关静默处理，不丢人）。宁可 PASS 也别硬找话。',
      '- 其他成员的错误/掉线由网关处理，你不会看到，也不用分析。',
    ].join('\n');
  }

  private async ensureStarted(): Promise<void> {
    if (this.backend?.alive()) return;
    const cfg = JSON.parse(this.agent.config || '{}');
    const mem = this.memCfg();
    const resumeToken = getActiveSession(this.deps.db, this.convo.id, this.memberId);

    let preamble = '';
    let memoryPreamble = '';
    // API contacts default to compact (cheaper fixed prefix); full/off remain explicit opts.
    // CLI/other backends keep full — their spawn path differs and is out of this change set.
    const memoryPreambleMode =
      this.agent.backend === 'api'
        ? (cfg.memoryPreambleMode ?? 'compact')
        : 'full';
    if (this.deps.vault && mem.injectOnSpawn && memoryPreambleMode !== 'off') {
      try {
        memoryPreamble = await buildSessionPreamble(
          this.deps.vault,
          {
            id: this.agent.id,
            name: this.agent.name,
            backend: this.agent.backend,
          },
          memoryPreambleMode
        );
        preamble = memoryPreamble;
        this.log(`memory preamble injected (${preamble.length} chars)`);
      } catch (e: any) {
        preamble = PREAMBLE_UNAVAILABLE;
        this.log(`memory preamble unavailable: ${e.message}`);
      }
    }
    this.seenMemoryPaths.clear();

    preamble = [this.roomFraming(), preamble].filter(Boolean).join('\n');

    const delegation: DelegationCfg = cfg.delegation ?? {};
    const delegationOn = delegation.enabled === true && !!this.deps.jobStore;
    const cliDelegationOn = delegationOn && ['claude-cli', 'codex', 'grok-cli'].includes(this.agent.backend);
    if (cliDelegationOn && !process.env.HUB_MCP_TOKEN?.trim()) {
      throw new Error('Worker 委派需要配置独立的 HUB_MCP_TOKEN');
    }

    if (!resumeToken) {
      const bridge = this.buildBridge();
      if (bridge) {
        preamble = [preamble, bridge].filter(Boolean).join('\n');
        this.log('conversation archive bridged into fresh session');
      }
    }

    if (this.agent.backend === 'claude-cli') {
      const access = cfg.projectAccess ?? {};
      const cwd = access.enabled
        ? path.resolve(String(access.workspace ?? ''))
        : path.resolve(this.deps.config.agentsDir, cfg.cwd ?? this.agent.id);
      if (access.enabled && (!access.workspace || path.parse(cwd).root === cwd || !fs.existsSync(cwd))) {
        throw new Error('项目写权限已开启，但 workspace 无效、是磁盘根目录或不存在');
      }
      fs.mkdirSync(cwd, { recursive: true });
      const writeTools = access.enabled
        ? ['Read', 'Grep', 'Glob', 'Write', 'Edit', ...(access.allowShell ? ['Bash'] : [])]
        : [];
      const allowedTools = [...new Set([...(cfg.allowedTools ?? []), ...writeTools])];
      const disallowedTools = (cfg.disallowedTools ?? []).filter((t: string) => !writeTools.includes(t));
      if (access.enabled) this.log(`PROJECT WRITE ENABLED: ${cwd} (shell=${!!access.allowShell})`);
      if (access.enabled) preamble = [preamble, PROJECT_WRITE_GIT_GUARD].join('\n');
      const memoryMcpOn = !!this.deps.vault && mem.injectOnSpawn;
      if (memoryMcpOn) allowedTools.push('mcp__memory-vault__*');
      const mcpConfig = this.writeManagedMcpConfig({
        base: cfg.mcpConfig,
        cwd,
        cwdName: cfg.cwd,
        includeMemoryVault: memoryMcpOn,
        includeHub: delegationOn,
      });
      if (delegationOn) {
        allowedTools.push('mcp__hub__*');
        preamble = [preamble, delegationGuidance(delegation, 'mcp__hub__')].join('\n');
        this.log('worker delegation enabled (mcp hub tools)');
      }
      this.backend = new ClaudeCliBackend({
        cliPath: cfg.cliPath ?? this.deps.config.claude.cliPath,
        cwd,
        model: cfg.model ?? undefined,
        effort: cfg.effort ?? undefined,
        allowedTools: allowedTools.length ? allowedTools : undefined,
        disallowedTools: disallowedTools.length ? disallowedTools : undefined,
        appendSystemPrompt:
          [cfg.appendSystemPrompt, preamble].filter(Boolean).join('\n') || undefined,
        permissionMode: cfg.permissionMode ?? undefined,
        mcpConfig,
        turnTimeoutMs: this.deps.config.claude.turnTimeoutMs,
        log: (m) => this.log(m),
      });
    } else if (this.agent.backend === 'codex') {
      const access = cfg.projectAccess ?? {};
      const cwd = access.enabled
        ? path.resolve(String(access.workspace ?? ''))
        : path.resolve(this.deps.config.agentsDir, cfg.cwd ?? this.agent.id);
      if (access.enabled && (!access.workspace || path.parse(cwd).root === cwd || !fs.existsSync(cwd))) {
        throw new Error('项目写权限已开启，但 workspace 无效、是磁盘根目录或不存在');
      }
      fs.mkdirSync(cwd, { recursive: true });
      if (access.enabled) this.log(`PROJECT WRITE ENABLED: ${cwd}`);
      if (access.enabled) preamble = [preamble, PROJECT_WRITE_GIT_GUARD].join('\n');
      let mcpServers;
      if (delegationOn) {
        const { config } = this.deps;
        const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
        const url = `http://${host}:${config.port}/api/hub-mcp/${encodeURIComponent(this.agent.id)}`;
        mcpServers = [{
          name: 'hub',
          url,
          bearerTokenEnvVar: 'HUB_MCP_TOKEN',
          enabledTools: ['delegate_to_worker', 'worker_job_status', 'worker_job_cancel'],
          required: true,
          defaultToolsApprovalMode: 'approve' as const,
        }];
        preamble = [preamble, delegationGuidance(delegation, 'mcp__hub__')].join('\n');
        this.log('worker delegation enabled (codex hub MCP)');
      }
      this.backend = new CodexAppServerBackend({
        cliPath: cfg.cliPath ?? this.deps.config.codex.cliPath,
        cwd,
        model: cfg.model ?? undefined,
        effort: cfg.effort ?? undefined,
        developerInstructions:
          [cfg.developerInstructions, preamble].filter(Boolean).join('\n') || undefined,
        mcpServers,
        sandbox: access.enabled ? 'workspace-write' : 'read-only',
        turnTimeoutMs: this.deps.config.codex.turnTimeoutMs,
        log: (m) => this.log(m),
      });
    } else if (this.agent.backend === 'grok-cli') {
      const access = cfg.projectAccess ?? {};
      if (access.enabled) {
        throw new Error('grok-cli 后端暂不支持项目写权限，先在设置里关掉再聊');
      }
      const cwd = path.resolve(this.deps.config.agentsDir, cfg.cwd ?? this.agent.id);
      fs.mkdirSync(cwd, { recursive: true });
      const memoryMcpOn = !!this.deps.vault && mem.injectOnSpawn;
      const allowRules: string[] = [];
      if (memoryMcpOn) allowRules.push('MCPTool(memory-vault__*)');
      const { config } = this.deps;
      const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
      const hubMcpUrl = delegationOn
        ? `http://${host}:\${HUB_PORT:-${config.port}}/api/hub-mcp/${encodeURIComponent(this.agent.id)}`
        : undefined;
      syncManagedGrokHubMcpConfig(cwd, hubMcpUrl);
      if (delegationOn) {
        allowRules.push(GROK_HUB_ALLOW_RULE);
        preamble = [preamble, delegationGuidance(delegation, 'hub__')].join('\n');
        this.log('worker delegation enabled (grok project hub MCP)');
      }
      // chat-only 模式：禁掉内置写/终端工具，防 headless 确认墙炸整轮
      // 与其他 CLI 后端的工具白名单策略保持一致：看不见就不会调
      const disallowedTools = ['search_replace', 'run_terminal_command'];
      this.backend = new GrokCliBackend({
        cliPath: cfg.cliPath ?? this.deps.config.grok.cliPath,
        cwd,
        model: cfg.model ?? undefined,
        allowRules,
        disallowedTools,
        // grok headless 没有 system-prompt flag：人设 + 记忆前缀作为首轮网关注入
        preamble: [cfg.appendSystemPrompt, preamble].filter(Boolean).join('\n') || undefined,
        // The cwd is AI Hub's managed chat directory (project writes are rejected
        // above). Disable Grok's interactive folder-trust gate only for this child
        // so its generated project MCP config can load in headless mode.
        env: delegationOn ? { GROK_FOLDER_TRUST: '0' } : undefined,
        turnTimeoutMs: this.deps.config.grok.turnTimeoutMs,
        log: (m) => this.log(m),
      });
    } else if (this.agent.backend === 'api') {
      const apiKey: string = cfg.apiKey || (cfg.apiKeyRef ? process.env[cfg.apiKeyRef] ?? '' : '');
      let extraTools;
      if (delegationOn) {
        extraTools = buildDelegateTools(
          this.deps.jobStore!,
          this.deps.db,
          this.agent.id,
          delegation,
          this.convo.id
        );
        preamble = [preamble, delegationGuidance(delegation)].join('\n');
        this.log('worker delegation enabled (native tools)');
      }
      const provider = cfg.provider === 'anthropic'
        ? 'anthropic'
        : cfg.provider === 'gemini'
          ? 'gemini'
          : 'openai-compat';
      this.backend = new DirectApiBackend({
        provider,
        baseUrl:
          cfg.baseUrl ??
          (provider === 'anthropic'
            ? 'https://api.anthropic.com/v1/messages'
            : provider === 'gemini'
              ? 'https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse'
              : 'https://api.openai.com/v1/chat/completions'),
        apiKey,
        model: cfg.model ?? '',
        visionModel: cfg.visionModel || undefined,
        supportsImages: typeof cfg.supportsImages === 'boolean' ? cfg.supportsImages : undefined,
        systemPrompt: [cfg.systemPrompt, preamble].filter(Boolean).join('\n') || undefined,
        memoryPreamble: memoryPreamble || undefined,
        maxHistoryMessages: cfg.maxHistoryMessages ?? 60,
        // 24k 默认会把近期原文塞满，叠加 tool 轮后 prompt 极易破 20k+；
        // 8k 够保 minRecentTurns 原文，更早内容走滚动摘要。可按联系人覆盖。
        historyTokenBudget: Math.max(Number(cfg.historyTokenBudget ?? 8000), 2048),
        minRecentTurns: Math.max(Number(cfg.minRecentTurns ?? 6), 1),
        summaryMaxTokens: Math.max(Number(cfg.summaryMaxTokens ?? 3000), 256),
        historySummaryStrategy:
          cfg.historySummaryStrategy === 'off'
            ? 'off'
            : cfg.historySummaryStrategy === 'external'
              ? 'external'
              : 'extractive',
        maxTokens: cfg.maxTokens ?? 4096,
        // 常见 API 窗口 128k；历史预算会再扣输出/工具/附件预留
        contextWindowTokens: Math.max(Number(cfg.contextWindowTokens ?? 128_000), 0),
        turnTimeoutMs: this.deps.config.claude.turnTimeoutMs,
        db: this.deps.db,
        uploadsDir: this.deps.config.uploadsDir,
        contactId: this.convo.id,
        memberId: this.memberId,
        log: (m) => this.log(m),
        // 记忆开着才把记忆工具声明给模型；preamble 里承诺的 search_vault/read_file 由网关代执行
        vault: mem.injectOnSpawn ? this.deps.vault ?? undefined : undefined,
        extraTools,
        roomMode: this.isRoom
          ? { selfId: this.agent.id, nameOf: (s) => this.nameOf(s) }
          : undefined,
      });
    } else {
      throw new Error(`backend "${this.agent.backend}" 不认识`);
    }

    this.log(`starting backend${resumeToken ? ` (resume ${resumeToken.slice(0, 8)}…)` : ''}`);
    await this.backend.start(resumeToken);
    this.backendStartedAt = Date.now();
  }

  /** 把联系人自己的 MCP 配置和网关托管的 memory-vault / hub 端点合并成一个稳定配置文件。 */
  private writeManagedMcpConfig(opts: {
    base: string | undefined;
    cwd: string;
    cwdName: string | undefined;
    includeMemoryVault: boolean;
    includeHub: boolean;
    fileName?: string;
  }): string | undefined {
    let servers: Record<string, unknown> = {};
    if (opts.base) {
      try {
        const raw = opts.base.trim().startsWith('{')
          ? opts.base
          : fs.readFileSync(this.resolveMcpConfigPath(opts.base, opts.cwd), 'utf-8');
        servers = { ...(JSON.parse(raw).mcpServers ?? {}) };
      } catch (e: any) {
        this.log(`base mcp config unreadable (${e.message}) - using gateway MCP defaults`);
      }
    }
    const { config } = this.deps;
    if (opts.includeMemoryVault && config.memory.mcpUrl) {
      servers['memory-vault'] = {
        type: 'http',
        url: config.memory.mcpUrl,
        ...(process.env.VAULT_TOKEN
          ? { headers: { Authorization: 'Bearer ${VAULT_TOKEN}' } }
          : {}),
      };
    }
    if (opts.includeHub) {
      const host = ['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host;
      servers.hub = managedHubMcpConfig(
        `http://${host}:${config.port}/api/hub-mcp/${this.agent.id}`
      );
    }
    if (Object.keys(servers).length === 0) return opts.base;
    const dir = path.resolve(config.agentsDir, opts.cwdName ?? this.agent.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, opts.fileName ?? 'mcp.gateway.json');
    const body = JSON.stringify({ mcpServers: servers }, null, 2);
    fs.writeFileSync(file, body, 'utf-8');
    // CLI 侧实际 schema 以客户端展开为准；这里先记网关下发的 mcp 配置体积作对照基线
    const approxTokens = Math.ceil(body.length / 4);
    this.log(
      `mcp config written servers=${Object.keys(servers).length} bytes=${body.length} ~tokens=${approxTokens} file=${path.basename(file)}`
    );
    return file;
  }

  private resolveMcpConfigPath(file: string, cwd: string): string {
    if (path.isAbsolute(file)) return file;
    const cwdRelative = path.resolve(cwd, file);
    if (fs.existsSync(cwdRelative)) return cwdRelative;
    return path.resolve(file);
  }
  /** 编辑/删除后的对话存档回放：被删内容天然不在其中——上下文诚实。 */
  private buildBridge(): string {
    if (this.agent.backend === 'api') return ''; // api 每轮都从 DB 重建历史
    const rows = this.deps.db
      .prepare(
        `SELECT sender, content FROM messages
         WHERE contact_id = ? AND kind = 'text' AND status = 'done' AND deleted = 0
         ORDER BY id DESC LIMIT 30`
      )
      .all(this.convo.id) as { sender: string; content: string }[];
    if (rows.length === 0) return '';
    const lines = rows.reverse().map((r) => `${this.nameOf(r.sender)}：${r.content.slice(0, 400)}`);
    return [
      '',
      '# 对话存档回放（网关注入）',
      '此前的 CLI 会话已被重置（消息被编辑或删除）。以下是保留下来的近期对话，被删除的内容不在其中，请以此为准继续，别提"会话重置"这回事：',
      '',
      ...lines,
    ].join('\n');
  }

  /**
   * 编辑/删除触及上下文：
   * - API：摘要覆盖区局部重建；仅改近期原文则保留摘要
   * - CLI：重置会话，下次 spawn 用存档回放
   * @param affectedFromId 变更起始 message id；省略/0 表示整份摘要作废（会话重置等）
   */
  async invalidateCliContext(affectedFromId?: number): Promise<void> {
    if (this.agent.backend === 'api') {
      const cfg = JSON.parse(this.agent.config || '{}');
      const result = touchConversationSummary(
        this.deps.db,
        this.convo.id,
        this.isRoom ? this.memberId : undefined,
        affectedFromId ?? 0,
        {
          summaryMaxTokens: Math.max(Number(cfg.summaryMaxTokens ?? 3000), 256),
          historyTokenBudget: Math.max(Number(cfg.historyTokenBudget ?? 8000), 2048),
          nameOf: this.isRoom ? (s) => this.nameOf(s) : undefined,
        }
      );
      this.log(
        `API rolling summary touch action=${result.action}` +
          (result.action === 'rebuilt'
            ? ` through=${result.through} rows=${result.rows} tokens=${result.tokens}`
            : result.action === 'kept'
              ? ` through=${result.through}`
              : '')
      );
      return;
    }
    deactivateSession(this.deps.db, this.convo.id, this.isRoom ? this.memberId : undefined);
    if (this.isRoom) {
      // 存档回放会覆盖历史，跳过重复的增量投递
      const max = this.deps.db
        .prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE contact_id = ?')
        .get(this.convo.id) as { m: number };
      setLastSeen(this.deps.db, this.convo.id, this.agent.id, max.m);
    }
    if (this.backend) {
      await this.backend.stop();
      this.backend = null;
    }
    this.log('CLI context invalidated (edit/delete) — will replay archive on next spawn');
  }

  /** 从某条 user 消息重新生成（仅 DM）。 */
  async regenerateFrom(userMessageId: number, text: string): Promise<'queued' | 'full'> {
    this.deps.db
      .prepare('UPDATE messages SET deleted = 1 WHERE contact_id = ? AND id > ?')
      .run(this.convo.id, userMessageId);
    this.deps.sse.broadcast('prune', { contactId: this.convo.id, afterId: userMessageId });
    // 该条可能被改写，且其后消息已删 → 从本条起触及摘要覆盖区
    await this.invalidateCliContext(userMessageId);
    return this.enqueue({ userMessageId, text });
  }

  private async maybeRecycleStale(): Promise<void> {
    const mem = this.memCfg();
    if (!this.deps.vault || !mem.injectOnSpawn) return;
    const maxAgeMs = mem.sessionMaxAgeHours * 3_600_000;
    if (this.backend?.alive() && maxAgeMs > 0 && Date.now() - this.backendStartedAt > maxAgeMs) {
      this.log(`backend older than ${mem.sessionMaxAgeHours}h — recycling for fresh memory context`);
      await this.backend.stop();
      this.backend = null;
    }
  }

  /**
   * 群聊增量投递：未读文本 → 带名字 transcript。
   * 错误/工具消息永不进入。超长时保留更近的消息，丢掉较早未读（仍推进 last_seen 到 upToId，
   * 避免卡死；被丢掉的早期未读可走成员自己的滚动摘要/历史预算）。
   */
  private buildRoomDelivery(): { text: string; upToId: number; imagePaths: string[] } | null {
    const lastSeen = getLastSeen(this.deps.db, this.convo.id, this.agent.id);
    const cfg = JSON.parse(this.agent.config || '{}');
    const maxChars = Math.max(Number(cfg.roomDeliveryMaxChars ?? 12_000), 2_000);
    const maxRows = Math.min(Math.max(Number(cfg.roomDeliveryMaxMessages ?? 40), 4), 80);
    const rows = this.deps.db
      .prepare(
        `SELECT id, sender, content FROM messages
         WHERE contact_id = ? AND id > ? AND deleted = 0 AND kind = 'text' AND status = 'done'
           AND sender != ?
         ORDER BY id ASC LIMIT ?`
      )
      .all(this.convo.id, lastSeen, this.agent.id, maxRows) as {
      id: number;
      sender: string;
      content: string;
    }[];
    if (rows.length === 0) return null;
    const upToId = rows[rows.length - 1].id;
    // 从最新往回装，保证接话轮看到最近上下文
    const kept: typeof rows = [];
    let used = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const line = `${this.nameOf(rows[i].sender)}：${rows[i].content}`;
      const cost = line.length + (kept.length ? 1 : 0);
      if (kept.length > 0 && used + cost > maxChars) break;
      kept.push(rows[i]);
      used += cost;
    }
    kept.reverse();
    if (kept.length < rows.length) {
      this.log(
        `room delivery trimmed ${rows.length - kept.length}/${rows.length} older unread (maxChars=${maxChars})`
      );
    }
    const lines = kept.map((r) => `${this.nameOf(r.sender)}：${r.content}`);
    return {
      text: lines.join('\n'),
      upToId,
      imagePaths: attachmentPathsForMessages(
        this.deps.db,
        this.deps.config.uploadsDir,
        kept.map((row) => row.id)
      ),
    };
  }

  private async processTurn(item: QueueItem): Promise<void> {
    const { sse } = this.deps;
    const convoId = this.convo.id;
    const turnStartedAt = Date.now();
    const queueWaitMs = Math.max(turnStartedAt - item.enqueuedAt, 0);
    const modeLabel = item.kind === 'room-turn' ? `room-${item.mode}` : 'dm';
    let prepMs = 0;
    let firstEventAt = 0;
    let firstTextAt = 0;
    let timingLogged = false;
    const markEvent = () => {
      if (!firstEventAt) firstEventAt = Date.now();
    };
    const markText = () => {
      markEvent();
      if (!firstTextAt) firstTextAt = Date.now();
    };
    const logTiming = (outcome: RoomTurnOutcome | 'done' | 'error' | 'silent', inputChars = 0, outputChars = 0) => {
      if (timingLogged) return;
      timingLogged = true;
      const totalMs = Date.now() - turnStartedAt;
      const firstEventMs = firstEventAt ? firstEventAt - turnStartedAt : -1;
      const firstTextMs = firstTextAt ? firstTextAt - turnStartedAt : -1;
      this.log(
        `turn timing mode=${modeLabel} outcome=${outcome} queueMs=${queueWaitMs} prepMs=${prepMs} firstEventMs=${firstEventMs} firstTextMs=${firstTextMs} totalMs=${totalMs} inputChars=${inputChars} outputChars=${outputChars}`
      );
    };

    // 群回合结果只回传一次
    let settled = false;
    const settle = (r: RoomTurnOutcome) => {
      if (item.kind === 'room-turn' && !settled) {
        settled = true;
        item.resolve(r);
      }
    };

    if (this.lockedOut()) {
      const row = this.insertMessage({
        role: 'system',
        kind: 'error',
        content: `${this.isRoom ? `${this.agent.name} ` : ''}连续崩了好几次，先歇了。用会话重置（session/reset）再叫我。`,
        status: 'done',
        turnId: null,
      });
      sse.broadcast('message', row);
      this.setState('error', 'crash lockout');
      this.queue = [];
      settle('error');
      return;
    }

    // 群聊：出队时构建增量投递（合批天然完成）
    let delivery: { text: string; upToId: number; imagePaths: string[] } | null = null;
    if (item.kind === 'room-turn') {
      delivery = this.buildRoomDelivery();
      if (!delivery) {
        settle('silent'); // 没有新东西可回
        return;
      }
    }

    // Mark thinking as soon as we commit to a turn — before vault/backend prep —
    // so room member name is on the wire during slow ensureStarted (not blank/room title).
    const turnId = crypto.randomUUID();
    this.setState('thinking');

    try {
      const prepStartedAt = Date.now();
      await this.maybeRecycleStale();
      await this.ensureStarted();
      prepMs = Date.now() - prepStartedAt;
    } catch (e: any) {
      this.recordCrash();
      this.backend = null;
      const row = this.insertMessage({
        role: 'system',
        kind: 'error',
        content: `${this.isRoom ? `${this.agent.name} ` : ''}后端启动失败：${e.message}`,
        status: 'done',
        turnId: null,
      });
      sse.broadcast('message', row);
      this.setState('error', e.message);
      logTiming('error');
      settle('error');
      return;
    }

    let textRow: MessageRow | null = null;
    let thinkingRow: MessageRow | null = null;
    let textBuf = '';
    let thinkingBuf = '';

    // 本轮实际投喂的文本
    const sourceText = item.kind === 'dm' ? item.text : delivery!.text;
    const reactionSuffix =
      '（接话机会：看完上面新发言，想接就简短接一句；没什么可补充就只回 [PASS]。）';
    const normalSuffix = '（轮到你了。实在没话说也可以只回 [PASS]。）';
    let turnText: string;
    if (item.kind === 'dm') {
      turnText = item.text;
    } else if (this.agent.backend === 'api') {
      // api 成员的群历史（含最新消息）由 roomMode history 携带，这里只需提示发言
      turnText = `（群里有新消息，见对话历史。）${item.kind === 'room-turn' && item.mode === 'reaction' ? reactionSuffix : normalSuffix}`;
    } else {
      turnText = `${delivery!.text}\n\n${item.kind === 'room-turn' && item.mode === 'reaction' ? reactionSuffix : normalSuffix}`;
    }

    const mem = this.memCfg();
    if (this.deps.vault && mem.searchPerTurn) {
      try {
        const block = await buildTurnBlock(
          this.deps.vault,
          sourceText,
          this.seenMemoryPaths,
          mem.maxTurnChars
        );
        if (block) {
          this.log(`memory search injected ${block.split('\n').length} entries`);
          turnText = wrapTurnText(turnText, block);
        }
      } catch {
        // best-effort — preamble is the guaranteed layer
      }
    }

    const handle = this.backend!.sendTurn({
      text: turnText,
      ...(item.kind === 'dm' ? { userMessageId: item.userMessageId } : {}),
      imagePaths: item.kind === 'dm'
        ? attachmentPathsForMessages(this.deps.db, this.deps.config.uploadsDir, [item.userMessageId])
        : delivery!.imagePaths,
    });
    this.currentHandle = handle;

    try {
      for await (const ev of handle.events) {
        switch (ev.type) {
          case 'session':
            saveSession(this.deps.db, convoId, ev.sessionId, this.memberId);
            break;

          case 'delta':
            markText();
            if (!textRow) {
              textRow = this.insertMessage({
                role: 'assistant',
                kind: 'text',
                content: '',
                status: 'streaming',
                turnId,
              });
              sse.broadcast('message', textRow);
              this.setState('streaming');
            }
            textBuf += ev.text;
            sse.broadcast('delta', { contactId: convoId, messageId: textRow.id, text: ev.text });
            break;

          case 'thinking':
            markEvent();
            if (!thinkingRow) {
              thinkingRow = this.insertMessage({
                role: 'assistant',
                kind: 'thinking',
                content: '',
                status: 'streaming',
                turnId,
              });
              sse.broadcast('message', thinkingRow);
            }
            thinkingBuf += ev.text;
            sse.broadcast('delta', { contactId: convoId, messageId: thinkingRow.id, text: ev.text });
            break;

          case 'tool_use': {
            markEvent();
            const row = this.insertMessage({
              role: 'assistant',
              kind: 'tool_use',
              content: ev.name,
              status: 'done',
              turnId,
              meta: { name: ev.name, input: ev.inputSummary },
            });
            sse.broadcast('message', row);
            this.setState(`tool:${ev.name}`);
            break;
          }

          case 'tool_result':
            this.setState('thinking', `${ev.name}: ${ev.ok ? 'ok' : 'denied/failed'}`);
            break;

          case 'done': {
            if (thinkingRow) {
              sse.broadcast('message', this.updateMessage(thinkingRow.id, thinkingBuf, 'done'));
            }
            const finalText = stableFinalText(textBuf, ev.finalText);
            const passed = this.isRoom && PASS_RE.test(finalText.trim());

            if (passed) {
              // 成员选择沉默：内部气泡无审计价值 → 物理删除 + prune（不走 soft-delete）
              const retractIds = [textRow?.id, thinkingRow?.id].filter(
                (id): id is number => typeof id === 'number'
              );
              if (retractIds.length > 0) {
                hardDeleteMessages(this.deps.db, this.deps.config.uploadsDir, retractIds);
                sse.broadcast('prune', { contactId: convoId, ids: retractIds });
              }
              this.log('passed (silent, hard-deleted bubbles)');
            } else if (textRow) {
              sse.broadcast(
                'message',
                this.updateMessage(textRow.id, finalText, 'done', { usage: ev.usage })
              );
            } else if (finalText) {
              const row = this.insertMessage({
                role: 'assistant',
                kind: 'text',
                content: finalText,
                status: 'done',
                turnId,
                meta: { usage: ev.usage },
              });
              sse.broadcast('message', row);
            }
            if (item.kind === 'room-turn' && delivery) {
              setLastSeen(this.deps.db, convoId, this.agent.id, delivery.upToId);
            }
            this.crashes = [];
            this.setState('idle');
            if (!this.isRoom || item.kind === 'room-turn') {
              const u = ev.usage;
              this.sessionInputTokens +=
                (u?.input ?? 0) + (u?.cacheCreation ?? 0) + (u?.cacheRead ?? 0);
              const cfg = JSON.parse(this.agent.config || '{}');
              const threshold = Math.max(Number(cfg.maxSessionInputTokens ?? 120000), 0);
              if (this.agent.backend !== 'api' && threshold > 0 && this.sessionInputTokens >= threshold) {
                this.rolloverAfterTurn = true;
                this.log(`session token threshold reached (${this.sessionInputTokens}/${threshold}) — rolling over`);
              }
            }
            // 自动捕捉只在 DM 里跑：群消息由派发层按“用户原话、群级一次”捕捉，
            // 成员发言（带名字前缀的 transcript）永不参与——防记忆污染
            if (!this.isRoom && this.deps.vault && mem.capture) {
              void maybeCapture(
                this.deps.vault,
                { id: this.agent.id, name: this.agent.name },
                sourceText,
                finalText,
                (m) => this.log(m)
              ).catch(() => {});
            }
            logTiming(passed ? 'silent' : 'spoke', sourceText.length, finalText.length);
            settle(passed ? 'silent' : 'spoke');
            break;
          }

          case 'error': {
            markEvent();
            if (thinkingRow) {
              sse.broadcast('message', this.updateMessage(thinkingRow.id, thinkingBuf, 'interrupted'));
            }
            if (textRow) {
              sse.broadcast('message', this.updateMessage(textRow.id, textBuf, 'interrupted'));
            }
            const row = this.insertMessage({
              role: 'system',
              kind: 'error',
              content: this.isRoom ? `${this.agent.name}：${ev.message}` : ev.message,
              status: 'done',
              turnId,
            });
            sse.broadcast('message', row);
            if (ev.fatal) {
              this.recordCrash();
              this.backend = null;
            }
            this.setState('error', ev.message);
            logTiming('error', sourceText.length, textBuf.length);
            settle('error');
            break;
          }
        }
      }
    } finally {
      this.currentHandle = null;
      settle('error'); // 流意外结束的兜底
      if (this.rolloverAfterTurn) {
        this.rolloverAfterTurn = false;
        this.sessionInputTokens = 0;
        deactivateSession(this.deps.db, this.convo.id, this.isRoom ? this.memberId : undefined);
        await this.backend?.stop();
        this.backend = null;
        this.seenMemoryPaths.clear();
      }
      if (this.state === 'streaming' || this.state === 'thinking' || this.state.startsWith('tool:')) {
        this.setState('idle');
      }
      if (!timingLogged) logTiming('error');
    }
  }
}

export class AgentManager {
  private runtimes = new Map<string, AgentRuntime>();

  constructor(private deps: Deps) {}

  /** DM runtime。 */
  get(contact: ContactRow): AgentRuntime {
    let rt = this.runtimes.get(contact.id);
    if (!rt) {
      rt = new AgentRuntime(contact, contact, this.deps);
      this.runtimes.set(contact.id, rt);
    }
    return rt;
  }

  /** 群成员 runtime。 */
  getRoomMember(room: ContactRow, member: ContactRow): AgentRuntime {
    const key = `${room.id}:${member.id}`;
    let rt = this.runtimes.get(key);
    if (!rt) {
      rt = new AgentRuntime(room, member, this.deps);
      this.runtimes.set(key, rt);
    }
    return rt;
  }

  private roomMembers(room: ContactRow): ContactRow[] {
    const cfg = JSON.parse(room.config || '{}');
    const ids: string[] = Array.isArray(cfg.members) ? cfg.members : [];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.deps.db
      .prepare(
        `SELECT * FROM contacts WHERE id IN (${placeholders}) AND enabled = 1 AND kind = 'dm'`
      )
      .all(...ids) as ContactRow[];
  }

  /** 点名解析：@名字/@id/@all；模型消息里的 @ 一律不算（只处理 user 消息）。 */
  parseTargets(room: ContactRow, content: string): ContactRow[] {
    const members = this.roomMembers(room);
    if (members.length === 0) return [];
    const cfg = JSON.parse(room.config || '{}');
    const mentions = [...content.matchAll(/@([^\s@，。！？、,!?：:；;]+)/g)].map((m) =>
      m[1].toLowerCase()
    );
    if (mentions.length === 0) return cfg.respondAllByDefault === true ? members : [];
    if (mentions.some((m) => m === 'all' || m === '所有人' || m === '大家')) return members;
    const hit = members.filter(
      (c) => mentions.includes(c.id.toLowerCase()) || mentions.includes(c.name.toLowerCase())
    );
    return hit;
  }

  private roomChains = new Map<string, Promise<void>>();
  private invalidationBatches = new Map<
    string,
    {
      timer: NodeJS.Timeout;
      contact: ContactRow;
      waiters: Array<() => void>;
      /** 批次内最小受影响 message id；0 = 整份摘要作废 */
      affectedFromId: number;
    }
  >();

  /** 用户在群里发言 → 顺序点名轮 + 接话轮（输出不互相触发，轮数硬上限）。
   *  记忆捕捉在这里做且只做一次：只看用户原话，成员发言永不参与。 */
  imageRoomMembers(room: ContactRow): ContactRow[] {
    return this.roomMembers(room);
  }

  dispatchRoomMessage(room: ContactRow, content: string, targetOverride?: ContactRow[]): string[] {
    const targets = targetOverride ?? this.parseTargets(room, content);

    const roomCfg = JSON.parse(room.config || '{}');
    const mem: MemoryConfig = { ...this.deps.config.memory, ...(roomCfg.memory ?? {}) };
    if (this.deps.vault && mem.capture) {
      void maybeCapture(
        this.deps.vault,
        { id: room.id, name: room.name },
        content,
        '',
        (m) => console.log(`  [${room.name}] ${m}`)
      ).catch(() => {});
    }
    if (targets.length === 0) return [];

    // 同一个群的轮次串行：用户连发消息时排队，不交叉
    const prev = this.roomChains.get(room.id) ?? Promise.resolve();
    this.roomChains.set(
      room.id,
      prev
        .then(() => this.runRoomRound(room, targets))
        .catch((e) => console.error(`  [${room.name}] round error:`, e))
    );
    return targets.map((t) => t.id);
  }

  private shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** 一轮群聊：点名成员按随机顺序依次发言（后发言者看得见先发言者），
   *  多人点名时再跑至多 reactionRounds 轮接话；单人点名只让被点名者回答。 */
  private async runRoomRound(room: ContactRow, targets: ContactRow[]): Promise<void> {
    for (const member of this.shuffle(targets)) {
      await this.getRoomMember(room, member).runRoomTurn('normal');
    }

    if (targets.length <= 1) return;

    const roomCfg = JSON.parse(room.config || '{}');
    const maxReactionRounds = Math.min(Math.max(Number(roomCfg.reactionRounds ?? 1), 0), 3);
    const everyone = this.roomMembers(room);

    for (let round = 0; round < maxReactionRounds; round++) {
      let anySpoke = false;
      for (const member of this.shuffle(everyone)) {
        const outcome = await this.getRoomMember(room, member).runRoomTurn('reaction');
        if (outcome === 'spoke') anySpoke = true;
      }
      if (!anySpoke) break; // 全员沉默，话题自然结束
    }
  }

  /** 会话状态聚合（列表小圆点用）：DM 直取；群取最忙成员。 */
  stateOf(contactId: string): string {
    return this.statusOf(contactId).state;
  }

  /**
   * Full status for a contact/room, including which room member is busy.
   * Clients must use `member` for room typing labels — never the room title.
   */
  statusOf(contactId: string): { state: string; member?: string } {
    const dm = this.runtimes.get(contactId);
    if (dm) return { state: dm.state };

    let best: { state: string; member?: string; rank: number } = { state: 'idle', rank: 0 };
    const rankOf = (state: string): number => {
      if (state === 'streaming' || state.startsWith('tool:')) return 3;
      if (state === 'thinking') return 2;
      if (state === 'error') return 1;
      return 0;
    };
    for (const [key, rt] of this.runtimes) {
      if (!key.startsWith(`${contactId}:`)) continue;
      const rank = rankOf(rt.state);
      if (rank > best.rank) {
        best = { state: rt.state, member: rt.agentName, rank };
      }
    }
    return best.rank > 0
      ? { state: best.state, member: best.member }
      : { state: 'idle' };
  }

  /**
   * Snapshot of non-idle runtimes for SSE reconnect. Room rows include member name
   * so a mid-turn resync does not fall back to the room title.
   */
  activeStatuses(): Array<{ contactId: string; state: string; member?: string }> {
    const roomIds = new Set<string>();
    const out: Array<{ contactId: string; state: string; member?: string }> = [];
    for (const [key, rt] of this.runtimes) {
      if (rt.state === 'idle') continue;
      const sep = key.indexOf(':');
      if (sep > 0) {
        roomIds.add(key.slice(0, sep));
      } else {
        out.push({ contactId: key, state: rt.state });
      }
    }
    for (const roomId of roomIds) {
      const s = this.statusOf(roomId);
      if (s.state !== 'idle') out.push({ contactId: roomId, state: s.state, member: s.member });
    }
    return out;
  }

  private runtimesOfRoom(roomId: string): AgentRuntime[] {
    return [...this.runtimes.entries()]
      .filter(([key]) => key.startsWith(`${roomId}:`))
      .map(([, rt]) => rt);
  }

  interruptAll(contact: ContactRow): void {
    if (contact.kind === 'room') {
      for (const rt of this.runtimesOfRoom(contact.id)) rt.interrupt();
    } else {
      this.runtimes.get(contact.id)?.interrupt();
    }
  }

  /** A model switch must not cut through an in-flight DM or room-member turn. */
  isAgentBusy(contactId: string): boolean {
    for (const [key, rt] of this.runtimes) {
      if (key !== contactId && !key.endsWith(`:${contactId}`)) continue;
      if (rt.state === 'thinking' || rt.state === 'streaming' || rt.state.startsWith('tool:')) {
        return true;
      }
    }
    return false;
  }

  /** Apply a new model without ever resuming a thread created by the old model. */
  async switchContactModel(contact: ContactRow): Promise<void> {
    const dm = this.runtimes.get(contact.id);
    if (dm) await dm.invalidateCliContext();
    else deactivateSession(this.deps.db, contact.id, '');

    for (const [key, rt] of this.runtimes) {
      if (key.endsWith(`:${contact.id}`)) await rt.invalidateCliContext();
    }
    // Also cover rooms that have not created an in-memory runtime since gateway boot.
    this.deps.db
      .prepare('UPDATE sessions SET active = 0 WHERE member_id = ? AND active = 1')
      .run(contact.id);
    await this.notifyContactUpdated(contact);
  }

  async resetConversation(contact: ContactRow): Promise<void> {
    if (contact.kind === 'room') {
      for (const rt of this.runtimesOfRoom(contact.id)) await rt.reset();
      deactivateSession(this.deps.db, contact.id); // 兜底：包括没有 runtime 的成员
    } else {
      await this.get(contact).reset();
    }
  }

  /**
   * 删除/批量变更后的上下文处理：DM 单 runtime；群里全体成员。
   * 300ms 合并窗口内取最小 affectedFromId（更早的变更覆盖更广）。
   */
  invalidateConversation(contact: ContactRow, affectedFromId = 0): Promise<void> {
    return new Promise((resolve) => {
      const existing = this.invalidationBatches.get(contact.id);
      if (existing) clearTimeout(existing.timer);
      const waiters = existing?.waiters ?? [];
      waiters.push(resolve);
      const mergedFrom =
        existing && existing.affectedFromId > 0 && affectedFromId > 0
          ? Math.min(existing.affectedFromId, affectedFromId)
          : existing?.affectedFromId === 0 || affectedFromId === 0
            ? 0
            : affectedFromId || existing?.affectedFromId || 0;
      const timer = setTimeout(() => {
        const batch = this.invalidationBatches.get(contact.id);
        this.invalidationBatches.delete(contact.id);
        const fromId = batch?.affectedFromId ?? mergedFrom;
        void (async () => {
          try {
            if (contact.kind === 'room') {
              for (const member of this.roomMembers(contact)) {
                await this.getRoomMember(contact, member).invalidateCliContext(fromId);
              }
            } else {
              await this.get(contact).invalidateCliContext(fromId);
            }
          } finally {
            for (const done of batch?.waiters ?? waiters) done();
          }
        })();
      }, 300);
      this.invalidationBatches.set(contact.id, {
        timer,
        contact,
        waiters,
        affectedFromId: mergedFrom,
      });
    });
  }

  async notifyContactUpdated(contact: ContactRow): Promise<void> {
    if (contact.kind === 'room') {
      for (const rt of this.runtimesOfRoom(contact.id)) rt.updateConvo(contact);
      return;
    }
    const rt = this.runtimes.get(contact.id);
    if (rt) await rt.updateAgent(contact);
    // 该联系人作为群成员的 runtime 也要换新配置
    for (const [key, roomRt] of this.runtimes) {
      if (key.endsWith(`:${contact.id}`)) await roomRt.updateAgent(contact);
    }
  }

  async remove(contactId: string): Promise<void> {
    for (const [key, rt] of [...this.runtimes]) {
      if (key === contactId || key.startsWith(`${contactId}:`) || key.endsWith(`:${contactId}`)) {
        await rt.stop();
        this.runtimes.delete(key);
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((rt) => rt.stop()));
  }
}
