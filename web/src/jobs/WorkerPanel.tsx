import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  api,
  type Worker,
  type WorkflowStage,
} from '../platform/api';
import {
  DeliverySummaryCard,
  hideJobWindow,
  humanJobLabel,
  JOB_ACTIVE as active,
  resolveJobOutOfBand,
} from './JobThread';
import { formatLocalTime } from '../platform/time';
import { useConfirm } from '../platform/ConfirmDialog';
import { Icon } from '../platform/icons';
import { useJobMessages, useWorkerState, workerState } from './useWorkerState';

interface Props {
  onClose(): void;
  /** Workflow module board shown in the 模块 drawer; App passes it in so jobs never imports workflow. */
  modulesPanel?: ReactNode;
}

const RUNNERS: ['codex' | 'claude' | 'grok' | 'opencode', string][] = [
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
  ['grok', 'Grok Build'],
  ['opencode', 'OpenCode / Sora'],
];

export default function WorkerPanel({ onClose, modulesPanel }: Props) {
  const confirm = useConfirm();
  const workers = useWorkerState((state) => state.workers);
  const jobs = useWorkerState((state) => state.jobs);
  const modules = useWorkerState((state) => state.modules);
  const jobsLoading = useWorkerState((state) => !!state.loading.jobs);
  const workersLoading = useWorkerState((state) => !!state.loading.workers);
  const jobsLoaded = useWorkerState((state) => !!state.loaded.jobs);
  const workersLoaded = useWorkerState((state) => !!state.loaded.workers);
  const jobsError = useWorkerState((state) => state.errors.jobs || '');
  const workersError = useWorkerState((state) => state.errors.workers || '');
  const syncError = useWorkerState((state) => state.errors.workers || state.errors.jobs || state.errors.profiles || '');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { messages, error: detailError, loading: detailLoading } = useJobMessages(selectedId);
  const [error, setError] = useState('');
  const [drawer, setDrawer] = useState<'none' | 'compose' | 'pair' | 'profile'>('none');
  const [pairToken, setPairToken] = useState('');
  const [pairName, setPairName] = useState('my-pc');
  const [form, setForm] = useState({
    runner: '' as '' | 'codex' | 'claude' | 'grok' | 'opencode',
    stage: 'execute' as WorkflowStage,
    workspace: '',
    prompt: '',
    workerId: '',
    write: false,
    shell: false,
    ssh: false,
  });

  const refresh = workerState.reconcile;

  useEffect(() => {
    const first = workers.flatMap((worker) => worker.capabilities.workspaces ?? [])[0];
    if (first) setForm((form) => form.workspace ? form : { ...form, workspace: first });
  }, [workers]);

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
  // The module snapshot is the binding the job was dispatched with. Only jobs
  // that predate it fall back to the retired profile snapshot.
  const jobBinding = (() => {
    const options = selected?.options;
    const snapshot = options?.workflowModule;
    if (snapshot) {
      return {
        label: modules?.modules.find((item) => item.id === snapshot.moduleId)?.label ?? snapshot.moduleId,
        stage: options.workflowStage ?? snapshot.moduleId,
        selected: snapshot.selected,
        escalateToHuman: snapshot.escalateToHuman,
        revision: `绑定 r${snapshot.bindingRevision}`,
      };
    }
    const legacy = options?.workflow;
    if (!legacy) return null;
    return {
      label: legacy.profileLabel,
      stage: legacy.stage,
      selected: legacy.selected,
      escalateToHuman: legacy.escalateToHuman || legacy.fallbackActive,
      revision: `v3 ${legacy.workflowFingerprint.slice(0, 12)}`,
    };
  })();
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
      setSelectedId(job.id);
      setForm((f) => ({ ...f, prompt: '' }));
      setDrawer('none');
      await refresh();
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
      await api.setWorkerEnabled(worker.id, enabled);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const visibleError = error || detailError || syncError;
  // 列表三态：loading / empty / error 分开。未完成或失败时禁止静默变成「还没有任务」；
  // 有 last-good 时保留列表并标陈旧，只有成功快照确认空队列才算真正 empty。
  const listError = jobsError || workersError;
  const hasJobs = jobs.length > 0;
  const listLoading = !hasJobs && !listError && !jobsLoaded;
  const showListError = !hasJobs && !listLoading && !!listError;
  const showEmpty = !hasJobs && !listLoading && !showListError && jobsLoaded;
  const showStale = hasJobs && !!listError;
  const workersInitialLoading = workers.length === 0 && !workersLoaded && !workersError;
  const retry = () => { void refresh().catch(() => {}); };
  // Mirrors the server's moduleForStage: "跟随策略" resolves to the live module binding.
  const stageModule = form.stage === 'fix' ? 'execute' : form.stage === 'patrol' ? 'maintenance' : form.stage;
  const boundRunner = modules?.modules.find((item) => item.id === stageModule)?.binding.runner;
  const effectiveRunner = form.runner || boundRunner;
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
            title="配置固定模块的模型绑定；在途任务保留执行快照"
          >
            工作流模块
          </button>
          <div className="worker-chips">
            {workersInitialLoading && <span className="worker-chips-loading">正在加载 Worker 状态…</span>}
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
                    <Icon name="close" />
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
            <Icon name="plus" />
            <span>派单</span>
          </button>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭 Worker 面板">
            <Icon name="close" />
          </button>
        </header>

        {visibleError && <div className="modal-error worker-error"><Icon name="warning" /> {visibleError}</div>}

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
                  <Icon name="copy" />
                  <span>复制</span>
                </button>
              </span>
            )}
            <small>仅显示一次</small>
          </section>
        )}

        {drawer === 'profile' && modulesPanel}

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
              {permWarn && <small className="compose-warn"><Icon name="warning" /> Codex 读写 workspace 必须开 Shell</small>}
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
          <aside className="job-list" aria-busy={jobsLoading || workersLoading}>
            {showStale && (
              <div className="worker-stale" role="status">
                <span>列表可能是旧数据（{listError}）。已保留上次成功结果。</span>
                <button type="button" onClick={retry}>
                  {jobsLoading || workersLoading ? '重试中…' : '重试'}
                </button>
              </div>
            )}
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
            {listLoading && <p className="worker-loading" role="status">正在加载任务…</p>}
            {showListError && (
              <div className="worker-list-error" role="alert">
                <p>任务列表加载失败：{listError}</p>
                <button type="button" onClick={retry}>
                  {jobsLoading || workersLoading ? '重试中…' : '重试'}
                </button>
              </div>
            )}
            {showEmpty && <p className="empty-note">还没有任务。点右上角“派单”。</p>}
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
                    <Icon name="arrow-left" />
                    <span>列表</span>
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
                  {jobBinding && (
                    <section className="workflow-job-card">
                      <div>
                        <b>{jobBinding.label}</b>
                        <span>
                          {jobBinding.stage} · 实际 {selected.runner}
                          {' · '}任务绑定 {jobBinding.selected.runner}/
                          {jobBinding.selected.model}/{jobBinding.selected.reasoning}
                        </span>
                        {selected.options?.runnerSource === 'override' && (
                          <em>此任务使用手动覆盖；权限仍受模块与任务授权约束</em>
                        )}
                        {jobBinding.escalateToHuman && (
                          <em>已转人工</em>
                        )}
                      </div>
                      <code>{jobBinding.revision}</code>
                      {['done', 'blocked', 'failed', 'interrupted'].includes(selected.status) && (
                        <div className="workflow-quality-actions">
                          <span className="room-task-meta">质量计数仅作观察，不再触发自动流转；继续推进走会议室任务账本。</span>
                        </div>
                      )}
                    </section>
                  )}
                  <article className="job-msg prompt">
                    <small>任务</small>
                    <pre>{selected.prompt}</pre>
                  </article>
                  {detailLoading && messages.length === 0 && !detailError && (
                    <p className="worker-loading" role="status">正在加载执行过程…</p>
                  )}
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
