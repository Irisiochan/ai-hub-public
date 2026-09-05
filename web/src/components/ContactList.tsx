import { useMemo, useState } from 'react';
import type { Contact, ContactStatus, UserProfile } from '../api';
import { formatConversationListTime } from '../time';
import { Icon } from './icons';
import { useMotionPresence } from '../motionPresence';

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
  onLedger(): void;
}

function stateLabel(state: string): string {
  if (state === 'thinking') return '思考中…';
  if (state === 'streaming') return '正在输入…';
  if (state.startsWith('tool:')) return `正在使用 ${state.slice(5)}`;
  if (state === 'error') return '出错了';
  return '';
}

type ContactFolder = 'all' | 'subscription' | 'api' | 'room';

/** 文件夹：订阅 CLI · API 直连 · 群聊。 */
function folderOf(contact: Contact): Exclude<ContactFolder, 'all'> {
  if (contact.kind === 'room') return 'room';
  if (contact.backend === 'api') return 'api';
  return 'subscription';
}

const FOLDERS: { id: ContactFolder; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'subscription', label: '订阅' },
  { id: 'api', label: 'API' },
  { id: 'room', label: '群聊' },
];

const FOLDER_NOTE: Record<Exclude<ContactFolder, 'all'>, string> = {
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
  onLedger,
}: Props) {
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState<ContactFolder>('all');
  const visibleContacts = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    return contacts.filter((contact) => {
      if (folder !== 'all' && folderOf(contact) !== folder) return false;
      if (!normalized) return true;
      return [contact.name, contact.last_content ?? '']
        .some((value) => value.toLocaleLowerCase('zh-CN').includes(normalized));
    });
  }, [contacts, folder, query]);

  return (
    <aside className="contact-list" data-motion-state={selectedId ? 'exit' : 'enter'}>
      <header className="contact-list-header">
        <h1>ai-hub</h1>
        <span className="header-btns">
          <button className="add-btn" title="账本" onClick={onLedger}>
            <Icon name="ledger" />
          </button>
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
        <div className="contact-folders" role="tablist" aria-label="会话文件夹">
          {FOLDERS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={folder === item.id}
              className={folder === item.id ? 'selected' : ''}
              onClick={() => setFolder(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
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
                      <span className="contact-kind-note">{FOLDER_NOTE[folderOf(c)]}</span>
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
