import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
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
import { buildMessageTimeline, messageSelectionKey, sameMessageReferences } from '../../messageTurns';
import {
  MAX_CACHED_MESSAGES_PER_CONTACT,
  selectMessageWindow,
  windowBoundaryForMessage,
} from '../../messagePerformance';
import { Icon } from '../icons';

const NO_HANDLED_RECEIPTS: ReadonlySet<number> = new Set();

export interface MessageEdit {
  id: number;
  draft: string;
}

interface AssistantTurnClusterProps {
  entering: boolean;
  messages: Message[];
  contact: Contact;
  senderName: string;
  user: UserProfile;
  selected: boolean;
  bulkMode: boolean;
  bulkSelected: boolean;
  firstUnreadId: number | null;
  jobs: WorkerJob[];
  jobsByMessage: Map<number, WorkerJob[]>;
  onSelect(id: number | null): void;
  onBulkToggle(message: Message): void;
  onDelete(message: Message, scope?: 'turn'): void;
  onOpenExternalLink(url: string): void;
  onRework(message: Message, job: WorkerJob): Promise<WorkerJob>;
  onFollowup(message: Message, job: WorkerJob, input: FollowupJobInput): Promise<WorkerJob>;
  onMarkTaskDone(message: Message, job: WorkerJob, taskPath: string): Promise<void>;
  onReceiptHandled(messageId: number): void;
}

