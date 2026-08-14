import { getNativeSession, notifyIncoming, setNativeSession, withBase } from './mobileShell';
import { SHANGHAI_TZ_OFFSET } from './time';
import type { ContactBackend, ContactConfig, ContactKind } from '@ai-hub/contact-config';
import {
  buildMessageRequestBody,
  createMessageIdempotencyKey,
  persistedSendResultFromError,
  type SendMessageResult,
} from './sendIdempotency';

export type MessageOrigin = 'main' | 'side';

export interface MessageReadState {
  origin: MessageOrigin;
  lastReadMessageId: number;
  firstUnreadId: number | null;
  unreadCount: number;
}

export interface MessageReadStates {
  main: MessageReadState;
}

export interface Contact {
  id: string;
  name: string;
  avatar: string;
  color: string;
  backend: ContactBackend;
  kind: ContactKind;
  config: ContactConfig;
  state: string;
  /** Busy room member display name from server statusOf (undefined for DM/idle). */
  origin?: MessageOrigin;
  member?: string;
  last_content: string | null;
  last_at: string | null;
  readStates?: MessageReadStates;
}

export interface Message {
  id: number;
  contact_id: string;
  idempotency_key?: string | null;
  sender: string;
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'thinking' | 'tool_use' | 'error';
  content: string;
  status: 'streaming' | 'done' | 'error' | 'interrupted';
  turn_id: string | null;
  meta: string;
  origin: MessageOrigin;
  created_at: string;
  attachments?: Attachment[];
}

