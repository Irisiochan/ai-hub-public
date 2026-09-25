# ai-hub 架构（living doc）

> 本文按**功能模块**写：每个模块做什么、从哪进、存什么、代码在哪、依赖谁、守哪些不变量；§4 是模块边界规则。
> 实现细节看代码，演进史看 git 与 vault；改动「扩展清单」（§8.2）里的位置必须同步本文（维护规则 §9）。
> 产品边界见 [CHARTER.md](CHARTER.md)；会议室任务工作流的完整协议见 [model-driven-room-workflow.md](model-driven-room-workflow.md)；
> 部署手册见 [../deploy/setup.md](../deploy/setup.md)；最小实现规则见 [MINIMAL_IMPLEMENTATION.md](MINIMAL_IMPLEMENTATION.md)；
> 原始设计 [plan.md](plan.md)（2026-07-18，历史，不再维护）。
>
> 最后整体核对：2026-09-24（migration 最新 0040）。同日完成模块化重构：每个功能模块一个目录、跨模块只走公开面、
> 依赖方向由测试强制（§4）；行为不变。

## 0. 定位

ai-hub 是 User 一个人用的 IM 式 AI 网关：每个 AI 联系人一条永续长对话，跑在她自己的 VPS 上；
模型侧接 CLI 订阅（Claude Code / Codex / Grok / OpenCode / Kimi）或 API 直连，共享同一个 Memory Vault；
「后台自动化」（triage worker）和「让 AI 去干活」（会议室任务账本 + Worker 派工）也收进同一个网关。

**不是什么**：不是多租户产品；不是通用 agent 平台（联系人身份与家规写死在人设与 overlay）；不对公网开放聊天面。

## 1. 运行拓扑（2026-09-22）

```
User 的手机 / PC / 微信
   │  Tailscale（tailnet 内直连）  或  微信 iLink（网关主动长轮询，无入站）
   ▼
VPS-52-xj401p = tailnet 名 User-house（100.64.0.10）
   ├─ ai-hub.service              网关（server/）100.64.0.10:3900 + 127.0.0.1:3900   User=ai-hub
   ├─ ai-hub-triage-worker        后台自动化（worker/triage-worker.mjs）127.0.0.1:3911 webhook   DynamicUser
   ├─ ai-dev-worker               VPS 执行端 vps-dev（worker/worker.mjs 的发布副本）  + release timer
   ├─ memory-vault-mcp            Vault MCP 100.64.0.10:8900   User=memory-vault
   ├─ memory-vault-mcp-public     Vault MCP 127.0.0.1:8901 + 秘密路径 → Tailscale Funnel 公网
   ├─ ai-hub-update.path/.service 部署触发器（root，监视 /var/lib/ai-hub/deploy.request）
   └─ tailscaled / wg-vps          网络层，不属于本仓

PC（Windows）
   ├─ PC 执行端 pc-User   worker/worker-launcher.ps1 托管 worker/worker.mjs（按 commit 导出的发布副本）
   │                      只出站：长轮询 /api/worker/claim，无入站端口；承接摄像头、淘宝、局域网 ssh、Windows 构建
   └─ offsite 备份拉取    deploy/pull-offsite-backup.ps1（ssh 别名 User-vps）
```

- 网关只绑 tailnet IP 与回环（`server/config.json` 的 `host`；非回环单播 host 自动加绑 `127.0.0.1`，`platform/config.ts resolveListenHosts`）。
  唯一公网入口是 Funnel 暴露的 vault 公网实例（给 claude.ai / 手机 MCP 用），URL 含随机路径。
- 一台机器、一个 SQLite（`/opt/ai-hub/server/data/hub.db`）、一个 vault clone（`/opt/memory-vault`）。没有 Docker、反代、对象存储。
- 主机变更史：2026-07-11 VirCS 首次部署 → 2026-09-04 整机迁到 VPS-52-xj401p（vault `memories/vps-migration-vircs-to-xj401p-2026-09-04`）。

## 2. 功能模块总览

四个可部署单元：**网关**（`server/`，一个 Node 进程）、**triage worker**（`worker/triage-worker.mjs`）、
**执行端**（`worker/worker.mjs`，PC 与 VPS 同一份代码）、**客户端**（`web/` 与 `mobile/` `desktop/` 壳）。
仓库级共享代码只有 `shared/contact-config`（联系人配置 zod schema）与 `shared/coordination-keys`（派单指纹与 key）。
`shared/contact-config` 由 server/web/desktop 以 `file:` + `install-links=true` 拷贝安装，npm 只按版本号判断副本新旧：
改它的内容必须同时升版本，并用 `npm install --package-lock-only --prefix <消费端> @ai-hub/contact-config@file:../shared/contact-config`
把新版本记进三份 lock（裸 `npm install` 不会动旧条目）。守门：`deploy/check-shared-packages.mjs`（server `npm test` 与 CI `shared-packages` job）。

| # | 模块 | 一句话职责 | 目录 | 主要入口 |
|---|---|---|---|---|
| — | 平台内核 | 配置、SQLite 与 migration、日志、SSE、鉴权中间件、网关工具契约 | `server/src/platform/` | `GET /api/events` |
| M1 | 联系人 | 联系人注册、配置校验、人设三层、seed、模型目录、用户资料 | `server/src/contacts/` | `/api/contacts`、`/api/user` |
| M2 | 对话与消息 | 消息存储、来源语义、附件与图片转写、已读、用量、日视图 | `server/src/messages/` | `/api/attachments`、`/api/journal/day` |
| M3 | 联系人运行时 | 每联系人串行运行时、生命周期、会议室轮次与部署续跑；聊天控制与模型切换 API | `server/src/runtime/` | `/api/contacts/:id/messages…`、`:id/models\|model\|effort` |
| M4 | 模型后端 | 7 种后端适配：CLI 子进程协议与 API 直连 | `server/src/backends/` | 内部 |
| M5 | 提示词与上下文 | 静态前缀、每轮块、滚动摘要、CLI 历史桥接、工具输出压缩 | `server/src/prompt/` | 内部 |
| M6 | 记忆 | Vault 读注入、User 原话捕捉、当日流水注入、Vault MCP 客户端与 outbox | `server/src/memory/` | 内部 |
| M7 | Vault 任务状态 | Vault `tasks/` 状态的单写者命令事务、投影与聊天回写 | `server/src/tasks/` | `/api/vault/task-status` |
| M8 | 会议室 | `kind=room` 群聊的点名解析与群提示词块 | `server/src/rooms/` | 经 M3 的消息接口 |
| M9 | 工作流模块 | 七模块绑定、权限、委派范围与签名 bearer、额度池、历史协调行 | `server/src/workflow/` | 视图与接管经 M11 路由 |
| M10 | 会议室任务账本 | 模型驱动的任务交接/执行/评审/发布/回调账本（strict 与 open 治理） | `server/src/roomTasks/` | `/api/room-tasks`、网关工具 `task_*` |
| M11 | Worker 派工 | job 生命周期、领取/租约/回执 outbox、能力卡、目标围栏、收口命令、委派工具 | `server/src/jobs/` | `/api/workers`、`/api/jobs`、`/api/worker/*`、`/api/workflow-modules` |
| M12 | 网关工具 | 给 CLI 联系人的 Hub MCP 端点（契约与 bearer 在平台内核） | `server/src/tools/` | `/api/hub-mcp/:contactId` |
| M13 | 设备桥 | 摄像头抓帧、淘宝桌面 MCP：网关停放请求，PC 执行端领取回传 | `server/src/devices/` | 网关工具 `camera_snap`、`taobao_*` |
| M14 | 陪伴 | 生活事件、心跳回执策略（`companion/`）；模型自决的周期心跳（`heartbeat/`） | `server/src/companion/`、`server/src/heartbeat/` | `/api/contacts/:id/heartbeat`、`/api/system/life-events` |
| M15 | 微信通道 | iLink bot 长轮询，前缀路由到联系人 | `server/src/wechat/` | 出站长轮询 |
| M17 | 订阅额度 | Claude/Codex/Grok 订阅额度轮询 | `server/src/quota/` | `/api/quota/*` |
| M18 | 运维 | SQLite 备份、软删清理、一键部署/状态、发布状态、Android OTA | `server/src/ops/` | `/api/system/*`、`/api/app/latest`、`/releases` |
| — | 组合根 | 进程装配与生命周期（`index.ts`）、HTTP 装配与内联端点（`server.ts`） | `server/src/index.ts`、`server.ts` | `/api/health`、`/api/session` |
| W1 | triage worker | 定时/变化/webhook 事件分诊，主动陪伴、提醒、议程、日记 rollup | `worker/triage/` | 独立进程，只经 HTTP 调网关 |
| W2 | 执行端 | 领 job、在工作区跑 runner、回执、供给工作区、收口脚本、设备桥 | `worker/runner/` | 独立进程，只出站 |
| C | 客户端 | React 移动优先 IM 界面，按功能分目录（§4.5）；Android / Electron 壳 | `web/src/`、`mobile/`、`desktop/` | 网关 serve `web/dist` |

