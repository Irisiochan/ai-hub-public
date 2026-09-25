# Model-driven room workflow

Replaces the mechanical host/automatic workflow engine (retired 2026-09-12).
Models explicitly call gateway interfaces to hand work off; the gateway never
selects the next stage or interprets chat PASS as a verdict. Worker starts
require explicit `execution_start` or an execute handoff with `auto_start=true`;
there is no autonomous repair/arbitration/review/closure routing. Authorized by User (实施,
2026-09-12) on the parent-proposed model-directed handoff + shared task
ledger + gateway interfaces plan.

## Authority model

- Modules (`plan/execute/review/arbitration/merge/deploy/maintenance`) are
  responsibility+capability bindings, not a machine graph. Quality counters
  are observations only; `WorkflowModulesStore.invoke()` never routes or
  escalates on its own. Observation policy (User 2026-09-14): implementation
  streak 2 marks arbitration, 3 stops auto-dispatch for User; review stays 3.
  Counters never pick the next module.
- Every task tool call carries a server-built turn context
  (`RoomTaskToolContext`: room session + captured module + pinned task when
  handoff/callback-woken). DMs and context-less callers get NO room task
  capabilities. Room/task/module mismatches are rejected; the same contact in
  another room, or wearing another module's hat, cannot act across.
  `BackendFactory` refuses to build a turn whose invocation names another
  contact (confused-deputy guard).
- Task creation/import anchors to an authorized room user message (User's
  approval, verified server-side from `messages`) and binds the approved
  workspace. Imports additionally prefer the server-read Vault task text and
  only attach jobs whose origin room AND recorded taskPath verify.
- Handoffs freeze the full target binding/permissions/workspace snapshot.
  Delivery wakes ONLY the captured recipient via the tracked room dispatch
  with the durable `{taskId, handoffId}` reference; the manager re-verifies
  the row and runs the turn under the frozen snapshot. Retries target the
  same recipient; posted keys never wake twice (`room_task_dispatches`).
  Queue acceptance is not model acceptance: if the round later fails, the
  ledger flips back to failed so an explicit `task_retry` can redeliver.
  This also covers an accepted handoff whose recipient round failed after
  accepting: retry is allowed only while it remains the latest accepted
  authority of the current owner, with no new pending edge. Successful
  deliveries remain deduplicated, and stale ownership is never reawakened.
- D2: `task_handoff` to `execute` with `auto_start=true` requires
  `expected_revision`. It atomically creates and accepts the handoff, records
  `handoff-auto-accepted` with the initiator and frozen binding/permissions,
  creates the linked Worker job, and registers its frozen completion return.
  `objective` defaults to `request`, `return_to_module` to `review`; optional
  `write/shell/ssh` use the same launch checks as `execution_start`. Workspace
  comes exclusively from the approved task. Implementation identity remains
  the execute binding, while the initiating reviewer is separately audited.
  Only a system `room-task-auto-start` fact is posted; no `dispatchToModule`
  call, `room-task-handoff` wake message or execute chat turn is created.
  Failures roll back all rows and buffered job SSE notifications. Exact retries
  return the existing job; reused keys with different launch parameters fail.
  Default keys include the expected revision so a later identical repair can
  create a new attempt. The originating turn can settle via its exact active,
  unfenced job and callback; historical duplicate replies do not settle new
  turns. Failed jobs still return to the frozen module and explicit takeover
  keeps its existing callback/fencing behavior. Omitted `auto_start`, or any
  non-execute target, retains the normal handoff path.
- `execution_start` with `write=false, shell=true` on the OpenCode runner
  keeps `edit` denied but allows a read-only bash whitelist (`git
  show/log/diff/rev-parse/status/cat-file`, `ls/cat/head/tail/wc/grep/find/rg`;
  everything else denied) so recon rounds can `git show <sha>:<path>` for
  evidence; `write=false, shell=false` keeps bash fully denied.
- `execution_start` requires the accepted handoff snapshot (owner + role +
  revision guard + exact approved workspace) and registers the explicit
  return choice (frozen return module/contact/binding). `return_mode` defaults
  to `handoff`: across modules, completion creates the pending handoff chosen
  at launch and the receiver must `task_accept` before gaining responsibility.
  `return_mode=notify` explicitly requests notification only; it conveys no
  ownership and must not be mistaken for an actionable handoff. Same-owner
  returns and already closed tasks only notify. `release_execute` uses the
  same return contract. Completion delivers
  that exact snapshot even across rebind/restart; it is never re-resolved
  live and never borrows the execution recipient. Redelivery is authoritative
  on the ledger, not on history events. Takeover re-registers the callback
  for the replacement job; fenced attempts deliver nothing anywhere
  (store retry, callback, and manager verification all refuse).
- Completion (`handleJobFinished`) is idempotent before any mutation, folds
  receipts into the ledger, and fulfills ONLY the registered return choice. It
  never selects or replaces the implementation candidate and never creates
  a new execution job. The registered completion handoff preserves the frozen
  recipient, permissions and workspace; it is not a runtime-selected next stage.
  Later explicit handoffs/waits supersede an unfulfilled return, including an
  ownership round trip back to the original owner. Failed delivery retries the
  same handoff; fences apply at delivery and acceptance. Closed tasks never downgrade; late non-candidate finishes
  hold reviewed state. Stale/fenced attempts and infra failures produce
  events, not new work.
- D1 direct loop: first and repair executions default `return_to_module` to
  `review` at the tool boundary. After accepting the completion handoff,
  review submits its verdict directly: REQUEST_CHANGES hands off to execute
  with MUST items and pass criteria; APPROVE hands off to merge. Only scope,
  design changes or arbitration thresholds return to plan. No automatic routing
  is added; the three-round gate, quality counters, permissions and fencing stay unchanged.
- Review verdicts atomically pin the linked terminal implementation job and
  its receipt HEAD, emitting `candidate-submitted` with the reviewer as actor
  when the pin changes. Only jobs created before the current pinned job are
  rejected (including the same SHA from an older job); the same job and equal
  creation timestamps remain reviewable. A null candidate job permits the
  first pin. Git ancestry is irrelevant, so amendments/rebases are supported.
  The owner can still submit candidate evidence explicitly (revision-guarded),
  invalidating prior approval, but this is no longer a prerequisite. Review
  requires ownership, an accepted review handoff, binding match, and rejects
  ANY known implementer identity (captured binding/selected/requester).
  APPROVE needs a real diff plus a non-empty all-green test set; empty
  tests or dangling refs never pass. Release requires the merge/deploy role
  with an accepted handoff, the unchanged approved candidate, full merge
  evidence, a task-wide write lease, a revision guard, and an idempotency
  key (repeats return the same job).

