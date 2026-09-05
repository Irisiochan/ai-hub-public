import type { ModelOption } from '../modelCatalog.js';

const MAX_PAGES = 8;
const MAX_MODELS = 800;
const FETCH_TIMEOUT_MS = 12_000;

export function defaultApiBaseUrl(provider: string): string {
  if (provider === 'anthropic') return 'https://api.anthropic.com/v1/messages';
  if (provider === 'gemini') {
    return 'https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse';
  }
  return 'https://api.openai.com/v1/chat/completions';
}

/** Derive the provider's model-list URL from the chat completions/messages URL. */
export function modelsUrlFor(provider: string, baseUrl: string): string {
  const raw = (baseUrl && baseUrl.trim()) || defaultApiBaseUrl(provider);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('API URL 无效');
  }
  url.hash = '';
  if (provider === 'gemini' || /\/models\/[^/]+:/.test(url.pathname)) {
    url.search = '';
    url.pathname = url.pathname.replace(/\/models\/.*$/, '/models');
    if (!url.pathname.endsWith('/models')) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
    }
    return url.toString();
  }
  url.search = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/chat\/completions$/i, '');
  pathname = pathname.replace(/\/completions$/i, '');
  pathname = pathname.replace(/\/messages$/i, '');
  pathname = pathname.replace(/\/responses$/i, '');
  if (!/\/models$/i.test(pathname)) pathname = `${pathname}/models`;
  url.pathname = pathname;
  return url.toString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function itemsFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const object = asRecord(payload);
  if (!object) return [];
  if (Array.isArray(object.data)) return object.data;
  if (Array.isArray(object.models)) return object.models;
  return [];
}

export function normalizeApiModelId(provider: string, raw: string): string {
  let id = raw.trim();
  if (!id) return '';
  if (provider === 'gemini' || id.startsWith('models/')) id = id.replace(/^models\//, '');
  return id;
}

export function optionFromApiItem(provider: string, item: unknown): ModelOption | null {
  if (typeof item === 'string') {
    const id = normalizeApiModelId(provider, item);
    return id ? { id, label: id } : null;
  }
  const object = asRecord(item);
  if (!object) return null;
  const rawId = typeof object.id === 'string' && object.id
    ? object.id
    : typeof object.name === 'string' ? object.name : '';
  const id = normalizeApiModelId(provider, rawId);
  if (!id) return null;
  if (provider === 'gemini' && Array.isArray(object.supportedGenerationMethods)) {
    const methods = object.supportedGenerationMethods.map(String);
    if (methods.length > 0 && !methods.some((method) => /generateContent/i.test(method))) {
      return null;
    }
  }
  const label = typeof object.displayName === 'string' && object.displayName
    ? object.displayName
    : typeof object.display_name === 'string' && object.display_name
      ? object.display_name
      : typeof object.name === 'string' && object.name && object.name !== rawId && !object.name.startsWith('models/')
        ? object.name
        : id;
  const option: ModelOption = { id, label };
  if (typeof object.description === 'string' && object.description) {
    option.description = object.description;
  }
  return option;
}

function nextPage(payload: unknown): { param: string; value: string } | null {
  const object = asRecord(payload);
  if (!object) return null;
  if (typeof object.nextPageToken === 'string' && object.nextPageToken) {
    return { param: 'pageToken', value: object.nextPageToken };
  }
  if (object.has_more === true && typeof object.last_id === 'string' && object.last_id) {
    return { param: 'after_id', value: object.last_id };
  }
  return null;
}

function withQuery(url: string, params: Record<string, string>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) parsed.searchParams.set(key, value);
  return parsed.toString();
}

export function composeApiModels(input: {
  live: ModelOption[];
  catalog: ModelOption[];
  custom: ModelOption[];
  current: string;
}): ModelOption[] {
  const overlay = new Map(input.catalog.filter((model) => model.id).map((model) => [model.id, model]));
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  const add = (model: ModelOption) => {
    if (!model.id || seen.has(model.id)) return;
    seen.add(model.id);
    const meta = overlay.get(model.id);
    out.push(meta ? {
      id: model.id,
      label: meta.label || model.label,
      description: meta.description ?? model.description,
      isDefault: meta.isDefault === true || model.isDefault === true,
    } : model);
  };
  for (const model of input.live) add(model);
  for (const model of input.catalog) add(model);
  for (const model of input.custom) add(model);
  if (input.current && !seen.has(input.current)) {
    out.unshift({ id: input.current, label: input.current });
  }
  return out;
}

export async function listApiModels(opts: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  log?: (message: string) => void;
}): Promise<ModelOption[]> {
  const modelsUrl = modelsUrlFor(opts.provider, opts.baseUrl);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.provider === 'anthropic') {
    headers['x-api-key'] = opts.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (opts.provider === 'gemini') {
    headers['x-goog-api-key'] = opts.apiKey;
  } else {
    headers.authorization = `Bearer ${opts.apiKey}`;
  }

  const collected: ModelOption[] = [];
  const seen = new Set<string>();
  let url = opts.provider === 'gemini'
    ? withQuery(modelsUrl, { pageSize: '100' })
    : opts.provider === 'anthropic'
      ? withQuery(modelsUrl, { limit: '100' })
      : modelsUrl;

  for (let page = 0; page < MAX_PAGES && collected.length < MAX_MODELS; page++) {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${raw ? `: ${raw.slice(0, 180)}` : ''}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error('模型目录不是 JSON');
    }
    for (const item of itemsFromPayload(payload)) {
      const option = optionFromApiItem(opts.provider, item);
      if (!option || seen.has(option.id)) continue;
      seen.add(option.id);
      collected.push(option);
      if (collected.length >= MAX_MODELS) break;
    }
    const next = nextPage(payload);
    if (!next) break;
    const params: Record<string, string> = { [next.param]: next.value };
    if (opts.provider === 'gemini') params.pageSize = '100';
    if (opts.provider === 'anthropic') params.limit = '100';
    url = withQuery(modelsUrl, params);
  }

  if (collected.length === 0) throw new Error('没有返回可用模型');
  opts.log?.(`loaded ${collected.length} API models from ${new URL(modelsUrl).host}`);
  return collected;
}
