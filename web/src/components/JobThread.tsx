import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type JobMessage, type WorkerJob } from '../api';
import { formatLocalTime, parseUtcTimestamp } from '../time';
import { useConfirm, type ConfirmFn } from './ConfirmDialog';

/**
 * 委派任务子会话：挂在原聊天消息下的紧凑状态条。
 * 执行过程默认隐藏，点击后在全屏层显示任务详情 + 结构化日志/tool/diff/结果 + 操作按钮。
 * 删除只软隐藏任务窗口，不碰原聊天消息。
 */

export const JOB_ACTIVE = new Set([
  'pending',
  'claimed',
  'running',
  'recovering',
  'pause_requested',
  'cancel_requested',
]);

/** Confirm + soft-hide a job window. Shared by chat thread and Worker panel. */
export async function hideJobWindow(job: WorkerJob, confirm: ConfirmFn): Promise<boolean> {
  const active = JOB_ACTIVE.has(job.status);
  if (active) {
    const ok = await confirm({
      title: '隐藏运行中的任务',
      message: '任务仍在队列或执行中。\n\n' +
        '删除窗口不会硬删数据，但后台 Worker 仍可能继续执行。\n' +
        '若要停止执行，请先点「取消」。\n\n' +
        '确定仅删除（隐藏）此任务窗口？',
      confirmLabel: '仅隐藏窗口',
      danger: true,
    });
    if (!ok) return false;
  } else {
    const ok = await confirm({
      title: '隐藏任务窗口',
      message: '删除此任务窗口？\n\n仅从界面隐藏（软删除），刷新后不会再出现；任务记录与日志仍保留。',
      confirmLabel: '隐藏窗口',
      danger: true,
    });
    if (!ok) return false;
  }
  await api.deleteJob(job.id, { force: active });
  return true;
}

/** Confirm + mark a blocked job whose commit was completed outside its original worker run. */
export async function resolveJobOutOfBand(job: WorkerJob, confirm: ConfirmFn): Promise<boolean> {
  if (job.status !== 'blocked' || job.delivery_state?.startsWith('blocked_') !== true) return false;
  const ok = await confirm({
    title: '标记已接力完成',
    message: '确认这项任务的成果已经由场外接力进入主分支？\n\n确认后任务会转为已完成；此操作不代表已经部署或通过线上验收。',
    confirmLabel: '确认已接力完成',
  });
  if (!ok) return false;
  await api.resolveJobOutOfBand(job.id);
  return true;
}

export function jobStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: '等待本机上线', claimed: '已认领', running: '执行中', recovering: '正在恢复',
    pause_requested: '正在暂停',
    cancel_requested: '正在取消', paused: '已暂停', interrupted: '连接中断', done: '已完成',
    blocked: '待续接', failed: '失败', cancelled: '已取消', expired: '已过期',
  };
  return labels[status] ?? status;
}

export function humanJobLabel(job: WorkerJob): string {
  return job.delivery_summary?.label ?? jobStatusLabel(job.status);
}

