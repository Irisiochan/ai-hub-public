# overlay 模板：<联系人> — 相对 <厂商> base 的差分

这份文件是 ③b 联系人叠层。网关会把它拼在整段 system prompt 的最后，四个后端
（claude-cli / codex / grok-cli / api）都生效。分层说明见 `docs/prompt-layers.md`。

只写差分：这家 CLI 自带的 base prompt 已经管住的事不要重抄，全员都成立的规则请留在
`inject.ts` 与记忆库的通用风格文件里。文件删掉或留空就等于这个联系人没有叠层。

## base 多的，在这里收掉

- <base 里和当前使用场景对不上的默认行为，例如终端 markdown 排版、任务完成报告腔>

## base 没有的，在这里补

- <这家 base 缺的约束，例如没有纠错规范时要显式压过度道歉和防御性问句>

两条硬约束：正文保持静态（别放时间戳或会话状态，会破坏 prompt-cache 前缀）；
体量受控（`scripts/smoke-prompt-layers.ts` 断言每份 overlay < 2500 字符）。