## Ledger tables (0035, additive; history preserved)

`room_tasks` (single status/revision/owner authority), `room_task_handoffs`
(frozen snapshots, idempotent), `room_task_events` / `room_task_evidence`
(append-only), `room_task_links` (server-verified job attachments),
`room_task_dispatches` (exactly-once wakes), `room_task_callbacks`
(explicit frozen return targets), `room_task_completion_handoffs` (0036:
start-time return responsibility choice and its single pending handoff),
`room_task_waits` (explicit wait/blocker
dispositions with reason + resume condition), `room_task_turns` /
`room_task_turn_calls` (origin-turn audit: which turn touched which task).

## Tools (native DirectApi AND hub MCP, same definitions)

`task_create`, `task_import`, `task_get` (paginated full receipts, source
requirements, evidence, attempts, waits), `task_submit_evidence` (append-only,
incl. explicit candidate pins), `task_handoff`, `task_accept` /
`task_decline`, `execution_start`, `execution_get`, `review_submit`,
`release_execute`, `task_retry`
(handoff redelivery / callback redelivery / cancel-handoff / takeover),
`task_wait` (`blocked` / `waiting_user`, owner-only; `waiting_owner`,
callback-scoped for verified non-owner callback turns only).
Module turns get the task tools independently of the delegate allow flag;
`delegate_to_worker` stays for DM/legacy callers only (module turns get a
migration pointer). `worker_job_status` is readable by all authorized
participants of the same room task (owner + linked-task members). MCP
bearers for module turns are server-signed `{contact, room, module,
revision}` scopes carrying the frozen invocation PLUS the origin-turn nonce
of the exact turn that generated them; the router re-verifies per request
including SSE follow-ups, and rejects stale prior-turn credentials outright.

## Open 治理模式（五条不变量 + task_pass 单动作 + 唤醒预算）

房间 `contacts.config.governance: 'open'`（缺省 `strict`）启用。会议室只为干活，
规则从保障变成限制时把权限交还给 AI。strict 代码不删，只在 open 下短路；
观察一周（对照指标：每任务唤醒数、plan 中转数、卡死次数、人工干预次数）后另开单删除。
本节是 open 房的唯一行为依据；下文 strict 段落（交接仪式、义务闸、nonce 绑定、
plan-only 路由）在 open 房不再执行，标「待观察一周后删除」。

只保留防真实损失的检查，不保留流程仪式：

1. **账本是唯一状态权威**：status / holder（持棒模块，`room_tasks.holder_module`）
   / candidate_sha / evidence / events。只记录，不审批。
2. **接棒义务**：本轮结束时，若任务仍 open 且持棒人是本席且没有在途 Worker job，
   网关**自动**把棒交回 plan 并记事件 `auto-pass: unfinished`（附本轮最后一条正文摘要）；
   不判失败、不要求补办。显式 `blocked`（交 User）或 `done` 才停。
3. **三轮闸**：自上次非实现者 review 结论起，execute 满 3 轮不得再回 execute
   （`EXECUTE_ROUNDS_BEFORE_REVIEW` 原样保留）。
4. **合入闸在脚本不在聊天**：合 master 前必须有一条非实现者的 review 结论
   （APPROVE 且 candidate_sha 一致）；合入只能 ff、非 force；merge 脚本先做
   ReleaseEvidence 本地自检（不是硬闸），再用 bearer 回调网关
   `GET /api/room-tasks/:room/:task` 核账本 live `candidate_sha` 与
   `review_status`，不一致即拒绝；不由 prompt 约束。
5. **机器级边界不动**：Worker 工作区白名单、ssh/shell 开关、写租约、模块权限交集。

协议压成一个动作：

- `task_pass(room_id, task_path, to_module, note, evidence_refs?, write?)`：任何会议室成员
  （含 User 会话）都可调用；网关把 holder 改为 `to_module`，唤醒该模块**当前**
  绑定的联系人；接棒即生效，没有 accept/decline。事件 `pass`。往 plan 交棒时
  `write` 默认为 false，显式 `write: true`（结构化参数，note 文本不授信）才放行
  写权限。strict 仪式工具（`task_handoff`/`task_accept`/`task_decline`）在 open 房
  直接返回 410 并指向 `task_pass`，不再有负责人 403。
- `task_block(note)` / `task_done(note)`：持棒人或 User 可调；block 交 User 主窗提醒。
- 保留 `task_get`、`execution_get section=patch`、`task_submit_evidence`、
  `review_submit`、`execution_start`（Worker job 仍是实现主路径）。
  `review_submit` 结论落账本后**自动** pass：REQUEST_CHANGES → execute，
  APPROVE → merge。
- 拿棒是软租约：持棒人本轮结束没 pass（被第 2 条兜底后）或轮次失败，任何席可直接
  `task_pass` 拿走，不返回 403。
- User 在会议室：`@<成员>` 直接唤醒该成员，按其当前所持模块授权；无 @ 进 plan。
  不再「只能进 plan」。
- 评审席用只读 shell 直接在候选分支上看 diff / 跑测试，不再依赖回执转述；
  回执仍存但只作证据。

新增的便宜防线：

- **唤醒预算**：每任务每日模型唤醒上限（默认 40，房间配置 `wakeBudget` 可调）；
  超出自动 `task_block(note='wake budget exhausted')` 交 User。计数含交接唤醒、
  User `@成员` 直连唤醒（消息点名 `tasks/<name>.md` 时记到该任务上；
  无路径的口语直连按该席位当前持棒任务计，同一任务一次只计一次）、
  回调唤醒与 Worker job 启动（`room_tasks.wake_count_date/wake_count`）。
- **同任务单持棒**：同一任务同时只有一个 holder；Worker job 在途时 holder 锁定为
  execute，pass 只登记为 `next`（`room_tasks.next_module`），job 终态后自动生效。
