# ai-hub

自托管的 multi-agent harness，也是面向个人长期运行的 AI 基础设施。它把 Claude Code、Codex、
Grok CLI 和任意 API 模型接进同一套持久会话、长期记忆、任务委派与协作总线，并自带 IM 式前端。

它不只是一个多模型聊天页面：网关管理 agent 会话与权限，Memory Vault 提供长期记忆，
PC Worker 在个人设备执行任务，triage worker 处理主动事件，会议室负责可信派单、handoff 和回执。
Web、Electron 桌面端和 Android 客户端只是这套 harness 的交互入口。

> 这是一个个人项目的公开展示版本。它在作者自己的 VPS 上 24/7 跑着真实日常，
> 但不承诺支持、不保证响应 issue，PR 随缘。拿去用、拿去改都欢迎（MIT）。

## 核心能力

- **多 Agent 宿主**：把 `claude` CLI（stream-json 持久子进程 + resume）、
  `codex app-server`（JSON-RPC）、Grok CLI 和 API 直连模型（Anthropic / OpenAI-compatible /
  Gemini 原生协议）组织成长期在线的独立联系人；每个联系人保留自己的会话、人格、权限与工作目录
- **协作与 handoff**：拉现有联系人建群，用 `@名字` / `@all` 调度；Plan 就绪的任务可进入会议室工作总线，
  由网关签发可信派单，成员接单、委派、交付，协调指纹和完成回执防止正文伪造状态
- **PC Worker 委派**：聊天里的 AI 可以把编码任务派给你 PC 上的 claude/codex 执行，
  任务以可折叠子会话挂回原消息，支持暂停/取消/重试，完成后自动回执验收
- **长期记忆**：Memory Vault 以 Markdown 保存记忆，网关按联系人自动注入、检索和捕捉，
  支持 full / compact / off 三档，并通过独立、版本化的 MCP 契约接入
- **自主 triage worker**：VPS 常驻事件分诊——daily 主动陪伴、纪念日/生日提醒、任务到期催办、
  临时离开跟进，全部走廉价 flash 模型把关后才打扰人
- **IM 式交互入口**：每个 AI 是一个联系人，一条持续演进的对话；历史跨设备同步，支持群聊、
  改名、头像与主题色，Web、Electron 和 Android 共用同一套网关
- **图片与模型能力**：选图或粘贴截图直接发送，API 联系人可按需配置独立视觉模型；
  Claude / Codex 标题栏可显示 5h / 周窗口剩余
- **运维内建**：token 门控的一键部署端点（拉取/构建/重启/健康检查/失败自动回滚）、
  SQLite 在线定时备份（integrity 校验 + 保留窗口）、发布状态面板

## 架构

```
客户端 (Web / Electron / Android IM UI)
   │  REST + SSE
AI Hub harness / 网关 (Node/TS, :3900)
   ├─ SQLite (contacts / messages / sessions / jobs / coordination)
   ├─ Memory Vault (MCP, :8900) → vault-data/ (Markdown)
   ├─ triage worker → 主动事件与通知闸门
   ├─ 会议室工作总线 → 可信派单 / handoff / 回执
   │
   │  每个联系人一个持久子进程或 API 客户端
   ├─ claude --input-format stream-json --output-format stream-json [--resume]
   ├─ codex app-server (JSON-RPC over stdio, thread/resume)
   ├─ grok (CLI stream events, session/resume)
   └─ 直连 API (anthropic / openai-compat / gemini)

PC Worker (主动出站长轮询，无入站端口)
   └─ 网关 jobs 队列 → 本机 codex exec / claude -p → 流式事件与结果回传
```

- CLI 会话通过 `--resume` 跨网关重启延续，session id 存 SQLite
- 每联系人串行队列，同一时刻只有一轮 in-flight；长会话按 token 阈值自动换新 thread + 滚动摘要
- API 直连按联系人 token 预算裁剪历史、持久化滚动摘要、成本分项估算

## 快速启动

推荐用 Compose 一次启动前端、网关和记忆库。Compose 默认从独立仓库构建
Memory Vault `v0.7.0`，本仓库不维护它的源码副本：

```bash
cp .env.example .env
docker compose -f docker-compose.example.yml up --build -d
```

打开 `http://127.0.0.1:3900`。首次启动会在仓库旁生成被 gitignore 的 `vault-data/`，
里面是可直接用 Obsidian 打开的私人 Markdown 记忆库。

本地源码开发：

```bash
cd server && npm install && npm run dev     # 网关 :3900
cd web && npm install && npm run dev        # 前端 :5173（代理 /api → 3900）
```

