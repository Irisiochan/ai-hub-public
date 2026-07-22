import type { ConversationSummaryRow, Db, MessageRow } from '../db.js';
import { attachmentDataUrl, attachmentsForMessage } from '../attachments.js';
import type { VaultClient } from '../memory/vaultClient.js';
import { compactSummaryText } from './conversationSummary.js';
import type { GatewayTool } from './gatewayTools.js';
import { estimateTokens } from './tokenEstimate.js';
import {
  AsyncQueue,
  type AgentBackend,
  type TokenCostEstimate,
  type TurnEvent,
  type TurnHandle,
} from './types.js';

export { estimateTokens } from './tokenEstimate.js';

export interface DirectApiBackendOpts {
  provider: 'anthropic' | 'openai-compat' | 'gemini';
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Optional model used only when the turn contains images. Keeps the normal chat model unchanged. */
  visionModel?: string;
  /**
   * 是否允许把图片 content part 发给上游。undefined = 按 provider+model 自动推断
   * （见 defaultSupportsImages）。为 false 时含图历史会被降级成文字占位，避免纯文字
   * 模型（如 openai-compat 下的 deepseek）因 image_url content block 被上游 HTTP 400。
   */
  supportsImages?: boolean;
  systemPrompt?: string; // persona + 网关注入的记忆 preamble
  /** 单独标记记忆前缀，便于本地成本分项；不改变实际 prompt。 */
  memoryPreamble?: string;
  maxHistoryMessages: number;
  historyTokenBudget: number;
  minRecentTurns: number;
  summaryMaxTokens: number;
  historySummaryStrategy: 'extractive' | 'off' | 'external';
  maxTokens: number;
  /**
   * 供应商上下文窗口上限（token 粗估）。历史预算会再扣掉输出/工具回填/附件预留，
   * 避免 history+system+tools 把窗口顶满。0/未设则只按 historyTokenBudget。
   */
  contextWindowTokens?: number;
  turnTimeoutMs: number;
  db: Db;
  uploadsDir: string;
  contactId: string;
  memberId?: string;
  log: (msg: string) => void;
  /** 记忆库客户端。给了就把只读记忆工具声明给模型，模型调用时网关代为执行——
   *  preamble 承诺的 search_vault / read_file 才不是空头支票。 */
  vault?: VaultClient;
  /** 额外的网关代执行工具（如 PC Worker 委派三件套） */
  extraTools?: GatewayTool[];
  /** 群聊模式：自己的历史发言→assistant，其他人（含用户）→带名字前缀的 user */
  roomMode?: {
    selfId: string;
    nameOf: (sender: string) => string;
  };
}

/** 每轮 turn 内最多几趟工具往返，防模型翻档案翻上瘾 */
export const MAX_TOOL_ROUNDS = 4;
/**
 * 单次工具结果回填上限（字符）。
 * 12k × 最多 4 轮会把后续 prompt 再撑十几～几十 k；5k 仍够装一段核心记忆
 * / 检索片段，截断后模型可继续用 search_vault / read_file 按需深挖。
 */
export const TOOL_RESULT_MAX_CHARS = 5_000;

/** 图片被剥离后留给纯文字模型的占位，保留“这里本来有图”的语义，但不外发 base64/url。 */
export const IMAGE_OMITTED_PLACEHOLDER = '[图片已省略，该模型不支持图片]';

/**
 * 未显式配置 supportsImages 时，按 provider + model 名推断能否发送图片 content part。
 *
 * - anthropic / gemini：本后端已按各自 schema 序列化图片，默认多模态。
 * - openai-compat：既涵盖多模态模型（gpt-4o、*-vl、*-4v 等），也涵盖纯文字模型
 *   （deepseek chat/coder/reasoner 等），后者对 `image_url` part 会 HTTP 400
 *   “unknown variant image_url”。按模型名识别已知纯文字家族，其余保持既有发图行为。
 *
 * 该推断可被联系人配置里的 supportsImages 显式覆盖（true/false）。
 */
export function defaultSupportsImages(
  provider: DirectApiBackendOpts['provider'],
  model: string
): boolean {
  if (provider !== 'openai-compat') return true;
  const m = (model ?? '').toLowerCase();
  // 模型名带明确视觉标记 → 当作多模态（放行未来的 deepseek-vl 等）。
  if (/vision|multimodal|-vl\b|\bvl\b|omni|4o\b|4v\b/.test(m)) return true;
  // 已知纯文字家族：deepseek 走 openai-compat 时不吃 image_url。
  if (/deepseek/.test(m)) return false;
  // 其它未知 openai-compat 模型保持既有行为（发图）；纯文字模型可显式设 supportsImages=false。
  return true;
}

