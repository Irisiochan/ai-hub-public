# ai-hub 架构（living doc）

> 本文写**不变量**，不写实现细节。每节标注最后核对日期与代码路径；改动「扩展清单」里列出的位置时必须同步本文（见文末维护规则）。
> 原始设计见 [plan.md](plan.md)（2026-07-18，历史文档，不再维护）；部署手册见 [../deploy/setup.md](../deploy/setup.md)。
>
> 最后整体核对：2026-09-05（commit 9ee7423 之后）。

## 0. 一句话定位

ai-hub 是 User 一个人用的 IM 式 AI 网关：每个 AI 联系人一条永续长对话，跑在她自己的 VPS 上，模型侧接 CLI 订阅（Claude Code / Codex / Grok / OpenCode）或 API 直连，共享同一个 Memory Vault，并把「后台自动化」和「让 AI 去干活」两条线也收进同一个网关。

**不是什么**：不是多租户产品；不是通用 agent 平台（联系人身份与家规是硬编码在人设与 overlay 里的）；不对公网开放聊天面。

产品层面的「是什么 / 不做什么 / 什么算够好」由 User 定，见 [CHARTER.md](CHARTER.md)；本文只管怎么建。

## 1. 生产拓扑（2026-09-05）

```
User 的手机 / PC / 微信
   │  Tailscale（tailnet 内直连）  或  微信 iLink（网关主动长轮询，无入站）
   ▼
VPS-52-xj401p = tailnet 名 User-house（100.69.139.7）
   ├─ ai-hub.service            Node 网关  100.69.139.7:3900   User=ai-hub
   ├─ ai-hub-triage-worker      后台自动化  127.0.0.1:3911(webhook)  DynamicUser
   ├─ memory-vault-mcp          Vault MCP  100.69.139.7:8900   User=memory-vault
   ├─ memory-vault-mcp-public   Vault MCP  127.0.0.1:8901 + 秘密路径 → Tailscale Funnel 公网
   ├─ ai-hub-update.path/.service  部署触发器（root，监视 /var/lib/ai-hub/deploy.request）
   └─ tailscaled / wg-vps（搬瓦工中转的 WireGuard 对端，网络层，不属于本仓）

PC（Windows）
   ├─ PC Worker  worker/worker.mjs：主动出站长轮询 /api/worker/claim，无入站端口
   ├─ 摄像头桥 / 淘宝桥：网关把请求「停放」，由 Worker 领取后回传
   └─ offsite 备份拉取 deploy/pull-offsite-backup.ps1（ssh 别名 User-vps）
```

- 网关只绑 tailnet IP（`server/config.json` 的 `host`），公网摸不到 3900。唯一公网入口是 Funnel 暴露的 vault 公网实例（给 claude.ai / 手机 MCP 用），URL 含随机路径。
- 一台机器、一个 SQLite（`/opt/ai-hub/server/data/hub.db`）、一个 vault clone（`/opt/memory-vault`）。没有 Docker、没有反代、没有对象存储。
- 主机变更史：2026-07-11 VirCS 首次部署 → 2026-09-04 整机 rsync 迁到 VPS-52-xj401p，tailnet 名 `User-house` 随迁，Funnel URL 不变（vault `memories/vps-migration-vircs-to-xj401p-2026-09-04`）。

## 2. 仓库结构（npm workspaces）

| 目录 | 职责 | 备注 |
|---|---|---|
| `server/src` | 网关：REST + SSE、联系人运行时、记忆层、通道、jobs | `index.ts` 入口，`server.ts` 装配路由 |
| `server/src/agents` | 后端适配、运行时、提示词、会议室、心跳、情绪/生活事件 | 39 个文件，最核心的目录 |
| `server/src/memory` | Vault 读写：`inject` / `capture` / `taskWriteback` / `vaultClient` | |
| `server/src/workers` | jobs、交付状态、验收/部署回执、workflow profiles、摄像头/淘宝桥 | PC Worker 的服务端半边 |
| `server/src/routes` | 12 个路由文件，见 §4 | |
| `server/migrations` | SQLite schema 演进，0001–0033，启动时顺序应用 | 只增不改 |
| `worker/` | **两个**常驻进程共用一个目录：`triage-worker.mjs`（VPS）与 `worker.mjs`（PC） | 别混淆 |
| `web/` | React + Vite 移动优先 IM 界面，网关直接 serve `web/dist` | |
| `mobile/` `desktop/` | Capacitor Android 壳（Web OTA 热更）、Electron 壳 | 壳只装 Web 版本 |
| `shared/coordination-keys` | 网关与 triage 共用派单指纹与 v1/v2 key；直接导入同一源码，不引入副本状态 | |
| `shared/contact-config` | 联系人配置 zod schema，server/web 以 `file:` 依赖安装**副本** | 改它必须升版，见 I-10 |
| `deploy/` | systemd unit、`update.sh`、触发/发布/备份脚本 | |

