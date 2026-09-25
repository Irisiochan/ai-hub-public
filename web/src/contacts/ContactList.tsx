import { useMemo, useState } from 'react';
import type { Contact, ContactStatus, UserProfile } from '../platform/api';
import { formatConversationListTime } from '../platform/time';
import { Icon } from '../platform/icons';
import { useMotionPresence } from '../platform/motionPresence';

interface Props {
  contacts: Contact[];
  statuses: Record<string, ContactStatus>;
  unread: Record<string, number>;
  selectedId: string | null;
  user: UserProfile;
  onSelect(id: string): void;
  onAdd(): void;
  onUserClick(): void;
  onWorkers(): void;
  onPublishStatus(): void;
}

function stateLabel(state: string): string {
  if (state === 'thinking') return '思考中…';
  if (state === 'streaming') return '正在输入…';
  if (state.startsWith('tool:')) return `正在使用 ${state.slice(5)}`;
  if (state === 'error') return '出错了';
  return '';
}

type ContactKind = 'subscription' | 'api' | 'room';

/** 会话类型说明。 */
function kindOf(contact: Contact): ContactKind {
  if (contact.kind === 'room') return 'room';
  if (contact.backend === 'api') return 'api';
  return 'subscription';
}

const KIND_NOTE: Record<ContactKind, string> = {
  subscription: '订阅',
  api: 'API',
  room: '群聊',
};

function UnreadBadge({ count }: { count: number }) {
  const presence = useMotionPresence(count > 0);
  if (!presence.rendered) return null;
  return <span className="unread-badge" data-motion-state={presence.state}>{count}</span>;
}

export default function ContactList({
  contacts,
  statuses,
  unread,
  selectedId,
  user,
  onSelect,
  onAdd,
  onUserClick,
  onWorkers,
  onPublishStatus,
}: Props) {
  const [query, setQuery] = useState('');
  const visibleContacts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return contacts.filter((contact) => {
      if (!normalized) return true;
      return [contact.name, contact.last_content ?? '']
        .some((value) => value.toLocaleLowerCase('zh-CN').includes(normalized));
    });
  }, [contacts, query]);

  return (
    <aside className="contact-list" data-motion-state={selectedId ? 'exit' : 'enter'}>
      <header className="contact-list-header">
        <h1>ai-hub</h1>
        <span className="header-btns">
          <button className="add-btn publish-btn" title="发布状态" onClick={onPublishStatus}>
            <Icon name="refresh" />
          </button>
          <button className="add-btn" title="PC Worker 任务" onClick={onWorkers}>
            <Icon name="worker" />
          </button>
          <button
            className="user-btn avatar"
            title={`${user.name} · 改我的资料`}
            style={{ background: user.color + '22' }}
            onClick={onUserClick}
          >
            {user.avatar}
          </button>
        </span>
      </header>
      <div className="contact-discovery">
        <label className="contact-search">
          <Icon name="search" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">
              <Icon name="close" />
            </button>
          )}
        </label>
      </div>
      <div className="contact-scroll">
        {visibleContacts.length === 0 && (
          <div className="contact-empty">没有匹配的会话</div>
        )}
        {visibleContacts.map((c) => {
                const st = statuses[c.id] ?? { state: 'idle' };
                const state = st.origin === 'side' ? 'idle' : st.state;
                const base = stateLabel(state);
                const label = base && st.member ? `${st.member} ${base}` : base;
                const count = unread[c.id] ?? 0;
                return (
                  <button
                    key={c.id}
                    className={`contact-item ${c.id === selectedId ? 'selected' : ''}`}
                    onClick={() => onSelect(c.id)}
                  >
                    <span
                      className="avatar"
                      style={c.id === selectedId ? undefined : { boxShadow: `inset 0 0 0 1.5px ${c.color}44` }}
                    >
                      {c.avatar}
                    </span>
                    <span className="contact-info">
                      <span className="contact-name">
                        {c.name}
                        {state !== 'idle' && (
                          <span className={`state-dot ${state === 'error' ? 'err' : 'busy'}`} />
                        )}
                      </span>
                      <span className="contact-preview">
                        {label || c.last_content?.slice(0, 48) || '还没聊过'}
                      </span>
                      <span className="contact-kind-note">{KIND_NOTE[kindOf(c)]}</span>
                    </span>
                    <span className="contact-meta">
                      <span className="contact-time">
                        {c.last_at ? formatConversationListTime(c.last_at) : ''}
                      </span>
                      <UnreadBadge count={count} />
                    </span>
                  </button>
                );
        })}
      </div>
      <button className="primary-fab" title="接入新 AI（API）" onClick={onAdd}>
        <Icon name="plus" />
        <span>接入新 AI</span>
      </button>
    </aside>
  );
}