export type UpstreamErrorCategory =
  | 'capacity'
  | 'rate_limit'
  | 'quota'
  | 'model_unavailable'
  | 'auth'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'unknown';

export interface UpstreamErrorInfo {
  provider: DirectApiBackendOpts['provider'];
  model: string;
  status: number;
  category: UpstreamErrorCategory;
  title: string;
  detail: string;
  rawSnippet: string;
}

function compactBody(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function extractErrorDetail(raw: string): { type?: string; code?: string; message: string } {
  const snippet = compactBody(raw);
  if (!snippet) return { message: '' };
  try {
    const parsed = JSON.parse(raw);
    const err = parsed?.error ?? parsed;
    const message = String(err?.message ?? err?.detail ?? err?.error ?? snippet);
    return {
      type: typeof err?.type === 'string' ? err.type : undefined,
      code: typeof err?.code === 'string' ? err.code : undefined,
      message,
    };
  } catch {
    return { message: snippet };
  }
}

export function classifyUpstreamHttpError(
  provider: DirectApiBackendOpts['provider'],
  model: string,
  status: number,
  rawBody: string
): UpstreamErrorInfo {
  const rawSnippet = compactBody(rawBody);
  const detail = extractErrorDetail(rawBody);
  const haystack = `${status} ${detail.type ?? ''} ${detail.code ?? ''} ${detail.message}`.toLowerCase();
  let category: UpstreamErrorCategory = 'unknown';
  let title = '上游 API 请求失败';

  if (haystack.includes('capacity') || haystack.includes('overloaded')) {
    category = 'capacity';
    title = '上游模型容量不足';
  } else if (haystack.includes('quota') || haystack.includes('insufficient_quota') || haystack.includes('billing')) {
    category = 'quota';
    title = '上游额度不足';
  } else if (status === 429 || haystack.includes('rate_limit') || haystack.includes('rate limit')) {
    category = 'rate_limit';
    title = '上游限流';
  } else if (
    haystack.includes('model_not_found') ||
    haystack.includes('model not found') ||
    haystack.includes('does not exist') ||
    haystack.includes('not available') ||
    haystack.includes('unsupported model')
  ) {
    category = 'model_unavailable';
    title = '模型不可用';
  } else if (status === 401 || status === 403 || haystack.includes('unauthorized') || haystack.includes('forbidden')) {
    category = 'auth';
    title = '上游鉴权失败';
  } else if (status >= 500) {
    category = 'server';
    title = '上游服务错误';
  } else if (status >= 400) {
    category = 'bad_request';
    title = '请求被上游拒绝';
  }

  return {
    provider,
    model,
    status,
    category,
    title,
    detail: detail.message || rawSnippet || `HTTP ${status}`,
    rawSnippet,
  };
}

function formatUpstreamError(info: UpstreamErrorInfo): string {
  const raw = info.rawSnippet && info.rawSnippet !== info.detail
    ? `；原始响应：${info.rawSnippet}`
    : '';
  return `${info.title}（${info.provider}，model=${info.model}，HTTP ${info.status}）：${info.detail}${raw}`;
}

class UpstreamHttpError extends Error {
  constructor(readonly info: UpstreamErrorInfo) {
    super(formatUpstreamError(info));
  }
}

interface ImageContentPart {
  type: 'image';
  mimeType: string;
  dataUrl: string;
}

type InternalContent = string | Array<{ type: 'text'; text: string } | ImageContentPart>;

interface HistoryBuild {
  messages: { role: 'user' | 'assistant'; content: InternalContent }[];
  summarySystem: string;
  historyTokens: number;
  summaryTokens: number;
}

const MEMORY_TOOLS: { name: string; description: string; schema: Record<string, unknown> }[] = [
  {
    name: 'search_vault',
    description:
      '在 Iris 的共享记忆库中按关键词搜索（多个词空格分隔，AND 逻辑），返回匹配的文件清单。',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description: '读取记忆库中某个文件的全文。path 是相对路径，例如 "memories/iris-core.md"。',
    schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对于记忆库根目录的路径' } },
      required: ['path'],
    },
  },
];

/**
 * Stateless streaming backend over raw HTTP APIs. Conversation state lives in
 * the gateway DB (last N text messages become the messages array), so there is
 * no resume token — every turn is a full request. Memory tools are executed
 * gateway-side against the vault and fed back in an agent loop.
 */
