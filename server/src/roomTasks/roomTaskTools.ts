import { z } from 'zod';
import { defineGatewayTool, type GatewayTool, type Db } from '../platform/index.js';
import type { JobStore } from '../jobs/index.js';
import { RoomTaskStore, roomTaskId, type RoomTaskDispatcher, type RoomTaskStoreOptions, type RoomTaskToolContext } from './roomTaskStore.js';
import { recordTurnCall } from './turnAttribution.js';

export type { RoomTaskToolContext };

/**
 * Native model tools for the model-driven room workflow. The same definitions
 * serve the DirectApi backend (native tool loop) and the hub MCP endpoint
 * (CLI contacts): no HTTP-only tools. Every tool authorizes the caller's
 * module/task context server-side; room-host markers never grant authority.
 */

export const ROOM_TASK_TOOL_NAMES = [
  'task_create',
  'task_import',
  'task_get',
  'task_submit_evidence',
  'task_handoff',
  'task_accept',
  'task_decline',
  'task_pass',
  'task_block',
  'task_done',
  'execution_start',
  'execution_get',
  'review_submit',
  'release_execute',
  'task_retry',
  'task_wait',
] as const;

const TASK_PATH_DESC = 'Vault 任务路径，形如 tasks/<name>.md（本室任务，不可跨室）';
const ROOM_DESC = '会议室 id（任务归属的房间）';

function fmt(outcome: unknown): { ok: boolean; text: string } {
  if (outcome && typeof outcome === 'object' && 'error' in (outcome as Record<string, unknown>)) {
    return { ok: false, text: String((outcome as { error: string }).error) };
  }
  // Keep the structured result intact. Cutting serialized JSON can hide the
  // task revision and execution/handoff ids, and also destroys the exact
  // receipts used by the end-of-turn obligation check. Large receipt text
  // is already paginated by the store; never truncate the JSON envelope.
  return { ok: true, text: JSON.stringify(outcome, null, 2) };
}

function taskIdFromOutcome(outcome: unknown): string | undefined {
  try {
    const parsed = outcome as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const task = (parsed as { task?: { id?: unknown } }).task;
    if (task && typeof task.id === 'string' && task.id) return task.id;
    const view = (parsed as { view?: { task?: { id?: unknown } } }).view;
    if (view?.task && typeof view.task.id === 'string' && view.task.id) return view.task.id;
    const handoff = (parsed as { handoff?: { task_id?: unknown } }).handoff;
    if (handoff && typeof handoff.task_id === 'string' && handoff.task_id) return handoff.task_id;
  } catch {
    // fall through
  }
  return undefined;
}

function detailFromOutcome(
  tool: string,
  args: Record<string, unknown>,
  outcome: unknown,
): string {
  try {
    const parsed = outcome as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return '';
    if (tool === 'task_handoff') {
      // Exact per-turn receipt from the structured result — never from the
      // model-facing display text, so clipping/pagination cannot drop it.
      const handoff = (parsed as { handoff?: { id?: unknown } }).handoff;
      const delivery = (parsed as { delivery?: { status?: unknown } }).delivery;
      const id = handoff && typeof handoff.id === 'string' ? handoff.id : '';
      const status = delivery && typeof delivery.status === 'string' ? delivery.status : '';
      const job = (parsed as { job?: { id?: unknown } }).job;
      if (id) return `handoff=${id} dispatch=${status}${typeof job?.id === 'string' ? ` job=${job.id}` : ''}`;
      return '';
    }
    if (tool === 'task_retry') {
      const delivery = (parsed as { delivery?: { status?: unknown } }).delivery;
      const status = delivery && typeof delivery.status === 'string' ? delivery.status : '';
      const returnedHandoff = (parsed as { handoff?: { id?: unknown } }).handoff;
      const handoffArg = typeof returnedHandoff?.id === 'string' ? returnedHandoff.id
        : typeof args.handoff_id === 'string' ? args.handoff_id : '';
      const jobArg = typeof args.job_id === 'string' ? args.job_id : '';
      if (handoffArg || jobArg) {
        return `retry handoff=${handoffArg} job=${jobArg} dispatch=${status}`.slice(0, 300);
      }
      return '';
    }
    const job = (parsed as { job?: { id?: unknown } }).job;
    if (job && typeof job.id === 'string') return `job=${job.id}`;
    if (tool === 'task_wait') {
      const waitId = (parsed as { waitId?: unknown }).waitId;
      const scope = (parsed as { scope?: unknown }).scope;
      if (typeof waitId === 'number' || typeof waitId === 'string') {
        return `wait=${String(waitId)} scope=${typeof scope === 'string' ? scope : ''}`.slice(0, 200);
      }
      return '';
    }
  } catch {
    // ignore
  }
  return '';
}

function extractTaskId(
  db: Db,
  tool: string,
  args: Record<string, unknown>,
  outText: string,
): string | undefined {
  try {
    const parsed = JSON.parse(outText) as Record<string, unknown>;
    const task = (parsed as { task?: { id?: unknown } }).task;
    if (task && typeof task.id === 'string' && task.id) return task.id;
    const view = (parsed as { view?: { task?: { id?: unknown } } }).view;
    if (view?.task && typeof view.task.id === 'string' && view.task.id) return view.task.id;
    const handoff = (parsed as { handoff?: { task_id?: unknown } }).handoff;
    if (handoff && typeof handoff.task_id === 'string' && handoff.task_id) return handoff.task_id;
  } catch {
    // fall through to args
  }
  const roomId = typeof args.room_id === 'string' ? args.room_id.trim() : '';
  const taskPath = typeof args.task_path === 'string' ? args.task_path.trim() : '';
  if (roomId && taskPath) {
    try {
      return roomTaskId(roomId, taskPath);
    } catch {
      return undefined;
    }
  }
  if (typeof args.handoff_id === 'string' && args.handoff_id) {
    try {
      const row = db.prepare('SELECT task_id FROM room_task_handoffs WHERE id = ?').get(
        String(args.handoff_id),
      ) as { task_id: string } | undefined;
      if (row?.task_id) return row.task_id;
    } catch {
      // ignore
    }
  }
  if (typeof args.job_id === 'string' && args.job_id) {
    try {
      const link = db.prepare('SELECT task_id FROM room_task_links WHERE job_id = ?').get(
        String(args.job_id),
      ) as { task_id: string } | undefined;
      if (link?.task_id) return link.task_id;
      const cb = db.prepare('SELECT task_id FROM room_task_callbacks WHERE job_id = ?').get(
        String(args.job_id),
      ) as { task_id: string } | undefined;
      if (cb?.task_id) return cb.task_id;
    } catch {
      // ignore
    }
  }
  void tool;
  return undefined;
}

