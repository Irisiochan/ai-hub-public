import fs from 'node:fs';
import path from 'node:path';
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

export interface KimiModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: Array<{ id: string; label: string }>;
  defaultReasoningEffort?: string;
}

/**
 * Static catalog — `kimi` has no `models` subcommand.
 * Prefer live `$KIMI_CODE_HOME/config.toml` `[models."…"]` when present.
 */
export const KIMI_DEFAULT_MODELS: KimiModelOption[] = [
  { id: '', label: '默认（Kimi CLI 自动选择）', isDefault: true },
  { id: 'kimi-code/kimi-for-coding', label: 'kimi-code/kimi-for-coding' },
  { id: 'kimi-for-coding', label: 'kimi-for-coding' },
];

export interface KimiCliBackendOpts {
  cliPath: string;
  cwd: string;
  model?: string;
  /**
   * Per-turn thinking effort. Applied via child env `KIMI_MODEL_THINKING_EFFORT`
   * (not by rewriting shared config.toml `[thinking].effort`, which would leak
   * across contacts). Empty / omitted → leave CLI default alone.
   */
  effort?: string;
  /**
   * 人设 + 记忆前缀。kimi 无 --rules；写入 cwd/AGENTS.md，
   * 并在每轮 -p prompt 前缀再带一份，避免只靠文件发现时漏注入。
   */
  preamble?: string;
  turnIdleTimeoutMs?: number;
  turnHardTimeoutMs?: number;
  /** False scrubs ambient SSH agent credentials from the child env. */
  sshAllowed?: boolean;
  /**
   * Optional overrides for the service-user layout verified on VPS:
   * HOME=/var/lib/ai-hub/home
   * KIMI_CODE_HOME=/var/lib/ai-hub/home/.kimi-code
   * When omitted, the hub process env is inherited as-is.
   */
  home?: string;
  kimiCodeHome?: string;
  log: (msg: string) => void;
}

/** Resolve `$KIMI_CODE_HOME` for config.toml reads / child spawn. */
export function resolveKimiCodeHome(opts: { kimiCodeHome?: string; home?: string } = {}): string {
  if (opts.kimiCodeHome?.trim()) return opts.kimiCodeHome.trim();
  if (process.env.KIMI_CODE_HOME?.trim()) return process.env.KIMI_CODE_HOME.trim();
  const home = opts.home?.trim() || process.env.HOME?.trim() || '';
  return home ? path.join(home, '.kimi-code') : path.join('.kimi-code');
}

function parseTomlStringList(raw: string): string[] {
  const inner = raw.trim();
  if (!inner.startsWith('[') || !inner.endsWith(']')) return [];
  const body = inner.slice(1, -1);
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    const value = (match[1] ?? match[2] ?? '').replace(/\\(.)/g, '$1').trim();
    if (value) out.push(value);
  }
  return out;
}

