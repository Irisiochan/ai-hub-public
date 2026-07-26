import type { TokenUsage, TurnEvent } from '../types.js';

export interface ImageContentPart {
  type: 'image';
  mimeType: string;
  dataUrl: string;
}

export type InternalContent = string | Array<{ type: 'text'; text: string } | ImageContentPart>;

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: InternalContent;
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface ProviderTools {
  definitions: ProviderToolDefinition[];
  allowCalls: boolean;
}

export interface ProviderSystemPrompt {
  static: string;
  summary: string;
}

export type PromptCacheMode = 'auto' | 'off';

export interface PromptCachePolicy {
  mode: PromptCacheMode;
  ttl: '1h';
}

export interface ProviderToolCall {
  id?: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderToolResult extends ProviderToolCall {
  ok: boolean;
  text: string;
}

export interface ProviderRoundUsage {
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
}

export type ProviderUsage = Omit<TokenUsage, 'estimate'>;

export interface ProviderRoundResult {
  calls: ProviderToolCall[];
  response: unknown;
  usage: ProviderRoundUsage;
}

export type ProviderStreamEvent =
  | Extract<TurnEvent, { type: 'delta' | 'thinking' }>
  | { type: 'round'; result: ProviderRoundResult };

export interface DirectApiProvider<TConversation = unknown> {
  createConversation(messages: HistoryMessage[], system: ProviderSystemPrompt): TConversation;
  applyCacheBreakpoints(
    conversation: TConversation,
    tools: ProviderTools,
    cachePolicy: PromptCachePolicy
  ): TConversation;
  stream(
    conversation: TConversation,
    tools: ProviderTools,
    signal: AbortSignal
  ): AsyncIterable<ProviderStreamEvent>;
  appendToolResults(
    conversation: TConversation,
    response: unknown,
    results: ProviderToolResult[]
  ): void;
  createUsage(): ProviderUsage;
  mergeUsage(total: ProviderUsage, round: ProviderRoundUsage): void;
  usageLog?(usage: ProviderUsage): string;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  promptCache: PromptCacheMode;
}

export class ProviderHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}`);
  }
}

export function parseJson(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? value : {};
  } catch {
    return {};
  }
}

export async function* sseEvents(res: Response): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as any) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
}
