import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';

type Phase = 'checking' | 'login' | 'ready';

const wrap: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'max(24px, var(--safe-top)) max(24px, var(--safe-right)) max(24px, var(--safe-bottom)) max(24px, var(--safe-left))',
  background: 'var(--bg)',
  color: 'var(--text)',
};

export default function SessionGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const bootstrapPassword = fragment.get('token') ?? '';
    if (bootstrapPassword) history.replaceState(null, '', `${location.pathname}${location.search}`);
    const check = bootstrapPassword ? api.login(bootstrapPassword) : api.session();
    void check
      .then((status) => {
        if (!alive) return;
        setPhase(!status.enabled || status.authenticated ? 'ready' : 'login');
      })
      .catch(() => {
        if (!alive) return;
        setError('登录状态检查失败，请确认服务器可达。');
        setPhase('login');
      });
    return () => { alive = false; };
  }, []);

  if (phase === 'ready') return <>{children}</>;
  if (phase === 'checking') return <div style={wrap}>🔐 检查登录状态…</div>;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.login(password);
      if (!result.authenticated) throw new Error('login rejected');
      setPassword('');
      setPhase('ready');
    } catch (loginError) {
      const message = loginError instanceof Error ? loginError.message : String(loginError);
      setError(message.includes('too many') ? '尝试过多，请稍后再试。' : '密码不对。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={wrap}>
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="login-logo">🔐</div>
        <h1>ai-hub</h1>
        <p>输入访问密码</p>
        <input
          autoFocus
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="密码"
          aria-label="访问密码"
        />
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={busy || !password}>
          {busy ? '登录中…' : '进入'}
        </button>
      </form>
    </div>
  );
}
