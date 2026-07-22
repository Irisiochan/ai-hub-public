import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JsonlProcess } from './jsonlProcess.js';
import {
  AsyncQueue,
  type AgentBackend,
  type TokenUsage,
  type TurnEvent,
  type TurnHandle,
  type TurnInput,
} from './types.js';

export interface GrokCliBackendOpts {
  cliPath: string;
  cwd: string;
  model?: string;
  /** Narrow auto-approval rules, e.g. MCPTool(hub__*). */
  allowRules?: string[];
  /** Built-in tools to block entirely (comma-joined → --disallowed-tools).
   *  Chat-only contacts should deny search_replace + run_terminal_command
   *  so the model never triggers a headless confirmation wall. */
  disallowedTools?: string[];
  /** 人设 + 记忆前缀，经 `--rules` 追加进 system prompt（每轮进程都带，resume 也不丢人设）。 */
  preamble?: string;
  /** Per-process environment overrides for managed project integrations. */
  env?: Record<string, string>;
  turnTimeoutMs: number;
  log: (msg: string) => void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function imageMimeType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  throw new Error(`grok 不支持这个图片格式：${ext || '无扩展名'}`);
}

/**
 * Grok Build --prompt-json uses ACP content blocks for native multimodal input.
 * Use trusted local resource links instead of base64 argv: normal screenshots
 * easily exceed Windows' command-line limit and Linux MAX_ARG_STRLEN.
 */
export function grokPromptJson(text: string, imagePaths: string[]): string {
  return JSON.stringify({
    type: 'acp',
    content: [
      { type: 'text', text },
      ...imagePaths.map((file) => ({
        type: 'resource_link',
        uri: pathToFileURL(file).href,
        name: path.basename(file),
        mimeType: imageMimeType(file),
      })),
    ],
  });
}

/** usage 字段各家拼法不一，宽容取值；一个都没有就当没报。 */
export function grokPluckUsage(obj: unknown): TokenUsage | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, any>;
  const usage = o.usage ?? o.tokenUsage ?? o.token_usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const num = (...keys: string[]): number => {
    for (const k of keys) if (typeof usage[k] === 'number') return usage[k];
    return 0;
  };
  const input = num('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens');
  const output = num('output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens');
  if (input === 0 && output === 0) return undefined;
  return {
    input,
    output,
    cacheRead: num('cache_read_input_tokens', 'cachedTokens', 'cached_tokens') || undefined,
  };
}

/**
 * Drives the `grok` CLI (Grok Build) in headless mode: one short-lived
 * process per turn, session continuity on disk (~/.grok/sessions), so a
 * gateway or VPS restart never loses context.
 *
 * Session flags (verified against grok 0.2.102 — the docs' "create or
 * resume" claim for -s is wrong): `-s <uuid>` CREATES and errors with
 * "already in use" on reuse; `-r <uuid>` RESUMES and errors when unknown.
 * We track which flag the next turn needs and flip-and-retry once when
 * the CLI disagrees (crashed create, stale resume token, …).
 *
 * streaming-json lines (flat, NOT the ACP shapes of `grok agent stdio`):
 *   {"type":"thought","data":"…"}   thinking delta
 *   {"type":"text","data":"…"}      answer delta
 *   {"type":"end","stopReason":…,"sessionId":…,"usage":{…}}
 * Tool activity does not surface in this stream. Exit code stays the
 * authoritative turn boundary; unknown line types are ignored.
 */
export class GrokCliBackend implements AgentBackend {
  readonly kind = 'grok-cli' as const;

  private sessionId: string | null = null;
  private sessionAnnounced = false;
  private sessionFlag: '-s' | '-r' = '-s';
  private started = false;
  private proc: JsonlProcess | null = null;
  private turn: AsyncQueue<TurnEvent> | null = null;
  private turnTimer: NodeJS.Timeout | null = null;
  private interrupted = false;
  private retried = false;
  private turnText = '';
  private turnImagePaths: string[] = [];
  private accText = '';
  private sawEnd = false;
  private stopReason: string | null = null;
  private usage: TokenUsage | undefined;
  private stderrTail: string[] = [];

  constructor(private opts: GrokCliBackendOpts) {}

  // ── lifecycle ──────────────────────────────────────────

  /** No persistent process: start() just fixes the session id and flag.
   *  The CLI hard-requires a plain UUID, so anything else (e.g. legacy
   *  `hub-…` names) is discarded in favor of a fresh session. */
  async start(resumeToken: string | null): Promise<void> {
    if (resumeToken && !UUID_RE.test(resumeToken)) {
      this.opts.log(`resume token ${resumeToken} is not a UUID — starting fresh session`);
      resumeToken = null;
    }
    this.sessionId = resumeToken ?? crypto.randomUUID();
    this.sessionFlag = resumeToken ? '-r' : '-s';
    this.sessionAnnounced = false;
    this.started = true;
  }

  alive(): boolean {
    return this.started;
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.proc?.stop(2000);
  }

  private stderrSnippet(prefix = ''): string {
    const tail = this.stderrTail.join('').trim().slice(-300);
    return tail ? `${prefix}${tail}` : '';
  }

  // ── turns ──────────────────────────────────────────────