## 3. 模块详解

每节格式：**职责 / 入口 / 数据 / 代码 / 依赖 / 不变量**。「依赖」是 §4.2 表里允许并实际使用的模块（平台内核人人可用，不列）。

### M1 联系人

- **职责**：`contacts` 行（`kind` = `dm` | `room`；`backend` = `claude-cli` | `codex` | `grok-cli` | `opencode-cli` | `kimi-cli` | `api` | `dsh`，
  `dsh` 为 DeepSeek harness 实验位）；`config` JSON 按 `shared/contact-config` 校验。**人设三层**：DB `config.appendSystemPrompt`
  ← 仓库 `server/agents/<id>/{CLAUDE.md,AGENTS.md}` ← 网关注入 `overlay.md`（口吻与交付的最高优先级，见 [prompt-layers.md](prompt-layers.md)）。
  启动时 `seed` 只在联系人不存在时补建（I-16）。模型目录（`modelCatalog.ts`）。用户资料（User 的显示名等）。
- **入口**：`/api/contacts`（`contacts/contactRoutes.ts`：列表/增删改；模型与推理强度端点在 M3 的 `runtime/modelRoutes.ts`）；`/api/user`（`contacts/userRoutes.ts`）；SSE `contact`、`user`。
- **数据**：`contacts`、`settings`（`user_profile`）。
- **代码**：`server/src/contacts/`（`contactRoutes.ts`、`userRoutes.ts`、`seed.ts`、`modelCatalog.ts`、`configSchemas.ts`）；`shared/contact-config`。
- **依赖**：M2（列表带已读态）。改配置后要通知运行时，经端口 `ContactRuntime`（§4.3）。
- **不变量**：I-10、I-16。

### M2 对话与消息

- **职责**：消息行（`sender`、`role`、`kind`、`status` streaming/done/error/interrupted、`turn_id`、`meta`、`origin` main|side）；幂等键；
  附件（uploads 目录 600 权限）与图片 caption 旁路转写（fail-open）；主窗已读游标；按联系人 token/成本日账与 prompt-cache 诊断；
  按上海日给 triage 日记 rollup 的日视图；软删消息的物理删除工具（被 M18 的清理调用）。
  **消息来源三件事分开存**（`messageSource.ts`）：provider 协议角色 / 领域来源 `sender`·`origin` / 结构化 `automation` 描述符；
  前端与 triage 只按后两者判「是不是 User 手动说的」，旧记录才允许正文 fallback（I-9）。side 已退役为审计层
  （[split-private-and-side-channel-windows.md](split-private-and-side-channel-windows.md)）。
- **入口**：`/api/attachments`（`messages/attachmentRoutes.ts`）；`/api/journal/day`（`messages/journalRoutes.ts`）；`/api/system/captions`（组合根内联）。
  消息的发送/流式/重生成/中断等控制端点属于 M3（`runtime/messageRoutes.ts`），因为它们驱动运行时。
- **数据**：`messages`、`message_attachments`、`message_read_cursors`、`usage_daily`、`message_usage`、`caption_usage`。
- **代码**：`server/src/messages/`（`messageRepo.ts`、`messageSource.ts`、`sideChannel.ts`、`usageRepo.ts`、`readState.ts`、`attachments.ts`、`captionService.ts`、
  `attachmentRoutes.ts`、`journalRoutes.ts`）。
- **依赖**：无（只用平台内核）。
- **不变量**：I-5、I-7、I-9、I-18。

### M3 联系人运行时

- **职责**：`AgentManager` 为每个启用联系人（及每个「会议室×成员×模块绑定」）持有一个 `AgentRuntime`；**FIFO 串行队列，同一时刻一轮 in-flight**
  （容量 5，满 429）。懒启动；崩溃后下一条消息带 resume 重启；5 分钟内连崩 3 次锁定待手动 reset。CLI 两段超时 `turnIdleTimeoutMs`（默认 300s，
  任一事件重置）/ `turnHardTimeoutMs`（默认 900s），分别落 `turn-idle-timeout` / `turn-hard-timeout`；API 与 DSH 走 `api.turnTimeoutMs`。
  `interrupt()` / `regenerateFrom()` 做 CLI 上下文失效。会话 token（claude session_id / codex thread）存 `sessions`，resume 失败开新会话、历史不丢。
  会议室：轮次 `roundId`、成员运行时键 `room:member[::module::bindingHash]`、部署 drain 与 durable 派发续跑（`stopAll('deploy-restart')`）；
  模块轮次还在运行时内做：模块快照注入、origin-turn nonce 登记/结算、交接义务检查与一次有界补办、open 房自动传棒 flush。
  `backendFactory.ts` 按 `contacts.backend` 构建后端并为 API 直连后端组装本轮工具。`roomTaskDispatch.ts` 是 M10 派发端口的实现（经 manager 唤醒被交接的成员）。
  `roomDispatchRecovery.ts` 管会议室派发的 durable 状态（`messages.meta.roomDispatch`）与部署重启后的续跑。
- **入口**：`/api/contacts`（`runtime/messageRoutes.ts`：`:id/messages` GET 分页 / POST 入队 202、`:mid/regenerate`、DELETE、`:id/interrupt`、`:id/session/reset`、
  `:id/usage`、`messages/read`、`:id/room-rounds/:roundId`、`:id/room-host/messages`（coordination 类已退役 410，历史 GET 保留）；
  `runtime/modelRoutes.ts`：`:id/models`、`:id/model`、`:id/effort`）；SSE `message`、`delta`、`status`。
  被 M10（交接/回调唤醒）、M14（心跳 tick）、M15（微信）调用。
- **数据**：`sessions`、`room_member_state`（0004）；会议室派发状态写在 `messages.meta`。
- **代码**：`server/src/runtime/`（`manager.ts`、`runtime.ts`、`backendFactory.ts`、`sessionRepo.ts`、`debouncer.ts`、`roomDispatchDrain.ts`、
  `roomDispatchRecovery.ts`、`roomTaskDispatch.ts`、`messageRoutes.ts`、`modelRoutes.ts`）。
- **依赖**：M1、M2、M4、M5、M6、M7（任务回写）、M8、M9、M10、M11、M13、M14（`companion/`）。运行时是编排中心，依赖最多（§4.6）。
- **不变量**：I-1、I-4；「持久会话」（claude/codex 常驻，preamble 只在 (re)spawn 注入）与「每轮新进程」（grok/API 每轮重传）是两种世界。
  CLI 子进程 env 必须剥掉 `CLAUDECODE` 与 `ANTHROPIC_BASE_URL/API_KEY`。

### M4 模型后端

- **职责**：`ClaudeCliBackend`（stream-json 持久子进程 + `--resume`）、`CodexAppServerBackend`（app-server JSON-RPC + thread/resume）、
  `GrokCliBackend`（headless，每轮新进程；会议室轮次用私有 `.grok-runtime` 家目录加载 Hub 与 vault MCP，见 [GROK-ROOM-MCP-REPAIR.md](GROK-ROOM-MCP-REPAIR.md)）、
  `OpencodeCliBackend`、`KimiCliBackend`、`DirectApiBackend`（anthropic / openai-compat / gemini，无 resume，靠历史回放）、`DshHarnessBackend`（实验）；
  各 CLI 的模型列表与 API 供应商 `/models` 发现（`apiModels.ts`）。识图四种喂法见 [image-recognition.md](image-recognition.md)。
