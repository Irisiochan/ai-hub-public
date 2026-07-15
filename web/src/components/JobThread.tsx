import { useEffect, useState } from 'react';
import { api, type JobMessage, type WorkerJob } from '../api';
import { formatLocalTime, parseUtcTimestamp } from '../time';

/**
 * 委派任务子会话：挂在原聊天消息下的可折叠 thread。
 * 折叠时一行状态摘要；展开后是任务详情 + 结构化日志/tool/diff/结果 + 操作按钮。
 */

export const JOB_ACTIVE = new Set(['pending', 'claimed', 'running', 'pause_requested', 'cancel_requested']);

export function jobStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '等待本机上线', claimed: '已认领', running: '执行中', pause_requested: '正在暂停',
    cancel_requested: '正在取消', paused: '已暂停', interrupted: '连接中断', done: '已完成',
    failed: '失败', cancelled: '已取消', expired: '已过期',
  };
  return labels[status] ?? status;
}

function elapsedText(job: WorkerJob): string {
  const start = parseUtcTimestamp(job.created_at).getTime();
  const end = JOB_ACTIVE.has(job.status) ? Date.now() : parseUtcTimestamp(job.updated_at).getTime();
  const s = Math.max(Math.round((end - start) / 1000), 0);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

const DIFF_RE = /^(@@ |\+\+\+ |--- |diff --git )/m;

/** 日志内容：长得像 unified diff 就按行着色，其余原样 pre。 */
function LogContent({ content }: { content: string }) {
  if (!DIFF_RE.test(content)) return <pre>{content}</pre>;
  return (
    <pre className="job-diff">
      {content.split('\n').map((line, i) => (
        <span
          key={i}
          className={
            line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del'
            : line.startsWith('@@') ? 'diff-hunk' : undefined
          }
        >
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

function metaUsage(meta: string): string | null {
  try {
    const u = JSON.parse(meta)?.usage;
    if (!u) return null;
    const bits: string[] = [];
    if (u.input) bits.push(`${u.input}↑`);
    if (u.output) bits.push(`${u.output}↓`);
    return bits.length ? bits.join(' ') : null;
  } catch {
    return null;
  }
}

interface Props {
  job: WorkerJob;
  onChanged(): void; // 操作后让父级刷新任务列表
}

export default function JobThread({ job, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<JobMessage[]>([]);
  const [error, setError] = useState('');
  const active = JOB_ACTIVE.has(job.status);

  useEffect(() => {
    if (!open) return;
    const load = () =>
      void api.job(job.id).then(({ messages: rows }) => setMessages(rows)).catch(() => {});
    load();
    if (!active) return;
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, [open, job.id, job.status, active]);

  const action = async (value: 'cancel' | 'pause' | 'resume') => {
    setError('');
    try {
      await api.jobAction(job.id, value);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className={`job-thread ${active ? 'active' : ''} ${job.status}`}>
      <button className="job-thread-head" onClick={() => setOpen(!open)}>
        <span className={`job-dot ${job.status}`} />
        <b>🖥 {jobStatusLabel(job.status)}</b>
        <span className="job-thread-brief">{job.runner} · {job.prompt.slice(0, 60)}</span>
        <small>{elapsedText(job)}</small>
        <span className="job-thread-arrow">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="job-thread-body">
          <div className="job-thread-meta">
            <span>workspace <code>{job.workspace}</code></span>
            <span>worker {job.worker_id ?? '待认领'}</span>
            {job.permissions.shell && <span className="perm-chip">Shell</span>}
            {job.permissions.ssh && <span className="perm-chip danger">SSH</span>}
            <span>耗时 {elapsedText(job)}</span>
          </div>
          <div className="job-msg prompt">
            <small>任务</small>
            <pre>{job.prompt}</pre>
          </div>
          {messages
            .filter((m) => m.kind !== 'prompt')
            .map((m) => {
              const usage = metaUsage(m.meta);
              return (
                <article key={m.id} className={`job-msg ${m.kind}`}>
                  <small>
                    {m.sender} · {m.kind}{usage ? ` · ${usage}` : ''} · {formatLocalTime(m.created_at)}
                  </small>
                  <LogContent content={m.content} />
                </article>
              );
            })}
          {job.result && (
            <div className="job-msg result">
              <small>结果</small>
              <LogContent content={job.result} />
            </div>
          )}
          {job.error && (
            <div className="job-msg stderr">
              <small>错误</small>
              <pre>{job.error}</pre>
            </div>
          )}
          {error && <div className="modal-error">⚠ {error}</div>}
          <div className="job-thread-actions">
            {active && job.status !== 'pending' && (
              <button onClick={() => void action('pause')}>暂停</button>
            )}
            {active && <button onClick={() => void action('cancel')}>取消</button>}
            {['paused', 'interrupted', 'failed'].includes(job.status) && (
              <button onClick={() => void action('resume')}>
                {job.status === 'failed' ? '重试' : '继续'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