export interface Attachment {
  id: number;
  name: string;
  mimeType: string;
  size: number;
  url: string;
}

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>
  ) {
    super(message);
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const headers = new Headers(init?.headers);
  if (!isForm && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const session = getNativeSession();
  if (session && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${session}`);
  const res = await fetch(withBase(url), {
    ...init,
    headers,
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new ApiRequestError(
      typeof body.error === 'string' ? body.error : `${res.status} ${res.statusText}`,
      res.status,
      body
    );
  }
  return res.json() as Promise<T>;
}

export interface UserProfile {
  name: string;
  avatar: string;
  color: string;
}

export interface Usage {
  today: UsageBucket;
  total: UsageBucket;
  last: UsageBucket;
}

export interface UsageBucket {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface QuotaWindow {
  remainingPct: number;
  resetsAt: string | null;
}

export interface ClaudeQuota {
  available: boolean;
  /** 不可用原因：no-token | setup-token | login-expired | error */
  reason?: string;
  /** 最后一次失败的真实响应，诊断用 */
  detail?: string;
  fiveHour?: QuotaWindow | null;
  sevenDay?: QuotaWindow | null;
}

export interface CodexQuota {
  available: boolean;
  fiveHour?: QuotaWindow | null;
  sevenDay?: QuotaWindow | null;
  fetchedAt?: string;
}

export interface GrokQuota {
  available: boolean;
  /** 不可用原因：no-token | login-expired | error */
  reason?: string;
  detail?: string;
  /** 订阅是全产品共享周池，只有一个窗口 */
  weekly?: QuotaWindow | null;
  /** true 时 weekly/fetchedAt 是上次成功快照，不是本轮新鲜数据 */
  stale?: boolean;
  fetchedAt?: string;
}

export interface ContactPayload {
  id?: string;
  name?: string;
  avatar?: string;
  color?: string;
  backend?: string;
  kind?: string;
  config?: Record<string, unknown>;
}

export interface ContactStatus {
  state: string;
  origin?: MessageOrigin;
  member?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface ModelCatalog {
  models: ModelOption[];
  current: string;
  dynamic: boolean;
  warning?: string;
  efforts?: ModelOption[];
  currentEffort?: string;
}

export interface Worker {
  id: string;
  name: string;
  capabilities: { runners?: string[]; workspaces?: string[]; shell?: boolean; ssh?: boolean };
  status: string;
  acceptingJobs: boolean;
  last_seen_at: string | null;
}

export interface WorkerJob {
  id: string;
  requested_by: string | null;
  worker_id: string | null;
  runner: 'codex' | 'claude' | 'grok';
  workspace: string;
  prompt: string;
  status: string;
  priority: number;
  ttl_at: string | null;
  session_id: string | null;
  permissions: { write?: boolean; shell?: boolean; ssh?: boolean };
  result: string | null;
  error: string | null;
  delivery_state: string | null;
  delivery_meta: {
    state?: string;
    changed?: boolean;
    dirtyFiles?: string[];
    head?: string | null;
    ahead?: number | null;
    declared?: {
      stage?: string;
      summary?: string;
      nextOwner?: string;
      needsUserDecision?: boolean;
      blocker?: string;
    };
  } | null;
  delivery_summary?: {
    state: 'in_progress' | 'completed_not_delivered' | 'delivered_waiting_deploy'
      | 'online_waiting_validation' | 'closed_loop' | 'user_decision' | 'rework_required'
      | 'failure_or_blocked';
    label: string;
    summary: string;
    nextOwner: string;
    needsUserDecision: boolean;
  };
  origin_contact_id: string | null;
  origin_anchor_id: number | null;
  /** 1 when task window is soft-hidden; list APIs omit these */
  deleted?: number;
  created_at: string;
  updated_at: string;
}

export interface JobMessage {
  id: number;
  job_id: string;
  sender: string;
  kind: string;
  content: string;
  meta: string;
  created_at: string;
}

export interface RepoPublishStatus {
  id: 'app' | 'memory';
  name: string;
  available: boolean;
  branch?: string;
  currentCommit?: string;
  remoteCommit?: string;
  matchesRemote?: boolean;
  dirty?: boolean;
  error?: string;
}

export interface PublishStatus {
  checkedAt: string;
  startedAt: string;
  repos: RepoPublishStatus[];
}

export const api = {
  session: () => req<{ enabled: boolean; authenticated: boolean }>('/api/session'),

  login: async (password: string) => {
    const result = await req<{ enabled: boolean; authenticated: boolean; sessionToken?: string }>(
      '/api/session',
      { method: 'POST', body: JSON.stringify({ password }) }
    );
    if (result.sessionToken) setNativeSession(result.sessionToken);
    return result;
  },

  logout: async () => {
    const result = await req<{ enabled: boolean; authenticated: boolean }>('/api/session', { method: 'DELETE' });
    setNativeSession('');
    return result;
  },

  contacts: () => req<{ contacts: Contact[] }>('/api/contacts'),

  createContact: (data: ContactPayload) =>
    req<Contact>('/api/contacts', { method: 'POST', body: JSON.stringify(data) }),

  updateContact: (id: string, data: ContactPayload) =>
    req<Contact>(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  models: (id: string) => req<ModelCatalog>(`/api/contacts/${id}/models`),

  switchModel: (id: string, model: string) =>
    req<Contact>(`/api/contacts/${id}/model`, {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    }),

  switchEffort: (id: string, effort: string) =>
    req<Contact>(`/api/contacts/${id}/effort`, {
      method: 'PATCH',
      body: JSON.stringify({ effort }),
    }),

  deleteContact: (id: string) =>
    req<{ ok: boolean }>(`/api/contacts/${id}`, { method: 'DELETE' }),

  messages: (contactId: string, opts: { before?: number; after?: number; limit?: number; origin?: MessageOrigin | 'all' } = {}) => {
    const q = new URLSearchParams();
    if (opts.before !== undefined) q.set('before', String(opts.before));
    if (opts.after !== undefined) q.set('after', String(opts.after));
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.origin) q.set('origin', opts.origin);
    return req<{ messages: Message[]; readState: MessageReadState | null }>(`/api/contacts/${contactId}/messages?${q}`);
  },

  markRead: (contactId: string, throughMessageId: number) =>
    req<{ readState: MessageReadState }>(`/api/contacts/${contactId}/messages/read`, {
      method: 'PATCH',
      body: JSON.stringify({ origin: 'main', throughMessageId }),
    }),

  send: async (
    contactId: string,
    content: string,
    images: File[] = [],
    idempotencyKey = createMessageIdempotencyKey()
  ): Promise<SendMessageResult> => {
    try {
      return await req<SendMessageResult>(`/api/contacts/${contactId}/messages`, {
        method: 'POST',
        body: buildMessageRequestBody(content, images, idempotencyKey),
      });
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const persisted = persistedSendResultFromError(error.body);
        if (persisted) return persisted;
      }
      throw error;
    }
  },

  interrupt: (contactId: string) =>
    req<{ ok: boolean }>(`/api/contacts/${contactId}/interrupt`, { method: 'POST' }),

  regenerate: (contactId: string, messageId: number, content?: string) =>
    req<{ ok: boolean }>(`/api/contacts/${contactId}/messages/${messageId}/regenerate`, {
      method: 'POST',
      body: JSON.stringify(content ? { content } : {}),
    }),

  deleteMessage: (contactId: string, messageId: number, opts: { scope?: 'turn' } = {}) =>
    req<{ ok: boolean; ids?: number[] }>(`/api/contacts/${contactId}/messages/${messageId}${opts.scope === 'turn' ? '?scope=turn' : ''}`, {
      method: 'DELETE',
    }),

  usage: (contactId: string) =>
    req<Usage>(`/api/contacts/${contactId}/usage?tzOffset=${SHANGHAI_TZ_OFFSET}`),

  publishStatus: () => req<PublishStatus>('/api/system/publish-status'),

  claudeQuota: () => req<ClaudeQuota>('/api/quota/claude'),

  codexQuota: () => req<CodexQuota>('/api/quota/codex'),

  grokQuota: () => req<GrokQuota>('/api/quota/grok'),

  getUser: () => req<UserProfile>('/api/user'),

  putUser: (p: Partial<UserProfile>) =>
    req<UserProfile>('/api/user', { method: 'PUT', body: JSON.stringify(p) }),

  resetSession: (contactId: string) =>
    req<{ ok: boolean }>(`/api/contacts/${contactId}/session/reset`, { method: 'POST' }),

  workers: () => req<{ workers: Worker[] }>('/api/workers'),

  pairWorker: (name: string, id?: string) =>
    req<{ worker: Worker; token: string }>('/api/workers', {
      method: 'POST', body: JSON.stringify({ name, id }),
    }),

  deleteWorker: (id: string) =>
    req<{ ok: boolean }>(`/api/workers/${id}`, { method: 'DELETE' }),

  setWorkerEnabled: (id: string, enabled: boolean) =>
    req<Worker>(`/api/workers/${id}/control`, {
      method: 'POST', body: JSON.stringify({ enabled }),
    }),

  jobs: () => req<{ jobs: WorkerJob[] }>('/api/jobs'),

  job: (id: string) => req<{ job: WorkerJob; messages: JobMessage[] }>(`/api/jobs/${id}`),

  createJob: (data: {
    runner: 'codex' | 'claude' | 'grok'; workspace: string; prompt: string; workerId?: string;
    permissions?: { write?: boolean; shell?: boolean; ssh?: boolean };
    requestedBy?: string; originContactId?: string; originAnchorId?: number; idempotencyKey?: string;
  }) => req<WorkerJob>('/api/jobs', { method: 'POST', body: JSON.stringify(data) }),

  setVaultTaskStatus: (data: { path: string; status: 'done'; note: string }) =>
    req<{ ok: true; path: string; status: 'done' }>('/api/vault/task-status', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  jobAction: (id: string, action: 'cancel' | 'pause' | 'resume') =>
    req<{ ok: boolean; status: string }>(`/api/jobs/${id}/action`, {
      method: 'POST', body: JSON.stringify({ action }),
    }),

  resolveJobOutOfBand: (id: string) =>
    req<{ ok: boolean; job: WorkerJob }>(`/api/jobs/${id}/resolve-out-of-band`, {
      method: 'POST', body: '{}',
    }),

  updateJobDelivery: (
    id: string,
    data: { stage: string; summary?: string; nextOwner?: string; blocker?: string },
  ) => req<{ ok: boolean; job: WorkerJob }>(`/api/jobs/${id}/delivery`, {
    method: 'PATCH', body: JSON.stringify(data),
  }),

  /** Soft-hide a worker task window (not a hard delete; does not touch chat messages). */
  deleteJob: (id: string, opts: { force?: boolean } = {}) =>
    req<{ ok: boolean; job: WorkerJob }>(`/api/jobs/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ force: opts.force === true }),
    }),
};

