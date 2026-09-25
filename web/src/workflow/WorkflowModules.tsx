import { useEffect, useId, useRef, useState } from 'react';
import {
  api, type WorkflowAgent, type WorkflowModule, type WorkflowModuleBinding,
  type WorkflowModuleId, type WorkflowModuleJob, type WorkflowModulesResponse, type WorkflowWorkerTarget,
} from '../platform/api';
import { useWorkerState, workerState } from '../jobs/useWorkerState';
import {
  bindingForAgent, chooseEffort, sameModuleBinding, validModuleBinding,
  WORKFLOW_MAIN, WORKFLOW_SUPPORT,
} from './moduleBindings';
import { Icon, type IconName } from '../platform/icons';

const STATUS = { idle: '就绪', running: '运行中', blocked: '等待接管', unavailable: '暂不可用' };
const JOB_STATUS: Record<string, string> = {
  pending: '排队中', claimed: '已认领', running: '运行中', recovering: '恢复中',
  failed: '失败', blocked: '受阻', cancelled: '已停止', paused: '已暂停',
  pause_requested: '正在暂停', cancel_requested: '正在停止', done: '已完成', expired: '已过期',
};

// Avatars are identity shorthand, not decoration: one glyph is enough to tell
// two bindings apart at a glance without the name being read in full.
const initial = (name: string) => (name.trim()[0] ?? '·').toUpperCase();

