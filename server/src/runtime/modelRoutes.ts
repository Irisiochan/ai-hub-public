import { Router } from 'express';
import type { AgentManager } from './manager.js';
import {
  CodexAppServerBackend,
  type CodexModelOption,
  composeApiModels,
  listApiModels,
  GrokCliBackend,
  type GrokModelOption,
  OpencodeCliBackend,
  type OpencodeModelOption,
  KimiCliBackend,
  type KimiModelOption,
} from '../backends/index.js';
import type { HubConfig, Db, ContactRow, SseHub, HubLogger } from '../platform/index.js';
import {
  modelCatalog,
  rememberModelCatalog,
  type ModelOption,
  contactConfig,
  formatContactConfigError,
  validateContactConfig,
  publicContactRow,
} from '../contacts/index.js';

const CODEX_EFFORT_IDS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

function codexEfforts(models: CodexModelOption[], currentModel: string): ModelOption[] {
  const selected = (currentModel && models.find((model) => model.id === currentModel))
    || models.find((model) => model.isDefault)
    || models[0];
  if (!selected) return [];
  const suffix = selected.defaultReasoningEffort ? `（${selected.defaultReasoningEffort}）` : '';
  return [
    { id: '', label: `默认强度${suffix}`, isDefault: true },
    ...(selected.supportedReasoningEfforts ?? []),
  ];
}

/** Prefer the selected model's support_efforts; else catalog efforts (low/high/max). */
function kimiEfforts(
  models: KimiModelOption[],
  currentModel: string,
  catalogEfforts: ModelOption[] | undefined,
): ModelOption[] {
  const selected = currentModel
    ? models.find((model) => model.id === currentModel)
    : undefined;
  if (selected?.supportedReasoningEfforts?.length) {
    const suffix = selected.defaultReasoningEffort ? `（${selected.defaultReasoningEffort}）` : '';
    return [
      { id: '', label: `默认强度${suffix}`, isDefault: true },
      ...selected.supportedReasoningEfforts,
    ];
  }
  return catalogEfforts ?? [];
}

function customModels(cfg: Record<string, any>): ModelOption[] {
  if (!Array.isArray(cfg.modelOptions)) return [];
  return cfg.modelOptions
    .map((v: unknown) => {
      if (typeof v === 'string') return { id: v, label: v };
      if (v && typeof v === 'object') {
        const item = v as Record<string, unknown>;
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        if (id) return { id, label: typeof item.label === 'string' ? item.label : id };
      }
      return null;
    })
    .filter((v: ModelOption | null): v is ModelOption => v !== null);
}

function dedupeModels(models: ModelOption[], current: string): ModelOption[] {
  const all = current && !models.some((m) => m.id === current)
    ? [{ id: current, label: current }, ...models]
    : models;
  return all.filter((model, index) => all.findIndex((m) => m.id === model.id) === index);
}

/** Catalog JSON can override live CLI labels without waiting for a restart. */
function applyCatalogMeta(models: ModelOption[], catalog: ModelOption[]): ModelOption[] {
  const byId = new Map(catalog.filter((item) => item.id).map((item) => [item.id, item]));
  return models.map((model) => {
    const overlay = byId.get(model.id);
    if (!overlay) return model;
    return {
      ...model,
      id: model.id,
      label: overlay.label || model.label,
      description: overlay.description ?? model.description,
      isDefault: overlay.isDefault === true || model.isDefault === true,
    };
  });
}

/**
 * Model and reasoning-effort switching for a contact's runtime
 * (`/api/contacts/:id/models|model|effort`): lists each backend's models,
 * validates the choice, persists it and restarts the conversation backend.
 */