export interface SseHandlers {
  onMessage(msg: Message): void;
  onDelta(d: { contactId: string; messageId: number; text: string }): void;
  onStatus(s: { contactId: string; state: string; detail?: string; member?: string; origin?: MessageOrigin }): void;
  onContact(c: Contact): void;
  onPrune(p: { contactId: string; ids?: number[]; afterId?: number }): void;
  onUser(u: UserProfile): void;
  onReadState(s: MessageReadState & { contactId: string }): void;
  onJob?(j: WorkerJob): void;
  onJobMessage?(m: JobMessage): void;
  onWorker?(w: Worker): void;
  onReconnect(): void;
}

export interface EventConnection {
  disconnect(): void;
  refresh(): void;
}

export function connectEvents(
  handlers: SseHandlers,
  subscriptions: () => string[] = () => []
): EventConnection {
  let es: EventSource | null = null;
  let closed = false;
  let hadError = false;
  let resyncOnOpen = false;

  const open = (reconcileAfterOpen = false) => {
    if (closed) return;
    if (reconcileAfterOpen) resyncOnOpen = true;
    es?.close();
    const query = new URLSearchParams({ subscribe: subscriptions().join(',') });
    const session = getNativeSession();
    if (session) query.set('session', session);
    es = new EventSource(withBase(`/api/events?${query}`), { withCredentials: true });
    es.onopen = () => {
      const shouldResync = hadError || resyncOnOpen;
      hadError = false;
      resyncOnOpen = false;
      if (shouldResync) handlers.onReconnect();
    };
    es.onerror = () => {
      hadError = true; // EventSource auto-retries; onopen will trigger resync
    };
    es.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data) as Message;
      notifyIncoming(msg);
      handlers.onMessage(msg);
    });
    es.addEventListener('delta', (e) => handlers.onDelta(JSON.parse(e.data)));
    es.addEventListener('status', (e) => handlers.onStatus(JSON.parse(e.data)));
    es.addEventListener('contact', (e) => handlers.onContact(JSON.parse(e.data)));
    es.addEventListener('prune', (e) => handlers.onPrune(JSON.parse(e.data)));
    es.addEventListener('user', (e) => handlers.onUser(JSON.parse(e.data)));
    es.addEventListener('read-state', (e) => handlers.onReadState(JSON.parse(e.data)));
    es.addEventListener('job', (e) => handlers.onJob?.(JSON.parse(e.data)));
    es.addEventListener('job-message', (e) => handlers.onJobMessage?.(JSON.parse(e.data)));
    es.addEventListener('worker', (e) => handlers.onWorker?.(JSON.parse(e.data)));
  };

  open();

  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    // phone coming back from lock screen: EventSource may be silently dead
    if (!es || es.readyState === EventSource.CLOSED) open(true);
    else handlers.onReconnect();
  };
  document.addEventListener('visibilitychange', onVisible);

  return {
    disconnect: () => {
      closed = true;
      document.removeEventListener('visibilitychange', onVisible);
      es?.close();
    },
    // Changing delta subscriptions closes the old EventSource. Always reconcile
    // after the replacement connection opens so events in that small gap cannot
    // leave the UI on a stale streaming row.
    refresh: () => open(true),
  };
}