- **代码**：`server/src/backends/`（`claudeCli.ts`、`codexAppServer.ts`、`contactHttpMcp.ts`、`grokCli.ts`、`grokRuntimeHome.ts`、`opencodeCli.ts`、`kimiCli.ts`、
  `directApi.ts` + `directApi/*`、`dshHarness.ts`、`jsonlProcess.ts`、`types.ts`、`turnTimeouts.ts`、`turnInterruption.ts`、`apiModels.ts`）。
- **依赖**：M1、M2（API 历史读消息）、M5（摘要/压缩）、M6（时间戳化历史）、M8（群提示词块）。
- **不变量**：I-13、I-14。CLI 权限：claude 走 MCP 白名单直通、Bash/Write/Edit 硬禁；codex `approvalPolicy=never`、默认 `sandbox=read-only`，
  仅 delegation 开启才 `workspace-write`；不用 `--dangerously-skip-permissions`。

### M5 提示词与上下文

- **职责**：`composeStart` 顺序固定、后者覆盖前者：
  `WORKFLOW_PRELOADED`（静态，无时间无联系人名，保护 prompt-cache 前缀）→ temporal block → room block（仅 room）→ memory preamble（full / compact / off）
  → replay block（CLI fresh spawn 历史桥接，硬预算 4096 token）→ overlay。每轮追加（不进静态前缀）：关键词检索片段、`nsfwCraft=intimate` 工艺块（fail-open，I-8）、
  跨联系人生活事件、`TURN_TIME_PRELOADED`、会议室 `<ROOM_TURN_GATEWAY>` 本轮窗口清单。滚动摘要按高低水位批量滚动；工具输出按证据保护做选择性压缩。
- **数据**：`conversation_summaries`（0006）。
- **代码**：`server/src/prompt/`（`promptComposer.ts`、`conversationSummary.ts`、`conversationSummaryRepo.ts`、`conversationReplay.ts`、`selectiveCompress.ts`、
  `historyPolicy.ts`、`tokenEstimate.ts`、`gemHeartbeatHistory.ts`）；脱敏在 `platform/redactSecrets.ts`。
- **依赖**：M1、M2、M6、M8、M11（委派指引文本）、M14（`companion/` 的生活事件块）。
- **不变量**：I-4、I-6、I-8。分层与「改什么动哪层」见 [prompt-layers.md](prompt-layers.md)。

### M6 记忆

- **职责**：**读路径**（`inject.ts`）网关决定模型看见什么：会话 preamble 默认 `get_core_context(source=compact)`（只常驻 pinned/high facts），
  显式 `full` 才走 `get_context`；每条用户消息做一次轻量 `search_vault`，会话内去重；当日流水注入（`sameDayDiary.ts`）。
  **写路径**（`capture.ts`）每轮跑廉价触发词，命中就把 User 原话（只看她新写的部分，剥 `> ` 引用行）投到 vault `inbox/` 打 `hub-auto`；
  可选 DeepSeek flash 复审，超时/异常不阻断。对外写先落 outbox 再重试。
- **数据**：`memory_outbox`（0002/0017）。
- **代码**：`server/src/memory/`（`vaultClient.ts`、`inject.ts`、`capture.ts`、`sameDayDiary.ts`）。
- **依赖**：无。
- **不变量**：I-7。Vault 存储与注入的整体设计在 vault `_meta/architecture.md`。

### M7 Vault 任务状态

- **职责**：Vault `tasks/` 状态的单写者命令事务：`TaskStateService.applyCommand` 把状态变更、注记、改期共用一个事务——幂等检查 → 版本校验 → 更新 →
  不可变事件 + task_outbox；投影失败整条回滚。`VaultTaskProjection` 把 outbox 投递到 vault；聊天轮次结束后的任务回写（`taskWriteback.ts`）也经它。
- **入口**：`/api/vault/task-status`（`tasks/vaultTaskRoutes.ts`，验收卡「置 done」）。
- **数据**：`task_commands`、`task_events`、`task_outbox`、`work_items`（0026）、`task_writebacks`（0018/0027）。
- **代码**：`server/src/tasks/`（`taskStateService.ts`、`invariants.ts`、`vaultProjection.ts`、`taskWriteback.ts`、`vaultTaskRoutes.ts`）。
- **依赖**：M6（Vault 客户端）。

### M8 会议室

- **职责**：房间是 `kind=room` 的联系人，成员是其他联系人；`@名字` / `@all` 点名（`roomTargets.ts`），每成员独立会话；
  群提示词块与本轮窗口（`roomPrompt.ts`）：成员看到 `<ROOM_TURN_GATEWAY> current_window {message_ids, from, through, count}`，**历史行标签恒为「历史消息」**（I-6）；
  共享群摘要只在 CLI fresh spawn 的 bridge 与 API 成员 history 两处写入。轮次调度在 M3（`runtime/manager.ts`）；历史 `room-host` 协调行在 M9（`workflow/coordinationRoom.ts`）。
- **代码**：`server/src/rooms/`（`roomPrompt.ts`、`roomTargets.ts`）。
- **依赖**：M6。

### M9 工作流模块

- **职责**：七个固定模块（规划、执行、评审、技术仲裁、合并、部署、维护）各自绑定 agent/model/reasoning（带 revision）；修改只影响新调用，已派任务保留调用快照；
  权限 = 模块策略 ∩ 任务授权 ∩ 宿主能力；模块轮次的委派范围与签名 invocation bearer（`moduleAuthority.ts`）；额度池（`workflowPools.ts`，未知额度不当耗尽）；
  job 手动接管 fencing；质量计数只观察不驱动流转；工作流房补齐预备成员（`roomReserves.ts`）；历史 `room-host` 协调行只读保留并在启动时审计
  `coordination.orchestrator`（`coordinationRoom.ts`）。`workflowProfiles` 是退役前的固定图配置（[workflow-profiles.md](workflow-profiles.md)、
  [workflow-modules-plan.md](workflow-modules-plan.md) 均为历史），仍承担 runner 档位与审计读写。
- **入口**：HTTP 视图、修订号校验的单模块修改与 job 接管由 M11 的 `jobs/workflowModuleRoutes.ts` 提供（视图要连 job 表）；SSE `workflow-modules`、`workflow-profile`。
- **数据**：`workflow_module_*`（0034 + 运行时 `ensureSchema`）、`workflow_profile_*`（0025）、`workflow_quality_*`。
- **代码**：`server/src/workflow/`（`workflowModules.ts`、`workflowProfiles.ts`、`workflowPools.ts`、`workflowStanding.ts`、`moduleAuthority.ts`、`roomReserves.ts`、`coordinationRoom.ts`）。
- **依赖**：M1、M6、M8。额度池读 M17 的快照经端口 `WorkflowQuotaSources`（§4.3）。

### M10 会议室任务账本

- **职责**：模型显式调用网关接口交接工作，网关只校验、不代选阶段与联系人（完整协议见 [model-driven-room-workflow.md](model-driven-room-workflow.md)）。
  两种治理：strict 房 `task_handoff/task_accept/execution_start/review_submit/release_execute/task_retry`（待观察一周后删除）；
  open 房（房间 config `governance: open`）只走 `task_pass/task_block/task_done` + 自动兜底与每任务每日唤醒预算（默认 40）。
  共同硬闸：自上次独立评审结论起 execute 已满 3 轮（`EXECUTE_ROUNDS_BEFORE_REVIEW`）不得再交回 execute。
  直启链：`auto_start` 直接建 execute job、评审 REQUEST_CHANGES 直启返修、APPROVE 直启合入、合入成功自动收口/直启部署、merge-stale 直启 rebase、W 序列下一块直启。
  发布去重按自然键 `release:v1:<task>:<kind>:<sha>`。建账默认 VPS 围栏工作区与缺省 baseline（部署回执 → `git ls-remote origin master`），
  `needs_pc`（camera/taobao/ssh/win32）才走 PC。派单前对照执行端能力卡，任一不满足记 `capability-reject` 且不改绑定。
  User 可在工作流面板保存全流程默认 Worker/工作区（`settings.workflow.worker-target`）：网关创建新账本时以此覆盖模型传入的工作区，VPS 映射按 task slug 生成任务目录；User 表单可显式改选。已有任务的 `approved_workspace` 不随默认值变化。
  origin-turn nonce（`turnAttribution.ts`）把每次工具调用绑到发起轮次；轮末交接义务检查 + 一次有界补办（`handoffObligation.ts`）。
  评审补丁的敏感路径清单（`REVIEW_PATCH_SENSITIVE`）有测试守住：清单里的文件搬家而清单没跟上会红。
