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
  runners?: ('claude' | 'codex')[];
  allowShell?: boolean;
  /** SSH 回 VPS 等高影响能力，必须 User 在联系人配置里单独打开 */
  allowSsh?: boolean;
  /** 固定派给某个 worker（默认任意在线 worker 认领） */
  workerId?: string;
  /** 同一联系人同时在跑/在排的任务上限，防委派循环 */
  maxOpenJobs?: number;
}

const OPEN_STATUSES = "('pending','claimed','running','pause_requested','cancel_requested')";

function jobBrief(job: JobRow): string {
  return [
    `任务 ${job.id}`,
    `状态：${job.status}`,
    `runner：${job.runner}，workspace：${job.workspace}`,
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
  const runners = Array.isArray(cfg.runners) && cfg.runners.length ? cfg.runners : ['claude', 'codex'];
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
        },
        required: ['runner', 'workspace', 'prompt'],
      },
      exec: async (input) => {
        if (workspaces.length === 0)
          return { ok: false, text: '你的委派白名单是空的——让 User 在联系人配置 delegation.workspaces 里加上允许的路径。' };
        const runner = input.runner === 'claude' ? 'claude' : input.runner === 'codex' ? 'codex' : null;
        if (!runner || !runners.includes(runner))
          return { ok: false, text: `runner 必须是 ${runners.join('/')}` };
        const workspace = typeof input.workspace === 'string' ? input.workspace.trim() : '';
        if (!workspace || !workspaceAllowed(workspace, workspaces))
          return { ok: false, text: `workspace 不在白名单内。可用：${workspaces.join('、')}` };
        const wantShell = input.shell === true || runner === 'codex';
        if (wantShell && cfg.allowShell !== true)
          return { ok: false, text: 'Shell 能力没开（联系人配置 delegation.allowShell）。claude 任务可以不带 shell 再试。' };
        const open = db
          .prepare(`SELECT COUNT(*) AS c FROM jobs WHERE requested_by = ? AND status IN ${OPEN_STATUSES}`)
          .get(contactId) as { c: number };
        if (open.c >= maxOpen)
          return { ok: false, text: `你已有 ${open.c} 个任务在队列里，先用 worker_job_status 看看它们，别刷屏。` };

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
          permissions: { write: true, shell: wantShell, ssh: false }, // ssh 永远由 User 手动派，不给模型
          originContactId: originChatId,
          originAnchorId: anchor.m ?? null,
        });
        if ('error' in created) return { ok: false, text: created.error };
        return {
          ok: true,
          text:
            `${jobBrief(created.job)}\n已进入队列。PC 在线会自动认领；离线则等它上线。` +
            `结果回来网关会通知你，本回合不用等——先把已派单的事告诉 User。`,
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
    `- 涉及代码修改的活，用 ${p('delegate_to_worker')} 派给 User 本机的 PC Worker 做——那边有正式 git 仓库，改动会走 commit/push 回 GitHub。`,
    '- 严禁直接编辑 VPS 部署目录（/opt 下的 checkout）里的代码：那里的改动不进 git，下次部署会被覆盖或造成分叉。VPS 本地只做读文件、查日志这类诊断。',
    `- 白名单 workspace：${(cfg.workspaces ?? []).join('、') || '（未配置）'}。`,
    `- 派单后本回合就结束，先告诉 User 派了什么；结果回来网关会自动通知你，届时验收并汇报，需要时用 ${p('worker_job_status')} 查详情。`,
    '- 收到任务回执后不要条件反射地再派新任务：验收失败且原因明确才考虑补一单，拿不准就先问 User。',
    '- 改动合入 master 后需要部署时，提醒 User 在 VPS 上 pull + build + restart（SSH 部署能力不在你手里）。',
  ].join('\n');
}

/** 只有项目写权限、没有委派工具的联系人：至少立好 git 纪律。 */
export const PROJECT_WRITE_GIT_GUARD = [
  '',
  '# 项目写权限纪律（网关注入）',
  '- 你改动的目录是 git 检出。所有代码改动完成后必须 git add/commit，能 push 就 push；绝不留未提交的散装文件。',
  '- 没法 push 时（没有凭据等），明确告诉 User 有哪些改动没进仓库，让她安排同步。',
].join('\n');
