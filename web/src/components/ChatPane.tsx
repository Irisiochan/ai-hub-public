import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type ClaudeQuota,
  type CodexQuota,
  type GrokQuota,
  type Contact,
  type ContactStatus,
  type Message,
  type ModelCatalog,
  type Usage,
  type UserProfile,
  type WorkerJob,
} from '../api';
import { DISPLAY_TIME_ZONE } from '../time';
import { statusText } from '../statusText';
import { ImageAttachButton, ImagePreviewStrip, usePendingImages } from './ImageComposer';
import { closeExternalLink, type ExternalLinkView, openExternalLink } from '../externalLinks';
import ExternalLinkViewer from './ExternalLinkViewer';
import JobThread, { JOB_ACTIVE } from './JobThread';
import MessageBubble from './MessageBubble';

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

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtFullTokens(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

function fmtQuotaReset(resetsAt: string | null | undefined): string {
  if (!resetsAt) return '重置时间未知';
  return `${new Intl.DateTimeFormat('zh-CN', {
    timeZone: DISPLAY_TIME_ZONE,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(resetsAt))} 重置`;
}

export default function ChatPane({ contact, contacts, messages, status, user, onBack, onLoadEarlier, onSettings }: Props) {
  const isRoom = contact.kind === 'room';
  const senderContactOf = (m: Message): Contact =>
    m.sender === 'user' ? contact : contacts.find((c) => c.id === m.sender) ?? contact;
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const handleImageError = useCallback((message: string) => setSendError(message), []);
  const { pendingImages, pendingFiles, addImages, removeImage, clearImages, maxImages } = usePendingImages(handleImageError);
  const [selectedMsg, setSelectedMsg] = useState<number | null>(null);
  const [bulkMessageMode, setBulkMessageMode] = useState(false);
  const [bulkMessageIds, setBulkMessageIds] = useState<Set<number>>(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [editing, setEditing] = useState<{ id: number; draft: string } | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [quota, setQuota] = useState<ClaudeQuota | null>(null);
  const [codexQuota, setCodexQuota] = useState<CodexQuota | null>(null);
  const [grokQuota, setGrokQuota] = useState<GrokQuota | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [jobs, setJobs] = useState<WorkerJob[]>([]);
  const [externalLink, setExternalLink] = useState<ExternalLinkView | null>(null);
  const [tokenDetailOpen, setTokenDetailOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tokenDetailRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!tokenDetailOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && tokenDetailRef.current?.contains(target)) return;
      setTokenDetailOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [tokenDetailOpen]);

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

  // usage/quota：切联系人时拉一次，回合结束（idle）再刷新
  useEffect(() => {
    setUsage(null);
    setQuota(null);
    setCodexQuota(null);
    setGrokQuota(null);
    void api.usage(contact.id).then(setUsage).catch(() => {});
    if (contact.backend === 'claude-cli') {
      void api.claudeQuota().then(setQuota).catch(() => {});
    } else if (contact.backend === 'codex') {
      void api.codexQuota().then(setCodexQuota).catch(() => {});
    } else if (contact.backend === 'grok-cli') {
      void api.grokQuota().then(setGrokQuota).catch(() => {});
    }
    setSelectedMsg(null);
    setBulkMessageMode(false);
    setBulkMessageIds(new Set());
    setEditing(null);
    setTokenDetailOpen(false);
    clearImages();
    setDraft('');
  }, [contact.id, contact.backend, clearImages]);

  useEffect(() => {
    setModelCatalog(null);
    if (isRoom) return;
    // During a rolling deploy the new frontend can briefly meet the old gateway.
    // Hide the picker until the models endpoint is available instead of surfacing a noisy 404.
    void api.models(contact.id).then(setModelCatalog).catch(() => {});
  }, [contact.id, contact.backend, contact.config.model, contact.config.effort, isRoom]);

  useEffect(() => {
    if (status.state === 'idle') {
      void api.usage(contact.id).then(setUsage).catch(() => {});
      if (contact.backend === 'claude-cli') {
        void api.claudeQuota().then(setQuota).catch(() => {});
      } else if (contact.backend === 'codex') {
        void api.codexQuota().then(setCodexQuota).catch(() => {});
      } else if (contact.backend === 'grok-cli') {
        void api.grokQuota().then(setGrokQuota).catch(() => {});
      }
    }
  }, [status.state, contact.id, contact.backend]);

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

  const switchModel = async (model: string) => {
    setSwitchingModel(true);
    setSendError(null);
    try {
      await api.switchModel(contact.id, model);
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSwitchingModel(false);
    }
  };

  const switchEffort = async (effort: string) => {
    setSwitchingModel(true);
    setSendError(null);
    try {
      await api.switchEffort(contact.id, effort);
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      setSwitchingModel(false);
    }
  };

  const busy =
    status.state === 'thinking' || status.state === 'streaming' || status.state.startsWith('tool:');
  const st = statusText(status, { isRoom, contactName: contact.name });

  const quotaBits: string[] = [];
  if (contact.backend === 'claude-cli') {
    if (quota?.available) {
      if (quota.fiveHour) quotaBits.push(`5h剩${quota.fiveHour.remainingPct}%`);
      if (quota.sevenDay) quotaBits.push(`周剩${quota.sevenDay.remainingPct}%`);
    } else if (quota?.reason === 'setup-token') {
      quotaBits.push('额度不可用：VPS 需完整 claude /login');
    } else if (quota?.reason === 'login-expired') {
      quotaBits.push('额度不可用：登录过期，需重新 /login');
    }
  }
  if (contact.backend === 'codex' && codexQuota?.available) {
    if (codexQuota.fiveHour) quotaBits.push(`5h剩${codexQuota.fiveHour.remainingPct}%`);
    if (codexQuota.sevenDay) quotaBits.push(`周剩${codexQuota.sevenDay.remainingPct}%`);
  }
  if (contact.backend === 'grok-cli') {
    if (grokQuota?.available && grokQuota.weekly) {
      // 订阅是 Grok 全产品共享周池：Chat/Imagine/Build 都从这一份里扣
      quotaBits.push(`周池剩${grokQuota.weekly.remainingPct}%`);
      if (grokQuota.weekly.resetsAt) {
        // 全站按上海时间显示，别跟着设备时区跑
        const reset = new Intl.DateTimeFormat('zh-CN', {
          timeZone: DISPLAY_TIME_ZONE,
          month: 'numeric',
          day: 'numeric',
        }).format(new Date(grokQuota.weekly.resetsAt));
        quotaBits.push(`${reset}重置`);
      }
    } else if (grokQuota?.reason === 'login-expired') {
      quotaBits.push('额度不可用：grok 登录过期');
    } else if (grokQuota?.reason === 'no-token') {
      quotaBits.push('额度不可用：VPS 没有 grok 登录态');
    }
  }
  if (usage && (usage.today.input > 0 || usage.today.output > 0)) {
    quotaBits.push(`本轮 ${fmtTokens(usage.last.input)}↑ ${fmtTokens(usage.last.output)}↓`);
    if (usage.last.cacheRead > 0 || usage.last.cacheCreation > 0) {
      quotaBits.push(`缓存 ${fmtTokens(usage.last.cacheRead)}读 ${fmtTokens(usage.last.cacheCreation)}建`);
    }
    quotaBits.push(`今日 ${fmtTokens(usage.today.input)}↑ ${fmtTokens(usage.today.output)}↓`);
  }
  const tokenSummary = quotaBits.join(' · ');
  const showTokenDetail = !st && tokenSummary.length > 0;
  const quotaRows: { label: string; value: string; note?: string }[] = [];
  if (contact.backend === 'claude-cli') {
    if (quota?.available) {
      if (quota.fiveHour) {
        quotaRows.push({
          label: 'Claude 5 小时窗口',
          value: `剩余 ${quota.fiveHour.remainingPct}%`,
          note: fmtQuotaReset(quota.fiveHour.resetsAt),
        });
      }
      if (quota.sevenDay) {
        quotaRows.push({
          label: 'Claude 7 天窗口',
          value: `剩余 ${quota.sevenDay.remainingPct}%`,
          note: fmtQuotaReset(quota.sevenDay.resetsAt),
        });
      }
    } else if (quota?.reason) {
      quotaRows.push({ label: 'Claude 额度', value: quotaBits[0] ?? '额度不可用' });
    }
  }
  if (contact.backend === 'codex' && codexQuota?.available) {
    if (codexQuota.fiveHour) {
      quotaRows.push({
        label: 'Codex 5 小时窗口',
        value: `剩余 ${codexQuota.fiveHour.remainingPct}%`,
        note: fmtQuotaReset(codexQuota.fiveHour.resetsAt),
      });
    }
    if (codexQuota.sevenDay) {
      quotaRows.push({
        label: 'Codex 7 天窗口',
        value: `剩余 ${codexQuota.sevenDay.remainingPct}%`,
        note: fmtQuotaReset(codexQuota.sevenDay.resetsAt),
      });
    }
  }
  if (contact.backend === 'grok-cli') {
    if (grokQuota?.available && grokQuota.weekly) {
      quotaRows.push({
        label: 'Grok 周池',
        value: `剩余 ${grokQuota.weekly.remainingPct}%`,
        note: fmtQuotaReset(grokQuota.weekly.resetsAt),
      });
    } else if (grokQuota?.reason) {
      quotaRows.push({ label: 'Grok 额度', value: quotaBits[0] ?? '额度不可用' });
    }
  }
  return (
    <main className="chat-pane">
      <header className="chat-header">
        <button className="back-btn" onClick={onBack}>
          ←
        </button>
        <span className="avatar" style={{ background: contact.color + '33' }}>
          {contact.avatar}
        </span>
        <div className="chat-title">
          <span style={{ color: contact.color }}>{contact.name}</span>
          <div className="token-detail-wrap" ref={tokenDetailRef}>
            {showTokenDetail ? (
              <button
                type="button"
                className="chat-status token-status-btn"
                aria-expanded={tokenDetailOpen}
                onClick={() => setTokenDetailOpen((open) => !open)}
              >
                {tokenSummary}
              </button>
            ) : (
              <span className="chat-status">{st}</span>
            )}
            {showTokenDetail && tokenDetailOpen && (
              <div className="token-detail-popover" role="dialog" aria-label="Token 消耗详情">
                <div className="token-detail-head">
                  <b>Token 详情</b>
                  <button type="button" className="modal-close" onClick={() => setTokenDetailOpen(false)}>
                    关闭
                  </button>
                </div>
                <div className="token-detail-body">
                  {usage && (
                    <>
                      <div className="token-detail-section">
                        <b>本轮</b>
                        <span>{fmtFullTokens(usage.last.input)} 输入 · {fmtFullTokens(usage.last.output)} 输出</span>
                        <small>{fmtFullTokens(usage.last.cacheRead)} 缓存读 · {fmtFullTokens(usage.last.cacheCreation)} 缓存建</small>
                      </div>
                      <div className="token-detail-section">
                        <b>今日</b>
                        <span>{fmtFullTokens(usage.today.input)} 输入 · {fmtFullTokens(usage.today.output)} 输出</span>
                        <small>{fmtFullTokens(usage.today.cacheRead)} 缓存读 · {fmtFullTokens(usage.today.cacheCreation)} 缓存建</small>
                      </div>
                    </>
                  )}
                  {quotaRows.length > 0 && (
                    <div className="token-detail-section">
                      <b>额度窗口</b>
                      {quotaRows.map((row) => (
                        <span key={row.label}>
                          {row.label}：{row.value}
                          {row.note ? <small>{row.note}</small> : null}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        {busy && (
          <button className="interrupt-btn" onClick={() => void api.interrupt(contact.id)}>
            ⏹ 打断
          </button>
        )}
        {!isRoom && modelCatalog && modelCatalog.models.length > 0 && (
          <select
            className="model-select"
            title={modelCatalog.warning ?? '切换模型会开启新的底层会话，并自动衔接近期聊天'}
            aria-label="切换模型"
            value={modelCatalog.current}
            disabled={busy || switchingModel}
            onChange={(e) => void switchModel(e.target.value)}
          >
            {modelCatalog.models.map((model) => (
              <option key={model.id || '__default'} value={model.id} title={model.description}>
                {model.label}
              </option>
            ))}
          </select>
        )}
        {!isRoom && modelCatalog?.efforts && modelCatalog.efforts.length > 0 && (
          <select
            className="model-select"
            title="推理强度：切换会开启新的底层会话，并自动衔接近期聊天"
            aria-label="切换推理强度"
            value={modelCatalog.currentEffort ?? ''}
            disabled={busy || switchingModel}
            onChange={(e) => void switchEffort(e.target.value)}
          >
            {modelCatalog.efforts.map((effort) => (
              <option key={effort.id || '__default'} value={effort.id}>
                {effort.label}
              </option>
            ))}
          </select>
        )}
        <button
          className={'bulk-tool-btn' + (bulkMessageMode ? ' active' : '')}
          title="批量选择消息气泡"
          onClick={toggleBulkMessageMode}
          disabled={bulkMessages.length === 0 || bulkDeleting}
        >
          批量消息
        </button>
        <button className="gear-btn" title="联系人设置" onClick={onSettings}>
          ⚙
        </button>
      </header>

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

      <div className="message-scroll" ref={scrollRef} onScroll={onScroll}>
        {messages.length >= 50 && (
          <button className="load-earlier" onClick={onLoadEarlier}>
            加载更早的
          </button>
        )}
        {messages.map((m) => (
          <Fragment key={m.id}>
            {editing && editing.id === m.id ? (
              <div className="edit-box">
                <textarea
                  autoFocus
                  rows={3}
                  value={editing.draft}
                  onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                />
                <div className="edit-actions">
                  <button className="ghost-btn" onClick={() => setEditing(null)}>
                    取消
                  </button>
                  <button className="primary-btn" onClick={() => void saveEdit()}>
                    保存并重新生成
                  </button>
                </div>
              </div>
            ) : (
              <MessageBubble
                message={m}
                contact={senderContactOf(m)}
                showName={isRoom && m.sender !== 'user' ? senderContactOf(m).name : undefined}
                allowRegen={!isRoom}
                user={user}
                selected={selectedMsg === m.id}
                bulkMessageMode={bulkMessageMode}
                bulkSelected={bulkMessageIds.has(m.id)}
                onSelect={setSelectedMsg}
                onBulkMessageToggle={toggleBulkMessage}
                onEdit={(msg) => {
                  setEditing({ id: msg.id, draft: msg.content });
                  setSelectedMsg(null);
                }}
                onResend={(msg) => void resend(msg)}
                onDelete={(msg) => void remove(msg)}
                onOpenExternalLink={openExternalView}
              />
            )}
            {(jobAnchors.byMessage.get(m.id) ?? []).map((job) => (
              <JobThread key={job.id} job={job} onChanged={loadJobs} />
            ))}
          </Fragment>
        ))}
        {jobAnchors.loose.map((job) => (
          <JobThread key={job.id} job={job} onChanged={loadJobs} />
        ))}
        {status.state === 'thinking' && (
          <div className="typing-hint">
            {statusText(status, { isRoom, contactName: contact.name })}
          </div>
        )}
      </div>

      {sendError && <div className="send-error">操作失败：{sendError}</div>}

      <ImagePreviewStrip images={pendingImages} onRemove={removeImage} />

      <footer className="composer">
        {canSendImages && (
          <ImageAttachButton
            disabled={sending || pendingImages.length >= maxImages}
            onAdd={addComposerImages}
          />
        )}
        <textarea
          value={draft}
          placeholder={`发给 ${contact.name}…`}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            if (!canSendImages) return;
            const images = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith('image/'));
            if (images.length > 0) {
              e.preventDefault();
              addComposerImages(images);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              if (window.matchMedia('(min-width: 768px)').matches) {
                e.preventDefault();
                void send();
              }
            }
          }}
        />
        <button className="send-btn" onClick={() => void send()} disabled={sending || (!draft.trim() && pendingImages.length === 0)}>
          {sending ? '…' : '➤'}
        </button>
      </footer>
      {externalLink && <ExternalLinkViewer view={externalLink} onClose={closeExternalView} />}
    </main>
  );
}
