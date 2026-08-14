# 系统提示词分层：全员家规与 per-contact overlay

一个联系人实际收到的 system prompt 不是一份文件，而是几层拼起来的。改错层的后果是
「想调一个人的口吻，结果全家一起变」，或者「写了半天没生效，因为被更高优先级的层压住」。
这份文档说明层的划分、优先级，以及「想改某件事该动哪一层」。

## 三层结构

| 层 | 内容 | 体量（估） | 谁能改 |
|---|---|---|---|
| ① 厂商 base | CLI 自带的 system prompt：身份、安全边界、交付与纠错规范 | ~2k token | 改不了，CLI 升级会覆盖。三家原文都已逐字存档在记忆库：Claude Code `memories/reference-claude-code-system-prompt.md`、Codex `memories/reference-codex-cli-gpt-5-6-sol-base-system-prompt.md`、Grok `memories/reference-grok-cli-grok-4-5-base-system-prompt.md`（2026-08-01 存档） |
| ② 工具定义 | 各工具的 JSON schema | ~10k token | 随版本漂移，不用来调口吻 |
| ③ 家规与注入 | 网关拼的所有中文块 + 联系人自己的文件 | ~4k token | 全在本仓库里 |

只有 ③ 是我们的。它又分两半：

### ③a 全员层——「对 User 一致」的部分

- 代码：`server/src/memory/inject.ts`（`WORKFLOW_PRELOADED`、`TEMPORAL_CONTEXT_RULES`、
  `identityGuard`、`nsfwCraftCompact`、记忆快照）与 `server/src/agents/promptComposer.ts`
  的群聊框架、对话存档回放。
- 记忆库：`memories/User-ai-interaction-styles.md`（tag「所有AI通用」）、
  `_meta/cli/global-agent-workflow.md`。
- 这一层只放**所有联系人都成立**的东西：身份边界、时间语义、记忆写入通道、NSFW 下限、
  User 的通用沟通偏好。
- **条件注入（token round2）**：`TEMPORAL_CONTEXT_RULES` 仅在有回放/历史摘要/既有消息/resume
  时注入；`nsfwCraft` 联系人开关 `always|intimate|off`（默认 `intimate`，亲密场景 fail-open
  per-turn；`always` 才进 session preamble）。

### ③b 联系人叠层 overlay——「某家 base 缺什么 / 多什么」

- 文件：`server/agents/<cwd 或联系人 id>/overlay.md`，网关在 `PromptComposer.composeStart`
  里读取，拼在整段 preamble 的最后。
- 四个后端（claude-cli / codex / grok-cli / api）走同一个机制，不依赖各家 CLI 是否会自己读
  `CLAUDE.md`、`AGENTS.md`。
- 文件不存在或全空 = 这个联系人没有叠层，一个字节都不注入。

## 优先级

> 口吻与交付形态冲突时：**联系人 overlay > 全员风格与记忆 > 全局工作流**。

这条写在网关注入的叠层抬头里，模型看得到。但**身份边界、时间语义、记忆写入通道不归叠层管**——
那三样由 ③a 的网关块决定，叠层无权放宽。

## 想改什么，动哪一层

| 想改的事 | 动的地方 |
|---|---|
| 所有 AI 对 User 的通用语气、协作偏好 | 记忆库 `User-ai-interaction-styles.md` |
| 身份隔离、时间语义、NSFW 下限、记忆预载标记 | `server/src/memory/inject.ts` |
| 某一个联系人相对它家 base 的口吻/交付差分 | 该联系人的 `overlay.md` |
| 某个 AI 的名字、关系、能力边界（有没有 Bash 等） | 该联系人的 `CLAUDE.md` / `AGENTS.md`，或 UI 里的联系人配置 |
| 委派规范、项目写权限纪律 | `server/src/agents/gatewayTools.ts` |

**禁止**用 ③a 的全员文件或网关块去对冲某一家厂商的 base prompt——那会误伤其他家。
反过来也禁止把某家专用的句子粘进 `User-ai-interaction-styles.md`：那是 append-only 的核心文件，
写进去就进了所有 AI 的会话注入。