- **合入闸**（第 4 条）落在 `deploy/merge-close-job.*`：脚本先本地自检
  ReleaseEvidence 的 review 结论与 candidate_sha（自检不是硬闸），再用 bearer
  回调网关账本核 live 值，缺任一或不一致即拒绝；候选落后 master 时报机器可读 stale，
  网关自动 `task_pass execute` 附「rebase 到 <sha>」。`release_execute` 下发的
  merge/deploy job 由 Worker 直接执行 `closureCommand`（不经模型），回执为脚本
  原始 stdout，网关读 `receipt.scriptReport` 做分支/HEAD 证明。

迁移 `0038_room_task_open_governance.sql` 增加 `holder_module`、`next_module`、
`wake_count_date`、`wake_count`；strict 房 holder 镜像 owner。

## 降本第一批（2026-09）

P1（attempt 成本账本）/ P2（`task_pass auto_start` 直启）/ P3（增量 patch）/
P4（`task_get section=summary`）已上线。本节只写现在代码里的真实行为。

### 1. attempt 成本账本（`attempt-finished` + `task_get.cost`）

- 每次 Worker 尝试终态落账本记事件 `attempt-finished`，payload 在原有
  `jobId` / `status` / `deliveryState` / `head` 之外追加成本字段：
  `durationMs`、`moduleId`、`runner`、`model`、`reasoning`、`usage`
 （见 `attemptDurationMs` / `attemptLedgerIdentity` / `receiptUsage`）。
  老数据缺字段时记 null，不估算、不抛错。
- `durationMs` 口径：job 行 `created_at → updated_at` 的 wall-clock 差（毫秒数，
  时间戳本身秒级，含排队等待）。任一时间戳缺失或不可解析时记 null。
- 绑定口径：`moduleId` / `runner` / `model` / `reasoning` 取派单时刻冻结的
  `options.workflowModule.selected`（真实派单绑定）；老行无该结构时回落到
  job 行 `runner` / 顶层 `options.model` / `options.reasoning`，再无则 null。
- `usage` 口径：网关只读 `delivery_meta.receipt.usage`（`receiptUsage`：
  `inputTokens` / `outputTokens` 必备，`cacheReadTokens` 可选；缺任一必备项
  即视为无 usage）。Worker 侧 `extractRunnerUsage` 从 runner 流式 JSON 按形状
  提取、从不编造：OpenCode `step_finish` 的 `part.tokens{input,output,reasoning,
  cache.read}` 是按步上报（`perStep: true`，output 含 reasoning），网关侧
  `worker.mjs` 按步累加；其余 runner 取最后一次可用读数。
- `task_get`（full 与 `summary` 都是同一 `taskCost`）在 `view.cost` 汇总：
  `attempts`（关联 job 数）、`durationMs`（各 attempt 求和，无有效时长则 null）、
  `tokens{inputTokens,outputTokens,cacheReadTokens?}`（各 attempt 求和；至少一次
  上报 usage 才出现 `tokens`，`cacheReadTokens` 只有上报过才出现）、
  `wakes`（`room_tasks.wake_count`）。`view.attempts[]`（`jobBrief`）每轮另带
  本轮 `durationMs` / `moduleId` / `usage`，来源与事件口径一致。

### 2. `task_pass auto_start` 直启（open 房免 execute 聊天席）

- 仅 open 房、仅 `to_module=execute` 生效：`task_pass(room_id, task_path,
  to_module='execute', note, auto_start=true, expected_revision, ...)` 在同一事务
  里直接受理并启动 Worker（`passAutoStart`：`passInternal` 用 `deferDelivery: true`
  压住聊天唤醒 + `startAcceptedExecution` + 记账），不唤醒 execute 聊天席，
  不调 `dispatchToModule`，不产生 `room-task-handoff` 唤醒消息与 execute 聊天轮次。
  `auto_start` 配其他目标直接 400 拒绝；省略 `auto_start` 走普通交棒。
- 必备守卫：`expected_revision` 必须等于 `task_get` 当前 revision（不等即 409，
  先重读再试）；`objective` 必填（缺省取 `note`，为空即 400）；
  `return_to_module` 缺省 `review`；三轮闸先行（execute 满 3 轮未送审时连直启
  一起拒绝，先 `task_pass` 到 review / arbitration）。有在途 Worker job 时不直启，
  退化为普通 pass（`next` 语义，job 终态后生效）。
- 对应事件：账本记 `pass-auto-accepted`（`passId` / `toContact` / 冻结 binding /
  permissions / `bindingRevision` / `signature` / `objective` / `returnTo`）；
  群里只发一条系统事实（`messages.meta.event='room-task-pass-auto-start'`，
  幂等键 `task-pass-auto-start:v1:<passId>`，正文 `【任务直接执行】…不唤醒执行席
  聊天轮次。`），  `delivery.status='posted'` 即该事实 id。`review_submit` 落账本后的
  自动 pass 中，APPROVE 走 Q2 直启合入；REQUEST_CHANGES 自 R1 起直启返修
  Worker（见「降本第三批」），不再唤醒 execute 席。
- 幂等：幂等键缺省 `pass-auto:v1:<taskId>:<actor+expected_revision+参数签名>`，
  可显式传 `idempotency_key` 覆盖；同键同参数重试返回同一 job
  （`delivery.status='duplicate'`，关联条件 `options.handoffAutoStart=1` +
   `roomTaskHandoffId`），换参数重用同键即 409。

### 3. 增量 patch（`patchSince..HEAD` + `execution_get section=patch_delta`）

- Worker 采增量：`execution_start` 派单时把任务当前已 pin 候选
  （`room_tasks.candidate_sha`，40 位 hex 才带）记为 job `options.patchSince`
  （首轮尚无候选即不带）；`collectStructuredReceipt` 用它多采一段
  `patchSince..HEAD` 存 `delivery_meta.receipt.patchDelta`（与累计 patch 同一个
  `RECEIPT_PATCH_MAX_CHARS` 上限，超长截断并记 `patchDeltaChars` /
  `patchDeltaTruncated`），基线记 `patchDeltaBase`。
- `execution_get section=patch_delta` 读该增量（`receiptPatchDelta`）：成功页与
  `section=patch` 同一套分页（`patch_offset` / `patch_limit`，默认 0/120000，
  单页最大 120000；`patch_file` 按 diff 文件名只取该文件块；尾部
  `patchNextOffset` / `patchAtEnd` / `patchTotalChars` / `patchFiles`
  （最多 200 个）+ 下一页 hint），元字段为 `patchDeltaChars` /
  `patchDeltaTruncated` / `patchDeltaBase` / `patchSinceFallback`，
  `kind='patch_delta'`。
