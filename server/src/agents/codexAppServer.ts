import { JsonlProcess } from './jsonlProcess.js';
import {
  AsyncQueue,
  type AgentBackend,
  type TurnEvent,
  type TurnHandle,
  type TurnInput,
} from './types.js';
import type { TokenUsage } from './types.js';

export interface CodexAppServerBackendOpts {
  cliPath: string;
  cwd: string;
  model?: string;
  effort?: string;
  developerInstructions?: string;
  mcpServers?: CodexMcpServerConfig[];
  sandbox?: 'read-only' | 'workspace-write';
  turnTimeoutMs: number;
  log: (msg: string) => void;
}

export interface CodexMcpServerConfig {
  name: string;
  url: string;
  bearerTokenEnvVar?: string;
  enabledTools?: string[];
  required?: boolean;
  defaultToolsApprovalMode?: 'auto' | 'prompt' | 'writes' | 'approve';
}

/** Build per-process config overrides so one contact never leaks MCP authority to another. */
export function codexAppServerArgs(servers: CodexMcpServerConfig[] = []): string[] {
  const args = ['app-server', '--stdio'];
  for (const server of servers) {
    if (!/^[A-Za-z0-9_-]+$/.test(server.name)) {
      throw new Error(`invalid Codex MCP server name: ${server.name}`);
    }
    const key = `mcp_servers.${server.name}`;
    args.push('--config', `${key}.url=${JSON.stringify(server.url)}`);
    args.push('--config', `${key}.enabled=true`);
    args.push('--config', `${key}.required=${server.required === true}`);
    if (server.bearerTokenEnvVar) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(server.bearerTokenEnvVar)) {
        throw new Error(`invalid Codex MCP bearer token env var: ${server.bearerTokenEnvVar}`);
      }
      args.push(
        '--config',
        `${key}.bearer_token_env_var=${JSON.stringify(server.bearerTokenEnvVar)}`
      );
    }
    if (server.enabledTools?.length) {
      args.push('--config', `${key}.enabled_tools=${JSON.stringify(server.enabledTools)}`);
    }
    if (server.defaultToolsApprovalMode) {
      args.push(
        '--config',
        `${key}.default_tools_approval_mode=${JSON.stringify(server.defaultToolsApprovalMode)}`
      );
    }
  }
  return args;
}

export interface CodexModelOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: CodexReasoningEffortOption[];
  defaultReasoningEffort?: string;
}

export interface CodexReasoningEffortOption {
  id: string;
  label: string;
  description?: string;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimits {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
}

export function codexTurnInput(text: string, imagePaths: string[] = []): Record<string, unknown>[] {
  return [
    { type: 'text', text },
    ...imagePaths.map((path) => ({ type: 'localImage', path })),
  ];
}

export type CodexErrorCategory =
  | 'capacity'
  | 'rate_limit'
  | 'quota'
  | 'model_unavailable'
  | 'auth'
  | 'server'
  | 'unknown';

export interface CodexErrorInfo {
  category: CodexErrorCategory;
  title: string;
  detail: string;
  rawSnippet: string;
}

function compactCodexError(value: unknown): string {
  try {
    return (typeof value === 'string' ? value : JSON.stringify(value)).replace(/\s+/g, ' ').trim().slice(0, 500);
  } catch {
    return '';
  }
}

export function classifyCodexAppServerError(error: unknown): CodexErrorInfo {
  const rawSnippet = compactCodexError(error);
  const detail = typeof (error as any)?.message === 'string'
    ? (error as any).message
    : rawSnippet || 'Codex app-server returned an error';
  const haystack = rawSnippet.toLowerCase();
  let category: CodexErrorCategory = 'unknown';
  let title = 'Codex 上游错误';

  if (haystack.includes('capacity') || haystack.includes('overloaded')) {
    category = 'capacity';
    title = 'Codex 模型容量不足';
  } else if (haystack.includes('quota') || haystack.includes('billing')) {
    category = 'quota';
    title = 'Codex 额度不足';
  } else if (haystack.includes('rate limit') || haystack.includes('rate_limit') || haystack.includes('429')) {
    category = 'rate_limit';
    title = 'Codex 上游限流';
  } else if (
    haystack.includes('model_not_found') ||
    haystack.includes('model not found') ||
    haystack.includes('selected model') ||
    haystack.includes('not available') ||
    haystack.includes('unsupported model')
  ) {
    category = 'model_unavailable';
    title = 'Codex 模型不可用';
  } else if (haystack.includes('unauthorized') || haystack.includes('forbidden') || haystack.includes('401') || haystack.includes('403')) {
    category = 'auth';
    title = 'Codex 鉴权失败';
  } else if (haystack.includes('500') || haystack.includes('502') || haystack.includes('503') || haystack.includes('504')) {
    category = 'server';
    title = 'Codex 服务错误';
  }

  return { category, title, detail, rawSnippet };
}

function formatCodexAppServerError(error: unknown): string {
  const info = classifyCodexAppServerError(error);
  const raw = info.rawSnippet && info.rawSnippet !== info.detail
    ? `；原始错误：${info.rawSnippet}`
    : '';
  return `${info.title}：${info.detail}${raw}`;
}
interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Drives `codex app-server` over its newline-delimited JSON-RPC v2 protocol. */
export class CodexAppServerBackend implements AgentBackend {
  readonly kind = 'codex' as const;

