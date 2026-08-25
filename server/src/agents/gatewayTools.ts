import type { Db, JobRow } from '../db.js';
import type { HubLogger } from '../logger.js';
import { canonicalWorkspacePath } from '../workers/coordinationKeys.js';
import { coordinationMarkerDispatchKey, parseCoordinationMarker } from '../workers/coordinationReceipt.js';
import { normalizeRoomCoordinationDispatch } from './roomPrompt.js';
import { coordinationTaskPath, JobStore, workspaceAllowed } from '../workers/jobStore.js';
import {
  problemFingerprint,
  stageForRouteClass,
  type WorkflowSnapshot,
} from '../workers/workflowProfiles.js';

/**
 * Gateway-executed tools exposed to contacts (phase 2 of the PC worker
 * bridge): a contact on the VPS delegates coding work to the PC worker
 * instead of editing the deployed checkout in place. One definition serves
 * both the DirectApi backend (native tool loop) and the hub MCP endpoint
 * (claude-cli contacts).
 */

export interface GatewayTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  exec: (input: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
}

export interface DelegationCfg {
  enabled?: boolean;
  /** 派单允许触碰的 workspace 白名单（PC 上的路径）。必填，空 = 不许派单。 */
  workspaces?: string[];
  runners?: ('claude' | 'codex' | 'grok')[];
  allowShell?: boolean;
  /** SSH 回 VPS 等高影响能力，必须 User 在联系人配置里单独打开 */
  allowSsh?: boolean;
  /** 固定派给某个 worker（默认任意在线 worker 认领） */
  workerId?: string;
  /** 同一联系人同时在跑/在排的任务上限，防委派循环 */
  maxOpenJobs?: number;
}

type DelegatedRunner = 'claude' | 'codex' | 'grok';
type RouteClass = 'implement' | 'fix' | 'review' | 'recon' | 'mechanical';
type RunnerSource = 'policy' | 'override';

const ROUTE_CLASS_VALUES: RouteClass[] = ['implement', 'fix', 'review', 'recon', 'mechanical'];
const RUNNER_VALUES: DelegatedRunner[] = ['claude', 'codex', 'grok'];
const ROUTE_POLICY_TEXT =
  '默认 runner/model/effort 由当前 Workflow Profile 和 route_class 决定；偏离必须显式传非空 runner_override_reason。';
const ROUTE_CLASS_REQUIRED_ERROR =
  `route_class 必填，且必须是 ${ROUTE_CLASS_VALUES.join(' | ')}。${ROUTE_POLICY_TEXT}`;

/** 调用方没显式传 model/effort 时补上的派单默认。 */
const RUNNER_DEFAULTS: Partial<Record<DelegatedRunner, { model: string; effort: string }>> = {
  claude: { model: 'claude-opus-5', effort: 'high' },
  codex: { model: 'gpt-5.6-sol', effort: 'high' },
  grok: { model: 'grok-4.6', effort: 'high' },
};

/**
 * Accept human-readable Claude versions without letting a pinned version fall
 * back to the moving `opus` / `sonnet` aliases.
 */
export function normalizeDelegatedModel(
  runner: DelegatedRunner,
  value: unknown
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (runner === 'claude') {
    const lower = raw.toLowerCase();
    const versioned = lower.match(/^(?:claude[-_\s]*)?(opus|sonnet|haiku)[-_\s]*(\d+)[._-](\d+)$/);
    if (versioned) return `claude-${versioned[1]}-${versioned[2]}-${versioned[3]}`;
    if (['opus', 'sonnet', 'haiku', 'fable'].includes(lower)) return lower;
    if (/^\d+[._-]\d+$/.test(lower)) return undefined;
  }
  return /^[a-zA-Z0-9._-]{1,100}$/.test(raw) ? raw : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  try { return record(value ? JSON.parse(value) : {}); } catch { return {}; }
}