- **入口**：`/api/room-tasks/:roomId`（User 会话建账，D3）、`/api/room-tasks/:roomId/:taskFile`、`/api/project-targets`（`roomTasks/roomTaskRoutes.ts`）；
  网关工具 `task_create/task_import/task_get/task_submit_evidence/task_handoff/task_accept/task_decline/task_pass/task_block/task_done/execution_start/execution_get/review_submit/release_execute/task_retry`；
  SSE `room-task`；job 完成回调（`handleJobFinished`，组合根装配到 `jobStore.onFinished`）。
- **数据**：`room_tasks` 与 `room_task_{handoffs,events,evidence,links,dispatches}`（0035）、`room_task_completion_handoffs`（0036）、
  `baseline_sha`（0037）、open 治理字段（0038）、`baseline_source`/`needs_pc`（0039）、`sequence_json`/`sequence_index`（0040）；
  `room_task_{callbacks,waits,remedies,turns,turn_calls}` 只由运行时 `ensureSchema` 建。
- **代码**：`server/src/roomTasks/`（`roomTaskStore.ts` 6.4k 行，含 schema、治理、交接、执行、评审、发布、回调、序列、成本；`handoffObligation.ts`、
  `roomTaskTools.ts`、`turnAttribution.ts`、`baselineDefaults.ts`、`roomTaskRoutes.ts`）。
- **依赖**：M9、M11。唤醒成员经端口 `RoomTaskDispatcher`，实现在 `runtime/roomTaskDispatch.ts`（§4.3）。
- **不变量**：I-1；派单/验收只认网关写入的可信 meta；`executor != verifier`。

### M11 Worker 派工

- **职责**：job `status` ∈ pending/claimed/running/recovering/pause_requested/paused/cancel_requested/cancelled/blocked/done/failed；
  `delivery_state` 是给人看的交付态（in_progress → completed_not_delivered → waiting_review → delivered_waiting_deploy → online_waiting_validation → closed_loop，
  另有 user_decision / rework_required / failure_or_blocked）。每个 job 存不可变 `options.workflow` 快照（0025）。执行端**只出站**：`/worker/connect` 注册 →
  `/worker/claim?wait=` 长轮询 → `/start` `/events` `/heartbeat` `/complete` `/recover`，同一长轮询也领取 M13 的设备请求。权限位 `permissions`（write/shell/ssh）
  由联系人 `delegation` 与 job 选项共同决定，**`ssh: true` 不注入任何凭据**。终态回执先落 `job_outbox` 再投递（抛错即重试，finalAttempt 转 dead）。
  项目目标围栏（`projectTargets.ts`：`server/config.json projectTargets` 映射冻结派单目标，`<root>/<task>/<attempt>/<repo>`）；能力卡（执行端心跳上报
  runners/workspaceWritable/npmCacheWritable/configVisible + releaseSha）；合入/部署收口命令（`closureAutomation.ts`）与部署回执轮询（`deployReceipt.ts`）。
  给 DM 联系人的委派工具 `delegate_to_worker`、`worker_job_status/update_delivery/cancel`（`delegateTools.ts`；同室任务参与者的读权限经端口 `DelegateTaskLedger`）。
  工作流模块的 HTTP 视图与接管（`workflowModuleRoutes.ts`）。派单指纹与 v1/v2 key 只在 `shared/coordination-keys` 定义，网关与 triage 共用。
- **入口**：`/api`（`jobs/workerRoutes.ts`：`/workers`、`/jobs`（含 `action` / `quality`（仅观察计数）/ `resolve-out-of-band` / `delivery`）、`/workflow-profiles/*`、
  `/worker/*`、`/worker/snap/:id`、`/worker/taobao/:id`；`jobs/workflowModuleRoutes.ts`：`/workflow-modules*`）；SSE `worker`、`job`、`job-message`。
- **数据**：`workers`、`jobs`、`job_messages`、`job_outbox`（0022）。
- **代码**：`server/src/jobs/`（`jobStore.ts`、`deliveryStatus.ts`、`deliveryChecks.ts`、`receiptFields.ts`、`receiptPreview.ts`、`capabilityCard.ts`、`projectTargets.ts`、
  `closureAutomation.ts`、`coordinationKeys.ts`、`coordinationReceipt.ts`、`deployReceipt.ts`、`delegateTools.ts`、`workerRoutes.ts`、`workflowModuleRoutes.ts`）；
  收口客户端鉴权在 `platform/middleware/closureAuth.ts`。
- **依赖**：M1、M9（JobStore 内含工作流模块与档位存储）、M13（领取设备请求）。
- **不变量**：I-1（同一 `taskPath` 的 coordination job 永不并行）、I-2。

### M12 网关工具

- **职责**：工具输入唯一声明在各工具的 `inputSchema`（zod）；`platform/gatewayTool.ts` 从它生成 API JSON Schema 并统一验证，Hub MCP 直接复用同一对象；
  未知字段与违约参数两种入口都先拒绝后执行。工具定义留在各自模块（委派工具 M11、任务工具 M10、摄像头/淘宝 M13）。
  `/api/hub-mcp/:contactId` 是给 CLI 联系人的 Streamable HTTP MCP（OpenCode 走 legacy SSE），身份 = URL contactId + per-contact HMAC bearer，
  模块轮次改用签名 invocation bearer 并校验 origin-turn 仍在进行。claude 以 `--allowedTools mcp__hub__*` 接入，grok 以 `[mcp_servers.hub]`（header 写展开后的真实 bearer）。
- **代码**：端点 `server/src/tools/hubMcpRoutes.ts`；契约 `platform/gatewayTool.ts`、bearer `platform/middleware/hubMcpAuth.ts`；API 直连后端的同一批工具在
  `runtime/backendFactory.ts` 另行组装（§4.6）。
- **依赖**：M1、M9、M10、M11、M13。
- **不变量**：I-14。

### M13 设备桥

- **职责**：摄像头——`CameraSnapBroker` 把请求停放在内存，执行端领取后抓帧回传，`camera_snap` 以 image content block 返回，不落盘；
  淘宝——`TaobaoBridge` 同样停放，执行端转给 PC 本地淘宝 MCP，工具子集按联系人 `taobao.mode` 裁剪。两者都只在心跳开启时提供（经端口 `HeartbeatActivity`）；
  没人领即超时失败，不落库。
- **代码**：`server/src/devices/`（`cameraSnap.ts`、`cameraTool.ts`、`taobaoBridge.ts`、`taobaoTools.ts`、`heartbeatActivity.ts`）；执行端侧 `worker/runner/camera.mjs`、`worker/runner/taobao.mjs`。
- **依赖**：M1。

### M14 陪伴

- **职责**：**生活事件**（`companion/lifeEvents.ts`）
  从 User 自述抽取高时效状态（正则闸 → DeepSeek 结构化），供其他联系人每轮注入；亲密内容与他人隐私一律排除。**心跳回执策略**（`companion/heartbeatPolicy.ts`）：
  写类工具后不能用静默令牌掩盖。**心跳**（`heartbeat/companionHeartbeat.ts`，`heartbeat_sessions`）每跳 4–7 分钟随机，模型自己决定说不说话，
  静默令牌 `HEARTBEAT_OK` 只是出口不是默认（I-12）；每跳执行/用量审计进 `heartbeat_runs`。
  拆两个目录是因为依赖方向相反：`companion/` 是运行时组装每轮上下文时要读的状态（在 M3 之下），`heartbeat/` 驱动运行时跑心跳轮（在 M3 之上）。
