import type { Db, MessageRow } from '../../db.js';
import { attachmentDataUrl, attachmentsForMessage } from '../../attachments.js';
import type { VaultClient } from '../../memory/vaultClient.js';
import { timestampedMessage } from '../../memory/inject.js';
import {
  compactSummaryText,
  summaryNeedsTimeAnchorUpgrade,
} from '../conversationSummary.js';
import type { GatewayTool } from '../gatewayTools.js';
import { estimateTokens } from '../tokenEstimate.js';
import { chooseKeepFrom } from '../historyPolicy.js';
import { ConversationSummaryRepo } from '../conversationSummaryRepo.js';
import { MessageRepo } from '../messageRepo.js';
import { quotedRoomMessage } from '../roomPrompt.js';
import { historicalMessageText } from '../sideChannel.js';
import {
  AsyncQueue,
  type AgentBackend,
  type TokenCostEstimate,
  type TurnInput,
  type TurnEvent,
  type TurnHandle,
} from '../types.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OpenAiProvider } from './openai.js';
import type {
  DirectApiProvider,
  HistoryMessage,
  InternalContent,
  ProviderToolDefinition,
  ProviderToolResult,
  PromptCachePolicy,
} from './provider.js';
import { ProviderHttpError } from './provider.js';

export { estimateTokens } from '../tokenEstimate.js';

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
  promptCache?: 'auto' | 'off';
  systemPrompt?: string; // persona + 网关注入的记忆 preamble
  /** 单独标记记忆前缀，便于本地成本分项；不改变实际 prompt。 */
  memoryPreamble?: string;
  /** Static prompt accounting is composed once by PromptComposer. */
  staticPromptTokens?: { system: number; memory: number };
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

/**
 * 摘要触发后一次压到低水位，给后续 turn 留出 headroom。
 * 这样 rolling summary 不会在达到 maxHistoryMessages 后每轮改写，API provider
 * 才能连续复用 system + summary + recent history 的相同前缀。
 */
export const SUMMARY_ROLLOVER_KEEP_RATIO = 0.8;

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

interface HistoryBuild {
  messages: HistoryMessage[];
  summarySystem: string;
  historyTokens: number;
  summaryTokens: number;
}