## 3. 数据模型（SQLite）

核心表与语义（`server/migrations/0001_init.sql` 起，逐号演进）：

- `contacts`：`kind` = `dm` | `room`；`backend` = `claude-cli` | `codex` | `grok-cli` | `opencode-cli` | `api`（`dsh` 是 DeepSeek harness 实验位）；`config` JSON 按 `shared/contact-config` schema 校验。**联系人的人设三层**：DB `config.appendSystemPrompt` ← 仓库 `server/agents/<id>/{CLAUDE.md,AGENTS.md}` ← 网关注入 `overlay.md`（见 §6）。
- `messages`：`sender`（user / 联系人 id / system）、`role`、`kind`（text/thinking/tool_use/error…）、`status`（streaming/done/error/interrupted）、`turn_id`、`meta` JSON、`origin`（`main` | `side`，0015）。**来源语义见 §7**，这是全仓最容易踩的地方。
- `sessions`：每联系人一个 active 的 CLI 会话 token（claude session_id / codex thread），用于 `--resume`；resume 失败置 inactive 开新会话，DB 历史不丢。
- `conversation_summaries`（0006）：滚动摘要，按高低水位批量滚动（不是逐轮），见 I-6。
- `workers` / `jobs`（0005 起）：PC Worker 注册与派工。job `status` ∈ pending/claimed/running/recovering/pause_requested/paused/cancel_requested/cancelled/blocked/done/failed；`delivery_state` 是给人看的交付态（`server/src/workers/deliveryStatus.ts`）：in_progress → completed_not_delivered → waiting_review → delivered_waiting_deploy → online_waiting_validation → closed_loop，另有 user_decision / rework_required / failure_or_blocked。每个 job 存不可变的 `options.workflow` 快照（0025）。
- `memory_outbox`（0002/0017）与 `job_outbox`（0022）：对外写入（vault、job 回执）先落 outbox 再重试，网关重启不丢。
- `task_writebacks`（0018/0027）与 task controller（0026）：Vault 任务状态的单写者状态机，`server/src/tasks/`。
- `usage_daily`（0014）：按联系人的 token/成本日账；`message_usage` 用于 prompt-cache 诊断。
- `contact_affect`（0021）、`life_events`（0024）、`heartbeat_sessions`（0028–0030；0032 起 API 联系人默认开启）、`ledger`（0031，支付宝/微信/招行账单导入）、`heartbeat_runs`（0033：心跳每跳的执行/用量审计，独立于 messages，静默清理不得抹掉执行证据）。
- `message_read_cursors`（0019）：主窗已读游标，跨端同步；历史 side 行只保留审计兼容，不提供副窗 UI 或 side 未读。

规则：schema 只通过新增 migration 变更；`server/src/migrations.ts` 顺序应用；新表若被非 root 的另一个服务读取，先看 I-2。

## 4. 请求与事件流

上行 REST，下行**单条全局 SSE** `GET /api/events`（`server/src/sse.ts`）。事件类型：`message`（完整落库行）、`delta`（流式追加）、`status`（idle/thinking/streaming/tool:x/error）、`contact`、`read-state`、`prune`、`user`、`worker`、`workflow-profile`、`job`、`job-message`、`heartbeat`。客户端断线后用 `GET /messages?after=lastId` 补齐，终态以服务端整行为准（I-5）。Worker/Job 由 `web/src/workerState.ts` 维护唯一可订阅状态，消费现有 worker/job/job-message SSE；展开详情才补取日志，重连或恢复前台统一校准，仅保留 App 内每 60 秒可见页兜底，不再在组件各开高频轮询。HTTP 返回不得覆盖请求期间的新 SSE 终态或删除事件。