- **入口**：`/api/contacts/:id/heartbeat`（`heartbeat/heartbeatRoutes.ts`）；`/api/system/life-events`（组合根内联）；SSE `heartbeat`。
- **数据**：`heartbeat_sessions`（0028–0030、0032）、`heartbeat_runs`（0033）、`life_events`、`life_event_usage`（0024）。历史 `contact_affect`（0021）不再读写。
- **代码**：`server/src/companion/`（`lifeEvents.ts`、`heartbeatPolicy.ts`）；`server/src/heartbeat/`（`companionHeartbeat.ts`、`heartbeatRoutes.ts`）。
- **依赖**：`companion/` → M1、M2、M6；`heartbeat/` → M1、M2、M3、M13、`companion/`。

### M15 微信通道

- **职责**：自实现 iLink bot HTTP 协议，网关主动长轮询，无入站；显式 `Claude/Codex/阿野` 前缀路由，30 分钟 sticky；`WECHAT_ALLOW_FROM` 之外直接丢弃；
  游标与 sticky 状态在 `/var/lib/ai-hub/wechat-channel-state.json`。详见 [wechat-channel.md](wechat-channel.md)。
- **代码**：`server/src/wechat/`。**依赖**：M2、M3。

### M17 订阅额度

- **职责**：轮询 Claude / Codex（经 app-server 协议）/ Grok 订阅额度，给 UI 与 M9 额度池。
- **入口**：`/api/quota/{claude,codex,grok}`（组合根内联）。**代码**：`server/src/quota/`。**依赖**：M4（Codex 额度复用 app-server 客户端）。

### M18 运维

- **职责**：SQLite 在线快照（`/var/backups/ai-hub/db`，保留 14）；软删消息与隐藏终态 job 的定期物理清理；一键部署与状态（`DEPLOY_TOKEN`，非 root 网关只写 request 文件，
  root path unit 跑固定脚本；部署前等房间轮次 drain，经端口 `DeployDrainManager`）；两仓发布状态；Android OTA 清单与 `/releases` 静态目录。
- **入口**：`ops/systemRoutes.ts`（`/system/publish-status`、`/system/deploy`、`/system/deploy/status`、`/system/hardening*`）；`ops/appReleaseRoutes.ts`（`/api/app/latest`）；
  组合根内联 `/api/health`（消息数、历史协调健康、job outbox 计数、微信状态）、`/api/session`、`/api/system/{backup,purge}`。
- **代码**：`server/src/ops/`（`backup.ts`、`purge.ts`、`publishStatus.ts`、`systemRoutes.ts`、`appReleaseRoutes.ts`）。**依赖**：M2（清理附件）。

### W1 triage worker（入口 `worker/triage-worker.mjs`，内部 `worker/triage/`）

- 独立 systemd 进程（DynamicUser，状态在 `/var/lib/private/ai-hub-triage/triage.db`），配置 `/etc/ai-hub/triage.json` + `triage.env`。
  **它和网关只通过 HTTP 说话**（`hub.baseUrl`，token 来自 env）。
- 事件源 `sources[]`：定时器（quarter-hour-check、daily-check-in、daily-idea-room、diary-rollup 等）、Vault backlog 摘要变化、项目 watch、webhook（127.0.0.1:3911）。
  事件进 `triage_events`，DeepSeek flash/pro 分类，按 `routing.rules` 派给联系人或 NO_OP；熔断 `breakers.dailyEvents / dailyCostCny`。
- 领域模块（`worker/triage/domains/*.mjs`，混入 `TriageWorker.prototype`）：reminders（确定性截止日期扫描）、
  coordination（已退役：不再产生新派单，仅 hub-auto hygiene 摘要保留，遗留载荷按 noop 排空）、agenda（每日议程）、routeTriage（`route-triage.mjs`，路由审核；
  否决窗口保留，自动派单段已移除）、diary（`idea-diary.mjs`，日记 rollup）、outcomes（回填 engaged/accepted/…）、backlog（待拆分需求日扫）。
  主动陪伴、idea 房、临时离开 followup 已删除；队列里的旧事件直接 noop。
  管线与共享件在 `worker/triage/`：`pipeline.mjs`、`domain-shared.mjs`、`triage-core/store/clients/migrations/shared.mjs`、`agenda-core.mjs`、`route-triage-core.mjs`、
  `diary-*.mjs`；手动 CLI `worker/diary-backfill.mjs`。
- `prompt-hygiene.test.mjs` 守派单措辞；手动跑任何一次性命令先 source `triage.env`（I-11）。
- 退役方向（未实施）：vault `inbox/2026-09-12_req-ai-hub-retire-triage-into-heartbeat`。

### W2 执行端（入口 `worker/worker.mjs`，内部 `worker/runner/`；pc-User 与 vps-dev 同一份代码）

- PC 由 `worker-launcher.ps1` 托管，运行 `releaseRef`（默认 master）导出的按 commit 发布副本（`git archive worker shared deploy`）；VPS 由 `ai-dev-worker.service`
  （`ProtectHome=read-only`、三个 CLI 状态目录写白名单、`KillMode=mixed`）运行 `deploy/install-vps-worker.sh` 装的发布副本，部署成功后 `update.sh` 自动跟进
  （忙则登记 pending，`ai-dev-worker-release.timer` 每 5 分钟重试）。
- **根目录的路径契约**：`worker.mjs` 必须在发布根下一层（收口脚本解析与 releaseSha 都以它的上级目录为发布根）；`state-store.mjs` 同时被 launcher 从检出直接运行；
  `worker/package.json`、launcher、unit、配置样例都不动。
- `worker/runner/`：`runner.mjs`（claude/codex/grok/opencode 子进程与进程组 kill）、`delivery.mjs`（回执与 patch 采集）、`stall.mjs`（停滞恢复）、`provision.mjs`
  （按 `config.repos` 可信映射 clone → checkout `options.patchBase` → 建分支 `task/<taskSlug>`，按需装依赖）、`workspace-path.mjs`（平台路径分类与 realpath 围栏）、
  `closure-runner.mjs`（从自身发布目录 `<release>/deploy/` 解析收口脚本）、`capability-card.mjs`、`auto-commit.mjs`（声明测试全过的执行轮自动提交）、
  `camera.mjs`、`taobao.mjs`、`instance-lock.mjs`、`worker-release.mjs`。两个进程唯一共用的是 `worker/lib/hub-time.mjs`。
- **PC 残留清单**（会议室任务默认走 vps-dev，只有这些必须 PC）：摄像头 `camera`（物理设备 + Windows 采集链，长期留 PC）；淘宝 MCP `taobao`
  （本地 MCP + 登录态绑 PC，长期留 PC）；局域网 ssh（VPS 映射一律 `ssh: false`，`enforceDispatchTarget` 拒 `ssh=true` 进 VPS 围栏；目标即 VPS 本机时不需要）；
  Windows 桌面 App 构建 `win32`（长期留 PC）；未进 `projectTargets` 的仓（`editable-camera-style-recipe`、`pet-daily`，纳入映射并配好 mirror/manifest 后可迁）。
  未声明任何 `needs_*` 的任务即使 execute 绑定指向离线 pc-User，也只记 `execute-pc-offline-fallback` 提示事件，绑定与工作区不动。

### C 客户端

- `web/`：React + Vite 移动优先 IM 界面，网关直接 serve `web/dist`。上行 REST，下行单条全局 SSE；断线后 `GET /messages?after=lastId` 补齐，
  终态以服务端整行为准（I-5）。Worker/Job 由 `web/src/jobs/workerState.ts` 维护唯一可订阅状态，只保留 App 内每 60 秒可见页兜底。功能目录见 §4.5。
- `mobile/`：Capacitor Android 壳，Web 改动走 OTA 热更，只有原生改动才发 APK（I-15）。`desktop/`：Electron 壳，打包 `server/dist`、`web/dist`、
  `server/migrations` 与 `shared/coordination-keys`（extraResources，依赖 `server-dist/<module>/` 的相对深度，I-2）。