## 预算观测

`PromptComposer.composeStart` 为每次 fresh prompt 打一条稳定的分块日志：
`workflow / temporal / room / memory / replay / overlay / total`，每块统一使用
`<chars>c/<estimated tokens>t`。启用 Worker 委派时，`withDelegation` 再记录
`delegation` 与追加后的 `total`。日志只写体量，不写 prompt 正文或凭据。

改注入预算必须用同一套 `estimateTokens`、同一条 compose 路径比较；不得用调低 history、
replay 或事实正文预算来冒充静态规则压缩。机械闸在
`server/scripts/smoke-gateway-injection-budget.ts`。

API 联系人的 rolling summary 使用 100%/80% 高低水位：触发摘要时一次压到消息数与
token 预算的 80%，后续多轮保持同一 summary/version，让 Gemini/Anthropic 能复用
`system + summary + recent history` 的相同请求前缀。不得为了碰缓存门槛恢复 full memory
或填充无意义 token；稳定性由 `smoke-prompt-cache-summary-rollover.ts` 守住。

## overlay 怎么写

只写差分，别复述 base。参考现有三份：

- `server/agents/claude/overlay.md`（Anthropic Claude Code base）：base 已经管住了如实汇报、
  少道歉、不可逆动作先确认，所以那些**不重写**；只收「终端 markdown 口吻、任务完成报告腔、
  本地 memory 目录」这些和 IM 聊天对不上的地方。
- `server/agents/codex/overlay.md`（Codex base）、`server/agents/aye/overlay.md`（Grok base）：
  这两家的 base 原文都已存档，overlay 仍然只写差分。两家的 base 都没有 Anthropic 那套 Corrections
  规范，所以两份 overlay 都要显式带**少道歉纪律**（过度道歉、为改口写长解释、「你觉得呢」这类
  防御性问句收尾，一律压掉）。Grok base 尤其小，除了少道歉之外，阿野还要显式带**要用工具就直接调**，
  压住「说要翻账本却不调工具」这个反复出现的失败模式。

三条硬约束：

1. **保持静态**。叠层是 prompt-cache 前缀的一部分，正文里不要放时间戳、会话状态或联系人名拼接。
2. **体量受控**。`scripts/smoke-prompt-layers.ts` 会断言每份 overlay < 2500 字符，
   并且不含 base 原文的大段抄录。
3. **不复述强制块**。当前联系人身份、称呼方向、时间语义与 NSFW 下限由网关通用块负责；
   overlay 只保留该宿主的差分，不再写一份同义提醒。

## 为什么是文件，不是联系人配置里的 `appendSystemPrompt`

联系人配置存在 DB 里，UI 可改、不进 git，会和 `seed.ts` 里的初始文案悄悄漂移——
阿野就漂过：seed 里早就改成了「系统含 `WORKFLOW_PRELOADED` 就别再读全局工作流」，
但生产 DB 里那条仍是旧版「新会话开始前先完整读取 `_meta/cli/global-agent-workflow.md`」，
和网关每轮注入的 `WORKFLOW_PRELOADED` 直接对着干。overlay 走仓库文件，跟着部署走，
review 得到、回滚得掉。DB 里的 `appendSystemPrompt` 保留兼容，但新的差分请写 overlay。

## 验证

```bash
npx tsx scripts/smoke-prompt-layers.ts
```

覆盖：按 `cfg.cwd` 解析目录、api 后端同样生效、缺文件/空文件不注入、叠层排在全员块与
对话存档回放之后、未配置 `agentsDir` 时整层关闭，以及仓库里三份真实 overlay 的体量与
「不重抄 base」约束。

## 不在本层解决的问题

记忆检索注入的相关性与 token 预算（话题无关的记忆被塞进来、对话存档回放体量过大）
是 ③ 注入层的**内容质量**问题，不是分层问题，见需求账本
`tasks/ai-hub-prompt-layers-house-rules-overlay.md` 第 6–10 条与
`tasks/ai-hub-vault-search-relevance-ranking.md`。