路由挂载（`server/src/server.ts`）：

| 前缀 | 文件 | 主要端点 |
|---|---|---|
| `/api/contacts` | `contacts.ts` | 列表/增删改、`:id/models`、`:id/model`、`:id/effort` |
| `/api/contacts` | `messages.ts` | `:id/messages`（GET 分页 / POST 202 入队）、`:mid/regenerate`、DELETE、`:id/interrupt`、`:id/session/reset`、`:id/usage`、`messages/read`、`:id/room-rounds/:roundId`、`:id/room-host/messages` |
| `/api/contacts` | `heartbeat.ts` | `:id/heartbeat` GET/POST/DELETE |
| `/api/attachments` | `attachments.ts` | 附件读取（uploads 目录，600 权限） |
| `/api` | `workers.ts` | `/workers`、`/jobs`（含 `action`/`quality`/`resolve-out-of-band`/`delivery`）、`/workflow-profiles/*`、`/worker/connect`、`/worker/claim`、`/worker/jobs/:id/*`、`/worker/snap/:id`、`/worker/taobao/:id` |
| `/api` | `hubMcp.ts` | `/hub-mcp/:contactId`（Streamable HTTP MCP，给 CLI 联系人用的网关工具） |
| `/api` | `journal.ts` | `/journal/day` |
| `/api/vault` | `vaultTasks.ts` | `/task-status`（验收卡「置 done」） |
| `/api/ledger` | `ledger.ts` | 账单导入与月度摘要 |
| `/api/user` `/api/app` | `user.ts` `appRelease.ts` | 用户资料；Android OTA 清单 `/latest` |
| `/api` | `system.ts` + `server.ts` | `health`、`session`、`quota/*`、`system/{backup,purge,captions,affect,life-events,deploy,deploy/status,publish-status,hardening}` |

鉴权分三类（§10）：普通 API 走 session cookie；`/api/system/deploy*` 只认 `DEPLOY_TOKEN`；`/api/hub-mcp/:id` 走 per-contact HMAC bearer；`/api/health`、静态登录页匿名。

## 5. 联系人运行时（`server/src/agents/runtime.ts` + `manager.ts`）

- `AgentManager` 为每个启用的联系人持有一个 `AgentRuntime`；runtime 内是 **FIFO 串行队列，同一时刻只有一轮 in-flight**（容量 5，满了 429）。会议室轮次走 `runRoomTurn`，同样串行。
- 后端由 `backendFactory.ts` 按 `contacts.backend` 构建：`ClaudeCliBackend`（stream-json 持久子进程 + `--resume`）、`CodexAppServerBackend`（app-server JSON-RPC + thread/resume）、`GrokCliBackend`（headless，每轮新进程）、`OpencodeCliBackend`、`DirectApiBackend`（anthropic / openai-compat / gemini，无 resume，靠历史回放），`DshHarnessBackend`（实验）。
- 生命周期：懒启动；崩溃后下一条消息带 resume 重启；5 分钟内连崩 3 次锁定要求手动 reset；三段超时 `turnTimeoutMs` / `turnIdleTimeoutMs` / `turnHardTimeoutMs`（`server/config.json`）；`interrupt()` 与 `regenerateFrom()` 会做 CLI 上下文失效（`invalidateCliContext`）。
- 「持久会话」与「每轮新进程」是两种世界：claude/codex 常驻，preamble 只在 (re)spawn 注入一次；grok/API 每轮重传。任何「只注一次」的假设对后者都不成立（I-4）。
- CLI 子进程 env 必须剥掉 `CLAUDECODE` 与 `ANTHROPIC_BASE_URL/API_KEY`（嵌套检测与代理污染，plan.md 时代就踩过）。

## 6. 提示词组成（`server/src/agents/promptComposer.ts`）

`composeStart` 顺序固定，后者覆盖前者：

```
WORKFLOW_PRELOADED（静态，无时间无联系人名，保护 prompt-cache 前缀）
→ temporal block（时间语义，API 每轮复用）
→ room block（会议室成员/规则，仅 room）
→ memory preamble（模式 full / compact / off，见 §7）
→ replay block（CLI fresh spawn 时的历史桥接，硬预算 4096 token）
→ overlay（③b：server/agents/<cwd|id>/overlay.md，口吻与交付的最高优先级）
```