## 4. 模块边界与依赖规则

### 4.1 规则

1. **一个功能模块一个目录**：网关是 `server/src/<module>/`，Web 是 `web/src/<feature>/`，两个 worker 进程是 `worker/triage/` 与 `worker/runner/`。
2. **跨模块只走公开面**：网关每个模块的 `index.ts` 只转出别的模块真正在用的符号；其他模块只能 `import '../<module>/index.js'`，不能伸进对方的内部文件。
   模块内部文件互相直接 import，不经自己的 `index.ts`。
3. **依赖单向、无环**：谁能依赖谁由 §4.2 的表决定；表本身必须无环。平台内核（`platform/`）人人可用，自己不依赖任何模块。
4. **反向需求走端口**：下层模块需要上层的能力时，在下层定义一个最小的结构化接口（TypeScript structural type），由组合根把上层实例传进来；
   不为此引入容器或事件总线（§4.3）。
5. **只有组合根装配**：`server/src/index.ts`（进程：构造、接线、启动与停止）与 `server/src/server.ts`（HTTP：挂路由与内联端点）可以 import 任何模块的公开面；
   任何模块都不能 import 组合根。Web 的组合根是 `web/src/App.tsx` 与 `main.tsx`。
6. **测试强制**：`server/test/moduleBoundaries.test.mts`、`web/test/moduleBoundaries.test.mjs`、`worker/layout.test.mjs` 在 `npm test` 里跑；
   违规（深 import、表外依赖、成环、import 组合根、未登记的新目录）直接红。新增依赖先确认不成环，再同时改测试里的表与本节。

### 4.2 网关依赖表（`server/test/moduleBoundaries.test.mts` 的 `ALLOWED`）

自下而上分层；每行只列直接依赖，`platform` 省略。

| 层 | 模块 | 可依赖 |
|---|---|---|
| 0 | `platform` | — |
| 1 | `messages`、`memory` | — |
| 2 | `contacts` | `messages` |
| 2 | `rooms`、`tasks` | `memory` |
| 2 | `ops` | `messages` |
| 3 | `companion` | `contacts`、`memory`、`messages` |
| 3 | `workflow` | `contacts`、`memory`、`rooms` |
| 3 | `devices` | `contacts` |
| 4 | `jobs` | `contacts`、`devices`、`workflow` |
| 5 | `roomTasks` | `jobs`、`workflow` |
| 5 | `prompt` | `companion`、`contacts`、`jobs`、`memory`、`messages`、`rooms` |
| 6 | `backends` | `contacts`、`memory`、`messages`、`prompt`、`rooms` |
| 6 | `tools` | `contacts`、`devices`、`jobs`、`roomTasks`、`workflow` |
| 7 | `quota` | `backends` |
| 7 | `runtime` | `backends`、`companion`、`contacts`、`devices`、`jobs`、`memory`、`messages`、`prompt`、`roomTasks`、`rooms`、`tasks`、`workflow` |
| 8 | `heartbeat` | `companion`、`contacts`、`devices`、`messages`、`runtime` |
| 8 | `wechat` | `messages`、`runtime` |
| 9 | 组合根 | 全部 |

各模块的公开面就是它的 `index.ts`：想知道「runtime 对外提供什么」，读 `server/src/runtime/index.ts`，不用翻内部文件。

### 4.3 端口（下层定义、上层满足、组合根接线）

| 端口 | 定义在 | 谁满足 | 用途 |
|---|---|---|---|
| `ContactRuntime` | `contacts/contactRoutes.ts` | `AgentManager` | 联系人 API 改配置/删除后通知运行时、读运行态 |
| `HeartbeatActivity` | `devices/heartbeatActivity.ts` | `CompanionHeartbeat` | 摄像头/淘宝工具、运行时、Hub MCP 只问「这个联系人的心跳在不在跑」 |
| `DelegateTaskLedger` | `jobs/delegateTools.ts` | `RoomTaskStore` | 委派工具判断同室任务参与者能否读 job；不传即只有派单人能读 |
| `RoomTaskDispatcher` | `roomTasks/roomTaskStore.ts` | `runtime/roomTaskDispatch.ts` | 账本投递交接/回调事实并唤醒被点名的成员 |
| `WorkflowQuotaSources` | `workflow/workflowPools.ts` | 三个额度 poller 的快照 | 额度池判定 runner 凭据是否可用 |
| `DeployDrainManager` | `ops/systemRoutes.ts` | `AgentManager` | 部署前等会议室轮次 drain |

组合根只构造一次共享件：`index.ts` 建一个房间任务派发器与 store 选项（`roomTaskPlumbing`），同一实例交给运行时与 HTTP 层。

### 4.4 worker 目录规则（`worker/layout.test.mjs`）

`worker/triage/` 与 `worker/runner/` 互不 import；两边共用的只有 `worker/lib/`，`lib/` 不认识任何一边；入口文件留在 `worker/` 根目录
（`triage-worker.mjs`、`diary-backfill.mjs`、`worker.mjs`、`state-store.mjs`），内部代码不能反过来 import 入口。

### 4.5 Web 功能目录（`web/test/moduleBoundaries.test.mjs`）

| 目录 | 内容 | 可依赖（`platform` 省略） |
|---|---|---|
| `web/src/platform/` | API 客户端与 SSE、原生壳桥、发送幂等、时间、动效 presence、图标、确认框 | — |
| `web/src/ops/` | OTA 更新器、发布状态面板 | — |
| `web/src/app/` | 登录与原生壳闸门 | `ops` |
| `web/src/settings/` | 资料、主题、动效与声音 | `ops` |
| `web/src/jobs/` | Worker 面板、job 线程、Worker 状态库 | — |
| `web/src/workflow/` | 工作流模块看板与绑定规则 | `jobs` |
| `web/src/roomTasks/` | 任务面板、建账表单、交接义务提示 | — |
| `web/src/contacts/` | 联系人列表、配置表单、模型选择器 | `workflow` |
| `web/src/chat/` | 聊天面板、消息列表/气泡、输入框、运行时抽屉、消息合并与来源、未读、Worker 回执动作 | `contacts`、`jobs`、`roomTasks`、`settings`、`workflow` |

`web/src/App.tsx` 把 Worker 面板与工作流看板拼在一起（`WorkerPanel` 的 `modulesPanel` 属性），所以 `jobs` 不依赖 `workflow`。
Web 不用 `index.ts` 公开面：Node 直接跑的测试要按 `.ts` 路径加载纯模块，经 index 会连带拉进 React 组件。`web/src/styles/` 是全局 CSS，
入口 `styles.css` 固定顺序 `@import`，不参与功能分目录。

### 4.6 已知遗留（没在这轮收掉，按价值排）

- **运行时是编排中心**：`runtime/` 依赖 12 个模块，会议室模块轮次的交接义务、补办、自动传棒仍写在 `runtime.ts`/`manager.ts` 里。下一刀是把这些收成
  M10 提供的「轮次钩子」端口，运行时只在轮次开始/结束时调用。
- **工具组装两处**：API 直连后端在 `runtime/backendFactory.ts` 组装委派/任务/摄像头/淘宝工具，CLI 后端经 `tools/hubMcpRoutes.ts` 再组装一遍；
  工具定义已单一（各模块的 `inputSchema`），组装清单还没有。
- **大文件**：`roomTasks/roomTaskStore.ts` 6.4k 行（单个类）、`runtime/runtime.ts` 1.8k、`runtime/manager.ts` 1.3k（`smoke-manager-architecture`
  的 1300 行棘轮随 `npm test` 跑，超了先拆文件）、`worker/worker.mjs` 2.0k、`worker/triage/triage-core.mjs` 1.6k。
- **两套 schema 机制**：migration 0001–0040 之外，M9/M10 在运行时 `ensureSchema` 补建表与列（测试库与旧库都靠它）。
- **行类型集中在 `platform/db.ts`**（ContactRow、MessageRow、JobRow…），各模块共用这份类型定义。
- **退役候选，等 User 决定**：历史 room-host 协调（`workflow/coordinationRoom.ts`、`jobs/coordinationReceipt.ts`、`runtime/messageRoutes.ts` 的 room-host 例外路径）、
  strict 治理（文档写着「待观察一周后删除」）、`workflowProfiles`（历史固定图，仍被 runner 档位读写）、triage 的 coordination 领域。
