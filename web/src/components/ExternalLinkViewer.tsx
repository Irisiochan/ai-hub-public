import { useEffect, useState } from 'react';
import type { ExternalLinkView } from '../externalLinks';

interface Props {
  view: ExternalLinkView;
  onClose(): void;
}

export default function ExternalLinkViewer({ view, onClose }: Props) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [view.url]);

  return (
    <div className="external-viewer" role="dialog" aria-modal="true" aria-label="外部链接">
      <header className="external-viewer-bar">
        <button className="external-close" onClick={onClose} autoFocus>
          ← 回到聊天
        </button>
        <div className="external-url" title={view.url}>
          {view.url}
        </div>
        <a className="external-open" href={view.url} target="_blank" rel="noreferrer">
          新窗口打开
        </a>
      </header>
      {failed && <div className="external-error">页面加载失败，但可以直接返回聊天。</div>}
      <iframe
        key={view.url}
        className="external-frame"
        src={view.url}
        title="外部链接内容"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
