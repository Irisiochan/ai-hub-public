import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ACCEPT = IMAGE_TYPES.join(',');

export interface PendingImage {
  file: File;
  url: string;
}

export function usePendingImages(onError: (message: string) => void) {
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const imagesRef = useRef<PendingImage[]>([]);

  const addImages = useCallback((files: File[]) => {
    const accepted = files.filter((file) => {
      if (!IMAGE_TYPES.includes(file.type)) {
        onError('只支持 JPEG、PNG、WebP、GIF 图片');
        return false;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        onError('单张图片不能超过 10 MB');
        return false;
      }
      return true;
    });

    setPendingImages((current) => {
      const room = Math.max(MAX_IMAGES - current.length, 0);
      if (accepted.length > room) onError(`每条消息最多 ${MAX_IMAGES} 张图片`);
      return [
        ...current,
        ...accepted.slice(0, room).map((file) => ({ file, url: URL.createObjectURL(file) })),
      ];
    });
  }, [onError]);

  const removeImage = useCallback((index: number) => {
    setPendingImages((current) => {
      const target = current[index];
      if (target) URL.revokeObjectURL(target.url);
      return current.filter((_, i) => i !== index);
    });
  }, []);

  const clearImages = useCallback(() => {
    setPendingImages((current) => {
      current.forEach((image) => URL.revokeObjectURL(image.url));
      return [];
    });
  }, []);

  useEffect(() => {
    imagesRef.current = pendingImages;
  }, [pendingImages]);

  useEffect(() => () => {
    imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url));
  }, []);

  return {
    pendingImages,
    pendingFiles: pendingImages.map((image) => image.file),
    addImages,
    removeImage,
    clearImages,
    maxImages: MAX_IMAGES,
  };
}

interface ImagePreviewStripProps {
  images: PendingImage[];
  onRemove(index: number): void;
}

export function ImagePreviewStrip({ images, onRemove }: ImagePreviewStripProps) {
  if (images.length === 0) return null;

  return (
    <div className="image-preview-strip">
      {images.map((image, index) => (
        <div className="image-preview" key={`${image.file.name}-${image.url}`}>
          <img src={image.url} alt={image.file.name} />
          <button
            type="button"
            aria-label={`移除 ${image.file.name}`}
            onClick={() => onRemove(index)}
          >
            ×
          </button>
        </div>
      ))}
      <span className="image-privacy-note">图片会发送给目标模型；可能含 EXIF、订单或密钥信息，请先确认。</span>
    </div>
  );
}

interface ImageAttachButtonProps {
  disabled: boolean;
  onAdd(files: File[]): void;
}

export function ImageAttachButton({ disabled, onAdd }: ImageAttachButtonProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={imageInputRef}
        className="image-input"
        type="file"
        accept={ACCEPT}
        multiple
        onChange={(e) => {
          onAdd(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <button
        className="attach-btn"
        type="button"
        title={`添加图片（最多 ${MAX_IMAGES} 张，每张 10 MB）`}
        disabled={disabled}
        onClick={() => imageInputRef.current?.click()}
      >
        ＋
      </button>
    </>
  );
}
