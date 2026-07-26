import { Fragment, type RefObject } from 'react';
import { type Contact, type ContactStatus, type Message, type UserProfile, type WorkerJob } from '../../api';
import { statusText } from '../../statusText';
import JobThread from '../JobThread';
import MessageBubble from '../MessageBubble';

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
  selectedMessage: number | null;
  editing: MessageEdit | null;
  bulkMode: boolean;
  bulkIds: Set<number>;
  jobsByMessage: Map<number, WorkerJob[]>;
  looseJobs: WorkerJob[];
  onLoadEarlier(): void;
  onScroll(): void;
  onSelect(id: number | null): void;
  onEditing(edit: MessageEdit | null): void;
  onSaveEdit(): void;
  onBulkToggle(id: number): void;
  onResend(message: Message): void;
  onDelete(message: Message): void;
  onJobsChanged(): void;
  onOpenExternalLink(url: string): void;
}

export default function MessageList(props: Props) {
  const { contact, contacts, messages, status, user, scrollRef, selectedMessage, editing, bulkMode, bulkIds, jobsByMessage, looseJobs } = props;
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

  return (
    <div className="message-scroll" ref={scrollRef} onScroll={props.onScroll}>
      {messages.length >= 50 && <button className="load-earlier" onClick={props.onLoadEarlier}>加载更早的</button>}
      {messages.map((message) => (
        <Fragment key={message.id}>
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
            />
          )}
          {(jobsByMessage.get(message.id) ?? []).map((job) => <JobThread key={job.id} job={job} onChanged={props.onJobsChanged} />)}
        </Fragment>
      ))}
      {looseJobs.map((job) => <JobThread key={job.id} job={job} onChanged={props.onJobsChanged} />)}
      {status.state === 'thinking' && <div className="typing-hint">{statusText(status, { isRoom, contactName: contact.name })}</div>}
    </div>
  );
}
