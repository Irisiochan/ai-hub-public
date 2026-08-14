import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type Contact,
  type ContactStatus,
  type Message,
  type UserProfile,
  type MessageReadState,
  type WorkerJob,
} from '../api';
import { usePendingImages } from './ImageComposer';
import { closeExternalLink, type ExternalLinkView, openExternalLink } from '../externalLinks';
import ExternalLinkViewer from './ExternalLinkViewer';
import { JOB_ACTIVE } from './JobThread';
import ChatHeader from './chat/ChatHeader';
import Composer from './chat/Composer';
import RuntimeDrawer from './chat/RuntimeDrawer';
import MessageList, { type MessageEdit } from './chat/MessageList';
import { useConfirm } from './ConfirmDialog';
import { useModelCatalog, useUsagePoll } from './chat/useChatMetadata';
import {
  buildFollowupPrompt,
  buildReworkPrompt,
  followupIdempotencyKey,
  reworkIdempotencyKey,
  type FollowupJobInput,
  visibleJobsForContact,
  workerReceiptJobId,
} from '../sideJobActions';
import {
  prepareMessageSendAttempt,
  type MessageSendAttempt,
} from '../sendIdempotency';
import { buildMessageSelectionUnits, messageSelectionKey } from '../messageTurns';

interface Props {
  contact: Contact;
  contacts: Contact[];
  messages: Message[];
  status: ContactStatus;
  user: UserProfile;
  onBack(): void;
  readState: MessageReadState;
  onMarkRead(throughMessageId: number): void;
  onLoadEarlier(): void;
  onSettings(): void;
}

