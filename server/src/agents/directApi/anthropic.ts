import type {
  DirectApiProvider,
  HistoryMessage,
  ProviderConfig,
  ProviderRoundUsage,
  PromptCachePolicy,
  ProviderStreamEvent,
  ProviderSystemPrompt,
  ProviderToolCall,
  ProviderToolResult,
  ProviderTools,
  ProviderUsage,
} from './provider.js';
import { parseJson, ProviderHttpError, sseEvents } from './provider.js';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; inputJson: string };

interface AnthropicConversation {
  messages: { role: string; content: unknown }[];
  system: AnthropicTextBlock[];
  toolCacheEnabled: boolean;
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl: '1h' };
}

interface AnthropicRoundResponse {
  ordered: AnthropicBlock[];
}

export class AnthropicProvider implements DirectApiProvider<AnthropicConversation> {
  private breakpoints = 0;

  constructor(
    private config: ProviderConfig,
    private log: (message: string) => void = () => {}
  ) {}

  createConversation(messages: HistoryMessage[], system: ProviderSystemPrompt): AnthropicConversation {
    return {
      system: [system.static, system.summary]
        .filter(Boolean)
        .map((text) => ({ type: 'text', text })),
      toolCacheEnabled: false,
      messages: messages.map((message) => ({
        role: message.role,
        content: typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => part.type === 'text'
            ? part
            : {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: part.mimeType,
                  data: part.dataUrl.slice(part.dataUrl.indexOf(',') + 1),
                },
              }),
      })),
    };
  }

  applyCacheBreakpoints(
    conversation: AnthropicConversation,
    tools: ProviderTools,
    cachePolicy: PromptCachePolicy
  ): AnthropicConversation {
    const withoutCacheControl = (value: unknown): unknown => {
      if (!Array.isArray(value)) return value;
      return value.map((part) => {
        if (!part || typeof part !== 'object') return part;
        const { cache_control: _ignored, ...rest } = part as Record<string, unknown>;
        return rest;
      });
    };
    conversation.system = withoutCacheControl(conversation.system) as AnthropicTextBlock[];
    conversation.messages = conversation.messages.map((message) => ({
      ...message,
      content: withoutCacheControl(message.content),
    }));
    conversation.toolCacheEnabled = false;
    this.breakpoints = 0;
    if (cachePolicy.mode === 'off') return conversation;

    const marker = { type: 'ephemeral' as const, ttl: cachePolicy.ttl };
    for (const block of conversation.system) {
      block.cache_control = marker;
      this.breakpoints++;
    }
    if (tools.definitions.length > 0) {
      conversation.toolCacheEnabled = true;
      this.breakpoints++;
    }
    const historyTail = conversation.messages.at(-2);
    if (historyTail) {
      const content = typeof historyTail.content === 'string'
        ? [{ type: 'text', text: historyTail.content }]
        : Array.isArray(historyTail.content) ? historyTail.content : [];
      let textIndex = -1;
      for (let index = content.length - 1; index >= 0; index--) {
        const part = content[index] as any;
        if (part?.type === 'text' && part.text) {
          textIndex = index;
          break;
        }
      }
      if (textIndex >= 0) {
        content[textIndex] = { ...(content[textIndex] as object), cache_control: marker };
        historyTail.content = content;
        this.breakpoints++;
      }
    }
    this.log(`provider=anthropic cache_policy=auto breakpoints=${this.breakpoints} ttl=${cachePolicy.ttl}`);
    return conversation;
  }

  async *stream(
    conversation: AnthropicConversation,
    tools: ProviderTools,
    signal: AbortSignal
  ): AsyncIterable<ProviderStreamEvent> {
    const definitions = tools.definitions.length
      ? tools.definitions.map((tool, index) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.schema,
          ...(conversation.toolCacheEnabled && index === tools.definitions.length - 1
            ? { cache_control: { type: 'ephemeral', ttl: '1h' } }
            : {}),
        }))
      : undefined;
    const res = await fetch(this.config.baseUrl.trim(), {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        stream: true,
        ...(conversation.system.length ? { system: conversation.system } : {}),
        ...(definitions
          ? { tools: definitions, tool_choice: { type: tools.allowCalls ? 'auto' : 'none' } }
          : {}),
        messages: conversation.messages,
      }),
    });
    if (!res.ok || !res.body) {
      throw new ProviderHttpError(res.status, await res.text().catch(() => ''));
    }

    const blocks = new Map<number, AnthropicBlock>();
    const usage: ProviderRoundUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    let stopReason: string | null = null;

    for await (const data of sseEvents(res)) {
      if (!data || data === '[DONE]') continue;
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === 'content_block_start' && event.content_block) {
        if (event.content_block.type === 'tool_use') {
          blocks.set(event.index, {
            type: 'tool_use',
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: '',
          });
        } else if (event.content_block.type === 'text') {
          blocks.set(event.index, { type: 'text', text: '' });
        }
      } else if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index);
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          if (block?.type === 'text') block.text += event.delta.text;
          yield { type: 'delta', text: event.delta.text };
        } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
          yield { type: 'thinking', text: event.delta.thinking };
        } else if (event.delta?.type === 'input_json_delta' && block?.type === 'tool_use') {
          block.inputJson += event.delta.partial_json ?? '';
        }
      } else if (event.type === 'message_start' && event.message?.usage) {
        usage.input += event.message.usage.input_tokens ?? 0;
        usage.cacheCreation! += event.message.usage.cache_creation_input_tokens ?? 0;
        usage.cacheRead! += event.message.usage.cache_read_input_tokens ?? 0;
      } else if (event.type === 'message_delta') {
        if (event.usage) usage.output += event.usage.output_tokens ?? 0;
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
      } else if (event.type === 'error') {
        throw new Error(event.error?.message ?? 'stream error');
      }
    }

    const ordered = [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block);
    const calls: ProviderToolCall[] = stopReason === 'tool_use'
      ? ordered
          .filter((block): block is Extract<AnthropicBlock, { type: 'tool_use' }> => block.type === 'tool_use')
          .map((block) => ({ id: block.id, name: block.name, input: parseJson(block.inputJson) }))
      : [];
    if (stopReason) {
      // Anthropic: max_tokens；与 OpenAI length / Gemini MAX_TOKENS 对齐为 UI 可读标签。
      usage.finishReason = stopReason === 'max_tokens' ? 'length' : stopReason;
    }
    yield {
      type: 'round',
      result: {
        calls,
        response: { ordered } satisfies AnthropicRoundResponse,
        usage,
        text: ordered.flatMap((block) => block.type === 'text' ? [block.text] : []).join(''),
      },
    };
  }

  appendToolResults(
    conversation: AnthropicConversation,
    response: unknown,
    results: ProviderToolResult[]
  ): void {
    const { ordered } = response as AnthropicRoundResponse;
    conversation.messages.push({
      role: 'assistant',
      content: ordered
        .filter((block) => block.type !== 'text' || block.text.trim() !== '')
        .map((block) => block.type === 'text'
          ? { type: 'text', text: block.text }
          : { type: 'tool_use', id: block.id, name: block.name, input: parseJson(block.inputJson) }),
    });
    conversation.messages.push({
      role: 'user',
      content: results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.id,
        content: result.text,
        ...(result.ok ? {} : { is_error: true }),
      })),
    });
  }

  createUsage(): ProviderUsage {
    return this.config.promptCache === 'off'
      ? { input: 0, output: 0 }
      : { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  }

  mergeUsage(total: ProviderUsage, round: ProviderRoundUsage): void {
    total.input += round.input;
    total.output += round.output;
    if (this.config.promptCache !== 'off') {
      total.cacheCreation = (total.cacheCreation ?? 0) + (round.cacheCreation ?? 0);
      total.cacheRead = (total.cacheRead ?? 0) + (round.cacheRead ?? 0);
    }
    if (round.finishReason) total.finishReason = round.finishReason;
  }

  usageLog(usage: ProviderUsage): string {
    if (this.config.promptCache === 'off') return 'provider=anthropic cache_policy=off breakpoints=0';
    return `provider=anthropic breakpoints=${this.breakpoints} ` +
      `hit=${usage.cacheRead ?? 0} write=${usage.cacheCreation ?? 0}`;
  }
}
