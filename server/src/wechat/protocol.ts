import crypto from 'node:crypto';

export const WECHAT_MESSAGE_TYPE = {
  user: 1,
  bot: 2,
} as const;

export const WECHAT_ITEM_TYPE = {
  text: 1,
  image: 2,
  voice: 3,
  file: 4,
  video: 5,
} as const;

export interface WechatMediaRef {
  encrypt_query_param?: string;
  aes_key?: string;
  full_url?: string;
}

export interface WechatMessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  image_item?: {
    media?: WechatMediaRef;
    aeskey?: string;
  };
  voice_item?: { media?: WechatMediaRef; text?: string };
  file_item?: { media?: WechatMediaRef; file_name?: string };
  video_item?: { media?: WechatMediaRef };
}

export interface WechatMessage {
  seq?: number;
  message_id?: number;
  client_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  message_type?: number;
  item_list?: WechatMessageItem[];
  context_token?: string;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WechatMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WechatApiConfig {
  baseUrl: string;
  token: string;
  channelVersion?: string;
  botAgent?: string;
  fetchImpl?: typeof fetch;
}

const REGULAR_TIMEOUT_MS = 15_000;
const LIGHT_TIMEOUT_MS = 10_000;
const DEFAULT_LONG_POLL_MS = 35_000;
const CLIENT_VERSION = (0 << 16) | (1 << 8) | 0;

function randomWechatUin(): string {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function endpointUrl(baseUrl: string, endpoint: string): string {
  return new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function abortController(timeoutMs: number, external?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener('abort', onExternalAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function boundedClientId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120);
  return safe || `ai-hub-${crypto.randomUUID()}`;
}

export class WechatApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly channelVersion: string;
  private readonly botAgent: string;

  constructor(private readonly config: WechatApiConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.channelVersion = config.channelVersion ?? '0.1.0';
    this.botAgent = config.botAgent ?? 'ai-hub/0.1.0';
  }

  private baseInfo(): { channel_version: string; bot_agent: string } {
    return { channel_version: this.channelVersion, bot_agent: this.botAgent };
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.token}`,
      AuthorizationType: 'ilink_bot_token',
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String(CLIENT_VERSION),
      'X-WECHAT-UIN': randomWechatUin(),
    };
  }

  private async post<T>(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    external?: AbortSignal,
  ): Promise<T> {
    const abort = abortController(timeoutMs, external);
    try {
      const response = await this.fetchImpl(endpointUrl(this.config.baseUrl, endpoint), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ...body, base_info: this.baseInfo() }),
        signal: abort.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`WeChat ${endpoint} HTTP ${response.status}`);
      }
      return JSON.parse(raw) as T;
    } finally {
      abort.cleanup();
    }
  }

  async getUpdates(cursor: string, timeoutMs = DEFAULT_LONG_POLL_MS, signal?: AbortSignal): Promise<GetUpdatesResponse> {
    try {
      return await this.post<GetUpdatesResponse>(
        'ilink/bot/getupdates',
        { get_updates_buf: cursor },
        timeoutMs,
        signal,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ret: 0, msgs: [], get_updates_buf: cursor };
      }
      throw error;
    }
  }

  async notifyStart(): Promise<void> {
    const response = await this.post<{ ret?: number; errmsg?: string }>(
      'ilink/bot/msg/notifystart',
      {},
      LIGHT_TIMEOUT_MS,
    );
    this.ensureOk('notifystart', response);
  }

  async notifyStop(): Promise<void> {
    const response = await this.post<{ ret?: number; errmsg?: string }>(
      'ilink/bot/msg/notifystop',
      {},
      LIGHT_TIMEOUT_MS,
    );
    this.ensureOk('notifystop', response);
  }

  async getTypingTicket(userId: string, contextToken?: string): Promise<string | null> {
    const response = await this.post<{ ret?: number; errmsg?: string; typing_ticket?: string }>(
      'ilink/bot/getconfig',
      { ilink_user_id: userId, context_token: contextToken },
      LIGHT_TIMEOUT_MS,
    );
    this.ensureOk('getconfig', response);
    return response.typing_ticket?.trim() || null;
  }

  async sendTyping(userId: string, ticket: string, status: 1 | 2): Promise<void> {
    const response = await this.post<{ ret?: number; errmsg?: string }>(
      'ilink/bot/sendtyping',
      { ilink_user_id: userId, typing_ticket: ticket, status },
      LIGHT_TIMEOUT_MS,
    );
    this.ensureOk('sendtyping', response);
  }

  async sendText(params: {
    to: string;
    text: string;
    contextToken?: string;
    clientId: string;
    runId?: string;
  }): Promise<void> {
    const response = await this.post<{ ret?: number; errmsg?: string }>(
      'ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: params.to,
          client_id: boundedClientId(params.clientId),
          message_type: WECHAT_MESSAGE_TYPE.bot,
          message_state: 2,
          item_list: [{ type: WECHAT_ITEM_TYPE.text, text_item: { text: params.text } }],
          context_token: params.contextToken || undefined,
          run_id: params.runId || undefined,
        },
      },
      REGULAR_TIMEOUT_MS,
    );
    this.ensureOk('sendmessage', response);
  }

  private ensureOk(label: string, response: { ret?: number; errmsg?: string }): void {
    if (response.ret !== undefined && response.ret !== 0) {
      throw new Error(`WeChat ${label} ret=${response.ret} errmsg=${response.errmsg ?? '(none)'}`);
    }
  }
}