function pinnedCoordinationWorkflow(
  db: Db,
  originChatId: string,
  contactId: string,
  taskPath: string,
  fingerprint: string,
): WorkflowSnapshot | null {
  if (!taskPath) return null;
  const row = db.prepare(
    `SELECT json_extract(meta, '$.roomHost.workflow') AS workflow
     FROM messages
     WHERE contact_id = ? AND sender = 'room-host' AND deleted = 0
       AND json_extract(meta, '$.roomHost.coordination.kind') = 'execution'
       AND json_extract(meta, '$.roomHost.coordination.taskPath') = ?
       AND json_extract(meta, '$.roomHost.coordination.executor') = ?
       AND json_type(meta, '$.roomHost.workflow') = 'object'
     ORDER BY id DESC LIMIT 1`
  ).get(originChatId, taskPath, contactId) as { workflow?: string } | undefined;
  const value = parseRecord(row?.workflow);
  const selected = record(value.selected);
  if (
    value.taskPath !== taskPath
    || value.problemFingerprint !== fingerprint
    || typeof value.profileId !== 'string'
    || !Number.isSafeInteger(value.profileVersion)
    || typeof value.workflowFingerprint !== 'string'
    || !['claude', 'codex', 'grok'].includes(String(selected.runner))
    || typeof selected.model !== 'string'
    || typeof selected.reasoning !== 'string'
  ) return null;
  return value as unknown as WorkflowSnapshot;
}