- 空态不抛错、回 404 指回累计：启动时无已 pin 候选、或 Worker 版本早于增量
  采集时无 delta，`该执行没有增量 diff（启动时任务没有已 pin 候选，或 Worker
  版本早于增量采集）；用 section=patch 读累计 diff`；增量超存储上限被丢弃
  （`patchDeltaDropped`，`boundedDeliveryMeta` 按尺寸上限先丢累计 patch 再丢
  增量）时回 `该执行的增量 diff 超出存储上限已丢弃；用 section=patch 读累计
  diff`（附原长 `patchDeltaChars`）。
- `patchSinceFallback`（见 `delivery.mjs`，只标记、不抛错）：
  `'invalid candidate baseline; no delta collected'`（非 40 位 hex）、
  `'candidate baseline unavailable; no delta collected'`（本地无该 commit）、
  `'no HEAD; no delta collected'`（无终态 HEAD）、
  `'candidate baseline is not an ancestor of HEAD; no delta collected'`
  （`isGitAncestor(since, HEAD)` 为假、且下面的 rebase 比对也做不了——没有
  `origin/master|main`，或任一侧不是主干上的分支）、
  `'delta collection failed; no delta collected'`（git 采集失败）。
- rebase 轮（merge-stale 自动回 execute 是最常见的返修轮）：旧候选不在新 HEAD
  祖先链上时，`rebaseDelta` 各取两个候选相对自己主干分叉点（`trunkForkPoint`）
  的 patch，去掉 `index` 行与 hunk 行号后比对（`patchIdentity`，同 `git patch-id`
  思路）。逐字一致 → `patchDeltaKind='rebase-identical'`、`patchDelta=''`，完成回执
  直接写「干净 rebase…逐字一致」，评审不必再读 diff；不一致 →
  `patchDeltaKind='rebase-range-diff'`，增量是两段提交序列的 `git range-diff` 原文。
- rebase 后的累计 patch：任务 `baseline_sha` 是新分叉点的祖先且二者不同
  时，累计 patch 改从分叉点量起（`patchBaseKind='task-baseline-rebased'`），即
  ff 合入实际会带进主干的内容；否则主干上别人的提交会整段混进来（2026-09-21
  实测：单文件候选被量成 15 文件 / 39k 字符）。未 rebase 时仍是 `task-baseline`。
- 与累计 `section=patch` 的关系：累计 patch（`patchBase` / `patchBaseKind` /
  `patchBaseFallback`，`task-baseline` 优先）不受增量影响，照常采集照常可读；
  完成回执带增量提示（`deltaHint`：增量优先，先读增量，需要全量再读
  `section="patch"`），评审先读 `patch_delta`、需要全量再读 `patch`。
  APPROVE 证据口径仍是累计侧：只看 `structuredReceiptFields` 的 `diffstat` /
  `changedFiles` / 非空全绿 `tests`，增量只省评审阅读量，不参与门禁。

### 4. `task_get section=summary`（只要状态，省 token）

- 返回什么：`view.task` 只要状态字段（`id` / `room_id` / `task_path` / `title` /
  `status` / `revision` / `owner_module` / `owner_contact` / `holder_module` /
  `next_module` / `candidate_sha` / `candidate_job_id` / `review_status` /
  `wake_count` / `updated_at`）+ 最近事件（`events`，`event_limit` 控制，默认
  100，上限 500，照常倒序取正序回）+ `cost`（与全量同一 `taskCost`：
  `attempts` / `durationMs` / `tokens` / `wakes`）。不含原始需求
  （`requirements`）、交接（`handoffs`）、证据（`evidence`）、尝试明细
  （`attempts`，即每轮 `jobBrief`）、等待（`waits`）、`unsettledRecoveries`，
  也不支持 `receipt_job_id` 回执分页。
- 什么时候用它代替全量 `task_get`：只需轮询状态/持棒/候选/revision
  （如下一动作的 `expected_revision` 取号、确认 holder 与 review_status、
  有无新事件）时用 `section=summary`；要读需求原文、核对证据链、看尝试明细
  或拉回执分页时用默认全量（`full`）。工具描述原话：只需状态时用
  `section=summary`（只回 holder/status/revision/candidate/review_status/
  最近事件与 cost，不含需求原文与证据）。

## 降本第二批（2026-09）

只做不改变闸门可信度、不改变权限边界的四件事；全部只在 open 房生效，
strict 房行为逐字不变。

### 1. 聊天席轮次用量进任务成本账（Q1）

- `room_task_turns` 增加可空 `message_id`（`ensureTurnSchema` 幂等加列，
  旧库不炸；`setTurnMessageId` best-effort 写入）。轮次结束时网关写入该轮
  最终 assistant 消息 id（`runtime/runtime.ts` done 路径，
  `recordTurnMessageId`）；拿不到就留空，不造数（PASS 沉默轮次气泡被物理
  删除、无消息轮次都保持 NULL）。
- 归属规则（`taskTurnCost`，只加不平均、不重复计）：turn 有 pinned
  `task_id` → 记给它；否则该轮 `room_task_turn_calls` 里 `ok=1` 的
  distinct `task_id` 恰好一个 → 记给它；零个或多个 → 不归属。同一联系人
  绑多个模块时按 turn 的 `module_id` 分（`byModule`），不按联系人分。
- `task_get`（全量与 `summary` 同一 `taskCost`）的 `cost` 增加
  `turns: { count, byModule: { <module>: { count, inputTokens,
  outputTokens, cacheReadTokens, cacheCreationTokens } }, tokens: {…合计} }`，
  用量来自 `message_usage`（LEFT JOIN：无 `message_id` 的旧行与
  `message_usage` 已删行只贡献 count，不抛错）。现有
  `cost.attempts/durationMs/tokens/wakes` 含义与形状不变（`tokens` 仍只是
  Worker attempt 之和）。

### 2. open 房 APPROVE 后直接启动合入（Q2）

- `review_submit` APPROVE 在 open 房不再唤醒 merge 席：同事务把棒交给
  merge（`passInternal` + `deferDelivery`，不投递聊天唤醒）**并**启动
  merge closure job（`reviewAutoReleaseToMerge`），等价于 merge 席调用
  `release_execute kind=merge return_to_module=review return_mode=handoff`；
  群里只发一条系统事实（`messages.meta.event='room-task-release-auto-start'`，
  幂等键 `task-release-auto-start:v1:<passId>`）。
