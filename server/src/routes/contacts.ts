import { Router } from 'express';
import type { AgentManager } from '../agents/manager.js';
import { CodexAppServerBackend, type CodexModelOption } from '../agents/codexAppServer.js';
import type { HubConfig } from '../config.js';
import type { Db, ContactRow } from '../db.js';
import type { SseHub } from '../sse.js';

/** apiKey never leaves the server in clear — mask to ••••+last4 for the UI. */
function maskConfig(config: Record<string, any>): Record<string, any> {
  if (typeof config.apiKey === 'string' && config.apiKey.length > 0) {
    return { ...config, apiKey: `••••${config.apiKey.slice(-4)}` };
  }
  return config;
}

function isMaskedKey(v: unknown): boolean {
  return typeof v === 'string' && (v === '' || v.startsWith('••••'));
}

interface ModelOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

const CLAUDE_MODELS: ModelOption[] = [
  { id: '', label: '默认（Claude CLI 自动选择）', isDefault: true },
  { id: 'sonnet', label: 'Sonnet（最新）' },
  { id: 'opus', label: 'Opus（最新）' },
  { id: 'haiku', label: 'Haiku（最新）' },
  { id: 'fable', label: 'Fable' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
];

// claude CLI 的 --effort 档位；'' 表示不传 flag，交给 CLI 默认（当前是 xhigh）
const CLAUDE_EFFORTS: ModelOption[] = [
  { id: '', label: '默认强度', isDefault: true },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
  { id: 'max', label: 'max' },
];

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

export function contactsRouter(
  db: Db,
  sse: SseHub,
  manager: AgentManager,
  hubConfig: HubConfig
): Router {
  const r = Router();
  let codexCache: { expires: number; models: CodexModelOption[] } | null = null;

  const loadCodexModels = async (cfg: Record<string, any>): Promise<CodexModelOption[]> => {
    if (!codexCache || codexCache.expires < Date.now()) {
      codexCache = {
        expires: Date.now() + 10 * 60_000,
        models: await CodexAppServerBackend.listModels({
          cliPath: cfg.cliPath ?? hubConfig.codex.cliPath,
          cwd: hubConfig.agentsDir,
          log: (m) => console.log(`  [models] ${m}`),
        }),
      };
    }
    return codexCache.models;
  };

  const publicRow = (c: ContactRow) => {
    const status = manager.statusOf(c.id);
    return {
      ...c,
      config: maskConfig(JSON.parse(c.config || '{}')),
      state: status.state,
      // Room busy member display name (undefined for DM / idle). Used by resync
      // so thinking labels stay on the contact, not the room title.
      member: status.member,
    };
  };

  r.get('/', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT c.*,
           (SELECT content FROM messages m WHERE m.contact_id = c.id AND m.kind = 'text'
              AND m.deleted = 0 ORDER BY m.id DESC LIMIT 1) AS last_content,
           (SELECT created_at FROM messages m WHERE m.contact_id = c.id AND m.deleted = 0
              ORDER BY m.id DESC LIMIT 1) AS last_at
         FROM contacts c WHERE c.enabled = 1 ORDER BY c.sort_order, c.created_at`
      )
      .all() as (ContactRow & { last_content: string | null; last_at: string | null })[];

    res.json({ contacts: rows.map((c) => publicRow(c)) });
  });

  r.get('/:id/models', async (req, res) => {
    const contact = db
      .prepare('SELECT * FROM contacts WHERE id = ? AND enabled = 1')
      .get(req.params.id) as ContactRow | undefined;
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    if (contact.kind === 'room') return res.json({ models: [], current: '', dynamic: false });

    const cfg = JSON.parse(contact.config || '{}');
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
      models = [...CLAUDE_MODELS, ...customModels(cfg)];
      efforts = CLAUDE_EFFORTS;
      currentEffort = typeof cfg.effort === 'string' ? cfg.effort : '';
    } else if (contact.backend === 'grok-cli') {
      // grok build 还在 beta，模型 id 没有稳定目录——默认自动选择，特定 id 走 modelOptions
      models = [{ id: '', label: '默认（Grok CLI 自动选择）', isDefault: true }, ...customModels(cfg)];
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
    const cfg = JSON.parse(contact.config || '{}');
    const previous = typeof cfg.model === 'string' ? cfg.model : '';
    if (previous === model) return res.json(publicRow(contact));

    if (model) cfg.model = model;
    else delete cfg.model;
    if (contact.backend === 'codex' && typeof cfg.effort === 'string') {
      try {
        const models = await loadCodexModels(cfg);
        const selected = (model && models.find((item) => item.id === model))
          || models.find((item) => item.isDefault);
        const supported = selected?.supportedReasoningEfforts?.some((item) => item.id === cfg.effort);
        if (selected && !supported) delete cfg.effort;
      } catch {
        // Switching the model should still work if the optional catalog lookup is unavailable.
      }
    }
    db.prepare('UPDATE contacts SET config = ? WHERE id = ?').run(JSON.stringify(cfg), contact.id);
    const updated = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id) as ContactRow;
    await manager.switchContactModel(updated);

    const label = (value: string) => value || '默认模型';
    const result = db
      .prepare(
        `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta)
         VALUES (?, 'system', 'system', 'text', ?, 'done', ?)`
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
    if (contact.backend !== 'claude-cli' && contact.backend !== 'codex')
      return res.status(400).json({ error: '当前联系人不支持推理强度' });
    if (manager.isAgentBusy(contact.id)) {
      return res.status(409).json({ error: '正在回复，等这轮结束再切强度' });
    }

    const effort: string | null = typeof req.body?.effort === 'string' ? req.body.effort.trim() : null;
    const validEffort = contact.backend === 'claude-cli'
      ? CLAUDE_EFFORTS.some((item) => item.id === effort)
      : effort === '' || CODEX_EFFORT_IDS.some((id) => id === effort);
    if (effort === null || !validEffort) {
      return res.status(400).json({ error: 'effort 无效' });
    }
    const cfg = JSON.parse(contact.config || '{}');
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
    const previous = typeof cfg.effort === 'string' ? cfg.effort : '';
    if (previous === effort) return res.json(publicRow(contact));

    if (effort) cfg.effort = effort;
    else delete cfg.effort;
    db.prepare('UPDATE contacts SET config = ? WHERE id = ?').run(JSON.stringify(cfg), contact.id);
    const updated = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id) as ContactRow;
    // 两种 CLI 都在新底层会话应用 effort，并自动衔接近期聊天。
    await manager.switchContactModel(updated);

    const label = (value: string) => value || '默认强度';
    const result = db
      .prepare(
        `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta)
         VALUES (?, 'system', 'system', 'text', ?, 'done', ?)`
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

  r.post('/', async (req, res) => {
    const { id, name, avatar, color, backend, config } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    let slug = (typeof id === 'string' && id ? id : name)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    // 纯中文名字 slug 会变空——退化成随机 id，显示名不受影响
    if (!slug) slug = `c${Date.now().toString(36)}`;
    const existing = db.prepare('SELECT * FROM contacts WHERE id = ?').get(slug) as
      | ContactRow
      | undefined;
    if (existing?.enabled) {
      return res.status(409).json({ error: `联系人 ${slug} 已存在` });
    }

    const isRoom = req.body?.kind === 'room';
    const cfg = config && typeof config === 'object' ? { ...config } : {};
    if (isRoom) {
      const members: string[] = Array.isArray(cfg.members) ? cfg.members : [];
      const valid = members.filter((id) =>
        db.prepare("SELECT id FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'").get(id)
      );
      if (valid.length === 0)
        return res.status(400).json({ error: '群聊至少要拉一个现有联系人' });
      cfg.members = valid;
    }
    const backendKind = isRoom
      ? 'room'
      : ['claude-cli', 'codex', 'grok-cli', 'api'].includes(backend)
        ? backend
        : 'api';

    // 软删过的同名坑位：UPDATE 复活并覆盖（消息表有外键，不能 DELETE；历史正好延续）
    db.prepare(
      `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, 50, 1)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, avatar = excluded.avatar, color = excluded.color,
         backend = excluded.backend, kind = excluded.kind, config = excluded.config,
         enabled = 1`
    ).run(
      slug,
      name.trim(),
      typeof avatar === 'string' && avatar ? avatar : isRoom ? '👥' : '🤖',
      typeof color === 'string' && color ? color : '#8888aa',
      backendKind,
      isRoom ? 'room' : 'dm',
      JSON.stringify(cfg)
    );

    const created = db.prepare('SELECT * FROM contacts WHERE id = ?').get(slug) as ContactRow;
    const payload = publicRow(created);
    sse.broadcast('contact', payload);
    res.status(201).json(payload);
  });

  r.patch('/:id', async (req, res) => {
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id) as
      | ContactRow
      | undefined;
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const { name, avatar, color, config } = req.body ?? {};
    let nextConfig = contact.config;
    if (config && typeof config === 'object') {
      const oldConfig = JSON.parse(contact.config || '{}');
      const merged = { ...config };
      // masked/empty key from the UI means "keep the stored one"
      if (isMaskedKey(merged.apiKey) && oldConfig.apiKey) merged.apiKey = oldConfig.apiKey;
      nextConfig = JSON.stringify(merged);
    }
    db.prepare('UPDATE contacts SET name = ?, avatar = ?, color = ?, config = ? WHERE id = ?').run(
      typeof name === 'string' && name.trim() ? name.trim() : contact.name,
      typeof avatar === 'string' && avatar ? avatar : contact.avatar,
      typeof color === 'string' && color ? color : contact.color,
      nextConfig,
      contact.id
    );
    const updated = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id) as ContactRow;
    await manager.notifyContactUpdated(updated);
    const payload = publicRow(updated);
    sse.broadcast('contact', payload);
    res.json(payload);
  });

  r.delete('/:id', async (req, res) => {
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id) as
      | ContactRow
      | undefined;
    if (!contact) return res.status(404).json({ error: 'contact not found' });
    db.prepare('UPDATE contacts SET enabled = 0 WHERE id = ?').run(contact.id);
    await manager.remove(contact.id);
    sse.broadcast('contact', { id: contact.id, enabled: 0 });
    res.json({ ok: true });
  });

  return r;
}
