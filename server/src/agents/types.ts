export type TurnEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; name: string; inputSummary: string }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'done'; finalText: string; usage?: TokenUsage }
  | { type: 'error'; message: string; fatal: boolean };

export interface TokenUsage {
  /**
   * 本轮展示用 input（UI「本轮 input」）。
   * Gemini 多工具轮：取最终请求的 promptTokenCount，避免把各趟 prompt 简单相加造成虚高。
   * 其它 provider：保持各自既有累加/上报口径。
   */
  input: number;
  output: number;
  /** Provider terminal reason for the final upstream round. */
  finishReason?: string;
  cacheCreation?: number;
  cacheRead?: number;
  /**
   * 多工具轮时各请求 prompt token 之和（更接近供应商按次计费的累加值）。
   * 有值时可与 input 对照：input=展示口径，inputRoundsSum=round 累加。
   */
  inputRoundsSum?: number;
  /** 本用户 turn 内实际向上游发了几趟请求（含 tool 回环）。 */
  providerRounds?: number;
  /** 本地启发式估算，只用于分项定位成本；供应商 usage 仍是计费口径。 */
  estimate?: TokenCostEstimate;
}

export interface TokenCostEstimate {
  system: number;
  memory: number;
  history: number;
  summary: number;
  retrieval: number;
  tools: number;
  user: number;
  total: number;
}

export interface TurnHandle {
  events: AsyncIterable<TurnEvent>;
  interrupt(): Promise<void>;
}

export interface TurnInput {
  text: string;
  userMessageId?: number;
  /** 群聊本轮实际投递的消息 ID。API 历史据此区分“本轮新消息”和旧记录。 */
  roomMessageIds?: number[];
  /** Trusted absolute paths resolved by the gateway from persisted attachments. */
  imagePaths?: string[];
}

export interface AgentBackend {
  readonly kind: 'claude-cli' | 'codex' | 'grok-cli' | 'api';
  /** Spawn/connect. resumeToken = claude session_id / codex threadId / null.
   *  Must not throw on a stale token — fall back to fresh and emit a new 'session'. */
  start(resumeToken: string | null): Promise<void>;
  /** One turn. Caller guarantees serialization — never called concurrently. */
  sendTurn(input: TurnInput): TurnHandle;
  alive(): boolean;
  /** Optional cache invalidation for DB-backed history implementations. */
  invalidateHistory?(affectedFromId?: number): void;
  stop(): Promise<void>;
}

/** Unbounded async FIFO used to bridge callback-style stdio events into AsyncIterable turns. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
