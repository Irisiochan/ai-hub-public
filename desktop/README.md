# ai-hub desktop（Electron 壳）

把现有网关 + Web UI 打成 Windows 桌面 App。Web/VPS 部署完全不受影响——桌面壳只是
用环境变量（`HUB_PORT/HUB_HOST/HUB_TOKEN/HUB_MCP_TOKEN/HUB_DATA_DIR/HUB_WEB_DIST/HUB_CONFIG`）
把同一个 server 跑在 127.0.0.1 随机端口上，带每次启动随机的会话令牌。

## 两种模式

- **本地模式**（默认）：壳自己起网关，数据独立在 `%APPDATA%/ai-hub/data/`。
- **远程模式**：`%APPDATA%/ai-hub/desktop.json` 写
  `{"remoteUrl": "http://<hub-tailnet-ip>:3900"}`，壳不起本地网关，直接套现有
  hub（如 VPS 实例），与网页端共享同一份数据。删掉该文件回到本地模式。

## 数据位置

- 数据库/上传/备份/agents 工作目录：`%APPDATA%/ai-hub/data/`
- 网关日志：`%APPDATA%/ai-hub/logs/gateway.log`
- 可选配置：`%APPDATA%/ai-hub/config.json`（与 server/config.json 同格式，
  memory.mcpUrl 等都在这里配）

卸载不会删除以上目录。

## 开发

```powershell
npm run build            # 仓库根：先出 web/dist + server/dist
cd desktop
npm install              # postinstall 会把 better-sqlite3 重建为 Electron ABI
npm run dev              # staging + electron .
```

## 打包

```powershell
npm run dist             # release/ 下出 NSIS 安装包 + 便携版
```

## 安全模型

- BrowserWindow：contextIsolation + sandbox，无 nodeIntegration，无 preload。
- 网关绑定 127.0.0.1 + 随机端口；所有请求需要会话令牌
  （首次加载 `?token=` 换 httpOnly cookie），未授权网页拿不到本地接口。
- 精确的 `/api/worker/*` 设备端点维持自己的 Worker Bearer 鉴权；复数
  `/api/workers` 管理端点仍受桌面会话保护。
- `/api/hub-mcp/*` 使用每次启动独立生成的 `HUB_MCP_TOKEN`；它与浏览器会话
  `HUB_TOKEN` 不同。Claude/Codex/Grok Build 只通过环境变量引用它，令牌不会写进
  MCP 配置文件；Grok 的项目配置同时通过 `HUB_PORT` 跟随桌面随机端口。
