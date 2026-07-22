import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  getServerBase,
  initNativeShell,
  isNativeShell,
  normalizeBase,
  setServerBase,
} from '../mobileShell';

// Android 壳的连接门：Web 部署下直接透传 children；
// 壳内先确认服务器地址可达（/api/health），失败或未配置时进配置页。

type Phase = 'checking' | 'connect' | 'ready';

async function pingHealth(base: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const wrap: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  padding: 24,
  background: '#16161e',
  color: '#c8c8d8',
  fontSize: 15,
};

export default function MobileGate({ children }: { children: ReactNode }) {
  const native = isNativeShell();
  const [phase, setPhase] = useState<Phase>(() =>
    !native ? 'ready' : getServerBase() ? 'checking' : 'connect'
  );
  const [input, setInput] = useState(() => getServerBase());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!native) return;
    initNativeShell();
    if (phase !== 'checking') return;
    let alive = true;
    void pingHealth(getServerBase()).then((ok) => {
      if (!alive) return;
      if (ok) setPhase('ready');
      else {
        setError('连不上已保存的服务器，检查网络（Tailscale 开了吗）或改地址。');
        setPhase('connect');
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === 'ready') return <>{children}</>;

  if (phase === 'checking') {
    return <div style={wrap}>🍊 连接服务器中…</div>;
  }

  const submit = async () => {
    const base = normalizeBase(input);
    if (!base) {
      setError('先填服务器地址。');
      return;
    }
    setBusy(true);
    setError('');
    const ok = await pingHealth(base);
    setBusy(false);
    if (!ok) {
      setError(`访问 ${base}/api/health 失败——地址不对，或手机没连上 Tailscale。`);
      return;
    }
    setServerBase(base);
    setPhase('ready');
  };

  const canEnterAnyway = Boolean(getServerBase());

  return (
    <div style={wrap}>
      <div style={{ fontSize: 40 }}>🍊</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: '#e8e8f0' }}>ai-hub</div>
      <div style={{ opacity: 0.7, textAlign: 'center' }}>填 hub 网关地址（Tailscale 内网可达）</div>
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="http://<hub-tailnet-ip>:3900"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        inputMode="url"
        style={{
          width: '100%',
          maxWidth: 340,
          padding: '10px 12px',
          borderRadius: 8,
          border: '1px solid #33334a',
          background: '#1e1e2a',
          color: '#e8e8f0',
          fontSize: 15,
        }}
      />
      {error && (
        <div style={{ color: '#e08080', maxWidth: 340, textAlign: 'center', fontSize: 13 }}>
          {error}
        </div>
      )}
      <button
        onClick={() => void submit()}
        disabled={busy}
        style={{
          padding: '10px 28px',
          borderRadius: 8,
          border: 'none',
          background: busy ? '#7a4a1a' : '#e8620a',
          color: '#fff',
          fontSize: 15,
          fontWeight: 600,
        }}
      >
        {busy ? '连接中…' : '连接'}
      </button>
      {canEnterAnyway && (
        <button
          onClick={() => setPhase('ready')}
          style={{
            padding: '6px 16px',
            borderRadius: 8,
            border: '1px solid #33334a',
            background: 'transparent',
            color: '#8888a0',
            fontSize: 13,
          }}
        >
          跳过检查，用已保存地址进入
        </button>
      )}
    </div>
  );
}