export function DeliverySummaryCard({ job }: { job: WorkerJob }) {
  const delivery = job.delivery_summary;
  if (!delivery) return null;
  return (
    <section className={`delivery-summary ${delivery.state}`} aria-label="交付状态摘要">
      <div>
        <b>{delivery.label}</b>
        <p>{delivery.summary}</p>
        <small>下一步负责人：{delivery.nextOwner}</small>
      </div>
      <details>
        <summary>展开内部状态与证据</summary>
        <dl>
          <div><dt>任务状态</dt><dd><code>{job.status}</code></dd></div>
          <div><dt>交付状态</dt><dd><code>{job.delivery_state ?? '未上报'}</code></dd></div>
          {job.delivery_meta && (
            <div><dt>交付证据</dt><dd><pre>{JSON.stringify(job.delivery_meta, null, 2)}</pre></dd></div>
          )}
        </dl>
      </details>
    </section>
  );
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
  const confirm = useConfirm();
  const [showExecution, setShowExecution] = useState(false);
  const [messages, setMessages] = useState<JobMessage[]>([]);
  const [error, setError] = useState('');
  const [hiding, setHiding] = useState(false);
  const [resolving, setResolving] = useState(false);
  const active = JOB_ACTIVE.has(job.status);
  const canResolveOutOfBand = job.status === 'blocked'
    && job.delivery_state?.startsWith('blocked_') === true;

  useEffect(() => {
    if (!showExecution) return;
    const load = () =>
      void api.job(job.id).then(({ messages: rows }) => setMessages(rows)).catch(() => {});
    load();
    if (!active) return;
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, [showExecution, job.id, job.status, active]);

  useEffect(() => {
    if (!showExecution) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowExecution(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [showExecution]);

  const action = async (value: 'cancel' | 'pause' | 'resume') => {
    setError('');
    try {
      await api.jobAction(job.id, value);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const updateDelivery = async (
    stage: 'online_waiting_validation' | 'closed_loop' | 'rework_required',
  ) => {
    setError('');
    const presets = {
      online_waiting_validation: {
        summary: '对应版本已经上线，等待真实入口验收。',
        nextOwner: '验收负责人',
      },
      closed_loop: {
        summary: '实现、交付和要求内的验收均已完成。',
        nextOwner: '无需后续动作',
      },
      rework_required: {
        summary: '当前交付未通过验收，需要按反馈继续处理。',
        nextOwner: 'PC Worker',
      },
    } as const;
    try {
      await api.updateJobDelivery(job.id, { stage, ...presets[stage] });
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
      const done = await hideJobWindow(job, confirm);
      if (done) onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setHiding(false);
    }
  };

  const resolveOutOfBand = async () => {
    if (resolving || !canResolveOutOfBand) return;
    setError('');
    setResolving(true);
    try {
      const done = await resolveJobOutOfBand(job, confirm);
      if (done) onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className={`job-thread ${active ? 'active' : ''} ${job.status}`}>
      <div className="job-thread-head-row">
        <button type="button" className="job-thread-head" onClick={() => setShowExecution(true)}>
          <span className={`job-dot ${job.status}`} />
          <b>🖥 {humanJobLabel(job)}</b>
          <span className="job-thread-brief">{job.runner} · {job.prompt.slice(0, 60)}</span>
          <small>{elapsedText(job)}</small>
          <span className="job-thread-open">查看执行过程</span>
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
      {showExecution && createPortal(
        <div
          className="job-execution-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="PC Worker 执行过程"
        >
          <section className="job-execution-modal">
            <header className="job-execution-header">
              <div>
                <span className={`job-dot ${job.status}`} />
                <b>PC Worker · {humanJobLabel(job)}</b>
                <small>{job.runner} · {elapsedText(job)}</small>
              </div>
              <button
                type="button"
                className="job-execution-close"
                aria-label="关闭执行过程"
                onClick={() => setShowExecution(false)}
              >
                ×
              </button>
            </header>
            <div className="job-execution-scroll">
              <div className="job-thread-meta">
                <span>workspace <code>{job.workspace}</code></span>
                <span>worker {job.worker_id ?? '待认领'}</span>
                {job.permissions.shell && <span className="perm-chip">Shell</span>}
                {job.permissions.ssh && <span className="perm-chip danger">SSH</span>}
                {job.permissions.write === false && <span className="perm-chip">只读</span>}
                <span>耗时 {elapsedText(job)}</span>
              </div>
              <DeliverySummaryCard job={job} />
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
                {canResolveOutOfBand && (
                  <button type="button" disabled={resolving} onClick={() => void resolveOutOfBand()}>
                    {resolving ? '标记中…' : '标记已接力完成'}
                  </button>
                )}
                {!active && (
                  <>
                    <button type="button" onClick={() => void updateDelivery('online_waiting_validation')}>标记已上线</button>
                    <button type="button" onClick={() => void updateDelivery('closed_loop')}>标记已闭环</button>
                    <button type="button" onClick={() => void updateDelivery('rework_required')}>打回重做</button>
                  </>
                )}
                <button type="button" className="del" disabled={hiding} onClick={() => void hideWindow()}>
                  {hiding ? '删除中…' : '删除窗口'}
                </button>
              </div>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </div>
  );
}