const AssistantTurnCluster = memo(function AssistantTurnCluster(props: AssistantTurnClusterProps) {
  const [processOpen, setProcessOpen] = useState(false);
  const processMessages = props.messages.filter((message) => message.kind === 'thinking' || message.kind === 'tool_use');
  const bodyMessages = props.messages.filter((message) => message.kind === 'text');
  const terminal = props.messages[props.messages.length - 1];
  const thinkingCount = processMessages.filter((message) => message.kind === 'thinking').length;
  const toolCount = processMessages.length - thinkingCount;
  const unreadId = props.messages.some((message) => message.id === props.firstUnreadId)
    ? props.firstUnreadId
    : null;

  return (
    <div className={`assistant-turn-cluster${props.selected ? ' selected' : ''}`} {...(props.entering ? { 'data-motion-state': 'enter' } : {})}>
      {unreadId !== null && (
        <div className="unread-divider" data-unread-divider={unreadId} role="separator" aria-label="以下是新消息">
          <span>以下是新消息</span>
        </div>
      )}
      {props.messages.map((message) => (
        <span key={message.id} className="message-read-sentinel" data-message-id={message.id} aria-hidden="true" />
      ))}
      <div className="assistant-turn-layout">
        <span className="avatar turn-avatar" style={{ boxShadow: `inset 0 0 0 1.5px ${props.contact.color}55` }}>
          {props.contact.avatar}
        </span>
        <div className="assistant-turn-content">
          <span className="assistant-turn-name">{props.senderName}</span>
          {processMessages.length > 0 && (
            <div className="turn-process">
              <button
                type="button"
                className={`proc-strip${props.bulkMode && bodyMessages.length === 0 ? ` bulk-selectable${props.bulkSelected ? ' bulk-selected' : ''}` : ''}`}
                aria-expanded={processOpen}
                onClick={() => {
                  if (props.bulkMode) {
                    props.onBulkToggle(terminal);
                    return;
                  }
                  setProcessOpen((open) => !open);
                }}
              >
                {props.bulkMode && bodyMessages.length === 0 && (
                  <span className="tool-select-mark" aria-hidden="true">
                    {props.bulkSelected ? <Icon name="check" /> : null}
                  </span>
                )}
                <Icon name={thinkingCount > 0 ? 'thinking' : 'tool'} />
                <span>过程</span>
                <small>
                  {[thinkingCount > 0 ? `${thinkingCount} 段思考` : '', toolCount > 0 ? `${toolCount} 次工具` : '']
                    .filter(Boolean)
                    .join(' · ')}
                </small>
                <Icon className="proc-caret" name={processOpen ? 'chevron-up' : 'chevron-down'} />
              </button>
              {processOpen && (
                <div className="proc-body" data-motion-state="enter">
                  {processMessages.map((message) => (
                    <div key={message.id} className={message.kind === 'thinking' ? 'think' : 'tool'}>
                      <Icon name={message.kind === 'thinking' ? 'thinking' : 'tool'} />
                      <span>{message.content || (message.status === 'streaming' ? '处理中…' : '过程已完成')}</span>
                      {message.status === 'streaming' && <span className="cursor" aria-hidden="true" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="assistant-turn-body">
            {bodyMessages.map((message, index) => {
              const receiptJobId = workerReceiptJobId(message);
              const receiptJob = receiptJobId ? props.jobs.find((job) => job.id === receiptJobId) : undefined;
              return (
                <div className="message-timeline-item" key={message.id} {...(receiptJob ? { 'data-receipt-card-id': message.id } : {})}>
                  <MessageBubble
                    message={message}
                    contact={props.contact}
                    allowRegen={false}
                    user={props.user}
                    selected={props.selected}
                    bulkMessageMode={props.bulkMode}
                    bulkSelected={props.bulkSelected}
                    showBulkMark={index === bodyMessages.length - 1}
                    showActions={false}
                    deleteScope="turn"
                    clustered
                    onSelect={() => props.onSelect(props.selected ? null : terminal.id)}
                    onBulkMessageToggle={() => props.onBulkToggle(terminal)}
                    onEdit={() => {}}
                    onResend={() => {}}
                    onDelete={props.onDelete}
                    onOpenExternalLink={props.onOpenExternalLink}
                  />
                  {receiptJob && (
                    <SideJobActions
                      message={message}
                      job={receiptJob}
                      onHandled={() => props.onReceiptHandled(message.id)}
                      onRework={props.onRework}
                      onFollowup={props.onFollowup}
                      onMarkTaskDone={props.onMarkTaskDone}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {props.messages.flatMap((message) => props.jobsByMessage.get(message.id) ?? []).map((job) => (
            <JobThread key={job.id} job={job} />
          ))}
          <AssistantTurnActions message={terminal} onDelete={props.onDelete} />
        </div>
      </div>
    </div>
  );
}, (previous, next) =>
  sameMessageReferences(previous.messages, next.messages)
  && previous.contact === next.contact
  && previous.user === next.user
  && previous.selected === next.selected
  && previous.bulkMode === next.bulkMode
  && previous.bulkSelected === next.bulkSelected
  && previous.firstUnreadId === next.firstUnreadId
  && previous.jobs === next.jobs
);

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
  onLoadEarlier(): Promise<number>;
  onScroll(): void;
  onVisibleThrough(messageId: number): void;
  onSelect(id: number | null): void;
  onEditing(edit: MessageEdit | null): void;
  onSaveEdit(): void;
  onBulkToggle(message: Message): void;
  onResend(message: Message): void;
  onDelete(message: Message, scope?: 'turn'): void;
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
  const [windowBeforeId, setWindowBeforeId] = useState<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const unreadPositionedForRef = useRef<string | null>(null);
  const knownMessageIdsRef = useRef<{ contactId: string; ids: Set<number>; entering: Set<number> }>({
    contactId: contact.id,
    ids: new Set(messages.map((message) => message.id)),
    entering: new Set(),
  });
  if (knownMessageIdsRef.current.contactId !== contact.id) {
    knownMessageIdsRef.current = {
      contactId: contact.id,
      ids: new Set(messages.map((message) => message.id)),
      entering: new Set(),
    };
  }
  const presentMessageIds = new Set(messages.map((message) => message.id));
  for (const id of knownMessageIdsRef.current.ids) {
    if (presentMessageIds.has(id)) continue;
    knownMessageIdsRef.current.ids.delete(id);
    knownMessageIdsRef.current.entering.delete(id);
  }
  for (const message of messages) {
    if (knownMessageIdsRef.current.ids.has(message.id)) continue;
    knownMessageIdsRef.current.ids.add(message.id);
    knownMessageIdsRef.current.entering.add(message.id);
  }
  // Keep this set stable for the row lifetime: an SSE delta changes only text,
  // never the motion attribute, so it cannot restart or cancel the entrance.
  const enteringMessageIds = knownMessageIdsRef.current.entering;
  const onVisibleThroughRef = useRef(props.onVisibleThrough);
  onVisibleThroughRef.current = props.onVisibleThrough;
  const afterNextPaint = (action: () => void) => {
    requestAnimationFrame(() => requestAnimationFrame(action));
  };
  useEffect(() => {
    setPendingOpen(false);
    setWindowBeforeId(null);
    setLoadingEarlier(false);
    unreadPositionedForRef.current = null;
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
      if (through > 0) onVisibleThroughRef.current(through);
    }, {
      root,
      threshold: 0.8,
    });
    const forEachSentinel = (node: ParentNode, visit: (sentinel: Element) => void) => {
      if (node instanceof HTMLElement && node.matches('.message-read-sentinel[data-message-id]')) {
        visit(node);
      }
      node.querySelectorAll('.message-read-sentinel[data-message-id]')
        .forEach(visit);
    };
    forEachSentinel(root, (sentinel) => observer.observe(sentinel));
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (node instanceof HTMLElement) forEachSentinel(node, (sentinel) => observer.observe(sentinel));
        });
        record.removedNodes.forEach((node) => {
          if (node instanceof HTMLElement) forEachSentinel(node, (sentinel) => observer.unobserve(sentinel));
        });
      }
    });
    mutations.observe(root, { childList: true, subtree: true });
    return () => {
      mutations.disconnect();
      observer.disconnect();
    };
  }, [contact.id, scrollRef]);

  useEffect(() => {
    if (unreadPositionedForRef.current === contact.id || props.firstUnreadId === null) return;
    if (!messages.some((message) => message.id === props.firstUnreadId)) return;
    unreadPositionedForRef.current = contact.id;
    setWindowBeforeId(windowBoundaryForMessage(messages, props.firstUnreadId));
    afterNextPaint(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-unread-divider="${props.firstUnreadId}"]`)
        ?.scrollIntoView({ block: 'start' });
    });
  }, [contact.id, messages, props.firstUnreadId]);

  const isRoom = contact.kind === 'room';
  const handledReceiptIds = handledReceipts.contactId === contact.id
    ? handledReceipts.ids
    : NO_HANDLED_RECEIPTS;
  const pendingReceipts = useMemo(
    () => isRoom ? pendingReceiptCards(messages, props.jobs, handledReceiptIds) : [],
    [handledReceiptIds, isRoom, messages, props.jobs],
  );
  const messageWindow = useMemo(
    () => selectMessageWindow(messages, windowBeforeId),
    [messages, windowBeforeId],
  );
  const visibleMessages = messageWindow.messages;

  const loadEarlierWindow = async () => {
    if (loadingEarlier || visibleMessages.length === 0) return;
    const boundary = visibleMessages[0].id;
    if (messageWindow.hasEarlier) {
      setWindowBeforeId(boundary);
      afterNextPaint(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
      });
      return;
    }
    if (messages.length >= MAX_CACHED_MESSAGES_PER_CONTACT) return;
    setLoadingEarlier(true);
    try {
      if (await props.onLoadEarlier() > 0) {
        setWindowBeforeId(boundary);
        afterNextPaint(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = 0;
        });
      }
    } finally {
      setLoadingEarlier(false);
    }
  };
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
    setWindowBeforeId(windowBoundaryForMessage(messages, messageId));
    afterNextPaint(() => {
      scrollRef.current
        ?.querySelector<HTMLElement>(`[data-receipt-card-id="${messageId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
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

  const renderMessage = (message: Message) => {
    const receiptJobId = workerReceiptJobId(message);
    const receiptJob = receiptJobId ? props.jobs.find((job) => job.id === receiptJobId) : undefined;
    return (
    <div
      className="message-timeline-item"
      key={message.id}
      {...(enteringMessageIds.has(message.id) ? { 'data-motion-state': 'enter' } : {})}
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
          showBulkMark
          showActions
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
      {isRoom && (jobsByMessage.get(message.id) ?? []).map((job) => (
        <JobThread key={job.id} job={job} />
      ))}
    </div>
    );
  };

  const timeline = useMemo(() => buildMessageTimeline(visibleMessages), [visibleMessages]);
  const renderTimelineEntry = (entry: (typeof timeline)[number]) => {
    if (entry.type === 'message') {
      return renderMessage(entry.message);
    }
    const actionMessage = entry.messages[entry.messages.length - 1];
    const speaker = senderContactOf(entry.messages[0]);
    return (
      <AssistantTurnCluster
        key={entry.key}
        entering={entry.messages.some((message) => enteringMessageIds.has(message.id))}
        messages={entry.messages}
        contact={speaker}
        senderName={senderNameOf(entry.messages[0]) ?? speaker.name}
        user={user}
        selected={entry.messages.some((message) => message.id === selectedMessage)}
        bulkMode={bulkMode}
        bulkSelected={bulkKeys.has(messageSelectionKey(actionMessage))}
        firstUnreadId={props.firstUnreadId}
        jobs={props.jobs}
        jobsByMessage={jobsByMessage}
        onSelect={props.onSelect}
        onBulkToggle={props.onBulkToggle}
        onDelete={props.onDelete}
        onOpenExternalLink={props.onOpenExternalLink}
        onRework={props.onRework}
        onFollowup={props.onFollowup}
        onMarkTaskDone={props.onMarkTaskDone}
        onReceiptHandled={markReceiptHandled}
      />
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
        if (target.closest('.msg-group, .edit-box, .job-thread, .side-job-actions, .assistant-turn-cluster, button, a')) {
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
      {(messageWindow.hasEarlier || (messages.length >= 50 && messages.length < MAX_CACHED_MESSAGES_PER_CONTACT)) && (
        <button className="load-earlier" onClick={() => void loadEarlierWindow()} disabled={loadingEarlier}>
          {loadingEarlier ? '加载中…' : '加载更早的'}
        </button>
      )}
      {timeline.map(renderTimelineEntry)}
      {messageWindow.hasLater && (
        <button className="load-earlier" onClick={() => {
          setWindowBeforeId(null);
          afterNextPaint(() => {
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            props.onScroll();
          });
        }}>返回最新消息</button>
      )}
      {isRoom && looseJobs.map((job) => <JobThread key={job.id} job={job} />)}
      {status.state === 'thinking' && <div className="typing-hint">{statusText(status, { isRoom, contactName: contact.name })}</div>}
    </div>
  );
}
