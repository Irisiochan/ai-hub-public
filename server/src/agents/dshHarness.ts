import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncQueue, type AgentBackend, type TurnEvent, type TurnHandle, type TurnInput } from './types.js';

interface HarnessConfig {
  command: string;
  home: string;
  workspace: string;
  port: number;
  model: string;
  apiKey: string;
  baseUrl: string;
  systemPrompt?: string;
  turnTimeoutMs: number;
  log: (message: string) => void;
}

interface RpcErrorBody { code?: string; message?: string }
interface HistoryEvent { event: { type: string; seq: number; data: unknown } }

const APPROVAL_PATCH = `# Managed by AI Hub for the isolated Jingwan harness.\n- id: approval\n  config:\n    policy: never\n\n- id: permission\n  config:\n    presets:\n      autonomous-workspace:\n        sandbox: workspace-write\n        approval: never\n        name: autonomous-workspace\n        description: Autonomous work inside the configured workspace only.\n      workspace-write:\n        sandbox: workspace-write\n        approval: ask\n        name: workspace-write\n        description: Workspace writes require approval.\n      danger-full-access:\n        sandbox: danger-full-access\n        approval: never\n        name: danger-full-access\n        description: Full file access without approval prompts.\n    defaultPreset: autonomous-workspace\n`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeDeepSeekBaseUrl(value: string): string {
  return value.replace(/\/chat\/completions\/?$/i, '').replace(/\/$/, '');
}

function ensureInside(home: string, workspace: string): void {
  const relative = path.relative(home, workspace);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('DSH workspace 必须是 harness home 下的独立子目录');
  }
}

function assistantText(events: HistoryEvent[], afterSeq: number): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const current = events[index]?.event;
    if (!current || current.seq <= afterSeq || current.type !== 'assistant/message' || !isRecord(current.data)) continue;
    const message = current.data.message;
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    return message.content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'text')
      .map((block) => typeof block.text === 'string' ? block.text : '')
      .join('');
  }
  return '';
}

/** Persistent DeepSeek Harness bridge for one AI Hub runtime. */
export class DshHarnessBackend implements AgentBackend {
  readonly kind = 'api' as const;
  private child: ChildProcess | null = null;
  private sessionId: string | null = null;
  private running = false;
  private stopped = false;
  private pendingSessionEvent = false;
  private activeAbort: AbortController | null = null;

  constructor(private readonly cfg: HarnessConfig) {
    ensureInside(path.resolve(cfg.home), path.resolve(cfg.workspace));
  }

  async start(resumeToken: string | null): Promise<void> {
    if (this.stopped) throw new Error('DSH backend 已停止');
    this.prepareHome();
    await this.ensureService();
    if (resumeToken && await this.sessionExists(resumeToken)) {
      this.sessionId = resumeToken;
      this.cfg.log(`dsh resumed session=${resumeToken}`);
      return;
    }
    this.sessionId = `aihub-${randomUUID().replaceAll('-', '')}`;
    await this.rpc('session.create', {
      sessionId: this.sessionId,
      cwd: path.resolve(this.cfg.workspace),
      agentPreset: 'standard',
    });
    await this.rpc('session.selectModel', {
      sessionId: this.sessionId,
      provider: 'deepseek-official',
      model: this.cfg.model,
    });
    this.pendingSessionEvent = true;
    this.cfg.log(`dsh created session=${this.sessionId}`);
  }

  sendTurn(input: TurnInput): TurnHandle {
    const queue = new AsyncQueue<TurnEvent>();
    const abort = new AbortController();
    this.activeAbort = abort;
    this.running = true;
    void this.runTurn(input, queue, abort.signal).finally(() => {
      if (this.activeAbort === abort) this.activeAbort = null;
      this.running = false;
      queue.end();
    });
    return {
      events: queue,
      interrupt: async () => {
        abort.abort();
        if (this.sessionId) {
          await this.rpc('session.cancel', { sessionId: this.sessionId }).catch(() => {});
        }
      },
    };
  }

  alive(): boolean {
    return !this.stopped && (this.child === null || this.child.exitCode === null);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.activeAbort?.abort();
    if (this.sessionId && this.running) {
      await this.rpc('session.cancel', { sessionId: this.sessionId }).catch(() => {});
    }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }

