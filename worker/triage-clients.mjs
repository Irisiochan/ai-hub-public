import process from 'node:process';
import {
  DEFAULT_DAILY_RECIPIENTS,
  estimateCostCny,
  isDailyMode,
  parseDiaryEntries,
  parseTriageJson,
  validateTriageMode,
} from './triage-core.mjs';

const IDEA_CATEGORIES = [
  'daily-life',
  'imagination',
  'ethics',
  'relationships',
  'creativity',
  'society',
  'technology',
  'pets',
  'work',
  'learning',
  'humor',
  'philosophy',
];

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

const RAW_SNIPPET_CHARS = 500;

function parseJsonObject(raw, label) {
  if (typeof raw !== 'string') throw new Error(`${label} response must be text`);
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`${label} response did not contain a JSON object`);
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (error) {
    // 原始正文以前直接丢了，只剩一句「position 563」，事后只能靠报错形状猜成因
    // （未转义引号？截断？多余逗号？）。留一段原文，下次是实锤而不是推理。
    const snippet = candidate.slice(0, RAW_SNIPPET_CHARS);
    const suffix = candidate.length > RAW_SNIPPET_CHARS ? `…(共 ${candidate.length} 字)` : '';
    throw new Error(`${label}: ${error.message} | raw: ${snippet}${suffix}`);
  }
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

  async callJson(model, system, user, pricing = {}, maxTokens = 400, { temperature = 0 } = {}) {
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
        temperature,
        max_tokens: maxTokens,
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
      result: parseJsonObject(content, 'DeepSeek JSON'),
      usage: body.usage ?? {},
      costCny: estimateCostCny(body.usage, pricing),
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }

  async call(model, system, user, pricing = {}, categories = this.categories) {
    const response = await this.callJson(model, system, user, pricing);
    return {
      ...response,
      result: parseTriageJson(JSON.stringify(response.result), categories),
    };
  }

  /**
   * Cheap flash extract for temporary-absence followups.
   * Only call after local keyword coarse screen hits.
   */
  async extractTemporaryAbsence(messageText) {
    const system = [
      'You extract temporary-absence intents from a single chat message by User.',
      'Return exactly one JSON object:',
      '{"intent":"temporary-absence"|"none","activity":"short label or null","expectedMinutes":number|null,"returnCommitment":"what User plans to do after returning or null"}',
      'intent=temporary-absence only when User is stepping away briefly (bath, out, work meeting, meal, sleep, back later).',
      'activity: short Chinese/English label of what she is doing (e.g. 洗澡, 出门, 开会).',
      'expectedMinutes: best estimate of when to check back (5–180). For games/entertainment default to 90–120; use 30 if otherwise unsure.',
      'returnCommitment: the concrete thing User says she will do after returning (e.g. 验收 toy); null when absent.',
      'Messages like “玩完之后验收 toy 我再来” are temporary absences with both an activity and a return commitment.',
      'If the message is not a temporary absence, intent must be none and the other fields null.',
      'No prose outside JSON.',
    ].join('\n');
    const response = await this.callJson(
      this.flashModel,
      system,
      JSON.stringify({ message: String(messageText ?? '').slice(0, 1000) }),
      this.pricing.flash,
      120,
    );
    return response;
  }

  async triage(event, backlogSummary, options = {}) {
    const daily = isDailyMode(event) || options.mode === 'daily';
    const dailyRecipients = Array.isArray(options.dailyRecipients) && options.dailyRecipients.length
      ? options.dailyRecipients
      : DEFAULT_DAILY_RECIPIENTS;
    const forceActionable = daily && options.forceActionable === true;
    const taskCategories = this.categories.filter((category) => category !== 'daily');
    const system = daily
      ? [
        'You are the L1 proactive daily-companion gate for an autonomous AI hub.',
        'Decide whether User should receive a proactive message right now.',
        'Allowed content: care/health/routine nudges, practical reminders, light chat openers, affectionate check-ins.',
        forceActionable
          ? 'This is the guaranteed daily slot. Choose one natural, low-pressure proactive message; actionable must be true.'
          : 'Stay selective — prefer NO_OP when nothing natural fits the current Shanghai time context.',
        'Return exactly one JSON object with this contract:',
        forceActionable
          ? `{"actionable":true,"needsLocalExec":false,"category":"daily","priority":1,"suggestedRecipient":"${dailyRecipients[0]}","rationale":"brief reason"}`
          : '{"actionable":false,"needsLocalExec":false,"category":"daily","priority":1,"suggestedRecipient":null,"rationale":"brief reason"}',
        'actionable and needsLocalExec must be JSON booleans, priority must be a JSON integer, and suggestedRecipient must be a JSON string or null.',
        'Daily companion messages never require local execution: needsLocalExec must be false.',
        'When actionable is true: category must be "daily" and suggestedRecipient must be exactly one of '
          + `${dailyRecipients.join(', ')}.`,
        forceActionable
          ? 'For this guaranteed slot, actionable must be true.'
          : 'When actionable is false: suggestedRecipient must be null.',
        'Priority 1 is light/routine, 2 is more important care, 3 is urgent (rare).',
        'Pick the recipient by tone and relationship fit among the allowed list only.',
      ].join('\n')
      : [
        'You are the cheap L1 event triage gate for an autonomous AI hub.',
        'Most events are not actionable. Be conservative.',
        'Return exactly one JSON object with this contract:',
        '{"actionable":false,"needsLocalExec":false,"category":"other","priority":1,"suggestedRecipient":null,"rationale":"brief reason","taskPath":null}',
        'actionable and needsLocalExec must be JSON booleans, priority must be a JSON integer, and suggestedRecipient must be a JSON string or null.',
        'Set needsLocalExec=true only when the action requires real repository state, tests, code/file changes, shell access, or deployment.',
        'Keep needsLocalExec=false for conversation, companionship, reminders, memory writes, and discussion that a contact can complete from chat context.',
        'For a backlog sweep, actionable=true requires taskPath to be copied exactly from recentBacklog.',
        'Never choose worker-tail/deploy-tail entries. A missing eligible task means NO_OP with taskPath=null.',
        `Allowed categories: ${taskCategories.join(', ')}.`,
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
      mode: daily ? 'daily' : 'task',
      allowedRecipients: daily ? dailyRecipients : undefined,
      proactiveContext: daily ? options.proactiveContext ?? '(unavailable)' : undefined,
      recentBacklog: daily
        ? undefined
        : backlogSummary?.slice(0, this.backlogMaxChars) || '(unavailable)',
    });
    const response = await this.call(
      this.flashModel,
      system,
      user,
      this.pricing.flash,
      daily ? ['daily'] : taskCategories,
    );
    validateTriageMode(response.result, {
      mode: daily ? 'daily' : 'task',
      dailyRecipients,
      forceActionable,
    });
    return response;
  }

  async fuzzyRoute(event, triageResult, contacts, options = {}) {
    const allowed = Array.isArray(options.allowedRecipientKeys) && options.allowedRecipientKeys.length
      ? new Set(options.allowedRecipientKeys.map((item) => String(item).trim().toLowerCase()))
      : null;
    const recipients = contacts
      .filter((contact) => (
        triageResult.needsLocalExec !== true
        || contact.config?.delegation?.enabled === true
      ))
      .map((contact) => ({
        recipientKey: contact.config?.routing?.recipientKey ?? contact.id,
        id: contact.id,
        name: contact.name,
        kind: contact.kind,
        categories: contact.config?.routing?.categories ?? [],
      }))
      .filter((contact) => {
        if (!allowed) return true;
        return allowed.has(String(contact.recipientKey).toLowerCase())
          || allowed.has(String(contact.id).toLowerCase());
      });
    const system = [
      'Choose exactly one recipient for an actionable event.',
      'Return exactly one JSON object with this contract:',
      '{"actionable":true,"needsLocalExec":false,"category":"other","priority":1,"suggestedRecipient":"recipient-key","rationale":"brief reason"}',
      'actionable and needsLocalExec must be JSON booleans, priority must be a JSON integer, and suggestedRecipient must be a JSON string.',
      'Set suggestedRecipient to one recipientKey from the provided list.',
      'Do not change actionable/needsLocalExec/category/priority.',
    ].join('\n');
    const user = JSON.stringify({
      event: { source: event.source, summary: event.summary },
      triage: triageResult,
      recipients,
    });
    return this.call(this.flashModel, system, user, this.pricing.flash);
  }

  async ideaTopic({ room, members, recentTopics }) {
    const system = [
      'You host a daily free-form idea discussion for a private multi-AI room.',
      'Choose one genuinely discussable topic. It may be playful, practical, philosophical, creative, or surprising; it is not limited to project optimization.',
      'Avoid the same semantic category and wording as the recent topics.',
      'Choose either all room members or a purposeful subset.',
      'Return exactly one JSON object:',
      '{"topic":"one concise Chinese discussion prompt","category":"short semantic category","targetIds":["all"],"rationale":"brief novelty reason"}',
      `category must be exactly one of: ${IDEA_CATEGORIES.join(', ')}.`,
      'targetIds must contain "all" alone, or one or more exact member ids from the provided list.',
      'Do not include @ mentions inside topic.',
    ].join('\n');
    const user = JSON.stringify({
      room: { id: room.id, name: room.name },
      members: members.map((member) => ({ id: member.id, name: member.name })),
      recentTopics,
    });
    const response = await this.callJson(
      this.flashModel,
      system,
      user,
      this.pricing.flash,
      600,
    );
    const value = response.result;
    const topic = typeof value.topic === 'string' ? value.topic.trim().slice(0, 1000) : '';
    const category = typeof value.category === 'string'
      ? value.category.trim().toLowerCase().slice(0, 100)
      : '';
    const targetIds = Array.isArray(value.targetIds)
      ? [...new Set(value.targetIds.map((item) => String(item).trim()).filter(Boolean))]
      : [];
    const rationale = typeof value.rationale === 'string'
      ? value.rationale.trim().slice(0, 1000)
      : '';
    if (!topic || !category || !targetIds.length || !rationale) {
      throw new Error('idea topic JSON is missing topic/category/targetIds/rationale');
    }
    if (!IDEA_CATEGORIES.includes(category)) {
      throw new Error(`idea topic category is invalid: ${category}`);
    }
    return { ...response, result: { topic, category, targetIds, rationale } };
  }

  /**
   * 日终 rollup 的抽取步骤：把一天的真实对话压成几条日记流水。
   * 只允许复述 User 自己说过的事——AI 的回复只是上下文，不是事实来源。
   */
  async diaryEntries({ date, weekday, transcript, maxEntries = 8, attempt = 1 }) {
    const system = [
      'You extract diary bullet points for User from one day of her real chat logs.',
      'Write in Chinese, in User 的第三人称视角（例如「User 上午洗了两只大型犬」），一条一句话。',
      '',
      '判断标准：一年后回看这一天，这条还算「她那天经历过的事」吗？不算就别记。',
      '记：生活事件、身体与情绪状态、宠物、出门与见人、吃睡、关系里真实发生的事、',
      '  以及工作上她实际做了什么、什么感受。',
      '不记：派单指令与回归测试指令、commit hash 与文件名、技术方案与实现结论、',
      '  待办与计划、AI 说的话或建议、系统通知、单独一句玩笑或表情动作。',
      '一整天只有工程派单和调试往来时，正确答案是空数组，不要为了凑数把派单写成流水。',
      '',
      '同一场景里连续几分钟的往来合成一条，不要一条消息一条流水。',
      'Only record what User herself stated in lines marked role=user.',
      'Lines marked role=assistant are context only — never turn an AI reply, suggestion, or plan into an entry.',
      'Never invent or infer beyond the text.',
      'time must be the HH:MM of the message the entry came from.',
      `Return at most ${maxEntries} entries, ordered by time. 宁可少记也不要凑数。`,
      'Return exactly one JSON object: {"entries":[{"time":"HH:MM","text":"一句话流水"}]}',
      'text 里出现的引号必须按 JSON 规则转义；不要输出 JSON 之外的任何字符。',
    ].join('\n');
    const user = JSON.stringify({
      date,
      weekday: weekday ?? null,
      transcript,
    });
    // 首次跑 temperature 0 求稳定复现。重试必须换一次采样——同 prompt + 同 transcript
    // + temperature 0 基本会原样再吐一遍同一份坏 JSON，那种「重试」等于没重试。
    const retry = attempt > 1;
    const response = await this.callJson(
      this.flashModel,
      system,
      user,
      this.pricing.flash,
      retry ? 1800 : 1200,
      { temperature: retry ? 0.3 : 0 },
    );
    return { ...response, result: parseDiaryEntries(response.result, { maxEntries }) };
  }

  async ideaSummary({ topic, transcript }) {
    const system = [
      'You are closing a private multi-AI room discussion.',
      'Write a compact Chinese host wrap-up that captures distinct viewpoints, useful disagreements, and one memorable takeaway.',
      'Do not claim anyone said something absent from the transcript.',
      'Return exactly one JSON object: {"summary":"final host message"}',
    ].join('\n');
    const user = JSON.stringify({ topic, transcript: transcript.slice(0, 30_000) });
    const response = await this.callJson(
      this.flashModel,
      system,
      user,
      this.pricing.flash,
      1000,
    );
    const summary = typeof response.result.summary === 'string'
      ? response.result.summary.trim().slice(0, 6000)
      : '';
    if (!summary) throw new Error('idea summary JSON is missing summary');
    return { ...response, result: { summary } };
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

  async dispatch(contactId, content, {
    origin = 'main',
    hidden = false,
    automation = null,
    idempotencyKey = null,
  } = {}) {
    const key = String(idempotencyKey ?? '').trim();
    return jsonRequest(`${this.baseUrl}/api/contacts/${encodeURIComponent(contactId)}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        content,
        origin,
        automated: true,
        hidden,
        automation,
        ...(key ? { idempotencyKey: key } : {}),
      }),
    }, this.timeoutMs);
  }

  async dispatchRoomHost(contactId, input) {
    return jsonRequest(
      `${this.baseUrl}/api/contacts/${encodeURIComponent(contactId)}/room-host/messages`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(input),
      },
      this.timeoutMs,
    );
  }

  async roomRound(contactId, roundId) {
    return jsonRequest(
      `${this.baseUrl}/api/contacts/${encodeURIComponent(contactId)}/room-rounds/${encodeURIComponent(roundId)}`,
      { headers: this.headers() },
      this.timeoutMs,
    );
  }

  async waitRoomRound(contactId, roundId, { pollMs = 2000, timeoutMs = 20 * 60_000 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.roomRound(contactId, roundId);
      if (status.status === 'done') return status;
      if (status.status === 'error') {
        throw new Error(`room round failed: ${status.error || 'unknown error'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`room round timed out after ${timeoutMs}ms`);
  }

  /** 某个上海日历日的全部 DM 文本对话，供日记 rollup 使用。 */
  async journalDay(date, limit = 400) {
    const query = new URLSearchParams({ date: String(date), limit: String(limit) });
    const body = await jsonRequest(
      `${this.baseUrl}/api/journal/day?${query}`,
      { headers: this.headers() },
      this.timeoutMs,
    );
    return {
      date: body.date ?? date,
      truncated: body.truncated === true,
      messages: body.messages ?? [],
    };
  }

  async messages(contactId, after, limit = 200, origin = 'main') {
    const query = new URLSearchParams({
      limit: String(limit),
      origin: String(origin),
    });
    // Omit after to fetch newest-first window (hub default). Callers that page
    // with a cursor still pass a numeric/string after as before.
    if (after !== null && after !== undefined && after !== '') {
      query.set('after', String(after));
    }
    const body = await jsonRequest(
      `${this.baseUrl}/api/contacts/${encodeURIComponent(contactId)}/messages?${query}`,
      { headers: this.headers() },
      this.timeoutMs,
    );
    return body.messages ?? [];
  }
}

export class VaultClient {
  constructor(config = {}) {
    this.url = config.url ?? '';
    this.token = secretFromEnv(config.tokenEnv ?? 'VAULT_TOKEN');
    this.sourceTag = config.sourceTag ?? 'codex';
    // Facts change rarely; default 1h. Config `vault.cacheMs` was declared but unused.
    const rawCache = Number(config.cacheMs);
    this.cacheMs = Number.isFinite(rawCache) && rawCache >= 0 ? rawCache : 3_600_000;
    this.cache = new Map();
    this.sessionId = null;
    this.requestId = 0;
    this.connecting = null;
  }

  cached(key, loader) {
    if (this.cacheMs <= 0) return loader();
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < this.cacheMs) return Promise.resolve(hit.value);
    return Promise.resolve(loader()).then((value) => {
      this.cache.set(key, { at: Date.now(), value });
      return value;
    });
  }

  clearCache() {
    this.cache.clear();
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

  async taskContext() {
    return this.call('get_task_context');
  }

  /**
   * Structured facts snapshot. domain '' = all domains.
   * Cached via vault.cacheMs (default 1h) — date-events only need occasional refresh.
   */
  async facts(domain = '') {
    const key = `facts:${domain || '*'}`;
    return this.cached(key, () => this.call('get_facts', { domain: domain || '' }));
  }

  async readFile(path) {
    return this.call('read_file', { path });
  }

  /** 写一条日记流水。date/time 留空即今天/此刻；rollup 与 backfill 都显式传。 */
  async logDaily({ content, date = '', time = '', source = this.sourceTag }) {
    return this.call('log_daily', { content, date, time, source });
  }

  async writeDiary({ slug, title, content, tags, source = this.sourceTag }) {
    return this.call('write_diary', { slug, title, content, tags, source });
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