  private proc: JsonlProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private threadId: string | null = null;
  private threadAnnounced = false;
  private turnId: string | null = null;
  private turn: AsyncQueue<TurnEvent> | null = null;
  private turnTimer: NodeJS.Timeout | null = null;
  private accText = '';
  private stderrTail: string[] = [];
  private toolNames = new Map<string, string>();
  private lastTokenUsage: TokenUsage | undefined;

  constructor(private opts: CodexAppServerBackendOpts) {}

  /** Query the account-aware picker catalog without creating a conversation thread. */
  static async listModels(opts: {
    cliPath: string;
    cwd: string;
    log: (msg: string) => void;
  }): Promise<CodexModelOption[]> {
    const client = new CodexAppServerBackend({
      ...opts,
      sandbox: 'read-only',
      turnTimeoutMs: 20_000,
    });
    try {
      client.spawn();
      await client.request('initialize', {
        clientInfo: { name: 'ai_hub', title: 'ai-hub', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      client.proc?.send({ method: 'initialized', params: {} });

      const models: CodexModelOption[] = [];
      let cursor: string | null = null;
      do {
        const result = await client.request('model/list', {
          cursor,
          limit: 100,
          // Hidden GPT entries can still be explicitly selected (for example
          // GPT-5.4); internal codex-* helpers are not conversation models.
          includeHidden: true,
        });
        for (const model of result?.data ?? []) {
          const id = String(model.model ?? model.id ?? '').trim();
          if (!id || id.startsWith('codex-') || models.some((m) => m.id === id)) continue;
          models.push({
            id,
            label: String(model.displayName ?? id),
            description: typeof model.description === 'string' ? model.description : undefined,
            isDefault: model.isDefault === true,
            supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts
                .map((option: any) => {
                  const effort = String(option?.reasoningEffort ?? '').trim();
                  if (!effort) return null;
                  return {
                    id: effort,
                    label: effort,
                    description: typeof option.description === 'string' ? option.description : undefined,
                  };
                })
                .filter((option: CodexReasoningEffortOption | null): option is CodexReasoningEffortOption => option !== null)
              : [],
            defaultReasoningEffort: typeof model.defaultReasoningEffort === 'string'
              ? model.defaultReasoningEffort
              : undefined,
          });
        }
        cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : null;
      } while (cursor && models.length < 500);
      return models;
    } finally {
      await client.stop();
    }
  }

  /** Read account subscription windows using the version-matched app-server protocol. */
  static async readRateLimits(opts: {
    cliPath: string;
    cwd: string;
    log: (msg: string) => void;
  }): Promise<CodexRateLimits> {
    const client = new CodexAppServerBackend({
      ...opts,
      sandbox: 'read-only',
      turnTimeoutMs: 20_000,
    });
    try {
      client.spawn();
      await client.request('initialize', {
        clientInfo: { name: 'ai_hub', title: 'ai-hub', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      client.proc?.send({ method: 'initialized', params: {} });
      const result = await client.request('account/rateLimits/read', undefined);
      const snapshot = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
      return {
        primary: snapshot?.primary ?? null,
        secondary: snapshot?.secondary ?? null,
      };
    } finally {
      await client.stop();
    }
  }

  async start(resumeToken: string | null): Promise<void> {
    this.spawn();
    await this.request('initialize', {
      clientInfo: { name: 'ai_hub', title: 'ai-hub', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.proc?.send({ method: 'initialized', params: {} });

    if (resumeToken) {
      try {
        const resumed = await this.request('thread/resume', this.threadParams({ threadId: resumeToken }));
        this.captureThread(resumed?.thread?.id ?? resumeToken);
        return;
      } catch (e: any) {
        this.opts.log(`resume ${resumeToken.slice(0, 8)}… failed: ${e.message}; starting fresh`);
      }
    }

    const started = await this.request('thread/start', this.threadParams({}));
    const id = started?.thread?.id;
    if (!id) throw new Error('codex thread/start returned no thread id');
    this.captureThread(id);
  }

  private threadParams(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      ...extra,
      cwd: this.opts.cwd,
      approvalPolicy: 'never',
      sandbox: this.opts.sandbox ?? 'read-only',
      personality: 'friendly',
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.developerInstructions
        ? { developerInstructions: this.opts.developerInstructions }
        : {}),
    };
  }

  private spawn(): void {
    const proc = new JsonlProcess({
      command: this.opts.cliPath,
      args: codexAppServerArgs(this.opts.mcpServers),
      cwd: this.opts.cwd,
      env: { ...process.env },
    });
    this.proc = proc;
    proc.on('line', (line: any) => this.route(line));
    proc.on('stderr', (s: string) => {
      this.stderrTail.push(s);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    proc.on('exit', ({ code, signal }: { code: number | null; signal: string | null }) => {
      const err = new Error(`codex app-server exited code=${code} signal=${signal}${this.stderrSnippet(' — ')}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
      if (this.turn) {
        this.turn.push({ type: 'error', message: err.message, fatal: true });
        this.finishTurn();
      }
    });
    proc.start();
  }

  alive(): boolean {
    return this.proc?.alive() ?? false;
  }

  async stop(): Promise<void> {
    this.finishTurn();
    await this.proc?.stop();
  }

  sendTurn(input: TurnInput): TurnHandle {
    const queue = new AsyncQueue<TurnEvent>();
    this.turn = queue;
    this.turnId = null;
    this.accText = '';
    this.lastTokenUsage = undefined;
    this.toolNames.clear();

    if (this.threadId && !this.threadAnnounced) {
      this.threadAnnounced = true;
      queue.push({ type: 'session', sessionId: this.threadId });
    }

    void this.beginTurn(input.text, input.imagePaths).catch((e: any) => {
      queue.push({ type: 'error', message: `Codex 发送失败：${e.message}`, fatal: false });
      this.finishTurn();
    });

    return { events: queue, interrupt: () => this.interrupt() };
  }

  private async beginTurn(text: string, imagePaths: string[] = []): Promise<void> {
    if (!this.threadId) throw new Error('Codex thread is not ready');
    const result = await this.request('turn/start', {
      threadId: this.threadId,
      input: codexTurnInput(text, imagePaths),
      ...(this.opts.effort ? { effort: this.opts.effort } : {}),
    });
    this.turnId = result?.turn?.id ?? this.turnId;
    this.turnTimer = setTimeout(() => {
      this.opts.log('turn timeout, interrupting');
      void this.interrupt();
      this.turn?.push({ type: 'error', message: '这轮超时了，已打断', fatal: false });
      this.finishTurn();
    }, this.opts.turnTimeoutMs);
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.turnId) return;
    try {
      await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
    } catch (e: any) {
      this.opts.log(`interrupt failed: ${e.message}`);
    }
  }

  private request(method: string, params: unknown, timeoutMs = 20_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.proc?.send({ method, id, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('codex app-server is not online'));
      }
    });
  }

  private route(line: any): void {
    if (line && line.id !== undefined && !line.method) {
      const pending = this.pending.get(Number(line.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(line.id));
      if (line.error) {
        this.opts.log(`json-rpc ${line.id} error: ${compactCodexError(line.error)}`);
        pending.reject(new Error(formatCodexAppServerError(line.error)));
      }
      else pending.resolve(line.result);
      return;
    }
    if (line?.method && line.id !== undefined) {
      this.handleServerRequest(line);
      return;
    }
    if (line?.method) this.handleNotification(line.method, line.params ?? {});
  }

  private handleServerRequest(line: any): void {
    const method = String(line.method);
    if (method === 'mcpServer/elicitation/request') {
      const trusted = line.params?.serverName === 'memory_vault';
      this.opts.log(`${trusted ? 'accepting' : 'declining'} MCP elicitation: ${line.params?.serverName ?? 'unknown'}`);
      this.proc?.send({
        id: line.id,
        result: { action: trusted ? 'accept' : 'decline', content: trusted ? {} : null, _meta: null },
      });
      return;
    }
    this.opts.log(`declining server request: ${method}`);
    if (method.includes('requestApproval') || method === 'execCommandApproval' || method === 'applyPatchApproval') {
      this.proc?.send({ id: line.id, result: { decision: 'decline' } });
    } else {
      this.proc?.send({ id: line.id, error: { code: -32601, message: `ai-hub does not support ${method}` } });
    }
  }

  private handleNotification(method: string, params: any): void {
    if (method === 'thread/started' && params?.thread?.id) {
      this.captureThread(params.thread.id);
      return;
    }
    if (method === 'thread/tokenUsage/updated' && params?.tokenUsage?.last) {
      if (!this.threadId || !params.threadId || params.threadId === this.threadId) {
        const last = params.tokenUsage.last;
        const cached = Number(last.cachedInputTokens ?? 0);
        this.lastTokenUsage = {
          input: Math.max(Number(last.inputTokens ?? 0) - cached, 0),
          cacheRead: cached,
          output: Number(last.outputTokens ?? 0),
        };
      }
      return;
    }
    if (!this.turn) return;

    switch (method) {
      case 'turn/started':
        this.turnId = params?.turn?.id ?? this.turnId;
        return;
      case 'item/agentMessage/delta':
        if (params?.delta) {
          this.accText += params.delta;
          this.turn.push({ type: 'delta', text: params.delta });
        }
        return;
      case 'item/reasoning/summaryTextDelta':
        if (params?.delta) this.turn.push({ type: 'thinking', text: params.delta });
        return;
      case 'item/started':
        this.handleItemStarted(params?.item);
        return;
      case 'item/completed':
        this.handleItemCompleted(params?.item);
        return;
      case 'turn/completed':
        this.handleTurnCompleted(params?.turn);
        return;
    }
  }

  private handleItemStarted(item: any): void {
    if (!item?.id) return;
    if (item.type === 'mcpToolCall') {
      const name = `${item.server ?? 'mcp'}:${item.tool ?? 'tool'}`;
      this.toolNames.set(item.id, name);
      this.turn?.push({
        type: 'tool_use',
        name,
        inputSummary: this.summarize(item.arguments),
      });
    } else if (item.type === 'commandExecution' || item.type === 'fileChange') {
      const name = item.type === 'commandExecution' ? 'shell (read-only)' : 'file change';
      this.toolNames.set(item.id, name);
      this.turn?.push({ type: 'tool_use', name, inputSummary: this.summarize(item.command ?? item.changes) });
    }
  }

  private handleItemCompleted(item: any): void {
    if (!item?.id) return;
    if (item.type === 'agentMessage' && item.text && !this.accText) {
      this.accText = item.text;
      this.turn?.push({ type: 'delta', text: item.text });
      return;
    }
    const name = this.toolNames.get(item.id);
    if (!name) return;
    const failed = ['failed', 'declined'].includes(String(item.status));
    this.turn?.push({
      type: 'tool_result',
      name,
      ok: !failed && !item.error,
      summary: this.summarize(item.error ?? item.result ?? item.aggregatedOutput ?? item.status),
    });
  }

  private handleTurnCompleted(turn: any): void {
    if (!this.turn || (this.turnId && turn?.id && turn.id !== this.turnId)) return;
    const status = typeof turn?.status === 'string' ? turn.status : turn?.status?.type;
    if (status === 'completed') {
      this.turn.push({ type: 'done', finalText: this.accText, usage: this.lastTokenUsage });
    } else {
      this.turn.push({
        type: 'error',
        message: turn?.error?.message ?? `Codex turn ended with status ${status ?? 'unknown'}`,
        fatal: false,
      });
    }
    this.finishTurn();
  }

  private captureThread(id: string): void {
    if (id === this.threadId) return;
    this.threadId = id;
    if (this.turn) {
      this.threadAnnounced = true;
      this.turn.push({ type: 'session', sessionId: id });
    } else {
      this.threadAnnounced = false;
    }
  }

  private finishTurn(): void {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.turnId = null;
    this.turn?.end();
    this.turn = null;
  }

  private summarize(value: unknown): string {
    if (value == null) return '';
    try {
      return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 200);
    } catch {
      return '';
    }
  }

  private stderrSnippet(prefix = ''): string {
    const tail = this.stderrTail.join('').trim().slice(-400);
    return tail ? `${prefix}${tail}` : '';
  }
}