export function contactModelRouter(
  db: Db,
  sse: SseHub,
  manager: AgentManager,
  hubConfig: HubConfig,
  logger?: HubLogger,
): Router {
  const r = Router();
  let codexCache: { expires: number; models: CodexModelOption[] } | null = null;
  let grokCache: { expires: number; models: GrokModelOption[] } | null = null;
  let opencodeCache: { expires: number; models: OpencodeModelOption[] } | null = null;
  let kimiCache: { expires: number; models: KimiModelOption[] } | null = null;
  const apiCaches = new Map<string, { expires: number; models: ModelOption[] }>();

  const catalogLog = (message: string) => logger?.warn({ component: 'models' }, message);
  const catalogOf = (backend: string) => modelCatalog(backend, catalogLog);

  const loadCodexModels = async (cfg: Record<string, any>): Promise<CodexModelOption[]> => {
    if (!codexCache || codexCache.expires < Date.now()) {
      codexCache = {
        expires: Date.now() + 10 * 60_000,
        models: await CodexAppServerBackend.listModels({
          cliPath: cfg.cliPath ?? hubConfig.codex.cliPath,
          cwd: hubConfig.agentsDir,
          log: (message) => logger?.info({ component: 'models' }, message),
        }),
      };
    }
    rememberModelCatalog('codex-cli', codexCache.models);
    return codexCache.models;
  };

  const loadGrokModels = async (cfg: Record<string, any>): Promise<GrokModelOption[]> => {
    if (!grokCache || grokCache.expires < Date.now()) {
      grokCache = {
        expires: Date.now() + 10 * 60_000,
        models: await GrokCliBackend.listModels({
          cliPath: cfg.cliPath ?? hubConfig.grok.cliPath,
          cwd: hubConfig.agentsDir,
          log: (message) => logger?.info({ component: 'models' }, message),
        }),
      };
    }
    rememberModelCatalog('grok-cli', grokCache.models);
    return grokCache.models;
  };

  const loadOpencodeModels = async (cfg: Record<string, any>): Promise<OpencodeModelOption[]> => {
    if (!opencodeCache || opencodeCache.expires < Date.now()) {
      opencodeCache = {
        expires: Date.now() + 10 * 60_000,
        models: await OpencodeCliBackend.listModels({
          cliPath: cfg.cliPath ?? hubConfig.opencode.cliPath,
          cwd: hubConfig.agentsDir,
          log: (message) => logger?.info({ component: 'models' }, message),
        }),
      };
    }
    rememberModelCatalog('opencode-cli', opencodeCache.models);
    return opencodeCache.models;
  };

  const loadKimiModels = async (cfg: Record<string, any>): Promise<KimiModelOption[]> => {
    if (!kimiCache || kimiCache.expires < Date.now()) {
      kimiCache = {
        expires: Date.now() + 10 * 60_000,
        models: await KimiCliBackend.listModels({
          cliPath: cfg.cliPath ?? hubConfig.kimi.cliPath,
          cwd: hubConfig.agentsDir,
          log: (message) => logger?.info({ component: 'models' }, message),
          modelOptions: Array.isArray(cfg.modelOptions) ? cfg.modelOptions : undefined,
        }),
      };
    }
    rememberModelCatalog('kimi-cli', kimiCache.models);
    return kimiCache.models;
  };

  const resolveApiKey = (cfg: Record<string, any>): string => {
    if (typeof cfg.apiKey === 'string' && cfg.apiKey) return cfg.apiKey;
    if (typeof cfg.apiKeyRef === 'string' && cfg.apiKeyRef) return process.env[cfg.apiKeyRef] ?? '';
    return '';
  };

  const loadApiProviderModels = async (cfg: Record<string, any>): Promise<ModelOption[]> => {
    const provider = typeof cfg.provider === 'string' ? cfg.provider : 'openai-compat';
    const baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl : '';
    const apiKey = resolveApiKey(cfg);
    if (!apiKey) throw new Error('缺少 API Key');
    const cacheKey = `${provider}\0${baseUrl}\0${apiKey}`;
    const cached = apiCaches.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.models;
    const models = await listApiModels({
      provider,
      baseUrl,
      apiKey,
      log: (message) => logger?.info({ component: 'models' }, message),
    });
    if (apiCaches.size > 32) {
      const oldest = apiCaches.keys().next().value;
      if (oldest) apiCaches.delete(oldest);
    }
    apiCaches.set(cacheKey, { expires: Date.now() + 10 * 60_000, models });
    return models;
  };

  const publicRow = (c: ContactRow) => publicContactRow(c, manager.statusOf(c.id));

  r.get('/:id/models', async (req, res) => {
    const contact = db
      .prepare('SELECT * FROM contacts WHERE id = ? AND enabled = 1')
      .get(req.params.id) as ContactRow | undefined;
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    if (contact.kind === 'room') return res.json({ models: [], current: '', dynamic: false });

    const cfg = contactConfig(contact);
    const current = typeof cfg.model === 'string' ? cfg.model : '';
    let models: ModelOption[] = [];
    let dynamic = false;
    let warning: string | undefined;
    let efforts: ModelOption[] | undefined;
    let currentEffort: string | undefined;

    if (contact.backend === 'codex') {
      try {
        models = await loadCodexModels(cfg);
        dynamic = true;
        efforts = codexEfforts(models as CodexModelOption[], current);
        currentEffort = typeof cfg.effort === 'string' ? cfg.effort : '';
      } catch (e: any) {
        warning = `Codex 模型列表暂时不可用：${e.message}`;
      }
      models = [{ id: '', label: '默认（Codex 自动选择）' }, ...models, ...customModels(cfg)];
    } else if (contact.backend === 'claude-cli') {
      const catalog = catalogOf('claude-cli');
      models = [...catalog.models, ...customModels(cfg)];
      efforts = catalog.efforts;
      currentEffort = typeof cfg.effort === 'string' ? cfg.effort : '';
    } else if (contact.backend === 'grok-cli') {
      const catalog = catalogOf('grok-cli');
      const defaultModel = catalog.models.find((model) => model.id === '')
        ?? { id: '', label: '默认（Grok CLI 自动选择）', isDefault: true };
      try {
        models = await loadGrokModels(cfg);
        dynamic = true;
      } catch (e: any) {
        warning = `Grok 模型列表暂时不可用：${e.message}`;
      }
      models = [
        defaultModel,
        ...models,
        ...catalog.models.filter((model) => model.id !== ''),
        ...customModels(cfg),
      ];
      if (current && !models.some((model) => model.id === current)) {
        models.push({ id: current, label: current });
      }
      efforts = catalog.efforts;
      currentEffort = typeof cfg.effort === 'string' ? cfg.effort : '';
    } else if (contact.backend === 'opencode-cli') {
      const catalog = catalogOf('opencode-cli');
      const defaultModel = catalog.models.find((model) => model.id === '')
        ?? { id: '', label: '默认（OpenCode 自动选择）', isDefault: true };
      try {
        models = applyCatalogMeta(await loadOpencodeModels(cfg), catalog.models);
        dynamic = true;
      } catch (e: any) {
        warning = `OpenCode 模型列表暂时不可用：${e.message}`;
      }
      models = [
        defaultModel,
        ...models,
        ...catalog.models.filter((model) => model.id !== ''),
        ...customModels(cfg),
      ];
      efforts = catalog.efforts;
      currentEffort = typeof cfg.effort === 'string' ? cfg.effort : '';
    } else if (contact.backend === 'kimi-cli') {
      const catalog = catalogOf('kimi-cli');
      const defaultModel = catalog.models.find((model) => model.id === '')
        ?? { id: '', label: '默认（Kimi CLI 自动选择）', isDefault: true };
      let kimiModels: KimiModelOption[] = [];
      try {
        kimiModels = await loadKimiModels(cfg);
        models = kimiModels;
        dynamic = true;
      } catch (e: any) {
        warning = `Kimi 模型列表暂时不可用：${e.message}`;
      }
      models = [
        defaultModel,
        ...models,
        ...catalog.models.filter((model) => model.id !== ''),
        ...customModels(cfg),
      ];
      if (current && !models.some((model) => model.id === current)) {
        models.push({ id: current, label: current });
      }
      efforts = kimiEfforts(kimiModels.length ? kimiModels : models as KimiModelOption[], current, catalog.efforts);
      currentEffort = typeof cfg.effort === 'string' ? cfg.effort : '';
    } else if (contact.backend === 'api') {
      const provider = typeof cfg.provider === 'string' ? cfg.provider : 'openai-compat';
      const catalog = [
        ...catalogOf('api').models,
        ...catalogOf(`api:${provider}`).models,
      ];
      try {
        models = await loadApiProviderModels(cfg);
        dynamic = true;
      } catch (e: any) {
        warning = `API 模型列表暂时不可用：${e.message}`;
      }
      models = composeApiModels({
        live: models,
        catalog,
        custom: customModels(cfg),
        current,
      });
    } else {
      models = [...customModels(cfg)];
      if (current) models.unshift({ id: current, label: current });
    }

    res.json({ models: dedupeModels(models, current), current, dynamic, warning, efforts, currentEffort });
  });

  r.patch('/:id/model', async (req, res) => {
    const contact = db
      .prepare('SELECT * FROM contacts WHERE id = ? AND enabled = 1')
      .get(req.params.id) as ContactRow | undefined;
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    if (contact.kind === 'room') return res.status(400).json({ error: '群聊请分别切换成员模型' });
    if (manager.isAgentBusy(contact.id)) {
      return res.status(409).json({ error: '正在回复，等这轮结束再切模型' });
    }

    const model: string | null = typeof req.body?.model === 'string' ? req.body.model.trim() : null;
    if (model === null || model.length > 160) return res.status(400).json({ error: 'model 无效' });
    const cfg = contactConfig(contact);
    const previous = typeof cfg.model === 'string' ? cfg.model : '';
    if (previous === model) return res.json(publicRow(contact));

    cfg.model = model;
    if (contact.backend === 'codex' && typeof cfg.effort === 'string') {
      try {
        const models = await loadCodexModels(cfg);
        const selected = (model && models.find((item) => item.id === model))
          || models.find((item) => item.isDefault);
        const supported = selected?.supportedReasoningEfforts?.some((item) => item.id === cfg.effort);
        if (selected && !supported) cfg.effort = '';
      } catch {
        // Switching the model should still work if the optional catalog lookup is unavailable.
      }
    }
    if (contact.backend === 'kimi-cli' && typeof cfg.effort === 'string' && cfg.effort) {
      try {
        const models = await loadKimiModels(cfg);
        const selected = model ? models.find((item) => item.id === model) : undefined;
        if (selected?.supportedReasoningEfforts?.length) {
          const supported = selected.supportedReasoningEfforts.some((item) => item.id === cfg.effort);
          if (!supported) cfg.effort = '';
        }
      } catch {
        // Switching the model should still work if config.toml is unavailable.
      }
    }
    const checked = validateContactConfig(contact.backend, contact.kind, cfg);
    if (!checked.success) {
      return res.status(400).json({ error: formatContactConfigError(checked.error) });
    }
    db.prepare('UPDATE contacts SET config = ? WHERE id = ?').run(JSON.stringify(checked.data), contact.id);
    const updated = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id) as ContactRow;
    await manager.switchContactModel(updated);

    const label = (value: string) => value || '默认模型';
    const result = db
      .prepare(
        `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
         VALUES (?, 'system', 'system', 'text', ?, 'done', ?, 'side')`
      )
      .run(
        contact.id,
        `已从 ${label(previous)} 切换到 ${label(model)}`,
        JSON.stringify({ event: 'model-switch', from: previous, to: model })
      );
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(result.lastInsertRowid));
    sse.broadcast('message', message);
    const payload = publicRow(updated);
    sse.broadcast('contact', payload);
    res.json(payload);
  });

  r.patch('/:id/effort', async (req, res) => {
    const contact = db
      .prepare('SELECT * FROM contacts WHERE id = ? AND enabled = 1')
      .get(req.params.id) as ContactRow | undefined;
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    if (
      contact.backend !== 'claude-cli'
      && contact.backend !== 'codex'
      && contact.backend !== 'opencode-cli'
      && contact.backend !== 'grok-cli'
      && contact.backend !== 'kimi-cli'
    )
      return res.status(400).json({ error: '当前联系人不支持推理强度' });
    if (manager.isAgentBusy(contact.id)) {
      return res.status(409).json({ error: '正在回复，等这轮结束再切强度' });
    }

    const effort: string | null = typeof req.body?.effort === 'string' ? req.body.effort.trim() : null;
    const validEffort = contact.backend === 'codex'
      ? effort === '' || CODEX_EFFORT_IDS.some((id) => id === effort)
      : (catalogOf(contact.backend).efforts ?? []).some((item) => item.id === effort);
    if (effort === null || !validEffort) {
      return res.status(400).json({ error: 'effort 无效' });
    }
    const cfg = contactConfig(contact);
    if (contact.backend === 'codex' && effort) {
      try {
        const models = await loadCodexModels(cfg);
        const currentModel: string = typeof cfg.model === 'string' ? cfg.model : '';
        const selected = (currentModel && models.find((item) => item.id === currentModel))
          || models.find((item) => item.isDefault);
        if (selected && !selected.supportedReasoningEfforts?.some((item) => item.id === effort)) {
          return res.status(400).json({ error: `${selected.label} 不支持 ${effort} 推理强度` });
        }
      } catch {
        // The finite allowlist above remains a safe fallback when model/list is unavailable.
      }
    }
    if (contact.backend === 'kimi-cli' && effort) {
      try {
        const models = await loadKimiModels(cfg);
        const currentModel: string = typeof cfg.model === 'string' ? cfg.model : '';
        const selected = currentModel ? models.find((item) => item.id === currentModel) : undefined;
        if (selected?.supportedReasoningEfforts?.length
          && !selected.supportedReasoningEfforts.some((item) => item.id === effort)) {
          return res.status(400).json({ error: `${selected.label} 不支持 ${effort} 推理强度` });
        }
      } catch {
        // Catalog allowlist remains the fallback when config.toml is unavailable.
      }
    }
    const previous = typeof cfg.effort === 'string' ? cfg.effort : '';
    if (previous === effort) return res.json(publicRow(contact));

    cfg.effort = effort;
    const checked = validateContactConfig(contact.backend, contact.kind, cfg);
    if (!checked.success) {
      return res.status(400).json({ error: formatContactConfigError(checked.error) });
    }
    db.prepare('UPDATE contacts SET config = ? WHERE id = ?').run(JSON.stringify(checked.data), contact.id);
    const updated = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id) as ContactRow;
    // Claude / Codex / OpenCode / Grok / Kimi 都在新底层会话应用 effort，并自动衔接近期聊天。
    await manager.switchContactModel(updated);

    const label = (value: string) => value || '默认强度';
    const result = db
      .prepare(
        `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
         VALUES (?, 'system', 'system', 'text', ?, 'done', ?, 'side')`
      )
      .run(
        contact.id,
        `推理强度已从 ${label(previous)} 切换到 ${label(effort)}`,
        JSON.stringify({ event: 'effort-switch', from: previous, to: effort })
      );
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(result.lastInsertRowid));
    sse.broadcast('message', message);
    const payload = publicRow(updated);
    sse.broadcast('contact', payload);
    res.json(payload);
  });

  return r;
}