function briefValue(value: unknown, max = 180): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(max - 1, 0))}…` : text;
}

function boolBrief(value: unknown): string {
  return typeof value === 'boolean' ? String(value) : 'unknown';
}

function jobBrief(job: JobRow): string {
  const opts = parseRecord(job.options);
  const permissions = parseRecord(job.permissions);
  const meta = parseRecord(job.delivery_meta);
  const declared = record(meta.declared);
  const git = record(meta.git);
  const checks = Array.isArray(meta.checks) ? meta.checks.map(record) : [];
  const extra = [opts.model, opts.reasoning].filter(Boolean).join('/');
  const routeClass = typeof opts.routeClass === 'string' ? opts.routeClass : '未知';
  const runnerSource = typeof opts.runnerSource === 'string' ? opts.runnerSource : '未知';
  const overrideReason = typeof opts.runnerOverrideReason === 'string' && opts.runnerOverrideReason
    ? `\nrunnerOverrideReason：${briefValue(opts.runnerOverrideReason)}` : '';
  const declaredParts = [
    `committed=${boolBrief(declared.committed)}`,
    `pushed=${boolBrief(declared.pushed)}`,
    `stage=${briefValue(declared.stage) || 'unknown'}`,
    `nextOwner=${briefValue(declared.nextOwner) || 'unknown'}`,
  ];
  const dirtyCount = Array.isArray(git.dirtyFiles)
    ? git.dirtyFiles.length
    : git.dirty === true ? 'unknown' : 0;
  const shortHead = typeof git.head === 'string' ? git.head.trim().slice(0, 8) : '';
  const gitParts = Object.keys(git).length > 0 ? [
    `HEAD=${shortHead || 'unknown'}`,
    `ahead=${typeof git.ahead === 'number' && Number.isFinite(git.ahead) ? git.ahead : 'unknown'}`,
    `behind=${typeof git.behind === 'number' && Number.isFinite(git.behind) ? git.behind : 'unknown'}`,
    `branch=${briefValue(git.branch, 80) || 'detached/unknown'}`,
    `dirty=${dirtyCount}`,
  ] : ['未上送（旧 runner）'];
  const failedChecks = checks.filter((item) => item.pass === false);
  return [
    `任务 ${job.id}`,
    `状态：${job.status} / ${job.delivery_state ?? 'unknown'}`,
    `runner：${job.runner}${extra ? `（${extra}）` : ''}，workspace：${job.workspace}`,
    `routeClass：${routeClass}，runnerSource：${runnerSource}${overrideReason}`,
    `permissions：write=${boolBrief(permissions.write)}，shell=${boolBrief(permissions.shell)}，ssh=${boolBrief(permissions.ssh)}`,
    `declared：${declaredParts.join('，')}`,
    `git：${gitParts.join('，')}`,
    ...failedChecks.map((item) => (
      `机检未通过：${briefValue(item.id, 80)} — ${briefValue(item.detail)}`
    )),
    job.worker_id ? `worker：${job.worker_id}` : 'worker：待认领',
  ].join('\n');
}

/** 派单 authority 的 TTL：旧派单即便未被新版取代，超时后也不再构成授权。 */
const DEFAULT_DISPATCH_TTL_HOURS = 24;
const MAX_DISPATCH_TTL_HOURS = 24 * 7;

function coordinationDispatchTtlHours(roomConfig: Record<string, unknown>): number {
  const value = Number(record(roomConfig.coordination).dispatchTtlHours);
  if (!Number.isFinite(value)) return DEFAULT_DISPATCH_TTL_HOURS;
  return Math.min(Math.max(value, 1), MAX_DISPATCH_TTL_HOURS);
}

/**
 * Coordination-marker prompt 的工具层硬闸（不再只靠 prompt 约束）：
 * 只有会议室里最新一张对应 taskPath 的 room-host 执行派单消息里点名的
 * executor，才能用该 marker 派单；fingerprint/taskPath 不匹配（伪造/跨 task）、
 * 已被新版派单取代（过期）、超过派单 TTL、workspace 与派单不符，
 * 一律拒绝并留审计。派单消息本体由网关生成（roomHost meta 只受服务端控制），
 * 是可信 authority 源；member/verifier 无论 prompt 被注入成什么样都拿不到这条授权。
 */
function coordinationDelegateGate(
  db: Db,
  contactId: string,
  prompt: string,
  workspace: string,
  logger?: HubLogger
): { ok: true } | { ok: false; text: string } {
  const marker = parseCoordinationMarker(prompt);
  if (!marker) return { ok: true };
  const reject = (reason: string, detail: Record<string, unknown> = {}): { ok: false; text: string } => {
    logger?.warn({
      component: 'coordination-delegate-gate',
      contactId,
      taskPath: marker.taskPath,
      dispatchKey: coordinationMarkerDispatchKey(marker),
      reason,
      ...detail,
    }, 'coordination delegate rejected');
    return { ok: false, text: `coordination 派单校验失败：${reason}` };
  };
  const dispatchKey = coordinationMarkerDispatchKey(marker);
  const row = db.prepare(
    `SELECT messages.idempotency_key, messages.meta, messages.created_at,
            contacts.config AS room_config
     FROM messages
     JOIN contacts ON contacts.id = messages.contact_id
     WHERE messages.sender = 'room-host'
       AND contacts.kind = 'room'
       AND json_extract(messages.meta, '$.roomHost.coordination.kind') = 'execution'
       AND json_extract(messages.meta, '$.roomHost.coordination.taskPath') = ?
     ORDER BY messages.id DESC LIMIT 1`
  ).get(marker.taskPath) as {
    idempotency_key: string | null;
    meta: string;
    created_at: string;
    room_config: string | null;
  } | undefined;
  if (!row) {
    return reject('找不到这张任务的会议室执行派单；不能凭 marker 自派 coordination 任务');
  }
  if (row.idempotency_key !== dispatchKey) {
    return reject('fingerprint 与最新派单不符（伪造或已被新版任务取代）', {
      latestKey: row.idempotency_key,
    });
  }
  const ttlHours = coordinationDispatchTtlHours(parseRecord(row.room_config));
  const dispatchedAtMs = Date.parse(`${String(row.created_at ?? '').replace(' ', 'T')}Z`);
  if (!Number.isFinite(dispatchedAtMs)) {
    return reject('派单时间戳无效，无法核验 TTL', { dispatchedAt: row.created_at });
  }
  if (Date.now() - dispatchedAtMs > ttlHours * 3_600_000) {
    return reject(`执行派单已过期（超过 ${ttlHours} 小时 TTL）；请 room-host 重新派单后再委派`, {
      dispatchedAt: row.created_at,
      ttlHours,
    });
  }
  let dispatch;
  try {
    dispatch = normalizeRoomCoordinationDispatch(JSON.parse(row.meta)?.roomHost?.coordination);
  } catch {
    dispatch = null;
  }
  if (dispatch?.kind !== 'execution') {
    return reject('派单元数据无效或不是执行派单');
  }
  if (dispatch.executor !== contactId) {
    return reject(`这张派单的 executor 是 @${dispatch.executor}，member/verifier 不得代为委派`, {
      executor: dispatch.executor,
    });
  }
  if (canonicalWorkspacePath(workspace) !== canonicalWorkspacePath(dispatch.workspace)) {
    return reject('workspace 与派单绑定不符', { boundWorkspace: dispatch.workspace });
  }
  return { ok: true };
}

export function buildDelegateTools(
  store: JobStore,
  db: Db,
  contactId: string,
  cfg: DelegationCfg,
  /** 委派发生的聊天 id（群里是 room id）——任务 thread 挂回这个聊天。 */
  originChatId: string = contactId,
  logger?: HubLogger
): GatewayTool[] {
  const workspaces = Array.isArray(cfg.workspaces) ? cfg.workspaces.filter(Boolean) : [];
  const runners = Array.isArray(cfg.runners) && cfg.runners.length ? cfg.runners : ['claude', 'codex', 'grok'];
  const maxOpen = Math.min(Math.max(Number(cfg.maxOpenJobs) || 3, 1), 10);

  const ownJob = (jobId: unknown): { job?: JobRow; reason?: string } => {
    const job = typeof jobId === 'string' ? store.get(jobId.trim()) : undefined;
    if (!job) return { reason: `没有找到任务 ${jobId}` };
    if (job.requested_by !== contactId) return { reason: '这个任务不是你派的，动不了' };
    return { job };
  };

  return [
    {
      name: 'delegate_to_worker',
      description:
        `把一个编码/文件任务派给 User 本机的 PC Worker 执行（那边有正式 git 仓库和 CLI agent）。` +
        `派单后任务进入持久队列，PC 离线也不会丢；结果回来时网关会自动通知你验收。` +
        `${ROUTE_POLICY_TEXT}可用 workspace：${workspaces.join('、') || '（未配置）'}。` +
        `prompt 要自包含：写清楚目标、验收标准、commit/push 与部署要求。` +
        (cfg.allowSsh === true
          ? ' 需要访问 VPS 时显式传 ssh=true，并在 prompt 写清主机、checkout、服务和验收。'
          : ' 当前未开放 SSH；需要远程部署时只能留下 deploy-tail。'),
      schema: {
        type: 'object',
        properties: {
          route_class: {
            type: 'string',
            enum: ROUTE_CLASS_VALUES,
            description: ROUTE_POLICY_TEXT,
          },
          runner: { type: 'string', enum: runners, description: '可选；不填时按 route_class 默认路由表推出' },
          runner_override_reason: {
            type: 'string',
            description: '偏离 route_class 默认 runner 时必填的非空理由；会写入 job 元数据',
          },
          workspace: { type: 'string', description: 'PC 上的项目路径，必须在白名单内' },
          prompt: { type: 'string', description: '自包含的任务描述（目标/约束/验收标准）' },
          write: {
            type: 'boolean',
            description: '是否允许修改文件；默认 true。诊断、盘点、验收等只读任务必须显式传 false',
          },
          shell: {
            type: 'boolean',
            description:
              '是否允许执行 shell 命令。codex 自动为 true；claude 不填就完全拿不到 Bash，只要 prompt 里含构建、测试、git 或部署任何一项就必须显式传 true',
          },
          ssh: {
            type: 'boolean',
            description: cfg.allowSsh === true
              ? '是否允许 SSH/VPS 操作；远程部署必须显式 true'
              : '当前联系人未开放 SSH；传 true 会被拒绝',
          },
          priority: { type: 'number', description: '-10~10，默认 0' },
          model: {
            type: 'string',
            description:
              '覆盖当前 Workflow Profile 的模型。Claude 固定版本必须写清系列和版本，例如 Opus 4.7 或 claude-opus-4-7；用户指定版本时禁止用会漂移的 opus/sonnet 别名代替。Codex 例如 gpt-5.6-sol。',
          },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], description: '推理强度（claude: effort，codex/grok: reasoning_effort）；不填时按当前 Workflow Profile' },
          problem_fingerprint: {
            type: 'string',
            description: '可选的同一问题稳定指纹（64 位 sha256）；coordination 任务默认从 planHash 推出',
          },
        },
        required: ['route_class', 'workspace', 'prompt'],
      },
      exec: async (input) => {
        const routeClass = ROUTE_CLASS_VALUES.includes(input.route_class as RouteClass)
          ? input.route_class as RouteClass : null;
        if (!routeClass) return { ok: false, text: ROUTE_CLASS_REQUIRED_ERROR };
        if (workspaces.length === 0)
          return { ok: false, text: '你的委派白名单是空的——让 User 在联系人配置 delegation.workspaces 里加上允许的路径。' };
        const taskPath = coordinationTaskPath(String(input.prompt ?? '')) ?? '';
        const suppliedProblemFingerprint = typeof input.problem_fingerprint === 'string'
          && /^[a-f0-9]{64}$/i.test(input.problem_fingerprint.trim())
          ? input.problem_fingerprint.trim().toLowerCase()
          : undefined;
        if (input.problem_fingerprint !== undefined && !suppliedProblemFingerprint) {
          return { ok: false, text: 'problem_fingerprint 必须是 64 位 sha256。' };
        }
        const fingerprint = suppliedProblemFingerprint
          ?? problemFingerprint(String(input.prompt ?? ''), taskPath);
        const workflow = pinnedCoordinationWorkflow(
          db,
          originChatId,
          contactId,
          taskPath,
          fingerprint,
        ) ?? store.workflowProfiles.snapshot({
          stage: stageForRouteClass(routeClass),
          taskPath,
          problemFingerprint: fingerprint,
        });
        const expectedRunner = workflow.selected.runner;
        const explicitRunner = input.runner === undefined
          ? undefined
          : RUNNER_VALUES.includes(input.runner as DelegatedRunner)
            ? input.runner as DelegatedRunner
            : null;
        if (explicitRunner === null)
          return { ok: false, text: `runner 必须是 ${RUNNER_VALUES.join('/')}` };
        const overrideProvided = input.runner_override_reason !== undefined;
        const overrideReason = typeof input.runner_override_reason === 'string'
          ? input.runner_override_reason.trim() : '';
        if (overrideProvided && !overrideReason) {
          return { ok: false, text: 'runner_override_reason 必须是非空字符串。' };
        }
        const runner = explicitRunner ?? expectedRunner;
        if (runner !== expectedRunner && !overrideReason) {
          return {
            ok: false,
            text:
              `runner 路由违规：route_class=${routeClass} 与 runner=${runner}；` +
              `正确默认是 ${expectedRunner}。若确需覆盖，显式传非空 runner_override_reason。`,
          };
        }
        if (!runners.includes(runner))
          return { ok: false, text: `runner=${runner} 未在该联系人的可用配置中（${runners.join('/')}）` };
        const runnerSource: RunnerSource = overrideReason ? 'override' : 'policy';
        const workspace = typeof input.workspace === 'string' ? input.workspace.trim() : '';
        if (!workspace || !workspaceAllowed(workspace, workspaces))
          return { ok: false, text: `workspace 不在白名单内。可用：${workspaces.join('、')}` };
        const coordinationGate = coordinationDelegateGate(
          db, contactId, String(input.prompt ?? ''), workspace, logger
        );
        if (!coordinationGate.ok) return coordinationGate;
        const wantWrite = input.write !== false;
        const grokExecutionNeedsShell = runner === 'grok'
          && (workflow.stage === 'execute' || workflow.stage === 'fix');
        const wantShell = input.shell === true || runner === 'codex' || grokExecutionNeedsShell;
        if (wantShell && cfg.allowShell !== true)
          return { ok: false, text: 'Shell 能力没开（联系人配置 delegation.allowShell）。claude 任务可以不带 shell 再试。' };
        const wantSsh = input.ssh === true;
        if (wantSsh && cfg.allowSsh !== true)
          return { ok: false, text: 'SSH 能力没开（联系人配置 delegation.allowSsh）。不能把远程部署伪装成普通 Shell；请留下 deploy-tail。' };
        // 派单瞬间聊天里的最后一条消息（通常是本轮的 tool_use 气泡）当锚点
        const anchor = db
          .prepare('SELECT MAX(id) AS m FROM messages WHERE contact_id = ? AND deleted = 0')
          .get(originChatId) as { m: number | null };
        const model = normalizeDelegatedModel(runner, input.model);
        if (input.model !== undefined && !model) {
          return {
            ok: false,
            text: 'model 无效。Claude 固定版本请同时写系列和版本，例如 Opus 4.7 或 claude-opus-4-7；不能只写 4.7。',
          };
        }
        const effort = typeof input.effort === 'string' && ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(input.effort)
          ? input.effort : undefined;
        if (effort === 'ultra' && runner !== 'codex') {
          return { ok: false, text: 'ultra 当前只对 Codex runner 开放。' };
        }
        const defaults = runner === workflow.selected.runner
          ? { model: workflow.selected.model, effort: workflow.selected.reasoning }
          : RUNNER_DEFAULTS[runner];
        const finalModel = model ?? defaults?.model;
        const finalEffort = effort ?? defaults?.effort;
        const created = store.create({
          requestedBy: contactId,
          runner,
          workspace,
          prompt: String(input.prompt ?? ''),
          workerId: cfg.workerId || null,
          priority: Number(input.priority) || 0,
          permissions: { write: wantWrite, shell: wantShell, ssh: wantSsh },
          options: {
            ...(finalModel ? { model: finalModel } : {}),
            ...(finalEffort ? { reasoning: finalEffort } : {}),
            routeClass,
            runnerSource,
            ...(overrideReason ? { runnerOverrideReason: overrideReason } : {}),
            workflowStage: workflow.stage,
            taskPath,
            problemFingerprint: fingerprint,
            workflow,
          },
          originContactId: originChatId,
          originAnchorId: anchor.m ?? null,
          maxOpenJobs: maxOpen,
        });
        if ('error' in created) return { ok: false, text: created.error };
        if (created.merged) {
          return {
            ok: true,
            text:
              `${jobBrief(created.job)}\n已并入在途 job；同一 taskPath 不再新建第二张。` +
              (created.queueWarning ? `\n⚠ ${created.queueWarning}` : ''),
          };
        }
        return {
          ok: true,
          text:
            `${jobBrief(created.job)}\n已进入队列。PC 在线会自动认领；离线则等它上线。` +
            `结果回来网关会通知你，本回合不用等——先把已派单的事告诉 User。` +
            (created.queueWarning ? `\n⚠ ${created.queueWarning}` : ''),
        };
      },
    },
    {
      name: 'worker_job_status',
      description: '查询你派出的 Worker 任务状态、最近日志，并用 result_offset/result_limit 分页 recall 完整回执。',
      schema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'delegate_to_worker 返回的任务 id' },
          result_offset: { type: 'integer', minimum: 0, description: '完整回执起始字符 offset；默认 0' },
          result_limit: { type: 'integer', minimum: 1, maximum: 12000, description: '本页字符数；默认 4000，最大 12000' },
        },
        required: ['job_id'],
      },
      exec: async (input) => {
        store.reap();
        const { job, reason } = ownJob(input.job_id);
        if (!job) return { ok: false, text: reason ?? '任务不存在' };
        const tail = (store.messages(job.id, 8) as { sender: string; kind: string; content: string }[])
          .map((m) => `[${m.sender}/${m.kind}] ${m.content.slice(0, 300)}`)
          .join('\n');
        const payload = job.result ?? job.error ?? '';
        const payloadLabel = job.result ? 'result' : job.error ? 'error' : 'empty';
        const requestedOffset = Number(input.result_offset);
        const requestedLimit = Number(input.result_limit);
        const offset = Number.isFinite(requestedOffset) ? Math.max(Math.floor(requestedOffset), 0) : 0;
        const limit = Number.isFinite(requestedLimit)
          ? Math.min(Math.max(Math.floor(requestedLimit), 1), 12_000)
          : 4_000;
        const start = Math.min(offset, payload.length);
        const end = Math.min(start + limit, payload.length);
        const page = payload.slice(start, end);
        const outcome = payload
          ? [
              `\n完整回执片段（${payloadLabel} ${start}-${end}/${payload.length}）：`,
              page,
              end < payload.length
                ? `下一页：worker_job_status(job_id="${job.id}", result_offset=${end}, result_limit=${limit})`
                : '已到全文末尾。',
            ].join('\n')
          : '\n完整回执：（无输出）';
        return { ok: true, text: `${jobBrief(job)}${outcome}\n最近事件：\n${tail || '（还没有事件）'}` };
      },
    },
    {
      name: 'worker_job_cancel',
      description: '取消你自己派出的、还没完成的 Worker 任务。',
      schema: {
        type: 'object',
        properties: { job_id: { type: 'string', description: '要取消的任务 id' } },
        required: ['job_id'],
      },
      exec: async (input) => {
        const { job, reason } = ownJob(input.job_id);
        if (!job) return { ok: false, text: reason ?? '任务不存在' };
        const outcome = store.action(job.id, 'cancel', contactId);
        if ('error' in outcome) return { ok: false, text: outcome.error };
        return { ok: true, text: `任务 ${job.id} → ${outcome.status}` };
      },
    },
    {
      name: 'worker_job_update_delivery',
      description: '事后修正你派出的 Worker 任务交付结论，例如已上线、已闭环、等待决定或需要返工。',
      schema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'delegate_to_worker 返回的任务 id' },
          stage: {
            type: 'string',
            enum: ['delivered_waiting_deploy', 'online_waiting_validation', 'closed_loop', 'user_decision', 'rework_required'],
          },
          summary: { type: 'string', description: '给人看的交付结论' },
          next_owner: { type: 'string', description: '下一步唯一负责人' },
          blocker: { type: 'string', description: '可选阻塞原因' },
        },
        required: ['job_id', 'stage'],
      },
      exec: async (input) => {
        const { job, reason } = ownJob(input.job_id);
        if (!job) return { ok: false, text: reason ?? '任务不存在' };
        const outcome = store.updateDelivery(job.id, contactId, {
          stage: String(input.stage ?? ''),
          summary: typeof input.summary === 'string' ? input.summary : undefined,
          nextOwner: typeof input.next_owner === 'string' ? input.next_owner : undefined,
          blocker: typeof input.blocker === 'string' ? input.blocker : undefined,
        });
        if ('error' in outcome) return { ok: false, text: outcome.error };
        return { ok: true, text: `任务 ${job.id} 的交付结论已更新为 ${input.stage}` };
      },
    },
  ];
}

/** 注入 system prompt 的委派规范；toolPrefix 是该后端下工具的实际名字前缀（MCP 是 mcp__hub__）。 */
export function delegationGuidance(cfg: DelegationCfg, toolPrefix = ''): string {
  const p = (n: string) => `${toolPrefix}${n}`;
  const remoteDelivery = cfg.allowSsh === true
    ? `- SSH 已开放：需要远程部署时 ${p('delegate_to_worker')} 必须传 ssh=true，并在 prompt 写清 repo、branch、host、checkout、service 与 post-deploy 验收；同一 job 完成，禁止用 tail 提前交付。`
    : '- delegation.allowSsh=false：Worker 禁止远程操作；代码 push 后如仍需部署，登记精确 deploy-tail（repo、branch、commit、host、checkout、service、验收），不得声称 Worker 已被授权部署。';
  return [
    '',
    '# 编码任务外派规范（网关注入）',
    `- 代码修改用 ${p('delegate_to_worker')} 交给 PC Worker；白名单：${(cfg.workspaces ?? []).join('、') || '（未配置）'}。`,
    `- ${ROUTE_POLICY_TEXT} ${p('delegate_to_worker')} 必须显式传 route_class；runner 可省略并由服务端按表推出。`,
    '- 委派 prompt 写清目标、边界、验证与交付。验证全绿后只暂存本任务文件，commit、push；需要且权限允许时继续部署、重启并做 post-deploy 验收。验证失败不提交推送，回报具体错误；仅 User 当次明确要求时覆盖。',
    remoteDelivery,
    '- Worker 进程结束不等于完成：验证、commit、push 或所需部署缺失且留下本任务改动时必须 blocked，回执写清文件、检查、原因与下一步；网关会自动登记 worker-tail。',
    '- 禁止直接编辑 VPS /opt checkout；远端只读诊断，代码必须从 Git 发布。',
    `- User 指定 Claude 具体版本时，${p('delegate_to_worker')} 的 model 必须 pin 完整版本（例如 Opus 4.6 → claude-opus-4-6），不得擅自改成会随最新版本漂移的 opus/sonnet 别名。`,
    `- 派单后结束本回合并说明派了什么；回执到达后以回执和 ${p('worker_job_status')} 的 delivery/commit/push 为权威，不再用终端、git fetch 或 VPS 重验。新证据用 ${p('worker_job_update_delivery')} 回写。`,
    '- 只按本任务交付判定：全部要求完成，或合法 deploy-tail 已登记，才关闭原 backlog；其他任务的脏文件不影响本任务结论。验收失败且原因明确才续派。',
    '- deploy-tail 只允许三种情况：(1) delegation.allowSsh=false，任务没有远程权限；(2) 重启 PC Worker 或当前 ai-hub gateway 会切断本任务回执；(3) 宿主要求 exact-target 授权且任务必须在确认前结束。其他已获权限、不会自断回执的部署必须在同一 Worker job 内完成，禁止用 tail 提前交付。',
    '- 合法 deploy-tail 用 memory_vault add_task 登记：slug deploy-{repo}-{shortsha}、tag deploy-tail，写清 repo、branch、commit、host、checkout、service、阻塞类型与验收；无 vault 工具则写进回执。',
  ].join('\n');
}

/** 只有项目写权限、没有委派工具的联系人：至少立好 git 纪律。 */
export const PROJECT_WRITE_GIT_GUARD = [
  '',
  '# 项目写权限纪律（网关注入）',
  '- 你改动的目录是 git 检出。完成代码改动后先运行相关构建/测试；验证通过后检查 diff，只暂存本任务文件、commit 并 push 当前分支，绝不留未提交的散装文件。',
  '- 验证失败时不 commit、不 push，回报具体错误；不得把无关的旧改动或未跟踪文件扫进本次提交。',
  '- User 明确要求不提交/不推送或指定其他发布顺序时，以她的当次指令为准。',
  '- 没法 push 时（没有凭据等），明确告诉 User 有哪些改动没进仓库，让她安排同步。',
  '- 验证、commit 或 push 任一步未完成且留下本任务相关改动时，必须在汇报前用 memory_vault 创建或更新 backlog/worker-tail，写清 workspace、文件、检查、阻塞和下一步；没有 vault 工具时把这些字段完整写进汇报。',
  '- push 完成且改动需要部署/重启才生效时，用 memory_vault 的 add_task 登记部署尾巴（slug deploy-{repo}-{shortsha}、tag deploy-tail、正文写清仓库/commit/部署方式/验证方式，协议见记忆库 _meta/rules.md），不要催 User 手动部署；没有 vault 工具时在汇报里写明这四项。',
].join('\n');