- 闸门一条不减：手动 `release_execute kind=merge` 与自动路径共用同一
  `startMergeClosureRelease`（`mergeGates`、baseline/frozen SHA 校验、
  ReleaseEvidence 组装、幂等键 `release:v1:<task>:merge:<pinned>`、写租约、
  merge 冻结快照权限），不是复制的第二份逻辑。事件可区分：自动记
  `release-auto-started`（附 `initiatedBy` 评审人），手动仍记
  `release-started`。`dispatchSource` 两边都是 `explicit-release`（Worker
  照常直接跑脚本）。
- 权限与执行身份取 merge 模块当前绑定的冻结快照，不用 review 席权限。
  merge 无可用绑定、或任一闸门拒绝 → 回退为现行为（唤醒 merge 席），并记
  `release-auto-start-fallback` 说明原因；不因此 block。重复 APPROVE（同
  一候选）命中同一幂等键，返回已有 job（`existing: true`），不产生第二个
  job，复放也不重发 fact。

### 3. APPROVE 声明"合入成功即完成"（Q3）

- `review_submit` 增加可选 `after_merge: 'review' | 'done'`（默认
  `'review'` = 现行为；只在 `verdict=approve` 时有意义，否则 400；值随
  review 证据（`after_merge=…` 行）与 `review-approved` 事件落账；
  自动收口只认事件 payload 的结构化 `afterMerge`，证据正文那一行只供人读
  ——findings 是同一正文里的自由文本；strict 房接受但忽略）。
- merge closure job 终态 `done` 且 open 房且当前 pin 候选的 APPROVE 声明了
  `after_merge='done'` 且机器核对通过（复用 `scriptReportOf` +
  `mergeTargetBranchOk`，`scriptReport.head` 等于当前 pin
  `candidate_sha`，合入 job 的 `parentJobId` 仍是当前候选，review 仍
  approved 在同一证据上，该 APPROVE 之后无 re-pin/新结论）→ 网关直接把
  任务置 `closed`（事件 `done` 带 `auto: true` 与核对依据，另记
  `auto-closed` 防重放），不唤醒 review 席；群里发一条系统事实
  （`room-task-auto-close`，幂等键 `task-auto-close:v1:<jobId>`）。
- 任一条件不满足（无 scriptReport 的旧回执、head 不符、期间重新 pin、
  stale/failed、新结论）→ 现行为不变（回执唤醒 review 席）。
- Guidance：纯文档/无需部署的任务 APPROVE 时带 `after_merge="done"`；
  需要部署的不要带。

### 4. merge-stale 自动回 execute 时直接启动 rebase Worker（Q4）

- `autoPassMergeStale` 改为 P2 同款直启：同事务交棒（defer，不投递
  execute 席聊天唤醒）+ `startAcceptedExecution`，objective 用网关已有的
  rebase note 并补边界（无冲突则 force-with-lease 重推并送审；有冲突就地
  停、如实回报，不得自行解冲突后直接送合入），`return_to_module=review`。
  只发系统事实（`room-task-merge-stale-auto-start`），事件
  `merge-stale-auto-started`。
- 保持：`EXECUTE_ROUNDS_BEFORE_REVIEW` 三轮闸（触发仍 blocked，
  `merge-stale-blocked` 不变）、单写租约、execute 冻结快照权限、
  `patchBase`/`patchSince` 照常下发（rebase 增量判定照旧）。直启失败
  （无可用绑定、租约冲突等）→ 回退为现行为（唤醒 execute 席），记
  `merge-stale-auto-start-fallback` 事件。
- 附带：`startAcceptedExecution` 不再假设调用方有 model 轮次上下文
  （`toolContext` 可空；此前系统路径必有该上下文才行）。

## 会议室最小化第一刀（2026-09-21，User 拍板）

方向：会议室过度工程的地方逐步砍掉，机械步骤不再占席位、不再烧聊天轮次。
线上 9 条任务里 4 条撞过 merge-stale，每次多一轮 rebase execute + 一轮
全量重审（8–34 分钟）；deploy 席本来就只是替脚本按按钮。

### 5. 合入脚本自己干净 rebase，逐行一致不重审

- open 房的 merge closure 命令带 `--auto-rebase`（仅 posix Node 入口；
  PC 的 ps1 不认，照旧报 stale）。master 已超前时，脚本在工作分支上
  `git rebase --onto <fetched master> merge-base(master, frozen)`：
  有冲突，或 rebase 后候选自身 patch 与 frozen 的不逐行一致（与
  worker `patchIdentity` 同口径：忽略 `index` 行与 hunk 行号），就
  `rebase --abort` + `reset --hard frozen`，按原样报 stale，走 Q4。
- 逐行一致 → 在新 head 上跑完整验证集，push 新 head，报告
  `{head:<新>, rebasedFrom:<frozen>, rebase:'identical'}`。rebase 后任一
  验证失败也把分支放回 frozen，重跑时 Gate0 照样对得上账本。
- 网关只在报告同时写明 `rebase='identical'` 且 `rebasedFrom` 等于当前
  pin 候选时接受新 head（`mergedHeadOf`），记 `merge-rebased` 事件；
  评审 APPROVE 沿用，不回 execute、不重审。账本 `candidate_sha` 仍是评审
  过的 frozen，Gate L 服务端回验不变。

### 6. `after_merge='deploy'`：合入后直接部署，部署验证通过即收口

- `review_submit` 的 `after_merge` 增加 `'deploy'`（仍只在 approve 时有意义）。
- open 房合入 job done 且机器核对通过（与 Q3 同一套 `provenMergeAfterApproval`）
  且声明 `deploy` → 同事务交棒 deploy（不投递聊天唤醒）+ 启动 deploy closure
  （`startDeployClosureRelease`，与手动 `release_execute kind=deploy` 共用，
  合并回执闸门一条不减），部署 SHA 取合入实际推上 master 的 head。事件
  `release-auto-started`（`kind='deploy'`、`mergeJobId`），系统事实
  `room-task-deploy-auto-start`。
- deploy closure done（脚本 deploy ok + `/api/health`）→ 任务已折叠为
  `closed`，网关记 `done`（`auto:true`）+ `auto-closed`，发
  `room-task-auto-close` 事实，不唤醒评审席。deploy 失败 → `blocked` +
  现行回调唤醒评审席。