export class DirectApiBackend implements AgentBackend {
  readonly kind = 'api' as const;
  private stopped = false;

  constructor(private opts: DirectApiBackendOpts) {}

  async start(_resumeToken: string | null): Promise<void> {
    if (!this.opts.apiKey) throw new Error('这个联系人还没配 API key（联系人设置里填）');
    if (!this.opts.model) throw new Error('这个联系人还没配 model');
  }

  alive(): boolean {
    return !this.stopped;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  private compactSummary(existing: string, rows: MessageRow[]): string {
    // external：配置了可选项，但默认仍走本地 extractive，不把私人对话发给另一供应商
    return compactSummaryText(existing, rows, {
      summaryMaxTokens: this.opts.summaryMaxTokens,
      historyTokenBudget: this.opts.historyTokenBudget,
      nameOf: this.opts.roomMode?.nameOf,
    });
  }

  /**
   * 历史原文可用预算：在 historyTokenBudget 上再扣输出/工具 schema/工具回填/附件预留。
   * 有 contextWindowTokens 时，还会用 system+tools+预留 反推 history 上限。
   */
  private effectiveHistoryBudget(summaryBlock: string): number {
    const toolDefs = this.toolDefs();
    const toolSchemaTokens = estimateTokens(JSON.stringify(toolDefs));
    const systemTokens = estimateTokens(this.opts.systemPrompt ?? '');
    // 输出 + 最多几轮工具结果回填（字符→粗估 token）+ 多模态头
    const outputReserve = Math.max(this.opts.maxTokens, 256);
    const toolResultReserve = toolDefs.length
      ? Math.ceil((TOOL_RESULT_MAX_CHARS * Math.min(MAX_TOOL_ROUNDS, 2)) / 4)
      : 0;
    const attachmentReserve = 1024;
    const reserve = outputReserve + toolSchemaTokens + toolResultReserve + attachmentReserve;

    let budget = this.opts.historyTokenBudget;
    const window = this.opts.contextWindowTokens ?? 0;
    if (window > 0) {
      const fixed = systemTokens + toolSchemaTokens + reserve;
      budget = Math.min(budget, Math.max(2048, window - fixed));
    }
    const afterSummary = Math.max(budget - estimateTokens(summaryBlock) - Math.min(reserve, Math.floor(budget * 0.35)), 512);
    return afterSummary;
  }

  private contentForRow(row: MessageRow, text = row.content): InternalContent {
    const images = attachmentsForMessage(this.opts.db, row.id).flatMap((attachment) => {
      try {
        return [{ type: 'image' as const, mimeType: attachment.mime_type, dataUrl: attachmentDataUrl(this.opts.uploadsDir, attachment) }];
      } catch (error) {
        this.opts.log(`attachment ${attachment.id} unreadable: ${(error as Error).message}`);
        return [];
      }
    });
    return images.length > 0 ? [{ type: 'text', text }, ...images] : text;
  }

  private mergeContent(left: InternalContent, right: InternalContent): InternalContent {
    if (typeof left === 'string' && typeof right === 'string') return `${left}\n${right}`;
    const parts = (content: InternalContent) =>
      typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
    return [...parts(left), { type: 'text', text: '\n' }, ...parts(right)];
  }

  private textOf(content: InternalContent): string {
    return typeof content === 'string'
      ? content
      : content.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map((part) => part.text).join('');
  }

  private contentHasSignal(content: InternalContent): boolean {
    if (typeof content === 'string') return content.trim().length > 0;
    return content.some((part) => part.type === 'image' || part.text.trim().length > 0);
  }

  private hasImages(history: HistoryBuild): boolean {
    return history.messages.some(
      (message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image')
    );
  }

  /** base（非 vision）模型是否可接收图片 content part。显式配置优先，否则按 provider+model 推断。 */
  private baseSupportsImages(): boolean {
    return typeof this.opts.supportsImages === 'boolean'
      ? this.opts.supportsImages
      : defaultSupportsImages(this.opts.provider, this.opts.model);
  }

  /**
   * 把历史里的图片 part 原地降级成一条文字占位，返回剥离的图片数。
   * 只影响本成员本轮请求：既保留“这里本来有图”的语义，又不把 base64/url 塞进上游。
   */
  private stripImages(history: HistoryBuild): number {
    let removed = 0;
    for (const message of history.messages) {
      if (typeof message.content === 'string') continue;
      const texts = message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text);
      const imageCount = message.content.length - texts.length;
      if (imageCount === 0) continue;
      removed += imageCount;
      const joined = texts.join('');
      message.content = joined ? `${joined}\n${IMAGE_OMITTED_PLACEHOLDER}` : IMAGE_OMITTED_PLACEHOLDER;
    }
    return removed;
  }

  private history(currentText: string, currentMessageId?: number): HistoryBuild {
    const memberId = this.opts.memberId ?? '';
    const saved = this.opts.db
      .prepare('SELECT * FROM conversation_summaries WHERE contact_id = ? AND member_id = ?')
      .get(this.opts.contactId, memberId) as ConversationSummaryRow | undefined;

    const rows = this.opts.db
      .prepare(
        `SELECT * FROM messages
         WHERE contact_id = ? AND kind = 'text' AND status = 'done' AND deleted = 0
           AND role IN ('user','assistant')
           AND id > ?
         ORDER BY id ASC`
      )
      .all(this.opts.contactId, saved?.through_message_id ?? 0) as MessageRow[];

    let summary = saved?.summary ?? '';
    let keepFrom = 0;
    const hardMax = Math.max(this.opts.maxHistoryMessages, 2);
    const minimum = Math.min(Math.max(this.opts.minRecentTurns * 2, 2), hardMax);

    const chooseKeepFrom = () => {
      const summaryBlock = summary
        ? `# 对话滚动摘要（覆盖更早消息）\n${summary}`
        : '';
      const rawBudget = this.effectiveHistoryBudget(summaryBlock);
      let used = 0;
      let count = 0;
      let start = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) {
        const cost = estimateTokens(rows[i].content) + 4;
        if (count >= minimum && (count >= hardMax || used + cost > rawBudget)) break;
        used += cost;
        count++;
        start = i;
      }
      return start;
    };

    keepFrom = chooseKeepFrom();
    // extractive / external 都走本地滚动摘要；external 仅表示「允许将来接 LLM」，当前不外发
    while (this.opts.historySummaryStrategy !== 'off' && keepFrom > 0) {
      const dropped = rows.splice(0, keepFrom);
      summary = this.compactSummary(summary, dropped);
      const through = dropped[dropped.length - 1].id;
      this.opts.db
        .prepare(
          `INSERT INTO conversation_summaries
             (contact_id, member_id, summary, through_message_id, version, updated_at)
           VALUES (?, ?, ?, ?, 1, datetime('now'))
           ON CONFLICT(contact_id, member_id) DO UPDATE SET
             summary = excluded.summary,
             through_message_id = excluded.through_message_id,
             version = conversation_summaries.version + 1,
             updated_at = datetime('now')`
        )
        .run(this.opts.contactId, memberId, summary, through);
      keepFrom = chooseKeepFrom();
    }

    // strategy=off 时仍按预算/条数裁掉旧原文，只是不持久化摘要。
    const kept = rows.slice(keepFrom);

    const room = this.opts.roomMode;
    const msgs = kept.map((r) => {
      if (room) {
        return r.sender === room.selfId
          ? { role: 'assistant' as const, content: this.contentForRow(r) }
          : { role: 'user' as const, content: this.contentForRow(r, `${room.nameOf(r.sender)}：${r.content}`) };
      }
      return { role: r.role as 'user' | 'assistant', content: this.contentForRow(r) };
    }).filter((m) => this.contentHasSignal(m.content));

    // 相邻同角色合并（群聊里连续多条 user 很常见，anthropic 要求交替）
    const merged: { role: 'user' | 'assistant'; content: InternalContent }[] = [];
    for (const m of msgs) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content = this.mergeContent(last.content, m.content);
      else merged.push({ ...m });
    }

