import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  connectEvents,
  type Contact,
  type ContactStatus,
  type Message,
  type MessageOrigin,
  type MessageReadState,
  type MessageReadStates,
  type UserProfile,
} from './api';
import ChatPane from './components/ChatPane';
import ContactConfig from './components/ContactConfig';
import ContactList from './components/ContactList';
import PublishStatusPanel from './components/PublishStatusPanel';
import UserConfig from './components/UserConfig';
import WorkerPanel from './components/WorkerPanel';
import {
  appendMessageDelta,
  createTrailingMessageReconciler,
  mergeIncomingMessage,
  mergeMessageRows,
  shouldReconcileMessagesAfterStatus,
} from './messageMerge';
import { effectiveMessageOrigin } from './messageSource.ts';
import { incrementReadStateForIncoming, unreadHydrationAfter } from './unreadState';

const emptyReadStates = (): MessageReadStates => ({
  main: { origin: 'main', lastReadMessageId: 0, firstUnreadId: null, unreadCount: 0 },
});

export default function App() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [statuses, setStatuses] = useState<Record<string, ContactStatus>>({});
  const [readStates, setReadStates] = useState<Record<string, MessageReadStates>>({});
  const [configFor, setConfigFor] = useState<{ contact: Contact | null } | null>(null);
  const [user, setUser] = useState<UserProfile>({ name: 'User', avatar: '🦋', color: '#e94560' });
  const [userConfigOpen, setUserConfigOpen] = useState(false);
  const [workerPanelOpen, setWorkerPanelOpen] = useState(false);
  const [publishStatusOpen, setPublishStatusOpen] = useState(false);

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const eventsRef = useRef<{ refresh(): void } | null>(null);
  const lastSubscriptionRef = useRef<string | null>(selectedId);
  const incomingIdsRef = useRef(new Set<string>());

  const applyReadState = useCallback((contactId: string, state: MessageReadState) => {
    setReadStates((prev) => {
      const contactStates = prev[contactId] ?? emptyReadStates();
      return { ...prev, [contactId]: { ...contactStates, main: state } };
    });
  }, []);

  const upsertMessage = useCallback((msg: Message) => {
    if (effectiveMessageOrigin(msg) !== 'main') return;
    const incomingKey = `${msg.contact_id}:${msg.id}`;
    const alreadyPresent =
      incomingIdsRef.current.has(incomingKey) ||
      (messagesRef.current[msg.contact_id] ?? []).some((message) => message.id === msg.id);
    incomingIdsRef.current.add(incomingKey);
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
        c.id === msg.contact_id && msg.kind === 'text' && effectiveMessageOrigin(msg) === 'main'
          ? { ...c, last_content: msg.content, last_at: msg.created_at }
          : c
      )
    );
    setReadStates((prev) => {
      const contactStates = prev[msg.contact_id] ?? emptyReadStates();
      const next = incrementReadStateForIncoming(contactStates.main, msg, alreadyPresent);
      if (!next || next === contactStates.main) return prev;
      return { ...prev, [msg.contact_id]: { ...contactStates, main: next } };
    });
  }, []);

  const loadMessages = useCallback(async (contactId: string) => {
    const initial = await api.messages(contactId, { limit: 50, origin: 'main' });
    let rows = initial.messages;
    let state = initial.readState ?? emptyReadStates().main;
    const after = unreadHydrationAfter(state, rows.map((message) => message.id));
    if (after !== null) {
      const hydrated = await api.messages(contactId, { after, limit: 1000, origin: 'main' });
      rows = mergeMessageRows(hydrated.messages, rows);
      state = hydrated.readState ?? state;
    }
    setMessages((prev) => {
      const existing = prev[contactId] ?? [];
      return { ...prev, [contactId]: mergeMessageRows(existing, rows) };
    });
    setReadStates((prev) => ({
      ...prev,
      [contactId]: { main: state },
    }));
  }, []);

  const reconcileMessages = useMemo(
    () => createTrailingMessageReconciler(loadMessages),
    [loadMessages]
  );

  const loadEarlier = useCallback(async (contactId: string) => {
    const list = (messagesRef.current[contactId] ?? []).filter((message) => message.origin === 'main');
    if (list.length === 0) return;
    const { messages: rows } = await api.messages(contactId, { before: list[0].id, limit: 50, origin: 'main' });
    if (rows.length === 0) return;
    setMessages((prev) => {
      const existing = prev[contactId] ?? [];
      return { ...prev, [contactId]: mergeMessageRows(rows, existing) };
    });
  }, []);

  const resync = useCallback(async () => {
    const { contacts: list } = await api.contacts();
    setContacts(list);
    setReadStates((prev) => {
      const next = { ...prev };
      for (const contact of list) {
        if (contact.readStates) next[contact.id] = contact.readStates;
      }
      return next;
    });
    void api.getUser().then(setUser).catch(() => {});
    const previousStatuses = statusesRef.current;
    const nextStatuses = { ...previousStatuses };
    const reconcileIds = new Set<string>();
    for (const c of list) {
      const prevStatus = previousStatuses[c.id];
      const busy = c.state === 'thinking' || c.state === 'streaming' || c.state.startsWith('tool:');
      const member = c.member ?? (busy && prevStatus?.state === c.state ? prevStatus.member : undefined);
      nextStatuses[c.id] = { state: c.state, member, origin: c.origin };
      if (shouldReconcileMessagesAfterStatus(prevStatus?.state, c.state, messagesRef.current[c.id] ?? [])) {
        reconcileIds.add(c.id);
      }
    }
    statusesRef.current = nextStatuses;
    setStatuses(nextStatuses);
    if (selectedRef.current) reconcileIds.add(selectedRef.current);
    await Promise.all([...reconcileIds].map((contactId) => reconcileMessages(contactId)));
  }, [reconcileMessages]);

  const handleStatus = useCallback(({ contactId, state, member, origin }: {
    contactId: string;
    state: string;
    member?: string;
    origin?: MessageOrigin;
  }) => {
    const previous = statusesRef.current[contactId];
    const next = { state, member, origin };
    statusesRef.current = { ...statusesRef.current, [contactId]: next };
    setStatuses((current) => ({ ...current, [contactId]: next }));
    if (shouldReconcileMessagesAfterStatus(previous?.state, state, messagesRef.current[contactId] ?? [])) {
      void reconcileMessages(contactId).catch(() => {});
    }
  }, [reconcileMessages]);

  useEffect(() => {
    void resync();
    const connection = connectEvents({
      onMessage: upsertMessage,
      onDelta: ({ contactId, messageId, text }) => {
        setMessages((prev) => {
          const list = prev[contactId];
          if (!list) return prev;
          return { ...prev, [contactId]: appendMessageDelta(list, messageId, text) };
        });
      },
      onStatus: handleStatus,
      onReadState: ({ contactId, ...state }) => applyReadState(contactId, state),
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
  }, [handleStatus, resync, upsertMessage]);

  useEffect(() => {
    if (lastSubscriptionRef.current === selectedId) return;
    lastSubscriptionRef.current = selectedId;
    eventsRef.current?.refresh();
  }, [selectedId]);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) void reconcileMessages(id);
  }, [reconcileMessages]);

  const unread = useMemo(() => Object.fromEntries(
    contacts.map((contact) => [contact.id, readStates[contact.id]?.main.unreadCount ?? 0])
  ), [contacts, readStates]);
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
          readState={(readStates[selected.id] ?? emptyReadStates()).main}
          onMarkRead={(throughMessageId) => {
            void api.markRead(selected.id, throughMessageId)
              .then(({ readState }) => applyReadState(selected.id, readState))
              .catch(() => {});
          }}
          onLoadEarlier={() => void loadEarlier(selected.id)}
          onSettings={() => setConfigFor({ contact: selected })}
        />
      ) : (
        <div className="chat-empty">选个人开聊 🍊</div>
      )}
      {configFor && (
        <ContactConfig contact={configFor.contact} contacts={contacts} onClose={() => setConfigFor(null)} />
      )}
      {userConfigOpen && <UserConfig user={user} onClose={() => setUserConfigOpen(false)} />}
      {workerPanelOpen && <WorkerPanel onClose={() => setWorkerPanelOpen(false)} />}
      {publishStatusOpen && <PublishStatusPanel onClose={() => setPublishStatusOpen(false)} />}
    </div>
  );
}