export default function ChatPane({ contact, contacts, messages, status, user, onBack, readState, onMarkRead, onLoadEarlier, onSettings }: Props) {
  const confirm = useConfirm();
  const isRoom = contact.kind === 'room';
  const channelMessages = messages;
  const channelStatus: ContactStatus = status.origin === 'side'
    ? { state: 'idle', origin: 'main' } : status;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const handleImageError = useCallback((message: string) => setSendError(message), []);
  const { pendingImages, pendingFiles, addImages, removeImage, clearImages, maxImages } = usePendingImages(handleImageError);
  const [selectedMsg, setSelectedMsg] = useState<number | null>(null);
  const [bulkMessageMode, setBulkMessageMode] = useState(false);
  const [bulkMessageKeys, setBulkMessageKeys] = useState<Set<string>>(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [editing, setEditing] = useState<MessageEdit | null>(null);
  const [jobs, setJobs] = useState<WorkerJob[]>([]);
  const composerFocus = 0;
  const [externalLink, setExternalLink] = useState<ExternalLinkView | null>(null);
  // 方案 1b：运行时抽屉。桌面默认常驻，窄屏默认收起（是标题下的下拉卡）
  const [runtimeOpen, setRuntimeOpen] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const positionedContactsRef = useRef(new Set<string>());
  const boundaryContactRef = useRef(contact.id);
  const unreadBoundaryRef = useRef<number | null>(readState.firstUnreadId);
  const stickToBottom = useRef(true);
  const jobsRef = useRef<WorkerJob[]>([]);
  const channelMessagesRef = useRef(channelMessages);
  const sendAttemptRef = useRef<MessageSendAttempt | null>(null);
  jobsRef.current = jobs;
  channelMessagesRef.current = channelMessages;

  if (boundaryContactRef.current !== contact.id) {
    boundaryContactRef.current = contact.id;
    positionedContactsRef.current.clear();
    unreadBoundaryRef.current = readState.firstUnreadId;
  }
  const firstUnreadId = unreadBoundaryRef.current;
  const delegationEnabled = !!(contact.config.delegation as { enabled?: boolean } | undefined)?.enabled;
  const receiptJobIdsVersion = useMemo(() => {
    const ids = new Set<string>();
    for (const message of channelMessages) {
      const jobId = workerReceiptJobId(message);
      if (jobId) ids.add(jobId);
    }
    return [...ids].sort().join('\0');
  }, [channelMessages]);
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
          visibleJobsForContact(contact.id, channelMessagesRef.current, rows, JOB_ACTIVE)
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
  }, [contact.id, delegationEnabled, loadJobs, receiptJobIdsVersion]);

  // 任务 thread 挂到已加载消息中 id ≤ 锚点的最后一条；锚点缺失/太老的活跃任务落到底部
  const jobAnchors = useMemo(() => {
    const byMessage = new Map<number, WorkerJob[]>();
    const loose: WorkerJob[] = [];
    const ids = channelMessages.map((m) => m.id);
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
  }, [channelMessages, jobs]);

  const bulkMessageUnits = useMemo(
    () => buildMessageSelectionUnits(channelMessages),
    [channelMessages]
  );
  const bulkSelectedUnits = useMemo(
    () => bulkMessageUnits.filter((unit) => bulkMessageKeys.has(unit.key)),
    [bulkMessageKeys, bulkMessageUnits]
  );
  const allMessagesSelected =
    bulkMessageUnits.length > 0 && bulkSelectedUnits.length === bulkMessageUnits.length;

  const canSendImages = isRoom || ['api', 'codex', 'claude-cli', 'grok-cli'].includes(contact.backend);

  const addComposerImages = (files: File[]) => {
    setSendError(null);
    addImages(files);
  };

  useEffect(() => {
    setBulkMessageKeys((prev) => {
      if (prev.size === 0) return prev;
      const available = new Set(bulkMessageUnits.map((unit) => unit.key));
      const next = new Set([...prev].filter((key) => available.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [bulkMessageUnits]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const positionKey = contact.id;
    if (!positionedContactsRef.current.has(positionKey)) {
      if (firstUnreadId !== null && !channelMessages.some((message) => message.id === firstUnreadId)) {
        return;
      }
      const frame = requestAnimationFrame(() => {
        const divider = firstUnreadId === null
          ? null
          : el.querySelector<HTMLElement>(`[data-unread-divider="${firstUnreadId}"]`);
        if (divider) divider.scrollIntoView({ block: 'start' });
        else el.scrollTop = el.scrollHeight;
        stickToBottom.current = firstUnreadId === null;
        positionedContactsRef.current.add(positionKey);
      });
      return () => cancelAnimationFrame(frame);
    }
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [channelMessages, contact.id, firstUnreadId]);

  useEffect(() => {
    setSelectedMsg(null);
    setBulkMessageMode(false);
    setBulkMessageKeys(new Set());
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
    const attempt = prepareMessageSendAttempt(
      sendAttemptRef.current,
      contact.id,
      content,
      pendingFiles
    );
    sendAttemptRef.current = attempt;
    try {
      const result = await api.send(
        contact.id,
        content,
        pendingFiles,
        attempt.idempotencyKey
      );
      sendAttemptRef.current = null;
      setDraft('');
      clearImages();
      if (result.queued === false) {
        setSendError(`${result.error ?? '当前排队已满'}；消息已保存，不会重复发送。`);
      } else if (result.duplicate) {
        setSendError('消息已保存；这次重试已去重。');
      }
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

  const remove = async (m: Message, scope?: 'turn') => {
    setSelectedMsg(null);
    try {
      await api.deleteMessage(contact.id, m.id, scope ? { scope } : undefined);
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const toggleBulkMessageMode = () => {
    setSendError(null);
    setSelectedMsg(null);
    setEditing(null);
    setBulkMessageMode((enabled) => {
      if (enabled) setBulkMessageKeys(new Set());
      return !enabled;
    });
  };

  const toggleBulkMessage = (message: Message) => {
    const key = messageSelectionKey(message);
    setBulkMessageKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllMessages = () => {
    setBulkMessageKeys(allMessagesSelected ? new Set() : new Set(bulkMessageUnits.map((unit) => unit.key)));
  };

  const deleteSelectedMessages = async () => {
    const units = bulkSelectedUnits;
    if (units.length === 0 || bulkDeleting) return;
    if (!(await confirm({
      title: '删除消息',
      message: `删除选中的 ${units.length} 个消息单元？助手轮会连同想法、工具调用和正文整轮删除。`,
      confirmLabel: '删除消息',
      danger: true,
    }))) {
      return;
    }
    setSendError(null);
    setSelectedMsg(null);
    setBulkDeleting(true);
    try {
      for (const unit of units) {
        await api.deleteMessage(
          contact.id,
          unit.message.id,
          unit.deleteScope ? { scope: unit.deleteScope } : undefined,
        );
      }
      setBulkMessageKeys(new Set());
      setBulkMessageMode(false);
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setBulkDeleting(false);
    }
  };

  const reworkJob = async (message: Message, hintedJob: WorkerJob): Promise<WorkerJob> => {
    setSendError(null);
    try {
      const { job } = await api.job(hintedJob.id);
      const created = await api.createJob({
        runner: job.runner,
        workspace: job.workspace,
        prompt: buildReworkPrompt(job, message),
        workerId: job.worker_id || undefined,
        permissions: job.permissions,
        requestedBy: job.requested_by || contact.id,
        originContactId: job.origin_contact_id || contact.id,
        originAnchorId: job.origin_anchor_id || undefined,
        idempotencyKey: reworkIdempotencyKey(job.id, message.id),
      });
      loadJobs();
      return created;
    } catch (error) {
      setSendError((error as Error).message);
      throw error;
    }
  };

  const followupJob = async (
    message: Message,
    hintedJob: WorkerJob,
    input: FollowupJobInput
  ): Promise<WorkerJob> => {
    setSendError(null);
    try {
      const { job } = await api.job(hintedJob.id);
      const created = await api.createJob({
        runner: input.runner,
        workspace: input.workspace.trim(),
        prompt: buildFollowupPrompt(input, message),
        workerId: job.worker_id || undefined,
        permissions: job.permissions,
        requestedBy: job.requested_by || contact.id,
        originContactId: job.origin_contact_id || contact.id,
        originAnchorId: job.origin_anchor_id || undefined,
        idempotencyKey: followupIdempotencyKey(job.id, message.id, input),
      });
      loadJobs();
      return created;
    } catch (error) {
      setSendError((error as Error).message);
      throw error;
    }
  };

  const markTaskDone = async (message: Message, job: WorkerJob, taskPath: string): Promise<void> => {
    setSendError(null);
    try {
      await api.setVaultTaskStatus({
        path: taskPath,
        status: 'done',
        note: [
          `User 通过 AI Hub 会议室回执验收 Worker job \`${job.id}\` 并点击「置 done」。`,
          `回执 message id：\`${message.id}\`。`,
          '',
          '### 验收回执',
          message.content.slice(0, 2000),
        ].join('\n'),
      });
      try {
        await api.updateJobDelivery(job.id, {
          stage: 'closed_loop',
          summary: `User 会议室置 done：${taskPath}`,
          nextOwner: '无需后续动作',
        });
      } catch {
        // Vault 已关账；交付态写失败时仍靠本机 handled 持久化把卡从置顶条拿掉。
      }
      loadJobs();
    } catch (error) {
      setSendError((error as Error).message);
      throw error;
    }
  };

  const turnBusy =
    channelStatus.state === 'thinking' ||
    channelStatus.state === 'streaming' ||
    channelStatus.state.startsWith('tool:');

  return (
    <main className={'chat-pane' + (runtimeOpen ? ' runtime-open' : '')}>
      <ChatHeader
        contact={contact}
        status={channelStatus}
        runtimeOpen={runtimeOpen}
        onBack={onBack}
        onToggleRuntime={() => setRuntimeOpen((open) => !open)}
      />

      {runtimeOpen && (
        <RuntimeDrawer
          contact={contact}
          status={channelStatus}
          usage={usage}
          quota={quota}
          codexQuota={codexQuota}
          grokQuota={grokQuota}
          modelCatalog={modelCatalog}
          switchingModel={switchingModel}
          bulkMode={bulkMessageMode}
          bulkCount={bulkMessageUnits.length}
          bulkDeleting={bulkDeleting}
          onClose={() => setRuntimeOpen(false)}
          onSettings={onSettings}
          onToggleBulk={toggleBulkMessageMode}
          onSwitchModel={(value) => void switchModel(value)}
          onSwitchEffort={(value) => void switchEffort(value)}
        />
      )}

      {bulkMessageMode && (
        <div className="bulk-tool-bar">
          <span>已选 {bulkSelectedUnits.length} / {bulkMessageUnits.length}</span>
          <button type="button" onClick={toggleAllMessages} disabled={bulkMessageUnits.length === 0 || bulkDeleting}>
            {allMessagesSelected ? '取消全选' : '全选'}
          </button>
          <button type="button" className="del" onClick={() => void deleteSelectedMessages()} disabled={bulkSelectedUnits.length === 0 || bulkDeleting}>
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
        messages={channelMessages}
        status={channelStatus}
        user={user}
        scrollRef={scrollRef}
        selectedMessage={selectedMsg}
        editing={editing}
        bulkMode={bulkMessageMode}
        firstUnreadId={firstUnreadId}
        bulkKeys={bulkMessageKeys}
        jobsByMessage={jobAnchors.byMessage}
        looseJobs={jobAnchors.loose}
        jobs={jobs}
        onLoadEarlier={onLoadEarlier}
        onScroll={onScroll}
        onSelect={setSelectedMsg}
        onEditing={setEditing}
        onSaveEdit={() => void saveEdit()}
        onVisibleThrough={onMarkRead}
        onBulkToggle={toggleBulkMessage}
        onResend={(message) => void resend(message)}
        onDelete={(message, scope) => void remove(message, scope)}
        onJobsChanged={loadJobs}
        onOpenExternalLink={openExternalView}
        onRework={reworkJob}
        onFollowup={followupJob}
        onMarkTaskDone={markTaskDone}
      />

      {sendError && <div className="send-error">操作提示：{sendError}</div>}

      <Composer
        contactName={contact.name}
        draft={draft}
        sending={sending}
        busy={turnBusy}
        onInterrupt={() => void api.interrupt(contact.id)}
        canSendImages={canSendImages}
        pendingImages={pendingImages}
        maxImages={maxImages}
        focusSignal={composerFocus}
        onDraft={setDraft}
        onAddImages={addComposerImages}
        onRemoveImage={removeImage}
        onSend={() => void send()}
      />
      {externalLink && <ExternalLinkViewer view={externalLink} onClose={closeExternalView} />}
    </main>
  );
}
