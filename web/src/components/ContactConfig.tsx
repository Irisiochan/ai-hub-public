import { useState } from 'react';
import { formatContactConfigError, validateContactConfig } from '@ai-hub/contact-config';
import { api, type Contact } from '../api';
import ApiFields from './contact-config/ApiFields';
import CliFields from './contact-config/CliFields';
import DelegationFields from './contact-config/DelegationFields';
import RoomFields from './contact-config/RoomFields';
import { useConfirm } from './ConfirmDialog';

interface Props {
  contact: Contact | null; // null = create new
  contacts: Contact[]; // 现有联系人（建群选成员用）
  onClose(): void;
}

type TabId = 'basic' | 'api' | 'room' | 'history' | 'deleg' | 'json';

const TAB_DEFS: Record<TabId, { label: string; title: string; hint: string }> = {
  basic: { label: '基本 · 项目', title: '基本 · 项目访问', hint: '身份、workspace、会话上限' },
  api: { label: '基本 · 接入', title: '基本 · 接入', hint: '身份、provider、key、模型' },
  room: { label: '成员与规则', title: '成员与规则', hint: '拉人、发言顺序、接话轮数' },
  history: { label: '历史与记忆', title: '历史与记忆', hint: '记忆注入、历史预算、摘要' },
  deleg: { label: '派单到 PC', title: '派单到 PC', hint: 'runner / workspace 白名单与限额' },
  json: { label: '高级 JSON', title: '高级 JSON', hint: '完整 config，保存前做 schema 校验' },
};

const SWATCHES = ['#9d8cf5', '#6fd39a', '#5fc2c9', '#e0a05e', '#e56a6a', '#8b8c99'];

