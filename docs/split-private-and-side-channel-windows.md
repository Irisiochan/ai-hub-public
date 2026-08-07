# ai-hub 私聊「主窗口 / 副窗口」分离方案

状态：方案稿（未实施，未改任何产品代码）
日期：2026-07-27
来源：User 的需求 —— 私聊窗口里人类对话被自动流量淹没

> 落位说明：本文原计划写进 memory vault 的需求账本（`add_task`，slug
> `ai-hub-split-private-and-side-channel-windows`，tags 含 `backlog`）。本次执行环境是
> 非交互式 worker job，memory_vault MCP 的 `add_task` / `search_vault` / `get_task_context`
> 全部返回「未授权」而无法完成 OAuth/授权流程，因此按任务书的退路条款改写成本文件。
> 后续如果要把它搬回 vault，正文可以整段复制，本文是自包含的。

---

## 0. 问题一句话

`POST /api/contacts/:id/messages` 是**唯一**的消息入口，User 的输入框和 triage worker
用的是同一个它，写出来的行也**逐字段全等**（`sender='user', role='user', kind='text'`）。
所以现在无论前端还是后端，都没有任何字段可以回答「这条是人说的还是机器说的」。

---

## 1. 现状梳理（读过的代码）

### 1.1 消息表与可用字段

`server/migrations/0001_init.sql:14-26` 建表，`server/src/db.ts:24-36` 定义类型：

```
messages(id, contact_id, sender, role, kind, content, status, turn_id, meta, created_at, deleted)
role: 'user' | 'assistant' | 'system'
kind: 'text' | 'thinking' | 'tool_use' | 'error'
```

后续 migration 到 `server/migrations/0014_usage_daily.sql`（下一个序号 `0015_`；
`server/src/migrations.ts:13-26` 强制文件序号连续，跳号直接抛错）。

### 1.2 全部 6 个 INSERT 点

| # | 位置 | sender / role | 谁在调 |
|---|---|---|---|
| 1 | `server/src/routes/messages.ts:312-317` | `user` / `user` | **User 的输入框 和 triage worker 共用** |
| 2 | `server/src/routes/messages.ts:186-189` | `room-host` / `user` | 群主持（`/room-host/messages`） |
| 3 | `server/src/server.ts:99` | `system` / `user` | Worker 任务回执，meta `{event:'worker-receipt', jobId}` |
| 4 | `server/src/routes/contacts.ts:198` | `system` / `system` | 切模型，meta `{event:'model-switch'}` |
| 5 | `server/src/routes/contacts.ts:261` | `system` / `system` | 切推理强度，meta `{event:'effort-switch'}` |
| 6 | `server/src/agents/messageRepo.ts:35`（`MessageRepo.insert`） | `<agent.id>` / `assistant`\|`system` | AI 的全部产物 |

第 6 项由 `server/src/agents/runtime.ts:200` 统一落 `sender = this.agent.id`，覆盖：
- assistant text `runtime.ts:534` / `runtime.ts:606`
- assistant thinking `runtime.ts:551`
- assistant tool_use（前端的 🔧 chip）`runtime.ts:566-573`
- system error `runtime.ts:428` / `runtime.ts:465` / `runtime.ts:656`

### 1.3 自动流量是怎么进来的

**triage / quarter-hour-check**：
`worker/triage-worker.mjs:617` 调 `this.hub.dispatch(route.contact.id, dispatchPrompt(...))`，
`worker/triage-clients.mjs:298-304` 的 `HubClient.dispatch` 就是普通的
`POST /api/contacts/:id/messages`，body 只有 `{content}`。

正文模板在 `worker/triage-worker.mjs:86-110`：
- task/system 池 → 以 `'⚡ AI Hub 自主事件分派'` 开头，带 `来源/分类/优先级/判断` 和最多
  16000 字的 `event.summary`；
- **daily 池（主动陪伴）→ 第 88-97 行，故意不带任何标记**，正文是「请现在直接用你自己的
  自然语气对 User 说一条简短消息……不要提及 triage、路由、系统事件」。

