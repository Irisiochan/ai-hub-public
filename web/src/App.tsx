import { useCallback, useEffect, useRef, useState } from 'react';
import { api, connectEvents, type Contact, type ContactStatus, type Message, type UserProfile } from './api';
import ChatPane from './components/ChatPane';
import ContactConfig from './components/ContactConfig';
import ContactList from './components/ContactList';
import PublishStatusPanel from './components/PublishStatusPanel';
import UserConfig from './components/UserConfig';
import WorkerPanel from './components/WorkerPanel';
import { appendMessageDelta, mergeIncomingMessage, mergeMessageRows } from './messageMerge';

export default function App() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [statuses, setStatuses] = useState<Record<string, ContactStatus>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [configFor, setConfigFor] = useState<{ contact: Contact | null } | null>(null);
  const [user, setUser] = useState<UserProfile>({ name: 'User', avatar: '🦋', color: '#e94560' });
  const [userConfigOpen, setUserConfigOpen] = useState(false);
  const [workerPanelOpen, setWorkerPanelOpen] = useState(false);
  const [publishStatusOpen, setPublishStatusOpen] = useState(false);

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const eventsRef = useRef<{ refresh(): void } | null>(null);

  const upsertMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      const list = prev[msg.contact_id] ?? [];
      const idx = list.findIndex((m) => m.id === msg.id);
      const next =
        idx >= 0
          ? [...list.slice(0, idx), mergeIncomingMessage(list[idx], msg), ...list.slice(idx + 1)]
          : [...list, msg].sort((a, b) => a.id - b.id);
      return { ...prev, [msg.contact_id]: next };
    });
    setContacts((prev) =>
      prev.map((c) =>
        c.id === msg.contact_id && msg.kind === 'text'
          ? { ...c, last_content: msg.content, last_at: msg.created_at }
          : c
      )
    );
    if (msg.contact_id !== selectedRef.current && msg.sender !== 'user') {
      setUnread((prev) => ({ ...prev, [msg.contact_id]: (prev[msg.contact_id] ?? 0) + 1 }));
    }
  }, []);

  const loadMessages = useCallback(async (contactId: string) => {
    const { messages: rows } = await api.messages(contactId, { limit: 50 });
    setMessages((prev) => {
      const existing = prev[contactId] ?? [];
      return { ...prev, [contactId]: mergeMessageRows(existing, rows) };
    });
  }, []);

  const loadEarlier = useCallback(async (contactId: string) => {
    const list = messagesRef.current[contactId] ?? [];
    if (list.length === 0) return;
    const { messages: rows } = await api.messages(contactId, { before: list[0].id, limit: 50 });
    if (rows.length === 0) return;
    setMessages((prev) => {
      const existing = prev[contactId] ?? [];
      return { ...prev, [contactId]: mergeMessageRows(rows, existing) };
    });
  }, []);

  const resync = useCallback(async () => {
    const { contacts: list } = await api.contacts();
    setContacts(list);
    void api.getUser().then(setUser).catch(() => {});
    setStatuses((prev) => {
      const next = { ...prev };
      for (const c of list) {
        const prevStatus = prev[c.id];
        const busy =
          c.state === 'thinking' ||
          c.state === 'streaming' ||
          c.state.startsWith('tool:');
        // Prefer server member; if contacts snapshot omitted it mid-turn, keep
        // the previous member while state is still busy (never invent room title).
        const member =
          c.member ??
          (busy && prevStatus?.state === c.state ? prevStatus.member : undefined);
        next[c.id] = { state: c.state, member };
      }
      return next;
    });
    if (selectedRef.current) await loadMessages(selectedRef.current);
  }, [loadMessages]);

  useEffect(() => {
    void resync();
    const connection = connectEvents({
      onMessage: upsertMessage,
      onDelta: ({ contactId, messageId, text }) => {
        setMessages((prev) => {
          const list = prev[contactId];
          if (!list) return prev;
          return {
            ...prev,
            [contactId]: appendMessageDelta(list, messageId, text),
          };
        });
      },
      onStatus: ({ contactId, state, member }) =>
        setStatuses((prev) => ({ ...prev, [contactId]: { state, member } })),
      onPrune: ({ contactId, ids, afterId }) =>
        setMessages((prev) => {
          const list = prev[contactId];
          if (!list) return prev;
          const keep = list.filter((m) => {
            if (ids && ids.includes(m.id)) return false;
            if (afterId !== undefined && m.id > afterId) return false;
            return true;
          });
          return { ...prev, [contactId]: keep };
        }),
      onUser: setUser,
      onContact: (c: Contact & { enabled?: number }) =>
        setContacts((prev) => {
          if (c.enabled === 0) {
            if (selectedRef.current === c.id) setSelectedId(null);
            return prev.filter((p) => p.id !== c.id);
          }
          return prev.some((p) => p.id === c.id)
            ? prev.map((p) => (p.id === c.id ? { ...p, ...c } : p))
            : [...prev, c];
        }),
      onReconnect: () => void resync(),
    }, () => selectedRef.current ? [selectedRef.current] : []);
    eventsRef.current = connection;
    return () => connection.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    eventsRef.current?.refresh();
  }, [selectedId]);

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (id) {
        setUnread((prev) => ({ ...prev, [id]: 0 }));
        void loadMessages(id);
      }
    },
    [loadMessages]
  );

  const selected = contacts.find((c) => c.id === selectedId) ?? null;

  return (
    <div className={`app ${selected ? 'chat-open' : ''}`}>
      <ContactList
        contacts={contacts}
        statuses={statuses}
        unread={unread}
        selectedId={selectedId}
        onSelect={select}
        onAdd={() => setConfigFor({ contact: null })}
        user={user}
        onUserClick={() => setUserConfigOpen(true)}
        onWorkers={() => setWorkerPanelOpen(true)}
        onPublishStatus={() => setPublishStatusOpen(true)}
      />
      {selected ? (
        <ChatPane
          contact={selected}
          contacts={contacts}
          messages={messages[selected.id] ?? []}
          status={statuses[selected.id] ?? { state: 'idle' }}
          user={user}
          onBack={() => select(null)}
          onLoadEarlier={() => void loadEarlier(selected.id)}
          onSettings={() => setConfigFor({ contact: selected })}
        />
      ) : (
        <div className="chat-empty">选个联系人开聊</div>
      )}
      {configFor && (
        <ContactConfig
          contact={configFor.contact}
          contacts={contacts}
          onClose={() => setConfigFor(null)}
        />
      )}
      {userConfigOpen && <UserConfig user={user} onClose={() => setUserConfigOpen(false)} />}
      {workerPanelOpen && <WorkerPanel onClose={() => setWorkerPanelOpen(false)} />}
      {publishStatusOpen && <PublishStatusPanel onClose={() => setPublishStatusOpen(false)} />}
    </div>
  );
}