  private async runTurn(input: TurnInput, queue: AsyncQueue<TurnEvent>, signal: AbortSignal): Promise<void> {
    try {
      if (!this.sessionId) throw new Error('DSH session 尚未启动');
      if (this.pendingSessionEvent) {
        queue.push({ type: 'session', sessionId: this.sessionId });
        this.pendingSessionEvent = false;
      }
      const before = await this.history();
      const baseline = before.reduce((max, item) => Math.max(max, item.event.seq), -1);
      await this.rpc('session.prompt', {
        sessionId: this.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: input.text }],
        clientTimeZone: 'Asia/Shanghai',
      }, signal);

      const deadline = Date.now() + this.cfg.turnTimeoutMs;
      while (Date.now() < deadline) {
        if (signal.aborted) throw new Error('已中断');
        const [events, list] = await Promise.all([
          this.history(signal),
          this.rpc<{ items: Array<{ sessionId: string; running: boolean }> }>('session.list', {}, signal),
        ]);
        const item = list.items.find((candidate) => candidate.sessionId === this.sessionId);
        const ended = events.some(({ event }) => event.seq > baseline && event.type === 'turn/end');
        if (ended && item?.running === false) {
          const finalText = assistantText(events, baseline);
          if (!finalText) throw new Error('DSH 本轮结束但没有 assistant 文本');
          queue.push({ type: 'done', finalText });
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 300);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('已中断')); }, { once: true });
        });
      }
      await this.rpc('session.cancel', { sessionId: this.sessionId }).catch(() => {});
      throw new Error(`DSH 本轮超时（${this.cfg.turnTimeoutMs}ms）`);
    } catch (error: any) {
      queue.push({ type: 'error', message: error?.message ?? String(error), fatal: false });
    }
  }

  private prepareHome(): void {
    const home = path.resolve(this.cfg.home);
    const workspace = path.resolve(this.cfg.workspace);
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(home, 'cordis.patch.yml'), APPROVAL_PATCH, { encoding: 'utf8', mode: 0o600 });
    if (this.cfg.systemPrompt) {
      fs.writeFileSync(path.join(workspace, 'AGENTS.md'), `${this.cfg.systemPrompt.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
    }
  }

  private async ensureService(): Promise<void> {
    if (await this.isReady()) return;
    const env = {
      ...process.env,
      DSH_HOME: path.resolve(this.cfg.home),
      DSH_PERMISSION_MODE: 'workspace-write',
      DEEPSEEK_API_KEY: this.cfg.apiKey,
      DEEPSEEK_BASE_URL: normalizeDeepSeekBaseUrl(this.cfg.baseUrl),
    };
    const child = spawn(this.cfg.command, ['web', '--host', '127.0.0.1', '--port', String(this.cfg.port)], {
      cwd: path.resolve(this.cfg.workspace),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let tail = '';
    const collect = (chunk: Buffer): void => {
      tail = `${tail}${chunk.toString('utf8')}`.slice(-4000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`dsh web 提前退出 code=${child.exitCode}: ${tail}`);
      if (await this.isReady()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    child.kill('SIGTERM');
    throw new Error(`dsh web 启动超时: ${tail}`);
  }

  private async isReady(): Promise<boolean> {
    try {
      await this.rpc('session.list', {}, undefined, 1000);
      return true;
    } catch {
      return false;
    }
  }

  private async sessionExists(sessionId: string): Promise<boolean> {
    try {
      const list = await this.rpc<{ items: Array<{ sessionId: string }> }>('session.list', {});
      return list.items.some((item) => item.sessionId === sessionId);
    } catch {
      return false;
    }
  }

  private history(signal?: AbortSignal): Promise<HistoryEvent[]> {
    return this.rpc<{ events: HistoryEvent[] }>('session.history', {
      sessionId: this.sessionId,
      maxMessages: 100,
    }, signal).then((page) => page.events);
  }

  private async rpc<T = unknown>(method: string, payload: unknown, signal?: AbortSignal, timeoutMs = 10_000): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(`http://127.0.0.1:${this.cfg.port}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `aihub-${randomUUID()}`,
        method,
        payload,
      }),
      signal: combined,
    });
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${await response.text()}`);
    const body = await response.json() as { result?: { ok: boolean; value?: T; error?: RpcErrorBody } };
    if (!body.result?.ok) {
      const detail = body.result?.error;
      throw new Error(`${method}: ${detail?.code ?? 'RPC_ERROR'}: ${detail?.message ?? 'unknown error'}`);
    }
    return body.result.value as T;
  }
}