事件源在 `worker/triage.config.example.json` 的 `sources`：`quarter-hour-check`（timer，
15 分钟）、`daily-check-in`（timer，daily 池）、`daily-idea-room`、`vault-backlog`、
`project-watch`、`example-feed`。

**Worker 派单回执**：`server/src/server.ts:88-107`。任务结束后写一条
`sender='system', role='user'` 的长消息（回执正文 6000 字 + 一大段验收指令），
然后 `server.ts:101` 直接 `manager.get(contact).enqueue(...)` 触发 AI 回一轮。

**鉴权层帮不上忙**：`server/src/middleware/auth.ts:13-32` 只有一个共享 hub token
（cookie 或 query），服务端无法从鉴权区分「是 User 还是 worker」。所以分类信息**只能由
调用方显式声明**。

### 1.4 前端渲染

- `web/src/App.tsx:14` 每个联系人一个扁平 `Message[]`，`App.tsx:29-49` 的 `upsertMessage`
  按 id 插入排序，没有任何分流。
- `web/src/components/chat/MessageList.tsx:60-93` 单一时间线，全量渲染，无过滤。
- `web/src/components/MessageBubble.tsx:42`：`const mine = message.sender === 'user'`
  —— 于是 triage 派单被渲染成 **User 自己的气泡**，背景色 `user.color`，默认 `#e94560`
  （`App.tsx:18`）。这就是她说的「红色横幅」：那不是系统消息样式，那是她自己的红色气泡。
- 工具 chip：`MessageBubble.tsx:69-85`（`kind === 'tool_use'`），
  错误条：`MessageBubble.tsx:87-101`，想法折叠：`MessageBubble.tsx:103-128`。
- 未读：`App.tsx:46-48` 只在「非当前会话 且 `sender !== 'user'`」时 +1，
  `App.tsx:147` 选中即清零；红点在 `web/src/components/ContactList.tsx:71`。
  → 注意：triage 派单因为 `sender === 'user'`，**现在根本不算未读**，但它引发的 AI 回复算。
- 分页：`GET /:id/messages` 支持 `before` / `after` / `limit`
  （`server/src/routes/messages.ts:81-114`），前端 `App.tsx:59-68` 用 `before` 往回翻。
- SSE：`server/src/sse.ts:46-59`，`message` 事件全量广播，只有 `delta` 按联系人订阅过滤。
- 响应体形状：`server/src/attachments.ts:87-105` 直接 `{...row}` 展开 —— **消息表新增列会
  自动出现在 API 响应和 SSE 里，路由零改动。**

### 1.5 Android 客户端

`mobile/` 是 Capacitor 壳，`mobile/capacitor.config.json` 的 `webDir: "www"`，
`mobile/www/assets/` 与 `mobile/android/app/src/main/assets/public/assets/` 是同一份
`web/dist` 产物（文件名都是 `index-DcsMHRr5.js`）。**没有独立的 UI 代码**，
前端改一次两端都覆盖，只需 `cd mobile && npm run sync` 重新打包。

唯一需要单独考虑的是本地通知：`web/src/mobileShell.ts:102-129` 的 `notifyIncoming`，
当前条件是 `role === 'assistant' && kind === 'text' && status === 'done'`，
**不区分这条回复是回给谁的**。也就是说每 15 分钟的 quarter-hour-check 只要 AI 说了话，
手机就会响一次。

### 1.6 AI 上下文注入路径

两条，谓词不同：

**CLI 后端（claude-cli / codex / grok-cli）**
底层是常驻子进程会话（`runtime.ts:242-254` `ensureStarted` + `sessions` 表），
网关平时**不逐条重放历史**——历史就活在那个进程里。只有会话被重置（编辑/删除消息，
`runtime.ts:262-298`）时，才用 `promptComposer.ts:137-162` 的 `bridge()` 回放存档，
数据来自 `MessageRepo.recentText`（`messageRepo.ts:42-46`）：

```sql
WHERE contact_id = ? AND kind = 'text' AND status = 'done' AND deleted = 0
```

—— **不筛 sender / role**，triage 派单和 worker 回执原文全量进回放。

