import { BUILTIN_THEMES, DEFAULT_THEME_ID } from './builtins.ts';
import {
  formatThemeValidationError,
  importedThemeListSchema,
  parseThemeManifest,
  type ThemeManifest,
  type ThemeMode,
  type ThemeVariant,
} from './schema.ts';

const SELECTED_KEY = 'ai-hub.theme.selected.v1';
const MODE_KEY = 'ai-hub.theme.mode.v1';
const IMPORTED_KEY = 'ai-hub.theme.imported.v1';
export const MAX_THEME_PACKAGE_BYTES = 128 * 1024;

const wallpaperAssets: Record<ThemeVariant['wallpaper']['asset'], string> = {
  none: 'none',
  'violet-bloom': 'url("/themes/violet-bloom.svg")',
  'quiet-grid': 'url("/themes/quiet-grid.svg")',
};

export interface ThemeSnapshot {
  selectedId: string;
  mode: ThemeMode;
  effectiveMode: 'light' | 'dark';
  themes: readonly ThemeManifest[];
}

let importedThemes: ThemeManifest[] = [];
let selectedId = DEFAULT_THEME_ID;
let mode: ThemeMode = 'dark';
let effectiveMode: 'light' | 'dark' = 'dark';
let initialized = false;
let mediaQuery: MediaQueryList | null = null;
let snapshot: ThemeSnapshot = { selectedId, mode, effectiveMode, themes: BUILTIN_THEMES };
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function allThemes(): ThemeManifest[] {
  return [...BUILTIN_THEMES, ...importedThemes];
}

function resolveEffectiveMode(nextMode: ThemeMode): 'light' | 'dark' {
  if (nextMode !== 'system') return nextMode;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function gradient(gradientValue: ThemeVariant['bubbles']['incomingGradient'], fallback: string): string {
  return gradientValue.enabled
    ? `linear-gradient(${gradientValue.angle}deg, ${gradientValue.from}, ${gradientValue.to})`
    : fallback;
}

export function themeCssTokens(theme: ThemeManifest, variantName: 'light' | 'dark'): Record<string, string> {
  const variant = theme.variants[variantName];
  return {
    '--bg': variant.surfaces.background,
    '--bg-canvas': variant.surfaces.canvas,
    '--bg-panel': variant.surfaces.panel,
    '--bg-rail': variant.surfaces.rail,
    '--bg-elev': variant.surfaces.elevated,
    '--bg-card': variant.surfaces.card,
    '--bg-hover': variant.surfaces.hover,
    '--bg-raised': variant.surfaces.raised,
    '--bg-code': variant.surfaces.code,
    '--border': variant.borders.subtle,
    '--border-strong': variant.borders.strong,
    '--text': variant.text.primary,
    '--text-body': variant.text.body,
    '--text-dim': variant.text.dim,
    '--text-muted': variant.text.muted,
    '--accent': variant.primary.accent,
    '--accent-soft': variant.primary.soft,
    '--accent-line': variant.primary.line,
    '--accent-ink': variant.primary.ink,
    '--accent-text': variant.primary.text,
    '--accent-glow': variant.primary.glow,
    '--ok': variant.status.success,
    '--ok-soft': variant.status.successSoft,
    '--ok-line': variant.status.successLine,
    '--ok-text': variant.status.successText,
    '--error': variant.status.error,
    '--error-soft': variant.status.errorSoft,
    '--error-line': variant.status.errorLine,
    '--bubble-mine': variant.bubbles.outgoing,
    '--bubble-theirs': variant.bubbles.incoming,
    '--bubble-mine-bg': gradient(variant.bubbles.outgoingGradient, variant.bubbles.outgoing),
    '--bubble-theirs-bg': gradient(variant.bubbles.incomingGradient, variant.bubbles.incoming),
    '--bubble-mine-text': variant.bubbles.outgoingText,
    '--bubble-theirs-text': variant.bubbles.incomingText,
    '--icon': variant.icons.default,
    '--icon-muted': variant.icons.muted,
    '--icon-active': variant.icons.active,
    '--chat-wallpaper': wallpaperAssets[variant.wallpaper.asset],
    '--chat-wallpaper-color': variant.wallpaper.background,
    '--chat-wallpaper-size': variant.wallpaper.size,
  };
}

export function applyThemeManifest(theme: ThemeManifest, variantName: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const [token, value] of Object.entries(themeCssTokens(theme, variantName))) root.style.setProperty(token, value);
  root.dataset.theme = theme.id;
  root.dataset.themeVariant = variantName;
  root.dataset.themeMotion = theme.animation;
  root.style.colorScheme = variantName;
  const color = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  color?.setAttribute('content', theme.variants[variantName].surfaces.background);
}

