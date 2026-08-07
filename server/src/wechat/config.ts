import path from 'node:path';

export interface WechatChannelConfig {
  enabled: boolean;
  token: string;
  botId: string;
  allowFrom: Set<string>;
  baseUrl: string;
  cdnBaseUrl: string;
  stateFile: string;
  longPollMs: number;
}

function enabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

function httpsUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${label} must use https`);
  return url.toString().replace(/\/$/, '');
}

export function loadWechatChannelConfig(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): WechatChannelConfig {
  const active = enabled(env.WECHAT_CHANNEL_ENABLED);
  const token = env.WECHAT_BOT_TOKEN?.trim() ?? '';
  const botId = env.WECHAT_BOT_ID?.trim() ?? '';
  const allowFrom = new Set(
    (env.WECHAT_ALLOW_FROM ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (active && (!token || !botId || allowFrom.size === 0)) {
    throw new Error(
      'WeChat channel enabled but WECHAT_BOT_TOKEN, WECHAT_BOT_ID or WECHAT_ALLOW_FROM is missing',
    );
  }
  const requestedStateFile = env.WECHAT_STATE_FILE?.trim();
  const stateFile = requestedStateFile
    ? path.resolve(requestedStateFile)
    : process.platform === 'linux'
      ? '/var/lib/ai-hub/wechat-channel-state.json'
      : path.join(dataDir, 'wechat-channel-state.json');
  const requestedPoll = Number(env.WECHAT_LONG_POLL_MS ?? 35_000);
  const longPollMs = Number.isFinite(requestedPoll)
    ? Math.min(Math.max(Math.trunc(requestedPoll), 5_000), 60_000)
    : 35_000;
  return {
    enabled: active,
    token,
    botId,
    allowFrom,
    baseUrl: httpsUrl(env.WECHAT_BASE_URL?.trim() || 'https://ilinkai.weixin.qq.com', 'WECHAT_BASE_URL'),
    cdnBaseUrl: httpsUrl(env.WECHAT_CDN_BASE_URL?.trim() || 'https://novac2c.cdn.weixin.qq.com/c2c', 'WECHAT_CDN_BASE_URL'),
    stateFile,
    longPollMs,
  };
}