function extractDetail(tool: string, args: Record<string, unknown>, outText: string): string {
  try {
    const parsed = JSON.parse(outText) as Record<string, unknown>;
    if (tool === 'task_handoff') {
      // Exact per-turn receipt: the returned handoff id plus its dispatch
      // outcome. The gate revalidates this exact handoff (pending/accepted +
      // posted ledger); historical/duplicated keys never satisfy a new turn.
      const handoff = (parsed as { handoff?: { id?: unknown } }).handoff;
      const delivery = (parsed as { delivery?: { status?: unknown } }).delivery;
      const id = handoff && typeof handoff.id === 'string' ? handoff.id : '';
      const status = delivery && typeof delivery.status === 'string' ? delivery.status : '';
      const job = (parsed as { job?: { id?: unknown } }).job;
      if (id) return `handoff=${id} dispatch=${status}${typeof job?.id === 'string' ? ` job=${job.id}` : ''}`;
    }
    if (tool === 'task_retry') {
      const delivery = (parsed as { delivery?: { status?: unknown } }).delivery;
      const status = delivery && typeof delivery.status === 'string' ? delivery.status : '';
      const returnedHandoff = (parsed as { handoff?: { id?: unknown } }).handoff;
      const handoffArg = typeof returnedHandoff?.id === 'string' ? returnedHandoff.id
        : typeof args.handoff_id === 'string' ? args.handoff_id : '';
      const jobArg = typeof args.job_id === 'string' ? args.job_id : '';
      return `retry handoff=${handoffArg} job=${jobArg} dispatch=${status}`.slice(0, 300);
    }
    const job = (parsed as { job?: { id?: unknown } }).job;
    if (job && typeof job.id === 'string') return `job=${job.id}`;
    if (tool === 'task_wait') return outText.slice(0, 200);
  } catch {
    // ignore
  }
  return '';
}