  sendTurn(input: TurnInput): TurnHandle {
    const queue = new AsyncQueue<TurnEvent>();
    this.turn = queue;
    this.retried = false;

    if (this.sessionId && !this.sessionAnnounced) {
      this.sessionAnnounced = true;
      queue.push({ type: 'session', sessionId: this.sessionId });
    }

    this.turnText = input.text;
    this.turnImagePaths = [...(input.imagePaths ?? [])];

    try {
      this.spawnAttempt();
    } catch (error) {
      queue.push({
        type: 'error',
        message: `grok 图片读取失败：${(error as Error).message}`,
        fatal: false,
      });
      this.finishTurn();
      return { events: queue, interrupt: () => this.interrupt() };
    }

    this.turnTimer = setTimeout(() => {
      this.opts.log('turn timeout, killing grok process');
      this.interrupted = true;
      void this.proc?.stop(0);
      this.turn?.push({ type: 'error', message: '这轮超时了，已打断', fatal: false });
      this.finishTurn();
    }, this.opts.turnTimeoutMs);

    return {
      events: queue,
      interrupt: () => this.interrupt(),
    };
  }

  private spawnAttempt(): void {
    this.accText = '';
    this.sawEnd = false;
    this.stopReason = null;
    this.usage = undefined;
    this.interrupted = false;
    this.stderrTail = [];

    const args = [this.sessionFlag, this.sessionId!];
    if (this.turnImagePaths.length > 0) {
      args.push('--prompt-json', grokPromptJson(this.turnText, this.turnImagePaths));
    } else {
      args.push('-p', this.turnText);
    }
    args.push('--output-format', 'streaming-json');
    if (this.opts.model) args.push('-m', this.opts.model);
    for (const rule of this.opts.allowRules ?? []) args.push('--allow', rule);
    const denied = this.opts.disallowedTools ?? [];
    if (denied.length) args.push('--disallowed-tools', denied.join(','));
    // 实测 headless 下 --rules 会进 system prompt；每轮都带，resume 轮人设/记忆不掉
    if (this.opts.preamble) args.push('--rules', this.opts.preamble);

    // dev fixture: a .mjs cliPath is a mock CLI run via node（对齐 claudeCli 的约定）
    const command = this.opts.cliPath.endsWith('.mjs') ? process.execPath : this.opts.cliPath;
    const finalArgs = this.opts.cliPath.endsWith('.mjs') ? [this.opts.cliPath, ...args] : args;

    const proc = new JsonlProcess({
      command,
      args: finalArgs,
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
    });
    this.proc = proc;

    proc.on('line', (line: any) => this.route(line));
    proc.on('stderr', (s: string) => {
      this.stderrTail.push(s);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    proc.on('exit', ({ code }: { code: number | null }) => this.handleExit(code));

    proc.start();
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    await this.proc?.stop(0);
  }

  private finishTurn(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    this.turn?.end();
    this.turn = null;
    this.turnText = '';
    this.turnImagePaths = [];
  }

  // ── line routing ───────────────────────────────────────

  private route(line: any): void {
    if (!this.turn) return;
    switch (line?.type) {
      case 'thought':
        if (typeof line.data === 'string' && line.data) {
          this.turn.push({ type: 'thinking', text: line.data });
        }
        return;
      case 'text':
        if (typeof line.data === 'string' && line.data) {
          this.accText += line.data;
          this.turn.push({ type: 'delta', text: line.data });
        }
        return;
      case 'end': {
        this.sawEnd = true;
        const stopReason = line.stopReason ?? line.stop_reason;
        this.stopReason = typeof stopReason === 'string' ? stopReason : null;
        this.usage = grokPluckUsage(line) ?? this.usage;
        // CLI 报的 sessionId 是权威值——万一和我们传的不一致，跟着它走
        if (typeof line.sessionId === 'string' && UUID_RE.test(line.sessionId) && line.sessionId !== this.sessionId) {
          this.sessionId = line.sessionId;
          this.turn.push({ type: 'session', sessionId: line.sessionId });
        }
        return;
      }
      default:
        return;
    }
  }

  /** 退出码是这轮的权威边界：0 = done，其余 = error。
   *  会话 flag 用错（-s 撞已存在 / -r 找不到）时换边重试一次。 */
  private handleExit(code: number | null): void {
    this.proc = null;
    if (!this.turn) return;

    if (!this.interrupted && code !== 0 && !this.retried && /session/i.test(this.stderrTail.join(''))) {
      this.retried = true;
      if (this.sessionFlag === '-s') {
        // create 撞车（上轮建好后中途崩过）→ 转 resume
        this.sessionFlag = '-r';
        this.opts.log(`session ${this.sessionId} already exists — retrying with -r`);
      } else {
        // resume 落空（会话文件丢了/被清）→ 开新会话并announce
        this.sessionFlag = '-s';
        this.sessionId = crypto.randomUUID();
        this.opts.log(`resume failed — retrying with fresh session ${this.sessionId}`);
        this.turn.push({ type: 'session', sessionId: this.sessionId });
      }
      this.spawnAttempt();
      return;
    }

    if (this.interrupted) {
      this.turn.push({ type: 'error', message: '这轮被打断了', fatal: false });
    } else if (code === 0) {
      // 进程正常退出说明 session 已落盘；即使工具审批取消，下一轮也必须 resume。
      this.sessionFlag = '-r';
      if (!this.sawEnd) this.opts.log('warning: exit 0 without end event — schema drift?');
      const abnormalStop = ['cancelled', 'canceled', 'failed', 'error'].includes(
        (this.stopReason ?? '').toLowerCase()
      );
      if (abnormalStop) {
        this.turn.push({
          type: 'error',
          message:
            `Grok 回合未完成（stop_reason=${this.stopReason}）。` +
            '通常是 headless 模式下工具调用需要确认但没有获批；上方文字只是半成品，不作为最终结论。',
          fatal: false,
        });
      } else {
        this.turn.push({ type: 'done', finalText: this.accText, usage: this.usage });
      }
    } else {
      this.turn.push({
        type: 'error',
        message: `grok 退出异常 (code=${code})${this.stderrSnippet(' — ')}`,
        // 进程本来就每轮一个，退出不代表后端坏了
        fatal: false,
      });
    }
    this.finishTurn();
  }
}
