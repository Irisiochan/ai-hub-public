# 图片上传与识图边界

四种后端（`api`、`codex`、`claude-cli`、`grok-cli`）都能收图，但四条管线各走各的协议：API 直连自己把图编成 base64 content part，三个 CLI 只拿到网关本机的图片路径，由 CLI 自己读盘、自己发给它背后的供应商。

## 使用范围

- 上传口径全后端一致：JPEG、PNG、WebP、GIF；每条最多 4 张，单张最多 10 MB。前端 `web/src/components/ImageComposer.tsx` 与网关的 multer 限流 + `persistImage()`（`server/src/attachments.ts`）各校验一遍，网关那遍还查文件签名。
- 私聊：`api`、`codex`、`claude-cli`、`grok-cli` 联系人都可以选图、粘贴截图、预览、移除和发送（`web/src/components/ChatPane.tsx:181`）。
- 群聊：有文字时沿用 `@名字` / `@all` 目标解析；无文字时投递给群内全部启用成员（`AgentManager.imageRoomMembers()` 现在就是 `roomMembers()`，不再按后端筛选），正文落库为「请看这张图片。」。群回合把本轮批到的未读消息的附件一起带上。
- 三条 CLI 管线的共同前提：传的都是绝对路径。`attachmentPathsForMessages()` 只认 `uploadsDir` 直属且仍存在的文件，所以 CLI 必须与网关同机运行并能读 `server/data/uploads`；跨机部署时 CLI 联系人拿不到图。
- 历史行为不同：API 直连每轮都会把历史消息里的图重新编进 content（`contentForRow()`）；三个 CLI 只拿本轮消息的附件路径，之前发过的图不会重复投喂。

### API 直连（`api`）

- 网关自己读文件并编 base64，按供应商序列化：openai-compat 用 `image_url` data URL，Anthropic 用 base64 image source，Gemini 用 `inlineData`。
- 是否发图还受 `visionModel` / `supportsImages` 约束，详见下方「隐私边界」。

### Claude CLI（`claude-cli`）——文本路径清单 + Read 工具单点授权

- `claudeTurnText()`（`server/src/agents/claudeCli.ts:25`）在正文后追加 `<本轮图片附件>` 路径清单，并要求模型先用 Read 工具逐张读，读失败要明说错误、不许照文字猜图。
- 后端以 `--permission-prompt-tool stdio` 接管审批：`claudePermissionDecision()`（同文件 37 行）只放行 `tool_name === 'Read'` 且 `path.resolve(file_path)` 命中本轮附件集合的请求，其余一律 deny，deny 文案会作为失败的工具气泡出现在聊天里。聊天型联系人本来没有任何工具权限，这条放行就是图片能被读到的唯一通道。
- `allowedImagePaths` 每轮在 `sendTurn()`（195 行）重建、`finishTurn()` 清空，所以上一轮的图不能在后续回合被翻出来读。
- 代价：每张图多一次工具往返。格式上限取决于 Claude Code 的 Read 工具支持哪些图片类型，网关这边只会存 JPEG/PNG/WebP/GIF。

### Codex（`codex`）——app-server 原生 localImage

- `codexTurnInput()`（`server/src/agents/codexAppServer.ts:81`）把每张图拼成 `{ type: 'localImage', path }`，与 text part 一起放进 `turn/start` 的 input。
- 没有工具审批环节，也没有额外提示词，Codex 自己按路径读盘。这条管线自己不做格式判断，网关的上传校验是唯一一道闸。

### Grok CLI（`grok-cli`）——ACP resource_link

- 含图回合改用 `--prompt-json`，payload 是 `{ type: 'acp', content: [text, resource_link…] }`，每个 link 带 `file://` URI、basename 和 mimeType（`server/src/agents/grokCli.ts:63`）；纯文字回合仍走 `-p`。
- 刻意不用 base64 argv：一张普通截图就能超出 Windows 命令行长度上限和 Linux 的 `MAX_ARG_STRLEN`。
- `imageMimeType()`（同文件 49 行）按扩展名白名单取 MIME，只认 `.jpg`/`.jpeg`/`.png`/`.webp`/`.gif`，其余直接抛错——这轮不会 spawn 进程，聊天里出现「grok 图片读取失败：…」的非致命错误。白名单与上传白名单同宽，且落盘文件名的扩展名是按校验过的 MIME 生成的，所以正常上传的图不会撞上这条；它只兜住 uploads 目录里来路不明的文件。

## 存储与访问

- 文件使用随机 UUID 文件名保存在 `server/data/uploads`（可通过 `uploadsDir` 配置），原文件名只作为展示元数据。
- 图片不作为静态目录公开。读取端点会校验附件仍属于未删除消息和已启用联系人，并返回 `nosniff`。
- 附件跟随消息生命周期：删除消息时立即删除文件和附件记录；网关启动时清理没有数据库引用的孤儿文件。当前不另设按天过期，避免历史消息静默缺图。

## 隐私边界

- 网关不主动读取或移除 EXIF。图片会原样发送给目标 API 供应商，因此发送前应确认其中没有不希望外传的位置、订单、密钥、cookie 或个人信息。
- 服务端同时校验 MIME 白名单和文件签名，但不把上传文件当作可信内容执行。
- OpenAI-compatible 使用 `image_url` data URL；Anthropic 使用 base64 image source。供应商或具体模型不支持视觉时，错误会原样回到聊天界面。
- API 联系人可以设置独立的 `visionModel`。含图回合使用图片模型，纯文字回合继续使用原模型，避免为日常聊天强行更换人设模型。
- 纯文字模型（如 openai-compat 下的 deepseek）只接受 `text` content part，收到 `image_url` 会 HTTP 400。联系人配置的 `supportsImages` 控制是否发图：`true`/`false` 为显式覆盖，留空时按 `provider + model` 名自动推断（`defaultSupportsImages`，deepseek 等已知纯文字家族返回 `false`）。判定为不支持且未配 `visionModel` 时，含图历史/新图会被降级成 `[图片已省略，该模型不支持图片]` 文字占位——只影响该成员这一趟请求，不外发 base64/url，也不拖累群里支持图片的其他成员。
