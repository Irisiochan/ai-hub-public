import { unzipSync } from 'fflate';
import { toBase64, writeWebBundle } from './appUpdateBundle';
import { getNativePlugins, isNativeShell, withBase } from './mobileShell';

const DATA = 'DATA' as const;
const CURRENT_KEY = 'ai-hub.update.current';
const PENDING_KEY = 'ai-hub.update.pending';
const UPDATE_ROOT = 'updates';
const EMBEDDED_ASSET_PATH = 'public';

export interface AppReleaseManifest {
  webVersion: string;
  nativeVersion: string;
  minNativeVersion: string;
  webBundleUrl: string;
  webBundleSha256: string;
  apkUrl: string;
  apkSha256: string;
  releaseNotes: string;
  publishedAt?: string;
}

interface InstalledWebRelease {
  version: string;
  path: string;
  previous: { version: string; path: string } | null;
}

export interface AppUpdateSnapshot {
  native: boolean;
  webVersion: string;
  nativeVersion: string;
  hasRollback: boolean;
}

export interface AppUpdateDecision {
  kind: 'apk' | 'web' | 'current';
  reason: string;
}

function parseStored<T>(key: string): T | null {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

function safeVersion(value: string): string {
  const safe = value.replace(/[^0-9A-Za-z._-]/g, '-').slice(0, 80);
  if (!safe) throw new Error('更新版本号无效。');
  return safe;
}

function compareVersions(left: string, right: string): number {
  const a = left.replace(/^v/i, '').split(/[.+-]/);
  const b = right.replace(/^v/i, '').split(/[.+-]/);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? '0';
    const bv = b[i] ?? '0';
    const an = /^\d+$/.test(av) ? Number(av) : null;
    const bn = /^\d+$/.test(bv) ? Number(bv) : null;
    const cmp = an !== null && bn !== null
      ? an - bn
      : av.localeCompare(bv, undefined, { numeric: true });
    if (cmp !== 0) return cmp < 0 ? -1 : 1;
  }
  return 0;
}

export function decideAppUpdate(
  snapshot: AppUpdateSnapshot,
  latest: AppReleaseManifest,
): AppUpdateDecision {
  if (
    snapshot.native
    && latest.apkUrl
    && latest.apkSha256
    && (
      compareVersions(snapshot.nativeVersion, latest.minNativeVersion) < 0
      || compareVersions(snapshot.nativeVersion, latest.nativeVersion) < 0
    )
  ) {
    return { kind: 'apk', reason: `原生壳 ${snapshot.nativeVersion} → ${latest.nativeVersion}` };
  }
  if (snapshot.native && snapshot.webVersion !== latest.webVersion) {
    return { kind: 'web', reason: `Web ${snapshot.webVersion} → ${latest.webVersion}` };
  }
  return { kind: 'current', reason: '已经是最新版' };
}

export async function getAppUpdateSnapshot(): Promise<AppUpdateSnapshot> {
  const native = isNativeShell();
  const app = getNativePlugins()?.App;
  let nativeVersion = 'web';
  if (native && app?.getInfo) {
    try {
      nativeVersion = (await app.getInfo()).version;
    } catch {
      nativeVersion = 'unknown';
    }
  }
  return {
    native,
    webVersion: __AI_HUB_WEB_VERSION__,
    nativeVersion,
    hasRollback: Boolean(parseStored<InstalledWebRelease>(CURRENT_KEY)),
  };
}

export async function checkForAppUpdate(): Promise<AppReleaseManifest> {
  const response = await fetch(withBase('/api/app/latest'), {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`检查更新失败（HTTP ${response.status}）${text ? `：${text.slice(0, 160)}` : ''}`);
  }
  const value = await response.json() as Partial<AppReleaseManifest>;
  for (const key of [
    'webVersion',
    'nativeVersion',
    'minNativeVersion',
    'webBundleUrl',
    'webBundleSha256',
    'releaseNotes',
  ] as const) {
    if (typeof value[key] !== 'string') throw new Error(`更新清单缺少 ${key}。`);
  }
  return {
    ...value,
    apkUrl: typeof value.apkUrl === 'string' ? value.apkUrl : '',
    apkSha256: typeof value.apkSha256 === 'string' ? value.apkSha256 : '',
  } as AppReleaseManifest;
}

async function downloadVerified(url: string, expectedSha256: string): Promise<Uint8Array> {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error('更新清单的 SHA-256 无效。');
  const response = await fetch(withBase(url), { cache: 'no-store' });
  if (!response.ok) throw new Error(`下载更新失败（HTTP ${response.status}）。`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const actual = Array.from(digest, (part) => part.toString(16).padStart(2, '0')).join('');
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(`更新包校验失败：SHA-256 不匹配（收到 ${actual.slice(0, 12)}…）。`);
  }
  return bytes;
}

function filesystemPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

async function removeDirectory(path: string): Promise<void> {
  const filesystem = getNativePlugins()?.Filesystem;
  if (!filesystem) return;
  await filesystem.rmdir({ path, directory: DATA, recursive: true }).catch(() => {});
}

