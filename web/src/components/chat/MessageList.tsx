import { useEffect, useMemo, useState, type RefObject } from 'react';
import { type Contact, type ContactStatus, type Message, type UserProfile, type WorkerJob } from '../../api';
import { statusText } from '../../statusText';
import {
  loadHandledReceiptIds,
  pendingReceiptCards,
  saveHandledReceiptIds,
  workerReceiptJobId,
} from '../../sideJobActions';
import type { FollowupJobInput } from '../../sideJobActions';
import JobThread from '../JobThread';
import MessageBubble, { AssistantTurnActions } from '../MessageBubble';
import SideJobActions from './SideJobActions';
import { buildMessageTimeline, messageSelectionKey } from '../../messageTurns';

const NO_HANDLED_RECEIPTS: ReadonlySet<number> = new Set();

export interface MessageEdit {
  id: number;
  draft: string;
}

interface Props {
  contact: Contact;
  contacts: Contact[];
  messages: Message[];
  status: ContactStatus;
  user: UserProfile;
  scrollRef: RefObject<HTMLDivElement>;
  firstUnreadId: number | null;
  selectedMessage: number | null;
  editing: MessageEdit | null;
  bulkMode: boolean;
  bulkKeys: Set<string>;
  jobsByMessage: Map<number, WorkerJob[]>;
  looseJobs: WorkerJob[];
  jobs: WorkerJob[];
  onLoadEarlier(): void;
  onScroll(): void;
  onVisibleThrough(messageId: number): void;
  onSelect(id: number | null): void;
  onEditing(edit: MessageEdit | null): void;
  onSaveEdit(): void;
  onBulkToggle(message: Message): void;
  onResend(message: Message): void;
  onDelete(message: Message, scope?: 'turn'): void;
  onJobsChanged(): void;
  onOpenExternalLink(url: string): void;
  onRework(message: Message, job: WorkerJob): Promise<WorkerJob>;
  onFollowup(message: Message, job: WorkerJob, input: FollowupJobInput): Promise<WorkerJob>;
  onMarkTaskDone(message: Message, job: WorkerJob, taskPath: string): Promise<void>;
}

