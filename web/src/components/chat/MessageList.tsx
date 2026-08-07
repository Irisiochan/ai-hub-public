import { useEffect, type RefObject } from 'react';
import { type Contact, type ContactStatus, type Message, type MessageOrigin, type UserProfile, type WorkerJob } from '../../api';
import { statusText } from '../../statusText';
import type { QuoteMode } from '../../sideQuote';
import { workerReceiptJobId } from '../../sideJobActions';
import type { FollowupJobInput } from '../../sideJobActions';
import JobThread from '../JobThread';
import MessageBubble from '../MessageBubble';
import SideJobActions from './SideJobActions';

export interface MessageEdit {
  id: number;
  draft: string;
}

interface Props {
  contact: Contact;
  contacts: Contact[];
  messages: Message[];
  channel: MessageOrigin;
  status: ContactStatus;
  user: UserProfile;
  scrollRef: RefObject<HTMLDivElement>;
  firstUnreadId: number | null;
  selectedMessage: number | null;
  editing: MessageEdit | null;
  bulkMode: boolean;
  bulkIds: Set<number>;
  jobsByMessage: Map<number, WorkerJob[]>;
  looseJobs: WorkerJob[];
  jobs: WorkerJob[];
  onLoadEarlier(): void;
  onScroll(): void;
  onVisibleThrough(messageId: number): void;
  onSelect(id: number | null): void;
  onEditing(edit: MessageEdit | null): void;
  onSaveEdit(): void;
  onBulkToggle(id: number): void;
  onResend(message: Message): void;
  onDelete(message: Message): void;
  onJobsChanged(): void;
  onOpenExternalLink(url: string): void;
  onQuoteToMain(message: Message, mode: QuoteMode): void;
  onRework(message: Message, job: WorkerJob): Promise<WorkerJob>;
  onFollowup(message: Message, job: WorkerJob, input: FollowupJobInput): Promise<WorkerJob>;
  onMarkTaskDone(message: Message, job: WorkerJob, taskPath: string): Promise<void>;
}

export default function MessageList(props: Props) {
  const { contact, contacts, messages, status, user, scrollRef, selectedMessage, editing, bulkMode, bulkIds, jobsByMessage, looseJobs } = props;
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

  const renderMessage = (message: Message) => {
    const receiptJobId = workerReceiptJobId(message);
    const receiptJob = receiptJobId ? props.jobs.find((job) => job.id === receiptJobId) : undefined;
    return (
    <div className="message-timeline-item" key={message.id}>
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
          allowRegen={!isRoom && props.channel === 'main'}
          user={user}
          selected={selectedMessage === message.id}
          bulkMessageMode={bulkMode}
          bulkSelected={bulkIds.has(message.id)}
          onSelect={props.onSelect}
          onBulkMessageToggle={props.onBulkToggle}
          onEdit={(value) => {
            props.onEditing({ id: value.id, draft: value.content });
            props.onSelect(null);
          }}
          onResend={props.onResend}
          onDelete={props.onDelete}
          onOpenExternalLink={props.onOpenExternalLink}
          // 工具调用/想法块引过去只是噪声，正文才值得带进主窗
          onQuoteToMain={
            props.channel === 'side' && message.kind === 'text' ? props.onQuoteToMain : undefined
          }
        />
      )}
      {receiptJob && (
        <SideJobActions
          message={message}
          job={receiptJob}
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

  // 主窗/副窗统一：同一 turn 的 tool_use 收成一条默认折叠条，避免主窗散成一长串 chip
  const toolGroups = new Map<string, Message[]>();
  for (const message of messages) {
    if (message.kind !== 'tool_use') continue;
    const key = message.turn_id ?? `message-${message.id}`;
    toolGroups.set(key, [...(toolGroups.get(key) ?? []), message]);
  }

  const renderTimelineMessage = (message: Message) => {
    if (message.kind !== 'tool_use') return renderMessage(message);
    const key = message.turn_id ?? `message-${message.id}`;
    const group = toolGroups.get(key) ?? [message];
    if (group[0].id !== message.id) return null;
    return (
      <details className="side-tool-group" key={`tools-${key}`}>
        <summary>🔧 本轮 {group.length} 次工具调用</summary>
        <div className="side-tool-details">{group.map(renderMessage)}</div>
      </details>
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
      {messages.length >= 50 && <button className="load-earlier" onClick={props.onLoadEarlier}>加载更早的</button>}
      {props.channel === 'side' && messages.length === 0 && <div className="side-empty">后台目前很安静</div>}
      {messages.map(renderTimelineMessage)}
      {looseJobs.map((job) => <JobThread key={job.id} job={job} onChanged={props.onJobsChanged} />)}
      {status.state === 'thinking' && <div className="typing-hint">{statusText(status, { isRoom, contactName: contact.name })}</div>}
    </div>
  );
}
