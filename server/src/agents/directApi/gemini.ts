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
import { ProviderHttpError, sseEvents } from './provider.js';

interface GeminiConversation {
  contents: { role: 'user' | 'model'; parts: Record<string, unknown>[] }[];
  system: string;
}

interface GeminiCall {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
}

interface GeminiRoundResponse {
  parts: Record<string, any>[];
}

/**
 * Gemini 原生 finishReason（如 MAX_TOKENS / STOP）归一成与 OpenAI 兼容的小写标签，
 * 好让 message meta 与前端 `outputLimitWarning`（认 `length`）共用一条路径。
 */
export function normalizeGeminiFinishReason(reason: string): string {
  const upper = reason.trim().toUpperCase();
  if (upper === 'MAX_TOKENS') return 'length';
  if (upper === 'STOP') return 'stop';
  return reason.trim().toLowerCase();
}

export class GeminiProvider implements DirectApiProvider<GeminiConversation> {
  constructor(
    private config: ProviderConfig,
    private log: (message: string) => void = () => {}
  ) {}

  createConversation(messages: HistoryMessage[], system: ProviderSystemPrompt): GeminiConversation {
    return {
      system: [system.static, system.summary].filter(Boolean).join('\n'),
      contents: messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: (typeof message.content === 'string'
          ? [{ type: 'text' as const, text: message.content }]
          : message.content
        ).map((part) => part.type === 'text'
          ? { text: part.text }
          : {
              inlineData: {
                mimeType: part.mimeType,
                data: part.dataUrl.slice(part.dataUrl.indexOf(',') + 1),
              },
            }),
      })),
    };
  }

  applyCacheBreakpoints(
    conversation: GeminiConversation,
    _tools: ProviderTools,
    _cachePolicy: PromptCachePolicy
  ): GeminiConversation {
    return conversation;
  }

  async *stream(
    conversation: GeminiConversation,
    tools: ProviderTools,
    signal: AbortSignal
  ): AsyncIterable<ProviderStreamEvent> {
    const url = this.config.baseUrl.trim().split('{model}').join(encodeURIComponent(this.config.model));
    const definitions = tools.definitions.length
      ? [{
          functionDeclarations: tools.definitions.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.schema,
          })),
        }]
      : undefined;
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.config.apiKey,
      },
      body: JSON.stringify({
        contents: conversation.contents,
        ...(conversation.system ? { systemInstruction: { parts: [{ text: conversation.system }] } } : {}),
        ...(definitions
          ? {
              tools: definitions,
              toolConfig: { functionCallingConfig: { mode: tools.allowCalls ? 'AUTO' : 'NONE' } },
            }
          : {}),
        generationConfig: { maxOutputTokens: this.config.maxTokens },
      }),
    });
    if (!res.ok || !res.body) {
      throw new ProviderHttpError(res.status, await res.text().catch(() => ''));
    }

    // 每个 Part 原样保存。thoughtSignature 可能在 functionCall Part 或独立空 Part上，
    // 合并、重建或过滤都会让下一趟请求被 Gemini 3 拒绝。
    const parts: Record<string, any>[] = [];
    const usage: ProviderRoundUsage = { input: 0, output: 0, cacheRead: 0 };

    for await (const data of sseEvents(res)) {
      if (!data || data === '[DONE]') continue;
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.error) throw new Error(event.error.message ?? 'Gemini stream error');
      for (const candidate of event.candidates ?? []) {
        if (typeof candidate.finishReason === 'string' && candidate.finishReason) {
          // 流式多包会重复带同一 finishReason；以最后一次非空为准。
          usage.finishReason = normalizeGeminiFinishReason(candidate.finishReason);
        }
        for (const part of candidate.content?.parts ?? []) {
          parts.push(part);
          if (typeof part.text === 'string' && part.text) {
            yield part.thought === true
              ? { type: 'thinking', text: part.text }
              : { type: 'delta', text: part.text };
          }
        }
      }
      if (event.usageMetadata) {
        this.log(`gemini usageMetadata=${JSON.stringify(event.usageMetadata)}`);
        usage.input = Math.max(usage.input, event.usageMetadata.promptTokenCount ?? 0);
        usage.output = Math.max(
          usage.output,
          (event.usageMetadata.candidatesTokenCount ?? 0) + (event.usageMetadata.thoughtsTokenCount ?? 0)
        );
        usage.cacheRead = Math.max(usage.cacheRead ?? 0, event.usageMetadata.cachedContentTokenCount ?? 0);
      }
    }

    const calls = parts
      .map((part) => part.functionCall as GeminiCall | undefined)
      .filter((call): call is GeminiCall => Boolean(call?.name))
      .map((call) => ({ id: call.id, name: call.name, input: call.args ?? {} }));
    yield {
      type: 'round',
      result: {
        calls,
        response: { parts } satisfies GeminiRoundResponse,
        usage,
        text: parts.flatMap((part) => !part.thought && typeof part.text === 'string' ? [part.text] : []).join(''),
      },
    };
  }

  appendToolResults(
    conversation: GeminiConversation,
    response: unknown,
    results: ProviderToolResult[]
  ): void {
    const { parts } = response as GeminiRoundResponse;
    // 服务端刚吐出的全部 parts 必须一字不改地放回下一次 contents。
    conversation.contents.push({ role: 'model', parts });
    conversation.contents.push({
      role: 'user',
      parts: results.map((result) => ({
        functionResponse: {
          name: result.name,
          ...(result.id ? { id: result.id } : {}),
          response: { output: result.text, ok: result.ok },
        },
      })),
    });
  }

  createUsage(): ProviderUsage {
    return {
      input: 0,
      output: 0,
      ...(this.config.promptCache === 'off' ? {} : { cacheRead: 0 }),
      inputRoundsSum: 0,
      providerRounds: 0,
    };
  }

  mergeUsage(total: ProviderUsage, round: ProviderRoundUsage): void {
    total.providerRounds = (total.providerRounds ?? 0) + 1;
    total.inputRoundsSum = (total.inputRoundsSum ?? 0) + round.input;
    // UI 展示口径取最终轮；round 累加单列保留供计费对照。
    total.input = round.input;
    if (this.config.promptCache !== 'off') total.cacheRead = round.cacheRead ?? 0;
    total.output += round.output;
    if (round.finishReason) total.finishReason = round.finishReason;
  }

  usageLog(usage: ProviderUsage): string {
    return `gemini usage display.input=${usage.input} roundsSum=${usage.inputRoundsSum ?? 0} ` +
      `output=${usage.output} ` +
      (this.config.promptCache === 'off' ? '' : `cacheRead=${usage.cacheRead ?? 0} `) +
      `providerRounds=${usage.providerRounds ?? 0}` +
      (usage.finishReason ? ` finishReason=${usage.finishReason}` : '');
  }
}
