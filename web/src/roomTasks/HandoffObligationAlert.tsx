import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { api, type Message } from '../platform/api';
import { taskFileOf } from './roomTasks';
import {
  createRecoveryWatcher,
  firstUnresolvedTask,
  matchRecovery,
  openRoomTaskDetail,
  parseHandoffObligationMeta,
  recoveryEvidenceText,
  type RecoveryWatcher,
  type TaskRecoveryItem,
} from './handoffObligation';
import { Icon } from '../platform/icons';

interface Props {
  message: Message;
  fallback: string;
  bulkClass?: string;
  bulkMark?: React.ReactNode;
  selected?: boolean;
  onSelect?: () => void;
}

const WATCH_INTERVAL_MS = 15_000;

function stateText(state: TaskRecoveryItem['state']): string {
  if (state === 'recovered') return '已恢复';
  if (state === 'pending') return '未恢复';
  return '未知';
}

/**
 * Chat-side handoff-obligation alert. The gateway-written meta links the red
 * box to the exact failed turn + tasks. The box flips to the calm
 * "once failed, later recovered" state only when EVERY associated task
 * carries a confirmed recovery for that turn; partial recovery keeps the
 * unresolved alarm with per-item details. A mount-lifetime watcher keeps
 * polling while anything is unconfirmed, so a recovery that lands after the
 * first paint still flips the box without refresh. "查看详情" opens the
 * exact task in the room task panel. Read failures keep the alarm (fail
 * closed, never hide it).
 */
export default function HandoffObligationAlert({
  message,
  fallback,
  bulkClass = '',
  bulkMark = null,
  selected = false,
  onSelect,
}: Props) {
  const ref = parseHandoffObligationMeta(message.meta);
  const [items, setItems] = useState<TaskRecoveryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const watcherRef = useRef<RecoveryWatcher | null>(null);

  useEffect(() => {
    if (!ref) return;
    const roomId = message.contact_id;
    const taskIds = ref.taskIds;
    const failedTurnId = ref.failedTurnId;
    const load = async (): Promise<TaskRecoveryItem[]> => {
      const list = await api.roomTasks(roomId);
      const out: TaskRecoveryItem[] = [];
      for (const taskId of taskIds) {
        const match = list.tasks.find((task) => task.id === taskId);
        if (!match) {
          out.push({ taskId, taskPath: taskId, state: 'unknown', evidence: '' });
          continue;
        }
        try {
          const view = await api.roomTask(roomId, taskFileOf(match.task_path), { event_limit: 50 });
          const hit = matchRecovery(view.unsettledRecoveries, failedTurnId);
          if (hit?.recovered) {
            out.push({
              taskId,
              taskPath: match.task_path,
              state: 'recovered',
              evidence: recoveryEvidenceText(hit.evidence),
            });
          } else {
            out.push({ taskId, taskPath: match.task_path, state: 'pending', evidence: '' });
          }
        } catch {
          // keep the original alarm on read failure
          out.push({ taskId, taskPath: match.task_path, state: 'unknown', evidence: '' });
        }
      }
      return out;
    };
    const watcher = createRecoveryWatcher({
      load,
      intervalMs: WATCH_INTERVAL_MS,
      onUpdate: (snapshot) => {
        setItems(snapshot.items);
        setLoaded(true);
      },
    });
    watcherRef.current = watcher;
    watcher.start();
    const onFocus = () => {
      void watcher.refresh();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      watcher.stop();
      watcherRef.current = null;
    };
  }, [message.id]);

  if (!ref) return null;

  const selectMessage = () => {
    onSelect?.();
  };
  const openDetailsFor = (taskId: string) => (event: MouseEvent) => {
    event.stopPropagation();
    openRoomTaskDetail(message.contact_id, taskId);
  };
  const openDetailsKey = (taskId: string) => (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation();
      openRoomTaskDetail(message.contact_id, taskId);
    }
  };

  const total = items.length;
  const recoveredCount = items.filter((item) => item.state === 'recovered').length;
  const fullyRecovered = loaded && total > 0 && recoveredCount === total;
  // Details target: the first task still needing attention, else the first task.
  const detailsTarget = firstUnresolvedTask(items)?.taskId ?? ref.taskIds[0];

  if (fullyRecovered) {
    const evidence = items
      .map((item) => item.evidence)
      .filter((text) => text.length > 0)
      .join('、');
    return (
      <button
        type="button"
        className={`handoff-note-recovered bulk-message-control${bulkClass}`}
        aria-pressed={selected}
        onClick={selectMessage}
      >
        {bulkMark}
        <span>
          <Icon name="check" /> 本轮交接检查曾失败，后续已恢复
          {evidence ? `（${evidence}）` : ''} ·{' '}
          <span
            role="button"
            tabIndex={0}
            className="handoff-alert-details"
            onClick={openDetailsFor(detailsTarget)}
            onKeyDown={openDetailsKey(detailsTarget)}
          >
            查看详情
          </span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`error-note bulk-message-control${bulkClass}`}
      aria-pressed={selected}
      onClick={selectMessage}
    >
      {bulkMark}
      <span>
        <Icon name="warning" /> {fallback}
        {!loaded ? <small>（正在核对恢复状态…）</small> : null}
        {loaded && total > 0 ? (
          <small>
            （{recoveredCount}/{total} 个任务已恢复
            {items.map((item) => ` ${item.taskPath}：${stateText(item.state)}`).join('；')}）
          </small>
        ) : null} ·{' '}
        <span
          role="button"
          tabIndex={0}
          className="handoff-alert-details"
          onClick={openDetailsFor(detailsTarget)}
          onKeyDown={openDetailsKey(detailsTarget)}
        >
          查看详情
        </span>
      </span>
    </button>
  );
}