export default function ContactConfig({ contact, contacts, onClose }: Props) {
  const confirm = useConfirm();
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
  const [color, setColor] = useState(contact?.color ?? SWATCHES[0]);

  const [provider, setProvider] = useState<string>(cfg.provider ?? 'openai-compat');
  const [baseUrl, setBaseUrl] = useState<string>(cfg.baseUrl ?? '');
  const [apiKey, setApiKey] = useState<string>(cfg.apiKey ?? '');
  const [model, setModel] = useState<string>(cfg.model ?? '');
  const [visionModel, setVisionModel] = useState<string>(cfg.visionModel ?? '');
  // 图片支持：auto=按模型推断（deepseek 等纯文字模型自动剥图），on/off=显式覆盖
  const [imageSupport, setImageSupport] = useState<'auto' | 'on' | 'off'>(
    typeof cfg.supportsImages === 'boolean' ? (cfg.supportsImages ? 'on' : 'off') : 'auto'
  );
  const [systemPrompt, setSystemPrompt] = useState<string>(cfg.systemPrompt ?? '');
  const [maxTokens, setMaxTokens] = useState<number>(cfg.maxTokens ?? 8192);
  const [maxHistory, setMaxHistory] = useState<number>(cfg.maxHistoryMessages ?? 60);
  // 与 server manager.ts API 默认一致：未配置时 compact + 8k 历史预算
  const [historyTokenBudget, setHistoryTokenBudget] = useState<number>(cfg.historyTokenBudget ?? 8000);
  const [minRecentTurns, setMinRecentTurns] = useState<number>(cfg.minRecentTurns ?? 6);
  const [summaryMaxTokens, setSummaryMaxTokens] = useState<number>(cfg.summaryMaxTokens ?? 3000);
  const [historySummary, setHistorySummary] = useState<boolean>(cfg.historySummaryStrategy !== 'off');
  const [memoryPreambleMode, setMemoryPreambleMode] = useState<'full' | 'compact' | 'off'>(
    cfg.memoryPreambleMode ?? 'compact'
  );
  const [promptCache, setPromptCache] = useState<'auto' | 'off'>(cfg.promptCache ?? 'auto');

  const [memInject, setMemInject] = useState<boolean>(mem.injectOnSpawn ?? true);
  const [memSearch, setMemSearch] = useState<boolean>(mem.searchPerTurn ?? true);
  const [memCapture, setMemCapture] = useState<boolean>(mem.capture ?? true);
  const delegation = (cfg.delegation ?? {}) as Record<string, any>;
  const [delegEnabled, setDelegEnabled] = useState<boolean>(delegation.enabled ?? false);
  const [delegWorkspaces, setDelegWorkspaces] = useState<string[]>(
    Array.isArray(delegation.workspaces) ? delegation.workspaces : []
  );
  const [delegRunners, setDelegRunners] = useState<string[]>(
    Array.isArray(delegation.runners) && delegation.runners.length
      ? delegation.runners.filter((runner: unknown) => ['claude', 'codex', 'grok'].includes(String(runner)))
      : ['claude', 'codex', 'grok']
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

  const [rawJson, setRawJson] = useState(() => JSON.stringify(cfg, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 三类联系人的 tab 集合不同：CLI 由服务端配置只能改项目访问；
  // API 是唯一能新建的普通联系人；群聊没有自己的记忆和派单。
  const tabs: TabId[] = isRoom ? ['room', 'json'] : isApi ? ['api', 'history', 'deleg', 'json'] : ['basic', 'history', 'deleg', 'json'];
  const [tab, setTab] = useState<TabId>(tabs[0]);
  const activeTab: TabId = tabs.includes(tab) ? tab : tabs[0];
  const advanced = activeTab === 'json';

  const buildConfig = (): Record<string, unknown> => {
    if (advanced) return JSON.parse(rawJson);
    if (isRoom) return { ...cfg, members, reactionRounds, respondAllByDefault };
    // 保留 workerId/allowSsh 等只能走高级 JSON 改的深层字段
    const delegationCfg = {
      ...delegation,
      enabled: delegEnabled,
      workspaces: delegWorkspaces,
      runners: delegRunners,
      allowShell: delegShell,
      maxOpenJobs: delegMaxJobs,
    };
    if (!isApi)
      return {
        ...cfg,
        projectAccess: { enabled: projectEnabled, workspace: projectWorkspace.trim(), allowShell: projectShell },
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
      supportsImages: imageSupport === 'auto' ? undefined : imageSupport === 'on',
      systemPrompt: systemPrompt.trim() || undefined,
      maxTokens,
      maxHistoryMessages: maxHistory,
      historyTokenBudget,
      minRecentTurns,
      summaryMaxTokens,
      historySummaryStrategy: historySummary ? 'extractive' : 'off',
      memoryPreambleMode,
      promptCache,
      memory: { injectOnSpawn: memInject, searchPerTurn: memSearch, capture: memCapture },
    };
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const rawConfig = buildConfig();
      const backend = isRoom ? 'room' : creating ? 'api' : contact!.backend;
      const checked = validateContactConfig(backend, isRoom ? 'room' : 'dm', rawConfig);
      if (!checked.success) throw new Error(formatContactConfigError(checked.error));
      const config = checked.data;
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
    if (!(await confirm({
      title: '删除联系人',
      message: `确定删除 ${contact.name}？聊天记录保留在库里，联系人从列表消失。`,
      confirmLabel: '删除联系人',
      danger: true,
    }))) {
      return;
    }
    try {
      await api.deleteContact(contact.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const footNote = isRoom
    ? '群聊 v1 不支持成员级别的模型覆盖'
    : isApi
      ? 'API Key 留空表示不改，服务端保留旧值'
      : 'CLI 联系人的深层字段（workerId / allowSsh）只能在高级 JSON 里改';

  const identity = (
    <div className="cfg-group">
      <h3>身份</h3>
      <div className="cfg-row">
        <label className="cfg-field">
          <span>{isRoom ? '群名' : '名称'}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={isRoom ? '比如 三人组' : '比如 GLM'} />
        </label>
        <label className="cfg-field cfg-field-narrow">
          <span>头像</span>
          <input className="cfg-emoji" value={avatar} onChange={(e) => setAvatar(e.target.value)} placeholder="🤖" />
        </label>
      </div>
      <div className="cfg-field">
        <span>主题色 · 只用在头像描边和群聊名字上</span>
        <div className="swatches">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`主题色 ${c}`}
              aria-pressed={c === color}
              className={'swatch' + (c === color ? ' selected' : '')}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
          <label className="swatch swatch-custom" title="自定义颜色">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
        </div>
      </div>
    </div>
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal cfg-modal" onClick={(e) => e.stopPropagation()}>
        <nav className="cfg-nav">
          <div className="cfg-nav-head">
            <span className="avatar" style={{ boxShadow: `inset 0 0 0 1.5px ${color}88` }}>
              {avatar}
            </span>
            <span className="cfg-nav-id">
              <b>{name || (creating ? '新联系人' : contact!.name)}</b>
              <small>{isRoom ? 'room' : creating ? 'api · 新建' : contact!.backend}</small>
            </span>
          </div>

          {creating && (
            <div className="cfg-kind">
              <span className="cfg-kind-label">类型</span>
              <div className="seg">
                <button
                  type="button"
                  className={'seg-btn' + (createKind === 'api' ? ' selected' : '')}
                  onClick={() => {
                    setCreateKind('api');
                    setTab('api');
                  }}
                >
                  API 联系人
                </button>
                <button
                  type="button"
                  className={'seg-btn' + (createKind === 'room' ? ' selected' : '')}
                  onClick={() => {
                    setCreateKind('room');
                    setTab('room');
                  }}
                >
                  群聊
                </button>
              </div>
            </div>
          )}

          <div className="cfg-tabs">
            {tabs.map((id) => (
              <button
                key={id}
                type="button"
                className={'cfg-tab' + (id === activeTab ? ' selected' : '')}
                onClick={() => setTab(id)}
              >
                {TAB_DEFS[id].label}
                {id === 'deleg' && delegEnabled && <span className="cfg-tab-dot" />}
              </button>
            ))}
          </div>

          <div className="cfg-nav-foot">
            {creating ? (
              <p className="cfg-note">只有 API 联系人和群聊能新建，CLI 联系人由服务端配置。</p>
            ) : (
              <button type="button" className="danger-btn" onClick={() => void remove()}>
                删除联系人
              </button>
            )}
          </div>
        </nav>

        <div className="cfg-main">
          <header className="cfg-head">
            <b>{TAB_DEFS[activeTab].title}</b>
            <small>{TAB_DEFS[activeTab].hint}</small>
            <span className="spacer" />
            <button type="button" className="modal-close" onClick={onClose}>
              ✕
            </button>
          </header>

          <div className="cfg-body">
            {activeTab === 'room' && (
              <>
                {identity}
                <RoomFields
                  contacts={dmContacts}
                  members={members}
                  reactionRounds={reactionRounds}
                  respondAllByDefault={respondAllByDefault}
                  onToggleMember={toggleMember}
                  onReactionRounds={setReactionRounds}
                  onRespondAll={setRespondAllByDefault}
                />
              </>
            )}

            {activeTab === 'basic' && (
              <>
                {identity}
                <CliFields
                  contact={contact!}
                  projectEnabled={projectEnabled}
                  projectWorkspace={projectWorkspace}
                  projectShell={projectShell}
                  sessionTokenLimit={sessionTokenLimit}
                  onProjectEnabled={setProjectEnabled}
                  onProjectWorkspace={setProjectWorkspace}
                  onProjectShell={setProjectShell}
                  onSessionTokenLimit={setSessionTokenLimit}
                />
              </>
            )}

            {(activeTab === 'api' || activeTab === 'history') && (
              <>
                {activeTab === 'api' && identity}
                <ApiFields
                  section={activeTab === 'api' ? 'connection' : 'context'}
                  readOnlyConnection={!isApi}
                  provider={provider}
                  model={model}
                  visionModel={visionModel}
                  imageSupport={imageSupport}
                  baseUrl={baseUrl}
                  apiKey={apiKey}
                  apiKeyPlaceholder={cfg.apiKey ? `已设置（${cfg.apiKey}），留空不改` : 'sk-…'}
                  systemPrompt={systemPrompt}
                  maxTokens={maxTokens}
                  maxHistory={maxHistory}
                  historyTokenBudget={historyTokenBudget}
                  minRecentTurns={minRecentTurns}
                  summaryMaxTokens={summaryMaxTokens}
                  memoryPreambleMode={memoryPreambleMode}
                  promptCache={promptCache}
                  historySummary={historySummary}
                  memInject={memInject}
                  memSearch={memSearch}
                  memCapture={memCapture}
                  onProvider={setProvider}
                  onModel={setModel}
                  onVisionModel={setVisionModel}
                  onImageSupport={setImageSupport}
                  onBaseUrl={setBaseUrl}
                  onApiKey={setApiKey}
                  onSystemPrompt={setSystemPrompt}
                  onMaxTokens={setMaxTokens}
                  onMaxHistory={setMaxHistory}
                  onHistoryTokenBudget={setHistoryTokenBudget}
                  onMinRecentTurns={setMinRecentTurns}
                  onSummaryMaxTokens={setSummaryMaxTokens}
                  onMemoryPreambleMode={setMemoryPreambleMode}
                  onPromptCache={setPromptCache}
                  onHistorySummary={setHistorySummary}
                  onMemInject={setMemInject}
                  onMemSearch={setMemSearch}
                  onMemCapture={setMemCapture}
                />
              </>
            )}

            {activeTab === 'deleg' && (
              <DelegationFields
                contact={contact}
                enabled={delegEnabled}
                workspaces={delegWorkspaces}
                runners={delegRunners}
                workspaceDraft={delegWorkspaceDraft}
                allowShell={delegShell}
                maxOpenJobs={delegMaxJobs}
                onEnabled={setDelegEnabled}
                onWorkspaces={setDelegWorkspaces}
                onRunners={setDelegRunners}
                onWorkspaceDraft={setDelegWorkspaceDraft}
                onAddWorkspace={addDelegWorkspace}
                onAllowShell={setDelegShell}
                onMaxOpenJobs={setDelegMaxJobs}
              />
            )}

            {activeTab === 'json' && (
              <div className="cfg-group">
                <p className="cfg-warn">
                  ⚠ 直接编辑整份 config，保存前会做一次 schema 校验；上面各页的改动会被这里覆盖。
                </p>
                <textarea
                  className="json-editor"
                  rows={16}
                  value={rawJson}
                  onChange={(e) => setRawJson(e.target.value)}
                  spellCheck={false}
                />
              </div>
            )}

            {error && <div className="modal-error">⚠ {error}</div>}
          </div>

          <footer className="cfg-foot">
            <span className="cfg-note">{footNote}</span>
            <span className="spacer" />
            <button className="ghost-btn" onClick={onClose}>
              取消
            </button>
            <button className="primary-btn" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存'}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