- 只覆盖 ai-hub 自部署：候选带其它 `projectTarget.repoId`、deploy 无绑定或任一
  闸门拒绝 → `deploy-auto-start-fallback` 事件 + 现行为（唤醒评审席）。
- Guidance：纯文档/无需上线 → `done`；需要上线的 ai-hub 改动 → `deploy`。

## 降本第三批（2026-09）

只在 open 房生效，strict 房行为逐字不变。R1、R2-D 已上线（R2-D 替代上轮拦停的 R2a–R2c；
User 2026-09-22 拍板选 D，授权改 `deploy/merge-close-job.mjs`）。

### R1：open 房 REQUEST_CHANGES 直启返修 Worker（无 execute 聊天席）

- `review_submit` REQUEST_CHANGES 在 open 房不再唤醒 execute 席：结论落账本后
  网关在同一流程里直接交棒 execute（`passInternal` + `deferDelivery`，不投递
  聊天唤醒）**并**启动返修 Worker（`reviewChangesDirectStart`），等价于 execute
  席把 findings 转成 objective 再起 job；群里只发一条系统事实
  （`messages.meta.event='room-task-review-changes-auto-start'`，幂等键
  `task-review-changes-auto-start:v1:<passId>`，正文 `【返修直接启动】…不唤醒
  execute 席聊天轮次。`）。
- objective = 固定前言（`REVIEW_CHANGES_DIRECT_OBJECTIVE_PREAMBLE` =
  `按评审 MUST 项返修；逐项满足通过条件；完成后送审`）+ findings 原文，
  截断到既有 20_000 上限；`return_to_module='review'`。
- 闸门一条不减：三轮闸（按**本次结论落账前**的轮次计：已满 3 轮未送审时不直启，
  回退为唤醒 execute 席并记 `review-changes-auto-start-fallback`）、单写租约、
  execute 冻结快照权限、`patchBase`/`patchSince` 照常下发（返修增量判定照旧），
  唤醒预算与 Q4 同口径（pass 唤醒 + job 启动各计一次）。
  直启失败（无可用绑定、租约冲突、budget 等）→ 回退为现行为（唤醒 execute 席），
  记 `review-changes-auto-start-fallback` 说明原因；不因此 block。
  直启成功记 `review-changes-auto-started`（`jobId` / `passId` /
  `returnTo='review'`）。`review_submit` 返回的 `autoPass` 在 open 房 REQUEST_CHANGES
  时增 `jobId`（直启的返修 job；回退时为 `fallbackReason`）。
- Guidance：findings 按可直接执行的 MUST 项 + 可判真伪的通过条件写，
  它们会原样成为返修 Worker 的 objective。

### R2-D：评审附小补丁（APPROVE + patch，由合入脚本机械应用）

- `review_submit` 增加可选 `patch`（unified diff 文本），仅 `verdict=approve` +
  open 房；strict 带 → 400，PC 工作区（Windows 路径）带 → 400。机器闸（具名常量
  `REVIEW_PATCH_MAX_CHARS=8000` / `REVIEW_PATCH_MAX_LINES=40` /
  `REVIEW_PATCH_MAX_FILES=3`，具名敏感清单 `REVIEW_PATCH_SENSITIVE`）：任一不满足
  → 400 写明哪条，不自动降级。上限、文件 ∈ 候选 `changedFiles` 或测试文件
  （`**/test/**`、`*.test.*`）、不得新增/删除/重命名/改 mode/binary、敏感清单、
  严格解析（路径规范化无 `..`/绝对路径、a/ b/ 一致，复用 `splitPatchByFile` /
  `listPatchFiles`）。
- 通过后照常落 review 证据与 `review-approved` 事件：payload 增结构化
  `patch:{sha256,chars,lines,files}`，补丁原文进证据正文**且**另存
  `room_task_evidence` 新 kind `review-patch`（body 为原文，id 记进事件 payload）。
  一切机器判定只读事件 payload 结构化字段。`candidate_sha` 不推进、review 照常
  approved：合入链看到的仍是 frozen 候选，Q2 直启合入、`mergeGates`、Gate L 回验一行不改。
- 合入脚本（本次授权修改）在 Gate0 → stale/rebase 判定（head 定下来之后）→
  应用补丁 → 验证集 → push：`git apply --check --index` 严格模式 →
  机器身份（`ai-hub-merge`）commit（message 含 taskPath、review evidence id、
  patchSha256）→ `git diff <应用前 head> <新 head>` 经 `patchIdentity` 逐字一致
  否则失败。新参数 `--review-patch-b64` / `--review-patch-sha256`
 （两者同现、sha 对得上、解码后 ≤ 上限），`buildMergeClosureCommand` 透传
  （仅 posix，ps1 不加）。任一失败恢复到应用前（rebase 场景回到 frozen），报告
  `patch:'failed'`；dry-run 验证后恢复。终报 `patch:'identical'` /
  `patchedFrom` / `patchSha256`，与 rebase 叠加时两组字段都带。残留恢复对齐
  `leftoverCleanRebase`。
- 网关 `mergedHeadOf(report, pinned, expectedPatchSha256)` 扩展：`patch==='identical'`
  且 `patchedFrom` 等于 pinned（或 rebase 叠加时的 rebase 后 head）且 `patchSha256`
  等于 pin 候选 APPROVE 事件 payload 的 `patch.sha256` → 接受 head；缺字段或 sha
  不符 → null（唤醒评审席）。合入 job done 记 `merge-patched{jobId,from,to,
  patchSha256,evidenceId}`；`after_merge` done/deploy 照常生效，部署 SHA 取
  `mergedHeadOf`。Q2/手动 `release_execute kind=merge` 共用
  `startMergeClosureRelease`，有 patch 时从 `review-patch` 证据取原文算 b64/sha 传入。
- Guidance（open）：小修 APPROVE 直接附 `patch`，由合入脚本机械应用并全量验证后合入；
  超出即 REQUEST_CHANGES（R1 已直启返修）。strict 文案不动。

### 合入清单 `.ai-hub-merge.json`（非 ai-hub 仓，User 2026-09-22 拍板）