export function buildRoomTaskTools(
  db: Db,
  jobs: JobStore,
  contactId: string,
  dispatch: RoomTaskDispatcher | null = null,
  options: RoomTaskStoreOptions = {},
  toolContext: RoomTaskToolContext | null = null,
): GatewayTool[] {
  const baseContext = toolContext;
  const me = () => contactId;

  // Bound origin-turn store: the toolContext (including the origin-turn
  // nonce) was captured for THIS turn at backend build/dispatch time. There
  // is deliberately no call-time lookup of any "latest" turn and no borrowing
  // of another turn's callback scope: a stale prior-turn closure keeps its
  // own expired nonce and is rejected by the store, never upgraded.
  // The User endpoint carve-out can never ride this channel.
  const storeForCall = (): RoomTaskStore =>
    new RoomTaskStore(db, jobs, dispatch, { ...options, toolContext: baseContext, irisReadEndpoint: false });

  const traced = async (
    tool: string,
    args: Record<string, unknown>,
    run: (store: RoomTaskStore) => unknown,
  ): Promise<{ ok: boolean; text: string }> => {
    const store = storeForCall();
    const outcome = await run(store);
    const out = fmt(outcome);
    const turnId = baseContext?.turnId;
    if (out.ok && turnId && baseContext) {
      // Structured credentials first: the exact ids/statuses come from the
      // raw outcome object, never from reparsing the model-facing text.
      // Text parsing stays only as a defensive fallback for unknown shapes.
      const taskId = taskIdFromOutcome(outcome)
        ?? extractTaskId(db, tool, args, out.text);
      const detail = detailFromOutcome(tool, args, outcome)
        || extractDetail(tool, args, out.text);
      try {
        recordTurnCall(db, turnId, {
          roomId: baseContext.roomId,
          contactId,
          moduleId: baseContext.moduleId,
          tool,
          ...(taskId ? { taskId } : {}),
          ok: true,
          detail,
        });
      } catch {
        // audit is best-effort
      }
    }
    return out;
  };

  return [
    defineGatewayTool({
      name: 'task_create',
      description: '在当前会议室创建任务账本（单一状态权威）。需引用本室 User 批准的用户消息 anchor，并绑定批准工作区；创建后 plan 持有初始负责人；后续只走显式交接。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().describe(TASK_PATH_DESC),
        title: z.string().describe('任务标题'),
        requirements: z.string().describe('原始需求全文（验收标准；不可事后改写）'),
        workspace: z.string().describe('批准工作区（PC 项目绝对路径；VPS 试点仓库则是 <映射根>/<任务slug>）'),
        anchor_message_id: z.number().int().min(1).describe('本室 User 批准该任务的用户消息 id（服务端核验）'),
        baseline_sha: z.string().optional().describe(
          '起点提交（目标仓库主干的 40 位 SHA）。VPS 试点工作区必填：首个执行尝试要按它供给工作区；PC 工作区可省略',
        ),
      },
      exec: async (input) => traced('task_create', input, (store) => store.createTask({
        roomId: String(input.room_id ?? ''),
        taskPath: String(input.task_path ?? ''),
        title: String(input.title ?? ''),
        requirements: String(input.requirements ?? ''),
        workspace: String(input.workspace ?? ''),
        anchorMessageId: Number(input.anchor_message_id),
        actorContact: me(),
        baselineSha: typeof input.baseline_sha === 'string' ? input.baseline_sha : null,
      })),
    }),
    defineGatewayTool({
      name: 'task_import',
      description: '把已有 Vault 任务（含旧自动链路留下的 job）接管为显式账本。需本室 User 批准 anchor；需求以服务端读取的 Vault 原文为准；只关联服务端验证过的同室同任务 job；工作区与旧尝试不一致会被拒绝。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().describe(TASK_PATH_DESC),
        title: z.string().optional().describe('可选标题（缺省用 task_path）'),
        requirements: z.string().optional().describe('Vault 读不到原文时提供；读到则以 Vault 为准'),
        workspace: z.string().optional().describe('批准工作区；有可验证旧尝试时必须与其一致'),
        anchor_message_id: z.number().int().min(1).describe('本室 User 批准接管的用户消息 id（服务端核验）'),
      },
      exec: async (input) => traced('task_import', input, (store) => store.importTask({
        roomId: String(input.room_id ?? ''),
        taskPath: String(input.task_path ?? ''),
        title: typeof input.title === 'string' ? input.title : undefined,
        requirements: typeof input.requirements === 'string' ? input.requirements : undefined,
        workspace: typeof input.workspace === 'string' ? input.workspace : undefined,
        anchorMessageId: Number(input.anchor_message_id),
        actorContact: me(),
      })),
    }),
    defineGatewayTool({
      name: 'task_get',
      description: '读取本室任务全貌：账本状态/负责人/revision、原始需求、证据、尝试与交接历史（含 waits）；可按 job 分页拉取完整原始回执。同室参与者可读，跨室拒绝。只需状态时用 section=summary（只回 holder/status/revision/candidate/review_status/最近事件与 cost，不含需求原文与证据）。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().describe(TASK_PATH_DESC),
        section: z.enum(['summary', 'full']).optional().describe('summary=只要状态（省 token）；full=全量（默认）'),
        receipt_job_id: z.string().optional().describe('要分页读取完整回执的 job id（须归属本任务）'),
        receipt_offset: z.number().int().min(0).optional().describe('回执起始字符 offset，默认 0'),
        receipt_limit: z.number().int().min(1).max(12000).optional().describe('本页字符数，默认 4000'),
        event_limit: z.number().int().min(1).max(500).optional().describe('事件条数，默认 100'),
      },
      exec: async (input) => traced('task_get', input, (store) => store.getFull({
        roomId: String(input.room_id ?? ''),
        taskPath: String(input.task_path ?? ''),
        actorContact: me(),
        section: input.section === 'summary' ? 'summary' : undefined,
        receiptJobId: typeof input.receipt_job_id === 'string' ? input.receipt_job_id : undefined,
        receiptOffset: typeof input.receipt_offset === 'number' ? input.receipt_offset : undefined,
        receiptLimit: typeof input.receipt_limit === 'number' ? input.receipt_limit : undefined,
        eventLimit: typeof input.event_limit === 'number' ? input.event_limit : undefined,
      })),
    }),
    defineGatewayTool({
      name: 'task_submit_evidence',
      description: '向任务追加证据（只增不改；不改写旧 Worker 申报，不把失败翻成通过）。结论一律从 job 行推导。kind=candidate 由负责人显式 pin 实现版本（需 ref 实现 job + expected_revision），并作废旧批准。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().describe(TASK_PATH_DESC),
        kind: z.enum(['note', 'receipt_ref', 'review_note', 'delivery_note', 'candidate']).describe('证据类型'),
        ref: z.string().optional().describe('引用（job id / SHA / 证据 id）；candidate 必填实现 job id'),
        body: z.string().describe('证据正文；candidate 填完整 40 位 SHA'),
        expected_revision: z.number().int().min(1).optional().describe('candidate 提交必填的 revision 守卫'),
      },
      exec: async (input) => traced('task_submit_evidence', input, (store) => store.submitEvidence({
        roomId: String(input.room_id ?? ''),
        taskPath: String(input.task_path ?? ''),
        actorContact: me(),
        kind: String(input.kind ?? ''),
        ref: typeof input.ref === 'string' ? input.ref : undefined,
        body: String(input.body ?? ''),
        expectedRevision: typeof input.expected_revision === 'number' ? input.expected_revision : undefined,
      })),
    }),
    defineGatewayTool({
      name: 'task_handoff',
      description: '显式交接（仅 strict 房；open 房调用直接返回 410 并指向 task_pass）：点名目标模块并附请求/证据。to_module=execute 可用 auto_start=true + expected_revision，在同一事务直接受理并启动 Worker（默认完成回 review），只发 system 事实，不唤醒执行席聊天轮次；否则保持 pending 交接并投递给捕获的接收人。幂等重试不重复建 job。自上次独立评审以来已执行 3 轮时，交回 execute 会被拒绝：先交 review/arbitration，或 task_wait blocked 交 User。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().describe(TASK_PATH_DESC),
        actor_module: z.string().optional().describe('你当前持有的模块（须与账本负责人一致）'),
        to_module: z.string().describe('目标模块：plan | execute | review | arbitration | merge | deploy | maintenance'),
        request: z.string().describe('要对方做什么、验收是什么'),
        evidence_refs: z.array(z.string()).optional().describe('证据引用（job id / SHA 等）'),
        idempotency_key: z.string().optional().describe('幂等键；同键重试返回同一交接'),
        auto_start: z.boolean().optional().describe('仅 to_module=execute 生效：同事务直接受理并启动 Worker，不唤醒执行席聊天轮次；省略保持普通交接'),
        expected_revision: z.number().int().min(1).optional().describe('auto_start=true 必填；使用 task_get 当前 revision'),
        return_to_module: z.string().optional().describe('auto_start 完成回调模块，默认 review'),
        objective: z.string().optional().describe('auto_start 执行目标，默认使用 request'),
        write: z.boolean().optional().describe('auto_start 是否写文件；默认 true，权限只能收窄'),
        shell: z.boolean().optional().describe('auto_start 是否需要 shell；默认跟随 write'),
        ssh: z.boolean().optional().describe('auto_start 是否需要 SSH；默认 false，受 execute 快照权限限制'),
      },
      exec: async (input) => traced('task_handoff', input, (store) => store.handoff({
        roomId: String(input.room_id ?? ''),
        taskPath: String(input.task_path ?? ''),
        actorContact: me(),
        actorModule: typeof input.actor_module === 'string' ? input.actor_module : undefined,
        toModule: String(input.to_module ?? ''),
        request: String(input.request ?? ''),
        evidenceRefs: Array.isArray(input.evidence_refs) ? input.evidence_refs as string[] : undefined,
        idempotencyKey: typeof input.idempotency_key === 'string' ? input.idempotency_key : undefined,
        autoStart: input.auto_start === true,
        expectedRevision: typeof input.expected_revision === 'number' ? input.expected_revision : undefined,
        returnToModule: typeof input.return_to_module === 'string' ? input.return_to_module : undefined,
        objective: typeof input.objective === 'string' ? input.objective : undefined,
        write: typeof input.write === 'boolean' ? input.write : undefined,
        shell: typeof input.shell === 'boolean' ? input.shell : undefined,
        ssh: typeof input.ssh === 'boolean' ? input.ssh : undefined,
      })),
    }),
    defineGatewayTool({
      name: 'task_accept',
      description: '接受点名给自己的交接（仅 strict 房；open 房调用直接返回 410，交棒即生效无需此步）。绑定切换后旧快照交接会过期，需对方重发；并发应答只第一个生效。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().optional().describe('任务路径（与 handoff_id 二选一）'),
        handoff_id: z.string().optional().describe('交接 id（与 task_path 二选一）'),
      },
      exec: async (input) => traced('task_accept', input, (store) => store.accept({
        roomId: String(input.room_id ?? ''),
        taskPath: typeof input.task_path === 'string' ? input.task_path : undefined,
        handoffId: typeof input.handoff_id === 'string' ? input.handoff_id : undefined,
        actorContact: me(),
      })),
    }),
    defineGatewayTool({
      name: 'task_decline',
      description: '拒绝点名给自己的交接（仅 strict 房；open 房调用直接返回 410，不用此步）。负责人不变，对方可重发。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().optional().describe('任务路径（与 handoff_id 二选一）'),
        handoff_id: z.string().optional().describe('交接 id（与 task_path 二选一）'),
      },
      exec: async (input) => traced('task_decline', input, (store) => store.decline({
        roomId: String(input.room_id ?? ''),
        taskPath: typeof input.task_path === 'string' ? input.task_path : undefined,
        handoffId: typeof input.handoff_id === 'string' ? input.handoff_id : undefined,
        actorContact: me(),
      })),
    }),
    defineGatewayTool({
      name: 'task_pass',
      description: 'open 治理交棒：任何会议室成员可调；网关把 holder 改为目标模块并唤醒其当前绑定联系人，无需 accept/decline。Worker 在途时只登记为 next，job 终态后自动生效。三轮闸保留：execute 满 3 轮未送审时拒绝回 execute。to plan 时 write 默认为 false，显式 write:true 才放行写权限（结构化参数，note 文本不授信）。to execute 时可用 auto_start=true + expected_revision 在同一事务直接受理并启动 Worker（默认完成回 review），只发 system 事实，不唤醒执行席聊天轮次；其他目标传 auto_start 会被拒绝。to execute + auto_start 可带 sequence（整条 W 序列 [{label, objective, write?, shell?}]，首项即本次目标）：合入核对通过后网关按序直启下一块（完成回 review），不唤醒 review/plan 席；三轮闸触发则停序列交 plan。裸 task_pass 到 plan 接回棒并清空序列；task_block/task_done 同样清空。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().describe(TASK_PATH_DESC),
        to_module: z.string().describe('目标模块：plan | execute | review | arbitration | merge | deploy | maintenance'),
        note: z.string().optional().describe('交棒说明（去向/原因；文本不授予权限）'),
        evidence_refs: z.array(z.string()).optional().describe('证据引用（job id / SHA 等）'),
        write: z.boolean().optional().describe('to plan：true 则冻结快照写权限放行，否则保持默认 false；to execute + auto_start：是否写文件，默认 true，权限只能收窄'),
        auto_start: z.boolean().optional().describe('仅 to_module=execute 生效：同事务直接受理并启动 Worker，不唤醒执行席聊天轮次；省略保持普通交棒'),
        objective: z.string().optional().describe('auto_start 执行目标，默认使用 note；带 sequence 时须与首项 objective 相同或省略'),
        sequence: z.array(z.object({
          label: z.string().describe('该块标识（如 W0）'),
          objective: z.string().describe('该块目标'),
          write: z.boolean().optional().describe('该块是否写文件，默认 true，只能收窄'),
          shell: z.boolean().optional().describe('该块是否需要 shell，默认跟随 write'),
        })).max(20).optional().describe('整条 W 序列；首项即本次直启目标，再传即替换整条序列'),
        return_to_module: z.string().optional().describe('auto_start 完成回调模块，默认 review'),
        shell: z.boolean().optional().describe('auto_start 是否需要 shell；默认跟随 write'),
        ssh: z.boolean().optional().describe('auto_start 是否需要 SSH；默认 false，受 execute 快照权限限制'),
        expected_revision: z.number().int().min(1).optional().describe('auto_start=true 必填；使用 task_get 当前 revision'),
        idempotency_key: z.string().optional().describe('auto_start 幂等键；同键重试返回同一 job，不重复启动'),
      },
      exec: async (input) => traced('task_pass', input, (store) => store.passTask({
        roomId: String(input.room_id ?? ''),
        taskPath: String(input.task_path ?? ''),
        toModule: String(input.to_module ?? ''),
        actorContact: me(),
        note: typeof input.note === 'string' ? input.note : undefined,
        evidenceRefs: Array.isArray(input.evidence_refs) ? input.evidence_refs as string[] : undefined,
        write: typeof input.write === 'boolean' ? input.write : undefined,
        autoStart: input.auto_start === true,
        objective: typeof input.objective === 'string' ? input.objective : undefined,
        sequence: Array.isArray(input.sequence) ? input.sequence as Array<Record<string, unknown>> : undefined,
        returnToModule: typeof input.return_to_module === 'string' ? input.return_to_module : undefined,
        shell: typeof input.shell === 'boolean' ? input.shell : undefined,
        ssh: typeof input.ssh === 'boolean' ? input.ssh : undefined,
        expectedRevision: typeof input.expected_revision === 'number' ? input.expected_revision : undefined,
        idempotencyKey: typeof input.idempotency_key === 'string' ? input.idempotency_key : undefined,
      })),
    }),
    defineGatewayTool({
      name: 'task_block',
      description: 'open 治理受阻：持棒人或 User 登记 blocked 并交 User 主窗提醒，需 5 字以上原因。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().describe(TASK_PATH_DESC),
        note: z.string().describe('受阻原因（≥5 字）'),
      },
      exec: async (input) => traced('task_block', input, (store) => store.blockTask({
        roomId: String(input.room_id ?? ''),
        taskPath: String(input.task_path ?? ''),
        actorContact: me(),
        note: typeof input.note === 'string' ? input.note : undefined,
      })),
    }),
    defineGatewayTool({
      name: 'task_done',
      description: 'open 治理完工：持棒人或 User 登记 closed，任务停止流转。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().describe(TASK_PATH_DESC),
        note: z.string().optional().describe('完工说明'),
      },
      exec: async (input) => traced('task_done', input, (store) => store.doneTask({
        roomId: String(input.room_id ?? ''),
        taskPath: String(input.task_path ?? ''),
        actorContact: me(),
        note: typeof input.note === 'string' ? input.note : undefined,
      })),
    }),
    defineGatewayTool({
      name: 'execution_start',
      description: '用已接受的交接授权启动执行：显式声明模块、revision 守卫、权限交集（不扩大）、单写租约，并登记完成回调的 return_to 模块。room-host marker 不再构成授权。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().describe(TASK_PATH_DESC),
        module: z.string().describe('执行模块（须是你当前持有且已接受交接的模块）'),
        expected_revision: z.number().int().min(1).describe('task_get 读到的 revision；变化则重读再试'),
        workspace: z.string().describe('PC 上的项目绝对路径'),
        objective: z.string().describe('本轮目标'),
        return_to_module: z.string().optional().describe('首轮和修复轮默认 review；完成后登记待 accept 的完成交接；同一负责人则只通知'),
        return_mode: z.enum(['handoff', 'notify']).optional().describe('默认 handoff：异模块完成交接，接收人 accept 后才接管；notify 仅抄送，不转责任，必须另有负责人继续路径'),
        write: z.boolean().optional().describe('是否写文件；默认 true，只读评审传 false'),
        shell: z.boolean().optional().describe('是否需要 shell；默认跟随 write'),
        ssh: z.boolean().optional().describe('是否需要 SSH；默认 false，模块无 ssh 权限时传 true 会被拒绝'),
        priority: z.number().optional().describe('-10~10，默认 0'),
      },
      exec: async (input) => traced('execution_start', input, (store) => store.executionStart({
        roomId: String(input.room_id ?? ''),
        taskPath: String(input.task_path ?? ''),
        actorContact: me(),
        module: String(input.module ?? ''),
        expectedRevision: Number(input.expected_revision),
        workspace: String(input.workspace ?? ''),
        objective: String(input.objective ?? ''),
        returnToModule: String(input.return_to_module ?? 'review'),
        returnMode: typeof input.return_mode === 'string' ? input.return_mode : undefined,
        write: typeof input.write === 'boolean' ? input.write : undefined,
        shell: typeof input.shell === 'boolean' ? input.shell : undefined,
        ssh: typeof input.ssh === 'boolean' ? input.ssh : undefined,
        priority: typeof input.priority === 'number' ? input.priority : undefined,
      })),
    }),
    defineGatewayTool({
      name: 'execution_get',
      description: '读取本任务下指定执行的记录与分页回执（须归属本任务；伪造/跨任务引用拒绝）。section=patch 读 Worker 从 git 直接采集的累计 diff 原文（不经模型转述），核对代码时优先用它，不要让执行方转贴。section=patch_delta 只读相对上次 pin 候选的增量（有 delta 时评审先读它，需要全量再读 patch）。patch 分页：patch_offset/patch_limit（默认 0/120000，单页最大 120000），patch_file 按 diff 文件名只取该文件块；返回尾部给出 patchNextOffset/patchAtEnd/patchTotalChars/patchFiles（最多 200 个）与下一页 hint。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().describe(TASK_PATH_DESC),
        job_id: z.string().describe('执行 id'),
        section: z.enum(['result', 'patch', 'patch_delta']).optional().describe('result=回执正文（默认）；patch=累计 git diff 原文；patch_delta=相对上次 pin 候选的增量'),
        result_offset: z.number().int().min(0).optional().describe('起始 offset，默认 0'),
        result_limit: z.number().int().min(1).max(12000).optional().describe('本页字符数，默认 4000'),
        patch_offset: z.number().int().min(0).optional().describe('section=patch/patch_delta 时 diff 起始 offset，默认 0'),
        patch_limit: z.number().int().min(1).max(120000).optional().describe('section=patch/patch_delta 时本页字符数，默认 120000'),
        patch_file: z.string().optional().describe('section=patch/patch_delta 时只返回该文件的 diff 块（diff --git 路径）'),
      },
      exec: async (input) => traced('execution_get', input, (store) => store.executionGet({
        roomId: String(input.room_id ?? ''),
        taskPath: String(input.task_path ?? ''),
        actorContact: me(),
        jobId: String(input.job_id ?? ''),
        section: input.section === 'patch' || input.section === 'patch_delta' ? input.section : 'result',
        resultOffset: typeof input.result_offset === 'number' ? input.result_offset : undefined,
        resultLimit: typeof input.result_limit === 'number' ? input.result_limit : undefined,
        patchOffset: typeof input.patch_offset === 'number' ? input.patch_offset : undefined,
        patchLimit: typeof input.patch_limit === 'number' ? input.patch_limit : undefined,
        patchFile: typeof input.patch_file === 'string' ? input.patch_file : undefined,
      })),
    }),
    defineGatewayTool({
      name: 'review_submit',
      description: '提交独立评审结论并 pin 候选，无需负责人先提交 candidate；按 job 创建时间拒绝比当前 pin 更旧的候选。评审人与执行人必须不同，SHA 必须匹配回执 HEAD，APPROVE 需要真实 diff 与全绿测试。REQUEST_CHANGES 后直接 task_handoff execute（附 MUST 项与通过条件），APPROVE 后直接交 merge。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().describe(TASK_PATH_DESC),
        module: z.enum(['review', 'arbitration']).describe('评审模块'),
        candidate_job_id: z.string().describe('被评审的候选执行 id'),
        candidate_sha: z.string().describe('完整 40 位候选 commit SHA（须与回执 HEAD 一致）'),
        verdict: z.enum(['approve', 'request_changes']).describe('结论'),
        findings: z.string().optional().describe('意见；REQUEST_CHANGES 必填 MUST 项与通过条件'),
        evidence_refs: z.array(z.string()).optional().describe('证据引用'),
        after_merge: z.enum(['review', 'done', 'deploy']).optional().describe('仅 approve 有意义：done=合入成功且机器核对通过后网关直接关闭（纯文档/无需部署）；deploy=合入后网关直接跑 ai-hub 部署脚本，deploy ok + health 通过即关闭（需要上线的 ai-hub 改动）；默认 review=合入后回评审席收口；strict 房忽略'),
        patch: z.string().optional().describe('仅 open 房 approve 有意义的小补丁 unified diff（≤8000 字符/40 行/3 文件，只碰候选已改文件与测试，不碰敏感路径）；由合入脚本机械应用并全量验证后合入'),
      },
      exec: async (input) => traced('review_submit', input, (store) => store.reviewSubmit({
        roomId: String(input.room_id ?? ''),
        taskPath: String(input.task_path ?? ''),
        actorContact: me(),
        module: String(input.module ?? ''),
        candidateJobId: String(input.candidate_job_id ?? ''),
        candidateSha: String(input.candidate_sha ?? ''),
        verdict: String(input.verdict ?? ''),
        findings: typeof input.findings === 'string' ? input.findings : undefined,
        evidenceRefs: Array.isArray(input.evidence_refs) ? input.evidence_refs as string[] : undefined,
        afterMerge: typeof input.after_merge === 'string' ? input.after_merge : undefined,
        patch: typeof (input as { patch?: unknown }).patch === 'string' ? (input as { patch?: string }).patch : undefined,
      })),
    }),
    defineGatewayTool({
      name: 'release_execute',
      description: '由 merge/deploy 绑定者显式发起发布：校验已批准且未变化的候选、分支与验证证据，下发确定性 closureCommand（Worker 直接执行脚本，不经模型，回执为原始 stdout）；从不自动调度。必须显式选择完成回调模块。任务级写租约 + revision 守卫 + 幂等键防止重叠与重复。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().describe(TASK_PATH_DESC),
        kind: z.enum(['merge', 'deploy']).describe('merge 先合主分支并全量验证；deploy 复用已授权通道上线'),
        return_to_module: z.string().describe('完成后交接给哪个模块：默认登记待 accept 的完成交接；同一负责人或任务已关闭则只通知'),
        return_mode: z.enum(['handoff', 'notify']).optional().describe('默认 handoff：完成交接且须 accept；notify 仅抄送，不转责任'),
        expected_revision: z.number().int().min(1).describe('task_get 读到的 revision；变化则重读再试'),
        idempotency_key: z.string().optional().describe('幂等键；同键重试返回同一发布任务，不重复创建'),
        evidence_refs: z.array(z.string()).optional().describe('证据引用'),
      },
      exec: async (input) => traced('release_execute', input, (store) => store.releaseExecute({
        roomId: String(input.room_id ?? ''),
        taskPath: String(input.task_path ?? ''),
        actorContact: me(),
        kind: String(input.kind ?? ''),
        returnToModule: String(input.return_to_module ?? ''),
        returnMode: typeof input.return_mode === 'string' ? input.return_mode : undefined,
        expectedRevision: Number(input.expected_revision),
        idempotencyKey: typeof input.idempotency_key === 'string' ? input.idempotency_key : undefined,
        evidenceRefs: Array.isArray(input.evidence_refs) ? input.evidence_refs as string[] : undefined,
      })),
    }),
    defineGatewayTool({
      name: 'task_retry',
      description: '中断后的显式恢复：重发 pending 交接，或已 accepted 但派发轮次 failed 且接收人仍为当前负责人的交接；重投未达完成回调；负责人取消卡住的交接或显式接管在途尝试。只向原接收人恢复，不改归属或阶段。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().optional().describe('任务路径'),
        handoff_id: z.string().optional().describe('交接 id'),
        job_id: z.string().optional().describe('重投回调的 job id，或要接管/取消关联的旧 job id'),
        mode: z.enum(['handoff', 'callback', 'takeover', 'cancel-handoff']).optional().describe('默认按参数推断'),
      },
      exec: async (input) => traced('task_retry', input, async (store) => {
        const mode = typeof input.mode === 'string' ? input.mode
          : typeof input.job_id === 'string' && typeof input.task_path === 'string' && !input.handoff_id ? 'callback'
            : 'handoff';
        if (mode === 'takeover') {
          if (typeof input.task_path !== 'string' || typeof input.job_id !== 'string') {
            return { error: 'takeover 需要同时传 task_path 与 job_id（要接管的旧尝试）', code: 400 as const };
          }
          return store.takeoverJob({
            roomId: String(input.room_id ?? ''),
            taskPath: input.task_path,
            actorContact: me(),
            oldJobId: input.job_id,
          });
        }
        if (mode === 'cancel-handoff') {
          return store.cancelHandoff({
            roomId: String(input.room_id ?? ''),
            taskPath: typeof input.task_path === 'string' ? input.task_path : undefined,
            handoffId: typeof input.handoff_id === 'string' ? input.handoff_id : undefined,
            actorContact: me(),
          });
        }
        return store.retryDelivery({
          roomId: String(input.room_id ?? ''),
          taskPath: typeof input.task_path === 'string' ? input.task_path : undefined,
          handoffId: typeof input.handoff_id === 'string' ? input.handoff_id : undefined,
          jobId: typeof input.job_id === 'string' ? input.job_id : undefined,
          actorContact: me(),
        });
      }),
    }),
    defineGatewayTool({
      name: 'task_wait',
      description: '显式等待/受阻登记（交接义务的有效去向之一）：负责人用 blocked（任务级受阻）或 waiting_user（等 User 决策/输入）；回调非负责人轮次只能用 waiting_owner（仅本回调范围，不改任务状态/负责人）。需 expected_revision、实质 reason 与 resume_condition/question；无自动唤醒，网关不选下一步。',
      inputSchema: {
        room_id: z.string().describe(ROOM_DESC),
        task_path: z.string().describe(TASK_PATH_DESC),
        mode: z.enum(['blocked', 'waiting_user', 'waiting_owner']).describe('blocked=任务受阻；waiting_user=等 User；waiting_owner=仅回调轮次 scoped 等待'),
        reason: z.string().describe('为什么停在这里（≥10 字实质内容）'),
        resume_condition: z.string().optional().describe('恢复条件（与 question 二选一，≥5 字）'),
        question: z.string().optional().describe('要 User 决定的问题（与 resume_condition 二选一，≥5 字）'),
        expected_revision: z.number().int().min(1).describe('task_get 读到的 revision；变化则重读再试'),
      },
      exec: async (input) => traced('task_wait', input, (store) => store.waitFor({
        roomId: String(input.room_id ?? ''),
        taskPath: String(input.task_path ?? ''),
        actorContact: me(),
        mode: String(input.mode ?? ''),
        reason: String(input.reason ?? ''),
        resumeCondition: typeof input.resume_condition === 'string' ? input.resume_condition : undefined,
        question: typeof input.question === 'string' ? input.question : undefined,
        expectedRevision: Number(input.expected_revision),
      })),
    }),
  ];
}

