import type { Contact, ContactStatus, UserProfile } from '../api';
import { formatConversationListTime } from '../time';

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
  if (state.startsWith('tool:')) return `🔧 ${state.slice(5)}`;
  if (state === 'error') return '出错了';
  return '';
}

const BACKEND_TAG: Record<string, string> = {
  'claude-cli': 'claude cli',
  codex: 'codex',
  'grok-cli': 'grok cli',
  api: 'api',
  mock: 'mock',
};

/** 分组：CLI（走订阅额度）· API 直连 · 群聊 */
function groupOf(contact: Contact): 'cli' | 'api' | 'room' {
  if (contact.kind === 'room') return 'room';
  if (contact.backend === 'api') return 'api';
  return 'cli';
}

const GROUP_TITLE: Record<'cli' | 'api' | 'room', string> = {
  cli: 'CLI · 走订阅额度',
  api: 'API 直连',
  room: '群聊',
};

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
  const groups: ('cli' | 'api' | 'room')[] = ['cli', 'api', 'room'];

  return (
    <aside className="contact-list">
      <header className="contact-list-header">
        <h1>ai-hub</h1>
        <span className="header-btns">
          <button className="add-btn publish-btn" title="发布状态" onClick={onPublishStatus}>
            ↻
          </button>
          <button className="add-btn" title="PC Worker 任务" onClick={onWorkers}>
            🖥
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
      <div className="contact-scroll">
        {groups.map((group) => {
          const rows = contacts.filter((c) => groupOf(c) === group);
          if (rows.length === 0) return null;
          return (
            <div key={group}>
              <div className="contact-group-title">{GROUP_TITLE[group]}</div>
              {rows.map((c) => {
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
                        <span className="backend-tag">
                          {c.kind === 'room' ? 'room' : BACKEND_TAG[c.backend] ?? c.backend}
                        </span>
                        {state !== 'idle' && (
                          <span className={`state-dot ${state === 'error' ? 'err' : 'busy'}`} />
                        )}
                      </span>
                      <span className="contact-preview">
                        {label || c.last_content?.slice(0, 48) || '还没聊过'}
                      </span>
                    </span>
                    <span className="contact-meta">
                      <span className="contact-time">
                        {c.last_at ? formatConversationListTime(c.last_at) : ''}
                      </span>
                      {count > 0 && <span className="unread-badge">{count}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <button className="primary-fab" title="接入新 AI（API）" onClick={onAdd}>
        ＋ 接入新 AI
      </button>
    </aside>
  );
}
