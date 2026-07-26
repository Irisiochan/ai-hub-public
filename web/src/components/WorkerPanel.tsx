import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type JobMessage, type Worker, type WorkerJob } from '../api';
import { hideJobWindow, JOB_ACTIVE as active, jobStatusLabel as statusLabel } from './JobThread';
import { formatLocalTime } from '../time';

interface Props { onClose(): void }

export default function WorkerPanel({ onClose }: Props) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [jobs, setJobs] = useState<WorkerJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<JobMessage[]>([]);
  const [error, setError] = useState('');
  const [pairToken, setPairToken] = useState('');
  const [pairName, setPairName] = useState('My-PC');
  const [form, setForm] = useState({ runner: 'codex' as 'codex' | 'claude' | 'grok', workspace: '', prompt: '', workerId: '', write: false, shell: false, ssh: false });

  const refresh = async () => {
    const [w, j] = await Promise.all([api.workers(), api.jobs()]);
    setWorkers(w.workers); setJobs(j.jobs);
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
    if (!selectedId) { setMessages([]); return; }
    const load = () => void api.job(selectedId).then(({ job, messages }) => {
      setJobs((list) => list.map((j) => j.id === job.id ? job : j)); setMessages(messages);
    }).catch(() => {});
    load(); const timer = setInterval(load, 2500); return () => clearInterval(timer);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [selectedId]);

  const selected = jobs.find((j) => j.id === selectedId) ?? null;
  const workspaceOptions = useMemo(() => [...new Set(workers.flatMap((w) => w.capabilities.workspaces ?? []))], [workers]);

  const submit = async () => {
    setError('');
    try {
      const job = await api.createJob({
        runner: form.runner, workspace: form.workspace, prompt: form.prompt,
        workerId: form.workerId || undefined,
        permissions: { write: form.write, shell: form.shell, ssh: form.ssh },
      });
      setJobs((list) => [job, ...list]); setSelectedId(job.id); setForm((f) => ({ ...f, prompt: '' }));
    } catch (e) { setError((e as Error).message); }
  };

  const pair = async () => {
    setError('');
    try { const result = await api.pairWorker(pairName); setPairToken(result.token); await refresh(); }
    catch (e) { setError((e as Error).message); }
  };

  const action = async (value: 'cancel' | 'pause' | 'resume') => {
    if (!selected) return;
    try { await api.jobAction(selected.id, value); await refresh(); }
    catch (e) { setError((e as Error).message); }
  };

  const hideSelected = async () => {
    if (!selected) return;
    setError('');
    try {
      const done = await hideJobWindow(selected);
      if (!done) return;
      setSelectedId(null);
      setMessages([]);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setWorkerEnabled = async (worker: Worker, enabled: boolean) => {
    setError('');
    try {
      const updated = await api.setWorkerEnabled(worker.id, enabled);
      setWorkers((list) => list.map((item) => item.id === updated.id ? updated : item));
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <>
      <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="worker-panel">
        <header><div><b>🖥 PC Worker</b><small> VPS 持久队列 · PC 主动认领</small></div><button onClick={onClose}>×</button></header>
        {error && <div className="modal-error worker-error">{error}</div>}
        <section className="worker-strip">
          {workers.map((w) => (
            <span key={w.id} className={`worker-chip ${w.status}`}>
              ● {w.name} · {w.status === 'paused' ? '已暂停' : w.status}
              {w.status !== 'offline' && (
                <button
                  className={`worker-power ${w.acceptingJobs ? 'on' : 'off'}`}
                  title={w.acceptingJobs ? '停止认领新任务；本次开机保持暂停' : '恢复任务轮询与认领'}
                  aria-pressed={w.acceptingJobs}
                  onClick={() => void setWorkerEnabled(w, !w.acceptingJobs)}
                >
                  {w.acceptingJobs ? '暂停接单' : '恢复接单'}
                </button>
              )}
              {w.status === 'offline' && (
                <button
                  className="worker-chip-del"
                  title="删除这个离线 worker（有历史任务的会被服务端拒绝）"
                  onClick={() => {
                    if (!window.confirm(`删除离线 worker「${w.name}」（${w.id}）？令牌会一并失效。`)) return;
                    void api.deleteWorker(w.id).then(refresh).catch((e) => setError((e as Error).message));
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          <input value={pairName} onChange={(e) => setPairName(e.target.value)} aria-label="Worker 名称" />
          <button onClick={() => void pair()}>生成配对令牌</button>
        </section>
        {pairToken && <div className="pair-token"><b>仅显示一次：</b><code>{pairToken}</code><button onClick={() => void navigator.clipboard.writeText(pairToken)}>复制</button></div>}
        <section className="job-compose">
          <select value={form.runner} onChange={(e) => setForm({ ...form, runner: e.target.value as 'codex' | 'claude' | 'grok' })}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="grok">Grok Build</option></select>
          <input list="worker-workspaces" placeholder="本机 workspace 绝对路径" value={form.workspace} onChange={(e) => setForm({ ...form, workspace: e.target.value })} />
          <datalist id="worker-workspaces">{workspaceOptions.map((w) => <option key={w} value={w} />)}</datalist>
          <select value={form.workerId} onChange={(e) => setForm({ ...form, workerId: e.target.value })}><option value="">任意匹配 Worker</option>{workers.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          <label><input type="checkbox" checked={form.write} onChange={(e) => setForm({ ...form, write: e.target.checked })} /> 写文件</label>
          <label title="Codex 的读写工具本身依赖 Shell；Claude Code 可在不开 Bash 时读写"><input type="checkbox" checked={form.shell} onChange={(e) => setForm({ ...form, shell: e.target.checked })} /> Shell</label>
          <label><input type="checkbox" checked={form.ssh} onChange={(e) => setForm({ ...form, ssh: e.target.checked })} /> SSH</label>
          <textarea placeholder={form.runner === 'codex' && !form.shell ? 'Codex 读写 workspace 必须显式勾选 Shell；写入还要勾选“写文件”' : '要本机 AI 执行什么？'} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
          <button className="primary-btn" disabled={!form.workspace.trim() || !form.prompt.trim()} onClick={() => void submit()}>派单</button>
        </section>
          <div className="worker-main">
            <aside className="job-list">{jobs.map((job) => <button key={job.id} className={job.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(job.id)}><b>{statusLabel(job.status)}</b><span>{job.runner} · {job.prompt.slice(0, 48)}</span><small>{job.workspace}</small><em className="job-list-open">查看执行过程</em></button>)}</aside>
          <main className="job-detail">
              <div className="empty-note">点击任务，全屏查看执行过程</div>
          </main>
          </div>
        </div>
      </div>
      {selected && createPortal(
        <div
          className="job-execution-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="PC Worker 任务执行过程"
        >
          <section className="job-execution-modal">
            <header className="job-execution-header">
              <div>
                <span className={`job-dot ${selected.status}`} />
                <b>PC Worker · {statusLabel(selected.status)}</b>
                <small>{selected.runner} · {selected.worker_id || '尚未认领'}</small>
              </div>
              <button
                type="button"
                className="job-execution-close"
                aria-label="关闭任务执行过程"
                onClick={() => setSelectedId(null)}
              >
                ×
              </button>
            </header>
            <div className="job-execution-scroll">
              <div className="job-thread-meta">
                <span>workspace <code>{selected.workspace}</code></span>
                <span>worker {selected.worker_id || '尚未认领'}</span>
                {selected.permissions.shell && <span className="perm-chip">Shell</span>}
                {selected.permissions.ssh && <span className="perm-chip danger">SSH</span>}
              </div>
              <div className="job-msg prompt">
                <small>任务</small>
                <pre>{selected.prompt}</pre>
              </div>
              {messages
                .filter((message) => message.kind !== 'prompt')
                .map((message) => (
                  <article key={message.id} className={`job-msg ${message.kind}`}>
                    <small>{message.sender} · {message.kind} · {formatLocalTime(message.created_at)}</small>
                    <pre>{message.content}</pre>
                  </article>
                ))}
              {selected.result && (
                <div className="job-msg result">
                  <small>结果</small>
                  <pre>{selected.result}</pre>
                </div>
              )}
              {selected.error && (
                <div className="job-msg stderr">
                  <small>错误</small>
                  <pre>{selected.error}</pre>
                </div>
              )}
              {error && <div className="modal-error">⚠ {error}</div>}
              <div className="job-thread-actions">
                {active.has(selected.status) && selected.status !== 'pending' && (
                  <button type="button" onClick={() => void action('pause')}>暂停</button>
                )}
                {active.has(selected.status) && (
                  <button type="button" onClick={() => void action('cancel')}>取消</button>
                )}
                {['paused', 'interrupted', 'blocked', 'failed'].includes(selected.status) && (
                  <button type="button" onClick={() => void action('resume')}>继续/重跑</button>
                )}
                <button type="button" className="del" onClick={() => void hideSelected()}>删除窗口</button>
              </div>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