**API 后端（directApi）**
`server/src/agents/directApi/base.ts:395-500` 的 `history()` 每轮从 DB 重建，
数据来自 `MessageRepo.historyAfter`（`messageRepo.ts:54-59`）：

```sql
WHERE contact_id = ? AND kind='text' AND status='done' AND deleted=0
  AND role IN ('user','assistant') AND id > ?
```

滚动摘要 `ConversationSummaryRepo.rowsThrough`（`conversationSummaryRepo.ts:13-18`）
用同一套谓词。结论：
- triage 派单（`role='user'`）**进** history 和摘要；
- worker 回执（`role='user'`）**进**；
- 切模型/切强度（`role='system'`）**不进**；
- tool_use / thinking（`kind != 'text'`）**不进**。

**已存在的语义污染（顺带发现）**：`server/src/agents/conversationSummary.ts:25-33`
的 `summaryLine` 在 DM 下把所有 `role !== 'assistant'` 的行标成「User：」。
也就是说**滚动摘要现在正把 triage 的机器指令和 worker 回执记成 User 说的话**。
这个 bug 和本需求同源，应该在同一批修掉。

---

## 2. 数据模型设计

### 2.1 新字段

```sql
ALTER TABLE messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'main';
CREATE INDEX idx_messages_contact_origin ON messages(contact_id, origin, id);
```

枚举（两值，故意不铺开）：

| 值 | 含义 |
|---|---|
| `main` | User 手打的消息 + AI 针对它们产生的一切（text / thinking / tool_use / error） |
| `side` | 一切非 user 发起的：triage 派单、worker 回执、切模型/强度、定时检查、自动测试，及其 AI 回复与工具 chip |

**为什么不加第三个 `system` 档**（把切模型这种会话事件单独放）：现在总共只有 5 条这类
消息模板，副窗里多几条灰条不构成问题；等真出现「副窗也太吵」的时候再拆，枚举加值比减值容易。
—— 这条留在开放问题里给 User 拍。

**为什么不复用 `role` / `sender`**：`role` 已经被 prompt 层当成「谁在说话」用
（`directApi/openai.ts:39`、`conversationSummary.ts:25-33`），`sender` 被前端当成
「是不是我」用（`MessageBubble.tsx:42`）。这两维都已经过载，加一个正交的第三维最省。

### 2.2 写入点

| INSERT 点 | 写什么 |
|---|---|
| `messages.ts:312`（`POST /messages`） | 读 body 里可选的 `origin`，白名单校验，缺省 `main` |
| `messages.ts:186`（room-host） | 群聊不在本期范围 → 写 `main`（见开放问题 3） |
| `server.ts:99`（worker 回执） | 硬编码 `side` |
| `contacts.ts:198` / `:261`（切模型/强度） | 硬编码 `side` |
| `messageRepo.ts:35`（`MessageRepo.insert`） | 新增 `origin` 入参 |

配套改 `worker/triage-clients.mjs:298-304`，`dispatch()` 的 body 加 `origin: 'side'`。

### 2.3 AI 回复怎么继承 origin（关键）

`runtime.ts:36-39` 的 `QueueItem` 在 `dm` 分支已经带 `userMessageId`。
**推荐做法**：`AgentRuntime.enqueue`（`runtime.ts:129`）内部按 `userMessageId` 回查那条
消息的 origin，存进 QueueItem，本轮所有 `insertMessage` 都用它。

理由：`enqueue` 有三个调用方（`messages.ts:336`、`server.ts:101`、
`runtime.ts:306` 的 `regenerateFrom`），让每个入口自己传 origin 迟早会漏一个；
按 userMessageId 回查只有一个真相源。`room-turn` 分支恒 `main`。

### 2.4 视图层过滤 vs 存储层落库 —— 必须落存储层

1. **视图层根本区分不出来。** triage 派单和 User 手打在 DB 里逐字段全等，唯一差别是
   正文前缀。而 daily 池的正文（`triage-worker.mjs:88-97`）**刻意不带任何标记**，
   靠前缀分类对这一类永远失效。