function parseTomlScalar(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const dq = trimmed.match(/^"((?:\\.|[^"\\])*)"$/);
  if (dq) return dq[1].replace(/\\(.)/g, '$1');
  const sq = trimmed.match(/^'((?:\\.|[^'\\])*)'$/);
  if (sq) return sq[1].replace(/\\(.)/g, '$1');
  // bare token (rare for display_name / default_effort)
  const bare = trimmed.match(/^([^#]+)/);
  return bare?.[1]?.trim() || undefined;
}

/**
 * Minimal extractor for `[models."id"]` blocks — no TOML dependency.
 * Reads `display_name`, `support_efforts`, `default_effort`. Skips
 * `[models."id".overrides]` and unrelated tables.
 */
export function parseKimiModelsToml(toml: string): KimiModelOption[] {
  const lines = toml.replace(/^\uFEFF/, '').split(/\r?\n/);
  const models: KimiModelOption[] = [];
  let currentId: string | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (!currentId) return;
    const block = buf.join('\n');
    const labelMatch = block.match(/(?:^|\n)\s*display_name\s*=\s*(.+)$/m);
    const effortsMatch = block.match(/(?:^|\n)\s*support_efforts\s*=\s*(\[[^\]]*\])/m)
      ?? block.match(/(?:^|\n)\s*support_efforts\s*=\s*(\[[\s\S]*?\])/m);
    const defaultMatch = block.match(/(?:^|\n)\s*default_effort\s*=\s*(.+)$/m);
    const label = (labelMatch ? parseTomlScalar(labelMatch[1]) : undefined) || currentId;
    const efforts = effortsMatch ? parseTomlStringList(effortsMatch[1]) : [];
    const defaultEffort = defaultMatch ? parseTomlScalar(defaultMatch[1]) : undefined;
    const option: KimiModelOption = { id: currentId, label };
    if (efforts.length) {
      option.supportedReasoningEfforts = efforts.map((id) => ({ id, label: id }));
    }
    if (defaultEffort) option.defaultReasoningEffort = defaultEffort;
    models.push(option);
    currentId = null;
    buf = [];
  };

  const headerRe = /^\[models\.(?:"([^"]+)"|([A-Za-z0-9_./:-]+))\]\s*$/;
  for (const line of lines) {
    const header = line.match(headerRe);
    if (header) {
      flush();
      currentId = (header[1] ?? header[2] ?? '').trim() || null;
      buf = [];
      continue;
    }
    if (/^\[/.test(line.trim())) {
      flush();
      continue;
    }
    if (currentId) buf.push(line);
  }
  flush();
  return models.filter((model, index) => models.findIndex((m) => m.id === model.id) === index);
}

/** Child env for one kimi turn — effort is per-invocation, never shared config. */
export function buildKimiChildEnv(
  base: NodeJS.ProcessEnv,
  opts: { home?: string; kimiCodeHome?: string; effort?: string; sshAllowed?: boolean },
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  if (opts.home) env.HOME = opts.home;
  if (opts.kimiCodeHome) env.KIMI_CODE_HOME = opts.kimiCodeHome;
  if (opts.effort?.trim()) env.KIMI_MODEL_THINKING_EFFORT = opts.effort.trim();
  else delete env.KIMI_MODEL_THINKING_EFFORT;
  if (opts.sshAllowed === false) {
    delete env.SSH_AUTH_SOCK;
    delete env.SSH_AGENT_PID;
  }
  return env;
}

function summarize(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 200);
  } catch {
    return '';
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const rec = part as Record<string, unknown>;
    if (typeof rec.text === 'string') parts.push(rec.text);
    else if (typeof rec.content === 'string') parts.push(rec.content);
  }
  return parts.join('');
}

function pluckUsage(obj: unknown): TokenUsage | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, any>;
  const usage = o.usage ?? o.token_usage ?? o.tokenUsage;
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
    cacheRead: num('cache_read_input_tokens', 'cached_tokens', 'cachedTokens') || undefined,
  };
}

function pickSessionId(rec: Record<string, unknown>): string | null {
  const direct = [rec.session_id, rec.sessionId, rec.id];
  for (const value of direct) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  // resume_hint.command looks like: `kimi -r session_…`
  if (typeof rec.command === 'string') {
    const match = rec.command.match(/(?:-r|--session|-S)\s+(\S+)/);
    if (match?.[1]) return match[1];
  }
  for (const key of ['data', 'payload', 'session']) {
    const nested = rec[key];
    if (nested && typeof nested === 'object') {
      const found = pickSessionId(nested as Record<string, unknown>);
      if (found) return found;
    }
  }
  return null;
}

export type KimiStreamAction =
  | { kind: 'ignore' }
  | { kind: 'delta'; text: string }
  | { kind: 'tool_use'; id: string; name: string; inputSummary: string }
  | { kind: 'tool_result'; id: string; name: string; ok: boolean; summary: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'usage'; usage: TokenUsage }
  | { kind: 'error'; message: string };

/**
 * Parse one stream-json NDJSON object into hub turn actions.
 *
 * Live capture (kimi 2.0.2, mainland oauth, print mode):
 *   {"role":"meta","type":"system.version","version":"2.0.2"}
 *   {"role":"assistant","content":"OK"}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_…",
 *    "command":"kimi -r session_…","content":"To resume this session: …"}
 *
 * Documented tool shape (not yet live-captured):
 *   assistant + tool_calls → tool role messages; thinking stays off JSONL.
 */
