import { useEffect, useMemo, useState } from 'react';
import { api, type JobMessage, type Worker, type WorkerJob } from '../api';
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
  const [drawer, setDrawer] = useState<'none' | 'compose' | 'pair'>('none');
  const [pairToken, setPairToken] = useState('');
  const [pairName, setPairName] = useState('my-pc');
  const [form, setForm] = useState({
    runner: 'codex' as 'codex' | 'claude' | 'grok',
    workspace: '',
    prompt: '',
    workerId: '',
    write: false,
    shell: false,
    ssh: false,
  });

  const refresh = async () => {
    const [w, j] = await Promise.all([api.workers(), api.jobs()]);
    setWorkers(w.workers);
    setJobs(j.jobs);
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
        runner: form.runner,
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

  const permWarn = form.runner === 'codex' && !form.shell;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'worker-panel' + (selected ? ' has-selection' : '')}>
        <header className="worker-topbar">
          <b>PC Worker</b>
          <small>VPS 持久队列 · PC 主动认领</small>
          <span className="spacer" />
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

        {drawer === 'compose' && (
          <section className="worker-drawer compose">
            <div className="compose-row">
              <div className="seg">
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
