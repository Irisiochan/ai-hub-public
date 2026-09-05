import { useEffect, useRef } from 'react';
import { ImageAttachButton, ImagePreviewStrip, type PendingImage } from '../ImageComposer';
import { Icon } from '../icons';

interface Props {
  contactName: string;
  draft: string;
  sending: boolean;
  /** 这一轮还在跑：发送键原地变成打断键（方案 1b） */
  busy: boolean;
  canSendImages: boolean;
  pendingImages: PendingImage[];
  maxImages: number;
  /** 递增一次就聚焦输入框并把光标移到末尾（副窗引用回来时用） */
  focusSignal?: number;
  onDraft(value: string): void;
  onAddImages(files: File[]): void;
  onRemoveImage(index: number): void;
  onSend(): void;
  onInterrupt(): void;
}

export default function Composer(props: Props) {
  const {
    contactName,
    draft,
    sending,
    busy,
    canSendImages,
    pendingImages,
    maxImages,
    focusSignal,
    onDraft,
    onAddImages,
    onRemoveImage,
    onSend,
    onInterrupt,
  } = props;
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!focusSignal) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
  }, [focusSignal]);

  return (
    <div className={`composer-shell${pendingImages.length > 0 ? ' has-attachments' : ''}`}>
      <ImagePreviewStrip images={pendingImages} onRemove={onRemoveImage} />
      <footer className="composer">
        {canSendImages && (
          <ImageAttachButton disabled={sending || pendingImages.length >= maxImages} onAdd={onAddImages} />
        )}
        <textarea
          ref={inputRef}
          value={draft}
          placeholder={`发给 ${contactName}…`}
          rows={1}
          onChange={(event) => onDraft(event.target.value)}
          onPaste={(event) => {
            if (!canSendImages) return;
            const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
            if (images.length > 0) {
              event.preventDefault();
              onAddImages(images);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              window.matchMedia('(min-width: 768px)').matches
            ) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <button
          className={`send-btn${busy ? ' stop' : ''}`}
          data-control-state={busy ? 'stop' : 'send'}
          title={busy ? '打断这一轮' : undefined}
          aria-label={busy ? '打断这一轮' : sending ? '发送中' : '发送消息'}
          onClick={busy ? onInterrupt : onSend}
          disabled={!busy && (sending || (!draft.trim() && pendingImages.length === 0))}
        >
          <Icon name={busy ? 'stop' : 'send'} size={24} />
        </button>
      </footer>
    </div>
  );
}
