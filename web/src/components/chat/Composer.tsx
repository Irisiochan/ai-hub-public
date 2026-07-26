import { ImageAttachButton, ImagePreviewStrip, type PendingImage } from '../ImageComposer';

interface Props {
  contactName: string;
  draft: string;
  sending: boolean;
  canSendImages: boolean;
  pendingImages: PendingImage[];
  maxImages: number;
  onDraft(value: string): void;
  onAddImages(files: File[]): void;
  onRemoveImage(index: number): void;
  onSend(): void;
}

export default function Composer(props: Props) {
  const { contactName, draft, sending, canSendImages, pendingImages, maxImages, onDraft, onAddImages, onRemoveImage, onSend } = props;
  return (
    <>
      <ImagePreviewStrip images={pendingImages} onRemove={onRemoveImage} />
      <footer className="composer">
        {canSendImages && (
          <ImageAttachButton disabled={sending || pendingImages.length >= maxImages} onAdd={onAddImages} />
        )}
        <textarea
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
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia('(min-width: 768px)').matches) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <button className="send-btn" onClick={onSend} disabled={sending || (!draft.trim() && pendingImages.length === 0)}>
          {sending ? '…' : '➤'}
        </button>
      </footer>
    </>
  );
}
