import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type Contact,
  type ContactStatus,
  type Message,
  type UserProfile,
  type WorkerJob,
} from '../api';
import { usePendingImages } from './ImageComposer';
import { closeExternalLink, type ExternalLinkView, openExternalLink } from '../externalLinks';
import ExternalLinkViewer from './ExternalLinkViewer';
import { JOB_ACTIVE } from './JobThread';
import ChatHeader from './chat/ChatHeader';
import Composer from './chat/Composer';
import MessageList, { type MessageEdit } from './chat/MessageList';
import { useModelCatalog, useUsagePoll } from './chat/useChatMetadata';

interface Props {
  contact: Contact;
  contacts: Contact[];
  messages: Message[];
  status: ContactStatus;
  user: UserProfile;
  onBack(): void;
  onLoadEarlier(): void;
  onSettings(): void;
}

export default function ChatPane({ contact, contacts, messages, status, user, onBack, onLoadEarlier, onSettings }: Props) {
  const isRoom = contact.kind === 'room';
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const handleImageError = useCallback((message: string) => setSendError(message), []);
  const { pendingImages, pendingFiles, addImages, removeImage, clearImages, maxImages } = usePendingImages(handleImageError);
  const [selectedMsg, setSelectedMsg] = useState<number | null>(null);
  const [bulkMessageMode, setBulkMessageMode] = useState(false);
  const [bulkMessageIds, setBulkMessageIds] = useState<Set<number>>(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [editing, setEditing] = useState<MessageEdit | null>(null);
  const [jobs, setJobs] = useState<WorkerJob[]>([]);
  const [externalLink, setExternalLink] = useState<ExternalLinkView | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const jobsRef = useRef<WorkerJob[]>([]);
  jobsRef.current = jobs;

  const delegationEnabled = !!(contact.config.delegation as { enabled?: boolean } | undefined)?.enabled;
  const closeExternalView = useCallback(() => {
    setExternalLink(closeExternalLink());
    if (window.history.state?.aiHubExternalLink) window.history.back();
  }, []);

  const openExternalView = useCallback((url: string) => {
    setExternalLink(openExternalLink(url));
    window.history.pushState({ ...(window.history.state ?? {}), aiHubExternalLink: true }, '', window.location.href);
  }, []);

  useEffect(() => {
    if (!externalLink) return;
    const onPopState = () => setExternalLink(closeExternalLink());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeExternalView();
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [closeExternalView, externalLink]);

  const { usage, quota, codexQuota, grokQuota } = useUsagePoll(contact, status);
  const { modelCatalog, switchingModel, switchModel, switchEffort } = useModelCatalog(contact, isRoom, setSendError);

  // 这个聊天里委派出去的任务（挂回原消息下）；旧的无锚点任务只在还活跃时显示
  const loadJobs = useCallback(() => {
    void api
      .jobs()
      .then(({ jobs: rows }) =>
        setJobs(
          rows.filter(
            (j) =>
              j.origin_contact_id === contact.id ||
              (!j.origin_contact_id && j.requested_by === contact.id && JOB_ACTIVE.has(j.status))
          )
        )
      )
      .catch(() => {});
  }, [contact.id]);

  useEffect(() => {
    setJobs([]);
    loadJobs();
    const timer = setInterval(() => {
      if (delegationEnabled || jobsRef.current.some((j) => JOB_ACTIVE.has(j.status))) loadJobs();
    }, 5000);
    return () => clearInterval(timer);
  }, [contact.id, delegationEnabled, loadJobs]);

  // 任务 thread 挂到已加载消息中 id ≤ 锚点的最后一条；锚点缺失/太老的活跃任务落到底部
  const jobAnchors = useMemo(() => {
    const byMessage = new Map<number, WorkerJob[]>();
    const loose: WorkerJob[] = [];
    const ids = messages.map((m) => m.id);
    for (const job of [...jobs].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      let target: number | null = null;
      if (job.origin_anchor_id != null) {
        for (const id of ids) {
          if (id <= job.origin_anchor_id) target = id;
          else break;
        }
        if (target === null && ids.length > 0) target = ids[0];
      }
      if (target === null) loose.push(job);
      else byMessage.set(target, [...(byMessage.get(target) ?? []), job]);
    }
    return { byMessage, loose };
  }, [jobs, messages]);

  const bulkMessages = useMemo(
    () => messages.filter((m) => m.kind !== 'thinking' || Boolean(m.content) || m.status === 'streaming'),
    [messages]
  );
  const bulkSelectedMessageIds = useMemo(
    () => bulkMessages.filter((m) => bulkMessageIds.has(m.id)).map((m) => m.id),
    [bulkMessageIds, bulkMessages]
  );
  const allMessagesSelected =
    bulkMessages.length > 0 && bulkSelectedMessageIds.length === bulkMessages.length;

  const canSendImages = isRoom || ['api', 'codex', 'claude-cli', 'grok-cli'].includes(contact.backend);

  const addComposerImages = (files: File[]) => {
    setSendError(null);
    addImages(files);
  };

  useEffect(() => {
    setBulkMessageIds((prev) => {
      if (prev.size === 0) return prev;
      const available = new Set(bulkMessages.map((m) => m.id));
      const next = new Set([...prev].filter((id) => available.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [bulkMessages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, contact.id]);

  useEffect(() => {
    setSelectedMsg(null);
    setBulkMessageMode(false);
    setBulkMessageIds(new Set());
    setEditing(null);
    clearImages();
    setDraft('');
  }, [contact.id, clearImages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const send = async () => {
    const content = draft.trim();
    if ((!content && pendingImages.length === 0) || sending) return;
    setSendError(null);
    setSending(true);
    stickToBottom.current = true;
    try {
      await api.send(contact.id, content, pendingFiles);
      setDraft('');
      clearImages();
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const saveEdit = async () => {
    if (!editing || !editing.draft.trim()) return;
    const { id, draft: content } = editing;
    setEditing(null);
    setSelectedMsg(null);
    stickToBottom.current = true;
    try {
      await api.regenerate(contact.id, id, content);
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const resend = async (m: Message) => {
    setSelectedMsg(null);
    stickToBottom.current = true;
    try {
      await api.regenerate(contact.id, m.id);
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const remove = async (m: Message) => {
    setSelectedMsg(null);
    try {
      await api.deleteMessage(contact.id, m.id);
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const toggleBulkMessageMode = () => {
    setSendError(null);
    setSelectedMsg(null);
    setEditing(null);
    setBulkMessageMode((enabled) => {
      if (enabled) setBulkMessageIds(new Set());
      return !enabled;
    });
  };

  const toggleBulkMessage = (id: number) => {
    setBulkMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllMessages = () => {
    setBulkMessageIds(allMessagesSelected ? new Set() : new Set(bulkMessages.map((m) => m.id)));
  };

  const deleteSelectedMessages = async () => {
    const ids = bulkSelectedMessageIds;
    if (ids.length === 0 || bulkDeleting) return;
    if (!window.confirm('删除选中的 ' + ids.length + ' 个消息气泡？未选中的消息不会受影响。')) return;
    setSendError(null);
    setSelectedMsg(null);
    setBulkDeleting(true);
    try {
      for (const id of ids) await api.deleteMessage(contact.id, id);
      setBulkMessageIds(new Set());
      setBulkMessageMode(false);
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setBulkDeleting(false);
    }
  };

  return (
    <main className="chat-pane">
      <ChatHeader
        contact={contact}
        status={status}
        usage={usage}
        quota={quota}
        codexQuota={codexQuota}
        grokQuota={grokQuota}
        modelCatalog={modelCatalog}
        switchingModel={switchingModel}
        bulkMode={bulkMessageMode}
        bulkDeleting={bulkDeleting}
        bulkCount={bulkMessages.length}
        onBack={onBack}
        onSettings={onSettings}
        onToggleBulk={toggleBulkMessageMode}
        onSwitchModel={(value) => void switchModel(value)}
        onSwitchEffort={(value) => void switchEffort(value)}
      />

      {bulkMessageMode && (
        <div className="bulk-tool-bar">
          <span>已选 {bulkSelectedMessageIds.length} / {bulkMessages.length}</span>
          <button type="button" onClick={toggleAllMessages} disabled={bulkMessages.length === 0 || bulkDeleting}>
            {allMessagesSelected ? '取消全选' : '全选'}
          </button>
          <button type="button" className="del" onClick={() => void deleteSelectedMessages()} disabled={bulkSelectedMessageIds.length === 0 || bulkDeleting}>
            {bulkDeleting ? '删除中…' : '删除所选'}
          </button>
          <button type="button" onClick={toggleBulkMessageMode} disabled={bulkDeleting}>
            退出
          </button>
        </div>
      )}

      <MessageList
        contact={contact}
        contacts={contacts}
        messages={messages}
        status={status}
        user={user}
        scrollRef={scrollRef}
        selectedMessage={selectedMsg}
        editing={editing}
        bulkMode={bulkMessageMode}
        bulkIds={bulkMessageIds}
        jobsByMessage={jobAnchors.byMessage}
        looseJobs={jobAnchors.loose}
        onLoadEarlier={onLoadEarlier}
        onScroll={onScroll}
        onSelect={setSelectedMsg}
        onEditing={setEditing}
        onSaveEdit={() => void saveEdit()}
        onBulkToggle={toggleBulkMessage}
        onResend={(message) => void resend(message)}
        onDelete={(message) => void remove(message)}
        onJobsChanged={loadJobs}
        onOpenExternalLink={openExternalView}
      />

      {sendError && <div className="send-error">操作失败：{sendError}</div>}

      <Composer
        contactName={contact.name}
        draft={draft}
        sending={sending}
        canSendImages={canSendImages}
        pendingImages={pendingImages}
        maxImages={maxImages}
        onDraft={setDraft}
        onAddImages={addComposerImages}
        onRemoveImage={removeImage}
        onSend={() => void send()}
      />
      {externalLink && <ExternalLinkViewer view={externalLink} onClose={closeExternalView} />}
    </main>
  );
}