- **公开 seed 模板漂移**：`deploy/public-seed.ts` 的导出与网关 import 早已对不上，公开发布会编译失败。

## 5. 数据与事件

- **SQLite**：`server/migrations` 0001–0040，启动时由 `platform/migrations.ts` 顺序应用，只增不改；各表归属见 §3 各模块「数据」。新表若被非 root 的另一个服务读取，先看 I-2。
  SQLite `datetime('now')` 是 UTC naive，一律经 `parseHubTimestampMs` 解析（I-18）。
- **SSE**：单条全局 `GET /api/events`（`platform/sse.ts`），事件 `message`（完整落库行）、`delta`、`status`（idle/thinking/streaming/tool:x/error）、`contact`、`read-state`、
  `prune`、`user`、`worker`、`workflow-profile`、`workflow-modules`、`job`、`job-message`、`heartbeat`、`room-task`。HTTP 返回不得覆盖请求期间的新 SSE 终态或删除事件。
- **outbox**：`memory_outbox`（vault 写）、`job_outbox`（job 回执）、`task_outbox`（vault 任务投影）——对外写入先落库再重试，网关重启不丢。

## 6. 安全边界

| 边界 | 机制 | 代码/配置 |
|---|---|---|
| 网络 | 网关与 vault 内网实例只绑 tailnet IP + 回环；公网仅 Funnel → 127.0.0.1:8901 秘密路径 | `server/config.json`、`tailscale funnel` |
| 登录 | 密码 → 30 天签名 session cookie；5 次/5 分钟单 IP 限速；Android 壳存签名 session 不存 HUB_TOKEN | `platform/middleware/auth.ts` |
| 后台/内部 | triage 与执行端用原始 `HUB_TOKEN` Bearer | `/etc/ai-hub/triage.env`、`worker/config.json` |
| 网关工具 | per-contact bearer = HMAC-SHA256(HUB_TOKEN, `hub-mcp-v1\0<contactId>`)，模式 enforce/warn/disabled；模块轮次用签名 invocation bearer；轮换 = 换 HUB_TOKEN（`deploy/rotate-hub-token.*`） | `platform/middleware/hubMcpAuth.ts`、`workflow/moduleAuthority.ts` |
| 部署 | 独立 `DEPLOY_TOKEN`；非 root 网关只能写 request 文件，root path unit 跑固定脚本 | `ops/systemRoutes.ts`、`deploy/ai-hub-update.*` |
| 收口客户端 | closure bearer = HMAC-SHA256(HUB_TOKEN, `closure-v1 <clientId>`)，**GET only** 且只开 `/api/room-tasks/:room/:task`、`/api/contacts`、`/api/contacts/:id/messages` 三条只读端点（允许清单非前缀）；装在 `/etc/ai-dev-worker/deploy.env`（`deploy/install-closure-env.sh`） | `platform/middleware/closureAuth.ts` |
| 建账写入口 | `POST /api/room-tasks/:roomId` 只接受已签发的 User 登录会话；原始 hub token / worker token 不授予 | `roomTasks/roomTaskRoutes.ts` |
| 评审补丁 | 触碰敏感路径（部署脚本、鉴权中间件、工作流模块、收口命令、任务账本、执行端供给与收口）的评审补丁一律拒绝机械应用 | `roomTasks/roomTaskStore.ts`（`REVIEW_PATCH_SENSITIVE`） |
| Vault | `VAULT_TOKEN` 共享密钥；生成的 MCP 配置必须写**展开后**的真实值（HTTP header 不展开 `${}`） | `memory/vaultClient.ts`、`setup.md` |
| CLI 子进程 | 见 M4 | `runtime/backendFactory.ts`、`backends/claudeCli.ts`、`backends/codexAppServer.ts` |
| 进程 | 专用用户 `ai-hub` / `memory-vault`，`ProtectSystem=strict` + `ReadWritePaths` 白名单，`UMask=0077`；运行时生成物一律在 `server/data/`，检出只读 | `deploy/*.service` |
| 秘密 | 只在 `/opt/ai-hub/.env`（600）与 `/etc/ai-hub/triage.env`；不进 git、DB、日志、聊天；用户可见错误经 `platform/redactSecrets.ts` 脱敏 | I-14 |
| 输入信任 | 消息正文不是控制字段；派单/验收只认网关写入的可信 meta；引用块不触发记忆捕捉 | M2、M10 |

## 7. 部署与运维

- 一键部署：push master → `deploy/trigger.ps1`（或会议室收口的 `deploy/room-deploy-job.*`）→ `POST /api/system/deploy` → root `update.sh`：拒绝脏工作区 → `git pull --ff-only`
  → `npm ci` × 2 → build → 发布 OTA zip → `chmod -R a+rX server/agents server/migrations worker shared/coordination-keys` → restart → 30 秒 health → 失败自动回滚到上一 commit
  → 成功后写部署回执并跟进 vps-dev 发布（`install-vps-worker.sh <sha>`，永不 `--force`）。修改 `update.sh` 自身的那次部署跑的是旧脚本，要连触发两次（I-3）。
- 构建产物布局跟着源码目录走：`server/dist/<module>/…`；`platform/config.ts` 与 `platform/migrations.ts` 按「自身在 `dist/platform/` 下」回推服务根与 migration 目录，
  Electron（`server-dist/platform/`）与 Docker 布局同样成立。
- 部署重启会掐死在途会议室轮次，错误气泡时间戳落在 `deploy ok` 同一分钟内即部署撞车，不是通道故障。
- 备份：网关内置每日 SQLite 在线快照；PC 每日拉 offsite 恢复包（db + 被引用附件 + manifest，SHA-256 校验）。恢复必须停服务后整体替换 db 与 uploads。
- Android：Web 改动只需正常部署，App 内 OTA 热更；原生改动才升 `mobile/package.json` 版本并发 APK。发布收尾同时核对 workflow head 与 `/api/app/latest` 的 webVersion（I-15）。
- PC 侧脚本默认地址与 ssh 别名 `User-vps` 指向当前生产机；大文件走搬瓦工跳板（`ProxyJump User-relay` → wg 地址），tailnet 直连只跑小命令。
- 部署后核对「网关 SHA == vps-dev releaseSha」（`/api/workers` capabilities 透出 `releaseSha` / `pendingReleaseSha`）。

## 8. 不变量与扩展清单

### 8.1 不变量（从 pitfalls 蒸馏，违反过才写进来；出处 vault `memories/pitfalls-ai-hub.md`）

