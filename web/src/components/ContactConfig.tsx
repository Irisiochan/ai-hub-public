import { useState } from 'react';
import { formatContactConfigError, validateContactConfig } from '@ai-hub/contact-config';
import { api, type Contact } from '../api';
import ApiFields from './contact-config/ApiFields';
import CliFields from './contact-config/CliFields';
import DelegationFields from './contact-config/DelegationFields';
import RoomFields from './contact-config/RoomFields';

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
  // 图片支持：auto=按模型推断（deepseek 等纯文字模型自动剥图），on/off=显式覆盖
  const [imageSupport, setImageSupport] = useState<'auto' | 'on' | 'off'>(
    typeof cfg.supportsImages === 'boolean' ? (cfg.supportsImages ? 'on' : 'off') : 'auto'
  );
  const [systemPrompt, setSystemPrompt] = useState<string>(cfg.systemPrompt ?? '');
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

  const [advanced, setAdvanced] = useState(false);
  const [rawJson, setRawJson] = useState(() => JSON.stringify(cfg, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
      supportsImages: imageSupport === 'auto' ? undefined : imageSupport === 'on',
      systemPrompt: systemPrompt.trim() || undefined,
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
      <div
        className={`modal contact-config-modal${isApi && !advanced ? ' contact-config-modal-api' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2>{creating ? (isRoom ? '建群聊' : '新联系人（API 接入）') : `设置 · ${contact!.name}`}</h2>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body contact-config-body">
          <div className="contact-config-basics">
            {creating && (
              <label className="field">
                类型
                <select value={createKind} onChange={(e) => setCreateKind(e.target.value as 'api' | 'room')}>
                  <option value="api">API 联系人</option>
                  <option value="room">群聊（拉现有联系人）</option>
                </select>
              </label>
            )}
            <label className="field field-wide">
              名称
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="比如 GLM" />
            </label>
            <label className="field">
              头像
              <input value={avatar} onChange={(e) => setAvatar(e.target.value)} placeholder="🤖" />
            </label>
            <label className="field">
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
            <RoomFields
              contacts={dmContacts}
              members={members}
              reactionRounds={reactionRounds}
              respondAllByDefault={respondAllByDefault}
              onToggleMember={toggleMember}
              onReactionRounds={setReactionRounds}
              onRespondAll={setRespondAllByDefault}
            />
          )}

          {isApi && !advanced && (
            <ApiFields
              provider={provider}
              model={model}
              visionModel={visionModel}
              imageSupport={imageSupport}
              baseUrl={baseUrl}
              apiKey={apiKey}
              apiKeyPlaceholder={cfg.apiKey ? `已设置（${cfg.apiKey}），留空不改` : 'sk-…'}
              systemPrompt={systemPrompt}
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
          )}

          {!isRoom && !isApi && !advanced && (
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
          )}

          {!isRoom && !advanced && (
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
