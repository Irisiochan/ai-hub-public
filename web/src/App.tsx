import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  connectEvents,
  type Contact,
  type ContactStatus,
  type HeartbeatStatus,
  type Message,
  type MessageOrigin,
  type MessageReadState,
  type MessageReadStates,
  type UserProfile,
  type WorkerJob,
} from './api';
import ChatPane from './components/ChatPane';
import ContactConfig from './components/ContactConfig';
import ContactList from './components/ContactList';
import PublishStatusPanel from './components/PublishStatusPanel';
import UserConfig from './components/UserConfig';
import LedgerPanel from './components/LedgerPanel';
import WorkerPanel from './components/WorkerPanel';
import {
  createTrailingMessageReconciler,
  mergeIncomingMessage,
  mergeMessageRows,
  shouldReconcileMessagesAfterStatus,
} from './messageMerge';
import {
  applyMessageDeltaBatch,
  MessageDeltaBatcher,
  rememberRecentMessageId,
  trimMessageCache,
} from './messagePerformance';
import { effectiveMessageOrigin } from './messageSource.ts';
import { incrementReadStateForIncoming, unreadHydrationAfter } from './unreadState';
import { playSoundEvent } from './sound';
import { getUiPreferenceSnapshot } from './preferences/store';
import type { MotionState } from './motionPresence';
import { workerState } from './useWorkerState';
import { WORKER_RECONCILE_MS } from './workerState';

const emptyReadStates = (): MessageReadStates => ({
  main: { origin: 'main', lastReadMessageId: 0, firstUnreadId: null, unreadCount: 0 },
});