function currentTheme(): ThemeManifest {
  return allThemes().find((theme) => theme.id === selectedId) ?? BUILTIN_THEMES[0];
}

function refresh(emit = true): void {
  effectiveMode = resolveEffectiveMode(mode);
  const themes = allThemes();
  if (!themes.some((theme) => theme.id === selectedId)) selectedId = DEFAULT_THEME_ID;
  applyThemeManifest(currentTheme(), effectiveMode);
  snapshot = { selectedId, mode, effectiveMode, themes };
  if (emit) for (const listener of listeners) listener();
}

export function initializeThemeSystem(): void {
  if (initialized) return;
  initialized = true;
  const saved = storage();
  if (saved) {
    try {
      importedThemes = importedThemeListSchema.parse(JSON.parse(saved.getItem(IMPORTED_KEY) ?? '[]'));
    } catch {
      importedThemes = [];
      saved.removeItem(IMPORTED_KEY);
    }
    const savedId = saved.getItem(SELECTED_KEY);
    if (savedId) selectedId = savedId;
    const savedMode = saved.getItem(MODE_KEY);
    if (savedMode === 'light' || savedMode === 'dark' || savedMode === 'system') mode = savedMode;
  }
  if (typeof matchMedia === 'function') {
    mediaQuery = matchMedia('(prefers-color-scheme: light)');
    mediaQuery.addEventListener('change', () => {
      if (mode === 'system') refresh();
    });
  }
  refresh(false);
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getThemeSnapshot(): ThemeSnapshot {
  return snapshot;
}

export function selectTheme(themeId: string): void {
  if (!allThemes().some((theme) => theme.id === themeId)) throw new Error('找不到这个主题');
  storage()?.setItem(SELECTED_KEY, themeId);
  selectedId = themeId;
  refresh();
}

export function setThemeMode(nextMode: ThemeMode): void {
  if (!['light', 'dark', 'system'].includes(nextMode)) throw new Error('不支持的明暗模式');
  storage()?.setItem(MODE_KEY, nextMode);
  mode = nextMode;
  refresh();
}

export function importThemePackage(source: string): ThemeManifest {
  if (new TextEncoder().encode(source).byteLength > MAX_THEME_PACKAGE_BYTES) throw new Error('主题包超过 128 KiB');
  let decoded: unknown;
  try {
    decoded = JSON.parse(source);
  } catch {
    throw new Error('主题包不是有效 JSON');
  }
  let manifest: ThemeManifest;
  try {
    manifest = parseThemeManifest(decoded);
  } catch (error) {
    throw new Error(`主题包校验失败：${formatThemeValidationError(error)}`);
  }
  if (BUILTIN_THEMES.some((theme) => theme.id === manifest.id)) throw new Error('导入主题不能覆盖内置主题');
  const nextImported = importedThemeListSchema.parse([
    ...importedThemes.filter((theme) => theme.id !== manifest.id),
    manifest,
  ]);
  storage()?.setItem(IMPORTED_KEY, JSON.stringify(nextImported));
  importedThemes = nextImported;
  selectedId = manifest.id;
  storage()?.setItem(SELECTED_KEY, selectedId);
  refresh();
  return manifest;
}

export function exportCurrentTheme(): string {
  return `${JSON.stringify(currentTheme(), null, 2)}\n`;
}
