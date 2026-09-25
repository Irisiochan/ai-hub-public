import { z } from 'zod';
import {
  defineGatewayTool,
  type GatewayTool,
  type Db,
  type JobRow,
  type HubLogger,
} from '../platform/index.js';
export type { GatewayTool } from '../platform/index.js';
import { JobStore, workspaceAllowed } from './jobStore.js';
import { receiptPatch, structuredReceiptFields, structuredReceiptLines } from './receiptFields.js';
import {
  problemFingerprint,
  type DelegateScope,
  moduleForRouteClass,
  legacyStageForModule,
  supportedEfforts,
  type WorkflowModuleId,
} from '../workflow/index.js';

/**
 * Gateway-executed tools exposed to contacts (phase 2 of the PC worker
 * bridge): a contact on the VPS delegates coding work to the PC worker
 * instead of editing the deployed checkout in place. One definition serves
 * both the DirectApi backend (native tool loop) and the hub MCP endpoint
 * (claude-cli contacts).
 */

export interface DelegationCfg {
  enabled?: boolean;
  /** 派单允许触碰的 workspace 白名单（PC 上的路径）。必填，空 = 不许派单。 */
  workspaces?: string[];
  runners?: ('claude' | 'codex' | 'grok' | 'opencode')[];
  allowShell?: boolean;
  /** SSH 回 VPS 等高影响能力，必须 User 在联系人配置里单独打开 */
  allowSsh?: boolean;
  /** 固定派给某个 worker（默认任意在线 worker 认领） */
  workerId?: string;
  /** 同一联系人同时在跑/在排的任务上限，防委派循环 */
  maxOpenJobs?: number;
}

type DelegatedRunner = 'claude' | 'codex' | 'grok' | 'opencode';
type RouteClass = 'implement' | 'fix' | 'review' | 'recon' | 'mechanical';
type RunnerSource = 'policy' | 'override';

const ROUTE_CLASS_VALUES = ['implement', 'fix', 'review', 'recon', 'mechanical'] as const;
const ROUTE_POLICY_TEXT =
  '默认 runner/model/effort 由当前 workflow module 绑定和 route_class 决定；偏离必须显式传非空 runner_override_reason。';
const ROUTE_CLASS_REQUIRED_ERROR =
  `route_class 必填，且必须是 ${ROUTE_CLASS_VALUES.join(' | ')}。${ROUTE_POLICY_TEXT}`;
const PAGINATION_REPEAT_WINDOW_MS = 20 * 60_000;
const PAGINATION_SEEN_MAX = 2_048;
const paginationReads = new Map<string, number>();

function recordPaginationRead(contactId: string, jobId: string, offset: number): boolean {
  const now = Date.now();
  for (const [key, seenAt] of paginationReads) {
    if (now - seenAt > PAGINATION_REPEAT_WINDOW_MS) paginationReads.delete(key);
  }
  while (paginationReads.size >= PAGINATION_SEEN_MAX) {
    const oldest = paginationReads.keys().next().value as string | undefined;
    if (!oldest) break;
    paginationReads.delete(oldest);
  }
  const key = `${contactId}:${jobId}:${offset}`;
  const repeated = paginationReads.has(key);
  paginationReads.delete(key);
  paginationReads.set(key, now);
  return repeated;
}

