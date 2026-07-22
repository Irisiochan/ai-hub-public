import { useEffect, useState } from 'react';
import { api, type JobMessage, type WorkerJob } from '../api';
import { formatLocalTime, parseUtcTimestamp } from '../time';

/**
 * 委派任务子会话：挂在原聊天消息下的可折叠 thread。
 * 折叠时一行状态摘要；展开后是任务详情 + 结构化日志/tool/diff/结果 + 操作按钮。
 * 删除只软隐藏任务窗口，不碰原聊天消息。
 */

export const JOB_ACTIVE = new Set(['pending', 'claimed', 'running', 'pause_requested', 'cancel_requested']);

/** Confirm + soft-hide a job window. Shared by chat thread and Worker panel. */
export async function hideJobWindow(job: WorkerJob): Promise<boolean> {
  const active = JOB_ACTIVE.has(job.status);
  if (active) {
    const ok = window.confirm(
      '任务仍在队列或执行中。\n\n' +
        '删除窗口不会硬删数据，但后台 Worker 仍可能继续执行。\n' +
        '若要停止执行，请先点「取消」。\n\n' +
        '确定仅删除（隐藏）此任务窗口？'
    );
    if (!ok) return false;
  } else {
    const ok = window.confirm(
      '删除此任务窗口？\n\n仅从界面隐藏（软删除），刷新后不会再出现；任务记录与日志仍保留。'
    );
    if (!ok) return false;
  }
  await api.deleteJob(job.id, { force: active });
  return true;
}

export function jobStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '等待本机上线', claimed: '已认领', running: '执行中', pause_requested: '正在暂停',
    cancel_requested: '正在取消', paused: '已暂停', interrupted: '连接中断', done: '已完成',
    blocked: '待续接', failed: '失败', cancelled: '已取消', expired: '已过期',
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
  const [hiding, setHiding] = useState(false);
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

  const hideWindow = async () => {
    if (hiding) return;
    setError('');
    setHiding(true);
    try {
      const done = await hideJobWindow(job);
      if (done) onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setHiding(false);
    }
  };

  return (
    <div className={`job-thread ${active ? 'active' : ''} ${job.status}`}>
      <div className="job-thread-head-row">
        <button type="button" className="job-thread-head" onClick={() => setOpen(!open)}>
          <span className={`job-dot ${job.status}`} />
          <b>🖥 {jobStatusLabel(job.status)}</b>
          <span className="job-thread-brief">{job.runner} · {job.prompt.slice(0, 60)}</span>
          <small>{elapsedText(job)}</small>
          <span className="job-thread-arrow">{open ? '▾' : '▸'}</span>
        </button>
        <button
          type="button"
          className="job-thread-hide"
          title="删除任务窗口（软隐藏，不删聊天消息）"
          aria-label="删除任务窗口"
          disabled={hiding}
          onClick={(e) => {
            e.stopPropagation();
            void hideWindow();
          }}
        >
          ×
        </button>
      </div>
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
              <button type="button" onClick={() => void action('pause')}>暂停</button>
            )}
            {active && <button type="button" onClick={() => void action('cancel')}>取消</button>}
            {['paused', 'interrupted', 'blocked', 'failed'].includes(job.status) && (
              <button type="button" onClick={() => void action('resume')}>
                {['failed', 'blocked'].includes(job.status) ? '重试' : '继续'}
              </button>
            )}
            <button type="button" className="del" disabled={hiding} onClick={() => void hideWindow()}>
              {hiding ? '删除中…' : '删除窗口'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
