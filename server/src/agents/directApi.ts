import type { ConversationSummaryRow, Db, MessageRow } from '../db.js';
import { attachmentDataUrl, attachmentsForMessage } from '../attachments.js';
import type { VaultClient } from '../memory/vaultClient.js';
import type { GatewayTool } from './gatewayTools.js';
import {
  AsyncQueue,
  type AgentBackend,
  type TokenCostEstimate,
  type TurnEvent,
  type TurnHandle,
} from './types.js';

export interface DirectApiBackendOpts {
  provider: 'anthropic' | 'openai-compat';
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Optional model used only when the turn contains images. Keeps the normal chat model unchanged. */
  visionModel?: string;
  systemPrompt?: string; // persona + 网关注入的记忆 preamble
  /** 单独标记记忆前缀，便于本地成本分项；不改变实际 prompt。 */
  memoryPreamble?: string;
  maxHistoryMessages: number;
  historyTokenBudget: number;
  minRecentTurns: number;
  summaryMaxTokens: number;
  historySummaryStrategy: 'extractive' | 'off';
  maxTokens: number;
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
const MAX_TOOL_ROUNDS = 4;
/** 单次工具结果回填上限（字符） */
const TOOL_RESULT_MAX_CHARS = 12_000;

/** 中日韩字符通常接近 1 token；其余文本按约 4 字符/token。仅作本地趋势估算。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff]/.test(ch)) cjk++;
    else other++;
  }
  return Math.max(0, Math.ceil(cjk + other / 4));
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

  private summaryLine(r: MessageRow): string {
    const room = this.opts.roomMode;
    const who = room
      ? room.nameOf(r.sender)
      : r.role === 'assistant'
        ? '助手'
        : 'User';
    const compact = r.content.replace(/\s+/g, ' ').trim().slice(0, 240);
    return `- ${who}：${compact}`;
  }

  private compactSummary(existing: string, rows: MessageRow[]): string {
    const appended = [existing.trim(), ...rows.map((r) => this.summaryLine(r))]
      .filter(Boolean)
      .join('\n');
    const maxTokens = Math.max(
      Math.min(this.opts.summaryMaxTokens, this.opts.historyTokenBudget - 512),
      256
    );
    if (estimateTokens(appended) <= maxTokens) return appended;
    // 保留更新、更可能仍影响当前对话的尾部；显式标记早期内容已淘汰。
    const prefix = '[更早的摘要已按预算淘汰]\n';
    let low = 0;
    let high = appended.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (estimateTokens(prefix + appended.slice(mid)) <= maxTokens) high = mid;
      else low = mid + 1;
    }
    return prefix + appended.slice(low);
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

  private hasImages(history: HistoryBuild): boolean {
    return history.messages.some(
      (message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image')
    );
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
      const rawBudget = Math.max(this.opts.historyTokenBudget - estimateTokens(summaryBlock), 512);
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
    });

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
        const requestModel = this.hasImages(history) && this.opts.visionModel
          ? this.opts.visionModel
          : this.opts.model;
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
          message: abort.signal.aborted ? '请求超时/被打断' : `API 请求失败：${e.message}`,
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
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/v1/messages`;
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
        throw new Error(`${res.status} ${body.slice(0, 200)}`);
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
    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
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
    const usage = { input: 0, output: 0 };
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
          ...(tools ? { tools, tool_choice: lastRound ? 'none' : 'auto' } : {}),
          messages: convo,
        }),
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        throw new Error(`${res.status} ${body.slice(0, 200)}`);
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
}