function WorkerTargetPicker({ data, onSaved, onClose }: {
  data: WorkflowModulesResponse; onSaved(message: string): void; onClose(): void;
}) {
  const [options, setOptions] = useState<Array<{ label: string; target: WorkflowWorkerTarget }>>([]);
  const [selection, setSelection] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([api.workers(), api.projectTargets()]).then(([{ workers }, { targets }]) => {
      if (!active) return;
      const choices: Array<{ label: string; target: WorkflowWorkerTarget }> = [];
      for (const worker of workers) {
        for (const root of worker.capabilities.workspaces ?? []) {
          if (!/^[A-Za-z]:[\\/]/.test(root)) continue;
          const workspace = root.replaceAll('\\', '/').replace(/\/+$/, '');
          choices.push({ label: `PC · ${worker.name} · ${workspace}`, target: { workerId: worker.id, workspace } });
        }
      }
      for (const target of targets) {
        if (target.platform !== 'linux') continue;
        const worker = workers.find((item) => item.id === target.workerId);
        if (!worker || !worker.capabilities.workspaces?.some((root) => root.replace(/\/+$/, '') === target.workspace)) continue;
        choices.push({ label: `VPS · ${target.repoId} · ${target.workspace}`,
          target: { workerId: target.workerId, workspace: target.workspace, repoId: target.repoId } });
      }
      setOptions(choices);
      const saved = data.workerTarget && JSON.stringify(data.workerTarget);
      setSelection(saved && choices.some(({ target }) => JSON.stringify(target) === saved)
        ? saved : choices[0] ? JSON.stringify(choices[0].target) : '');
      setLoading(false);
    }).catch((cause: unknown) => {
      if (active) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false); }
    });
    return () => { active = false; };
  }, [data.workerTarget]);
  const save = async () => {
    const chosen = options.find(({ target }) => JSON.stringify(target) === selection)?.target;
    if (!chosen || saving) return;
    setSaving(true); setError('');
    try {
      const next = await api.setWorkflowWorkerTarget(data.revision, chosen);
      workerState.applyModules(next);
      onSaved(`默认 Worker 已设为 ${chosen.repoId ? `VPS · ${chosen.repoId}` : `PC · ${chosen.workspace}`}。新任务建账时生效。`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      void workerState.refreshModules().catch(() => {});
    } finally { setSaving(false); }
  };
  return <div className="workflow-worker-picker" aria-label="默认 Worker 工作区">
    <label>新任务默认 Worker / 工作区
      <select value={selection} disabled={loading || saving} onChange={(event) => setSelection(event.target.value)}>
        {options.length === 0 && <option value="">{loading ? '读取中…' : '没有已登记的工作区'}</option>}
        {options.map(({ label, target }) => <option key={JSON.stringify(target)} value={JSON.stringify(target)}>{label}</option>)}
      </select>
    </label>
    <button type="button" disabled={!selection || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存默认位置'}</button>
    <button type="button" disabled={saving} onClick={onClose}>取消</button>
    <small>整条新任务共用此工作区；已建账任务继续使用原工作区。</small>
    {error && <p className="workflow-error" role="alert">{error}</p>}
  </div>;
}

function permissionChips(permissions: WorkflowModule['permissions']): Array<[IconName, string]> {
  return [
    permissions.write ? ['edit', '允许范围内写入'] : ['lock', '代码只读'],
    permissions.shell ? ['runtime', '允许受限命令'] : ['close', '无命令执行'],
    permissions.ssh ? ['tool', '授权部署操作'] : ['close', '无远程操作'],
  ];
}

function ModuleEditor({ module, data, onSaved }: {
  module: WorkflowModule; data: WorkflowModulesResponse; onSaved(message: string): void;
}) {
  const [draft, setDraft] = useState<WorkflowModuleBinding>({ ...module.binding });
  const [baseRevision, setBaseRevision] = useState(data.revision);
  const [baseBinding, setBaseBinding] = useState({ ...module.binding });
  const [saving, setSaving] = useState(false);
  const [takingOver, setTakingOver] = useState<string | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const dirty = !sameModuleBinding(draft, baseBinding);
  useEffect(() => {
    if (dirty || saving) return;
    setDraft({ ...module.binding });
    setBaseBinding({ ...module.binding });
    setBaseRevision(data.revision);
  }, [module.binding, data.revision, dirty, saving]);
  const agent = data.agents.find((item) => item.contactId === draft.contactId);
  const model = agent?.models.find((item) => item.id === draft.model);
  const compatible = data.agents.filter((item) => item.compatibleModules.includes(module.id));
  const valid = validModuleBinding(module.id, draft, data.agents);
  const currentAgent = data.agents.find((item) => item.contactId === module.binding.contactId);
  const jobs = data.jobs.filter((job) => job.moduleId === module.id);
  const busy = saving || takingOver !== null;
  const reload = () => {
    setDraft({ ...module.binding }); setBaseBinding({ ...module.binding });
    setBaseRevision(data.revision); setError('');
  };
  const save = async () => {
    if (!dirty || !valid || busy) return;
    setSaving(true); setError('');
    try {
      const next = await api.bindWorkflowModule(module.id, baseRevision, draft);
      workerState.applyModules(next);
      if (!alive.current) return;
      const saved = next.modules.find((item) => item.id === module.id);
      if (saved) { setDraft({ ...saved.binding }); setBaseBinding({ ...saved.binding }); }
      setBaseRevision(next.revision);
      onSaved(`${module.label}已更新，后续任务使用新绑定。`);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
      void workerState.refreshModules().catch(() => {});
    } finally { if (alive.current) setSaving(false); }
  };
  const takeover = async (job: WorkflowModuleJob) => {
    if (busy || dirty) return;
    setTakingOver(job.id); setError('');
    try {
      const result = await api.takeoverWorkflowJob(job.id, data.revision);
      workerState.applyJob(result.job);
      if (alive.current) onSaved(result.existing ? '接管任务已存在，已更新状态。' : '已创建接管任务，等待 Worker 执行。');
      await workerState.refreshModules();
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setTakingOver(null); }
  };

  return <section className="workflow-module-editor" aria-label={`${module.label}配置`}>
    <div className="workflow-editor-title">
      <strong>{module.label}</strong>
      <span className={`workflow-status ${module.status}`}>{STATUS[module.status]}</span>
      <div className="workflow-permissions" aria-label="模块固定权限">
        {permissionChips(module.permissions).map(([icon, text]) => <span key={text}>
          <Icon name={icon} /><span>{text}</span>
        </span>)}
      </div>
    </div>
    <p className="workflow-description">{module.description}</p>
    {module.statusDetail && <p className="workflow-module-notice">{module.statusDetail}</p>}
    <div className="workflow-binding-fields">
      <label>Agent
        <select value={draft.contactId} disabled={busy} onChange={(e) => {
          const next = compatible.find((item) => item.contactId === e.target.value);
          if (next) { setDraft(bindingForAgent(next, draft)); setError(''); }
        }}>
          {!compatible.some((item) => item.contactId === draft.contactId)
            && <option value={draft.contactId}>{draft.contactId || '未绑定'}（不兼容）</option>}
          {compatible.map((item) => <option key={item.contactId} value={item.contactId}>
            {item.name}{item.unavailableReason ? ' · 暂不可用' : ''}
          </option>)}
        </select>
      </label>
      <label>模型
        <select value={draft.model} disabled={busy || !agent} onChange={(e) => {
          const next = agent?.models.find((item) => item.id === e.target.value);
          if (next) setDraft({ ...draft, model: next.id, reasoning: chooseEffort(next.efforts, draft.reasoning) });
        }}>
          {!model && <option value={draft.model}>{draft.model || '无可用模型'}（目录未提供）</option>}
          {agent?.models.map((item) => <option key={item.id} value={item.id}>{item.label || item.id}</option>)}
        </select>
      </label>
      <label>推理强度
        <select value={draft.reasoning} disabled={busy || !model} onChange={(e) => setDraft({ ...draft, reasoning: e.target.value })}>
          {!model?.efforts.includes(draft.reasoning) && <option value={draft.reasoning}>{draft.reasoning || '未提供'}（不支持）</option>}
          {model?.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      </label>
    </div>
    {agent?.unavailableReason && <p className="workflow-module-notice">{agent.unavailableReason}</p>}
    {!valid && <p className="workflow-error">该绑定未通过能力校验，请选择兼容的 agent、模型和强度。</p>}
    {dirty && baseRevision !== data.revision && <p className="workflow-module-notice">
      工作流配置已被更新。请载入最新配置后重新选择，避免覆盖其他修改。
    </p>}
    <div className="workflow-editor-actions">
      <button type="button" className="workflow-save" disabled={busy || !dirty || !valid || baseRevision !== data.revision} onClick={() => void save()}>
        {saving ? '保存中…' : '保存绑定'}
      </button>
      {(dirty || baseRevision !== data.revision) && <button type="button" disabled={busy} onClick={reload}>
        {baseRevision !== data.revision ? '载入最新配置' : '撤销选择'}
      </button>}
      <small>运行中的任务保留原绑定；保存不会唤醒模型。</small>
    </div>
    {error && <p className="workflow-error" role="alert">{error}</p>}
    <div className="workflow-module-jobs" aria-label="模块任务">
      <strong>实际执行</strong><span className="workflow-jobs-count">{jobs.length}</span>
      {jobs.length === 0 && <p className="workflow-jobs-empty">
        <Icon name="thinking" />
        <span>该模块当前没有在途任务。任务受阻时会出现在这里，并可一键交给绑定的 agent 接管。</span>
      </p>}
      {jobs.map((job) => <article key={job.id} className="workflow-module-job">
        <div><span>{JOB_STATUS[job.status] ?? job.status}</span><code>{job.id.slice(0, 12)}</code></div>
        <p>{job.model} · {job.reasoning}<small>绑定 v{job.bindingRevision}</small></p>
        {job.error && <p className="workflow-job-error">{job.error}</p>}
        {job.canTakeover && <button type="button" disabled={busy || dirty} onClick={() => void takeover(job)}>
          {takingOver === job.id ? '创建接管任务…' : `交给 ${currentAgent?.name ?? module.binding.contactId} 接管`}
        </button>}
      </article>)}
      {dirty && jobs.some((job) => job.canTakeover) && <small>先保存新绑定，再接管受阻任务。</small>}
    </div>
  </section>;
}

function ReserveAgent({ agent, bound }: { agent: WorkflowAgent; bound: boolean }) {
  return <div className={`workflow-reserve-agent ${bound ? 'bound' : 'dormant'}`}>
    <i className="workflow-reserve-avatar" aria-hidden="true">{initial(agent.name)}</i>
    <div>
      <b>{agent.name}</b>
      <small>{agent.models.length} 模型{agent.quotaPool ? ` · ${agent.quotaPool}` : ''}</small>
    </div>
    {agent.unavailableReason
      ? <span className="workflow-reserve-warn" title={agent.unavailableReason}>
        <Icon name="warning" />不可用
      </span>
      : <span className="workflow-reserve-tag">{bound ? '已绑定' : '预备'}</span>}
  </div>;
}

function ReservePool({ agents, modules }: { agents: WorkflowAgent[]; modules: WorkflowModule[] }) {
  const bound = new Set(modules.map((module) => module.binding.contactId));
  const boundAgents = agents.filter((agent) => bound.has(agent.contactId));
  const dormant = agents.filter((agent) => !bound.has(agent.contactId));
  // The same backend reason repeated under every dormant agent was most of the
  // panel's text; it collapses into one line and a per-agent tooltip.
  const reasons = [...new Set(agents.map((agent) => agent.unavailableReason).filter(Boolean))] as string[];
  const blockedCount = agents.filter((agent) => agent.unavailableReason).length;
  return <aside className="workflow-reserve" aria-label="Agent 预备池">
    <div className="workflow-reserve-title">
      <strong>Agent 预备池</strong>
      <span>{boundAgents.length} 绑定 · {dormant.length} 休眠</span>
    </div>
    <p>未绑定的 agent 保持休眠，@all 也不会唤醒。</p>
    <div className="workflow-reserve-group">
      {boundAgents.map((agent) => <ReserveAgent key={agent.contactId} agent={agent} bound />)}
    </div>
    {dormant.length > 0 && <>
      <div className="workflow-reserve-divider">休眠</div>
      <div className="workflow-reserve-group">
        {dormant.map((agent) => <ReserveAgent key={agent.contactId} agent={agent} bound={false} />)}
      </div>
    </>}
    {reasons.length > 0 && <p className="workflow-reserve-note">
      {blockedCount} 个 agent 不可用：{reasons.join('；')}
    </p>}
  </aside>;
}

export default function WorkflowModules({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const data = useWorkerState((state) => state.modules);
  const loadError = useWorkerState((state) => state.errors.modules ?? '');
  const jobs = useWorkerState((state) => state.jobs);
  const [open, setOpen] = useState(initiallyOpen);
  const [selectedId, setSelectedId] = useState<WorkflowModuleId>('plan');
  const [notice, setNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [workerPickerOpen, setWorkerPickerOpen] = useState(false);
  const panelId = useId();
  useEffect(() => { void workerState.refreshModules().catch(() => {}); }, []);
  // Share existing SSE job updates and REST cache; no second event stream or
  // provider polling. Coalesce a burst of receipts before refreshing statuses.
  useEffect(() => {
    const timer = window.setTimeout(() => { void workerState.refreshModules().catch(() => {}); }, 250);
    return () => window.clearTimeout(timer);
  }, [jobs]);
  const refresh = async () => {
    setRefreshing(true);
    try { await workerState.refreshModules(); } catch { /* store renders the error */ }
    finally { setRefreshing(false); }
  };
  const selected = data?.modules.find((module) => module.id === selectedId);
  const blocked = data?.modules.filter((module) => module.status === 'blocked' || module.status === 'unavailable') ?? [];
  const ready = data?.modules.filter((module) => module.status === 'idle').length ?? 0;
  const lane = (ids: WorkflowModuleId[]) => ids.map((id) => {
    const module = data?.modules.find((item) => item.id === id);
    if (!module) return null;
    const agent = data?.agents.find((item) => item.contactId === module.binding.contactId);
    const modelLabel = agent?.models.find((item) => item.id === module.binding.model)?.label ?? module.binding.model;
    const who = agent?.name ?? module.binding.contactId;
    // Collapsed hides the model, the effort and the status wording, so the
    // whole node carries them as a tooltip instead of the model line alone.
    return <button key={id} type="button" className={`workflow-node ${module.status}${open && selectedId === id ? ' selected' : ''}`}
      title={`${module.label} · ${who} · ${module.binding.model} · ${module.binding.reasoning} · ${STATUS[module.status]}`}
      aria-pressed={open && selectedId === id} onClick={() => { setSelectedId(id); setOpen(true); setNotice(''); }}>
      <span className="workflow-node-head">
        <i className={`workflow-node-dot ${module.status}`} aria-hidden="true" />
        <b>{module.label}</b>
        <span className="workflow-node-status">{STATUS[module.status]}</span>
      </span>
      <small className="workflow-node-agent">
        <i className="workflow-node-avatar" aria-hidden="true">{initial(who)}</i>{who}
      </small>
      <small className="workflow-node-model">
        <span title={modelLabel}>{modelLabel}</span><span>{module.binding.reasoning}</span>
      </small>
    </button>;
  });
  return <section className={`workflow-board${open ? ' expanded' : ''}`} aria-label="固定工作流">
    <div className="workflow-board-header">
      <button type="button" className="workflow-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
        <Icon name="worker" />
        <span className="workflow-toggle-text">
          <b>工作流模块</b>
          <small>固定五步交付流程 · 所有工作会议室共用</small>
        </span>
      </button>
      <div className="workflow-header-actions">
        {data && <span className={`workflow-ready-pill${blocked.length > 0 ? ' has-blocked' : ''}`}>
          <i aria-hidden="true" />
          {blocked.length > 0 ? `${blocked.length} 个模块受阻` : `${ready} 个模块就绪`}
        </span>}
        {data && <button type="button" className="workflow-worker-button" aria-expanded={workerPickerOpen}
          onClick={() => { setWorkerPickerOpen((value) => !value); setOpen(true); }}>
          <Icon name="worker" />
          {data.workerTarget
            ? data.workerTarget.repoId ? `Worker · VPS ${data.workerTarget.repoId}` : 'Worker · PC'
            : 'Worker · 选择工作区'}
        </button>}
        <button type="button" className="workflow-refresh" disabled={refreshing} onClick={() => void refresh()} aria-label="刷新工作流">
          <Icon name="regenerate" />{refreshing ? '刷新中' : '刷新'}
        </button>
        {open && <button type="button" className="workflow-collapse" onClick={() => setOpen(false)}>
          收起<Icon name="chevron-up" />
        </button>}
      </div>
    </div>
    {loadError && <p className="workflow-error" role="alert">工作流状态读取失败：{loadError}。{data ? '当前显示上次结果。' : '请重试。'}</p>}
    {!data && !loadError && <p className="workflow-loading">正在读取模块与模型…</p>}
    {data && <>
      {workerPickerOpen && <WorkerTargetPicker data={data} onSaved={setNotice} onClose={() => setWorkerPickerOpen(false)} />}
      <div className="workflow-main-lane" aria-label="交付流程">{lane(WORKFLOW_MAIN)}</div>
      <div className="workflow-support-lane" aria-label="支援模块">
        <span className="workflow-lane-tag">旁路</span>
        {lane(WORKFLOW_SUPPORT)}
        <p>评审未通过 → 执行修复<br />累计两轮未收敛 → 技术仲裁</p>
      </div>
      {!open && blocked.length > 0 && <button type="button" className="workflow-blocked-banner" onClick={() => {
        setSelectedId(blocked[0].id); setOpen(true);
      }}>{blocked.map((module) => module.label).join('、')}暂时受阻，点此更换绑定或查看任务。</button>}
      {notice && <p className="workflow-saved" role="status">{notice}</p>}
      {open && <div className="workflow-board-body" id={panelId}>
        {selected && <ModuleEditor key={selected.id} module={selected} data={data} onSaved={setNotice} />}
        <ReservePool agents={data.agents} modules={data.modules} />
      </div>}
    </>}
  </section>;
}