/** 调用方没显式传 model/effort 时补上的派单默认。 */
const RUNNER_DEFAULTS: Partial<Record<DelegatedRunner, { model: string; effort: string }>> = {
  claude: { model: 'claude-opus-5', effort: 'high' },
  codex: { model: 'gpt-5.6-sol', effort: 'high' },
  grok: { model: 'grok-4.6', effort: 'high' },
};
export function normalizeDelegatedModel(
  runner: DelegatedRunner,
  value: unknown
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  if (runner === 'claude') {
    const lower = raw.toLowerCase();
    const versioned = lower.match(/^(?:claude[-_\s]*)?(opus|sonnet|haiku|fable)[-_\s]*(\d+)[._-](\d+)$/);
    if (versioned) return `claude-${versioned[1]}-${versioned[2]}-${versioned[3]}`;
    if (['opus', 'sonnet', 'haiku', 'fable'].includes(lower)) return lower;
    if (/^\d+[._-]\d+$/.test(lower)) return undefined;
  }
  if (runner === 'opencode') {
    return /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]{1,80}$/.test(raw) && raw.length <= 120 ? raw : undefined;
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

/**
 * Model-driven workflow: room-host coordination markers no longer grant any
 * authority. Execution goes through execution_start with an accepted task
 * handoff; delegate_to_worker stays for DM/legacy callers only.
 */
export const DELEGATE_SCOPE_RETIRED_MESSAGE =
  '模块轮次派单已迁移：room-host marker 不再构成授权。先 task_handoff/task_accept 形成显式交接，再用 execution_start 启动执行（附 accepted 交接授权与 revision 守卫）。读取用 task_get/execution_get 或 worker_job_status。';

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
  const rawGit = record(meta.git);
  const git = Object.keys(rawGit).length > 0 ? rawGit : meta;
  const receipt = structuredReceiptFields(job);
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
  const shortHead = receipt.head?.slice(0, 8) ?? '';
  const gitParts = receipt.head || receipt.branch || Object.keys(rawGit).length > 0 ? [
    `HEAD=${shortHead || 'unknown'}`,
    `ahead=${typeof git.ahead === 'number' && Number.isFinite(git.ahead) ? git.ahead : 'unknown'}`,
    `behind=${typeof git.behind === 'number' && Number.isFinite(git.behind) ? git.behind : 'unknown'}`,
    `branch=${receipt.branch ?? '未报告'}`,
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
    ...structuredReceiptLines(job),
    ...failedChecks.map((item) => (
      `机检未通过：${briefValue(item.id, 80)} — ${briefValue(item.detail)}`
    )),
    job.worker_id ? `worker：${job.worker_id}` : 'worker：待认领',
  ].join('\n');
}

/**
 * Read side of the room task ledger that task-scoped job reads need. The
 * gateway passes the room task store; without it only a job's own requester
 * can read it (fail closed).
 */
export interface DelegateTaskLedger {
  getTaskById(taskId: string): { room_id: string; task_path: string } | undefined;
  isParticipant(roomId: string, contactId: string): boolean;
}

