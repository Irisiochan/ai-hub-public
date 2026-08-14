import { useEffect, useState } from 'react';
import {
  type Contact,
  type ContactStatus,
} from '../../api';
import { statusText } from '../../statusText';

interface Props {
  contact: Contact;
  status: ContactStatus;
  runtimeOpen: boolean;
  onBack(): void;
  onToggleRuntime(): void;
}

/**
 * 方案 1b：header 只剩「返回 · 名字 · 状态点 · 运行时」。
 * 模型、推理强度、批量、额度、token、联系人设置全部搬进 RuntimeDrawer；
 * 打断挪到 Composer 的发送键位（.send-btn.stop）。
 */
export default function ChatHeader(props: Props) {
  const { contact, status } = props;
  const isRoom = contact.kind === 'room';
  const busy =
    status.state === 'thinking' || status.state === 'streaming' || status.state.startsWith('tool:');
  const statusLabel = statusText(status, { isRoom, contactName: contact.name });
  const [flash, setFlash] = useState(false);

  // 切联系人时清掉状态点的余韵，避免上一个人的动画留在新会话上
  useEffect(() => setFlash(false), [contact.id]);
  useEffect(() => {
    if (!busy) return;
    setFlash(true);
    return () => setFlash(false);
  }, [busy]);

  return (
    <header className="chat-header">
      <button className="back-btn" onClick={props.onBack} aria-label="返回联系人列表">
        ←
      </button>
      <div className="chat-title">
        <span className="chat-title-name">
          <span>{contact.name}</span>
        </span>
        {busy || flash ? <span className="chat-state-dot" aria-hidden="true" /> : null}
        <span className="chat-status">{statusLabel}</span>
      </div>
      <div className="chat-header-controls">
        <button
          type="button"
          className={'runtime-btn' + (props.runtimeOpen ? ' open' : '')}
          aria-expanded={props.runtimeOpen}
          onClick={props.onToggleRuntime}
        >
          ⌸ 运行时
        </button>
      </div>
    </header>
  );
}
