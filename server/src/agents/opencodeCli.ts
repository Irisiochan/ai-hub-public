import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { JsonlProcess } from './jsonlProcess.js';
import {
  AsyncQueue,
  type AgentBackend,
  type TokenUsage,
  type TurnEvent,
  type TurnHandle,
  type TurnInput,
} from './types.js';
import { TurnTimeoutController, resolveTurnTimeouts, timeoutTurnEvent } from './turnTimeouts.js';

const execFileAsync = promisify(execFile);

export interface OpencodeModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
}

/** `muse-spark-1.2-contributor` → `Muse Spark 1.2 Contributor`. */
export function prettyOpencodeModelLabel(id: string): string {
  const slash = id.indexOf('/');
  const provider = slash >= 0 ? id.slice(0, slash) : '';
  const model = slash >= 0 ? id.slice(slash + 1) : id;
  const pretty = model
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d+(\.\d+)*$/.test(part)) return part;
      if (part === part.toUpperCase()) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
  if (!pretty) return id;
  if (provider === 'opencode-go') return `${pretty} (Go)`;
  if (!provider || provider === 'opencode') return pretty;
  return `${pretty} (${provider})`;
}

/** `opencode models` prints one `provider/model` id per line. */
export function parseOpencodeModelList(output: string): OpencodeModelOption[] {
  const lines = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/);
  const models: OpencodeModelOption[] = [];
  for (const line of lines) {
    const id = line.trim();
    if (!id || id.startsWith('#') || /\s/.test(id) || !id.includes('/')) continue;
    if (models.some((model) => model.id === id)) continue;
    models.push({ id, label: prettyOpencodeModelLabel(id) });
  }
  return models;
}

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function opencodeImageMimeType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (!mime) throw new Error(`opencode 不支持这个图片格式：${ext || '无扩展名'}`);
  return mime;
}

/**
 * Repeatable `opencode run --file` flags. Paths stay on argv (no base64) so a
 * screenshot cannot blow Windows command-line / Linux MAX_ARG_STRLEN limits.
 * MIME is a Hub-side gate matching the upload whitelist; OpenCode sniffs bytes.
 */
export function opencodeFileArgs(imagePaths: string[]): string[] {
  return imagePaths.flatMap((file) => {
    opencodeImageMimeType(file);
    return ['--file', file];
  });
}

export interface OpencodeCliBackendOpts {
  cliPath: string;
  cwd: string;
  model?: string;
  variant?: string;
  preamble?: string;
  configPath?: string;
  turnTimeoutMs?: number;
  turnIdleTimeoutMs?: number;
  turnHardTimeoutMs?: number;
  log: (msg: string) => void;
}

function partText(part: unknown): string {
  if (!part || typeof part !== 'object') return '';
  const text = (part as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!value || typeof value !== 'object') return 'opencode 报错';
  const rec = value as Record<string, unknown>;
  if (typeof rec.message === 'string' && rec.message.trim()) return rec.message.trim();
  if (rec.data && typeof rec.data === 'object') {
    const data = rec.data as Record<string, unknown>;
    if (typeof data.message === 'string' && data.message.trim()) return data.message.trim();
  }
  if (typeof rec.name === 'string' && rec.name.trim()) return rec.name.trim();
  try {
    return JSON.stringify(value).slice(0, 300);
  } catch {
    return 'opencode 报错';
  }
}

/**
 * Drives `opencode run --format json` one process per turn.
 * Session continuity is `--session <id>` (ids look like ses_…).
 */
export class OpencodeCliBackend implements AgentBackend {
  readonly kind = 'opencode-cli' as const;
  private sessionId: string | null = null;
  private sessionAnnounced = false;
  private started = false;
  private proc: JsonlProcess | null = null;
  private turn: AsyncQueue<TurnEvent> | null = null;
  private turnTimeouts: TurnTimeoutController | null = null;
  private interrupted = false;
  private turnText = '';
  private turnImagePaths: string[] = [];
  private accText = '';
  private jsonError: string | null = null;
  private usage: TokenUsage | undefined;
  private stderrTail: string[] = [];

  constructor(private opts: OpencodeCliBackendOpts) {}

