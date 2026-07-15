import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type ClaudeQuota,
  type CodexQuota,
  type Contact,
  type ContactStatus,
  type Message,
  type ModelCatalog,
  type Usage,
  type UserProfile,
  type WorkerJob,
} from '../api';
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

function statusText(status: ContactStatus): string {
  const who = status.member ? `${status.member} ` : '';
  if (status.state === 'thinking') return `${who}思考中…`;
  if (status.state === 'streaming') return `${who}正在输入…`;
  if (status.state.startsWith('tool:')) return `${who}正在用 ${status.state.slice(5)}`;
  if (status.state === 'error') return '出错了，可以再试一次或重置会话';
  return '';
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function ChatPane({ contact, contacts, messages, status, user, onBack, onLoadEarlier, onSettings }: Props) {
  const isRoom = contact.kind === 'room';
  const senderContactOf = (m: Message): Contact =>
    m.sender === 'user' ? contact : contacts.find((c) => c.id === m.sender) ?? contact;
  const [draft, setDraft] = useState('');
  const [pendingImages, setPendingImages] = useState<Array<{ file: File; url: string }>>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [selectedMsg, setSelectedMsg] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ id: number; draft: string } | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [quota, setQuota] = useState<ClaudeQuota | null>(null);
  const [codexQuota, setCodexQuota] = useState<CodexQuota | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [jobs, setJobs] = useState<WorkerJob[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const jobsRef = useRef<WorkerJob[]>([]);
  jobsRef.current = jobs;

  const delegationEnabled = !!(contact.config.delegation as { enabled?: boolean } | undefined)?.enabled;

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

  const canSendImages = contact.backend === 'api' || isRoom;

  const addImages = (files: File[]) => {
    setSendError(null);
    const accepted = files.filter((file) => {
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
        setSendError('只支持 JPEG、PNG、WebP、GIF 图片');
        return false;
      }
      if (file.size > 10 * 1024 * 1024) {
        setSendError('单张图片不能超过 10 MB');
        return false;
      }
      return true;
    });
    setPendingImages((current) => {
      const room = Math.max(4 - current.length, 0);
      if (accepted.length > room) setSendError('每条消息最多 4 张图片');
      return [...current, ...accepted.slice(0, room).map((file) => ({ file, url: URL.createObjectURL(file) }))];
    });
  };

  const clearImages = () => {
    setPendingImages((current) => {
      current.forEach((image) => URL.revokeObjectURL(image.url));
      return [];
    });
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, contact.id]);

  // usage/quota：切联系人时拉一次，回合结束（idle）再刷新
  useEffect(() => {
    setUsage(null);
    setQuota(null);
    setCodexQuota(null);
    void api.usage(contact.id).then(setUsage).catch(() => {});
    if (contact.backend === 'claude-cli') {
      void api.claudeQuota().then(setQuota).catch(() => {});
    } else if (contact.backend === 'codex') {
      void api.codexQuota().then(setCodexQuota).catch(() => {});
    }
    setSelectedMsg(null);
    setEditing(null);
    clearImages();
    setDraft('');
  }, [contact.id, contact.backend]);

  useEffect(() => {
    setModelCatalog(null);
    if (isRoom) return;
    // During a rolling deploy the new frontend can briefly meet the old gateway.
    // Hide the picker until the models endpoint is available instead of surfacing a noisy 404.
    void api.models(contact.id).then(setModelCatalog).catch(() => {});
  }, [contact.id, contact.backend, contact.config.model, isRoom]);

  useEffect(() => {
    if (status.state === 'idle') {
      void api.usage(contact.id).then(setUsage).catch(() => {});
      if (contact.backend === 'claude-cli') {
        void api.claudeQuota().then(setQuota).catch(() => {});
      } else if (contact.backend === 'codex') {
        void api.codexQuota().then(setCodexQuota).catch(() => {});
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
      await api.send(contact.id, content, pendingImages.map((image) => image.file));
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

  const busy =
    status.state === 'thinking' || status.state === 'streaming' || status.state.startsWith('tool:');
  const st = statusText(status);

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
  if (usage && (usage.today.input > 0 || usage.today.output > 0)) {
    quotaBits.push(`本轮 ${fmtTokens(usage.last.input)}↑ ${fmtTokens(usage.last.output)}↓`);
    if (usage.last.cacheRead > 0 || usage.last.cacheCreation > 0) {
      quotaBits.push(`缓存 ${fmtTokens(usage.last.cacheRead)}读 ${fmtTokens(usage.last.cacheCreation)}建`);
    }
    quotaBits.push(`今日 ${fmtTokens(usage.today.input)}↑ ${fmtTokens(usage.today.output)}↓`);
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
          <span className="chat-status">{st || quotaBits.join(' · ')}</span>
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
        <button className="gear-btn" title="联系人设置" onClick={onSettings}>
          ⚙
        </button>
      </header>

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
                onSelect={setSelectedMsg}
                onEdit={(msg) => {
                  setEditing({ id: msg.id, draft: msg.content });
                  setSelectedMsg(null);
                }}
                onResend={(msg) => void resend(msg)}
                onDelete={(msg) => void remove(msg)}
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
            {status.member ?? contact.name} 思考中…
          </div>
        )}
      </div>

      {sendError && <div className="send-error">操作失败：{sendError}</div>}

      {pendingImages.length > 0 && (
        <div className="image-preview-strip">
          {pendingImages.map((image, index) => (
            <div className="image-preview" key={`${image.file.name}-${image.url}`}>
              <img src={image.url} alt={image.file.name} />
              <button
                type="button"
                aria-label={`移除 ${image.file.name}`}
                onClick={() => setPendingImages((current) => {
                  URL.revokeObjectURL(current[index].url);
                  return current.filter((_, i) => i !== index);
                })}
              >
                ×
              </button>
            </div>
          ))}
          <span className="image-privacy-note">图片会发送给目标 API 模型；可能含 EXIF、订单或密钥信息，请先确认。</span>
        </div>
      )}

      <footer className="composer">
        {canSendImages && (
          <>
            <input
              ref={imageInputRef}
              className="image-input"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              onChange={(e) => {
                addImages(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <button
              className="attach-btn"
              type="button"
              title="添加图片（最多 4 张，每张 10 MB）"
              disabled={sending || pendingImages.length >= 4}
              onClick={() => imageInputRef.current?.click()}
            >
              ＋
            </button>
          </>
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
              addImages(images);
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
    </main>
  );
}
