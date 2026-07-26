import { useEffect, useState } from 'react';
import { api, type UserProfile } from '../api';
import {
  checkForAppUpdate,
  decideAppUpdate,
  getAppUpdateSnapshot,
  installApkUpdate,
  installWebUpdate,
  rollbackWebUpdate,
  type AppReleaseManifest,
  type AppUpdateSnapshot,
} from '../appUpdate';

interface Props {
  user: UserProfile;
  onClose(): void;
}

export default function UserConfig({ user, onClose }: Props) {
  const [name, setName] = useState(user.name);
  const [avatar, setAvatar] = useState(user.avatar);
  const [color, setColor] = useState(user.color);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AppUpdateSnapshot | null>(null);
  const [latest, setLatest] = useState<AppReleaseManifest | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);

  const checkUpdate = async () => {
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      const [installed, published] = await Promise.all([
        getAppUpdateSnapshot(),
        checkForAppUpdate(),
      ]);
      setSnapshot(installed);
      setLatest(published);
    } catch (e) {
      setUpdateError((e as Error).message);
    } finally {
      setUpdateBusy(false);
    }
  };

  useEffect(() => {
    void checkUpdate();
  }, []);

  const runUpdate = async () => {
    if (!snapshot || !latest) return;
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      const decision = decideAppUpdate(snapshot, latest);
      if (decision.kind === 'apk') await installApkUpdate(latest);
      else if (decision.kind === 'web') await installWebUpdate(latest);
    } catch (e) {
      setUpdateError((e as Error).message);
      setUpdateBusy(false);
    }
  };

  const save = async () => {
    try {
      await api.putUser({ name, avatar, color });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const decision = snapshot && latest ? decideAppUpdate(snapshot, latest) : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal user-config-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>我的资料与更新</h2>
          <button className="modal-close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">
          <div className="field-row">
            <label className="field field-wide">
              名字
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              头像
              <input value={avatar} onChange={(e) => setAvatar(e.target.value)} />
            </label>
            <label className="field">
              气泡色
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
          </div>
          <section className="app-update-card">
            <div className="app-update-head">
              <strong>应用更新</strong>
              <button className="ghost-btn compact" disabled={updateBusy} onClick={() => void checkUpdate()}>
                {updateBusy ? '检查中…' : '检查更新'}
              </button>
            </div>
            {snapshot && (
              <dl className="app-version-grid">
                <div>
                  <dt>本机 Web</dt>
                  <dd title={snapshot.webVersion}>{snapshot.webVersion}</dd>
                </div>
                <div>
                  <dt>本机 APK</dt>
                  <dd>{snapshot.nativeVersion}</dd>
                </div>
                <div>
                  <dt>最新 Web</dt>
                  <dd title={latest?.webVersion}>{latest?.webVersion ?? '—'}</dd>
                </div>
                <div>
                  <dt>最新 APK</dt>
                  <dd>{latest?.nativeVersion ?? '—'}</dd>
                </div>
              </dl>
            )}
            {decision && <div className={`app-update-status ${decision.kind}`}>{decision.reason}</div>}
            {latest?.releaseNotes && <p className="app-release-notes">{latest.releaseNotes}</p>}
            {updateError && <div className="modal-error">⚠ {updateError}</div>}
            <div className="app-update-actions">
              {decision && decision.kind !== 'current' && (
                <button
                  className="primary-btn"
                  disabled={updateBusy}
                  onClick={() => void runUpdate()}
                >
                  {decision.kind === 'apk' ? '下载并安装 APK' : '立即热更新'}
                </button>
              )}
              {snapshot?.native && snapshot.hasRollback && (
                <button
                  className="ghost-btn"
                  disabled={updateBusy}
                  onClick={() => {
                    setUpdateBusy(true);
                    setUpdateError(null);
                    void rollbackWebUpdate().catch((e) => {
                      setUpdateError((e as Error).message);
                      setUpdateBusy(false);
                    });
                  }}
                >
                  回滚 Web
                </button>
              )}
            </div>
            {!snapshot?.native && snapshot && (
              <div className="field-hint">浏览器版随服务器部署自动更新，无需下载安装。</div>
            )}
          </section>
          {error && <div className="modal-error">⚠ {error}</div>}
        </div>
        <footer className="modal-footer">
          <span style={{ flex: 1 }} />
          <button className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button className="primary-btn" onClick={() => void save()}>
            保存
          </button>
        </footer>
      </div>
    </div>
  );
}