/**
 * 注入 system prompt 的任务流规范（工作会议室模块轮次）。
 * governance=open 的房间走放权短规范（无义务闸/accept/nonce 段落）；
 * strict 段落待观察一周后删除（open 上线对照期）。
 */
export function roomTaskGuidance(governance: 'strict' | 'open' = 'strict'): string {
  if (governance === 'open') {
    return [
      '',
      '# 任务驱动协作规范（open 治理 · 网关注入）',
      '- 会议室任务以 room_tasks 账本为唯一状态权威：status / holder（持棒模块）/ candidate_sha / evidence / events。只记录，不审批。task_get 读全量，task_submit_evidence 只增不改。',
      '- 交棒只用 task_pass(room_id, task_path, to_module, note)：任何成员可调；网关把 holder 改为目标模块并唤醒其当前绑定联系人，接棒即生效，没有 accept/decline。持棒人可用 task_block（交 User）或 task_done 停下；Worker 在途时交棒登记为 next，job 终态后自动生效。',
      '- execute 免聊天席：task_pass to_module=execute 时可用 auto_start=true，并带 task_get 的 expected_revision；objective 默认 note，完成默认回 review。网关按冻结 execute 快照直接受理并启动 Worker，返回 job；不唤醒执行席聊天轮次。未传 auto_start 或目标非 execute 仍走普通交棒。',
      '- 整条 W 序列免传话：plan 派首块时 task_pass 带 sequence（整条 W 序列 [{label, objective, write?, shell?}]，首项即本次目标）；每块合入核对通过后网关按序直启下一块 execute Worker（完成回 review），只发一条系统事实，不唤醒 review/plan 席。最后一块按 APPROVE 的 after_merge 收口（无声明走现有唤醒）。三轮闸触发停序列交 plan；直启失败回退唤醒 review 席。plan 随时可再传 sequence 覆盖，或裸 task_pass 到 plan 接回棒（清空序列）；task_block/task_done 同样清空。',
      '- 省 token：只需状态时 task_get 用 section=summary（只要 holder/status/revision/candidate/review_status/最近事件与 cost，不读需求原文与证据）。',
      '- 轮末兜底：本轮结束时任务仍 open、棒在你手上且无在途 job，网关自动把棒交回 plan 并记 auto-pass（附你最后一条正文摘要），不判失败、不要求补办。',
      '- 评审走 review_submit（独立评审人、锁定完整候选 SHA、有真实 diff 与全绿测试才可 approve）；结论落账本后自动交棒：REQUEST_CHANGES → execute，APPROVE → merge。发布走 release_execute（merge/deploy 绑定者显式发起，合入闸在合并脚本里，不在聊天里）。',
      '- open 房 APPROVE 直启合入：结论落账本后网关直接按 merge 模块冻结快照启动合入 job（等价于 merge 席 release_execute kind=merge 回 review），只发一条系统事实，不唤醒 merge 席聊天轮次；merge 无可用绑定或任一闸门拒绝时回退为唤醒 merge 席。',
      '- open 房 REQUEST_CHANGES 直启返修：结论落账本后网关把 findings 原样拼成返修 Worker 的 objective（固定前言"按评审 MUST 项返修；逐项满足通过条件；完成后送审"+ findings 原文），按 execute 模块冻结快照直接启动返修 job（完成回 review），只发一条系统事实，不唤醒 execute 席聊天轮次；三轮闸触发或直启失败时回退为唤醒 execute 席。写 findings 时按可直接执行的 MUST 项 + 可判真伪的通过条件写。',
      '- APPROVE 时顺手声明合入后怎么收：纯文档/无需部署带 after_merge="done"（合入机器核对通过即关闭）；需要上线的 ai-hub 改动带 after_merge="deploy"（合入后网关直接跑部署脚本，deploy ok + /api/health 通过即关闭，不唤醒 deploy/评审席）。合入时 master 已前进的，脚本自己干净 rebase，候选自身改动逐行一致才直接合入，不回头重审；有冲突或改动变化才退回 execute。无声明、核对失败或 strict 房走现行为。',
      '- 小修（≤40 行、只碰候选已改文件与测试、不碰敏感路径）APPROVE 时直接附 patch，由合入脚本机械应用并全量验证后合入；超出即 REQUEST_CHANGES（R1 已直启返修）。',
      '- diff 由 Worker 从 git 直接采集，不在回执正文里：评审核对代码用 execution_get section=patch（返修轮先读 patch_delta），回执没贴 diff 不构成 REQUEST_CHANGES 理由；plan 写验收条件时不要要求"回执贴 git diff 原文"，那只会换来一轮不改代码的补证。',
      '- 一次交棒只起一个执行：execution_start 配错了（例如该写却只读）先等它终态或取消，再起下一个；同时挂两个 job 会让评审先被无效的那轮唤醒。',
      '- 三轮闸保留：自上次独立评审起 execute 满 3 轮不得再回 execute，先送 review/arbitration。机器边界不动：Worker 工作区白名单、ssh/shell 开关、写租约、模块权限交集。',
      '- 唤醒预算：每任务每日模型唤醒上限（默认 40）；超限自动 task_block 交 User。User @你即点名你当前所持模块；无 @ 的消息进 plan。',
      '- room-host marker、群聊 PASS、preview 摘要都不构成授权与结论；跨室任务不可读不可写；伪造引用会被拒绝。',
    ].join('\n');
  }
  return [
    '',
    '# 任务驱动协作规范（网关注入）',
    '- 会议室任务以 room_tasks 账本为唯一状态权威：task_get 读全量（原始需求/证据/尝试/交接/waits），task_submit_evidence 只增不改。',
    '- 流转全显式：task_create/task_import 建账 → task_handoff 点名目标模块 → 对方 task_accept/task_decline → execution_start（附 accepted 授权 + revision 守卫 + return_to_module）。默认 return_mode=handoff：异模块完成后兑现启动时登记的交接，原负责人保留责任直到对方 accept；不自动开下一单。同一负责人只收回执；notify 仅抄送，不转责任，勿把任务交给无权流转的人后自己退出。',
    '- 评审走 review_submit（独立评审人、锁定完整候选 SHA、有真实 diff 与全绿测试才可 approve）；发布走 release_execute（merge/deploy 绑定者显式发起）。中断恢复走 task_retry（同一接收人/同一回调/显式接管）。',
    '- 内环直连：首轮与修复轮 execution_start 默认 return_to_module=review。review accept 后直接 review_submit（结论即 pin，无需先交负责人提交 candidate）；REQUEST_CHANGES 后由 review 直接 task_handoff execute，附 MUST 项与通过条件；APPROVE 后直接 task_handoff merge。仅改方案、改范围或触发仲裁阈值时交 plan；3 轮闸、质量计数和权限校验不变。',
    '- execute 免聊天席：task_handoff to_module=execute 时使用 auto_start=true，并带 task_get 的 expected_revision；objective 默认 request，完成默认回 review。网关按冻结 execute 快照直接受理与启动 Worker，返回 job；不需要再唤醒 execute 聊天席 accept/execution_start。未传 auto_start 或目标非 execute 仍走普通交接。',
    '- 交接义务（每轮结束强制）：每个相关未完成任务在本轮结束前必须留下可验证责任去向——继续真实执行、显式 task_handoff（投递成功）、登记 task_wait（blocked/waiting_user；回调非负责人轮次 waiting_owner）、或 decline 不再承接；否则本轮判为未交接失败（不记正常 done、不 prune PASS）。accept 只是接下责任，还须执行/交接/等待才算交代。只报 done/PASS、只读 task_get、历史等待/旧交接、失败投递、终态/被接管 job 的回调都不能免责。阶段完成不是任务完成。',
    '- 等待要显式登记：task_wait 需 expected_revision + 实质 reason + resume_condition/question；无自动定时唤醒；下一步仍由模型显式决定，网关不选阶段、不代劳交接、不循环追问。',
    '- room-host marker、群聊 PASS、preview 摘要都不构成授权与结论；跨室任务不可读不可写；伪造引用会被拒绝。',
  ].join('\n');
}
