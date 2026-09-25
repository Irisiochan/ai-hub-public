import fs from 'node:fs';
import path from 'node:path';
import { serverRoot } from '../platform/index.js';

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: Array<{ id: string; label: string }>;
}

export interface BackendCatalog {
  models: ModelOption[];
  efforts?: ModelOption[];
}

/**
 * 内置兜底目录。model-catalog.json 不存在、为空或写坏时用这份，保证下拉永远不会空。
 * JSON 里给了某个 backend 的某个字段，就只覆盖那个字段，其余仍走这里。
 */
const BUILTIN: Record<string, BackendCatalog> = {
  'claude-cli': {
    models: [
      { id: '', label: '默认（Claude CLI 自动选择）', isDefault: true },
      { id: 'sonnet', label: 'Sonnet（最新）' },
      { id: 'opus', label: 'Opus（最新）' },
      { id: 'haiku', label: 'Haiku（最新）' },
      { id: 'fable', label: 'Fable（最新）' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1' },
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-fable-5', label: 'Fable 5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'claude-opus-4-5', label: 'Opus 4.5' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],
    // claude CLI 的 --effort 档位；'' 表示不传 flag，交给 CLI 默认（当前是 xhigh）
    efforts: [
      { id: '', label: '默认强度', isDefault: true },
      { id: 'low', label: 'low' },
      { id: 'medium', label: 'medium' },
      { id: 'high', label: 'high' },
      { id: 'xhigh', label: 'xhigh' },
      { id: 'max', label: 'max' },
    ],
  },
  // `grok models` 是主目录；这里用于旧 CLI / 临时查询失败时兜底，也可被热更新 JSON 覆盖。
  'grok-cli': {
    models: [
      { id: '', label: '默认（Grok CLI 自动选择）', isDefault: true },
      { id: 'grok-4.6', label: 'Grok 4.6' },
      { id: 'grok-4.5', label: 'Grok 4.5' },
    ],
    // 空档 = 不传 --reasoning-effort，交给 Grok CLI 当前模型默认。
    efforts: [
      { id: '', label: '默认强度', isDefault: true },
      ...['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((id) => ({ id, label: id })),
    ],
  },
  // Codex 模型的热目录：联系人页走 CLI 实时列表（10 分钟缓存）；这里是文件
  // 缺失/查询失败时的内置兜底，也是 workflow module 绑定的校验依据。
  // model-catalog.json 里补了某个 backend 的 models，就只覆盖 models。
  'codex-cli': {
    models: [
      { id: 'gpt-6-astra', label: 'Astra' },
      { id: 'gpt-5.6-sol', label: 'Sol' },
      { id: 'gpt-5.6-terra', label: 'Terra' },
      { id: 'gpt-5.6-luna', label: 'Luna', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id, label: id })) },
      { id: 'gpt-5.5', label: 'GPT-5.5', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map((id) => ({ id, label: id })) },
    ],
    efforts: [
      { id: 'low', label: 'low' },
      { id: 'medium', label: 'medium' },
      { id: 'high', label: 'high' },
      { id: 'xhigh', label: 'xhigh' },
      { id: 'max', label: 'max' },
      { id: 'ultra', label: 'ultra' },
    ],
  },
  // API 主目录来自上游 /models；这里只做查询失败时的空兜底，具体模型写 api 或 api:<provider>。
  api: { models: [] },
  'api:openai-compat': { models: [] },
  'api:anthropic': { models: [] },
  'api:gemini': { models: [] },
  // `opencode models` 是主目录；这里用于 CLI 查询失败时兜底，也可被热更新 JSON 覆盖。
  'opencode-cli': {
    models: [
      { id: '', label: '默认（OpenCode 自动选择）', isDefault: true },
      { id: 'opencode-go/muse-spark-1.3-contributor', label: 'Muse Spark 1.3 Contributor (Go)', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({ id, label: id })) },
      { id: 'opencode-go/muse-spark-1.2-contributor', label: 'Muse Spark 1.2 Contributor (Go)' },
    ],
    efforts: [
      { id: '', label: '默认强度', isDefault: true },
      { id: 'low', label: 'low' },
      { id: 'medium', label: 'medium' },
      { id: 'high', label: 'high' },
      { id: 'xhigh', label: 'xhigh' },
    ],
  },
  // kimi has no `models` subcommand; contact page prefers live config.toml.
  // Efforts mirror managed kimi-code support_efforts (low/high/max); '' = omit env.
  'kimi-cli': {
    models: [
      { id: '', label: '默认（Kimi CLI 自动选择）', isDefault: true },
      { id: 'kimi-code/kimi-for-coding', label: 'kimi-code/kimi-for-coding' },
      { id: 'kimi-for-coding', label: 'kimi-for-coding' },
    ],
    efforts: [
      { id: '', label: '默认强度', isDefault: true },
      { id: 'low', label: 'low' },
      { id: 'high', label: 'high' },
      { id: 'max', label: 'max' },
    ],
  },
};