2. **AI 回复必须能继承分类。** 一条 assistant 消息没有任何字段指回触发它的 user 消息：
   `turn_id` 只在同一轮的 assistant 产物之间共享（`runtime.ts:539/556/571/611`），
   不包含触发方。不落库就得在前端做「看上一条是谁」的启发式，一遇到分页、
   「加载更早」、并发轮次就崩。
3. **上下文注入要按 origin 做取舍**（见第 5 节），SQL 谓词必须用得上它。

代价：一次 migration + 6 个写入点 + worker 一行。收益是三层（存储 / API / 前端 / prompt）
共用一个真相。取舍是明确的。

---

## 3. 后端改动

### 3.1 Migration `0015_message_origin.sql`

加列 + 索引 + 回填（回填规则见第 6 节）。

**注意 0014 的触发器**：`0014_usage_daily.sql` 上挂了
`BEFORE/AFTER UPDATE OF meta, status, deleted ON messages`，会在 UPDATE 这三列时逐行
拆装 `message_usage` / `usage_daily`。所以回填**只能写新列 `origin`，绝对不要写 `meta`**
——写新列不在触发器的 `OF` 列表里，一次都不会触发。这也是选独立列而不是往 meta JSON 里
塞字段的一条硬理由。

### 3.2 路由

`GET /:id/messages`（`messages.ts:81-114`）加一个 query：

```
?origin=main | side | all     默认 main
```

三条分页 SQL（`after` / `before` / 默认）都要带上谓词。默认值取 `main` 意味着老客户端
拿到的时间线会突然变干净——这里恰恰**就是要**这个突变，副窗显式传 `side`。

`POST /:id/messages` 接受可选 `origin`，白名单外的值 400。

### 3.3 SSE

不用改。`sse.broadcast('message', withAttachments(db, row))`（`messages.ts:192` 等）
的 payload 是 `{...row}` 展开（`attachments.ts:88`），新列自动带上。
前端拿到 `msg.origin` 自己决定塞哪个桶。

### 3.4 未读计数：分开算，且都放前端

**分开算。** 主窗未读和副窗未读合并计数，等于把机器噪音重新灌回联系人列表，
那正是要治的病。

- 主窗未读 = 未选中该会话时收到的、`origin === 'main'` 且 `sender !== 'user'` 的消息数
  → 显示在 `ContactList` 的现有红点上。
- 副窗未读 = 收到的 `origin === 'side'` 的消息数（**不筛 sender**，因为副窗里的
  `sender === 'user'` 就是机器）→ 显示在会话内的副窗入口按钮上。

**都放前端内存**，沿用现有 `App.tsx:46-48` 的机制，只是拆成两个桶。
不做服务端持久化未读：现在的未读本来就是内存态（刷新即清零），
「跨设备已读同步」是另一个独立需求，别混进这一单里做。

---

## 4. 前端改动

### 4.1 形态：同一个 ChatPane 内切换，不另开路由

`ChatPane` 增加 `channel: 'main' | 'side'` 状态。理由是 `MessageList` / `MessageBubble` /
滚动粘底（`ChatPane.tsx:149-167`）/ 批量删除（`ChatPane.tsx:218-257`）/ 外链查看器
全部可以直接复用，改动面最小。副窗顶部换一条明显的标题栏 +「← 回主窗」。

### 4.2 入口按钮

放在 `ChatHeader`（`web/src/components/chat/ChatHeader.tsx`）标题右侧，
形如 `🛰 后台`，有未读时挂数字角标，无未读时不显示数字。
`ChatHeader` 目前已经挤了（返回 / 批量 / 模型切换 / 配额 / 设置），手机窄屏下建议
只显示图标 + 角标。

### 4.3 副窗的信息层级

副窗的用途是「扫一眼有没有出事」，不是逐条精读。所以：

- 默认折叠 thinking 和 tool_use chip，收成一行「🔧 本轮 4 次工具调用」，点开才展开明细；
- side 里的 `sender === 'user'` 行**不能再用 User 的红色气泡**——改成居中的系统横幅
  样式（灰底 + 来源标签，如「网关 · quarter-hour-check · backlog P2」），正文默认
  截断 + 「展开原文」。这顺带修掉「红色横幅」的观感问题。
  → 具体改 `MessageBubble.tsx:42` 的 `mine` 判定：`mine = sender === 'user' && origin === 'main'`。