或构建后单进程：`cd web && npm run build`，网关直接 serve `web/dist`。

首次启动会创建中性的 `Claude Code`、`Codex`、`Grok Build` 三个工具联系人；使用前请先
登录对应 CLI。也可以用 🧪 Mock 联系人（`server/scripts/mock-claude.mjs`）测试管线和 UI。

## 配置

- `server/config.example.json` → 复制为 `server/config.json`（端口、CLI 路径等）
- Compose 会自动连接固定版本的外部 Memory Vault；源码开发时先用
  `memory-vault-mcp --vault <数据目录> --http --host 127.0.0.1 --port 8900`
  启动独立服务，再在 `server/config.json` 将 `memory.mcpUrl` 指向
  `http://127.0.0.1:8900/mcp`
- 联系人级配置存在 DB（UI 可改）：模型、人设、记忆三开关、委派权限等
- Agent 工作目录在 `server/agents/<联系人id>/`：`CLAUDE.md` 是人设
  （模板见 `server/agents/example/`），`mcp.json` 指向记忆库 MCP server，
  `overlay.md` 是该联系人相对它家厂商 base prompt 的差分叠层（跟着仓库走，四个后端通用）
- 系统提示词分几层、想改口吻该动哪一层：[docs/prompt-layers.md](docs/prompt-layers.md)
- 自动消息 `origin` 兼容与 side 审计层约定（任务执行进会议室，daily 陪伴进 `main`）：
  [docs/split-private-and-side-channel-windows.md](docs/split-private-and-side-channel-windows.md) 文末「side 退役为审计层」
- **多会话并发写这个仓库时先开自己的分支**（暂存区是仓库级共享状态，直接在 master 上
  add/commit 会互相收走对方的文件）：

  ```bash
  git config core.hooksPath deploy/githooks   # 每个 checkout 装一次，挡住 master 直提
  bash deploy/session-worktree.sh add <本次任务短名>
  # 干完在自己的 worktree 里 commit，再回主检出 merge --ff-only session/<短名> 并 push
  ```

  集成、修部署脚本这类确实要就地提交的，用 `AI_HUB_ALLOW_MASTER=1 git commit ...` 单次放行；
  PC Worker 的 job 已经带着这个变量跑，委派链路不受影响。
- 秘密只走 `.env`（gitignore）：`CLAUDE_CODE_OAUTH_TOKEN`、`VAULT_TOKEN`、`DEPLOY_TOKEN`、`DEEPSEEK_API_KEY`

## Memory Vault

Memory Vault 是独立产品，本仓库只通过版本化 Docker 构建上下文或
`memory-vault-mcp` CLI 消费它，不复制维护 `_meta/mcp_server.py`、模板或测试源码。
Compose 的私人数据始终写入被 gitignore 的 `vault-data/`，不会进入 ai-hub 源码历史。