const catalogPath = process.env.HUB_MODEL_CATALOG
  ?? path.join(serverRoot, 'model-catalog.json');

type Overrides = Record<string, Partial<BackendCatalog>>;

let cache: { mtimeMs: number; data: Overrides } | null = null;
const observedCatalogs = new Map<string, { expires: number; models: ModelOption[] }>();

/** Reuse an explicit contact-page catalog lookup; never starts a provider itself. */
export function rememberModelCatalog(backend: string, models: ModelOption[]): void {
  if (models.length) observedCatalogs.set(backend, {
    expires: Date.now() + 10 * 60_000,
    models: structuredClone(models),
  });
}

/** 宽松解析：允许写成 "claude-opus-5" 或 { id, label }，坏条目丢弃而不是整段失败。 */
function normalizeOptions(raw: unknown): ModelOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((v): ModelOption | null => {
      if (typeof v === 'string') return { id: v, label: v };
      if (v && typeof v === 'object') {
        const item = v as Record<string, unknown>;
        // id 允许是空串——那是「默认/自动选择」那一项
        if (typeof item.id !== 'string') return null;
        const option: ModelOption = {
          id: item.id.trim(),
          label: typeof item.label === 'string' && item.label ? item.label : item.id.trim(),
        };
        if (typeof item.description === 'string') option.description = item.description;
        if (item.isDefault === true) option.isDefault = true;
        if (Array.isArray(item.supportedReasoningEfforts)) {
          option.supportedReasoningEfforts = normalizeOptions(item.supportedReasoningEfforts) ?? [];
        }
        return option;
      }
      return null;
    })
    .filter((v): v is ModelOption => v !== null);
}

function normalizeOverrides(raw: unknown): Overrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Overrides = {};
  for (const [backend, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    // 允许 { "claude-cli": [...] } 这种只给模型列表的简写
    if (Array.isArray(value)) {
      const models = normalizeOptions(value);
      if (models) out[backend] = { models };
      continue;
    }
    const item = value as Record<string, unknown>;
    const entry: Partial<BackendCatalog> = {};
    const models = normalizeOptions(item.models);
    if (models) entry.models = models;
    const efforts = normalizeOptions(item.efforts);
    if (efforts) entry.efforts = efforts;
    if (entry.models || entry.efforts) out[backend] = entry;
  }
  return out;
}

/**
 * 按 mtime 缓存读取覆盖文件。mtime 没变就不重新解析，
 * 所以写坏的 JSON 只在改动那一次刷一条日志，不会每次请求刷屏。
 */
function readOverrides(log?: (message: string) => void): Overrides {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(catalogPath).mtimeMs;
  } catch {
    cache = null; // 文件被删掉 → 回到纯内置目录
    return {};
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.data;
  try {
    const data = normalizeOverrides(JSON.parse(fs.readFileSync(catalogPath, 'utf-8')));
    cache = { mtimeMs, data };
    return data;
  } catch (e: any) {
    log?.(`${catalogPath} 解析失败，本次回落到内置模型目录：${e.message}`);
    cache = { mtimeMs, data: {} };
    return {};
  }
}

/** 取某个 backend 的模型/强度目录。改 model-catalog.json 即刻生效，无需重启。 */
export function modelCatalog(backend: string, log?: (message: string) => void): BackendCatalog {
  const override = readOverrides(log)[backend];
  const builtin = BUILTIN[backend];
  const observed = observedCatalogs.get(backend);
  const live = observed && observed.expires > Date.now() ? observed.models : undefined;
  const models = override?.models ?? live ?? builtin?.models ?? [];
  return {
    models: models.map((model) => ({
      ...model,
      supportedReasoningEfforts: model.supportedReasoningEfforts
        ?? builtin?.models.find((item) => item.id === model.id)?.supportedReasoningEfforts,
    })),
    efforts: override?.efforts ?? builtin?.efforts,
  };
}

export { catalogPath as modelCatalogPath };