- **副窗禁用 Composer**。在副窗打字如果落回主窗会话，会造出第二条输入路径，
  session 上下文会被搅乱。想说话就回主窗说。

### 4.4 App.tsx 的状态结构

**推荐：仍然单桶 `Record<contactId, Message[]>`，渲染时 filter。**
不推荐按 origin 分桶存，因为 SSE 的 `delta`（`App.tsx:98-107`）、`prune`
（`App.tsx:110-120`）、`appendMessageDelta`（`messageMerge.ts:52-54`）全是按 message id
操作的，分桶会让每个操作都要查两个桶。

但**分页游标必须分开**：`loadEarlier`（`App.tsx:59-68`）用 `list[0].id` 做 `before`，
两个窗各自的「最早一条」不同，要各维护一个游标，并各自带上 `origin` 参数请求。

### 4.5 Android 影响面

前端改完 `cd mobile && npm run sync` 重打包即可，**没有独立 Android UI 代码要动**。

唯一必须单独改的是 `web/src/mobileShell.ts:111` 的 `notifyIncoming`：
加一个 `msg.origin === 'main'` 条件。不改的话拆窗只是眼不见，手机照样每 15 分钟被
quarter-hour-check 叫醒。**这条的体感收益比 UI 还大，值得优先做。**

---

## 5. AI 上下文注入的影响（重点）

### 推荐方案：上下文不拆，只拆视图 + 把 side 行压成摘要行

也就是：**副窗消息仍然进主窗会话的 prompt，但作为「压缩事件行」进，不是原文。**

### 为什么不能真的拆掉

1. **CLI 后端物理上做不到。** claude-cli / codex / grok-cli 的历史活在常驻子进程里
   （`runtime.ts:242-254`），triage 触发的那一轮和 User 手打的那一轮跑在**同一个
   session**。网关没有能力把已经发生过的一轮从进程上下文里择出去，除非每次切 origin
   就重置会话——那代价（丢缓存、丢连续性、每次重新回放）完全不可接受。
2. **拆了就丢事实。** API 后端确实能在 `historyAfter` 上加 origin 过滤，但过滤掉之后，
   User 在主窗问「刚才那单 triage 怎么样了」，AI 会失忆。需求里明确点名不许发生。

### 为什么也不能原样全留

triage 派单原文最多 16000 字（`triage-worker.mjs:106`），worker 回执 6000 字 + 一大段
验收指令（`server.ts:93-97`）。默认 `historyTokenBudget` 是 8000
（`runtime.ts:272`）——**一条 triage 事件就能把整个原文窗口挤爆**，真正的人类对话被
`chooseKeepFrom`（`historyPolicy.ts:8-26`）挤进摘要甚至淘汰掉。这也是「人类对话被淹没」
在 prompt 层的同构表现。

### 具体做法

1. `MessageRepo.historyAfter`（`messageRepo.ts:54-59`）和
   `ConversationSummaryRepo.rowsThrough`（`conversationSummaryRepo.ts:13-18`）
   的谓词**不加 origin 过滤**——连续性保住。
2. 在序列化层做折叠：`directApi/base.ts:438-450` 的 `serializedRowText`，
   若 `row.origin === 'side'`，正文替换成一行摘要，例如
   `[后台事件 07-27 15:16] 自主事件分派 · 来源 quarter-hour-check · 分类 backlog · P2`；
   side 的 assistant 回复截断到 ~200 字。原文只在副窗 UI 里看得到。
3. CLI 侧的 `bridge()`（`promptComposer.ts:137-162`）走同一套折叠，
   并在回放说明里加一句「标 `[后台事件]` 的行不是 User 说的话」。
4. **触发那一轮本身不折叠**——AI 要拿全文才能干活。折叠只发生在「这条已经变成历史」之后。
5. 顺手修 `conversationSummary.ts:25-33`：side 行的说话人标「网关」，不要再标「User」。

### 效果

主窗里 AI 仍然知道「刚处理过一单 quarter-hour-check backlog P2」，
但它在预算里只占一行；User 追问细节时 AI 可以说「具体正文在后台窗口」，
或者真需要时用工具去查。

