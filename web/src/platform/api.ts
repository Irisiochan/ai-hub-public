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

export interface HeartbeatStatus {
  contactId: string;
  active: boolean;
  mode?: 'timed' | 'unlimited';
  startedAt?: string;
  expiresAt?: string;
  intervalMinutes?: number;
  tickCount?: number;
  pausedReason?: string;
  stats?: { dispatched: number; silent: number; visible: number; failed: number; skipped: number; inputTokens: number; outputTokens: number; toolCount: number };
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

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>
  ) {
    super(message);
  }
}

async function req<T>(url: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const isForm = init?.body instanceof FormData;
  const headers = new Headers(init?.headers);
  if (!isForm && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const session = getNativeSession();
  if (session && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${session}`);
  // 超时只包住显式传入正数 timeoutMs 的读请求；不传、undefined 或 0 都不排 abort timer、
  // fetch 也不带超时 signal，避免月结 summarize、账单导入等写请求被误报成超时。
  const hasTimeout = typeof timeoutMs === 'number' && timeoutMs > 0;
  const timeoutController = hasTimeout ? new AbortController() : null;
  const timer = hasTimeout
    ? globalThis.setTimeout(() => timeoutController!.abort(), timeoutMs)
    : undefined;
  // 调用方 signal 与超时 signal 必须同时生效：有调用方 signal 时合并，而不是丢掉一方。
  let signal: AbortSignal | undefined = init?.signal ?? undefined;
  const cleanup: Array<() => void> = [];
  if (timeoutController) {
    if (!signal) {
      signal = timeoutController.signal;
    } else if (!signal.aborted && !timeoutController.signal.aborted) {
      const AnySignal = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
      if (typeof AnySignal === 'function') {
        signal = AnySignal([signal, timeoutController.signal]);
      } else {
        const combined = new AbortController();
        const onAbort = () => combined.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        timeoutController.signal.addEventListener('abort', onAbort, { once: true });
        cleanup.push(() => {
          signal!.removeEventListener('abort', onAbort);
          timeoutController.signal.removeEventListener('abort', onAbort);
        });
        signal = combined.signal;
      }
    } else if (timeoutController.signal.aborted) {
      signal = timeoutController.signal;
    }
  }
  const startedAt = Date.now();
  try {
    const res = await fetch(withBase(url), {
      ...init,
      headers,
      credentials: 'include',
      signal: signal ?? undefined,
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
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    if (timeoutController?.signal.aborted && !init?.signal?.aborted) {
      throw new Error(`请求超时（${Math.round((timeoutMs as number) / 1000)}s），请重试`);
    }
    throw error;
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    for (const fn of cleanup) fn();
    const elapsed = Date.now() - startedAt;
    if (elapsed > API_SLOW_WARN_MS) console.warn(`[api] slow ${url} ${elapsed}ms`);
  }
}

/** 首屏加载上限：PC Worker 列表/状态不再无限转圈，超时后进入错误态可重试。 */
export const API_REQUEST_TIMEOUT_MS = 15_000;
/** 慢请求观测阈值：只打 warn，不改变行为。 */
export const API_SLOW_WARN_MS = 5_000;

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
  runner: 'codex' | 'claude' | 'grok' | 'opencode';
  workspace: string;
  prompt: string;
  status: string;
  /** Present on create when no currently eligible worker advertises this runner. */
  queue_warning?: string;
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
    state: 'in_progress' | 'completed_not_delivered' | 'waiting_review' | 'delivered_waiting_deploy'
      | 'online_waiting_validation' | 'closed_loop' | 'user_decision' | 'rework_required'
      | 'failure_or_blocked';
    label: string;
    summary: string;
    nextOwner: string;
    needsUserDecision: boolean;
  };
  origin_contact_id: string | null;
  origin_anchor_id: number | null;
  options?: {
    model?: string;
    reasoning?: string;
    runnerSource?: 'policy' | 'override';
    runnerOverrideReason?: string;
    workflowStage?: WorkflowStage;
    /** Dispatch-time module binding snapshot: the binding this job actually ran with. */
    workflowModule?: {
      moduleId: WorkflowModuleId;
      bindingRevision: number;
      binding: WorkflowModuleBinding;
      selected: WorkflowModuleBinding;
      escalateToHuman: boolean;
    };
    /** Jobs created before the module snapshot only carry the retired profile one. */
    workflow?: WorkflowSnapshot;
  };
  /** 1 when task window is soft-hidden; list APIs omit these */
  deleted?: number;
  created_at: string;
  updated_at: string;
}

export type WorkflowStage = 'plan' | 'review' | 'execute' | 'fix' | 'maintenance' | 'patrol';

export interface WorkflowBinding {
  runner: 'codex' | 'claude' | 'grok' | 'opencode';
  model: string;
  reasoning: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
}

export interface WorkflowRoute {
  primary: WorkflowBinding;
  escalateAfter?: number;
  upgrade?: WorkflowBinding;
}

export interface WorkflowProfile {
  id: string;
  version: number;
  label: string;
  description: string;
  routes: Record<WorkflowStage, WorkflowRoute>;
  capabilities: { deepseekBulkHarness: 'unavailable' | 'planned' | 'available' };
}

export interface WorkflowSnapshot {
  profileId: string;
  profileVersion: number;
  profileLabel: string;
  stage: WorkflowStage;
  taskPath: string;
  problemFingerprint: string;
  primary: WorkflowBinding;
  escalateAfter?: number;
  escalateToHuman: boolean;
  fallbackActive: boolean;
  selected: WorkflowBinding;
  workflowFingerprint: string;
}

export interface WorkflowProfilesResponse {
  active: WorkflowProfile;
  previous: WorkflowProfile | null;
  updatedBy: string;
  updatedAt: string;
  profiles: WorkflowProfile[];
  audit: Array<Record<string, unknown>>;
}

export type WorkflowModuleId = 'plan' | 'execute' | 'review' | 'arbitration' | 'merge' | 'deploy' | 'maintenance';

export interface WorkflowModuleBinding {
  contactId: string;
  runner: WorkflowBinding['runner'];
  model: string;
  reasoning: string;
}

export interface WorkflowWorkerTarget {
  workerId: string;
  workspace: string;
  repoId?: string;
}

export interface WorkflowModule {
  id: WorkflowModuleId;
  label: string;
  description: string;
  permissions: { write: boolean; shell: boolean; ssh: boolean };
  binding: WorkflowModuleBinding;
  status: 'idle' | 'running' | 'blocked' | 'unavailable';
  statusDetail?: string;
}

export interface WorkflowAgent {
  contactId: string;
  name: string;
  runner: WorkflowBinding['runner'];
  models: Array<{ id: string; label: string; efforts: string[] }>;
  compatibleModules: string[];
  unavailableReason?: string;
  quotaPool?: string;
}

export interface WorkflowModuleJob {
  id: string;
  moduleId: WorkflowModuleId;
  status: string;
  model: string;
  reasoning: string;
  bindingRevision: number;
  error?: string;
  canTakeover: boolean;
}

export interface WorkflowModulesResponse {
  revision: number;
  workerTarget: WorkflowWorkerTarget | null;
  modules: WorkflowModule[];
  agents: WorkflowAgent[];
  jobs: WorkflowModuleJob[];
  audit: Array<{ id?: number; actor?: string; createdAt?: string; detail?: string }>;
}

export interface RoomTaskSummary {
  id: string;
  room_id: string;
  task_path: string;
  title: string;
  status: string;
  revision: number;
  owner_module: string;
  owner_contact: string;
  active_handoff_id: string | null;
  candidate_sha: string | null;
  candidate_job_id: string | null;
  review_status: string | null;
  imported: number;
  updated_at: string;
  attemptCount: number;
}

export interface RoomTaskView {
  task: RoomTaskSummary & { requirements: string; approved_workspace: string; anchor_message_id: number | null };
  handoffs: Array<Record<string, unknown>>;
  events: Array<{ id: number; kind: string; actor: string; module: string | null; payload: string; created_at: string }>;
  evidence: Array<{ id: number; kind: string; ref: string; body: string; actor: string; created_at: string }>;
  attempts: Array<Record<string, unknown>>;
  waits: Array<{ id: number; mode: string; reason: string; resume_condition: string; revision: number; actor: string; module: string; scope: string; created_at: string }>;
  unsettledRecoveries?: Array<{
    turnId: string;
    recovered: boolean;
    evidence: Array<{ eventId: number; kind: string; turnId?: string; handoffId?: string; jobId?: string }>;
    summary?: string;
  }>;
  receiptPage?: { jobId: string; kind: string; start: number; end: number; total: number; page: string; atEnd: boolean; nextOffset: number };
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

  heartbeat: (id: string) => req<HeartbeatStatus>(`/api/contacts/${id}/heartbeat`),

  startHeartbeat: (id: string, options: { minutes: number } | { unlimited: true }) =>
    req<HeartbeatStatus>(`/api/contacts/${id}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),

  stopHeartbeat: (id: string) => req<HeartbeatStatus>(`/api/contacts/${id}/heartbeat`, {
    method: 'DELETE',
  }),

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

  workers: () => req<{ workers: Worker[] }>('/api/workers', undefined, API_REQUEST_TIMEOUT_MS),

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

  jobs: () => req<{ jobs: WorkerJob[] }>('/api/jobs', undefined, API_REQUEST_TIMEOUT_MS),

  job: (id: string) => req<{ job: WorkerJob; messages: JobMessage[] }>(`/api/jobs/${id}`, undefined, API_REQUEST_TIMEOUT_MS),

  createJob: (data: {
    runner?: 'codex' | 'claude' | 'grok' | 'opencode'; stage?: WorkflowStage;
    workspace: string; prompt: string; workerId?: string;
    permissions?: { write?: boolean; shell?: boolean; ssh?: boolean };
    requestedBy?: string; originContactId?: string; originAnchorId?: number; idempotencyKey?: string;
  }) => req<WorkerJob>('/api/jobs', { method: 'POST', body: JSON.stringify(data) }),

  workflowProfiles: () => req<WorkflowProfilesResponse>('/api/workflow-profiles'),

  roomTasks: (roomId: string) =>
    req<{ roomId: string; tasks: RoomTaskSummary[] }>(`/api/room-tasks/${encodeURIComponent(roomId)}`),

  createRoomTask: (roomId: string, data: {
    task_path: string; workspace?: string; repo_id?: string; baseline_sha?: string;
    needs_camera?: boolean; needs_taobao?: boolean; needs_ssh?: boolean; needs_win32?: boolean;
    title?: string; requirements?: string;
    dispatch?: { to_module: 'plan' | 'execute'; request: string; auto_start?: boolean; return_to_module?: string };
  }) => req<{ task: RoomTaskSummary; baseline_source?: string | null; job?: WorkerJob; delivery?: { status: string; reason?: string } }>(
    `/api/room-tasks/${encodeURIComponent(roomId)}`, { method: 'POST', body: JSON.stringify(data) },
  ),

  projectTargets: () => req<{ targets: { repoId: string; platform: string; workerId: string; workspace: string }[] }>(
    '/api/project-targets',
  ),

  roomTask: (roomId: string, taskFile: string, query: { receipt_job_id?: string; receipt_offset?: number; receipt_limit?: number; event_limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (query.receipt_job_id) q.set('receipt_job_id', query.receipt_job_id);
    if (query.receipt_offset !== undefined) q.set('receipt_offset', String(query.receipt_offset));
    if (query.receipt_limit !== undefined) q.set('receipt_limit', String(query.receipt_limit));
    if (query.event_limit !== undefined) q.set('event_limit', String(query.event_limit));
    const suffix = q.toString() ? `?${q}` : '';
    return req<RoomTaskView>(`/api/room-tasks/${encodeURIComponent(roomId)}/${encodeURIComponent(taskFile)}${suffix}`);
  },

  workflowModules: () => req<WorkflowModulesResponse>('/api/workflow-modules'),

  bindWorkflowModule: (id: WorkflowModuleId, expectedRevision: number, binding: WorkflowModuleBinding) =>
    req<WorkflowModulesResponse>(`/api/workflow-modules/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({ expectedRevision, binding }),
    }),

  setWorkflowWorkerTarget: (expectedRevision: number, target: WorkflowWorkerTarget) =>
    req<WorkflowModulesResponse>('/api/workflow-modules/worker-target', {
      method: 'PATCH', body: JSON.stringify({ expectedRevision, target }),
    }),

  takeoverWorkflowJob: (id: string, expectedRevision: number) =>
    req<{ job: WorkerJob; existing?: boolean }>(`/api/workflow-modules/jobs/${encodeURIComponent(id)}/takeover`, {
      method: 'POST', body: JSON.stringify({ expectedRevision }),
    }),

  recordJobQuality: (id: string, quality: 'success' | 'inadequate' | 'infrastructure', detail?: string) =>
    req<{ ok: boolean; streak?: number; fallbackActive?: boolean; escalateToHuman?: boolean }>(`/api/jobs/${id}/quality`, {
      method: 'POST', body: JSON.stringify({ quality, detail }),
    }),

  setVaultTaskStatus: (data: { path: string; status: 'done'; note: string }) =>
    req<{ ok: true; path: string; status: 'done'; alreadyDone?: boolean }>('/api/vault/task-status', {
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
  onWorkflowProfile?(): void;
  onRoomTask?(change: { roomId: string }): void;
  onHeartbeat?(status: HeartbeatStatus): void;
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
    es.addEventListener('workflow-profile', () => handlers.onWorkflowProfile?.());
    es.addEventListener('workflow-modules', () => handlers.onWorkflowProfile?.());
    es.addEventListener('room-task', (e) => handlers.onRoomTask?.(JSON.parse(e.data)));
    es.addEventListener('heartbeat', (e) => handlers.onHeartbeat?.(JSON.parse(e.data)));
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