    if (room) {
      // 群聊：全部内容都在历史里（含最新消息），currentText 只是提示发言
      merged.push({ role: 'user', content: currentText });
    } else {
      // DM：当前这条已落库，但注入检索块后的版本以参数为准
      if (merged.length > 0 && merged[merged.length - 1].role === 'user') merged.pop();
      const currentRow = currentMessageId
        ? rows.find((row) => row.id === currentMessageId)
        : undefined;
      merged.push({ role: 'user', content: currentRow ? this.contentForRow(currentRow, currentText) : currentText });
    }

    while (merged.length > 0 && merged[0].role === 'assistant') merged.shift();
    const summarySystem = summary
      ? `# 对话滚动摘要（网关持久化，覆盖较早消息）\n${summary}`
      : '';
    return {
      messages: merged,
      summarySystem,
      historyTokens: estimateTokens(merged.slice(0, -1).map((m) => this.textOf(m.content)).join('\n')),
      summaryTokens: estimateTokens(summarySystem),
    };
  }

  private estimateCost(history: HistoryBuild, currentText: string): TokenCostEstimate {
    const defs = this.toolDefs();
    const marker = currentText.indexOf('<记忆库检索|');
    const userText = marker >= 0 ? currentText.slice(0, marker) : currentText;
    const retrieval = marker >= 0 ? currentText.slice(marker) : '';
    const memory = estimateTokens(this.opts.memoryPreamble ?? '');
    const systemAll = estimateTokens(this.opts.systemPrompt ?? '');
    const estimate = {
      system: Math.max(systemAll - memory, 0),
      memory,
      history: history.historyTokens,
      summary: history.summaryTokens,
      retrieval: estimateTokens(retrieval),
      tools: estimateTokens(JSON.stringify(defs)),
      user: estimateTokens(userText),
      total: 0,
    };
    estimate.total = Object.entries(estimate)
      .filter(([k]) => k !== 'total')
      .reduce((sum, [, value]) => sum + value, 0);
    return estimate;
  }

  sendTurn(input: { text: string; userMessageId?: number }): TurnHandle {
    const queue = new AsyncQueue<TurnEvent>();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.opts.turnTimeoutMs);

    void (async () => {
      try {
        const history = this.history(input.text, input.userMessageId);
        const historyHasImages = this.hasImages(history);
        const useVisionModel = historyHasImages && !!this.opts.visionModel;
        const requestModel = useVisionModel ? this.opts.visionModel! : this.opts.model;
        // 纯文字模型（未配 visionModel 且 base model 不支持图片）：把图片降级成文字占位。
        // 群聊里只对该成员这一趟请求生效，不影响支持图片的其他成员。
        if (historyHasImages && !useVisionModel && !this.baseSupportsImages()) {
          const removed = this.stripImages(history);
          this.opts.log(
            `stripped ${removed} image part(s): model=${requestModel} is text-only (image_url unsupported)`
          );
        }
        const estimate = this.estimateCost(history, input.text);
        this.opts.log(
          `token estimate total=${estimate.total} system=${estimate.system} memory=${estimate.memory} history=${estimate.history} summary=${estimate.summary} retrieval=${estimate.retrieval} tools=${estimate.tools} user=${estimate.user}`
        );
        if (this.opts.provider === 'anthropic') {
          await this.streamAnthropic(
            history.messages,
            queue,
            abort.signal,
            history.summarySystem,
            estimate,
            requestModel
          );
        } else if (this.opts.provider === 'gemini') {
          await this.streamGemini(
            history.messages,
            queue,
            abort.signal,
            history.summarySystem,
            estimate,
            requestModel
          );
        } else {
          await this.streamOpenAi(
            history.messages,
            queue,
            abort.signal,
            history.summarySystem,
            estimate,
            requestModel
          );
        }
      } catch (e: any) {
        queue.push({
          type: 'error',
          message: abort.signal.aborted
            ? '请求超时/被打断'
            : e instanceof UpstreamHttpError
              ? e.message
              : `API 请求失败：${e.message}`,
          fatal: false,
        });
      } finally {
        clearTimeout(timer);
        queue.end();
      }
    })();

    return {
      events: queue,
      interrupt: async () => abort.abort(),
    };
  }

  /** 声明给模型的全部工具：记忆三件套（有 vault 时）+ 网关额外工具 */
  private toolDefs(): { name: string; description: string; schema: Record<string, unknown> }[] {
    return [
      ...(this.opts.vault ? MEMORY_TOOLS : []),
      ...(this.opts.extraTools ?? []).map(({ name, description, schema }) => ({ name, description, schema })),
    ];
  }

  private async execTool(
    name: string,
    input: Record<string, unknown>,
    queue: AsyncQueue<TurnEvent>
  ): Promise<{ ok: boolean; text: string }> {
    queue.push({ type: 'tool_use', name, inputSummary: JSON.stringify(input).slice(0, 200) });
    let out: { ok: boolean; text: string };
    const extra = this.opts.extraTools?.find((t) => t.name === name);
    if (extra) {
      try {
        out = await extra.exec(input);
        out = { ...out, text: out.text.slice(0, TOOL_RESULT_MAX_CHARS) };
      } catch (e: any) {
        out = { ok: false, text: `工具调用失败：${e.message}` };
      }
    } else if (!this.opts.vault || !MEMORY_TOOLS.some((t) => t.name === name)) {
      out = { ok: false, text: `工具 ${name} 不存在或当前不可用` };
    } else {
      try {
        const text = await this.opts.vault.call(name, input, 0);
        out = { ok: true, text: text.slice(0, TOOL_RESULT_MAX_CHARS) || '(空结果)' };
      } catch (e: any) {
        out = { ok: false, text: `工具调用失败：${e.message}` };
      }
    }
    this.opts.log(`tool ${name}(${JSON.stringify(input).slice(0, 120)}) → ${out.ok ? 'ok' : 'fail'}`);
    queue.push({ type: 'tool_result', name, ok: out.ok, summary: out.text.slice(0, 120) });
    return out;
  }

  private static parseJson(raw: string): Record<string, unknown> {
    if (!raw.trim()) return {};
    try {
      const v = JSON.parse(raw);
      return typeof v === 'object' && v !== null ? v : {};
    } catch {
      return {};
    }
  }

  private async *sseEvents(res: Response): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as any) {
      buf += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  }

  private async streamAnthropic(
    messages: { role: string; content: InternalContent }[],
    queue: AsyncQueue<TurnEvent>,
    signal: AbortSignal,
    summarySystem: string,
    estimate: TokenCostEstimate,
    requestModel: string
  ): Promise<void> {
    const url = this.opts.baseUrl.trim();
    const defs = this.toolDefs();
    const tools = defs.length
      ? defs.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }))
      : undefined;
    const convo: { role: string; content: unknown }[] = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : m.content.map((part) => part.type === 'text'
          ? part
          : {
              type: 'image',
              source: {
                type: 'base64',
                media_type: part.mimeType,
                data: part.dataUrl.slice(part.dataUrl.indexOf(',') + 1),
              },
            }),
    }));

    let acc = '';
    const usage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    let toolRounds = 0;

    while (true) {
      // 工具趟数用完后强制收口，只许出文字
      const lastRound = !tools || toolRounds >= MAX_TOOL_ROUNDS;
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.opts.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: requestModel,
          max_tokens: this.opts.maxTokens,
          stream: true,
          ...([this.opts.systemPrompt, summarySystem].filter(Boolean).join('\n')
            ? { system: [this.opts.systemPrompt, summarySystem].filter(Boolean).join('\n') }
            : {}),
          ...(tools ? { tools, tool_choice: { type: lastRound ? 'none' : 'auto' } } : {}),
          messages: convo,
        }),
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        throw new UpstreamHttpError(classifyUpstreamHttpError(this.opts.provider, requestModel, res.status, body));
      }

      type Block =
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; inputJson: string };
      const blocks = new Map<number, Block>();
      let stopReason: string | null = null;

      for await (const data of this.sseEvents(res)) {
        if (!data || data === '[DONE]') continue;
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev.type === 'content_block_start' && ev.content_block) {
          if (ev.content_block.type === 'tool_use') {
            blocks.set(ev.index, {
              type: 'tool_use',
              id: ev.content_block.id,
              name: ev.content_block.name,
              inputJson: '',
            });
          } else if (ev.content_block.type === 'text') {
            blocks.set(ev.index, { type: 'text', text: '' });
          }
        } else if (ev.type === 'content_block_delta') {
          const block = blocks.get(ev.index);
          if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            if (block?.type === 'text') block.text += ev.delta.text;
            acc += ev.delta.text;
            queue.push({ type: 'delta', text: ev.delta.text });
          } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            queue.push({ type: 'thinking', text: ev.delta.thinking });
          } else if (ev.delta?.type === 'input_json_delta' && block?.type === 'tool_use') {
            block.inputJson += ev.delta.partial_json ?? '';
          }
        } else if (ev.type === 'message_start' && ev.message?.usage) {
          usage.input += ev.message.usage.input_tokens ?? 0;
          usage.cacheCreation += ev.message.usage.cache_creation_input_tokens ?? 0;
          usage.cacheRead += ev.message.usage.cache_read_input_tokens ?? 0;
        } else if (ev.type === 'message_delta') {
          if (ev.usage) usage.output += ev.usage.output_tokens ?? 0;
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        } else if (ev.type === 'error') {
          throw new Error(ev.error?.message ?? 'stream error');
        }
      }

      const ordered = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
      const toolUses = ordered.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
      if (lastRound || stopReason !== 'tool_use' || toolUses.length === 0) break;

      // 回填：assistant 的原始 content（文本 + tool_use），再补 user 的 tool_result
      convo.push({
        role: 'assistant',
        content: ordered
          .map((b) =>
            b.type === 'text'
              ? { type: 'text', text: b.text }
              : { type: 'tool_use', id: b.id, name: b.name, input: DirectApiBackend.parseJson(b.inputJson) }
          )
          .filter((b) => b.type !== 'text' || (b as any).text.trim() !== ''),
      });
      const results: unknown[] = [];
      for (const tu of toolUses) {
        const r = await this.execTool(tu.name, DirectApiBackend.parseJson(tu.inputJson), queue);
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: r.text,
          ...(r.ok ? {} : { is_error: true }),
        });
      }
      convo.push({ role: 'user', content: results });
      toolRounds++;
    }

    queue.push({ type: 'done', finalText: acc, usage: { ...usage, estimate } });
  }

  private async streamOpenAi(
    messages: { role: string; content: InternalContent }[],
    queue: AsyncQueue<TurnEvent>,
    signal: AbortSignal,
    summarySystem: string,
    estimate: TokenCostEstimate,
    requestModel: string
  ): Promise<void> {
    const url = this.opts.baseUrl.trim();
    const defs = this.toolDefs();
    const tools = defs.length
      ? defs.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.schema },
        }))
      : undefined;
    const convo: Record<string, unknown>[] = [
      ...([this.opts.systemPrompt, summarySystem].filter(Boolean).join('\n')
        ? [{ role: 'system', content: [this.opts.systemPrompt, summarySystem].filter(Boolean).join('\n') }]
        : []),
      ...messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content
          : m.content.map((part) => part.type === 'text'
            ? part
            : { type: 'image_url', image_url: { url: part.dataUrl } }),
      })),
    ];

    let acc = '';
    const usage = { input: 0, output: 0, cacheRead: 0 };
    let toolRounds = 0;

    while (true) {
      const lastRound = !tools || toolRounds >= MAX_TOOL_ROUNDS;
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: requestModel,
          stream: true,
          stream_options: { include_usage: true },
          // Bound total completion (incl. reasoning_content for GLM-style models).
          // Anthropic/Gemini already send max_tokens; openai-compat was uncapped and
          // room turns with larger context could burn a long time in pure thinking.
          max_tokens: this.opts.maxTokens,
          ...(tools ? { tools, tool_choice: lastRound ? 'none' : 'auto' } : {}),
          messages: convo,
        }),
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        throw new UpstreamHttpError(classifyUpstreamHttpError(this.opts.provider, requestModel, res.status, body));
      }

      let roundText = '';
      const toolCalls = new Map<number, { id: string; name: string; args: string }>();

      for await (const data of this.sseEvents(res)) {
        if (!data) continue;
        if (data === '[DONE]') break;
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        const delta = ev.choices?.[0]?.delta;
        if (delta?.content) {
          roundText += delta.content;
          acc += delta.content;
          queue.push({ type: 'delta', text: delta.content });
        }
        if (delta?.reasoning_content) {
          queue.push({ type: 'thinking', text: delta.reasoning_content });
        }
        for (const tc of delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const entry = toolCalls.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          toolCalls.set(idx, entry);
        }
        if (ev.usage) {
          usage.input += ev.usage.prompt_tokens ?? ev.usage.input_tokens ?? 0;
          usage.output += ev.usage.completion_tokens ?? ev.usage.output_tokens ?? 0;
          usage.cacheRead += ev.usage.prompt_cache_hit_tokens ?? 0;
        }
      }

      if (lastRound || toolCalls.size === 0) break;

      const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
      convo.push({
        role: 'assistant',
        content: roundText || null,
        tool_calls: calls.map((c, i) => ({
          id: c.id || `call_${toolRounds}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: c.args || '{}' },
        })),
      });
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        const r = await this.execTool(c.name, DirectApiBackend.parseJson(c.args), queue);
        convo.push({
          role: 'tool',
          tool_call_id: c.id || `call_${toolRounds}_${i}`,
          content: r.text,
        });
      }
      toolRounds++;
    }

    queue.push({ type: 'done', finalText: acc, usage: { ...usage, estimate } });
  }

  private async streamGemini(
    messages: { role: string; content: InternalContent }[],
    queue: AsyncQueue<TurnEvent>,
    signal: AbortSignal,
    summarySystem: string,
    estimate: TokenCostEstimate,
    requestModel: string
  ): Promise<void> {
    // Gemini 的模型名在 URL 路径里。只替换显式占位符，绝不擅自追加 /v1/...。
    const url = this.opts.baseUrl.trim().split('{model}').join(encodeURIComponent(requestModel));
    const defs = this.toolDefs();
    const tools = defs.length
      ? [{
          functionDeclarations: defs.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.schema,
          })),
        }]
      : undefined;
    const convo: { role: 'user' | 'model'; parts: Record<string, unknown>[] }[] = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: (typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content)
        .map((part) => part.type === 'text'
          ? { text: part.text }
          : {
              inlineData: {
                mimeType: part.mimeType,
                data: part.dataUrl.slice(part.dataUrl.indexOf(',') + 1),
              },
            }),
    }));

    let acc = '';
    // output 按轮累加（每趟新生成的 token 都计费）。
    // input/cacheRead：多工具轮若对各趟 promptTokenCount 简单相加会把共享前缀重复计入，
    // UI「本轮 input」虚高 ×1.5–3；展示口径改用最终轮，round 累加写入 inputRoundsSum 供对照。
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      inputRoundsSum: 0,
      providerRounds: 0,
    };
    let toolRounds = 0;

    while (true) {
      const lastRound = !tools || toolRounds >= MAX_TOOL_ROUNDS;
      const systemText = [this.opts.systemPrompt, summarySystem].filter(Boolean).join('\n');
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.opts.apiKey,
        },
        body: JSON.stringify({
          contents: convo,
          ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
          ...(tools
            ? {
                tools,
                toolConfig: {
                  functionCallingConfig: { mode: lastRound ? 'NONE' : 'AUTO' },
                },
              }
            : {}),
          generationConfig: { maxOutputTokens: this.opts.maxTokens },
        }),
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        throw new UpstreamHttpError(classifyUpstreamHttpError(this.opts.provider, requestModel, res.status, body));
      }

      // 每个 Part 原样保存。thoughtSignature 可能在 functionCall Part 或独立空 Part
      // 上，合并、重建或过滤都会让下一趟请求被 Gemini 3 拒绝。
      const roundParts: Record<string, any>[] = [];
      let roundInput = 0;
      let roundOutput = 0;
      let roundCacheRead = 0;

      for await (const data of this.sseEvents(res)) {
        if (!data || data === '[DONE]') continue;
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev.error) throw new Error(ev.error.message ?? 'Gemini stream error');

        for (const candidate of ev.candidates ?? []) {
          for (const part of candidate.content?.parts ?? []) {
            roundParts.push(part);
            if (typeof part.text === 'string' && part.text) {
              if (part.thought === true) {
                queue.push({ type: 'thinking', text: part.text });
              } else {
                acc += part.text;
                queue.push({ type: 'delta', text: part.text });
              }
            }
          }
        }
        if (ev.usageMetadata) {
          // Gemini 在同一请求的流式块里报告累计值，取最大值避免重复相加。
          roundInput = Math.max(roundInput, ev.usageMetadata.promptTokenCount ?? 0);
          roundOutput = Math.max(
            roundOutput,
            (ev.usageMetadata.candidatesTokenCount ?? 0) + (ev.usageMetadata.thoughtsTokenCount ?? 0)
          );
          roundCacheRead = Math.max(roundCacheRead, ev.usageMetadata.cachedContentTokenCount ?? 0);
        }
      }
      usage.providerRounds += 1;
      usage.inputRoundsSum += roundInput;
      // 展示口径：最终（最新）请求的 prompt / cache，不把各趟相加。
      usage.input = roundInput;
      usage.cacheRead = roundCacheRead;
      usage.output += roundOutput;

      const calls = roundParts
        .map((part, index) => ({ part, index, call: part.functionCall }))
        .filter((entry): entry is {
          part: Record<string, any>;
          index: number;
          call: { name: string; args?: Record<string, unknown>; id?: string };
        } => Boolean(entry.call?.name));
      if (lastRound || calls.length === 0) break;

      // 这是修复 thought_signature 400 的关键：把服务端刚吐出的全部 parts
      // 一字不改地作为 model content 放回下一次 contents。
      convo.push({ role: 'model', parts: roundParts });
      const resultParts: Record<string, unknown>[] = [];
      for (const { call } of calls) {
        const r = await this.execTool(call.name, call.args ?? {}, queue);
        resultParts.push({
          functionResponse: {
            name: call.name,
            ...(call.id ? { id: call.id } : {}),
            response: { output: r.text, ok: r.ok },
          },
        });
      }
      convo.push({ role: 'user', parts: resultParts });
      toolRounds++;
    }

    this.opts.log(
      `gemini usage display.input=${usage.input} roundsSum=${usage.inputRoundsSum} ` +
        `output=${usage.output} cacheRead=${usage.cacheRead} providerRounds=${usage.providerRounds}`
    );
    queue.push({ type: 'done', finalText: acc, usage: { ...usage, estimate } });
  }
}