- 非 ai-hub 仓（如 PC 工作区 `C:/work/pet-daily`）review APPROVE 后要走会议室合入闭环，
  在该仓根放 `<repo>/.ai-hub-merge.json` 声明自己的门禁：
  `{"repoId":"pet-daily","targetBranch":"master","validation":[{"suite":"npm test","command":"npm","args":["test"]}]}`。
  `command` 只允许 `npm` / `node`（spawn 数组执行，不经过 shell），`args` 为字符串数组且
  不含换行/`..`；`validation` 非空（最多 32 组）。清单不合法即拒绝合入（fail closed），
  不回落到别的仓的套件。
- 两个脚本（`deploy/merge-close-job.ps1`、`deploy/merge-close-job.mjs`）同一优先级：
  显式 `--repo` / `-Repo` → 现有映射（ai-hub 六套件 / ai-dashboard 四套件，不读清单）；
  否则有清单 → 用清单的 repoId、targetBranch（显式 `--target-branch` / `-TargetBranch`
  仍优先）与套件（cwd=repoDir）；否则 → 现行 ai-hub 默认。回执 `scriptReport` 增
  `repoId`、`manifest: true|false`。ai-hub / ai-dashboard 现行行为逐字不变
  （ai-hub 仓根无清单，显式 `--repo ai-dashboard` 不读清单）。
- 网关 `buildMergeClosureCommand`：无冻结 projectTarget 时把候选 `candidate.workspace`
  作为 `-RepoDir` / `--repo-dir` 传给两个入口（不传 `--repo`）；有 projectTarget 时现行不变。
  `mergedHeadOf` 与 deploy 闸不改；非 ai-hub 仓 APPROVE 只可 `after_merge=done`
 （deploy 自动直启仍只覆盖 ai-hub，走 `deploy-auto-start-fallback`）。
- ps1 新增 `-DryRun`（与 mjs `--dry-run` 同语义：门禁全跑、验证记 pass 不执行、不 push）。

### Min-closure-2：W 序列下一块直启（open 房，User 2026-09-23 安排第二刀）

- plan 派首块时 `task_pass to_module=execute + auto_start=true` 可带 `sequence`
  （整条 W 序列，数组，每项 `{label, objective, write?, shell?}`，最多
  `ROOM_TASK_SEQUENCE_MAX_ITEMS=20` 项）：首项即本次直启目标（与显式
  `objective` 并存时必须相同，否则 400；省略 `objective` 时取首项）。
  账本 `room_tasks.sequence_json` 存全文、`sequence_index` 存当前下标（首块为 0，
  落账不 bump revision），事件 `sequence-started`（首设）/
  `sequence-replaced`（再传即替换）带全文与下标。
- 合入核对通过（同一套 `provenMergeAfterApproval`，`mergedHeadOf` 校验通过之后、
  `after_merge` 分流之前）：账本有 sequence 且还有下一块 → 按 execute 冻结快照
  直接启动下一块 Worker（`trySequenceNext`：`passInternal` + `deferDelivery` +
  `startAcceptedExecution`，`return_to_module='review'`），账本下标 +1 并记
  `sequence-next-started`（`{index,label,jobId,passId,mergedSha,mergeJobId}`），只发
  一条系统事实（`room-task-sequence-next-auto-start`，正文 `【序列直接启动】`），
  不唤醒 review/plan 席。直启失败（无可用绑定、闸门拒绝、租约冲突、budget 等）
  → 记 `sequence-next-fallback`（`{reason,index,label,mergeJobId}`）并回退现行为
  （唤醒 review 席）。同一 merge 终态重放靠 `sequence-next-started /
  sequence-completed / sequence-halted` 的 `mergeJobId` 去重，不重复直启。
- 最后一块合入通过：有 `after_merge` 声明（`done`/`deploy`）按原收口走（序列随之
  清空，记 `sequence-completed`）；无声明（`after_merge='review'`）则交棒回 plan
  （唤醒 plan 席，不唤醒 review 席），同样记 `sequence-completed` 并清空。
- 任一块 REQUEST_CHANGES 走现有 R1 直启返修；返修 APPROVE 合入后序列照常继续。
  派下一块时三轮闸已满 → 不再直启：清空序列、记 `sequence-halted`（`{reason}`）、
  唤醒 plan 接管（merge 回调被消费，不再唤醒 review）。
- plan 随时可干预：再传 `sequence` 即替换（`sequence-replaced`）；裸 `task_pass`
  到 plan 接回棒并清空（`sequence-cleared`，`reason='pass-to-plan`）；`task_block` /
  `task_done` 同样清空（`reason='blocked'/'done'`）。`wakeBudget` 上限不动；直启
  只是不投递聊天唤醒，`passInternal` + `startAcceptedExecution` 内的 budget 会计
  与现有 execute 直启同口径。
- migration `0040_room_task_sequence.sql`（`sequence_json` / `sequence_index`）；
  单测 `server/test/roomTaskSequenceDirect.test.mts`（T1–T7）。

## End-of-turn handoff obligation (model-directed, gateway-validated)（strict；待观察一周后删除）

For every related unfinished task (trusted pinned task plus tasks this turn
successfully read/created/operated — failures and cross-room attempts excluded),
the turn must leave one verifiable disposition before a normal final: keep
executing an active job with a valid unfenced explicit callback (acknowledged
this turn via `execution_start`/`release_execute`/`execution_get`), deliver an
explicit `task_handoff` (pending/accepted, dispatch posted), register
`task_wait`, decline a pending incoming handoff, or genuinely close the task.
`task_accept` alone never settles (it only acquires responsibility); old
handoffs, duplicate idempotency replays, historical waits, stale revisions,
terminal/fenced jobs, and a live pending handoff addressed back to this turn
never settle stale receipts — final owner and the live handoff edge are
re-read at terminal time. Missing disposition records an honest
`turn-unsettled` event plus a visible error naming the tasks: no normal done,
no PASS pruning, no invented block, no automatic next stage or reprompt.
Runtime errors/cancel can never claim normal completion. DM and task-free
conversation are unaffected.

A job that finishes during its launching controller turn may settle that
turn through its exact registered completion handoff if delivery succeeded.
A later read of the old terminal job still cannot settle a new turn. Tool
JSON envelopes are never cut mid-string; receipt pagination preserves full
task revision/owner and exact handoff/job IDs even for long requirements.