每轮追加（不进静态前缀）：`buildTurnBlock` 关键词检索片段、`nsfwCraft=intimate` 的 per-turn 工艺块（fail-open，见 I-8）、跨联系人生活事件、`TURN_TIME_PRELOADED` 当前时间、会议室 `<ROOM_TURN_GATEWAY>` 本轮窗口清单。

分层与优先级的完整说明：[prompt-layers.md](prompt-layers.md)。**规则：每轮必变的内容一律放最后一条 user 消息，绝不放 system/历史区**（I-6）。

## 7. 记忆层与消息来源语义

**读路径** `server/src/memory/inject.ts`：网关决定模型看见什么，而不是指望模型自己去查。`buildSessionPreamble` 默认 `get_core_context(source=compact)`（只常驻 pinned/high facts，约 3k token），显式 `full` 才走 `get_context` 全索引；`buildTurnBlock` 每条用户消息做一次轻量 `search_vault`，会话内去重。

**写路径** `server/src/memory/capture.ts`：每轮结束跑廉价触发词，命中就把 User 原话（**只看她自己新写的部分**，剥掉 `> ` 引用行）投到 vault `inbox/` 打 `hub-auto` 标签；可选 DeepSeek flash 复审，超时/异常不阻断（标 `llm-review-pending`）。捕捉只在 room/message 级执行一次，AI 成员发言与拼装 transcript 永远排除（I-7）。

**任务回写** `server/src/memory/taskWriteback.ts` + `server/src/tasks/`：任务变更经 controller 单写者，写 `task_writebacks` 再投递。`TaskStateService` 的状态变更、注记、改期共用一个命令事务：幂等检查 → 版本校验 → 更新 → 不可变事件 + task_outbox；投影失败时整条命令回滚。保留既有 Vault 描述/Plan 读取和历史迁移，不增加第二份可变任务账本。

**消息来源三件事分开存**（`server/src/agents/messageSource.ts`）：
1. provider 协议角色（后台事件为了触发模型必须用 `user` role）；
2. 领域来源 `sender` / `origin`（后台事件强制 `origin=side, sender=system`）；
3. 结构化 `automation` 描述符（`messageType/eventSource/eventId/eventCategory/eventPriority`）。
前端与 triage 只按 (2)(3) 判「是不是 User 手动说的」；旧记录才允许正文规则 fallback，而 `⚡ AI Hub 自主事件分派` 这行抬头就是那个 fallback 的分类主键（I-9）。side 已退役为审计层，当前主窗/会议室路由约定见文末：[split-private-and-side-channel-windows.md](split-private-and-side-channel-windows.md)。

## 8. 会议室（`kind=room`）

- 房间是一个联系人，成员是其他联系人；`room-host` 是不唤醒模型的持久化系统发言（`coordinationRoom.ts`），`roomDispatchDrain.ts` 负责把派单投递到成员轮次。
- 一轮 = `roundId`；成员看到的是 `<ROOM_TURN_GATEWAY> current_window {message_ids, from, through, count}`，**历史行标签恒为「历史消息」**，本轮范围只由 manifest 承载（否则 prompt-cache 前缀在邻轮翻转处断开，I-6）。
- 共享群摘要写入点只有两处：CLI fresh spawn 的 bridge 与 API 成员的 history；持久会话成员不写。验收「摘要 version 增速」前先确认写路径跑过。
- 派工语言统一为「委托契约」（vault `memories/ai-hub-delegation-contract.md`）：User 批准 Plan 是授权闸门，聊天文字只给人看，结构化 dispatch 才驱动系统；`executor != verifier`；同一 `taskPath` 的 coordination job 永不并行（`coordinationJobMutex.test.mts`）。
- Claude 后端只有三席（房间Claude / CLI Claude / 主窗 daily Claude），不接 headless worker job；实现单默认 codex，只读/机械单默认 grok。

## 9. 后台自动化：triage worker（`worker/triage-worker.mjs`）