export function interpretKimiStreamLine(line: unknown): KimiStreamAction[] {
  if (!line || typeof line !== 'object') return [{ kind: 'ignore' }];
  const rec = line as Record<string, unknown>;
  const actions: KimiStreamAction[] = [];

  const usage = pluckUsage(rec);
  if (usage) actions.push({ kind: 'usage', usage });

  const role = typeof rec.role === 'string' ? rec.role : '';
  const type = typeof rec.type === 'string' ? rec.type : '';

  if (role === 'meta' || role === 'system' || type.startsWith('system.') || type.startsWith('session.')) {
    if (/session/i.test(type) || /resume/i.test(type)) {
      const sessionId = pickSessionId(rec);
      if (sessionId) actions.push({ kind: 'session', sessionId });
    }
    return actions.length ? actions : [{ kind: 'ignore' }];
  }

  if (role === 'error' || type === 'error' || rec.is_error === true) {
    const message = textFromContent(rec.content)
      || (typeof rec.message === 'string' ? rec.message : '')
      || (typeof rec.error === 'string' ? rec.error : '')
      || summarize(rec.error ?? rec)
      || 'kimi 报错';
    actions.push({ kind: 'error', message });
    return actions;
  }

  if (role === 'assistant') {
    const text = textFromContent(rec.content);
    if (text) actions.push({ kind: 'delta', text });
    const toolCalls = rec.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const raw of toolCalls) {
        if (!raw || typeof raw !== 'object') continue;
        const call = raw as Record<string, unknown>;
        const fn = call.function && typeof call.function === 'object'
          ? call.function as Record<string, unknown>
          : {};
        const id = typeof call.id === 'string' && call.id
          ? call.id
          : typeof call.tool_call_id === 'string' ? call.tool_call_id : `tool_${actions.length}`;
        const name = typeof fn.name === 'string' && fn.name
          ? fn.name
          : typeof call.name === 'string' && call.name ? call.name : 'tool';
        actions.push({
          kind: 'tool_use',
          id,
          name,
          inputSummary: summarize(fn.arguments ?? call.arguments ?? call.input),
        });
      }
    }
    return actions.length ? actions : [{ kind: 'ignore' }];
  }

  if (role === 'tool') {
    const id = typeof rec.tool_call_id === 'string' && rec.tool_call_id
      ? rec.tool_call_id
      : typeof rec.id === 'string' ? rec.id : '';
    const name = typeof rec.name === 'string' && rec.name ? rec.name : 'tool';
    const summary = textFromContent(rec.content) || summarize(rec);
    actions.push({
      kind: 'tool_result',
      id,
      name,
      ok: rec.is_error === true ? false : true,
      summary: summary.slice(0, 200),
    });
    return actions;
  }

  return actions.length ? actions : [{ kind: 'ignore' }];
}

function buildPrompt(text: string, imagePaths: string[], preamble?: string): string {
  const chunks: string[] = [];
  if (preamble?.trim()) {
    chunks.push(preamble.trim(), '');
  }
  chunks.push(text);
  if (imagePaths.length) {
    chunks.push(
      '',
      '<本轮图片附件>',
      ...imagePaths.map((file) => `- ${file}`),
      '</本轮图片附件>',
      '如需看图请用你的读文件/视觉工具打开以上路径；读失败请明确说明，不要只凭文字猜图。',
    );
  }
  return chunks.join('\n');
}

/**
 * Drives `kimi -p … --output-format stream-json` one process per turn.
 * Session continuity: `-r <id>` when known (live resume_hint uses `-r`;
 * `-S` / `--session` are aliases). After a successful turn without an id yet,
 * fall back to `-c` so cwd's latest session keeps going.
 */
export class KimiCliBackend implements AgentBackend {
  readonly kind = 'kimi-cli' as const;

  private sessionId: string | null = null;
  private sessionAnnounced = false;
  /** True after at least one successful exit 0 (or a resume token was supplied). */
  private canContinue = false;
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
  private toolNames = new Map<string, string>();

  constructor(private opts: KimiCliBackendOpts) {}

  /**
   * Hot catalog from `$KIMI_CODE_HOME/config.toml` `[models."…"]`.
   * Falls back to `KIMI_DEFAULT_MODELS` when the file is missing/unreadable.
   * Never invents a broken `kimi models` CLI probe.
   */
  static async listModels(opts: {
    cliPath: string;
    cwd: string;
    log: (msg: string) => void;
    modelOptions?: Array<string | { id: string; label?: string }>;
    home?: string;
    kimiCodeHome?: string;
  }): Promise<KimiModelOption[]> {
    const extras: KimiModelOption[] = [];
    for (const raw of opts.modelOptions ?? []) {
      if (typeof raw === 'string') {
        if (!raw.trim()) continue;
        extras.push({ id: raw.trim(), label: raw.trim() });
        continue;
      }
      if (raw && typeof raw === 'object' && typeof raw.id === 'string' && raw.id.trim()) {
        extras.push({ id: raw.id.trim(), label: (raw.label ?? raw.id).trim() });
      }
    }

    let live: KimiModelOption[] = [];
    const kimiHome = resolveKimiCodeHome(opts);
    const configPath = path.join(kimiHome, 'config.toml');
    try {
      const toml = fs.readFileSync(configPath, 'utf8');
      live = parseKimiModelsToml(toml);
      if (live.length) {
        opts.log(`kimi-cli model catalog: ${live.length} from ${configPath}`);
      } else {
        opts.log(`kimi-cli model catalog: ${configPath} has no [models."…"] — using defaults`);
      }
    } catch (e: any) {
      opts.log(`kimi-cli model catalog: config.toml unavailable (${e?.code ?? e?.message ?? e}) — using defaults`);
    }

    const base = live.length
      ? [{ id: '', label: '默认（Kimi CLI 自动选择）', isDefault: true }, ...live]
      : [...KIMI_DEFAULT_MODELS];
    const models = [
      ...base,
      ...extras.filter((model) => !base.some((item) => item.id === model.id)),
    ];
    opts.log(`kimi-cli model catalog: ${models.length} options`);
    return models;
  }