async function cleanupWebReleases(keep: string[]): Promise<void> {
  const filesystem = getNativePlugins()?.Filesystem;
  if (!filesystem) return;
  const allowed = new Set(keep.filter(Boolean));
  try {
    const entries = await filesystem.readdir({ path: UPDATE_ROOT, directory: DATA });
    const directories = entries.files
      .filter((item) => item.type === 'directory' && item.name.startsWith('web-'))
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    for (const item of directories) {
      if (allowed.has(item.name)) continue;
      await removeDirectory(`${UPDATE_ROOT}/${item.name}`);
    }
  } catch {
    // 第一次运行没有 updates 目录是正常状态。
  }
}

export async function installWebUpdate(latest: AppReleaseManifest): Promise<never> {
  if (!isNativeShell()) throw new Error('浏览器页面由服务器直接更新，不需要安装 Web 包。');
  const plugins = getNativePlugins();
  const filesystem = plugins?.Filesystem;
  const webView = plugins?.WebView;
  if (!filesystem || !webView) throw new Error('当前 APK 没有 Web 热更新能力，请先安装新版 APK。');

  const bytes = await downloadVerified(latest.webBundleUrl, latest.webBundleSha256);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (error) {
    throw new Error(`更新包无法解压：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!files['index.html']) throw new Error('更新包缺少 index.html。');

  const version = safeVersion(latest.webVersion);
  const directoryName = `web-${version}`;
  const relativeRoot = `${UPDATE_ROOT}/${directoryName}`;
  await removeDirectory(relativeRoot);
  try {
    await writeWebBundle(files, relativeRoot, filesystem);
  } catch (error) {
    await removeDirectory(relativeRoot);
    throw error;
  }

  const uri = await filesystem.getUri({ path: relativeRoot, directory: DATA });
  const path = filesystemPath(uri.uri);
  const current = parseStored<InstalledWebRelease>(CURRENT_KEY);
  const pending: InstalledWebRelease = {
    version: latest.webVersion,
    path,
    previous: current ? { version: current.version, path: current.path } : null,
  };
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  await webView.setServerBasePath({ path });
  return await new Promise<never>((_resolve, reject) => {
    window.setTimeout(() => reject(new Error('WebView 没有重新载入更新包。')), 5000);
  });
}

export async function installApkUpdate(latest: AppReleaseManifest): Promise<void> {
  if (!isNativeShell()) throw new Error('APK 更新只在 Android 壳内可用。');
  if (!latest.apkUrl || !latest.apkSha256) throw new Error('服务器还没有发布可安装的 APK。');
  const filesystem = getNativePlugins()?.Filesystem;
  const opener = getNativePlugins()?.FileOpener;
  if (!filesystem || !opener) throw new Error('当前 APK 没有自更新能力，请手动安装这一次新版 APK。');

  const bytes = await downloadVerified(latest.apkUrl, latest.apkSha256);
  const version = safeVersion(latest.nativeVersion);
  const result = await filesystem.writeFile({
    path: `${UPDATE_ROOT}/ai-hub-${version}.apk`,
    data: toBase64(bytes),
    directory: DATA,
    recursive: true,
  });
  await opener.openFile({
    path: result.uri,
    mimeType: 'application/vnd.android.package-archive',
  });
}

export function scheduleWebUpdateConfirmation(): void {
  if (!isNativeShell()) return;
  const pending = parseStored<InstalledWebRelease>(PENDING_KEY);
  const webView = getNativePlugins()?.WebView;
  if (!pending || !webView) return;
  window.setTimeout(() => {
    void (async () => {
      const active = await webView.getServerBasePath();
      if (active.path !== pending.path) return;
      await webView.persistServerBasePath();
      if (pending.version === 'embedded') {
        localStorage.removeItem(CURRENT_KEY);
      } else {
        localStorage.setItem(CURRENT_KEY, JSON.stringify(pending));
      }
      localStorage.removeItem(PENDING_KEY);
      const keep = [
        pathName(pending.path),
        pending.previous ? pathName(pending.previous.path) : '',
      ];
      await cleanupWebReleases(keep);
    })().catch(() => {
      // 不确认即不持久化；下次冷启动由 Capacitor 自动回退到已确认版本。
    });
  }, 1800);
}

function pathName(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? '';
}

export async function rollbackWebUpdate(): Promise<never> {
  if (!isNativeShell()) throw new Error('浏览器页面没有本地回滚包。');
  const webView = getNativePlugins()?.WebView;
  if (!webView) throw new Error('当前 APK 没有 Web 回滚能力。');
  const current = parseStored<InstalledWebRelease>(CURRENT_KEY);
  if (!current) throw new Error('没有可回滚的 Web 更新。');

  if (current.previous) {
    const pending: InstalledWebRelease = {
      version: current.previous.version,
      path: current.previous.path,
      previous: null,
    };
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    await webView.setServerBasePath({ path: pending.path });
  } else {
    localStorage.setItem(PENDING_KEY, JSON.stringify({
      version: 'embedded',
      path: EMBEDDED_ASSET_PATH,
      previous: null,
    } satisfies InstalledWebRelease));
    await webView.setServerAssetPath({ path: EMBEDDED_ASSET_PATH });
  }
  return await new Promise<never>((_resolve, reject) => {
    window.setTimeout(() => reject(new Error('WebView 没有重新载入回滚版本。')), 5000);
  });
}