独立 systemd 进程（DynamicUser，状态在 `/var/lib/private/ai-hub-triage/triage.db`），配置 `/etc/ai-hub/triage.json` + `triage.env`。**它和网关只通过 HTTP 说话**（`hub.baseUrl`，token 来自 env），改网关地址两边都要改。

- 事件源 `sources[]`：定时器（quarter-hour-check、daily-check-in、daily-idea-room 等）、Vault backlog 摘要变化、webhook（127.0.0.1:3911，网关推送）。事件进 `triage_events`，DeepSeek flash/pro 分类，按 `routing.rules` 派给联系人或 NO_OP。
- 领域模块（`worker/worker-*.mjs`）：proactive（日常陪伴，静默时段与在场感知）、reminders（确定性截止日期扫描）、coordination（会议室 sweep/催办/回执）、agenda（每日议程）、routeTriage（路由审核）、idea/diary（idea 房与日记 rollup）、outcomes（回填 engaged/accepted/…）、followups、backlog（待拆分需求日扫）。
- 执行候选与验收候选共用 `coordinationTaskSnapshot()` 的一次即时目录快照，各自资格判定与派发前重读仍独立；不缓存任务裁决。派单指纹和 v1/v2 key 只在 `shared/coordination-keys` 定义，网关和 Worker 共用；Agenda 只保留当前增量通知状态，移除无人读取的 v1 last-fingerprint 写入。
- 熔断 `breakers.dailyEvents / dailyCostCny`；`prompt-hygiene.test.mjs` 守派单措辞。
- 手动跑任何一次性命令必须先 `set -a; . /etc/ai-hub/triage.env; set +a`（I-11）。

## 10. PC Worker、jobs 与网关工具

- PC Worker（`worker/worker.mjs`，Windows 由 `worker-launcher.ps1` 托管）**只出站**：`/worker/connect` 注册 → `/worker/claim?wait=` 长轮询领 job → `/start` `/events` `/heartbeat` `/complete` `/recover` 回传。领到的还包括摄像头 `snapRequest` 与淘宝 `taobaoRequest`：网关侧 `CameraSnapBroker` / `TaobaoBridge` 只是把请求停放在内存，没人领就超时失败，不落库。
- job 权限位 `permissions`（write/shell/ssh）由联系人 `delegation` 配置与 job 选项共同决定；**`ssh: true` 不注入任何凭据**，只是允许去试。
- Workflow profiles（[workflow-profiles.md](workflow-profiles.md)）只改角色→runner/model 映射，不改权限、审批闸门与任务状态机；三振 fallback 按 `(profile, taskPath, stage, fingerprint, runner)` 键计。
- 工具输入唯一声明在各工具的 `inputSchema`（zod）；`agents/gatewayTool.ts` 从它生成 API JSON Schema 并统一验证，`routes/hubMcp.ts` 直接复用同一对象，不维护第二张参数表。未知字段与违约参数两种入口都拒绝后再执行，联系人权限、心跳及范围校验仍在领域实现中。
- `/api/hub-mcp/:contactId` 暴露给 CLI 联系人的网关工具：`delegate_to_worker`、`worker_job_status/update_delivery/cancel`、`camera_snap`（返回 image content block，不落盘）、淘宝一组 `search_products/add_to_cart/…`（按联系人 `taobao.mode` 裁剪）。claude 通过 `--allowedTools mcp__hub__*` 白名单接入，grok 通过 `~/.grok/config.toml` 的 `[mcp_servers.hub]`（header 要写展开后的真实 bearer）。

## 11. 通道与陪伴功能

- **微信**（`server/src/wechat/`，[wechat-channel.md](wechat-channel.md)）：自实现 iLink bot HTTP 协议，网关主动长轮询，无入站；显式 `Claude/Codex/阿野` 前缀路由，30 分钟 sticky；`WECHAT_ALLOW_FROM` 之外直接丢弃；游标与 sticky 状态在 `/var/lib/ai-hub/wechat-channel-state.json`。
- **心跳**（`companionHeartbeat.ts`，`heartbeat_sessions`）：每跳 4–7 分钟随机，模型自己决定说不说话，静默令牌只是出口不是默认（I-12）。
- **生活事件**（`lifeEvents.ts`）：从 User 自述里抽取高时效状态（正则闸 → DeepSeek 结构化），供其他联系人每轮注入；亲密内容与他人隐私一律排除。
- **情绪**（`affect.ts` / `affectService.ts`）：联系人级 valence/arousal 带衰减，`config.affect=on` 才启用。
- **识图**：四种后端四种喂法，[image-recognition.md](image-recognition.md)；新加后端必须同时改前端 `canSendImages`、后端消费 `imagePaths`、文档、smoke（I-13）。

