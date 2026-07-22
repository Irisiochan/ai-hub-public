import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Contact, Message, UserProfile } from '../api';
import { shouldOpenInExternalView } from '../externalLinks';
import { withBase } from '../mobileShell';

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
}: Props) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const mine = message.sender === 'user';
  const edited = message.meta?.includes('"edited"');
  const selectMessage = () => {
    if (bulkMessageMode) onBulkMessageToggle?.(message.id);
    else onSelect(selected ? null : message.id);
  };
  const bulkClass = bulkMessageMode
    ? ` bulk-selectable${bulkSelected ? ' bulk-selected' : ''}`
    : '';
  const bulkMark = bulkMessageMode && (
    <span className="tool-select-mark" aria-hidden="true">{bulkSelected ? '✓' : ''}</span>
  );

  const actions = selected && (
    <div className={`msg-actions ${mine ? 'mine' : ''}`}>
      {mine && message.kind === 'text' && allowRegen && (
        <>
          <button onClick={() => onEdit(message)}>✎ 编辑</button>
          <button onClick={() => onResend(message)}>🔄 重新生成</button>
        </>
      )}
      <button className="del" onClick={() => onDelete(message)}>
        🗑 删除
      </button>
    </div>
  );

  if (message.kind === 'tool_use') {
    return (
      <div className="msg-group">
        <button
          type="button"
          className={`tool-chip${bulkClass}`}
          title={safeMeta(message.meta)}
          aria-pressed={bulkMessageMode ? bulkSelected : undefined}
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
      <div className="msg-group center">
        <button
          type="button"
          className={`error-note bulk-message-control${bulkClass}`}
          aria-pressed={bulkMessageMode ? bulkSelected : undefined}
          onClick={selectMessage}
        >
          {bulkMark}<span>⚠ {message.content}</span>
        </button>
        {actions}
      </div>
    );
  }

  if (message.kind === 'thinking') {
    if (!message.content && message.status !== 'streaming') return null;
    return (
      <div className="msg-group">
        <div className="thinking-block">
          <button
            className={`thinking-toggle${bulkClass}`}
            aria-pressed={bulkMessageMode ? bulkSelected : undefined}
            onClick={() => {
              if (bulkMessageMode) {
                onBulkMessageToggle?.(message.id);
                return;
              }
              setThinkingOpen(!thinkingOpen);
              onSelect(selected ? null : message.id);
            }}
          >
            {bulkMark}<span>💭 {thinkingOpen ? '收起想法' : '想法'}</span>
            {message.status === 'streaming' && <span className="cursor">▍</span>}
          </button>
          {thinkingOpen && <div className="thinking-content">{message.content}</div>}
        </div>
        {actions}
      </div>
    );
  }

  return (
    <div className="msg-group">
      {showName && <span className="sender-name">{showName}</span>}
      <div className={`bubble-row ${mine ? 'mine' : 'theirs'}`}>
        {!mine && (
          <span className="avatar bubble-avatar" style={{ background: contact.color + '33' }}>
            {contact.avatar}
          </span>
        )}
        <div
          className={`bubble ${mine ? 'bubble-mine' : 'bubble-theirs'} ${
            message.status === 'interrupted' ? 'interrupted' : ''
          }${bulkClass}`}
          style={mine ? { background: user.color } : undefined}
          role={bulkMessageMode ? 'button' : undefined}
          aria-pressed={bulkMessageMode ? bulkSelected : undefined}
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
          {edited && <span className="edited-tag">（已编辑）</span>}
        </div>
        {mine && (
          <span className="avatar bubble-avatar" style={{ background: user.color + '33' }}>
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
