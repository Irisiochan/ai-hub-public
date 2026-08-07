import type {
  DirectApiProvider,
  HistoryMessage,
  ProviderConfig,
  ProviderRoundUsage,
  PromptCachePolicy,
  ProviderStreamEvent,
  ProviderSystemPrompt,
  ProviderToolResult,
  ProviderTools,
  ProviderUsage,
} from './provider.js';
import { parseJson, ProviderHttpError, sseEvents } from './provider.js';
import { DsmlTextFilter } from './dsml.js';

interface OpenAiConversation {
  messages: Record<string, unknown>[];
  toolRound: number;
}

interface OpenAiCall {
  id: string;
  name: string;
  args: string;
}

interface OpenAiRoundResponse {
  text: string;
  calls: OpenAiCall[];
}

export class OpenAiProvider implements DirectApiProvider<OpenAiConversation> {
  constructor(private config: ProviderConfig) {}

  createConversation(messages: HistoryMessage[], system: ProviderSystemPrompt): OpenAiConversation {
    const systemText = [system.static, system.summary].filter(Boolean).join('\n');
    return {
      toolRound: 0,
      messages: [
        ...(systemText ? [{ role: 'system', content: systemText }] : []),
        ...messages.map((message) => ({
          role: message.role,
          content: typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => part.type === 'text'
              ? part
              : { type: 'image_url', image_url: { url: part.dataUrl } }),
        })),
      ],
    };
  }

  applyCacheBreakpoints(
    conversation: OpenAiConversation,
    _tools: ProviderTools,
    _cachePolicy: PromptCachePolicy
  ): OpenAiConversation {
    return conversation;
  }

  async *stream(
    conversation: OpenAiConversation,
    tools: ProviderTools,
    signal: AbortSignal
  ): AsyncIterable<ProviderStreamEvent> {
    const definitions = tools.definitions.length
      ? tools.definitions.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.schema },
        }))
      : undefined;
    const res = await fetch(this.config.baseUrl.trim(), {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: this.config.maxTokens,
        ...(definitions ? { tools: definitions, tool_choice: tools.allowCalls ? 'auto' : 'none' } : {}),
        messages: conversation.messages,
      }),
    });
    if (!res.ok || !res.body) {
      throw new ProviderHttpError(res.status, await res.text().catch(() => ''));
    }

    let roundText = '';
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    const usage: ProviderRoundUsage = { input: 0, output: 0, cacheRead: 0 };
    const dsml = new DsmlTextFilter();

    for await (const data of sseEvents(res)) {
      if (!data) continue;
      if (data === '[DONE]') break;
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = event.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) {
        const visible = dsml.push(delta.content);
        if (visible) {
          roundText += visible;
          yield { type: 'delta', text: visible };
        }
      }
      if (delta?.reasoning_content) yield { type: 'thinking', text: delta.reasoning_content };
      for (const toolCall of delta?.tool_calls ?? []) {
        const index = toolCall.index ?? 0;
        const entry = toolCalls.get(index) ?? { id: '', name: '', args: '' };
        if (toolCall.id) entry.id = toolCall.id;
        if (toolCall.function?.name) entry.name = toolCall.function.name;
        if (toolCall.function?.arguments) entry.args += toolCall.function.arguments;
        toolCalls.set(index, entry);
      }
      // 单次 HTTP 流的 usage 是整请求汇总，不是 delta。OpenAI/DeepSeek 规范只在
      // 末包带非空 usage；部分中转（openrouter/硅基流动等）会在每个 chunk 重复塞
      // 同一份 prompt_tokens。这里用 last-write，禁止 +=，否则长文（如 3万 token
      // 输出 × 每包都带 usage）会把「本轮」吹到百万级。
      if (event.usage && typeof event.usage === 'object') {
        const input = event.usage.prompt_tokens ?? event.usage.input_tokens;
        const output = event.usage.completion_tokens ?? event.usage.output_tokens;
        const cacheRead = event.usage.prompt_cache_hit_tokens
          ?? event.usage.prompt_tokens_details?.cached_tokens;
        if (typeof input === 'number') usage.input = input;
        if (typeof output === 'number') usage.output = output;
        if (typeof cacheRead === 'number') usage.cacheRead = cacheRead;
      }
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
        usage.finishReason = choice.finish_reason;
      }
    }

    const tail = dsml.finish();
    if (tail.visible) {
      roundText += tail.visible;
      yield { type: 'delta', text: tail.visible };
    }
    if (tail.detected && tail.calls.length === 0) {
      throw new Error('上游返回了无法解析的 DSML 工具调用标记');
    }

    const standardCalls = [...toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call], index) => ({
      ...call,
      id: call.id || `call_${conversation.toolRound}_${index}`,
    }));
    const calls = [...standardCalls];
    const seen = new Set(calls.map((call) => `${call.name}\u0000${JSON.stringify(parseJson(call.args))}`));
    for (const call of tail.calls) {
      const key = `${call.name}\u0000${JSON.stringify(call.input)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({ id: `call_${conversation.toolRound}_${calls.length}`, name: call.name, args: JSON.stringify(call.input) });
    }
    yield {
      type: 'round',
      result: {
        calls: calls.map((call) => ({ id: call.id, name: call.name, input: parseJson(call.args) })),
        response: { text: roundText, calls } satisfies OpenAiRoundResponse,
        usage,
        text: roundText,
      },
    };
  }

  appendToolResults(
    conversation: OpenAiConversation,
    response: unknown,
    results: ProviderToolResult[]
  ): void {
    const { text, calls } = response as OpenAiRoundResponse;
    conversation.messages.push({
      role: 'assistant',
      content: text || null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.args || '{}' },
      })),
    });
    for (const result of results) {
      conversation.messages.push({ role: 'tool', tool_call_id: result.id, content: result.text });
    }
    conversation.toolRound++;
  }

  createUsage(): ProviderUsage {
    return this.config.promptCache === 'off'
      ? { input: 0, output: 0 }
      : { input: 0, output: 0, cacheRead: 0 };
  }

  mergeUsage(total: ProviderUsage, round: ProviderRoundUsage): void {
    total.input += round.input;
    total.output += round.output;
    if (this.config.promptCache !== 'off') {
      total.cacheRead = (total.cacheRead ?? 0) + (round.cacheRead ?? 0);
    }
    if (round.finishReason) total.finishReason = round.finishReason;
  }
}