## 12. 安全边界

| 边界 | 机制 | 代码/配置 |
|---|---|---|
| 网络 | 网关与 vault 内网实例只绑 tailnet IP；公网仅 Funnel → 127.0.0.1:8901 秘密路径 | `server/config.json`、`tailscale funnel` |
| 登录 | 密码 → 30 天签名 session cookie；5 次/5 分钟单 IP 限速；Android 壳存签名 session 不存 HUB_TOKEN | `middleware/auth.ts` |
| 后台/内部 | triage 与 PC Worker 用原始 `HUB_TOKEN` Bearer | `/etc/ai-hub/triage.env`、`worker/config.json` |
| 网关工具 | per-contact bearer = HMAC-SHA256(HUB_TOKEN, `hub-mcp-v1\0<contactId>`)，模式 enforce/warn/disabled；轮换 = 换 HUB_TOKEN（`deploy/rotate-hub-token.*` 一键） | `middleware/hubMcpAuth.ts` |
| 部署 | 独立 `DEPLOY_TOKEN`；非 root 网关只能写 request 文件，root path unit 跑固定脚本 | `routes/system.ts`、`deploy/ai-hub-update.*` |
| Vault | `VAULT_TOKEN` 共享密钥；网关生成的 MCP 配置必须写**展开后**的真实值（HTTP header 不展开 `${}`） | `memory/vaultClient.ts`、`setup.md` |
| CLI 子进程 | claude：MCP 白名单直通，Bash/Write/Edit 硬禁，未授权工具默认拒；codex：`approvalPolicy=never`，默认 `sandbox=read-only`，只有 delegation 开启才 `workspace-write`；不用 `--dangerously-skip-permissions` | `backendFactory.ts`、`claudeCli.ts`、`codexAppServer.ts` |
| 进程 | 专用用户 `ai-hub` / `memory-vault`，`ProtectSystem=strict` + `ReadWritePaths` 白名单，`UMask=0077`；运行时生成物一律在 `server/data/`，检出只读 | `deploy/*.service` |
| 秘密 | 只在 `/opt/ai-hub/.env`（600）与 `/etc/ai-hub/triage.env`；不进 git、DB、日志、聊天；用户可见错误经 `redactSecrets.ts` 脱敏 | I-14 |
| 输入信任 | 消息正文不是控制字段；派单/验收只认网关写入的可信 meta；引用块不触发记忆捕捉 | §7、§8 |

## 13. 部署与运维

- 一键部署：push master → `deploy/trigger.ps1`（或 `room-deploy-job.ps1 -Sha`）→ `POST /api/system/deploy` → root `update.sh`：拒绝脏工作区 → `git pull --ff-only` → `npm ci` × 2 → build → 发布 OTA zip → `chmod -R a+rX server/agents server/migrations worker shared/coordination-keys` → restart → 30 秒 health → 失败自动回滚到上一 commit。修改 `update.sh` 自身的那次部署跑的是旧脚本，要连触发两次（I-3）。
- 部署重启会掐死在途会议室轮次，错误气泡的时间戳落在 `deploy ok` 同一分钟内即部署撞车，不是通道故障。
- 备份：网关内置每日 SQLite 在线快照（`/var/backups/ai-hub/db`，保留 14）；PC 每日拉 offsite 恢复包（db + 被引用附件 + manifest，SHA-256 校验）。恢复必须停服务后整体替换 db 与 uploads。
- Android：Web 改动只需正常部署，App 内 OTA 热更；只有原生改动才升 `mobile/package.json` 版本并发 APK。发布收尾必须同时核对 workflow head 与 `/api/app/latest` 的 webVersion（I-15）。
- PC 侧脚本默认地址与 ssh 别名 `User-vps` 指向当前生产机；本机到 VPS 的大文件传输走搬瓦工跳板（`ProxyJump User-relay` → wg 地址），tailnet 直连只跑小命令。