  /** Query `opencode models` without starting a chat session. */
  static async listModels(opts: {
    cliPath: string;
    cwd: string;
    log: (msg: string) => void;
  }): Promise<OpencodeModelOption[]> {
    const command = opts.cliPath.endsWith('.mjs') ? process.execPath : opts.cliPath;
    const args = opts.cliPath.endsWith('.mjs') ? [opts.cliPath, 'models'] : ['models'];
    const { stdout } = await execFileAsync(command, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    const models = parseOpencodeModelList(String(stdout));
    if (!models.length) throw new Error('opencode models 没有返回可用模型');
    opts.log(`loaded ${models.length} OpenCode models from CLI`);
    return models;
  }

  async start(resumeToken: string | null): Promise<void> {
    fs.mkdirSync(this.opts.cwd, { recursive: true });
    if (this.opts.preamble) {
      fs.writeFileSync(path.join(this.opts.cwd, 'AGENTS.md'), `${this.opts.preamble.trim()}\n`, 'utf8');
    }
    this.sessionId = resumeToken && resumeToken.trim() ? resumeToken.trim() : null;
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

  sendTurn(input: TurnInput): TurnHandle {
    const queue = new AsyncQueue<TurnEvent>();
    this.turn = queue;
    if (this.sessionId && !this.sessionAnnounced) {
      this.sessionAnnounced = true;
      queue.push({ type: 'session', sessionId: this.sessionId });
    }
    this.turnText = input.text;
    this.turnImagePaths = [...(input.imagePaths ?? [])];

    try {
      opencodeFileArgs(this.turnImagePaths);
    } catch (error) {
      queue.push({
        type: 'error',
        message: `opencode 图片读取失败：${(error as Error).message}`,
        fatal: false,
      });
      this.finishTurn();
      return { events: queue, interrupt: () => this.interrupt() };
    }

    const timeouts = resolveTurnTimeouts(this.opts);
    this.turnTimeouts = new TurnTimeoutController(timeouts, (kind) => {
      if (this.turn !== queue) return;
      this.opts.log(`${kind} turn timeout, killing opencode process${this.stderrSnippet()}`);
      this.interrupted = true;
      void this.proc?.stop(0);
      queue.push(timeoutTurnEvent(kind));
      this.finishTurn();
    });
    this.turnTimeouts.start();
    this.spawnAttempt();
    return { events: queue, interrupt: () => this.interrupt() };
  }

  private spawnAttempt(): void {
    this.accText = '';
    this.jsonError = null;
    this.interrupted = false;
    this.usage = undefined;
    this.stderrTail = [];

    const args = ['run', '--format', 'json', '--pure', '--thinking'];
    if (this.opts.model) args.push('-m', this.opts.model);
    if (this.opts.variant) args.push('--variant', this.opts.variant);
    if (this.sessionId) args.push('--session', this.sessionId);
    args.push(...opencodeFileArgs(this.turnImagePaths));
    args.push('--dir', this.opts.cwd);
    args.push('--', this.turnText);

    const command = this.opts.cliPath.endsWith('.mjs') ? process.execPath : this.opts.cliPath;
    const finalArgs = this.opts.cliPath.endsWith('.mjs') ? [this.opts.cliPath, ...args] : args;
    const proc = new JsonlProcess({
      command,
      args: finalArgs,
      cwd: this.opts.cwd,
      env: {
        ...process.env,
        HOME: process.env.HOME,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        ...(this.opts.configPath ? { OPENCODE_CONFIG: this.opts.configPath } : {}),
      },
    });
    this.proc = proc;
    proc.on('line', (line: unknown) => {
      this.turnTimeouts?.pulse();
      this.route(line);
    });
    proc.on('stderr', (s: string) => {
      this.turnTimeouts?.pulse();
      this.stderrTail.push(s);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    proc.on('exit', ({ code }: { code: number | null }) => this.handleExit(code));
    proc.start();
    proc.endStdin();
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    await this.proc?.stop(0);
  }

  private finishTurn(): void {
    this.turnTimeouts?.finish();
    this.turnTimeouts = null;
    this.turn?.end();
    this.turn = null;
    this.turnText = '';
    this.turnImagePaths = [];
  }

  private emit(event: TurnEvent): void {
    this.turnTimeouts?.activity(event);
    this.turn?.push(event);
  }

  private captureSession(id: unknown): void {
    if (typeof id !== 'string' || !id.trim()) return;
    if (id === this.sessionId) return;
    this.sessionId = id.trim();
    this.sessionAnnounced = true;
    this.emit({ type: 'session', sessionId: this.sessionId });
  }

  private route(line: unknown): void {
    if (!this.turn || !line || typeof line !== 'object') return;
    const rec = line as Record<string, unknown>;
    this.captureSession(rec.sessionID ?? rec.sessionId);
    switch (rec.type) {
      case 'text': {
        const text = partText(rec.part);
        if (!text) return;
        this.accText += (this.accText && !this.accText.endsWith('\n') ? '\n' : '') + text;
        this.emit({ type: 'delta', text });
        return;
      }
      case 'reasoning': {
        const text = partText(rec.part);
        if (text) this.emit({ type: 'thinking', text });
        return;
      }
      case 'tool_use': {
        const part = rec.part && typeof rec.part === 'object' ? rec.part as Record<string, unknown> : {};
        const name = typeof part.tool === 'string' ? part.tool : 'tool';
        this.emit({ type: 'tool_use', name, inputSummary: '' });
        return;
      }
      case 'error': {
        this.jsonError = errorMessage(rec.error ?? rec);
        return;
      }
      default:
        return;
    }
  }

  private stderrSnippet(): string {
    const tail = this.stderrTail.join('').trim().slice(-300);
    return tail ? ` — ${tail}` : '';
  }

  private handleExit(code: number | null): void {
    this.proc = null;
    if (!this.turn) return;
    if (this.interrupted) {
      this.emit({ type: 'error', message: '这轮被打断了', fatal: false });
    } else if (this.jsonError) {
      this.emit({ type: 'error', message: this.jsonError, fatal: false });
    } else if (code === 0) {
      this.emit({ type: 'done', finalText: this.accText, usage: this.usage });
    } else {
      this.emit({
        type: 'error',
        message: `opencode 退出异常 (code=${code})${this.stderrSnippet()}`,
        fatal: false,
      });
    }
    this.finishTurn();
  }
}
