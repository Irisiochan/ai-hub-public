import type { Db, JobRow } from '../db.js';
import { JobStore, workspaceAllowed } from '../workers/jobStore.js';

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
  /** SSH 等高影响能力，必须由用户在联系人配置里单独打开 */
  allowSsh?: boolean;
  /** 固定派给某个 worker（默认任意在线 worker 认领） */
  workerId?: string;
  /** 同一联系人同时在跑/在排的任务上限，防委派循环 */
  maxOpenJobs?: number;
}

const OPEN_STATUSES = "('pending','claimed','running','pause_requested','cancel_requested')";

/**
 * Accept human-readable Claude versions without letting a pinned version fall
 * back to the moving `opus` / `sonnet` aliases.
 */
export function normalizeDelegatedModel(
  runner: 'claude' | 'codex' | 'grok',
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

function jobBrief(job: JobRow): string {
  const opts = JSON.parse(job.options || '{}');
  const extra = [opts.model, opts.reasoning].filter(Boolean).join('/');
  return [
    `任务 ${job.id}`,
    `状态：${job.status}`,
    `runner：${job.runner}${extra ? `（${extra}）` : ''}，workspace：${job.workspace}`,
    job.worker_id ? `worker：${job.worker_id}` : 'worker：待认领',
  ].join('\n');
}

export function buildDelegateTools(
  store: JobStore,
  db: Db,
  contactId: string,
  cfg: DelegationCfg,
  /** 委派发生的聊天 id（群里是 room id）——任务 thread 挂回这个聊天。 */
  originChatId: string = contactId
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
        `把一个编码/文件任务派给用户自己的 PC Worker 执行（那里有正式 git 仓库和 CLI agent）。` +
        `派单后任务进入持久队列，PC 离线也不会丢；结果回来时网关会自动通知你验收。` +
        `可用 runner：${runners.join('/')}；可用 workspace：${workspaces.join('、') || '（未配置）'}。` +
        `prompt 要自包含：写清楚目标、验收标准、改完是否要 commit/push。`,
      schema: {
        type: 'object',
        properties: {
          runner: { type: 'string', enum: runners, description: '本机执行方' },
          workspace: { type: 'string', description: 'PC 上的项目路径，必须在白名单内' },
          prompt: { type: 'string', description: '自包含的任务描述（目标/约束/验收标准）' },
          shell: { type: 'boolean', description: '是否允许执行 shell 命令（codex 必须 true）' },
          priority: { type: 'number', description: '-10~10，默认 0' },
          model: {
            type: 'string',
            description:
              '覆盖 Worker 默认模型。Claude 固定版本必须写清系列和版本，例如 Opus 4.6 或 claude-opus-4-6；用户指定版本时禁止用会漂移的 opus/sonnet 别名代替。Codex 例如 gpt-5.6-sol。',
          },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: '推理强度（claude: effort，codex: reasoning_effort）；不填用默认值' },
        },
        required: ['runner', 'workspace', 'prompt'],
      },
      exec: async (input) => {
        if (workspaces.length === 0)
          return { ok: false, text: '委派白名单为空——请让用户在联系人配置 delegation.workspaces 中添加允许的路径。' };
        const runner = ['claude', 'codex', 'grok'].includes(input.runner as string)
          ? (input.runner as 'claude' | 'codex' | 'grok')
          : null;
        if (!runner || !runners.includes(runner))
          return { ok: false, text: `runner 必须是 ${runners.join('/')}` };
        const workspace = typeof input.workspace === 'string' ? input.workspace.trim() : '';
        if (!workspace || !workspaceAllowed(workspace, workspaces))
          return { ok: false, text: `workspace 不在白名单内。可用：${workspaces.join('、')}` };
        const wantShell = input.shell === true || runner === 'codex';
        if (wantShell && cfg.allowShell !== true)
          return { ok: false, text: 'Shell 能力没开（联系人配置 delegation.allowShell）。claude 任务可以不带 shell 再试。' };
        const open = db
          .prepare(
            `SELECT COUNT(*) AS c FROM jobs WHERE requested_by = ? AND deleted = 0 AND status IN ${OPEN_STATUSES}`
          )
          .get(contactId) as { c: number };
        if (open.c >= maxOpen)
          return { ok: false, text: `你已有 ${open.c} 个任务在队列里，先用 worker_job_status 看看它们，别刷屏。` };

        // 派单瞬间聊天里的最后一条消息（通常是本轮的 tool_use 气泡）当锚点
        const anchor = db
          .prepare('SELECT MAX(id) AS m FROM messages WHERE contact_id = ? AND deleted = 0')
          .get(originChatId) as { m: number | null };
        const model = normalizeDelegatedModel(runner, input.model);
        if (input.model !== undefined && !model) {
          return {
            ok: false,
            text: 'model 无效。Claude 固定版本请同时写系列和版本，例如 Opus 4.6 或 claude-opus-4-6；不能只写 4.6。',
          };
        }
        const effort = typeof input.effort === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(input.effort)
          ? input.effort : undefined;
        const created = store.create({
          requestedBy: contactId,
          runner,
          workspace,
          prompt: String(input.prompt ?? ''),
          workerId: cfg.workerId || null,
          priority: Number(input.priority) || 0,
          permissions: { write: true, shell: wantShell, ssh: false }, // ssh 必须由用户手动派，不给模型
          options: model || effort ? { model, reasoning: effort } : undefined,
          originContactId: originChatId,
          originAnchorId: anchor.m ?? null,
        });
        if ('error' in created) return { ok: false, text: created.error };
        return {
          ok: true,
          text:
            `${jobBrief(created.job)}\n已进入队列。PC 在线会自动认领；离线则等它上线。` +
            `结果回来网关会通知你，本回合不用等——先把已派单的事告诉用户。`,
        };
      },
    },
    {
      name: 'worker_job_status',
      description: '查询你派出的 Worker 任务的状态、最近日志和结果。',
      schema: {
        type: 'object',
        properties: { job_id: { type: 'string', description: 'delegate_to_worker 返回的任务 id' } },
        required: ['job_id'],
      },
      exec: async (input) => {
        store.reap();
        const { job, reason } = ownJob(input.job_id);
        if (!job) return { ok: false, text: reason ?? '任务不存在' };
        const tail = (store.messages(job.id, 8) as { sender: string; kind: string; content: string }[])
          .map((m) => `[${m.sender}/${m.kind}] ${m.content.slice(0, 300)}`)
          .join('\n');
        const outcome = job.result ? `\n结果：\n${job.result.slice(0, 4000)}` : job.error ? `\n错误：${job.error.slice(0, 1000)}` : '';
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
  ];
}