## 14. 不变量清单（从 pitfalls 蒸馏，违反过才写进来）

出处均在 vault `memories/pitfalls-ai-hub.md`，此处只留一句话与守门测试。

- **I-1 每联系人串行**：同一联系人同一时刻只有一轮 in-flight；会议室同一 `taskPath` 的 coordination job 永不并行。守门：`coordinationJobMutex.test.mts`。
- **I-2 跨用户读文件先用消费方身份读一次**：`UMask=0077` 的服务写出的文件（vault tasks、git 对象、migration、worker/*.mjs、overlay.md）非 root 读不到，症状伪装成 EACCES / `loose object corrupt` / 静默空串。`update.sh` 的 chmod 白名单必须覆盖 `server/agents`、`server/migrations`、`worker`、`shared/coordination-keys`。Electron 通过 extraResources 分发同一共享源码到 resources/shared/coordination-keys；移动编译产物布局时必须同时核对相对导入。守门：`deployPermissions.test.mts`。把「经服务读」改成「直接读文件」的改动，Plan 里必须写部署前置权限。
- **I-3 部署脚本自更新延迟一轮**：改 `update.sh` 要触发两次部署。
- **I-4 preamble 只注一次的假设只对持久会话成立**：grok/API 每轮重传；WORKFLOW_PRELOADED 之类必须靠网关标记而不是「新会话」判断。守门：`smoke-token-round2-gates`。
- **I-5 流终态以服务端整行为权威**：done/error/interrupted 不得被本地 delta 拼接稿覆盖；只有仍在 streaming 的较短快照才保留本地更长内容。守门：`web/test/messageMerge.test.mjs`。
- **I-6 保护 prompt-cache 前缀**：每轮必变的内容（时间、本轮窗口、滚动摘要）不进 system/历史区；摘要按高低水位批量滚动；群聊历史标签恒为「历史消息」。压 token 前先用 `message_usage` 量缓存账。守门：`smoke-prompt-cache-stability`。
- **I-7 记忆捕捉只看 User 原话**：拼装前锁定原始 user text；剥引用块；AI 发言与 transcript 永远排除；每 room/message 最多一次。守门：`capture.test.mts`。
- **I-8 亲密/工程混合分类器禁止单信号 skip**：漏报优先于省 token。守门：`smoke-token-round2-gates`。
- **I-9 `⚡ AI Hub 自主事件分派` 抬头是契约常量**：产地 `worker/triage-worker.mjs`，消费 `messageSource.ts`、`sideChannel.ts`、`routes/journal.ts`；改抬头必须四处同步并保留旧值兼容分支。
- **I-10 `file:` 共享包改源码必须升版**：否则 server/web 的安装副本静默继续跑旧代码，两份 lock 一起更新。
- **I-11 手动跑 triage 一次性命令先 source triage.env**：否则 HubClient 空 token 报 `missing or invalid session token`，像网关坏了。
- **I-12 自主发言协议不得把「说」框成打扰**：会收敛到 100% 静默；把授权写明（开启功能即发言许可），不加机械配额。
- **I-13 新增 CLI 后端的四处清单**：`ChatPane canSendImages`、backend 消费 `imagePaths`、`docs/image-recognition.md`、对应 smoke。
- **I-14 子进程 stderr 透传到用户可见面之前必须脱敏**：codex `-c` 的 map 值要 TOML inline table 而不是 JSON 字符串，否则报错会把 bearer 回显进聊天。守门：`hubMcpSecurity.test.mts`。
- **I-15 双轨发布核对两条版本线**：APK workflow head 与 `/api/app/latest` 的 webVersion/SHA 都指向目标才算发布完成。
- **I-16 生产人设以 `/api/contacts` 为准**：seed 只在联系人不存在时生效，DB 与仓库不一致是默认状态；要覆盖 DB 文案用 overlay。
- **I-17 状态接口区分「探测失败」与「探测到否」**：三态（active/inactive/unknown）+ 日志标记兜底，不把异常吞成 false。守门：`deployStatus.test.mts`。
- **I-18 时间戳先确认数据源时区**：SQLite `datetime('now')` 是 UTC naive，一律经 `parseHubTimestampMs` 解析；不改主机 TZ 也不改落库格式。
- **I-19 多会话共用检出**：只 `git add <确切路径>`，永不 `-A`/`-a`/`.`；开工先 `deploy/session-worktree.sh add`。

## 15. 扩展清单（改这些位置时同步本文）

| 要做的事 | 必改位置 |
|---|---|
| 加一种模型后端 | `agents/types.ts` backend 枚举、`backendFactory.ts` builder、`shared/contact-config`（升版）、`web` ContactConfig 与 `canSendImages`、`docs/image-recognition.md`、smoke；README 架构框图；本文 §5/§11 |
| 加一个联系人 | DB（UI 或 seed）、`server/agents/<id>/{CLAUDE.md\|AGENTS.md, overlay.md}`（644）、如需网关工具则 hub-mcp bearer 注入路径；会议室成员默认表（vault fact `work.ai_hub.room.members`） |
| 加一条通道（类微信） | `server/src/<channel>/`、`.env` 变量、`/api/health` 观测字段、状态文件路径进 `ReadWritePaths`、`docs/<channel>.md`；本文 §1/§11/§12 |
| 加一个网关工具 | 对应 `agents/*Tools.ts` 的单一 inputSchema/exec、`routes/hubMcp.ts` 挂载、claude 白名单与 grok config 说明、`gatewayToolContract.test.mts` 与 `hubMcpSecurity.test.mts`；本文 §10 |
| 加 triage 事件源或领域 | `triage.config.example.json` + VPS 真实 `triage.json` 同步、`worker/worker-<domain>.mjs`、`prompt-hygiene.test.mjs`；本文 §9 |
| 加表/改 schema | 新 migration 文件；若被 triage 或 vault 读，见 I-2；本文 §3 |
| 改部署脚本 / unit | `deploy/*`、`deployPermissions.test.mts`、`setup.md`；记得 I-3；本文 §13 |
| 改静态 preamble 任一块 | `promptComposer.ts`、`smoke-token-round2-gates`、`prompt-layers.md`；先量缓存账（I-6）；本文 §6 |
| 换生产主机 / 地址 | `server/config.json`、`/etc/ai-hub/triage.json`、CLI 家目录 `.grok/.codex config.toml`、`server/data/agents/*gateway.json`、PC 侧 `worker/config.json`、`~/.ssh/config`、`~/.codex` `~/.grok` config.toml、Claude 桌面 MCP 配置、`deploy/*.ps1` 默认值、`setup.md`、**vault `_meta/cli/hooks/refresh-*.ps1` 的 Endpoint**（vault MCP 校验 Host 头，写 IP 不写 MagicDNS 名）；runbook 在 vault `vps-migration-vircs-to-xj401p-2026-09-04`；本文 §1 |

## 16. 维护规则

1. 本文只写不变量、边界与「改哪几处」；实现细节看代码，历史看 git 与 vault pitfalls。
2. 触碰 §15 任一行的 commit 必须同时改本文对应小节并更新该节日期；review 时对照。
   文档与测试类 commit 不单独触发生产部署（重启会掐在途轮次，违背 CHARTER §4），随下一次维护窗口或功能部署带上。
3. 最小实现与验证入口见 [MINIMAL_IMPLEMENTATION.md](MINIMAL_IMPLEMENTATION.md)。
4. 新的坑先进 vault `memories/pitfalls-ai-hub.md`，被验证具备跨任务复用价值后再蒸馏成一条 I-n 进 §14；不要反过来。
5. 与本文冲突时，以 **测试与生产配置** 为准，并回来改本文。

相关文档：[plan.md](plan.md)（历史）、[prompt-layers.md](prompt-layers.md)、[split-private-and-side-channel-windows.md](split-private-and-side-channel-windows.md)、[wechat-channel.md](wechat-channel.md)、[image-recognition.md](image-recognition.md)、[workflow-profiles.md](workflow-profiles.md)、[../deploy/setup.md](../deploy/setup.md)；vault：`ai-hub-delegation-contract`、`memory-routing-context-injection-architecture`、`pitfalls-ai-hub`、`pitfalls-triage-worker`、`pitfalls-pc-worker`。