export default function App() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [statuses, setStatuses] = useState<Record<string, ContactStatus>>({});
  const [heartbeats, setHeartbeats] = useState<Record<string, HeartbeatStatus>>({});
  const [readStates, setReadStates] = useState<Record<string, MessageReadStates>>({});
  const [configFor, setConfigFor] = useState<{ contact: Contact | null } | null>(null);
  const [user, setUser] = useState<UserProfile>({ name: 'User', avatar: '🦋', color: '#e94560' });
  const [userConfigOpen, setUserConfigOpen] = useState(false);
  const [workerPanelOpen, setWorkerPanelOpen] = useState(false);
  const [ledgerPanelOpen, setLedgerPanelOpen] = useState(false);
  const [publishStatusOpen, setPublishStatusOpen] = useState(false);
  const [chatMotionState, setChatMotionState] = useState<MotionState>('enter');

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const eventsRef = useRef<{ refresh(): void } | null>(null);
  const lastSubscriptionRef = useRef<string | null>(selectedId);
  const incomingIdsRef = useRef(new Map<string, true>());
  const deltaBatcherRef = useRef<MessageDeltaBatcher | null>(null);
  const liveEventsReadyRef = useRef(false);
  const contactSwitchTimerRef = useRef<number | null>(null);

  const soundContext = (contactId: string | null) => ({
    currentConversation: contactId !== null && selectedRef.current === contactId,
    pageVisible: typeof document !== 'undefined' && document.visibilityState === 'visible',
  });

  const applyReadState = useCallback((contactId: string, state: MessageReadState) => {
    setReadStates((prev) => {
      const contactStates = prev[contactId] ?? emptyReadStates();
      return { ...prev, [contactId]: { ...contactStates, main: state } };
    });
  }, []);

  const applyHeartbeat = useCallback((status: HeartbeatStatus) => {
    setHeartbeats((prev) => ({ ...prev, [status.contactId]: status }));
  }, []);

  const upsertMessage = useCallback((msg: Message) => {
    if (effectiveMessageOrigin(msg) !== 'main') return;
    const incomingKey = `${msg.contact_id}:${msg.id}`;
    deltaBatcherRef.current?.discard(msg.contact_id, msg.id);
    const alreadyPresent =
      rememberRecentMessageId(incomingIdsRef.current, incomingKey) ||
      (messagesRef.current[msg.contact_id] ?? []).some((message) => message.id === msg.id);
    if (liveEventsReadyRef.current && !alreadyPresent) {
      if (msg.kind === 'error' || msg.status === 'error') {
        void playSoundEvent('error', `message:${incomingKey}:error`, soundContext(msg.contact_id));
      } else if (msg.role === 'assistant' && msg.kind === 'text' && msg.status === 'done') {
        const turnKey = msg.turn_id ?? String(msg.id);
        void playSoundEvent('assistant', `turn:${msg.contact_id}:${turnKey}:done`, soundContext(msg.contact_id));
      }
    }
    setMessages((prev) => {
      const list = prev[msg.contact_id] ?? [];
      const idx = list.findIndex((m) => m.id === msg.id);
      const next =
        idx >= 0
          ? [...list.slice(0, idx), mergeIncomingMessage(list[idx], msg), ...list.slice(idx + 1)]
          : [...list, msg].sort((a, b) => a.id - b.id);
      return { ...prev, [msg.contact_id]: trimMessageCache(next) };
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
      return { ...prev, [contactId]: trimMessageCache(mergeMessageRows(existing, rows)) };
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

  const loadEarlier = useCallback(async (contactId: string): Promise<number> => {
    const list = (messagesRef.current[contactId] ?? []).filter((message) => message.origin === 'main');
    if (list.length === 0) return 0;
    const { messages: rows } = await api.messages(contactId, { before: list[0].id, limit: 50, origin: 'main' });
    if (rows.length === 0) return 0;
    setMessages((prev) => {
      const existing = prev[contactId] ?? [];
      return { ...prev, [contactId]: trimMessageCache(mergeMessageRows(rows, existing)) };
    });
    return rows.length;
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
    const selectedContactId = selectedRef.current;
    await Promise.all([
      ...[...reconcileIds].map((contactId) => reconcileMessages(contactId)),
      ...(selectedContactId
        ? [api.heartbeat(selectedContactId).then(applyHeartbeat).catch(() => {})]
        : []),
    ]);
  }, [applyHeartbeat, reconcileMessages]);

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
    const deltaBatcher = new MessageDeltaBatcher((batches) => {
      setMessages((prev) => {
        let next = prev;
        for (const batch of batches) {
          const list = next[batch.contactId];
          if (!list) continue;
          const updated = applyMessageDeltaBatch(list, batch.deltas);
          if (updated === list) continue;
          if (next === prev) next = { ...prev };
          next[batch.contactId] = trimMessageCache(updated);
        }
        return next;
      });
    });
    deltaBatcherRef.current = deltaBatcher;
    let disposed = false;
    liveEventsReadyRef.current = false;
    void workerState.refresh().catch(() => {});
    const workerFallback = window.setInterval(() => {
      if (document.visibilityState === 'visible') void workerState.refresh().catch(() => {});
    }, WORKER_RECONCILE_MS);
    void resync().finally(() => {
      if (!disposed) liveEventsReadyRef.current = true;
    });
    const connection = connectEvents({
      onMessage: upsertMessage,
      // Delta only mutates text through the frame batcher. It never changes a
      // motion class or emits sound; completion is handled by terminal events.
      onDelta: (delta) => deltaBatcher.add(delta),
      onStatus: (status) => {
        deltaBatcher.flushNow();
        handleStatus(status);
      },
      onReadState: ({ contactId, ...state }) => applyReadState(contactId, state),
      onPrune: ({ contactId, ids, afterId }) => {
        deltaBatcher.flushNow();
        for (const id of ids ?? []) incomingIdsRef.current.delete(`${contactId}:${id}`);
        setMessages((prev) => {
          const list = prev[contactId];
          if (!list) return prev;
          const keep = list.filter((m) => {
            if (ids && ids.includes(m.id)) return false;
            if (afterId !== undefined && m.id > afterId) return false;
            return true;
          });
          return { ...prev, [contactId]: keep };
        });
      },
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
      onHeartbeat: applyHeartbeat,
      onWorker: workerState.applyWorker,
      onJobMessage: workerState.applyJobMessage,
      onWorkflowProfile: () => { void workerState.reconcile().catch(() => {}); },
      onJob: (job: WorkerJob) => {
        workerState.applyJob(job);
        if (!liveEventsReadyRef.current) return;
        const context = soundContext(job.origin_contact_id);
        if (job.status === 'done') void playSoundEvent('worker', `job:${job.id}:done`, context);
        else if (job.status === 'failed') void playSoundEvent('error', `job:${job.id}:failed`, context);
      },
      onReconnect: () => {
        deltaBatcher.flushNow();
        void resync();
        void workerState.reconcile().catch(() => {});
      },
    }, () => selectedRef.current ? [selectedRef.current] : []);
    eventsRef.current = connection;
    return () => {
      disposed = true;
      connection.disconnect();
      window.clearInterval(workerFallback);
      workerState.reset();
      deltaBatcher.close();
      if (deltaBatcherRef.current === deltaBatcher) deltaBatcherRef.current = null;
    };
  }, [applyHeartbeat, handleStatus, resync, upsertMessage]);

  useEffect(() => {
    if (lastSubscriptionRef.current === selectedId) return;
    lastSubscriptionRef.current = selectedId;
    eventsRef.current?.refresh();
  }, [selectedId]);

  useEffect(() => () => {
    if (contactSwitchTimerRef.current !== null) window.clearTimeout(contactSwitchTimerRef.current);
  }, []);

  const select = useCallback((id: string | null) => {
    const current = selectedRef.current;
    if (current === id) return;
    if (id) {
      void reconcileMessages(id);
      void api.heartbeat(id).then(applyHeartbeat).catch(() => {});
    }
    if (contactSwitchTimerRef.current !== null) window.clearTimeout(contactSwitchTimerRef.current);
    if (current === null) {
      setChatMotionState('enter');
      setSelectedId(id);
      return;
    }
    setChatMotionState('exit');
    const delay = getUiPreferenceSnapshot().effectiveMotion === 'off' ? 0 : 260;
    contactSwitchTimerRef.current = window.setTimeout(() => {
      contactSwitchTimerRef.current = null;
      setSelectedId(id);
      setChatMotionState('enter');
    }, delay);
  }, [applyHeartbeat, reconcileMessages]);

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
        onLedger={() => setLedgerPanelOpen(true)}
        onPublishStatus={() => setPublishStatusOpen(true)}
      />
      {selected ? (
        <ChatPane
          key={selected.id}
          motionState={chatMotionState}
          contact={selected}
          contacts={contacts}
          messages={messages[selected.id] ?? []}
          status={statuses[selected.id] ?? { state: 'idle' }}
          heartbeat={heartbeats[selected.id] ?? { contactId: selected.id, active: false }}
          onHeartbeat={applyHeartbeat}
          user={user}
          onBack={() => select(null)}
          readState={(readStates[selected.id] ?? emptyReadStates()).main}
          onMarkRead={(throughMessageId) => {
            void api.markRead(selected.id, throughMessageId)
              .then(({ readState }) => applyReadState(selected.id, readState))
              .catch(() => {});
          }}
          onLoadEarlier={() => loadEarlier(selected.id)}
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
      {ledgerPanelOpen && <LedgerPanel onClose={() => setLedgerPanelOpen(false)} />}
      {publishStatusOpen && <PublishStatusPanel onClose={() => setPublishStatusOpen(false)} />}
    </div>
  );
}