/** 注入 system prompt 的委派规范；toolPrefix 是该后端下工具的实际名字前缀（MCP 是 mcp__hub__）。 */
export function delegationGuidance(cfg: DelegationCfg, toolPrefix = ''): string {
  const p = (n: string) => `${toolPrefix}${n}`;
  return [
    '',
    '# 编码任务外派规范（网关注入）',
    `- 涉及代码或文件修改的任务，用 ${p('delegate_to_worker')} 派给用户自己的 PC Worker。`,
    '- 委派 prompt 必须自包含，写清目标、约束、验收标准，以及是否需要 commit/push。',
    '- Worker 进程结束不等于交付完成；根据回执中的测试、工作区和版本控制状态验收。',
    '- 不要编辑部署目录中的检出副本；把代码改动放在白名单内的正式工作区。',
    `- 白名单 workspace：${(cfg.workspaces ?? []).join('、') || '（未配置）'}。`,
    `- 用户指定具体模型版本时，${p('delegate_to_worker')} 的 model 必须固定完整版本，不得换成会漂移的别名。`,
    `- 派单后先告诉用户任务已进入队列；收到回执后，需要时用 ${p('worker_job_status')} 查详情并给出明确验收结论。`,
    '- 不要因收到回执就自动重复派单；只有验收失败且续接范围明确时才重试。',
  ].join('\n');
}

/** 只有项目写权限、没有委派工具的联系人：至少立好 git 纪律。 */
export const PROJECT_WRITE_GIT_GUARD = [
  '',
  '# 项目写权限纪律（网关注入）',
  '- 你改动的目录是 git 检出。完成代码改动后先运行相关构建/测试；验证通过后检查 diff，只暂存本任务文件、commit 并 push 当前分支，绝不留未提交的散装文件。',
  '- 验证失败时不 commit、不 push，回报具体错误；不得把无关的旧改动或未跟踪文件扫进本次提交。',
  '- 用户明确要求不提交、不推送或指定其他发布顺序时，以当次指令为准。',
  '- 无法 push 时，明确说明哪些改动尚未同步以及原因。',
  '- 验证、commit 或 push 任一步未完成时，回报 workspace、相关文件、已运行检查、阻塞原因和下一步。',
].join('\n');
