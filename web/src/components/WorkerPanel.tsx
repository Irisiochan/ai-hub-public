import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type JobMessage,
  type Worker,
  type WorkerJob,
  type WorkflowProfile,
  type WorkflowStage,
} from '../api';
import {
  DeliverySummaryCard,
  hideJobWindow,
  humanJobLabel,
  JOB_ACTIVE as active,
  resolveJobOutOfBand,
} from './JobThread';
import { formatLocalTime } from '../time';
import { useConfirm } from './ConfirmDialog';

interface Props {
  onClose(): void;
}

const RUNNERS: ['codex' | 'claude' | 'grok', string][] = [
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
  ['grok', 'Grok Build'],
];

export default function WorkerPanel({ onClose }: Props) {
  const confirm = useConfirm();
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [jobs, setJobs] = useState<WorkerJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<JobMessage[]>([]);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState<'none' | 'compose' | 'pair' | 'profile'>('none');
  const [profiles, setProfiles] = useState<WorkflowProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<WorkflowProfile | null>(null);
  const [previousProfile, setPreviousProfile] = useState<WorkflowProfile | null>(null);
  const [pairToken, setPairToken] = useState('');
  const [pairName, setPairName] = useState('my-pc');
  const [form, setForm] = useState({
    runner: '' as '' | 'codex' | 'claude' | 'grok',
    stage: 'execute' as WorkflowStage,
    workspace: '',
    prompt: '',
    workerId: '',
    write: false,
    shell: false,
    ssh: false,
  });

  const refresh = async () => {
    const [w, j, p] = await Promise.all([api.workers(), api.jobs(), api.workflowProfiles()]);
    setWorkers(w.workers);
    setJobs(j.jobs);
    setProfiles(p.profiles);
    setActiveProfile(p.active);
    setPreviousProfile(p.previous);
    if (!form.workspace) {
      const first = w.workers.flatMap((x) => x.capabilities.workspaces ?? [])[0];
      if (first) setForm((f) => ({ ...f, workspace: f.workspace || first }));
    }
  };

  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => void refresh().catch(() => {}), 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    const load = () =>
      void api
        .job(selectedId)
        .then(({ job, messages }) => {
          setJobs((list) => list.map((j) => (j.id === job.id ? job : j)));
          setMessages(messages);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, [selectedId]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (drawer !== 'none') {
        setDrawer('none');
        return;
      }
      if (selectedId) {
        setSelectedId(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [drawer, onClose, selectedId]);

  const selected = jobs.find((j) => j.id === selectedId) ?? null;
  const workspaceOptions = useMemo(
    () => [...new Set(workers.flatMap((w) => w.capabilities.workspaces ?? []))],
    [workers]
  );

  const submit = async () => {
    setError('');
    try {
      const job = await api.createJob({
        runner: form.runner || undefined,
        stage: form.stage,
        workspace: form.workspace,
        prompt: form.prompt,
        workerId: form.workerId || undefined,
        permissions: { write: form.write, shell: form.shell, ssh: form.ssh },
      });
      setJobs((list) => [job, ...list]);
      setSelectedId(job.id);
      setForm((f) => ({ ...f, prompt: '' }));
      setDrawer('none');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const pair = async () => {
    setError('');
    try {
      const result = await api.pairWorker(pairName);
      setPairToken(result.token);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const action = async (value: 'cancel' | 'pause' | 'resume') => {
    if (!selected) return;
    try {
      await api.jobAction(selected.id, value);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const hideSelected = async () => {
    if (!selected) return;
    setError('');
    try {
      const done = await hideJobWindow(selected, confirm);
      if (!done) return;
      setSelectedId(null);
      setMessages([]);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const resolveSelectedOutOfBand = async () => {
    if (!selected) return;
    setError('');
    try {
      const done = await resolveJobOutOfBand(selected, confirm);
      if (done) await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setWorkerEnabled = async (worker: Worker, enabled: boolean) => {
    setError('');
    try {
      const updated = await api.setWorkerEnabled(worker.id, enabled);
      setWorkers((list) => list.map((item) => (item.id === updated.id ? updated : item)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const switchProfile = async (profile: WorkflowProfile) => {
    setError('');
    try {
      const preview = await api.previewWorkflowProfile(profile.id, profile.version);
      const changedStages = preview.changes.length;
      const ok = await confirm({
        title: `切换到 ${profile.label}`,
        message: `将改变 ${changedStages} 个角色路由。只影响切换后新建的任务；在途任务继续使用原快照。`,
        confirmLabel: '切换协议',
      });
      if (!ok) return;
      await api.switchWorkflowProfile(profile.id, profile.version);
      await refresh();
      setDrawer('none');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rollbackProfile = async () => {
    if (!previousProfile) return;
    const ok = await confirm({
      title: '回滚工作流协议',
      message: `回滚到 ${previousProfile.label}。只影响之后新建的任务。`,
      confirmLabel: '回滚',
    });
    if (!ok) return;
    await api.rollbackWorkflowProfile();
    await refresh();
    setDrawer('none');
  };

  const recordQuality = async (quality: 'success' | 'inadequate' | 'infrastructure') => {
    if (!selected) return;
    setError('');
    try {
      await api.recordJobQuality(selected.id, quality);
      const detail = await api.job(selected.id);
      setJobs((list) => list.map((job) => job.id === selected.id ? detail.job : job));
      setMessages(detail.messages);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const profileRunner = activeProfile?.routes[form.stage]?.primary.runner;
  const effectiveRunner = form.runner || profileRunner;
  const permWarn = effectiveRunner === 'codex' && !form.shell;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'worker-panel' + (selected ? ' has-selection' : '')}>
        <header className="worker-topbar">
          <b>PC Worker</b>
          <small>VPS 持久队列 · PC 主动认领</small>
          <span className="spacer" />
          <button
            type="button"
            className={'chip-pill' + (drawer === 'profile' ? ' selected' : '')}
            onClick={() => setDrawer(drawer === 'profile' ? 'none' : 'profile')}
            title="切换只影响新任务；在途任务固定原协议快照"
          >
            {activeProfile?.label ?? '工作流协议'}
          </button>
          <div className="worker-chips">
            {workers.map((w) => (
              <span key={w.id} className={`worker-chip ${w.status}`}>
                <span className="job-dot" />
                {w.name}
                <small>{w.status === 'paused' ? '已暂停' : w.status}</small>
                {w.status !== 'offline' && (
                  <button
                    type="button"
                    className={`worker-power ${w.acceptingJobs ? 'on' : 'off'}`}
                    title={w.acceptingJobs ? '停止认领新任务；手动恢复前一直保持暂停' : '恢复任务轮询与认领'}
                    aria-pressed={w.acceptingJobs}
                    onClick={() => void setWorkerEnabled(w, !w.acceptingJobs)}
                  >
                    {w.acceptingJobs ? '暂停接单' : '恢复接单'}
                  </button>
                )}
                {w.status === 'offline' && (
                  <button
                    type="button"
                    className="worker-chip-del"
                    title="删除这个离线 worker（有历史任务的会被服务端拒绝）"
                    onClick={() => void (async () => {
                      const ok = await confirm({
                        title: '删除离线 Worker',
                        message: `删除离线 worker「${w.name}」（${w.id}）？令牌会一并失效。`,
                        confirmLabel: '删除 Worker',
                        danger: true,
                      });
                      if (!ok) return;
                      await api.deleteWorker(w.id).then(refresh).catch((e) => setError((e as Error).message));
                    })()}
                  >
                    ✕
                  </button>
                )}
              </span>
            ))}
          </div>
          <button
            type="button"
            className={'chip-pill' + (drawer === 'pair' ? ' selected' : '')}
            onClick={() => setDrawer(drawer === 'pair' ? 'none' : 'pair')}
          >
            配对新 PC
          </button>
          <button
            type="button"
            className={drawer === 'compose' ? 'chip-pill selected' : 'primary-btn'}
            onClick={() => setDrawer(drawer === 'compose' ? 'none' : 'compose')}
          >
            ＋ 派单
          </button>
          <button type="button" className="modal-close" onClick={onClose}>
            ✕
          </button>
        </header>

        {error && <div className="modal-error worker-error">⚠ {error}</div>}

        {drawer === 'pair' && (
          <section className="worker-drawer">
            <input
              value={pairName}
              aria-label="Worker 名称"
              onChange={(e) => setPairName(e.target.value)}
              style={{ width: 180 }}
            />
            <button type="button" onClick={() => void pair()}>
              生成配对令牌
            </button>
            {pairToken && (
              <span className="pair-token">
                <code>{pairToken}</code>
                <button type="button" onClick={() => void navigator.clipboard.writeText(pairToken)}>
                  ⧉ 复制
                </button>
              </span>
            )}
            <small>仅显示一次</small>
          </section>
        )}

        {drawer === 'profile' && (
          <section className="worker-drawer workflow-profile-drawer">
            <div className="workflow-profile-list">
              {profiles.map((profile) => (
                <button
                  key={`${profile.id}@${profile.version}`}
                  type="button"
                  className={'workflow-profile-option' + (activeProfile?.id === profile.id && activeProfile.version === profile.version ? ' active' : '')}
                  onClick={() => void switchProfile(profile)}
                  disabled={activeProfile?.id === profile.id && activeProfile.version === profile.version}
                >
                  <b>{profile.label}</b>
                  <span>{profile.description}</span>
                  <small>
                    Plan {profile.routes.plan.primary.model}/{profile.routes.plan.primary.reasoning}
                    {' · '}Execute {profile.routes.execute.primary.model}/{profile.routes.execute.primary.reasoning}
                  </small>
                </button>
              ))}
            </div>
            <small>切换只影响新任务；在途任务固定原 Profile 版本。</small>
            {previousProfile && (
              <button type="button" onClick={() => void rollbackProfile()}>
                ↶ 回滚到 {previousProfile.label}
              </button>
            )}
          </section>
        )}

        {drawer === 'compose' && (
          <section className="worker-drawer compose">
            <div className="compose-row">
              <select value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value as WorkflowStage })}>
                <option value="execute">执行</option>
                <option value="fix">修复</option>
                <option value="review">Review</option>
                <option value="maintenance">维护</option>
                <option value="patrol">巡逻</option>
                <option value="plan">Plan</option>
              </select>
              <div className="seg">
                <button
                  type="button"
                  className={'seg-btn' + (!form.runner ? ' selected' : '')}
                  onClick={() => setForm({ ...form, runner: '' })}
                >
                  按协议
                </button>
                {RUNNERS.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={'seg-btn' + (form.runner === id ? ' selected' : '')}
                    onClick={() => setForm({ ...form, runner: id })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input
                className="cfg-mono"
                list="worker-workspaces"
                placeholder="本机 workspace 绝对路径"
                value={form.workspace}
                onChange={(e) => setForm({ ...form, workspace: e.target.value })}
              />
              <datalist id="worker-workspaces">
                {workspaceOptions.map((w) => (
                  <option key={w} value={w} />
                ))}
              </datalist>
              <select value={form.workerId} onChange={(e) => setForm({ ...form, workerId: e.target.value })}>
                <option value="">任意匹配 Worker</option>
                {workers.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              rows={3}
              className="cfg-textarea"
              placeholder="要本机 AI 执行什么？"
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            />
            <div className="compose-row">
              {([['write', '写文件'], ['shell', 'Shell'], ['ssh', 'SSH']] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={form[key]}
                  className={'chip-pill' + (form[key] ? ' selected' : '')}
                  onClick={() => setForm({ ...form, [key]: !form[key] })}
                >
                  {label}
                </button>
              ))}
              {permWarn && <small className="compose-warn">⚠ Codex 读写 workspace 必须开 Shell</small>}
              <span className="spacer" />
              <button
                type="button"
                className="primary-btn"
                disabled={!form.workspace.trim() || !form.prompt.trim()}
                onClick={() => void submit()}
              >
                派单
              </button>
            </div>
          </section>
        )}

        <div className="worker-main">
          <aside className="job-list">
            {jobs.map((job) => (
              <button
                key={job.id}
                type="button"
                className={'job-item' + (job.id === selectedId ? ' selected' : '')}
                onClick={() => setSelectedId(job.id)}
              >
                <span className="job-item-head">
                  <span className={`job-dot ${job.status}`} />
                  <b>{humanJobLabel(job)}</b>
                  <small>{job.runner}</small>
                </span>
                <span className="job-item-prompt">{job.prompt}</span>
                <code>{job.workspace}</code>
                <em className="job-list-open">查看执行过程</em>
              </button>
            ))}
            {jobs.length === 0 && <p className="empty-note">还没有任务。点右上角「＋ 派单」。</p>}
          </aside>

          <main className="job-detail" aria-label="PC Worker 任务执行过程">
            {!selected ? (
              <div className="empty-note">点击左侧任务，在此查看执行过程</div>
            ) : (
              <>
                <header className="job-detail-head">
                  <button
                    type="button"
                    className="job-detail-back"
                    onClick={() => setSelectedId(null)}
                    aria-label="返回任务列表"
                  >
                    ← 列表
                  </button>
                  <span className={`job-dot ${selected.status}`} />
                  <b>{humanJobLabel(selected)}</b>
                  <small>
                    {selected.status} · {selected.runner} · {selected.worker_id || '尚未认领'}
                  </small>
                  <code>{selected.workspace}</code>
                  {selected.permissions.shell && <span className="perm-chip">Shell</span>}
                  {selected.permissions.ssh && <span className="perm-chip danger">SSH</span>}
                  <span className="spacer" />
                  {active.has(selected.status) && selected.status !== 'pending' && (
                    <button type="button" onClick={() => void action('pause')}>
                      暂停
                    </button>
                  )}
                  {active.has(selected.status) && (
                    <button type="button" onClick={() => void action('cancel')}>
                      取消
                    </button>
                  )}
                  {['paused', 'interrupted', 'blocked', 'failed'].includes(selected.status) && (
                    <button type="button" className="accent" onClick={() => void action('resume')}>
                      继续 / 重跑
                    </button>
                  )}
                  {selected.status === 'blocked' && selected.delivery_state?.startsWith('blocked_') && (
                    <button type="button" onClick={() => void resolveSelectedOutOfBand()}>
                      标记已接力完成
                    </button>
                  )}
                  <button type="button" className="del" onClick={() => void hideSelected()}>
                    删除窗口
                  </button>
                </header>

                <div className="job-detail-scroll">
                  <div className="job-thread-meta">
                    <span>
                      workspace <code>{selected.workspace}</code>
                    </span>
                    <span>worker {selected.worker_id || '尚未认领'}</span>
                  </div>
                  <DeliverySummaryCard job={selected} />
                  {selected.options?.workflow && (
                    <section className="workflow-job-card">
                      <div>
                        <b>{selected.options.workflow.profileLabel}</b>
                        <span>
                          {selected.options.workflow.stage} · 实际 {selected.runner}
                          {' · '}Profile 计划 {selected.options.workflow.selected.runner}/
                          {selected.options.workflow.selected.model}/{selected.options.workflow.selected.reasoning}
                        </span>
                        {selected.options.runnerSource === 'override' && (
                          <em>手动 override，不计入 Profile fallback 统计</em>
                        )}
                        {selected.options.workflow.fallbackActive && <em>已触发兜底</em>}
                      </div>
                      <code title={selected.options.workflow.workflowFingerprint}>
                        v3 {selected.options.workflow.workflowFingerprint.slice(0, 12)}
                      </code>
                      {['done', 'blocked', 'failed', 'interrupted'].includes(selected.status) && (
                        <div className="workflow-quality-actions">
                          <button type="button" onClick={() => void recordQuality('success')}>质量收敛</button>
                          <button type="button" onClick={() => void recordQuality('inadequate')}>效果不佳 +1</button>
                          <button type="button" onClick={() => void recordQuality('infrastructure')}>平台故障（不计数）</button>
                        </div>
                      )}
                    </section>
                  )}
                  <article className="job-msg prompt">
                    <small>任务</small>
                    <pre>{selected.prompt}</pre>
                  </article>
                  {messages
                    .filter((message) => message.kind !== 'prompt')
                    .map((message) => (
                      <article key={message.id} className={`job-msg ${message.kind}`}>
                        <small>
                          <span className="job-msg-kind">{message.kind}</span>
                          {message.sender} · {formatLocalTime(message.created_at)}
                        </small>
                        <pre>{message.content}</pre>
                      </article>
                    ))}
                  {selected.result && (
                    <article className="job-msg result">
                      <small>结果</small>
                      <pre>{selected.result}</pre>
                    </article>
                  )}
                  {selected.error && (
                    <article className="job-msg stderr">
                      <small>错误</small>
                      <pre>{selected.error}</pre>
                    </article>
                  )}
                </div>
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
