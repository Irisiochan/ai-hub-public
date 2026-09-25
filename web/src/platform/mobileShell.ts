// Android 壳（Capacitor WebView）运行时接入。
// 不 import 任何 Capacitor npm 包：原生壳会把桥注入成 window.Capacitor，
// 这里全部走桥的全局对象，Web 部署下所有函数都是 no-op，构建产物两端共用。

export interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: {
    App?: {
      addListener: (event: 'backButton', cb: (data: { canGoBack?: boolean }) => void) => void;
      minimizeApp: () => Promise<void>;
      getInfo: () => Promise<{ version: string; build: string }>;
    };
    LocalNotifications?: {
      requestPermissions: () => Promise<{ display: string }>;
      schedule: (opts: {
        notifications: Array<{ id: number; title: string; body: string }>;
      }) => Promise<unknown>;
    };
    StatusBar?: {
      setOverlaysWebView: (opts: { overlay: boolean }) => Promise<void>;
      setStyle: (opts: { style: 'DARK' | 'LIGHT' | 'DEFAULT' }) => Promise<void>;
    };
    Filesystem?: {
      writeFile: (opts: {
        path: string; data: string; directory: 'DATA'; recursive?: boolean; encoding?: 'utf8';
      }) => Promise<{ uri: string }>;
      mkdir: (opts: {
        path: string; directory: 'DATA'; recursive?: boolean;
      }) => Promise<void>;
      getUri: (opts: { path: string; directory: 'DATA' }) => Promise<{ uri: string }>;
      readdir: (opts: { path: string; directory: 'DATA' }) => Promise<{
        files: Array<{ name: string; type: 'file' | 'directory'; mtime?: number }>;
      }>;
      rmdir: (opts: { path: string; directory: 'DATA'; recursive?: boolean }) => Promise<void>;
    };
    FileOpener?: {
      openFile: (opts: { path: string; mimeType?: string }) => Promise<void>;
    };
    WebView?: {
      setServerAssetPath: (opts: { path: string }) => Promise<void>;
      setServerBasePath: (opts: { path: string }) => Promise<void>;
      getServerBasePath: () => Promise<{ path: string }>;
      persistServerBasePath: () => Promise<void>;
    };
  };
}

const cap = (): CapacitorGlobal | undefined =>
  (window as { Capacitor?: CapacitorGlobal }).Capacitor;

export type NativePlugins = NonNullable<CapacitorGlobal['Plugins']>;

export function getNativePlugins(): NativePlugins | undefined {
  return cap()?.Plugins;
}

export const isNativeShell = (): boolean => cap()?.isNativePlatform?.() === true;

const BASE_KEY = 'ai-hub.serverBase';
const SESSION_KEY = 'ai-hub.session';
let cachedBase: string | null = null;

export function normalizeBase(url: string): string {
  let u = url.trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}

export function getServerBase(): string {
  if (!isNativeShell()) return '';
  if (cachedBase === null) cachedBase = localStorage.getItem(BASE_KEY) ?? '';
  return cachedBase;
}

export function setServerBase(url: string): void {
  cachedBase = normalizeBase(url);
  localStorage.setItem(BASE_KEY, cachedBase);
}

export function getNativeSession(): string {
  return isNativeShell() ? localStorage.getItem(SESSION_KEY) ?? '' : '';
}

export function setNativeSession(token: string): void {
  if (!isNativeShell()) return;
  if (token) localStorage.setItem(SESSION_KEY, token);
  else localStorage.removeItem(SESSION_KEY);
}

/** 相对路径（/api/...）挂上已保存的服务器地址；Web 部署下原样返回。 */
export function withBase(path: string): string {
  const base = getServerBase();
  if (!base || /^https?:\/\//i.test(path)) return path;
  return base + path;
}

/** 壳内一次性初始化：状态栏安全区 + Android 返回键最小化 + 通知权限。 */
export function initNativeShell(): void {
  if (!isNativeShell()) return;
  const plugins = cap()?.Plugins;
  // overlay:false —— WebView 整体在系统状态栏下方布局，不依赖 env(safe-area-inset-top)
  //（Android WebView 上该 inset 经常为 0，overlay:true + CSS 仍会顶栏压图标）。
  // CSS 仍保留 --safe-top，作为 iOS 刘海/后续若改回 edge-to-edge 时的双保险。
  void plugins?.StatusBar?.setOverlaysWebView({ overlay: false }).catch(() => {});
  void plugins?.StatusBar?.setStyle({ style: 'DARK' }).catch(() => {});
  plugins?.App?.addListener('backButton', () => {
    void plugins.App?.minimizeApp();
  });
  void plugins?.LocalNotifications?.requestPermissions().catch(() => {});
}

const notified = new Set<number>();

/** App 退到后台时，对新完成的对方消息发本地通知（SSE 还活着的窗口内有效）。 */
export function notifyIncoming(msg: {
  id: number;
  sender: string;
  role: string;
  kind: string;
  status: string;
  content: string;
  origin: 'main' | 'side';
}): void {
  if (!isNativeShell() || document.visibilityState === 'visible') return;
  if (msg.role !== 'assistant' || msg.kind !== 'text' || msg.status !== 'done') return;
  if (msg.origin !== 'main') return;
  if (!msg.content.trim() || notified.has(msg.id)) return;
  notified.add(msg.id);
  if (notified.size > 500) {
    const oldest = notified.values().next().value;
    if (oldest !== undefined) notified.delete(oldest);
  }
  void cap()
    ?.Plugins?.LocalNotifications?.schedule({
      notifications: [
        {
          id: msg.id % 2147483647,
          title: msg.sender || 'ai-hub',
          body: msg.content.slice(0, 200),
        },
      ],
    })
    .catch(() => {});
}
