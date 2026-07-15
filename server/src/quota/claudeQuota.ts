import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface QuotaWindow {
  remainingPct: number;
  resetsAt: string | null;
}

export interface ClaudeQuota {
  fiveHour: QuotaWindow | null;
  sevenDay: QuotaWindow | null;
  sevenDayOpus: QuotaWindow | null;
  fetchedAt: string;
}

/** 拿不到额度时的原因，前端据此给可操作提示 */
export type ClaudeQuotaReason = 'no-token' | 'setup-token' | 'login-expired' | 'error';

export interface ClaudeQuotaStatus {
  available: boolean;
  reason?: ClaudeQuotaReason;
  /** 最后一次失败的真实响应（状态码 + body 片段），诊断用 */
  detail?: string;
  fiveHour?: QuotaWindow | null;
  sevenDay?: QuotaWindow | null;
  sevenDayOpus?: QuotaWindow | null;
  fetchedAt?: string;
}

const CREDENTIALS_PATH =
  process.env.CLAUDE_CREDENTIALS_PATH ?? path.join(os.homedir(), '.claude', '.credentials.json');
// Claude Code 官方 OAuth 公开 client id（CLI /login 用的同一个）
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

interface TokenInfo {
  token: string;
  source: 'credentials' | 'env';
}

/**
 * Best-effort subscription quota for claude-cli contacts, polled from the
 * OAuth usage endpoint the Claude Code /usage screen uses. Undocumented —
 * parsed defensively; when it breaks the UI shows the reason instead of
 * fabricated numbers.
 *
 * 授权边界（实测）：usage 端点只认完整 /login 产生的 credentials access
 * token；`claude setup-token` 的 sk-ant-oat 只能聊天，打 usage 是 403。
 * access token 会过期，poller 用 refresh token 自动续期并原子写回
 * credentials 文件（聊天子进程走 CLAUDE_CODE_OAUTH_TOKEN，不碰这份凭据）。
 */
export class ClaudeQuotaPoller {
  private data: ClaudeQuota | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private skipUntil = 0;
  private lastReason: ClaudeQuotaReason | undefined;
  private lastDetail: string | undefined;
  private lastSource: TokenInfo['source'] | null = null;

  constructor(private log: (msg: string) => void) {}

  start(intervalMs = 300_000): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get(): ClaudeQuotaStatus {
    if (this.data) return { available: true, ...this.data };
    return { available: false, reason: this.lastReason ?? 'no-token', detail: this.lastDetail };
  }

  private readCredentials(): any | null {
    try {
      return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    } catch {
      return null;
    }
  }

  private token(): TokenInfo | null {
    const creds = this.readCredentials();
    const t = creds?.claudeAiOauth?.accessToken;
    if (t) return { token: t, source: 'credentials' };
    const env = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return env ? { token: env, source: 'env' } : null;
  }

  /** 用 refresh token 续期并原子写回 credentials 文件；成功返回新 access token */
  private async refreshCredentials(): Promise<string | null> {
    const creds = this.readCredentials();
    const refreshToken = creds?.claudeAiOauth?.refreshToken;
    if (!refreshToken) return null;
    try {
      const res = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: OAUTH_CLIENT_ID,
        }),
      });
      if (!res.ok) {
        this.log(`claude quota token refresh failed: HTTP ${res.status}`);
        return null;
      }
      const j: any = await res.json();
      if (!j.access_token) return null;
      creds.claudeAiOauth.accessToken = j.access_token;
      if (j.refresh_token) creds.claudeAiOauth.refreshToken = j.refresh_token;
      if (typeof j.expires_in === 'number') {
        creds.claudeAiOauth.expiresAt = Date.now() + j.expires_in * 1000;
      }
      const tmp = `${CREDENTIALS_PATH}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(creds), { mode: 0o600 });
      fs.renameSync(tmp, CREDENTIALS_PATH);
      this.log('claude quota token refreshed');
      return j.access_token;
    } catch (e: any) {
      this.log(`claude quota token refresh failed: ${e.message}`);
      return null;
    }
  }

  private async fetchUsage(token: string): Promise<Response> {
    return fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        // 端点校验客户端身份：没有这两个头会 401
        'user-agent': 'claude-cli/2.1.207 (external, cli)',
        'x-app': 'cli',
      },
    });
  }

  private async poll(): Promise<void> {
    const info = this.token();
    if (!info) {
      this.lastReason = 'no-token';
      this.lastDetail = undefined;
      return;
    }
    // 完整 /login 后凭据出现（或来源变化）→ 立刻结束退避重试
    if (info.source !== this.lastSource) {
      this.lastSource = info.source;
      this.failures = 0;
      this.skipUntil = 0;
    }
    if (Date.now() < this.skipUntil) return; // 指数退避中

    try {
      let res = await this.fetchUsage(info.token);

      // credentials token 过期 → refresh 一次再试
      if (res.status === 401 && info.source === 'credentials') {
        const fresh = await this.refreshCredentials();
        if (fresh) res = await this.fetchUsage(fresh);
      }

      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        if (info.source === 'env' && (res.status === 403 || res.status === 401)) {
          // setup-token 只能聊天，usage 端点不认；重试也不会好
          this.lastReason = 'setup-token';
        } else if (res.status === 401 || res.status === 403) {
          this.lastReason = 'login-expired';
        } else {
          this.lastReason = 'error';
        }
        this.lastDetail = `HTTP ${res.status} ${body}`;
        throw new Error(`HTTP ${res.status}${body ? ` — ${body}` : ''}`);
      }
      const j: any = await res.json();

      const pick = (o: any): QuotaWindow | null =>
        o && typeof o.utilization === 'number'
          ? {
              remainingPct: Math.max(0, Math.round(100 - o.utilization)),
              resetsAt: o.resets_at ?? null,
            }
          : null;

      this.data = {
        fiveHour: pick(j.five_hour),
        sevenDay: pick(j.seven_day),
        sevenDayOpus: pick(j.seven_day_opus),
        fetchedAt: new Date().toISOString(),
      };
      this.failures = 0;
      this.skipUntil = 0;
      this.lastReason = undefined;
      this.lastDetail = undefined;
    } catch (e: any) {
      this.failures++;
      if (this.lastReason === undefined) {
        this.lastReason = 'error';
        this.lastDetail = e.message;
      }
      // 退避：5min → 10 → 20 → … 封顶 2h，永不放弃（端点恢复就恢复）
      const backoffMs = Math.min(300_000 * 2 ** this.failures, 7_200_000);
      this.skipUntil = Date.now() + backoffMs;
      this.log(`claude quota poll failed (${this.failures}): ${e.message}, backing off ${Math.round(backoffMs / 60_000)}min`);
    }
  }
}
