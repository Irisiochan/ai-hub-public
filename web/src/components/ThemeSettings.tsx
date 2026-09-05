import { useState, useSyncExternalStore, type CSSProperties, type ChangeEvent } from 'react';
import {
  exportCurrentTheme,
  getThemeSnapshot,
  importThemePackage,
  MAX_THEME_PACKAGE_BYTES,
  selectTheme,
  setThemeMode,
  subscribeTheme,
} from '../theme/store';
import type { ThemeManifest, ThemeMode } from '../theme/schema';

function bubbleBackground(
  gradient: ThemeManifest['variants']['dark']['bubbles']['outgoingGradient'],
  fallback: string,
): string {
  return gradient.enabled ? `linear-gradient(${gradient.angle}deg, ${gradient.from}, ${gradient.to})` : fallback;
}

function ThemePreview({ theme, mode }: { theme: ThemeManifest; mode: 'light' | 'dark' }) {
  const variant = theme.variants[mode];
  const style = {
    '--preview-canvas': variant.surfaces.canvas,
    '--preview-panel': variant.surfaces.panel,
    '--preview-accent': variant.primary.accent,
    '--preview-incoming': bubbleBackground(variant.bubbles.incomingGradient, variant.bubbles.incoming),
    '--preview-outgoing': bubbleBackground(variant.bubbles.outgoingGradient, variant.bubbles.outgoing),
  } as CSSProperties;
  return (
    <span className="theme-preview" style={style} aria-hidden="true">
      <span className="theme-preview-rail" />
      <span className="theme-preview-chat">
        <span className="theme-preview-bubble incoming" />
        <span className="theme-preview-bubble outgoing" />
      </span>
    </span>
  );
}

export default function ThemeSettings() {
  const snapshot = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chooseMode = (nextMode: ThemeMode) => {
    setThemeMode(nextMode);
    setError(null);
    setNotice(null);
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    setNotice(null);
    try {
      if (file.size > MAX_THEME_PACKAGE_BYTES) throw new Error('主题包超过 128 KiB');
      const theme = importThemePackage(await file.text());
      setNotice(`已导入并切换到「${theme.name}」`);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const exportTheme = () => {
    const source = exportCurrentTheme();
    const active = snapshot.themes.find((theme) => theme.id === snapshot.selectedId)!;
    const url = URL.createObjectURL(new Blob([source], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${active.id}.ai-hub-theme.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setError(null);
    setNotice(`已导出「${active.name}」`);
  };

  return (
    <section className="theme-settings-card" aria-labelledby="theme-settings-title">
      <div className="theme-settings-head">
        <span>
          <strong id="theme-settings-title">主题</strong>
          <small>只替换语义色与内置壁纸，不执行主题包中的样式或脚本。</small>
        </span>
        <span className="theme-mode" aria-label="明暗模式">
          {([['light', '亮色'], ['dark', '暗色'], ['system', '跟随系统']] as const).map(([value, label]) => (
            <button
              type="button"
              className={snapshot.mode === value ? 'selected' : ''}
              aria-pressed={snapshot.mode === value}
              onClick={() => chooseMode(value)}
              key={value}
            >
              {label}
            </button>
          ))}
        </span>
      </div>
      <div className="theme-list">
        {snapshot.themes.map((theme) => (
          <button
            type="button"
            className={`theme-card${theme.id === snapshot.selectedId ? ' selected' : ''}`}
            aria-pressed={theme.id === snapshot.selectedId}
            onClick={() => {
              selectTheme(theme.id);
              setError(null);
              setNotice(`已切换到「${theme.name}」`);
            }}
            key={theme.id}
          >
            <ThemePreview theme={theme} mode={snapshot.effectiveMode} />
            <span className="theme-card-copy">
              <b>{theme.name}</b>
              <small>{theme.description}</small>
              <em>{theme.wallpaperAttribution.source} · {theme.wallpaperAttribution.license}</em>
            </span>
            <span className="theme-selected-mark">{theme.id === snapshot.selectedId ? '使用中' : '选择'}</span>
          </button>
        ))}
      </div>
      <div className="theme-package-actions">
        <label className="ghost-btn theme-file-button">
          导入 JSON 主题包
          <input type="file" accept="application/json,.json" onChange={(event) => void importFile(event)} />
        </label>
        <button type="button" className="ghost-btn" onClick={exportTheme}>导出当前主题</button>
        <small>ThemeManifest v1 · 最大 128 KiB · 未知字段会被拒绝</small>
      </div>
      {notice && <div className="theme-notice" role="status">{notice}</div>}
      {error && <div className="modal-error" role="alert">{error}</div>}
    </section>
  );
}