export default function MessageList(props: Props) {
  const { contact, contacts, messages, status, user, scrollRef, selectedMessage, editing, bulkMode, bulkKeys, jobsByMessage, looseJobs } = props;
  const [handledReceipts, setHandledReceipts] = useState<{ contactId: string; ids: Set<number> }>(() => ({
    contactId: contact.id,
    ids: loadHandledReceiptIds(contact.id),
  }));
  const [pendingOpen, setPendingOpen] = useState(false);
  useEffect(() => {
    setPendingOpen(false);
    setHandledReceipts({
      contactId: contact.id,
      ids: loadHandledReceiptIds(contact.id),
    });
  }, [contact.id]);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (document.visibilityState !== 'visible') return;
      let through = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = Number((entry.target as HTMLElement).dataset.messageId);
        if (Number.isSafeInteger(id)) through = Math.max(through, id);
      }
      if (through > 0) props.onVisibleThrough(through);
    }, {
      root,
      threshold: 0.8,
    });
    const sentinels = root.querySelectorAll<HTMLElement>('.message-read-sentinel[data-message-id]');
    sentinels.forEach((sentinel) => observer.observe(sentinel));
    return () => observer.disconnect();
  }, [messages, props.onVisibleThrough, scrollRef]);

  const isRoom = contact.kind === 'room';
  const handledReceiptIds = handledReceipts.contactId === contact.id
    ? handledReceipts.ids
    : NO_HANDLED_RECEIPTS;
  const pendingReceipts = useMemo(
    () => isRoom ? pendingReceiptCards(messages, props.jobs, handledReceiptIds) : [],
    [handledReceiptIds, isRoom, messages, props.jobs],
  );
  const markReceiptHandled = (messageId: number) => {
    setHandledReceipts((current) => {
      const ids = current.contactId === contact.id ? new Set(current.ids) : loadHandledReceiptIds(contact.id);
      ids.add(messageId);
      saveHandledReceiptIds(contact.id, ids);
      return { contactId: contact.id, ids };
    });
  };
  const jumpToReceipt = (messageId: number) => {
    setPendingOpen(false);
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-receipt-card-id="${messageId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const senderContactOf = (message: Message) =>
    message.sender === 'user' ? contact : contacts.find((candidate) => candidate.id === message.sender) ?? contact;
  const senderNameOf = (message: Message) => {
    if (message.sender === 'user') return undefined;
    if (message.sender === 'room-host') {
      try {
        const parsed = JSON.parse(message.meta || '{}');
        const name = parsed?.roomHost?.name;
        if (typeof name === 'string' && name.trim()) return name.trim();
      } catch {
        // Older/third-party rows may carry non-JSON meta; fall back below.
      }
      return 'DS 主持';
    }
    return senderContactOf(message).name;
  };

  const renderMessage = (
    message: Message,
    options: { showActions?: boolean; deleteScope?: 'turn'; compactWithPrevious?: boolean; showBulkMark?: boolean } = {},
  ) => {
    const receiptJobId = workerReceiptJobId(message);
    const receiptJob = receiptJobId ? props.jobs.find((job) => job.id === receiptJobId) : undefined;
    return (
    <div
      className={`message-timeline-item${options.compactWithPrevious ? ' same-turn-continuation' : ''}`}
      key={message.id}
      {...(receiptJob ? { 'data-receipt-card-id': message.id } : {})}
    >
      {props.firstUnreadId === message.id && (
        <div
          className="unread-divider"
          data-unread-divider={message.id}
          role="separator"
          aria-label="以下是新消息"
        ><span>以下是新消息</span></div>
      )}
      <span className="message-read-sentinel" data-message-id={message.id} aria-hidden="true" />
      {editing?.id === message.id ? (
        <div className="edit-box">
          <textarea autoFocus rows={3} value={editing.draft} onChange={(event) => props.onEditing({ ...editing, draft: event.target.value })} />
          <div className="edit-actions">
            <button className="ghost-btn" onClick={() => props.onEditing(null)}>取消</button>
            <button className="primary-btn" onClick={props.onSaveEdit}>保存并重新生成</button>
          </div>
        </div>
      ) : (
        <MessageBubble
          message={message}
          contact={senderContactOf(message)}
          showName={isRoom ? senderNameOf(message) : undefined}
          allowRegen={!isRoom}
          user={user}
          selected={selectedMessage === message.id}
          bulkMessageMode={bulkMode}
          bulkSelected={bulkKeys.has(messageSelectionKey(message))}
          showBulkMark={options.showBulkMark}
          showActions={options.showActions}
          deleteScope={options.deleteScope}
          onSelect={props.onSelect}
          onBulkMessageToggle={props.onBulkToggle}
          onEdit={(value) => {
            props.onEditing({ id: value.id, draft: value.content });
            props.onSelect(null);
          }}
          onResend={props.onResend}
          onDelete={props.onDelete}
          onOpenExternalLink={props.onOpenExternalLink}
        />
      )}
      {receiptJob && (
        <SideJobActions
          message={message}
          job={receiptJob}
          onHandled={() => markReceiptHandled(message.id)}
          onRework={props.onRework}
          onFollowup={props.onFollowup}
          onMarkTaskDone={props.onMarkTaskDone}
        />
      )}
      {(jobsByMessage.get(message.id) ?? []).map((job) => (
        <JobThread key={job.id} job={job} onChanged={props.onJobsChanged} />
      ))}
    </div>
    );
  };

  const timeline = buildMessageTimeline(messages);
  const renderTimelineEntry = (entry: (typeof timeline)[number]) => {
    if (entry.type === 'message') {
      return renderMessage(entry.message, {
        showActions: entry.turnId ? entry.isFinalTurnBlock : true,
        deleteScope: entry.turnId ? 'turn' : undefined,
        compactWithPrevious: entry.compactWithPrevious,
        showBulkMark: !entry.turnId || entry.isFinalTurnBlock,
      });
    }
    const actionMessage = entry.messages[entry.messages.length - 1];
    const selected = entry.messages.some((message) => message.id === selectedMessage);
    const bulkSelected = bulkKeys.has(messageSelectionKey(actionMessage));
    const showBulkMark = !entry.turnId || entry.isFinalTurnBlock;
    return (
      <div
        className={`assistant-tool-turn${entry.compactWithPrevious ? ' same-turn-continuation' : ''}${selected ? ' selected' : ''}`}
        key={entry.key}
      >
        <details className={`side-tool-group${bulkMode ? ` bulk-selectable${bulkSelected ? ' bulk-selected' : ''}` : ''}`}>
          <summary
            onClick={(event) => {
              if (bulkMode) {
                event.preventDefault();
                props.onBulkToggle(actionMessage);
                return;
              }
              if (entry.isFinalTurnBlock) props.onSelect(selected ? null : actionMessage.id);
            }}
          >
            {bulkMode && showBulkMark && (
              <span className="tool-select-mark" aria-hidden="true">{bulkSelected ? '✓' : ''}</span>
            )}
            🔧 本轮 {entry.messages.length} 次工具调用
          </summary>
          <div className="side-tool-details">
            {entry.messages.map((message) => renderMessage(message, { showActions: false, showBulkMark: false }))}
          </div>
        </details>
        {entry.isFinalTurnBlock && (
          <AssistantTurnActions message={actionMessage} onDelete={props.onDelete} />
        )}
      </div>
    );
  };

  return (
    <div
      className="message-scroll"
      ref={scrollRef}
      onScroll={props.onScroll}
      onClick={(event) => {
        // 点空白处收起操作钮（点消息气泡本身由 MessageBubble 切换选中）
        const target = event.target as HTMLElement | null;
        if (!target) return;
        if (target.closest('.msg-group, .edit-box, .job-thread, .side-job-actions, .side-tool-group, button, a')) {
          return;
        }
        if (props.selectedMessage != null) props.onSelect(null);
      }}
    >
      {pendingReceipts.length > 0 && (
        <div className="pending-receipt-entry" aria-label="待操作验收卡入口">
          <button
            type="button"
            className="pending-receipt-summary"
            aria-expanded={pendingReceipts.length > 1 ? pendingOpen : undefined}
            onClick={() => {
              if (pendingReceipts.length === 1) jumpToReceipt(pendingReceipts[0].message.id);
              else setPendingOpen((open) => !open);
            }}
          >
            <span>待操作验收卡</span>
            <strong>{pendingReceipts.length}</strong>
            <span className="pending-receipt-hint">{pendingReceipts.length === 1 ? '定位' : pendingOpen ? '收起' : '展开'}</span>
          </button>
          {pendingOpen && pendingReceipts.length > 1 && (
            <div className="pending-receipt-menu">
              {pendingReceipts.map(({ message, job }) => (
                <button type="button" key={message.id} onClick={() => jumpToReceipt(message.id)}>
                  <span>{job.delivery_summary?.label ?? 'Worker 回执'}</span>
                  <small>{job.id.slice(0, 8)}</small>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {messages.length >= 50 && <button className="load-earlier" onClick={props.onLoadEarlier}>加载更早的</button>}
      {timeline.map(renderTimelineEntry)}
      {looseJobs.map((job) => <JobThread key={job.id} job={job} onChanged={props.onJobsChanged} />)}
      {status.state === 'thinking' && <div className="typing-hint">{statusText(status, { isRoom, contactName: contact.name })}</div>}
    </div>
  );
}