---

## 6. 历史消息回填

### 能靠现有字段推断的

| 规则 | 判定为 | 可靠度 |
|---|---|---|
| `sender = 'system'` | `side` | 100%（只有 `server.ts:99`、`contacts.ts:198/261` 会写） |
| `json_extract(meta,'$.event') IN ('worker-receipt','model-switch','effort-switch')` | `side` | 100%，作为冗余校验 |
| `sender='user' AND content LIKE '⚡ AI Hub 自主事件分派%'` | `side` | 高（前缀硬编码在 `triage-worker.mjs:100`） |
| assistant / system 行 = 它之前最近一条 `role='user'` 行的 origin（同 contact，按 id 序） | 继承 | 正常时序下正确 |

最后一条可以在 migration 里用一条相关子查询写完。并发或重新生成的边界上可能判错，
但判错的后果只是气泡进错窗，不丢数据、可人工纠正。

### 推断不了的硬缺口

**daily 池的主动陪伴消息**（`triage-worker.mjs:86-98` 的 daily 分支）。
它的正文是纯自然语言指令，**故意不带任何标记**，和 User 手打的一句话在 DB 里
完全无法区分。没有任何字段能救。

三个处理选项（**需要 User 拍板**）：

- **(a) 全部留在 `main`** —— 也就是 `DEFAULT 'main'` 的自然结果。旧的脏数据留在主窗，
  只保证从上线那天起干净。
  **我推荐这个**：回填规则错杀 User 的真实消息，比留几条历史噪音糟糕得多，
  而且是不可逆的（她看不出来哪条被误判进了副窗）。
- **(b) 跨机时间戳对账** —— triage 的 `TriageStore.recordDelivery`
  （`triage-worker.mjs:619-625`）记了 `recipientId` + 时间戳，落在
  `triage.config.json` 的 `stateFile`（`data/triage.db`）。写一个离线脚本按
  delivery 时刻 ±N 秒匹配 user 消息。准确度最高，但那个 DB 在 VPS 上，要跨机器取数，
  且要单独一轮验证。
- **(c) UI 提供「把这条移到副窗」的手动动作**，让 User 自己清历史。

（a）和（c）可以叠加：默认保守，给她一个手动纠偏的口子。

---

## 7. 分阶段实施 + 验收标准

### Phase 1 — 数据分类落地（UI 行为完全不变）

做：
- migration `0015_message_origin.sql`：加列 + 索引 + 保守回填（system sender / meta.event /
  `⚡` 前缀 / assistant 继承）。
- `MessageRepo.insert` 加 `origin` 参数；6 个 INSERT 点写值。
- `runtime.ts` 的 `enqueue` 按 `userMessageId` 回查 origin 并写进 QueueItem，
  本轮 text / thinking / tool_use / error 全部继承。
- `worker/triage-clients.mjs` 的 `dispatch()` 带 `origin: 'side'`。

验收：
- 触发一次真实 triage 派单 + User 手打一条，查 DB：两条本身、它们的 assistant 回复、
  以及 tool_use chip 的 `origin` 分别是 `side` / `main`。
- 跑一次 worker 派单，回执行及其 AI 回复 `origin='side'`。
- `server/scripts/` 下的 smoke 全绿，重点：`smoke-architecture-hygiene.ts`、
  `smoke-migrations-usage.ts`（确认 0015 没扰动 0014 的 usage 触发器）、
  `smoke-history-cache.ts`、`smoke-server-foundation.ts`。
- UI 此时**看不出任何变化**——这是本阶段的验收条件之一，说明改动是可回退的。

### Phase 2 — 主窗过滤 + 副窗

做：
- `GET /:id/messages` 加 `origin` 参数（默认 `main`）。
- `ChatPane` 加 channel 切换；`ChatHeader` 加入口按钮 + 角标；
  `MessageBubble` 的 `mine` 判定改成 `sender==='user' && origin==='main'`，
  side 的 user 行改系统横幅样式；副窗禁用 Composer；副窗默认折叠 thinking / tool chip。
- `App.tsx` 未读拆两桶；两个窗各自的 `before` 分页游标。