- **I-1 每联系人串行**：同一联系人同一时刻只有一轮 in-flight；会议室同一 `taskPath` 的 coordination job 永不并行。守门：`coordinationJobMutex.test.mts`。
- **I-2 跨用户读文件先用消费方身份读一次**：`UMask=0077` 的服务写出的文件（vault tasks、git 对象、migration、worker/**/*.mjs、overlay.md）非 root 读不到，症状伪装成 EACCES / `loose object corrupt` / 静默空串。`update.sh` 的 chmod 白名单必须覆盖 `server/agents`、`server/migrations`、`worker`、`shared/coordination-keys`。Electron 通过 extraResources 分发同一共享源码到 resources/shared/coordination-keys；移动编译产物布局时必须同时核对相对导入。守门：`deployPermissions.test.mts`。把「经服务读」改成「直接读文件」的改动，Plan 里必须写部署前置权限。
- **I-3 部署脚本自更新延迟一轮**：改 `update.sh` 要触发两次部署。
- **I-4 preamble 只注一次的假设只对持久会话成立**：grok/API 每轮重传；WORKFLOW_PRELOADED 之类必须靠网关标记而不是「新会话」判断。守门：`smoke-token-round2-gates`。
- **I-5 流终态以服务端整行为权威**：done/error/interrupted 不得被本地 delta 拼接稿覆盖；只有仍在 streaming 的较短快照才保留本地更长内容。守门：`web/test/messageMerge.test.mjs`。
- **I-6 保护 prompt-cache 前缀**：每轮必变的内容（时间、本轮窗口、滚动摘要）不进 system/历史区；摘要按高低水位批量滚动；群聊历史标签恒为「历史消息」。压 token 前先用 `message_usage` 量缓存账。守门：`smoke-prompt-cache-stability`。
- **I-7 记忆捕捉只看 User 原话**：拼装前锁定原始 user text；剥引用块；AI 发言与 transcript 永远排除；每 room/message 最多一次。守门：`capture.test.mts`。
- **I-8 亲密/工程混合分类器禁止单信号 skip**：漏报优先于省 token。守门：`smoke-token-round2-gates`。
- **I-9 `⚡ AI Hub 自主事件分派` 抬头是契约常量**：产地 `worker/triage-worker.mjs`，消费 `messages/messageSource.ts`、`messages/sideChannel.ts`、`messages/journalRoutes.ts`；改抬头必须四处同步并保留旧值兼容分支。
- **I-10 `file:` 共享包改源码必须升版**：否则 server/web 的安装副本静默继续跑旧代码，两份 lock 一起更新。
- **I-11 手动跑 triage 一次性命令先 source triage.env**：否则 HubClient 空 token 报 `missing or invalid session token`，像网关坏了。
- **I-12 自主发言协议不得把「说」框成打扰**：会收敛到 100% 静默；把授权写明（开启功能即发言许可），不加机械配额。
- **I-13 新增 CLI 后端的四处清单**：`web/src/chat/ChatPane.tsx` 的 `canSendImages`、backend 消费 `imagePaths`、`docs/image-recognition.md`、对应 smoke。
- **I-14 子进程 stderr 透传到用户可见面之前必须脱敏**：codex `-c` 的 map 值要 TOML inline table 而不是 JSON 字符串，否则报错会把 bearer 回显进聊天。守门：`hubMcpSecurity.test.mts`。
- **I-15 双轨发布核对两条版本线**：APK workflow head 与 `/api/app/latest` 的 webVersion/SHA 都指向目标才算发布完成。
- **I-16 生产人设以 `/api/contacts` 为准**：seed 只在联系人不存在时生效，DB 与仓库不一致是默认状态；要覆盖 DB 文案用 overlay。
- **I-17 状态接口区分「探测失败」与「探测到否」**：三态（active/inactive/unknown）+ 日志标记兜底，不把异常吞成 false。守门：`deployStatus.test.mts`。
- **I-18 时间戳先确认数据源时区**：SQLite `datetime('now')` 是 UTC naive，一律经 `parseHubTimestampMs` 解析；不改主机 TZ 也不改落库格式。
- **I-19 多会话共用检出**：只 `git add <确切路径>`，永不 `-A`/`-a`/`.`；开工先 `deploy/session-worktree.sh add`。

### 8.2 扩展清单（改这些位置时同步本文）

| 要做的事 | 必改位置 |
|---|---|
| 加一个功能模块 / 改模块依赖 | 新目录 `server/src/<module>/` + `index.ts` 公开面；`server/test/moduleBoundaries.test.mts` 的 `ALLOWED`（先确认不成环）；本文 §2、§3、§4.2；Web 同理（`web/test/moduleBoundaries.test.mjs`、§4.5） |
| 下层要用上层的能力 | 在下层定义结构化端口，组合根接线；本文 §4.3 |
| 加一种模型后端 | `backends/types.ts` backend 枚举、`runtime/backendFactory.ts` builder、`shared/contact-config`（升版）、`web` 的 `contacts/ContactConfig.tsx` 与 `chat/ChatPane.tsx` 的 `canSendImages`、`docs/image-recognition.md`、smoke；README 架构框图；本文 M4 |
| 加一个联系人 | DB（UI 或 seed）、`server/agents/<id>/{CLAUDE.md\|AGENTS.md, overlay.md}`（644）、如需网关工具则 hub-mcp bearer 注入路径；会议室成员默认表（vault fact `work.ai_hub.room.members`） |
| 加一条通道（类微信） | `server/src/<channel>/`（按新模块登记）、`.env` 变量、`/api/health` 观测字段、状态文件路径进 `ReadWritePaths`、`docs/<channel>.md`；本文 §1、§3、§6 |
| 加一个网关工具 | 所属模块的单一 inputSchema/exec、`tools/hubMcpRoutes.ts` 与 `runtime/backendFactory.ts` 两处挂载、claude 白名单与 grok config 说明、`gatewayToolContract.test.mts` 与 `hubMcpSecurity.test.mts`；本文 M12 |
| 加 triage 事件源或领域 | `triage.config.example.json` + VPS 真实 `triage.json` 同步、`worker/triage/domains/<domain>.mjs`、`prompt-hygiene.test.mjs`；本文 W1 |
| 搬动执行端/部署相关文件 | `worker/layout.test.mjs` 的入口表、`REVIEW_PATCH_SENSITIVE` 与其守护测试、`deploy/install-vps-worker.sh` / `worker-launcher.ps1` 的路径；本文 W2 |
| 加表/改 schema | 新 migration 文件；若被 triage 或 vault 读，见 I-2；本文 §5 与所属模块「数据」 |
| 改部署脚本 / unit | `deploy/*`、`deployPermissions.test.mts`、`setup.md`；记得 I-3；本文 §7 |
| 改静态 preamble 任一块 | `prompt/promptComposer.ts`、`smoke-token-round2-gates`、`prompt-layers.md`；先量缓存账（I-6）；本文 M5 |
| 换生产主机 / 地址 | `server/config.json`、`/etc/ai-hub/triage.json`、CLI 家目录 `.grok/.codex config.toml`、`server/data/agents/*gateway.json`、PC 侧 `worker/config.json`、`~/.ssh/config`、`~/.codex` `~/.grok` config.toml、Claude 桌面 MCP 配置、`deploy/*.ps1` 默认值、`setup.md`、**vault `_meta/cli/hooks/refresh-*.ps1` 的 Endpoint**（vault MCP 校验 Host 头，写 IP 不写 MagicDNS 名）；runbook 在 vault `vps-migration-vircs-to-xj401p-2026-09-04`；本文 §1 |

## 9. 维护规则

1. 本文只写功能模块、边界规则、不变量与「改哪几处」；实现细节看代码，历史看 git 与 vault pitfalls。
2. 触碰 §8.2 任一行的 commit 必须同时改本文对应小节；review 时对照。`server/test/architectureDoc.test.mts` 把「加了路由/后端/migration/专题文档/triage 领域/功能目录
   却没回来改文档」变成机械红灯；三份边界测试（§4.1）守住目录与依赖方向。
   文档与测试类 commit 不单独触发生产部署（重启会掐在途轮次，违背 CHARTER §4），随下一次维护窗口或功能部署带上。
3. 最小实现与验证入口见 [MINIMAL_IMPLEMENTATION.md](MINIMAL_IMPLEMENTATION.md)。
4. 新的坑先进 vault `memories/pitfalls-ai-hub.md`，被验证具备跨任务复用价值后再蒸馏成一条 I-n 进 §8.1；不要反过来。
5. 与本文冲突时，以 **测试与生产配置** 为准，并回来改本文。

相关文档：[plan.md](plan.md)（历史）、[model-driven-room-workflow.md](model-driven-room-workflow.md)、[prompt-layers.md](prompt-layers.md)、
[split-private-and-side-channel-windows.md](split-private-and-side-channel-windows.md)、[wechat-channel.md](wechat-channel.md)、[image-recognition.md](image-recognition.md)、
[Intiface MCP](intiface-mcp.md)、[GROK-ROOM-MCP-REPAIR.md](GROK-ROOM-MCP-REPAIR.md)、[workflow-profiles.md](workflow-profiles.md)、[workflow-modules-plan.md](workflow-modules-plan.md)、
[../deploy/setup.md](../deploy/setup.md)；vault：`ai-hub-delegation-contract`、`memory-routing-context-injection-architecture`、`pitfalls-ai-hub`、`pitfalls-triage-worker`、`pitfalls-pc-worker`。
