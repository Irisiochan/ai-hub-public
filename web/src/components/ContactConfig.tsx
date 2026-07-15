import { useState } from 'react';
import { api, type Contact } from '../api';

interface Props {
  contact: Contact | null; // null = create new
  contacts: Contact[]; // 现有联系人（建群选成员用）
  onClose(): void;
}

export default function ContactConfig({ contact, contacts, onClose }: Props) {
  const creating = contact === null;
  const cfg = (contact?.config ?? {}) as Record<string, any>;
  const mem = (cfg.memory ?? {}) as Record<string, any>;
  const project = (cfg.projectAccess ?? {}) as Record<string, any>;
  const [createKind, setCreateKind] = useState<'api' | 'room'>('api');
  const isRoom = creating ? createKind === 'room' : contact?.kind === 'room';
  const isApi = !isRoom && (creating || contact?.backend === 'api');
  const dmContacts = contacts.filter((c) => c.kind !== 'room');
  const [members, setMembers] = useState<string[]>((cfg.members as string[]) ?? []);
  const [reactionRounds, setReactionRounds] = useState<number>(cfg.reactionRounds ?? 1);
  const [respondAllByDefault, setRespondAllByDefault] = useState<boolean>(cfg.respondAllByDefault ?? false);
  const toggleMember = (id: string) =>
    setMembers((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]));

  const [name, setName] = useState(contact?.name ?? '');
  const [avatar, setAvatar] = useState(contact?.avatar ?? '🤖');
  const [color, setColor] = useState(contact?.color ?? '#8888aa');

  const [provider, setProvider] = useState<string>(cfg.provider ?? 'openai-compat');
  const [baseUrl, setBaseUrl] = useState<string>(cfg.baseUrl ?? '');
  const [apiKey, setApiKey] = useState<string>(cfg.apiKey ?? '');
  const [model, setModel] = useState<string>(cfg.model ?? '');
  const [visionModel, setVisionModel] = useState<string>(cfg.visionModel ?? '');
  const [systemPrompt, setSystemPrompt] = useState<string>(cfg.systemPrompt ?? '');
  const [maxHistory, setMaxHistory] = useState<number>(cfg.maxHistoryMessages ?? 60);
  const [historyTokenBudget, setHistoryTokenBudget] = useState<number>(cfg.historyTokenBudget ?? 24000);
  const [minRecentTurns, setMinRecentTurns] = useState<number>(cfg.minRecentTurns ?? 6);
  const [summaryMaxTokens, setSummaryMaxTokens] = useState<number>(cfg.summaryMaxTokens ?? 3000);
  const [historySummary, setHistorySummary] = useState<boolean>(cfg.historySummaryStrategy !== 'off');
  const [memoryPreambleMode, setMemoryPreambleMode] = useState<'full' | 'compact' | 'off'>(
    cfg.memoryPreambleMode ?? (creating ? 'compact' : 'full')
  );

  const [memInject, setMemInject] = useState<boolean>(mem.injectOnSpawn ?? true);
  const [memSearch, setMemSearch] = useState<boolean>(mem.searchPerTurn ?? true);
  const [memCapture, setMemCapture] = useState<boolean>(mem.capture ?? true);
  const delegation = (cfg.delegation ?? {}) as Record<string, any>;
  const [delegEnabled, setDelegEnabled] = useState<boolean>(delegation.enabled ?? false);
  const [delegWorkspaces, setDelegWorkspaces] = useState<string[]>(
    Array.isArray(delegation.workspaces) ? delegation.workspaces : []
  );
  const [delegWorkspaceDraft, setDelegWorkspaceDraft] = useState('');
  const [delegShell, setDelegShell] = useState<boolean>(delegation.allowShell ?? false);
  const [delegMaxJobs, setDelegMaxJobs] = useState<number>(delegation.maxOpenJobs ?? 3);
  const addDelegWorkspace = () => {
    const value = delegWorkspaceDraft.trim();
    if (!value) return;
    setDelegWorkspaces((prev) => (prev.includes(value) ? prev : [...prev, value]));
    setDelegWorkspaceDraft('');
  };
  const [projectEnabled, setProjectEnabled] = useState<boolean>(project.enabled ?? false);
  const [projectWorkspace, setProjectWorkspace] = useState<string>(project.workspace ?? '');
  const [projectShell, setProjectShell] = useState<boolean>(project.allowShell ?? false);
  const [sessionTokenLimit, setSessionTokenLimit] = useState<number>(cfg.maxSessionInputTokens ?? 120000);

  const [advanced, setAdvanced] = useState(false);
  const [rawJson, setRawJson] = useState(() => JSON.stringify(cfg, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const buildConfig = (): Record<string, unknown> => {
    if (advanced) return JSON.parse(rawJson);
    if (isRoom) return { ...cfg, members, reactionRounds, respondAllByDefault };
    // 保留 runners/workerId/allowSsh 等只能走高级 JSON 改的深层字段
    const delegationCfg = {
      ...delegation,
      enabled: delegEnabled,
      workspaces: delegWorkspaces,
      allowShell: delegShell,
      maxOpenJobs: delegMaxJobs,
    };
    if (!isApi) return {
      ...cfg,
      projectAccess: {
        enabled: projectEnabled,
        workspace: projectWorkspace.trim(),
        allowShell: projectShell,
      },
      maxSessionInputTokens: sessionTokenLimit,
      delegation: delegationCfg,
    };
    return {
      ...cfg,
      delegation: delegationCfg,
      provider,
      baseUrl: baseUrl.trim(),
      apiKey: apiKey, // 打码值/空 = 服务端保留旧 key
      model: model.trim(),
      visionModel: visionModel.trim() || undefined,
      systemPrompt: systemPrompt.trim() || undefined,
      maxHistoryMessages: maxHistory,
      historyTokenBudget,
      minRecentTurns,
      summaryMaxTokens,
      historySummaryStrategy: historySummary ? 'extractive' : 'off',
      memoryPreambleMode,
      memory: { injectOnSpawn: memInject, searchPerTurn: memSearch, capture: memCapture },
    };
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const config = buildConfig();
      if (creating) {
        if (!name.trim()) throw new Error('得有个名字');
        if (isRoom && members.length === 0) throw new Error('群聊至少拉一个人');
        await api.createContact({
          name,
          avatar: avatar === '🤖' && isRoom ? '👥' : avatar,
          color,
          backend: isRoom ? 'room' : 'api',
          kind: isRoom ? 'room' : 'dm',
          config,
        });
      } else {
        await api.updateContact(contact!.id, { name, avatar, color, config });
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!contact) return;
    if (!window.confirm(`确定删除 ${contact.name}？聊天记录保留在库里，联系人从列表消失。`)) return;
    try {
      await api.deleteContact(contact.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{creating ? (isRoom ? '建群聊' : '新联系人（API 接入）') : `设置 · ${contact!.name}`}</h2>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          {creating && (
            <div className="field-row">
              <label className="field">
                类型
                <select value={createKind} onChange={(e) => setCreateKind(e.target.value as 'api' | 'room')}>
                  <option value="api">API 联系人</option>
                  <option value="room">群聊（拉现有联系人）</option>
                </select>
              </label>
            </div>
          )}
          <div className="field-row">
            <label className="field" style={{ flex: 2 }}>
              名称
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="比如 GLM" />
            </label>
            <label className="field" style={{ flex: 1 }}>
              头像
              <input value={avatar} onChange={(e) => setAvatar(e.target.value)} placeholder="🤖" />
            </label>
            <label className="field" style={{ flex: 1 }}>
              颜色
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
          </div>

          {!creating && (
            <p className="field-hint">
              后端：<code>{contact!.backend}</code>
              {!isApi && ' — CLI 联系人的深层配置用下面的「高级 JSON」改'}
            </p>
          )}

          {isRoom && !advanced && (
            <fieldset className="mem-toggles">
              <legend>群成员</legend>
              {dmContacts.map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={members.includes(c.id)}
                    onChange={() => toggleMember(c.id)}
                  />
                  {c.avatar} {c.name}
                  <span className="field-hint" style={{ marginLeft: 6 }}>
                    ({c.backend})
                  </span>
                </label>
              ))}
              <p className="field-hint">
                群里用 @名字 点名，@all 叫全员；默认无 @ 时不调用模型，避免无意消耗。
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={respondAllByDefault}
                  onChange={(e) => setRespondAllByDefault(e.target.checked)}
                />
                无 @ 时默认全员响应（更热闹，也更耗 token）
              </label>
              <label className="field" style={{ maxWidth: 160 }}>
                接话轮数（0-3）
                <input
                  type="number"
                  min={0}
                  max={3}
                  value={reactionRounds}
                  onChange={(e) => setReactionRounds(Math.min(3, Math.max(0, Number(e.target.value) || 0)))}
                />
              </label>
              <p className="field-hint">
                每轮点名发言后，成员会看到彼此的新发言并可自然接话（或沉默）。0 = 关闭，回到纯点名制。
              </p>
            </fieldset>
          )}

          {isApi && !advanced && (
            <>
              <div className="field-row">
                <label className="field" style={{ flex: 1 }}>
                  协议
                  <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                    <option value="openai-compat">OpenAI 兼容（GLM/DeepSeek/…）</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </label>
                <label className="field" style={{ flex: 1 }}>
                  模型
                  <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="glm-4-plus" />
                </label>
              </div>
              <label className="field">
                图片模型（可选）
                <input
                  value={visionModel}
                  onChange={(e) => setVisionModel(e.target.value)}
                  placeholder="例如 qwen3-vl-plus；留空则沿用普通模型"
                />
                <span className="field-hint">只在消息含图片时使用，不改变日常文字聊天模型。</span>
              </label>
              <label className="field">
                Base URL
                <input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://open.bigmodel.cn/api/paas（会自动拼 /v1/…）"
                />
              </label>
              <label className="field">
                API Key
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={cfg.apiKey ? `已设置（${cfg.apiKey}），留空不改` : 'sk-…'}
                />
              </label>
              <label className="field">
                人设 / 系统提示
                <textarea
                  rows={3}
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="这个 AI 是谁、怎么说话"
                />
              </label>
              <div className="field-row">
                <label className="field" style={{ flex: 1 }}>
                  历史条数
                  <input
                    type="number"
                    min={2}
                    max={200}
                    value={maxHistory}
                    onChange={(e) => setMaxHistory(Number(e.target.value) || 60)}
                  />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  历史 token 预算
                  <input
                    type="number"
                    min={2048}
                    step={1000}
                    value={historyTokenBudget}
                    onChange={(e) => setHistoryTokenBudget(Math.max(2048, Number(e.target.value) || 24000))}
                  />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  至少保留近期轮数
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={minRecentTurns}
                    onChange={(e) => setMinRecentTurns(Math.min(30, Math.max(1, Number(e.target.value) || 6)))}
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field" style={{ flex: 1 }}>
                  滚动摘要上限（token）
                  <input
                    type="number"
                    min={256}
                    step={250}
                    value={summaryMaxTokens}
                    onChange={(e) => setSummaryMaxTokens(Math.max(256, Number(e.target.value) || 3000))}
                  />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  记忆前缀
                  <select
                    value={memoryPreambleMode}
                    onChange={(e) => setMemoryPreambleMode(e.target.value as 'full' | 'compact' | 'off')}
                  >
                    <option value="compact">compact（推荐，核心身份 + 动态检索）</option>
                    <option value="full">full（完整 get_context）</option>
                    <option value="off">off（不注入固定前缀）</option>
                  </select>
                </label>
              </div>
              <label>
                <input
                  type="checkbox"
                  checked={historySummary}
                  onChange={(e) => setHistorySummary(e.target.checked)}
                />
                超预算时持久化滚动摘要（关闭后只裁剪旧原文）
              </label>
              <p className="field-hint">
                历史条数是硬上限；token 预算先保近期原文，再把更早消息压成联系人独立摘要。编辑或删除会自动重建，避免残留旧内容。
              </p>
              <fieldset className="mem-toggles">
                <legend>记忆库</legend>
                <label>
                  <input type="checkbox" checked={memInject} onChange={(e) => setMemInject(e.target.checked)} />
                  开局注入核心记忆
                </label>
                <label>
                  <input type="checkbox" checked={memSearch} onChange={(e) => setMemSearch(e.target.checked)} />
                  每轮自动检索
                </label>
                <label>
                  <input type="checkbox" checked={memCapture} onChange={(e) => setMemCapture(e.target.checked)} />
                  触发词自动记录
                </label>
              </fieldset>
            </>
          )}

          {!isRoom && !isApi && !advanced && (
            <fieldset className="mem-toggles">
              <legend>项目权限</legend>
              <label>
                <input
                  type="checkbox"
                  checked={projectEnabled}
                  onChange={(e) => setProjectEnabled(e.target.checked)}
                />
                允许这个联系人修改指定项目
              </label>
              {projectEnabled && (
                <>
                  <label className="field">
                    项目工作区（必须已存在，不能填磁盘根目录）
                    <input
                      value={projectWorkspace}
                      onChange={(e) => setProjectWorkspace(e.target.value)}
                      placeholder="/opt/my-project 或 E:\\projects\\my-project"
                    />
                  </label>
                  {contact?.backend === 'claude-cli' && (
                    <label>
                      <input
                        type="checkbox"
                        checked={projectShell}
                        onChange={(e) => setProjectShell(e.target.checked)}
                      />
                      同时允许 Bash（可运行测试/构建，风险更高）
                    </label>
                  )}
                  <p className="field-hint">
                    默认仍只读。开启后 Claude 获得 Read/Write/Edit，Codex 使用 workspace-write；工具调用会保留在聊天审计记录中，可随时关闭。
                  </p>
                </>
              )}
              <label className="field" style={{ maxWidth: 240 }}>
                换新会话阈值（输入 token，0 = 关闭）
                <input
                  type="number"
                  min={0}
                  step={10000}
                  value={sessionTokenLimit}
                  onChange={(e) => setSessionTokenLimit(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
              <p className="field-hint">达到阈值后自动开启新 thread，并注入最近对话的压缩回放与最新记忆。</p>
            </fieldset>
          )}

          {!isRoom && !advanced && (
            <fieldset className="mem-toggles">
              <legend>PC Worker 委派</legend>
              <label>
                <input
                  type="checkbox"
                  checked={delegEnabled}
                  onChange={(e) => setDelegEnabled(e.target.checked)}
                />
                允许这个联系人把编码任务派给 PC Worker
              </label>
              {delegEnabled && (
                <>
                  <div className="deleg-workspaces">
                    <span className="field-hint">workspace 白名单（PC 上的绝对路径，派单只能落在这些目录里）</span>
                    {delegWorkspaces.length === 0 && (
                      <p className="field-hint deleg-empty">⚠ 白名单为空时无法派单</p>
                    )}
                    {delegWorkspaces.map((ws) => (
                      <div className="deleg-workspace-row" key={ws}>
                        <code>{ws}</code>
                        <button
                          type="button"
                          aria-label={`移除 ${ws}`}
                          onClick={() => setDelegWorkspaces((prev) => prev.filter((w) => w !== ws))}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <div className="deleg-workspace-add">
                      <input
                        value={delegWorkspaceDraft}
                        placeholder="C:\path\to\project"
                        onChange={(e) => setDelegWorkspaceDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addDelegWorkspace();
                          }
                        }}
                      />
                      <button type="button" onClick={addDelegWorkspace} disabled={!delegWorkspaceDraft.trim()}>
                        添加
                      </button>
                    </div>
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={delegShell}
                      onChange={(e) => setDelegShell(e.target.checked)}
                    />
                    允许派带 Shell 的任务（Codex 任务必需；风险更高）
                  </label>
                  <label className="field" style={{ maxWidth: 200 }}>
                    同时在跑/在排任务上限
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={delegMaxJobs}
                      onChange={(e) => setDelegMaxJobs(Math.min(10, Math.max(1, Number(e.target.value) || 3)))}
                    />
                  </label>
                  <p className="field-hint">
                    SSH 等高影响能力永远不给模型，只能在 🖥 面板手动派。委派任务会以子会话形式挂在原聊天消息下。
                    {contact?.backend === 'codex' &&
                      ' Codex 会按联系人自动接入 hub MCP，无需修改全局 config.toml。'}
                  </p>
                </>
              )}
            </fieldset>
          )}

          <label className="advanced-toggle">
            <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} />
            高级 JSON（直接编辑完整 config）
          </label>
          {advanced && (
            <textarea
              className="json-editor"
              rows={10}
              value={rawJson}
              onChange={(e) => setRawJson(e.target.value)}
              spellCheck={false}
            />
          )}

          {error && <div className="modal-error">⚠ {error}</div>}
        </div>

        <footer className="modal-footer">
          {!creating && (
            <button className="danger-btn" onClick={() => void remove()}>
              删除联系人
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button className="primary-btn" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  );
}
