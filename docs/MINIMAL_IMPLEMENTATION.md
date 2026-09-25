# 最小实现

以 [产品宪章](CHARTER.md) 与 [架构](ARCHITECTURE.md) 为准：联系人身份、永续对话、共享记忆、主动消息、工作台派工和验收都保留；
要收掉的是「同一件事在两处实现」和「模块之间靠约定而不是靠测试的边界」。不另建平台、容器或状态库。

## 一件事只有一处实现

| 责任 | 唯一实现 | 收掉的重复 |
|---|---|---|
| 模块边界与依赖方向 | 网关 `server/test/moduleBoundaries.test.mts`、Web `web/test/moduleBoundaries.test.mjs`、worker `worker/layout.test.mjs` 各一张表 | 按技术层分目录、跨目录随意互相 import（重构前网关各技术目录之间的 import 成环） |
| 模块对外提供什么 | 各网关模块的 `index.ts` | 其他模块直接 import 任意内部文件 |
| 房间任务派发器与 store 选项 | 组合根 `server/src/index.ts` 用 `roomTaskPlumbing` 建一次，运行时与 HTTP 层共用 | 进程里建三份（`index.ts` 一份、`server.ts` 两份），`index.ts` 还用 `as Record` 事后塞进 manager |
| 「等待评审闸门」判定 | `server/src/jobs/receiptPreview.ts` 的 `isWaitingReviewGate` | `reviewAutomation.ts` 里手工同步的副本（生产无人调用） |
| Worker/Job 界面状态 | `web/src/jobs/workerState.ts` + 全局 SSE | WorkerPanel 4 秒/2.5 秒、ChatPane 5 秒、JobThread 2.5 秒轮询 |
| 任务命令提交 | `TaskStateService.applyCommand` | 状态变更与注记/改期各写一套幂等、版本、事件和 outbox 事务 |
| 网关工具输入 | 工具自身 `inputSchema` + `platform/gatewayTool.ts` 的 `defineGatewayTool` | API JSON Schema、MCP 参数表、淘宝重复校验各自维护 |
| 派单身份 | `shared/coordination-keys` | 网关与 triage 手抄同一指纹/key 算法 |
| Agenda 通知事实 | 已有 v3 增量状态 | 无读取者的 v1 last-fingerprint 写入 |

不新增数据库表，不改历史 migration，不迁移或删除已有聊天、记忆、任务数据。派单旧 v1 key 继续解析；同一 taskPath 的互斥、独立验收、
权限和心跳闸门继续生效。后台领域保留各自语义，静默规则与 route-triage 否决窗口不因代码收敛改变。

还没收掉的重复与耦合（运行时编排中心、工具清单两处组装、大文件、两套 schema 机制、退役候选）列在 [ARCHITECTURE.md](ARCHITECTURE.md) §4.6。

## 模块化重构（2026-09-24）

- 网关：`server/src/<module>/` 20 个模块目录 + 组合根（`index.ts`、`server.ts`）；每个模块一个 `index.ts` 公开面；依赖表见 ARCHITECTURE §4.2。
  反向需求走结构化端口（§4.3），不为此加容器或事件总线。
- worker：`worker/triage/`（含 `domains/`）、`worker/runner/`、`worker/lib/`；入口与部署路径契约留在 `worker/` 根目录（§4.4）。
- Web：`web/src/<feature>/` 10 个功能目录，`App.tsx` / `main.tsx` 是组合根（§4.5）。
- 行为不变：只有文件位置、import、公开面与接线方式变化；删掉的只有全仓无人引用的导出与未使用的局部变量。

## 对使用者的变化

没有。页面、接口路径、SSE 事件、部署入口、systemd unit 与 launcher 路径都与重构前一致。

## 验证

使用 Node 22+，按锁文件安装依赖后运行：

```bash
npm ci --prefix server
npm ci --prefix web
npm run build --prefix server
npm run build --prefix web
npm run pretest --prefix server
npm test --prefix server
npm run test:room-tasks --prefix server
npm test --prefix web
npm test --prefix worker
node --test deploy/*.test.mjs
```

worker 全量测试在 Windows 上只从 PowerShell/cmd 跑、一次一套（Git Bash 的 GNU tar 与并行子进程会造成假失败）。

关键回归：`server/test/moduleBoundaries.test.mts`、`web/test/moduleBoundaries.test.mjs`、`worker/layout.test.mjs`（边界）；
`server/test/architectureDoc.test.mts`（文档与目录同步）；`server/test/roomTaskReviewPatch.test.mts`（评审补丁敏感清单跟着文件位置走）；
`server/test/taskController.test.mts`（三类命令故障回滚与重试）；`server/test/gatewayToolContract.test.mts`（API/MCP 同契约与拒绝无副作用）；
`server/test/coordinationKeys.test.mts` 与 `worker/triage/triage.test.mjs`（既有 key 字节兼容）；`web/test/workerState.test.mjs`（事件/HTTP 竞态与断线校准）。
Worker 运行状态事件另以 `server/scripts/smoke-worker-control.ts` 验证。构建后可用临时配置启动 `server/dist/index.js` 探一遍只读端点，确认模块装载顺序无误。

## 交付与运行

源码重构的交付与生产上线分开核对。合入前独立 review；之后在维护窗口沿现有部署脚本更新。重构改变了 `server/dist` 的目录布局：
`platform/config.ts`、`platform/migrations.ts` 按新深度回推服务根与 migration 目录，`jobs/coordinationKeys.ts` 与原 `workers/coordinationKeys.ts` 同深度，
桌面包 extraResources 的 `shared/coordination-keys` 相对导入不变。首次重启前照旧确认 `shared/coordination-keys` 与 `worker/` 子目录对服务用户可读
（`update.sh` 的 `chmod -R` 已递归覆盖）。部署后检查健康、收发消息、重连、任务执行与回执，再进入产品宪章规定的一周住户观察窗。
本地测试通过不等于已完成线上稳定验收。