const MEMORY_TOOLS: { name: string; description: string; schema: Record<string, unknown> }[] = [
  {
    name: 'search_vault',
    description:
      '在 User 的共享记忆库中按关键词搜索（多个词空格分隔，AND 逻辑），返回匹配的文件清单。',
    schema: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description: '读取记忆库中某个文件的全文。path 是相对路径，例如 "memories/User-core.md"。',
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
  private readonly activeTurns = new Map<AbortController, Promise<void>>();
  private readonly summaries: ConversationSummaryRepo;
  private readonly messages: MessageRepo;
  private historyCache: {
    summaryVersion: number;
    throughMessageId: number;
    rows: MessageRow[];
    maxSeenId: number;
  } | null = null;

  constructor(private opts: DirectApiBackendOpts) {
    this.summaries = new ConversationSummaryRepo(opts.db);
    this.messages = new MessageRepo(opts.db);
  }

  invalidateHistory(_affectedFromId?: number): void {
    this.historyCache = null;
  }

  async start(_resumeToken: string | null): Promise<void> {
    if (!this.opts.apiKey) throw new Error('这个联系人还没配 API key（联系人设置里填）');
    if (!this.opts.model) throw new Error('这个联系人还没配 model');
    this.stopped = false;
  }

  alive(): boolean {
    return !this.stopped;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const turns = [...this.activeTurns.entries()];
    for (const [controller] of turns) controller.abort();
    await Promise.allSettled(turns.map(([, turn]) => turn));
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

  private history(
    currentText: string,
    currentMessageId?: number,
    roomMessageIds: readonly number[] = []
  ): HistoryBuild {
    const memberId = this.opts.memberId ?? '';
    let saved = this.summaries.get(this.opts.contactId, memberId);
    if (saved && summaryNeedsTimeAnchorUpgrade(saved.summary)) {
      const sourceRows = this.summaries.rowsThrough(
        this.opts.contactId,
        saved.through_message_id
      );
      if (sourceRows.length > 0) {
        const rebuilt = this.compactSummary('', sourceRows);
        this.summaries.update(
          this.opts.contactId,
          memberId,
          rebuilt,
          sourceRows[sourceRows.length - 1].id
        );
        this.opts.log(`history summary upgraded to time-anchor-v1 rows=${sourceRows.length}`);
      } else {
        this.summaries.delete(this.opts.contactId, memberId);
        this.opts.log('history summary upgrade dropped an expired legacy summary');
      }
      saved = this.summaries.get(this.opts.contactId, memberId);
      this.historyCache = null;
    }
    const summaryVersion = saved?.version ?? 0;
    const throughMessageId = saved?.through_message_id ?? 0;
    const cacheValid = this.historyCache
      && this.historyCache.summaryVersion === summaryVersion
      && this.historyCache.throughMessageId === throughMessageId;
    const cachedRows = cacheValid ? this.historyCache!.rows : [];
    const maxSeenId = cacheValid ? this.historyCache!.maxSeenId : throughMessageId;
    const added = this.messages.historyAfter(this.opts.contactId, maxSeenId);
    const rows = [...cachedRows, ...added];
    this.opts.log(
      `history cache ${cacheValid ? 'hit' : 'miss'} cached=${cachedRows.length} added=${added.length} version=${summaryVersion}`
    );

    const room = this.opts.roomMode;
    const serializedRowText = (row: MessageRow): string => {
      if (!room) return timestampedMessage(historicalMessageText(row), row.created_at, '历史消息');
      return row.sender === room.selfId
        ? timestampedMessage(row.content, row.created_at, '历史消息')
        : quotedRoomMessage({
          senderId: row.sender,
          senderName: room.nameOf(row.sender),
          content: row.content,
          createdAt: row.created_at,
          temporal: '历史消息',
        });
    };

    let summary = saved?.summary ?? '';
    let keepFrom = 0;
    // 本轮群消息必须完整留在原文窗口里，不能因联系人把 maxHistoryMessages
    // 配得比 roomDeliveryMaxMessages 小而提前压成“历史摘要”。
    const currentRoomCount = roomMessageIds.length;
    const hardMax = Math.max(this.opts.maxHistoryMessages, currentRoomCount, 2);
    const minimum = Math.min(
      Math.max(this.opts.minRecentTurns * 2, currentRoomCount, 2),
      hardMax
    );

    const selectKeepFrom = (maxMessages = hardMax, budgetRatio = 1) => {
      const summaryBlock = summary
        ? `# 对话滚动摘要（覆盖更早消息）\n${summary}`
        : '';
      const rawBudget = this.effectiveHistoryBudget(summaryBlock);
      const tokenBudget = Math.max(512, Math.floor(rawBudget * budgetRatio));
      return chooseKeepFrom(
        rows.map((row) => ({ content: serializedRowText(row) })),
        minimum,
        maxMessages,
        tokenBudget
      );
    };

    keepFrom = selectKeepFrom();
    // extractive / external 都走本地滚动摘要；external 仅表示「允许将来接 LLM」，当前不外发
    while (this.opts.historySummaryStrategy !== 'off' && keepFrom > 0) {
      // 高水位触发后不要只丢本轮溢出的 1–2 条，否则 summary/version 会每轮变化，
      // 把 Gemini/Anthropic 可复用的 request prefix 逐轮打碎。一次压到 80% 的消息/预算
      // 低水位；群聊仍以 currentRoomCount 为下限，本轮消息一条不丢。
      const lowWaterMax = Math.max(
        minimum,
        currentRoomCount,
        Math.floor(hardMax * SUMMARY_ROLLOVER_KEEP_RATIO)
      );
      const batchedKeepFrom = selectKeepFrom(
        lowWaterMax,
        SUMMARY_ROLLOVER_KEEP_RATIO
      );
      const dropCount = Math.max(keepFrom, batchedKeepFrom);
      if (dropCount > keepFrom) {
        this.opts.log(
          `history summary rollover triggerDrop=${keepFrom} batchDrop=${dropCount} ` +
          `targetMessages=${lowWaterMax} keepRatio=${SUMMARY_ROLLOVER_KEEP_RATIO}`
        );
      }
      const dropped = rows.splice(0, dropCount);
      summary = this.compactSummary(summary, dropped);
      const through = dropped[dropped.length - 1].id;
      this.summaries.upsert(this.opts.contactId, memberId, summary, through);
      keepFrom = selectKeepFrom();
    }

    // strategy=off 时仍按预算/条数裁掉旧原文，只是不持久化摘要。
    const kept = rows.slice(keepFrom);
    const finalSaved = this.summaries.get(this.opts.contactId, memberId);
    this.historyCache = {
      summaryVersion: finalSaved?.version ?? 0,
      throughMessageId: finalSaved?.through_message_id ?? 0,
      rows: [...kept],
      maxSeenId: rows.at(-1)?.id ?? maxSeenId,
    };

    const msgs = kept.map((r) => {
      if (room) {
        const anchored = serializedRowText(r);
        return r.sender === room.selfId
          ? { role: 'assistant' as const, content: this.contentForRow(r, anchored) }
          : { role: 'user' as const, content: this.contentForRow(r, anchored) };
      }
      return {
        role: r.role as 'user' | 'assistant',
        content: this.contentForRow(r, serializedRowText(r)),
      };
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
    const memory = this.opts.staticPromptTokens?.memory ?? estimateTokens(this.opts.memoryPreamble ?? '');
    const system = this.opts.staticPromptTokens?.system
      ?? Math.max(estimateTokens(this.opts.systemPrompt ?? '') - memory, 0);
    const estimate = {
      system,
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

  sendTurn(input: TurnInput): TurnHandle {
    const queue = new AsyncQueue<TurnEvent>();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.opts.turnTimeoutMs);

    const turn = (async () => {
      try {
        const history = this.history(input.text, input.userMessageId, input.roomMessageIds);
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
        await this.streamProvider(
          history,
          queue,
          abort.signal,
          estimate,
          requestModel
        );
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
    this.activeTurns.set(abort, turn);
    void turn.finally(() => this.activeTurns.delete(abort));

    return {
      events: queue,
      interrupt: async () => abort.abort(),
    };
  }

  /** 声明给模型的全部工具：记忆三件套（有 vault 时）+ 网关额外工具 */
  private toolDefs(): ProviderToolDefinition[] {
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

  private createProvider(requestModel: string): DirectApiProvider<any> {
    const config = {
      baseUrl: this.opts.baseUrl,
      apiKey: this.opts.apiKey,
      model: requestModel,
      maxTokens: this.opts.maxTokens,
      promptCache: this.opts.promptCache ?? 'auto',
    };
    if (this.opts.provider === 'anthropic') return new AnthropicProvider(config, this.opts.log);
    if (this.opts.provider === 'gemini') return new GeminiProvider(config, this.opts.log);
    return new OpenAiProvider(config);
  }

  private async streamProvider(
    history: HistoryBuild,
    queue: AsyncQueue<TurnEvent>,
    signal: AbortSignal,
    estimate: TokenCostEstimate,
    requestModel: string
  ): Promise<void> {
    const provider = this.createProvider(requestModel);
    const definitions = this.toolDefs();
    const cachePolicy: PromptCachePolicy = { mode: this.opts.promptCache ?? 'auto', ttl: '1h' };
    let conversation = provider.createConversation(history.messages, {
      static: this.opts.systemPrompt ?? '',
      summary: history.summarySystem,
    });
    const usage = provider.createUsage();
    let finalText = '';
    let toolRounds = 0;
    let finalRoundText = '';

    try {
      while (true) {
        const allowCalls = definitions.length > 0 && toolRounds < MAX_TOOL_ROUNDS;
        const tools = { definitions, allowCalls };
        conversation = provider.applyCacheBreakpoints(conversation, tools, cachePolicy);
        let round: import('./provider.js').ProviderRoundResult | undefined;
        for await (const event of provider.stream(
          conversation,
          tools,
          signal
        )) {
          if (event.type === 'round') {
            round = event.result;
          } else {
            if (event.type === 'delta') finalText += event.text;
            queue.push(event);
          }
        }
        if (!round) throw new Error('上游流结束但没有返回轮次结果');
        finalRoundText = round.text;
        provider.mergeUsage(usage, round.usage);
        if (!allowCalls || round.calls.length === 0) break;

        const results: ProviderToolResult[] = [];
        for (const call of round.calls) {
          const result = await this.execTool(call.name, call.input, queue);
          results.push({ ...call, ...result });
        }
        provider.appendToolResults(conversation, round.response, results);
        toolRounds++;
      }
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        throw new UpstreamHttpError(
          classifyUpstreamHttpError(this.opts.provider, requestModel, error.status, error.body)
        );
      }
      throw error;
    }

    const usageLog = provider.usageLog?.(usage);
    if (usageLog) this.opts.log(usageLog);
    if (!finalRoundText.trim()) {
      const suffix = usage.finishReason === 'length' ? '（输出预算已耗尽）' : '';
      throw new Error(`上游只返回了思考/工具过程，没有可显示的正文${suffix}`);
    }
    queue.push({ type: 'done', finalText, usage: { ...usage, estimate } });
  }
}