  async start(resumeToken: string | null): Promise<void> {
    fs.mkdirSync(this.opts.cwd, { recursive: true });
    if (this.opts.preamble) {
      fs.writeFileSync(path.join(this.opts.cwd, 'AGENTS.md'), `${this.opts.preamble.trim()}\n`, 'utf8');
    }
    this.sessionId = resumeToken && resumeToken.trim() ? resumeToken.trim() : null;
    this.sessionAnnounced = false;
    this.canContinue = !!this.sessionId;
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

    const timeouts = resolveTurnTimeouts(this.opts);
    this.turnTimeouts = new TurnTimeoutController(timeouts, (kind) => {
      if (this.turn !== queue) return;
      this.opts.log(`${kind} turn timeout, killing kimi process${this.stderrSnippet()}`);
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
    this.toolNames.clear();

    const prompt = buildPrompt(this.turnText, this.turnImagePaths, this.opts.preamble);
    // Live contract: kimi -p "…" --output-format stream-json [-m model] [-r session]
    const args = ['-p', prompt, '--output-format', 'stream-json'];
    if (this.opts.model) args.push('-m', this.opts.model);
    if (this.sessionId) {
      // resume_hint.command uses `-r`; `-S` / `--session` are documented aliases.
      args.push('-r', this.sessionId);
    } else if (this.canContinue) {
      args.push('-c');
    }

    const command = this.opts.cliPath.endsWith('.mjs') ? process.execPath : this.opts.cliPath;
    const finalArgs = this.opts.cliPath.endsWith('.mjs') ? [this.opts.cliPath, ...args] : args;

    const env = buildKimiChildEnv(process.env, {
      home: this.opts.home,
      kimiCodeHome: this.opts.kimiCodeHome,
      effort: this.opts.effort,
      sshAllowed: this.opts.sshAllowed,
    });

    const proc = new JsonlProcess({
      command,
      args: finalArgs,
      cwd: this.opts.cwd,
      env,
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

  private captureSession(sessionId: string): void {
    if (!sessionId || sessionId === this.sessionId) return;
    this.sessionId = sessionId;
    this.sessionAnnounced = true;
    this.canContinue = true;
    this.emit({ type: 'session', sessionId });
  }

  private route(line: unknown): void {
    if (!this.turn) return;
    for (const action of interpretKimiStreamLine(line)) {
      switch (action.kind) {
        case 'ignore':
          break;
        case 'delta':
          this.accText += action.text;
          this.emit({ type: 'delta', text: action.text });
          break;
        case 'tool_use':
          this.toolNames.set(action.id, action.name);
          this.emit({ type: 'tool_use', name: action.name, inputSummary: action.inputSummary });
          break;
        case 'tool_result': {
          const name = this.toolNames.get(action.id) ?? action.name;
          this.emit({ type: 'tool_result', name, ok: action.ok, summary: action.summary });
          break;
        }
        case 'session':
          this.captureSession(action.sessionId);
          break;
        case 'usage':
          this.usage = action.usage;
          break;
        case 'error':
          this.jsonError = action.message;
          break;
        default:
          break;
      }
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
      this.canContinue = true;
      this.emit({ type: 'done', finalText: this.accText, usage: this.usage });
    } else if (code === 75) {
      // kimi print-mode: 75 = retryable (rate limit / 5xx / timeout)
      this.emit({
        type: 'error',
        message: `kimi 暂时不可用 (code=75，可重试)${this.stderrSnippet()}`,
        fatal: false,
      });
    } else {
      this.emit({
        type: 'error',
        message: `kimi 退出异常 (code=${code})${this.stderrSnippet()}`,
        fatal: false,
      });
    }
    this.finishTurn();
  }
}
