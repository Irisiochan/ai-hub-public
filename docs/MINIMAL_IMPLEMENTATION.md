# 最小实现

本次以 2026-09-05 的 [产品宪章](CHARTER.md)、[架构](ARCHITECTURE.md) 和 Vault 既有
单一任务账本、Worker SSE 收敛需求为依据。联系人身份、永续对话、共享记忆、主动消息、
工作台派工和验收保留；减少维护同一种规则的地方，不另建平台或状态库。

## 实现边界

| 责任 | 唯一实现 | 移除的重复 |
|---|---|---|
| Worker/Job 界面状态 | `web/src/workerState.ts` + 原有全局 SSE | WorkerPanel 4 秒/2.5 秒、ChatPane 5 秒、JobThread 2.5 秒轮询 |
| 任务命令提交 | `TaskStateService.applyCommand` | 状态变更与注记/改期各写一套幂等、版本、事件和 outbox 事务 |
| 网关工具输入 | 工具自身 `inputSchema` + `defineGatewayTool` | API JSON Schema、MCP 参数表、淘宝重复校验各自维护 |
| 派单身份 | `shared/coordination-keys` | 网关与 Worker 手抄同一指纹/key 算法 |
| 执行/验收候选 | 每轮一次 `coordinationTaskSnapshot` 即时扫描 | 同一轮分别读取整份任务目录 |
| Agenda 通知事实 | 已有 v3 增量状态 | 无读取者的 v1 last-fingerprint 写入 |

不新增数据库表，不改历史 migration，不迁移或删除已有聊天、记忆、任务数据。
派单旧 v1 key 继续解析；同一 taskPath 的互斥、独立验收、权限和心跳闸门继续生效。
后台领域仍保留各自语义，静默规则与 route-triage 否决窗口不因代码收敛改变。

## 对使用者的变化

- 任务和 Worker 状态随 SSE 更新；切后台回来或重连时校准。App 只保留一处每 60 秒的可见页兜底。
- 展开同一 Job 的多个入口共用详情与日志；旧 HTTP 响应不能把新终态改回运行中。
- 工具两入口统一拒绝未知字段和声明范围之外的参数。`result_limit` 必须为 1–12000，
  不再把 0 自动夹成 1；淘宝的内部来源字段不能由调用者传入。
- 改期、注记、完成依旧走相同外部接口；事件或 outbox 写入失败时整条命令回滚，可安全重试。

## 验证

使用 Node 22，按锁文件安装依赖后运行：

```bash
npm ci --prefix server
npm ci --prefix web
npm run build --prefix server
npm run build --prefix web
npm test --prefix server
npm test --prefix web
npm test --prefix worker
```

关键回归在 `server/test/taskController.test.mts`（三类命令故障回滚与重试）、
`server/test/gatewayToolContract.test.mts`（API/MCP 同契约与拒绝无副作用）、
`server/test/coordinationKeys.test.mts` 与 `worker/triage.test.mjs`（既有 key 字节兼容）、
`web/test/workerState.test.mjs`（事件/HTTP 竞态与断线校准）。
Worker 运行状态事件另以 `server/scripts/smoke-worker-control.ts` 验证。

## 交付与运行

源码重构的交付与生产上线分开核对。合入前独立 review；之后在维护窗口沿现有部署脚本更新，
首次重启前必须确认 `shared/coordination-keys` 对服务用户可读，并保留桌面包的共享文件分发。
本次同时更新了部署脚本的可读白名单；若部署入口仍运行内存中的旧脚本，须先落实这项权限准备，
不能假定它会在本轮自动采用新白名单。
部署后检查健康、收发消息、重连、任务执行与回执，再进入产品宪章规定的一周住户观察窗。
本地测试通过不等于已完成线上稳定验收。