export function buildDelegateTools(
  store: JobStore,
  db: Db,
  contactId: string,
  cfg: DelegationCfg,
  /** 委派发生的聊天 id（群里是 room id）——任务 thread 挂回这个聊天。 */
  originChatId: string = contactId,
  logger?: HubLogger,
  /**
   * Module-turn delegation scope. When set, only the listed route_classes
   * may be dispatched; read-only/mechanical modules (allow:false) never
   * dispatch. Unset for DM/legacy callers, which keep contact-level behavior.
   */
  scope?: DelegateScope | null,
  taskLedger?: DelegateTaskLedger | null,
): GatewayTool[] {
  const workspaces = scope?.invocation?.workspace ? [scope.invocation.workspace]
    : Array.isArray(cfg.workspaces) ? cfg.workspaces.filter(Boolean) : [];
  const runners = scope ? ['claude', 'codex', 'grok', 'opencode']
    : Array.isArray(cfg.runners) && cfg.runners.length ? cfg.runners : ['claude', 'codex', 'grok', 'opencode'];
  const maxOpen = Math.min(Math.max(Number(cfg.maxOpenJobs) || 3, 1), 10);

  const inScope = (job: JobRow): boolean => !scope
    || (job.origin_contact_id === originChatId
      && (!scope.invocation?.taskPath || parseRecord(job.options).taskPath === scope.invocation.taskPath));

  const ownJob = (jobId: unknown): { job?: JobRow; reason?: string } => {
    const job = typeof jobId === 'string' ? store.get(jobId.trim()) : undefined;
    if (!job) return { reason: `没有找到任务 ${jobId}` };
    if (job.requested_by !== contactId) return { reason: '这个任务不是你派的，动不了' };
    if (!inScope(job)) {
      return { reason: '任务不属于当前模块会话的房间或任务范围。' };
    }
    return { job };
  };

  /**
   * Task-scoped read: the owner reads their own jobs; other authorized room
   * task participants read all jobs linked to the same room task (same room
   * only — never across rooms or private DMs). Writes stay owner-only.
   */
  const readableJob = (jobId: unknown): { job?: JobRow; reason?: string } => {
    const job = typeof jobId === 'string' ? store.get(jobId.trim()) : undefined;
    if (!job) return { reason: `没有找到任务 ${jobId}` };
    if (job.requested_by === contactId) {
      if (!inScope(job)) return { reason: '任务不属于当前模块会话的房间或任务范围。' };
      return { job };
    }
    try {
      let taskId: string | null = null;
      try {
        const link = db.prepare('SELECT task_id FROM room_task_links WHERE job_id = ?').get(job.id) as
          | { task_id: string }
          | undefined;
        taskId = link?.task_id ?? null;
      } catch { taskId = null; }
      if (!taskId) {
        const candidate = parseRecord(job.options).roomTaskId;
        taskId = typeof candidate === 'string' && candidate ? candidate : null;
      }
      if (!taskId || !taskLedger) return { reason: '这个任务不是你派的，动不了' };
      const task = taskLedger.getTaskById(taskId);
      if (!task) return { reason: '这个任务不是你派的，动不了' };
      if (scope && task.room_id !== originChatId) return { reason: '任务不属于当前模块会话的房间。' };
      if (scope?.invocation?.taskPath && task.task_path !== scope.invocation.taskPath) {
        return { reason: '任务不属于当前模块会话的任务范围。' };
      }
      if (!taskLedger.isParticipant(task.room_id, contactId)) return { reason: '这个任务不是你派的，动不了' };
      return { job };
    } catch {
      return { reason: '这个任务不是你派的，动不了' };
    }
  };

  return [
    defineGatewayTool({
      name: 'delegate_to_worker',
      description:
        `把一个编码/文件任务派给 User 本机的 PC Worker 执行（那边有正式 git 仓库和 CLI agent）。` +
        `派单后任务进入持久队列，PC 离线也不会丢；结果回来时网关会自动通知你验收。` +
        `${ROUTE_POLICY_TEXT}可用 workspace：${workspaces.join('、') || '（未配置）'}。` +
        `prompt 要自包含：写清楚目标、验收标准、commit/push 与部署要求。` +
        (cfg.allowSsh === true
          ? ' 需要访问 VPS 时显式传 ssh=true，并在 prompt 写清主机、checkout、服务和验收。'
          : ' 当前未开放 SSH；需要远程部署时只能留下 deploy-tail。'),
      inputSchema: {
        route_class: z.enum(ROUTE_CLASS_VALUES, {
          errorMap: () => ({ message: ROUTE_CLASS_REQUIRED_ERROR }),
        }).describe(ROUTE_POLICY_TEXT),
        runner: z.enum(runners as [string, ...string[]]).optional()
          .describe('可选；不填时按 route_class 默认路由表推出'),
        runner_override_reason: z.string().optional()
          .describe('偏离 route_class 默认 runner 时必填的非空理由；会写入 job 元数据'),
        workspace: z.string().describe('PC 上的项目路径，必须在白名单内'),
        prompt: z.string().describe('自包含的任务描述（目标/约束/验收标准）'),
        write: z.boolean().optional()
          .describe('是否允许修改文件；默认 true。诊断、盘点、验收等只读任务必须显式传 false'),
        shell: z.boolean().optional().describe(
          '是否允许执行 shell 命令。codex 自动为 true；claude 不填就完全拿不到 Bash，只要 prompt 里含构建、测试、git 或部署任何一项就必须显式传 true',
        ),
        ssh: z.boolean().optional().describe(cfg.allowSsh === true
          ? '是否允许 SSH/VPS 操作；远程部署必须显式 true'
          : '当前联系人未开放 SSH；传 true 会被拒绝'),
        priority: z.number().optional().describe('-10~10，默认 0'),
        model: z.string().optional().describe(
          '覆盖当前 workflow module 绑定的模型。Claude 固定版本必须写清系列和版本，例如 Opus 4.7 或 claude-opus-4-7；用户指定版本时禁止用会漂移的 opus/sonnet 别名代替。Codex 例如 gpt-5.6-sol。',
        ),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional()
          .describe('推理强度（claude: effort，codex/grok: reasoning_effort）；不填时按当前 workflow module 绑定'),
        problem_fingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/, 'problem_fingerprint 必须是 64 位 sha256。').optional()
          .describe('可选的同一问题稳定指纹（64 位 sha256）；coordination 任务默认从 planHash 推出'),
      },
      exec: async (input) => {
        const routeClass = input.route_class as RouteClass;
        // Model-driven workflow: module turns never dispatch here. The
        // room-host marker authority is retired; execution goes through
        // execution_start with an accepted task handoff. This tool stays for
        // DM/legacy callers only.
        if (scope) return { ok: false, text: DELEGATE_SCOPE_RETIRED_MESSAGE };
        if (workspaces.length === 0)
          return { ok: false, text: '你的委派白名单是空的——让 User 在联系人配置 delegation.workspaces 里加上允许的路径。' };
        const taskPath = '';
        const suppliedProblemFingerprint = typeof input.problem_fingerprint === 'string'
          ? input.problem_fingerprint.toLowerCase() : undefined;
        const fingerprint = suppliedProblemFingerprint
          ?? problemFingerprint(String(input.prompt ?? ''), taskPath);
        const workspace = typeof input.workspace === 'string' ? input.workspace.trim() : '';
        if (!workspace || !workspaceAllowed(workspace, workspaces))
          return { ok: false, text: `workspace 不在白名单内。可用：${workspaces.join('、')}` };
        const overrideReason = typeof input.runner_override_reason === 'string'
          ? input.runner_override_reason.trim() : '';
        if (input.runner_override_reason !== undefined && !overrideReason) {
          return { ok: false, text: 'runner_override_reason 必须是非空字符串。' };
        }
        const moduleId: WorkflowModuleId = moduleForRouteClass(routeClass);
        let runner: DelegatedRunner;
        let finalModel: string | undefined;
        let finalEffort: string | undefined;
        let runnerSource: RunnerSource = 'policy';
        {
          // Ordinary path: module identity from the fixed route-class mapping
          // with the current binding. Explicit runner/model/effort overrides
          // stay available here with a non-empty reason (audited).
          const invocation = store.workflowModules.invoke(moduleId, taskPath, fingerprint);
          const expectedRunner = invocation.selected.runner;
          const explicitRunner = input.runner as DelegatedRunner | undefined;
          runner = explicitRunner ?? expectedRunner;
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
          if (overrideReason) runnerSource = 'override';
          const model = normalizeDelegatedModel(runner, input.model);
          if (input.model !== undefined && !model) {
            return {
              ok: false,
              text: 'model 无效。Claude 固定版本请同时写系列和版本，例如 Opus 4.7 或 claude-opus-4-7；不能只写 4.7。',
            };
          }
          const effort = typeof input.effort === 'string' ? input.effort : undefined;
          if (effort === 'ultra' && runner !== 'codex') {
            return { ok: false, text: 'ultra 当前只对 Codex runner 开放。' };
          }
          const defaults = runner === invocation.selected.runner
            ? { model: invocation.selected.model, effort: invocation.selected.reasoning }
            : RUNNER_DEFAULTS[runner];
          finalModel = model ?? defaults?.model;
          finalEffort = effort ?? defaults?.effort;
          if (finalEffort && !supportedEfforts(runner, finalModel ?? '').includes(finalEffort)) {
            return { ok: false, text: `${runner} 模型 ${finalModel ?? ''} 不支持 effort ${finalEffort}。` };
          }
        }
        // Caller flags may only narrow the invoked module's permissions;
        // JobStore.create intersects them with the module policy, so forged
        // widening never grants authority. Contact-level operation caps and
        // worker claim caps still apply on top.
        const wantWrite = input.write !== false;
        const executionNeedsShell = (runner === 'grok' || runner === 'opencode')
          && moduleId === 'execute';
        const wantShell = input.shell === true || runner === 'codex' || executionNeedsShell;
        if (wantShell && cfg.allowShell !== true)
          return { ok: false, text: 'Shell 能力没开（联系人配置 delegation.allowShell）。claude 任务可以不带 shell 再试。' };
        const wantSsh = input.ssh === true;
        if (wantSsh && cfg.allowSsh !== true)
          return { ok: false, text: 'SSH 能力没开（联系人配置 delegation.allowSsh）。不能把远程部署伪装成普通 Shell；请留下 deploy-tail。' };
        // 派单瞬间聊天里的最后一条消息（通常是本轮的 tool_use 气泡）当锚点
        const anchor = db
          .prepare('SELECT MAX(id) AS m FROM messages WHERE contact_id = ? AND deleted = 0')
          .get(originChatId) as { m: number | null };
        const created = store.create({
          requestedBy: contactId,
          runner,
          workspace,
          prompt: String(input.prompt ?? ''),
          workerId: cfg.workerId || null,
          priority: Number(input.priority) || 0,
          // Narrow-only: JobStore.create intersects these with the invoked
          // module's permissions, so they can never widen authority.
          permissions: { write: wantWrite, shell: wantShell, ssh: wantSsh },
          options: {
            ...(finalModel ? { model: finalModel } : {}),
            ...(finalEffort ? { reasoning: finalEffort } : {}),
            routeClass,
            runnerSource,
            ...(overrideReason ? { runnerOverrideReason: overrideReason } : {}),
            workflowStage: legacyStageForModule(moduleId),
            taskPath,
            problemFingerprint: fingerprint,
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
    }),
    defineGatewayTool({
      name: 'worker_job_status',
      description: '查询你派出的 Worker 任务状态、最近日志，并用 result_offset/result_limit 分页 recall 完整回执；结果尾部给出 nextOffset/atEnd，同 offset 重复拉取会幂等标注。section=patch 分页读 Worker 从 git 直接采集的 diff 原文，核对代码时优先用它，不要让执行方转贴。',
      inputSchema: {
        job_id: z.string().describe('delegate_to_worker 返回的任务 id'),
        section: z.enum(['result', 'patch']).optional().describe('result=回执正文（默认）；patch=git diff 原文'),
        result_offset: z.number().int().min(0).optional().describe('完整回执起始字符 offset；默认 0'),
        result_limit: z.number().int().min(1).max(12000).optional().describe('本页字符数；默认 4000，最大 12000'),
      },
      exec: async (input) => {
        store.reap();
        const { job, reason } = readableJob(input.job_id);
        if (!job) return { ok: false, text: reason ?? '任务不存在' };
        const tail = (store.messages(job.id, 8) as { sender: string; kind: string; content: string }[])
          .map((m) => `[${m.sender}/${m.kind}] ${m.content.slice(0, 300)}`)
          .join('\n');
        const wantPatch = input.section === 'patch';
        const patch = wantPatch ? receiptPatch(job) : null;
        if (wantPatch && (!patch || patch.dropped)) {
          return {
            ok: false,
            text: patch?.dropped
              ? `该任务的 diff 原文超出存储上限已丢弃（原长 ${patch.chars} 字符）；按 diffstat/changedFiles 分文件核对。`
              : '该任务没有 Worker 采集的 diff（无代码变化，或 Worker 版本早于 diff 采集）。',
          };
        }
        const payload = patch ? patch.patch : job.result ?? job.error ?? '';
        const payloadLabel = patch
          ? `patch${patch.truncated ? `，原长 ${patch.chars} 已截断` : ''}`
          : job.result ? 'result' : job.error ? 'error' : 'empty';
        const sectionArg = patch ? ', section="patch"' : '';
        const offset = typeof input.result_offset === 'number' ? input.result_offset : 0;
        const limit = typeof input.result_limit === 'number' ? input.result_limit : 4_000;
        const start = Math.min(offset, payload.length);
        const end = Math.min(start + limit, payload.length);
        const page = payload.slice(start, end);
        const atEnd = end >= payload.length;
        const repeatedOffset = recordPaginationRead(contactId, patch ? `${job.id}:patch` : job.id, offset);
        const outcome = payload
          ? [
              `\n完整回执片段（${payloadLabel} ${start}-${end}/${payload.length}）：`,
              page,
              !atEnd
                ? `下一页：worker_job_status(job_id="${job.id}"${sectionArg}, result_offset=${end}, result_limit=${limit})`
                : '已到全文末尾。',
            ].join('\n')
          : '\n完整回执：（无输出）';
        const repeatNotice = repeatedOffset
          ? `\n重复分页请求：job=${job.id} offset=${offset}；本页幂等返回，请继续使用 nextOffset=${end}。`
          : '';
        const cursor = [
          `nextOffset=${end}`,
          `atEnd=${atEnd}`,
          `repeatedOffset=${repeatedOffset}`,
        ].join('\n');
        return {
          ok: true,
          text: `${jobBrief(job)}${outcome}\n最近事件：\n${tail || '（还没有事件）'}${repeatNotice}\n${cursor}`,
        };
      },
    }),
    defineGatewayTool({
      name: 'worker_job_cancel',
      description: '取消你自己派出的、还没完成的 Worker 任务。',
      inputSchema: {
        job_id: z.string().describe('要取消的任务 id'),
      },
      exec: async (input) => {
        if (scope) return { ok: false, text: '模块会话不能取消其他执行尝试；请由 User 在任务面板操作。' };
        const { job, reason } = ownJob(input.job_id);
        if (!job) return { ok: false, text: reason ?? '任务不存在' };
        const outcome = store.action(job.id, 'cancel', contactId);
        if ('error' in outcome) return { ok: false, text: outcome.error };
        return { ok: true, text: `任务 ${job.id} → ${outcome.status}` };
      },
    }),
    defineGatewayTool({
      name: 'worker_job_update_delivery',
      description: '事后修正你派出的 Worker 任务交付结论，例如已上线、已闭环、等待决定或需要返工。',
      inputSchema: {
        job_id: z.string().describe('delegate_to_worker 返回的任务 id'),
        stage: z.enum([
          'waiting_review', 'delivered_waiting_deploy', 'online_waiting_validation',
          'closed_loop', 'user_decision', 'rework_required',
        ]).describe('新的交付结论'),
        summary: z.string().optional().describe('给人看的交付结论'),
        next_owner: z.string().optional().describe('下一步唯一负责人'),
        blocker: z.string().optional().describe('可选阻塞原因'),
      },
      exec: async (input) => {
        if (scope) return { ok: false, text: '模块会话不能自行改写交付判定；由独立评审和部署凭据推进。' };
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
    }),
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
