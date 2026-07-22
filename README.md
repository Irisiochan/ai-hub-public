# ai-hub

自托管的 AI 聊天网关，也是 [Memory Vault](https://github.com/Irisiochan/memory-vault)
的可选旗舰客户端：像 IM 一样跟 Claude Code、Codex、Grok CLI 和任意 API 模型聊天。
手机/电脑浏览器访问，历史全同步，CLI 后端走订阅额度，还能把编码任务派回自己的 PC 执行。

> 这是一个个人项目的公开展示版本。它在作者自己的 VPS 上 24/7 跑着真实日常，
> 但不承诺支持、不保证响应 issue，PR 随缘。拿去用、拿去改都欢迎（MIT）。

## 能干什么

- **IM 式永续会话**：每个 AI 是一个联系人，一条永远聊下去的对话；改名、换头像、换颜色
- **四类后端**：`claude` CLI、`codex app-server`、Grok CLI，以及 Anthropic /
  OpenAI-compatible / Gemini 原生 API；模型与推理档位可以按联系人和委派任务选择
- **群聊**：拉现有联系人建群，`@名字` / `@all` 调度，每成员独立会话
- **图片**：选图/粘贴截图直接发，API 联系人可按需配独立视觉模型
- **版本化长期记忆**：Memory Vault 以 Markdown 保存记忆，网关按联系人自动注入、检索和捕捉，支持 full / compact / off 三档；两仓只通过 MCP 契约连接
- **语义化记忆捕捉**：廉价规则先筛选候选，再由 DeepSeek 以固定 JSON schema 精筛；高置信度内容进入 inbox、明确误报丢弃，低置信度或 API 故障标记为待审，不阻断聊天
- **PC Worker 委派**：聊天里的 AI 可以把编码任务派给你 PC 上的 claude/codex 执行，
  任务以可折叠子会话挂回原消息，支持暂停/取消/重试，完成后自动回执验收
- **订阅额度可见**：Claude / Codex 标题栏实时显示 5h / 周窗口剩余
- **桌面与 Android 壳**：Electron 支持本地/远程 Hub，Capacitor 伴侣 App 可由 Actions 生成 APK
- **运维内建**：token 门控的一键部署端点（拉取/构建/重启/健康检查/失败自动回滚）、
  SQLite 在线定时备份（integrity 校验 + 保留窗口）、发布状态面板

## 架构

```
浏览器 (React IM UI)
   │  REST + SSE
网关 (Node/TS, :3900)  ←  SQLite (contacts / messages / sessions / jobs)
   │  每个联系人一个持久子进程或 API 客户端
   ├─ claude --input-format stream-json --output-format stream-json [--resume]
   ├─ codex app-server (JSON-RPC over stdio, thread/resume)
   ├─ 直连 API (anthropic / openai-compat / gemini)
   └─ Memory Vault (MCP, :8900) → vault-data/ (Markdown)

PC Worker (主动出站长轮询，无入站端口)
   └─ 网关 jobs 队列 → 本机 codex exec / claude -p → 流式事件与结果回传
```

- CLI 会话通过 `--resume` 跨网关重启延续，session id 存 SQLite
- 每联系人串行队列，同一时刻只有一轮 in-flight；长会话按 token 阈值自动换新 thread + 滚动摘要
- API 直连按联系人 token 预算裁剪历史、持久化滚动摘要、成本分项估算

## 快速启动

推荐用 Compose 一次启动前端、网关和记忆库。Compose 默认锁定
`memory-vault` 的 `v0.4.1` 发布标签，不复制维护它的源码：

```bash
cp .env.example .env
docker compose -f docker-compose.example.yml up --build -d
```

打开 `http://127.0.0.1:3900`。首次启动会在仓库旁生成被 gitignore 的 `vault-data/`，
里面是可直接用 Obsidian 打开的私人 Markdown 记忆库。升级记忆系统时，显式修改
`.env` 中的 `MEMORY_VAULT_VERSION`，再运行契约测试。

源码开发：

```bash
cd server && npm install && npm run dev     # 网关 :3900
cd web && npm install && npm run dev        # 前端 :5173（代理 /api → 3900）
```

或构建后单进程：`cd web && npm run build`，网关直接 serve `web/dist`。

首次启动自动种一个 claude-cli 联系人。前提：`claude` CLI 已登录（`claude /login`）。
不想耗额度可以用 🧪 Mock 联系人（`server/scripts/mock-claude.mjs`）测管线和 UI。

## 配置

- `server/config.example.json` → 复制为 `server/config.json`（端口、CLI 路径等）
- Compose 会从独立仓库的固定标签构建 Memory Vault；源码开发时另行启动
  `memory-vault-mcp --vault <数据目录> --http --host 127.0.0.1 --port 8900`，再在
  `server/config.json` 将 `memory.mcpUrl` 指向 `http://127.0.0.1:8900/mcp`
- 联系人级配置存在 DB（UI 可改）：模型、人设、记忆三开关、委派权限等
- Agent 工作目录在 `server/agents/<联系人id>/`：`CLAUDE.md` 是人设
  （模板见 `server/agents/example/`），`mcp.json` 指向记忆库 MCP server
- 秘密只走 `.env`（gitignore）：`CLAUDE_CODE_OAUTH_TOKEN`、`VAULT_TOKEN`、`DEPLOY_TOKEN`、`DEEPSEEK_API_KEY`

### 自动记忆捕捉

`hub-auto` 只检查用户原话。时间、待办、偏好或长期约定等规则命中后，才把该条原话发送给
DeepSeek 做语义精筛，不会发送完整聊天历史或记忆库：

- `confidence >= 0.8` 且模型判定值得保留：写入 Memory Vault `inbox/`
- `confidence <= 0.2` 且模型判定不值得保留：直接丢弃
- 中间置信度、未配置密钥、超时、非 2xx、空响应或 schema 无效：以
  `llm-review-pending` 标签写入 `inbox/`，等待人工复核；聊天与 MCP 链路继续运行

在 `.env` 中配置：

```dotenv
DEEPSEEK_API_KEY=your_key_here
DEEPSEEK_CAPTURE_MODEL=deepseek-v4-flash
# 可选；默认 https://api.deepseek.com
DEEPSEEK_API_BASE_URL=
```

模型调用显式关闭 thinking。公开回归集使用合成样本，不包含私人聊天导出；可运行
`npx tsx server/scripts/smoke-capture.ts` 验证规则边界、系统回执过滤、置信度分流和失败降级。

## Memory Vault

Memory Vault 是独立主产品；AI Hub 不再内嵌或复制它的服务实现。
`docker-compose.example.yml` 通过固定 release tag 消费它，私人数据始终写入被 gitignore 的
`vault-data/`，所以首次启动产生记忆后 ai-hub 源码仓库仍保持干净。

不配置 Git 时，记忆会稳定保存在本机目录。需要多设备同步时，把 `vault-data/` 初始化或克隆成一个
**独立的私有 Git 仓库**；服务检测到 `vault-data/.git` 后，才会自动 pull、commit 和 push。
它绝不会沿父目录误用公开 ai-hub 的远端。完整安装、同步和隐私说明见
[Memory Vault 仓库](https://github.com/Irisiochan/memory-vault)。

已启动 Memory Vault 后可验证当前 MCP 契约：

```bash
npm run smoke:memory-contract --prefix server
```

## PC Worker（离线优先）

网关是权威任务队列。PC 不在线时任务保持 `pending`；上线后只认领 runner、workspace
和能力快照都匹配的任务。运行中失联变 `interrupted`，不自动重跑可能有副作用的任务。

1. 前端左上角 `🖥`，输入设备名生成一次性配对令牌
2. `worker/config.example.json` → `worker/config.json`，填令牌和允许的 workspace
3. `node worker/worker.mjs worker/config.json` 验证；Windows 登录自启用
   `worker-launcher.ps1 -Action install`（单实例、崩溃退避重拉、本地状态文件）

## 桌面与 Android

- `desktop/`：Electron 壳；默认运行本地网关，也可在 `desktop.json` 中指向已有远程 Hub。
- `mobile/`：Capacitor Android 伴侣壳；`.github/workflows/android.yml` 可生成签名 APK artifact。
- 两者都是同一套 Web UI 的消费端，不复制 Memory Vault 实现；远程模式仍应只连接受保护的私网 Hub。

## 安全模型与威胁边界

**信任边界 = 你的私有网络。** 网关目前没有账号体系，设计为跑在 Tailscale 等
overlay 网络内、绑定内网 IP；**绝对不要把 3900 直接暴露公网**。在此边界内：

- 没有账号、租户或会话级访问控制：任何能访问 Web UI 的人都可能读取聊天记录、管理联系人、
  生成 Worker 配对令牌，并在已有权限边界内发起委派。Tailnet 里有其他成员时，必须用 ACL
  只允许受信设备/用户访问 3900，不能把“加入同一 Tailnet”直接等同于可信。

- API key 服务端存储、返回 UI 永远打码；`.env` 与数据库不进 git
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

## License

MIT © Irisiochan
