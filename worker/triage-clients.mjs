import process from 'node:process';
import { estimateCostCny, parseTriageJson } from './triage-core.mjs';

function secretFromEnv(name) {
  if (!name) return '';
  return process.env[name]?.trim() ?? '';
}

async function jsonRequest(url, init, timeoutMs = 30_000) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error?.message ?? body.error ?? `${response.status} ${response.statusText}`);
  }
  return body;
}

export class DeepSeekClient {
  constructor(config, categories) {
    this.baseUrl = String(config.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');
    this.key = secretFromEnv(config.apiKeyEnv ?? 'DEEPSEEK_API_KEY');
    this.flashModel = config.flashModel ?? 'deepseek-v4-flash';
    this.proModel = config.proModel ?? 'deepseek-v4-pro';
    this.categories = categories;
    this.pricing = config.pricing ?? {};
    this.timeoutMs = Number(config.timeoutMs ?? 30_000);
    this.backlogMaxChars = Math.max(0, Number(config.backlogMaxChars ?? 2000));
    this.thinking = config.thinking?.type === 'enabled'
      ? { type: 'enabled' }
      : { type: 'disabled' };
  }

  async call(model, system, user, pricing = {}) {
    if (!this.key) throw new Error('DeepSeek API key environment variable is missing');
    const startedAt = performance.now();
    const body = await jsonRequest(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 400,
        thinking: this.thinking,
        // DeepSeek's OpenAI-compatible endpoint supports JSON mode. The worker
        // performs the stricter enum/type validation locally before routing.
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    }, this.timeoutMs);
    const content = body.choices?.[0]?.message?.content;
    return {
      result: parseTriageJson(content, this.categories),
      usage: body.usage ?? {},
      costCny: estimateCostCny(body.usage, pricing),
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }

  async triage(event, backlogSummary) {
    const system = [
      'You are the cheap L1 event triage gate for an autonomous AI hub.',
      'Most events are not actionable. Be conservative.',
      'Return exactly one JSON object with this contract:',
      '{"actionable":false,"category":"other","priority":1,"suggestedRecipient":null,"rationale":"brief reason"}',
      'actionable must be a JSON boolean, priority must be a JSON integer, and suggestedRecipient must be a JSON string or null.',
      `Allowed categories: ${this.categories.join(', ')}.`,
      'Priority 1 is routine, 2 is important, 3 is urgent.',
      'suggestedRecipient is a configured routing key, or null when rules should decide.',
    ].join('\n');
    const user = JSON.stringify({
      event: {
        source: event.source,
        categoryHint: event.category_hint,
        summary: event.summary,
        payload: event.payload,
      },
      recentBacklog: backlogSummary?.slice(0, this.backlogMaxChars) || '(unavailable)',
    });
    return this.call(this.flashModel, system, user, this.pricing.flash);
  }

  async fuzzyRoute(event, triageResult, contacts) {
    const system = [
      'Choose exactly one recipient for an actionable event.',
      'Return exactly one JSON object with this contract:',
      '{"actionable":true,"category":"other","priority":1,"suggestedRecipient":"recipient-key","rationale":"brief reason"}',
      'actionable must be a JSON boolean, priority must be a JSON integer, and suggestedRecipient must be a JSON string.',
      'Set suggestedRecipient to one recipientKey from the provided list.',
      'Do not change actionable/category/priority.',
    ].join('\n');
    const user = JSON.stringify({
      event: { source: event.source, summary: event.summary },
      triage: triageResult,
      recipients: contacts.map((contact) => ({
        recipientKey: contact.config?.routing?.recipientKey ?? contact.id,
        name: contact.name,
        kind: contact.kind,
        categories: contact.config?.routing?.categories ?? [],
      })),
    });
    return this.call(this.proModel, system, user, this.pricing.pro);
  }
}

export class HubClient {
  constructor(config) {
    this.baseUrl = String(config.baseUrl ?? '').replace(/\/+$/, '');
    this.token = secretFromEnv(config.tokenEnv ?? 'HUB_TOKEN');
    this.timeoutMs = Number(config.timeoutMs ?? 30_000);
    if (!this.baseUrl) throw new Error('hub.baseUrl is required');
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  async contacts() {
    const body = await jsonRequest(`${this.baseUrl}/api/contacts`, {
      headers: this.headers(),
    }, this.timeoutMs);
    return body.contacts ?? [];
  }

  async dispatch(contactId, content) {
    return jsonRequest(`${this.baseUrl}/api/contacts/${encodeURIComponent(contactId)}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ content }),
    }, this.timeoutMs);
  }
}

export class VaultClient {
  constructor(config = {}) {
    this.url = config.url ?? '';
    this.token = secretFromEnv(config.tokenEnv ?? 'VAULT_TOKEN');
    this.sourceTag = config.sourceTag ?? 'codex';
    this.sessionId = null;
    this.requestId = 0;
    this.connecting = null;
  }

  get enabled() {
    return Boolean(this.url);
  }

  headers(withSession = true) {
    return {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(withSession && this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
    };
  }

  async post(message, withSession = true) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.headers(withSession),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(30_000),
    });
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`memory-vault HTTP ${response.status}: ${detail}`);
    }
    if (response.status === 202 || response.status === 204) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) return JSON.parse(text);
    const messages = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return messages.find((item) => item.id === message.id) ?? messages.at(-1) ?? null;
  }

  async connect() {
    if (!this.enabled) throw new Error('memory-vault URL is not configured');
    if (this.sessionId) return;
    if (!this.connecting) {
      this.connecting = (async () => {
        const id = ++this.requestId;
        const response = await this.post({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'ai-hub-triage-worker', version: '0.1.0' },
          },
        }, false);
        if (response?.error) throw new Error(response.error.message ?? 'memory-vault initialize failed');
        await this.post({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        });
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async call(name, args = {}) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.connect();
        const id = ++this.requestId;
        const response = await this.post({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        });
        if (response?.error) throw new Error(response.error.message ?? `${name} failed`);
        const result = response?.result ?? {};
        const text = (result.content ?? [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
        if (result.isError) throw new Error(text || `${name} returned an error`);
        return text;
      } catch (error) {
        lastError = error;
        this.sessionId = null;
      }
    }
    throw lastError;
  }

  async backlog(query = 'triage-backlog') {
    return this.call('search_vault', { query });
  }

  async park(event, result, reason) {
    const slug = `triage-${event.id.slice(0, 16)}`;
    return this.call('write_inbox', {
      slug,
      title: `Triage 待路由：${event.source}`,
      content: [
        `事件 ID：\`${event.id}\``,
        `来源：\`${event.source}\``,
        `分类：\`${result.category}\`，优先级：${result.priority}`,
        `原因：${reason}`,
        '',
        '## 事件摘要',
        event.summary.slice(0, 12_000),
        '',
        `Triage 判断：${result.rationale}`,
      ].join('\n'),
      tags: ['triage-backlog', 'ai-hub', result.category],
      source: this.sourceTag,
    });
  }

  async close() {
    this.sessionId = null;
  }
}