不配置 Git 时，记忆会稳定保存在本机目录。需要多设备同步时，把 `vault-data/` 初始化或克隆成一个
**独立的私有 Git 仓库**；服务检测到 `vault-data/.git` 后，才会自动 pull、commit 和 push。
它绝不会沿父目录误用 ai-hub 的远端。安装、MCP 配置与升级说明见
[Memory Vault 独立仓库](https://github.com/Irisiochan/memory-vault)。

## PC Worker（离线优先）

网关是权威任务队列。PC 不在线时任务保持 `pending`；上线后只认领 runner、workspace
和能力快照都匹配的任务。运行中失联变 `interrupted`，不自动重跑可能有副作用的任务。

1. 前端左上角 `🖥`，输入设备名生成一次性配对令牌
2. `worker/config.example.json` → `worker/config.json`，填令牌和允许的 workspace
3. `node worker/worker.mjs worker/config.json` 验证；Windows 登录自启用
   `worker-launcher.ps1 -Action install`（单实例、崩溃退避重拉、本地状态文件）

## 安全模型与威胁边界

**信任边界 = 你的私有网络。** 网关目前没有账号或租户体系，设计为跑在 Tailscale 等
overlay 网络内、绑定内网 IP；**绝对不要把 3900 直接暴露公网**。在此边界内：

- 设置 `HUB_TOKEN` 后，Web UI、API 与 SSE 会启用同一套 session 鉴权；CLI 联系人的 Hub MCP
  Bearer 还会按联系人派生并默认强制校验。它仍是单用户边界，不是多租户权限系统。任何取得
  session 的人都可能读取聊天记录、管理联系人、生成 Worker 配对令牌，并在已有权限边界内
  发起委派。Tailnet 里有其他成员时，仍必须用 ACL 只允许受信设备/用户访问 3900。

- API key 服务端存储、返回 UI 永远打码；`.env` 与数据库不进 git
- 微信 iLink bot 通道的部署与凭据边界见 [docs/wechat-channel.md](docs/wechat-channel.md)
- CLI 联系人默认聊天模式：MCP 记忆工具白名单直通，Bash/Write/Edit 硬禁，漏网默认拒；
  写权限/Shell 需按联系人显式开启 projectAccess 并指定 workspace
- Worker 只出站长轮询，无入站端口；配对 token 服务端只存 SHA-256；
  workspace 白名单 + shell/ssh 双开关默认关闭；委派有防循环和并发上限
- 部署端点 Bearer token 门控（未配置即整体禁用），只执行仓库内固定脚本，
  经 systemd 瞬态单元跑，健康检查失败自动回滚
- 图片上传：MIME + 文件签名双校验、大小/数量限制、UUID 文件名、随消息删除、启动孤儿清理

## 部署

`deploy/update.sh` 是幂等更新脚本（拒脏工作树、ff-only、npm ci、构建、重启、
健康检查、失败自动回滚），配合 `deploy/ai-hub.service` systemd 单元使用。
线上跑起来后可用 `POST /api/system/deploy`（Bearer `DEPLOY_TOKEN`）远程触发同一脚本，
`GET /api/system/deploy/status` 看进度。SQLite 每 24h 自动在线备份到仓库外目录。

### Docker Compose（开源部署模板）

作者自己的生产环境继续使用 systemd；Compose 模板只服务外部部署者，不替换现有生产链路。

默认只绑定宿主机 `127.0.0.1:3900`；Memory Vault 的 8900 端口只在 Compose 内网开放。
聊天数据、附件、备份和 agent 工作目录放在命名卷中，私人 Markdown 放在 `vault-data/`。
容器镜像包含网关与 Web UI，但不内置 Claude/Codex CLI 或个人凭据；API 直连联系人可直接使用。
如需 CLI 后端，请基于 Dockerfile 自建包含相应 CLI 的镜像并显式挂载凭据，或者使用上面的
宿主机 systemd 部署方式。不要为了让容器重启宿主服务而挂载 `docker.sock`。

## 设计参考与致谢

下面列的是已经影响到现有实现的协议或工程设计参考，不表示 AI Hub 是这些项目的 fork，
也不表示它们与 AI Hub 存在官方关联或背书：

- [Model Context Protocol](https://modelcontextprotocol.io/) 与
  [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)：Memory Vault、工具发现、
  Streamable HTTP 与 Hub MCP 的协议边界。
- [OpenAI Codex app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server)：
  Codex 后端的 JSON-RPC、thread/resume 与 native compact 接入。
- [Anthropic Claude Code](https://github.com/anthropics/claude-code)：Claude CLI 的 stream-json、
  resume 与项目级 agent 工作目录集成。
- [CAS — Coding Agent System](https://github.com/codingagentsystem/cas)：用于对照会议室编排、
  supervisor/worker 分工、共享任务状态与隔离 worktree 的交付闭环。
- [NVIDIA Labs OO Agents (NOOA)](https://github.com/NVIDIA-NeMo/labs-OO-Agents)：用于对照
  大对象 bounded preview + recall、显式状态与优先采用后端原生 compaction 的上下文策略。

项目由 Irisiochan 发起并维护；Claude Code、Codex 等 AI 编程代理参与过设计、实现、测试与
审查，AI 不作为版权所有者。若代码、配置或资产直接复用/改编自第三方，应在对应文件和
第三方声明中单独标注来源与许可证。

## 第三方依赖与许可证

React、Node.js、SQLite、Electron、Capacitor、MCP SDK 等构成主要技术栈。各目录的
`package.json` 与 `package-lock.json` 是依赖名称和版本的权威来源；由四份 lockfile
可重复生成的完整 npm 组件清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：

```bash
npm run notices        # 重新生成
npm run notices:check  # 验证锁文件与声明仍一致
```

生成器会拒绝缺失许可证元数据以及 GPL/AGPL/LGPL/SSPL/BUSL/自定义许可证，当前清单覆盖
网关/Docker、Web UI、Electron 桌面壳和 Capacitor Android 壳所用的 npm 运行时与构建依赖。
Electron/Chromium/Node、Android 等原生工具链仍以它们随二进制附带的上游 notices 为准。
第三方组件分别受其自身许可证约束，与本项目自身的 MIT License 分开表达。

## License

MIT © Irisiochan