`task_wait` needs `expected_revision`, a substantive reason and a
resume condition/question; it persists structured evidence + event and shows
in `task_get`/UI. No timers, no auto-wake. Owner/module turns use
`blocked`/`waiting_user` (task-level); a verified non-owner callback turn may
record ONLY its own callback-scoped `waiting_owner` (exact callback
provenance: registration, task, contact, module, unfenced) without changing
task status/owner/revision or gaining handoff/release rights. Workers never
call task tools: the execution prompt requires real progress/evidence/
blocker/resume reporting in the receipt, while the room-controller callback
side carries the obligation.

## Reads (User UI)

`GET /api/room-tasks/:roomId`, `GET /api/room-tasks/:roomId/:taskFile`
(`receipt_job_id/receipt_offset/receipt_limit/event_limit`). The chat pane
shows a task ledger panel per workflow room (stale-response guarded),
including waits (reason/resume) and unsettled markers; module binding board
stays.

## Migration

One control owner per task. The old host/auto pipelines are stopped first:
no `scanCoordinationIfDue` execution/verification (hygiene digest preserved),
no `processCoordination`/`processVerification` dispatches, no review batch,
no `ensureAutomatic*`, no marker-gated delegates, no out-of-band auto
sweep, no route-triage auto-dispatch, no deferred room-host replay in
workflow rooms (verified task refs still recover; legacy host sources are
marked retired). `POST /:id/room-host/messages` returns 410 for workflow
rooms except wake-free `trigger=false` notes (ancillary digests persist
without waking any model); history GETs stay.
In-flight legacy attempts finish and keep stored results plus in-place
receipt updates. Blocked legacy work continues via `task_import` under the
same room (verified jobs attach; old failures are never rewritten) followed
by explicit handoff/accept/execution. The blocked-job out-of-band
auto-resolver no longer runs on a timer (explicit reconcile routes stay).
Existing callback registrations remain notification-only: 0036 does not
retroactively turn historical callbacks into ownership transfers. Resume a
stalled historical task through its current owner and an explicit handoff.

## Limitations

- 车道 A（merge）/ 车道 B（deploy）机械收口是确定性 job：`release_execute`
  下发 `options.closureCommand`（win/posix 双目标 + timeout），Worker 按平台
  直接 `spawn` 脚本（Windows `powershell -File`，POSIX `node`，args 数组原样
  传递），不经任何模型 runner、不进 stall 看门狗、不做 session resume。
  回执正文是固定的 `【closure <kind> raw receipt】` + 脚本原始 stdout/stderr
  全文（各 200k 上限，超限留头尾并标注）；`delivery` 由 stdout 最后一段 JSON
  确定性推导（merge `ok:true+lane:merge` → `delivered_waiting_deploy`，
  deploy `ok:true` → `closed_loop`，否则 `failed`），`receipt.scriptReport` /
  `scriptExitCode` 进账本，`receipt.tests` 从脚本 `tests` 数组归一化映射。
  `release_execute` 提示词保留给人读，但多一行「Worker 将直接执行
  closureCommand，不经模型」。实现轮次本身不做 SSH/push。
  网关 deploy 闸优先读 `receipt.scriptReport`（无则回落旧 result 正则），
  拒绝逐项列缺失并附 `git ls-remote origin refs/heads/master`。
- Plan turns create/import; a task needs its accepted chain before execution.
- Closed tasks never downgrade; late finishes only append evidence.
- Across a gateway restart, a deferred wake may replay once (durable refs
  are preserved); the dispatch ledger still prevents same-process
  double-wakes and explicit retries stay idempotent.

## Receipt facts (worker-collected, gate inputs)

### User ledger entry (D3)

`POST /api/room-tasks/:roomId` accepts a signed User login session (cookie or
session bearer); raw hub/worker/model credentials and unauthenticated setups
get 401. The body contains `task_path`, `workspace`, optional `title` and
`requirements` (default: Vault original), and optional `dispatch` with
`to_module: plan|execute`, `request`, `auto_start`, `return_to_module`.
Only enabled workflow rooms and Worker-whitelisted workspaces are accepted.
The visible user anchor `建账：<task_path>`, task and optional auto-start job
commit together; validation/launch failures leave no rows or SSE. Duplicate
paths return 409. The creator and handoff initiator are User, without a fake
plan turn; the implementation still uses the frozen execute binding.
Ordinary handoffs wake their recipient after commit. Model `task_create`
and `task_handoff` retain their original membership/nonce/owner checks.
The ledger's “建账并派单” form reads `/api/workers` workspaces, defaults to
direct execute, and refreshes the ledger after successful creation. A failed
handoff delivery remains visibly pending and is reported instead of claiming
that a model has started.

### Captured receipt

- The per-round receipt statistics (`diffstat`, `changedFiles`) are measured
  from `patchBase`: the pre-job HEAD when the job continued the same line of
  history (`patchBaseKind=round`), otherwise the merge-base with
  `origin/master` (`branch-base`) so a job that branched from the default
  branch reports the candidate itself, not the previous checkout's branch.
  With no default-branch ref the pre-job HEAD stays the base and the kind is
  `cross-branch`.
- D4b: migration 0037 adds nullable `room_tasks.baseline_sha`. The first
  unfenced implementation completion records its Worker `before.head` once.
  Later execution jobs receive it as `options.patchBase`; takeover preserves
  that option. The Worker captures the cumulative baseline-to-HEAD patch
  (`patchBaseKind=task-baseline`) while retaining round snapshots/statistics.
  An unavailable baseline falls back to the round diff with an explicit
   `patchBaseFallback`. `execution_get section=patch` exposes that metadata.
   Patches are capped at 120,000 characters; the 800,000-character JSON envelope
   accommodates escaping and still drops oversized patches explicitly.
   `section=patch` pages with `patch_offset`/`patch_limit` (default 0/120000,
   max 120000 per page) and slices one file with `patch_file`; every page ends
   with `patchNextOffset`/`patchAtEnd`/`patchTotalChars`/`patchFiles` (up to 200)
   plus a next-page hint, so reviewers page a large diff instead of depending
   on model retelling.
- `structuredReceiptFields` reads `delivery_meta.receipt`, then
  `delivery_meta.declared`, and only when neither carries a field falls back
  to a `{"delivery":{...}}` declaration embedded in the stored result text
  (rows written by worker releases that never scanned the joined OpenCode
  result). Git-collected receipt facts always win; the fallback never rewrites
  rows.
