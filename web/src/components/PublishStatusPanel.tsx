import { useCallback, useEffect, useState } from 'react';
import { api, type PublishStatus, type RepoPublishStatus } from '../api';
import { formatLocalTime } from '../time';

interface Props { onClose(): void }

function repoState(repo: RepoPublishStatus): { tone: string; label: string } {
  if (!repo.available) return { tone: 'error', label: '不可用' };
  if (repo.dirty) return { tone: 'warn', label: 'VPS 有未提交改动' };
  if (repo.matchesRemote === false) return { tone: 'warn', label: '远端与 VPS 不一致' };
  if (repo.matchesRemote === true) return { tone: 'ok', label: 'VPS 已同步远端' };
  return { tone: 'muted', label: '远端状态未知' };
}

const short = (value?: string) => value?.slice(0, 7) || '—';

export default function PublishStatusPanel({ onClose }: Props) {
  const [status, setStatus] = useState<PublishStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try { setStatus(await api.publishStatus()); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal publish-panel">
        <header className="modal-header">
          <h2>发布状态</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </header>
        <div className="modal-body publish-body">
          {error && <div className="modal-error">⚠ {error}</div>}
          {!status && !error && <div className="publish-loading">正在核对 VPS 与远端…</div>}
          {status?.repos.map((repo) => {
            const state = repoState(repo);
            return (
              <section className="publish-card" key={repo.id}>
                <div className="publish-card-head">
                  <b>{repo.name}</b>
                  <span className={`publish-badge ${state.tone}`}>● {state.label}</span>
                </div>
                <dl>
                  <div><dt>分支</dt><dd>{repo.branch ?? '—'}</dd></div>
                  <div><dt>VPS</dt><dd><code>{short(repo.currentCommit)}</code></dd></div>
                  <div><dt>远端</dt><dd><code>{short(repo.remoteCommit)}</code></dd></div>
                </dl>
                {repo.error && <small className="publish-error">{repo.error}</small>}
              </section>
            );
          })}
          {status && (
            <div className="publish-meta">
              <span>核对时间（上海）：{formatLocalTime(status.checkedAt)}</span>
              <span>服务启动（上海）：{formatLocalTime(status.startedAt)}</span>
            </div>
          )}
          <div className="publish-note">
            本机尚未 commit / push 的修改，VPS 无法感知；刷新网页也不会发布代码或记忆。后端会话若缓存了旧记忆，还需要重置会话或开启新会话。
          </div>
          <button className="primary-btn" disabled={loading} onClick={() => void refresh()}>
            {loading ? '核对中…' : '重新核对'}
          </button>
        </div>
      </div>
    </div>
  );
}