验收：
- 一屏主窗只剩 User 和 AI 的对话，一条自动流量都没有。
- 触发一次 quarter-hour-check：主窗完全无变化，副窗按钮出现 `1`，
  联系人列表红点不动。
- 点进副窗看得到派单原文、AI 回复、工具 chip；返回主窗后副窗角标清零。
- 「加载更早」在两个窗里各自正确往回翻，不互相污染。
- `cd mobile && npm run sync` 后 Android 端表现一致。

### Phase 3 — 通知与上下文折叠

做：
- `mobileShell.ts:111` 的 `notifyIncoming` 加 `origin === 'main'` 条件。
- `directApi/base.ts` 的 `serializedRowText` 和 `promptComposer.ts` 的 `bridge()`
  对 side 行折叠。
- `conversationSummary.ts:25-33` 的 side 行说话人改「网关」。

验收：
- 手机后台放着，触发一次 quarter-hour-check：不弹通知；User 手打后 AI 回复：弹通知。
- 造一条 16k 字的 triage 事件，确认它在下一轮 prompt 的历史里只占一行
  （看 `history cache` 日志 / `smoke-token-efficiency.ts`）。
- 同一轮问 AI「刚才处理了什么后台事件」，它答得出来源和分类 —— 上下文没断。
- `smoke-token-efficiency.ts`、`smoke-history-cache.ts`、`smoke-history-time-anchors.ts`
  不退化。

### Phase 4（可选，等前三期跑稳）

手动改归属的 UI 动作、副窗保留期与自动清理、群聊是否也分窗。

---

## 8. 风险与开放问题（需要 User 拍板）

1. **daily 主动陪伴消息归哪边？**
   它语义上是「AI 自己找 User 说话」，不是后台噪音。进副窗 → 主动陪伴变成没人看的日志；
   进主窗 → 它确实不是 User 发起的。
   **我的倾向：daily 归 `main`，只有 task/system 池归 `side`。**
   实现上就是 `triage-worker.mjs` 的 `dispatch` 按 `isDaily` 传不同 origin。这条必须她定。

2. **历史回填选哪条路？**（第 6 节的 a / b / c）我推荐 a，可叠加 c。

3. **群聊（`kind='room'`）要不要也分窗？**
   `room-host` 消息和成员发言混在一起是同构问题，但群本身就是「自动流量的展示场」，
   拆了可能反而没意义。本方案默认**不拆群**（room 一律 `main`）。

4. **副窗未读要不要冒到联系人列表？**
   本方案默认**不冒**（冒了等于没拆）。代价是 User 不进会话就不知道后台出事了。
   折中方案：联系人列表上加一个不带数字的小灰点。

5. **side 行在 prompt 历史里保留多少条 / 折叠到多长？**
   直接影响 token 预算和「AI 还记不记得刚才那单」。需要一个数字：
   比如只保留最近 5 条 side 摘要行，更早的直接从历史掉出。

6. **副窗要不要能回复？** 我倾向不能（会造出第二条对话线，搅乱同一个 session）。

7. **`origin` 两值还是三值？**（是否把切模型/切强度这类会话事件单独放一档 `system`）
   我倾向先两值。

8. **默认值的污染风险**：因为鉴权层是单一共享 token（`middleware/auth.ts`），
   服务端无法自己判断来源，`origin` 只能由调用方声明。将来任何第三方脚本直接
   `POST /messages` 而不带 `origin`，都会默认落进 `main` 污染主窗。
   缓解成本最低的做法是：接受默认 `main`，在 `README.md` 和 `worker/README.md` 里
   把这条约定写死。更硬的做法是给自动化单开一个 `/api/contacts/:id/side-messages`
   端点——但那会多一份几乎重复的路由代码。

9. **顺带发现的既有 bug（建议同批修）**：`conversationSummary.ts:25-33` 目前把所有
   非 assistant 行在 DM 下标成「User：」，也就是滚动摘要**正在把 triage 机器指令和
   worker 回执记成 User 说的话**。这会实打实地污染 AI 对 User 的认知。
   它和本需求同源，Phase 3 一起修。
