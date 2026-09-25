import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type RoomTaskSummary, type RoomTaskView } from '../platform/api';
import { ROOM_TASKS_OPEN_EVENT } from './handoffObligation';
import { isActiveRoomTask, taskFileOf, taskStatusText } from './roomTasks';
import RoomTaskCreateForm from './RoomTaskCreateForm';

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 12) : '—';
}

export default function RoomTasksPanel({ roomId }: { roomId: string }) {
  const [tasks, setTasks] = useState<RoomTaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RoomTaskView | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createNotice, setCreateNotice] = useState('');
  // Stale-response guards: every async read carries an identity; only the
  // latest list generation and the currently open detail may commit.
  const generation = useRef(0);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const openIdRef = useRef<string | null>(null);
  openIdRef.current = openId;

  const fetchDetail = useCallback((room: string, task: RoomTaskSummary) => {
    const myRequest = detailRequest.current + 1;
    detailRequest.current = myRequest;
    const myGeneration = generation.current;
    setDetail(null);
    setDetailError(null);
    api.roomTask(room, taskFileOf(task.task_path), { event_limit: 50 }).then(
      (view) => {
        if (generation.current !== myGeneration || detailRequest.current !== myRequest) return;
        setDetail(view);
      },
      (err: Error) => {
        if (generation.current !== myGeneration || detailRequest.current !== myRequest) return;
        setDetailError(err instanceof Error ? err.message : String(err));
      },
    );
  }, []);

  const refresh = useCallback(() => {
    const myGeneration = generation.current;
    const myRequest = ++listRequest.current;
    setError(null);
    api.roomTasks(roomId).then(
      (res) => {
        if (generation.current !== myGeneration || listRequest.current !== myRequest) return;
        setTasks(res.tasks);
        // Refresh the open detail as appropriate; a closed/missing task
        // clears the panel instead of showing stale content.
        const open = openIdRef.current;
        const match = open ? res.tasks.find((task) => task.id === open) : undefined;
        if (open && !match) {
          detailRequest.current += 1;
          setOpenId(null);
          setDetail(null);
        } else if (match) {
          fetchDetail(roomId, match);
        }
      },
      (err: Error) => {
        if (generation.current !== myGeneration || listRequest.current !== myRequest) return;
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  }, [roomId, fetchDetail]);

  useEffect(() => {
    // New room (or remount): invalidate in-flight reads from the old room.
    generation.current += 1;
    detailRequest.current += 1;
    setTasks(null);
    setError(null);
    setOpenId(null);
    setDetail(null);
    setDetailError(null);
    refresh();
  }, [refresh, roomId]);

  useEffect(() => {
    let timer: number | null = null;
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ roomId?: string }>).detail;
      if (detail?.roomId && detail.roomId !== roomId) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; refresh(); }, 100);
    };
    window.addEventListener('room-tasks:changed', changed);
    return () => {
      window.removeEventListener('room-tasks:changed', changed);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [roomId, refresh]);

  // Real details entry for handoff-obligation chat alerts: open the exact
  // task and reveal it. Other rooms' requests are ignored.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ roomId?: string; taskId?: string }>).detail;
      if (!detail || detail.roomId !== roomId || !detail.taskId) return;
      const match = tasks?.find((task) => task.id === detail.taskId);
      if (!match) return;
      setOpenId(match.id);
      fetchDetail(roomId, match);
      window.setTimeout(() => {
        document.getElementById(`room-task-${match.id}`)?.scrollIntoView({ block: 'nearest' });
      }, 80);
    };
    window.addEventListener(ROOM_TASKS_OPEN_EVENT, handler);
    return () => window.removeEventListener(ROOM_TASKS_OPEN_EVENT, handler);
  }, [roomId, fetchDetail, tasks]);

  const visibleTasks = tasks?.filter((task) => isActiveRoomTask(task.status)) ?? null;

  const toggle = (task: RoomTaskSummary) => {
    if (openId === task.id) {
      detailRequest.current += 1;
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(task.id);
    fetchDetail(roomId, task);
  };

  return (
    <section className="room-tasks" aria-label="任务账本">
      <div className="room-tasks-header">
        <strong>任务账本</strong>
        <span className="room-tasks-count">{visibleTasks ? `${visibleTasks.length} 个任务` : '读取中…'}</span>
        <span className="spacer" />
        <button type="button" onClick={() => { setCreating(!creating); setCreateNotice(''); }}>建账并派单</button>
        <button type="button" className="room-tasks-refresh" onClick={() => void refresh()} aria-label="刷新任务账本">
          刷新
        </button>
      </div>
      {error && <p className="workflow-error" role="alert">任务账本读取失败：{error}</p>}
      {createNotice && <p role="status">{createNotice}</p>}
      {creating && <RoomTaskCreateForm roomId={roomId} onCancel={() => setCreating(false)} onCreated={notice => {
        setCreating(false); setCreateNotice(notice); refresh();
      }} />}
      {visibleTasks && visibleTasks.length === 0 && <p className="room-tasks-empty">暂无任务。建账后这里会显示状态与证据。</p>}
      {visibleTasks && visibleTasks.map((task) => (
        <article key={task.id} id={`room-task-${task.id}`} className="room-task">
          <button type="button" className="room-task-head" onClick={() => toggle(task)} aria-expanded={openId === task.id}>
            <span className={`room-task-status ${task.status}`}>{taskStatusText(task.status)}</span>
            <span className="room-task-title">{task.title || task.task_path}</span>
            <small className="room-task-meta">
              {task.owner_module}@{task.owner_contact} · rev{task.revision} · 候选{shortSha(task.candidate_sha)}
              {task.review_status ? ` · 评审${task.review_status}` : ''}
            </small>
          </button>
          {openId === task.id && (
            <div className="room-task-body">
              {detailError && <p className="workflow-error" role="alert">详情读取失败：{detailError}</p>}
              {!detail && !detailError && <p className="room-tasks-empty">读取中…</p>}
              {detail && (
                <>
                  <p className="room-task-req">{detail.task.requirements.slice(0, 800)}</p>
                  <p className="room-task-meta">工作区 <code>{detail.task.approved_workspace || '（未绑定）'}</code></p>
                  <div className="room-task-section" aria-label="尝试">
                    <strong>尝试 {detail.attempts.length}</strong>
                    {detail.attempts.map((attempt) => {
                      const row = attempt as Record<string, unknown>;
                      return (
                        <p key={String(row.id)} className="room-task-meta">
                          <code>{String(row.id).slice(0, 8)}</code> {String(row.status)} / {String(row.deliveryState ?? '—')}
                          {' '}HEAD {shortSha(typeof row.head === 'string' ? row.head : null)}
                        </p>
                      );
                    })}
                  </div>
                  <div className="room-task-section" aria-label="证据">
                    <strong>证据 {detail.evidence.length}</strong>
                    {detail.evidence.slice(-10).map((item) => (
                      <p key={item.id} className="room-task-meta">
                        [{item.kind}] {item.ref} — {(item.body || '').slice(0, 200)}
                      </p>
                    ))}
                  </div>
                  {(detail.waits ?? []).length > 0 && (
                    <div className="room-task-section" aria-label="等待">
                      <strong>等待 {detail.waits.length}</strong>
                      {detail.waits.map((wait) => (
                        <p key={wait.id} className="room-task-meta">
                          [{wait.mode}{wait.scope === 'callback' ? '/scoped' : ''}] rev{wait.revision} · {wait.actor}{wait.module ? `@${wait.module}` : ''}
                          {' '}— {(wait.reason || '').slice(0, 200)}
                          {' '}恢复：{(wait.resume_condition || '').slice(0, 200)}
                        </p>
                      ))}
                    </div>
                  )}
                  <div className="room-task-section" aria-label="事件">
                    <strong>事件 {detail.events.length}</strong>
                    {detail.events.slice(-10).map((item) => {
                      if (item.kind !== 'turn-unsettled') {
                        return (
                          <p key={item.id} className="room-task-meta">
                            {item.kind} · {item.actor}{item.module ? `@${item.module}` : ''}
                          </p>
                        );
                      }
                      // Preserved audit first: the original failure row is never
                      // rewritten. Recovery only adds a separate hint for the
                      // same task + chain; unrelated activity never clears it.
                      let failedTurnId = '';
                      try {
                        const payload = JSON.parse(item.payload || '{}') as { turnId?: unknown };
                        if (typeof payload.turnId === 'string') failedTurnId = payload.turnId;
                      } catch {
                        failedTurnId = '';
                      }
                      const recovery = (detail.unsettledRecoveries ?? []).find(
                        (entry) => entry.turnId && failedTurnId && entry.turnId === failedTurnId,
                      );
                      if (recovery?.recovered) {
                        const evidence = (recovery.evidence ?? [])
                          .map((entry) => `${entry.kind}#${entry.eventId}`)
                          .join('、');
                        return (
                          <p key={item.id} className="room-task-meta">
                            本轮交接检查曾失败，后续已恢复 · 查看详情
                            {' '}({item.kind} · {item.actor}{item.module ? `@${item.module}` : ''}{evidence ? ` → ${evidence}` : ''})
                          </p>
                        );
                      }
                      return (
                        <p key={item.id} className="workflow-error">
                          未交接：{item.kind} · {item.actor}{item.module ? `@${item.module}` : ''}
                        </p>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
