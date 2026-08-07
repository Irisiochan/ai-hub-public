import { isValidElement, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Contact, Message, UserProfile } from '../api';
import { shouldOpenInExternalView } from '../externalLinks';
import { withBase } from '../mobileShell';
import { effectiveMessageOrigin, isManualUserMessage } from '../messageSource.ts';
import { outputLimitWarning } from '../messageWarnings';
import { sideSourceLabel, type QuoteMode } from '../sideQuote';
import { formatMessageTimestamp } from '../time';

/** 方案 1b：代码块带工具栏（语言 · 复制 · 折叠），样式见 styles.css §2 .code-card */
function CodeCard({ children }: { children?: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  let lang = '';
  const first = Array.isArray(children) ? children[0] : children;
  if (isValidElement(first)) {
    const className = (first.props as { className?: string }).className ?? '';
    const match = /language-([\w+-]+)/.exec(className);
    if (match) lang = match[1].toUpperCase();
  }

  const copy = () => {
    const text = preRef.current?.innerText ?? '';
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  };

  return (
    <div className="code-card" data-collapsed={collapsed ? 'true' : 'false'}>
      <div className="code-card-bar">
        <span className="code-lang">{lang || 'CODE'}</span>
        <span className="spacer" />
        <button
          type="button"
          className="code-act primary"
          onClick={(event) => {
            event.stopPropagation();
            copy();
          }}
        >
          {copied ? '已复制' : '⧉ 复制'}
        </button>
        <button
          type="button"
          className="code-act"
          onClick={(event) => {
            event.stopPropagation();
            setCollapsed((value) => !value);
          }}
        >
          {collapsed ? '展开' : '折叠'}
        </button>
      </div>
      <pre ref={preRef}>{children}</pre>
    </div>
  );
}

interface Props {
  message: Message;
  contact: Contact; // 发言人（群里是成员，DM 里就是会话联系人）
  showName?: string; // 群聊里气泡上方的发言人名字
  allowRegen?: boolean; // 群聊 v1 不支持编辑/重新生成
  user: UserProfile;
  selected: boolean;
  bulkMessageMode?: boolean;
  bulkSelected?: boolean;
  onSelect(id: number | null): void;
  onBulkMessageToggle?(id: number): void;
  onEdit(m: Message): void;
  onResend(m: Message): void;
  onDelete(m: Message): void;
  onOpenExternalLink(url: string): void;
  /** 只有副窗的正文消息拿得到；给了就在操作条里露出引用按钮 */
  onQuoteToMain?(m: Message, mode: QuoteMode): void;
}

export default function MessageBubble({
  message,
  contact,
  showName,
  allowRegen = true,
  user,
  selected,
  bulkMessageMode = false,
  bulkSelected = false,
  onSelect,
  onBulkMessageToggle,
  onEdit,
  onResend,
  onDelete,
  onOpenExternalLink,
  onQuoteToMain,
}: Props) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const mine = isManualUserMessage(message);
  const effectiveOrigin = effectiveMessageOrigin(message);
  const edited = message.meta?.includes('"edited"');
  const outputWarning = outputLimitWarning(message.meta);
  const selectMessage = () => {
    if (bulkMessageMode) onBulkMessageToggle?.(message.id);
    else onSelect(selected ? null : message.id);
  };
  const bulkClass = bulkMessageMode ? ` bulk-selectable${bulkSelected ? ' bulk-selected' : ''}` : '';
  const bulkMark = bulkMessageMode && (
    <span className="tool-select-mark" aria-hidden="true">
      {bulkSelected ? '✓' : ''}
    </span>
  );

  // 动作条常驻 DOM：桌面 hover / 触屏点选消息后由 CSS 淡入；默认隐藏
  const groupClass = `msg-group${selected && !bulkMessageMode ? ' selected' : ''}`;
  const stopAction = (event: MouseEvent, action: () => void) => {
    event.stopPropagation();
    action();
  };
  const actions = (
    <div className={`msg-actions ${mine ? 'mine' : ''}`}>
      <time
        className="msg-time"
        dateTime={message.created_at}
        title={formatMessageTimestamp(message.created_at)}
        aria-label={`发送时间 ${formatMessageTimestamp(message.created_at)}`}
      >
        {formatMessageTimestamp(message.created_at)}
      </time>
      {mine && message.kind === 'text' && allowRegen && (
        <>
          <button type="button" onClick={(event) => stopAction(event, () => onEdit(message))}>
            ✎ 编辑
          </button>
          <button type="button" onClick={(event) => stopAction(event, () => onResend(message))}>
            🔄 重新生成
          </button>
        </>
      )}
      {onQuoteToMain && (
        <>
          <button type="button" onClick={(event) => stopAction(event, () => onQuoteToMain(message, 'full'))}>
            ⤴ 引原文
          </button>
          <button type="button" onClick={(event) => stopAction(event, () => onQuoteToMain(message, 'digest'))}>
            ⤴ 引摘要
          </button>
        </>
      )}
      <button type="button" className="del" onClick={(event) => stopAction(event, () => onDelete(message))}>
        🗑 删除
      </button>
    </div>
  );

  if (effectiveOrigin === 'side' && message.role !== 'assistant' && message.kind === 'text') {
    const long = message.content.length > 360;
    const body = systemOpen || !long ? message.content : `${message.content.slice(0, 360)}…`;
    return (
      <div className={`${groupClass} center`}>
        <div
          className={`side-system-card${bulkClass}`}
          role="button"
          aria-pressed={bulkMessageMode ? bulkSelected : selected}
          onClick={selectMessage}
        >
          <div className="side-system-head">
            {bulkMark}
            <span>{sideSourceLabel(message)}</span>
          </div>
          <pre>{body}</pre>
          {long && !bulkMessageMode && (
            <button
              type="button"
              className="side-expand-btn"
              onClick={(event) => {
                event.stopPropagation();
                setSystemOpen((open) => !open);
              }}
            >
              {systemOpen ? '收起原文' : '展开原文'}
            </button>
          )}
        </div>
        {actions}
      </div>
    );
  }

  if (message.kind === 'tool_use') {
    return (
      <div className={groupClass}>
        <button
          type="button"
          className={`tool-chip${bulkClass}`}
          title={safeMeta(message.meta)}
          aria-pressed={bulkMessageMode ? bulkSelected : selected}
          onClick={selectMessage}
        >
          {bulkMark}
          <span>🔧 {message.content}</span>
        </button>
        {actions}
      </div>
    );
  }

  if (message.kind === 'error') {
    return (
      <div className={`${groupClass} center`}>
        <button
          type="button"
          className={`error-note bulk-message-control${bulkClass}`}
          aria-pressed={bulkMessageMode ? bulkSelected : selected}
          onClick={selectMessage}
        >
          {bulkMark}
          <span>⚠ {message.content}</span>
        </button>
        {actions}
      </div>
    );
  }

  if (message.kind === 'thinking') {
    if (!message.content && message.status !== 'streaming') return null;
    return (
      <div className={groupClass}>
        <div className="thinking-block">
          <button
            type="button"
            className={`thinking-toggle${bulkClass}`}
            aria-pressed={bulkMessageMode ? bulkSelected : selected}
            onClick={() => {
              if (bulkMessageMode) {
                onBulkMessageToggle?.(message.id);
                return;
              }
              setThinkingOpen(!thinkingOpen);
              onSelect(selected ? null : message.id);
            }}
          >
            {bulkMark}
            <span>💭 {thinkingOpen ? '收起想法' : '想法'}</span>
            {message.status === 'streaming' && <span className="cursor">▍</span>}
          </button>
          {thinkingOpen && <div className="thinking-content">{message.content}</div>}
        </div>
        {actions}
      </div>
    );
  }

  return (
    <div className={groupClass}>
      {showName && <span className="sender-name">{showName}</span>}
      <div className={`bubble-row ${mine ? 'mine' : 'theirs'}`}>
        {!mine && (
          <span className="avatar bubble-avatar" style={{ boxShadow: `inset 0 0 0 1.5px ${contact.color}55` }}>
            {contact.avatar}
          </span>
        )}
        <div
          className={`bubble ${mine ? 'bubble-mine' : 'bubble-theirs'} ${
            message.status === 'interrupted' ? 'interrupted' : ''
          }${bulkClass}`}
          role="button"
          aria-pressed={bulkMessageMode ? bulkSelected : selected}
          onClick={selectMessage}
        >
          {bulkMark}
          {(message.attachments ?? []).length > 0 && (
            <div className="message-images">
              {message.attachments!.map((attachment) => (
                <a
                  key={attachment.id}
                  href={withBase(attachment.url)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  <img src={withBase(attachment.url)} alt={attachment.name} loading="lazy" />
                </a>
              ))}
            </div>
          )}
          <div className="markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                pre: ({ children }) => <CodeCard>{children}</CodeCard>,
                a: ({ href, children, ...anchorProps }) => (
                  <a
                    {...anchorProps}
                    href={href}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (shouldOpenInExternalView(href, window.location.href)) {
                        event.preventDefault();
                        onOpenExternalLink(new URL(href!, window.location.href).href);
                      }
                    }}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
          {message.status === 'streaming' && <span className="cursor">▍</span>}
          {message.status === 'interrupted' && <span className="interrupted-tag">（被打断）</span>}
          {outputWarning && <span className="length-limit-tag">⚠ {outputWarning}</span>}
          {edited && <span className="edited-tag">（已编辑）</span>}
        </div>

        {mine && (
          <span className="avatar bubble-avatar" style={{ boxShadow: `inset 0 0 0 1.5px ${user.color}55` }}>
            {user.avatar}
          </span>
        )}
      </div>
      {actions}
    </div>
  );
}

function safeMeta(meta: string): string {
  try {
    const m = JSON.parse(meta);
    return m.input ?? '';
  } catch {
    return '';
  }
}
