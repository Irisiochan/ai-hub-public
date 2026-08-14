/**
 * Smoke test: PC-worker delegation tools + terminal-transition continuation
 * hook, against an on-disk temp SQLite (openDb runs real migrations).
 * Run with: npx tsx scripts/smoke-delegate.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDelegateTools, delegationGuidance } from '../src/agents/gatewayTools.js';
import { openDb, type JobRow } from '../src/db.js';
import {
  JobStore,
  normalizeWorkspace,
  workspaceAllowed,
} from '../src/workers/jobStore.js';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures++;
}

check(
  'Windows workspace 双分隔符规范化',
  normalizeWorkspace(String.raw`C:\\path\\to\\project`) === String.raw`C:\path\to\project`,
);
check(
  'Windows workspace 跨平台允许匹配',
  workspaceAllowed(String.raw`C:\\path\\to\\project`, [String.raw`C:\path\to\project`]),
);
check(
  'Windows 相邻目录仍不可越界',
  !workspaceAllowed(String.raw`C:\path\to\project-evil`, [String.raw`C:\path\to\project`]),
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-smoke-'));
const db = openDb(path.join(dir, 'test.db'));
const sse = { broadcast: () => {} } as any;
const store = new JobStore(db, sse);

const finished: JobRow[] = [];
store.onFinished = (job) => finished.push(job);

const ws = path.join(dir, 'repo');
fs.mkdirSync(ws);
// 造一个聊天现场：委派应记录 origin（聊天 id + 派单时最后一条消息）
db.prepare("INSERT INTO contacts (id, name, backend) VALUES ('glm', 'GLM', 'api')").run();
db.prepare(
  "INSERT INTO messages (contact_id, sender, role, kind, content) VALUES ('glm', 'user', 'user', 'text', '帮我修个 bug')"
).run();
const anchorId = Number(
  db.prepare(
    "INSERT INTO messages (contact_id, sender, role, kind, content) VALUES ('glm', 'glm', 'assistant', 'tool_use', 'delegate_to_worker')"
  ).run().lastInsertRowid
);
const tools = buildDelegateTools(store, db, 'glm', {
  enabled: true,
  workspaces: [ws],
  allowShell: true,
});
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

// route_class 服务端硬闸（实现单验收 a-g）
const routeTools = buildDelegateTools(store, db, 'route-smoke', {
  enabled: true,
  workspaces: [ws],
  allowShell: true,
  maxOpenJobs: 10,
});
const routeDelegate = routeTools.find((tool) => tool.name === 'delegate_to_worker')!;
const routeStatus = routeTools.find((tool) => tool.name === 'worker_job_status')!;
const jobFrom = (text: string) => {
  const id = text.match(/任务 ([0-9a-f-]{36})/)?.[1] ?? '';
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
};

let routeOut = await routeDelegate.exec({ route_class: 'implement', workspace: ws, prompt: 'route a' });
let routeJob = jobFrom(routeOut.text);
let routeOptions = JSON.parse(routeJob?.options || '{}');
check(
  'a) implement 不填 runner → codex + policy',
  routeOut.ok && routeJob?.runner === 'codex'
    && routeOptions.routeClass === 'implement' && routeOptions.runnerSource === 'policy',
  `${routeOut.text}\n${JSON.stringify(routeOptions)}`
);

routeOut = await routeDelegate.exec({
  route_class: 'implement',
  runner: 'grok',
  workspace: ws,
  prompt: 'route b',
});
check(
  'b) implement + grok 无 override → 拒绝并给正确默认',
  !routeOut.ok && routeOut.text.includes('route_class=implement')
    && routeOut.text.includes('runner=grok') && routeOut.text.includes('正确默认是 codex'),
  routeOut.text
);

const reviewOut = await routeDelegate.exec({
  route_class: 'review', runner: 'grok', workspace: ws, prompt: 'route c review',
});
const mechanicalExplicitOut = await routeDelegate.exec({
  route_class: 'mechanical', runner: 'grok', workspace: ws, prompt: 'route c mechanical',
});
check('c) review / mechanical + grok → 放行', reviewOut.ok && mechanicalExplicitOut.ok,
  `${reviewOut.text}\n${mechanicalExplicitOut.text}`);

routeOut = await routeDelegate.exec({ route_class: 'mechanical', workspace: ws, prompt: 'route d' });
routeJob = jobFrom(routeOut.text);
routeOptions = JSON.parse(routeJob?.options || '{}');
check(
  'd) mechanical 不填 runner → grok + policy',
  routeOut.ok && routeJob?.runner === 'grok'
    && routeOptions.routeClass === 'mechanical' && routeOptions.runnerSource === 'policy',
  `${routeOut.text}\n${JSON.stringify(routeOptions)}`
);

routeOut = await routeDelegate.exec({
  route_class: 'implement',
  runner: 'grok',
  runner_override_reason: '专项兼容性复现',
  workspace: ws,
  prompt: 'route e',
});
routeJob = jobFrom(routeOut.text);
routeOptions = JSON.parse(routeJob?.options || '{}');
const overrideStatus = await routeStatus.exec({ job_id: routeJob?.id ?? '' });
check(
  'e) implement + grok + override → 放行，持久化并由 status 返回 reason',
  routeOut.ok && routeJob?.runner === 'grok'
    && routeOptions.runnerSource === 'override'
    && routeOptions.runnerOverrideReason === '专项兼容性复现'
    && overrideStatus.ok && overrideStatus.text.includes('runnerOverrideReason：专项兼容性复现'),
  `${routeOut.text}\n${JSON.stringify(routeOptions)}\n${overrideStatus.text}`
);

routeOut = await routeDelegate.exec({ workspace: ws, prompt: 'route f' });
check(
  'f) 缺 route_class → 拒绝并给 enum 全表',
  !routeOut.ok && ['implement', 'fix', 'review', 'recon', 'mechanical']
    .every((value) => routeOut.text.includes(value)),
  routeOut.text
);

const claudeDenied = await routeDelegate.exec({
  route_class: 'implement', runner: 'claude', workspace: ws, prompt: 'table-out denied',
});
const claudeOverride = await routeDelegate.exec({
  route_class: 'implement',
  runner: 'claude',
  runner_override_reason: '需要 Claude 专项验证',
  workspace: ws,
  prompt: 'table-out allowed',
});
const claudeOverrideJob = jobFrom(claudeOverride.text);
const claudeOverrideOptions = JSON.parse(claudeOverrideJob?.options || '{}');
check(
  '表外 claude 无 override 拒绝、有 override 放行',
  !claudeDenied.ok && claudeDenied.text.includes('正确默认是 codex')
    && claudeOverride.ok && claudeOverrideJob?.runner === 'claude'
    && claudeOverrideOptions.runnerSource === 'override',
  `${claudeDenied.text}\n${claudeOverride.text}`
);

const emptyOverride = await routeDelegate.exec({
  route_class: 'implement',
  runner: 'grok',
  runner_override_reason: '   ',
  workspace: ws,
  prompt: 'empty override denied',
});
check('空 override reason 拒绝', !emptyOverride.ok && emptyOverride.text.includes('非空字符串'), emptyOverride.text);

const fixDefault = await routeDelegate.exec({ route_class: 'fix', workspace: ws, prompt: 'fix default' });
const reconDefault = await routeDelegate.exec({ route_class: 'recon', workspace: ws, prompt: 'recon default' });
check(
  '完整默认表补证：fix → codex，recon → grok',
  jobFrom(fixDefault.text)?.runner === 'codex' && jobFrom(reconDefault.text)?.runner === 'grok',
  `${fixDefault.text}\n${reconDefault.text}`
);

const legacy = store.create({
  requestedBy: 'route-smoke',
  runner: 'codex',
  workspace: ws,
  prompt: 'legacy job without route metadata',
  permissions: { write: false, shell: true, ssh: false },
});
if ('error' in legacy) throw new Error(legacy.error);
routeOut = await routeStatus.exec({ job_id: legacy.job.id });
check(
  'g) 存量 job 无新字段 → status 显示未知且不崩',
  routeOut.ok && routeOut.text.includes('routeClass：未知，runnerSource：未知'),
  routeOut.text
);

check(
  'tool description 写入稳定默认表且移除仅列 runner 文案',
  routeDelegate.description.includes('implement/fix→codex')
    && routeDelegate.description.includes('review/recon/mechanical→grok')
    && routeDelegate.description.includes('runner_override_reason')
    && !routeDelegate.description.includes('可用 runner：'),
  routeDelegate.description
);

// 1. 越界 workspace 被拒
let out = await byName.delegate_to_worker.exec({
  route_class: 'review',
  runner: 'claude',
  runner_override_reason: '覆盖 Claude workspace 校验',
  workspace: '/etc',
  prompt: 'x',
});
check('workspace 越界被拒', !out.ok && out.text.includes('白名单'));

// 2. SSH 是独立、显式的双层能力，不能被普通 shell 偷渡
out = await byName.delegate_to_worker.exec({
  route_class: 'implement',
  runner: 'codex',
  workspace: ws,
  prompt: '部署到 VPS',
  ssh: true,
});
check('联系人未开放 SSH 时远程部署被拒', !out.ok && out.text.includes('delegation.allowSsh'), out.text);

const sshTools = buildDelegateTools(store, db, 'ssh-contact', {
  enabled: true,
  workspaces: [ws],
  allowShell: true,
  allowSsh: true,
  maxOpenJobs: 10,
});
out = await sshTools.find((tool) => tool.name === 'delegate_to_worker')!.exec({
  route_class: 'implement',
  runner: 'codex',
  workspace: ws,
  prompt: '部署到 User-vps:/opt/app，只重启 target.service',
  ssh: true,
});
check('联系人已开放 SSH 时 job 显式携带远程权限', out.ok, out.text);
const sshJobId = out.text.match(/任务 ([0-9a-f-]{36})/)?.[1] ?? '';
const sshJob = db.prepare('SELECT * FROM jobs WHERE id = ?').get(sshJobId) as JobRow | undefined;
check('SSH 权限写入持久 job', JSON.parse(sshJob?.permissions || '{}').ssh === true);

const sshGuidance = delegationGuidance({ enabled: true, workspaces: [ws], allowShell: true, allowSsh: true });
const noSshGuidance = delegationGuidance({ enabled: true, workspaces: [ws], allowShell: true, allowSsh: false });
check(
  'SSH 已开放时要求 Worker 同 job 完成部署',
  sshGuidance.includes('必须传 ssh=true') && sshGuidance.includes('禁止用 tail 提前交付'),
);
check(
  'SSH 未开放时只允许精确 deploy-tail',
  noSshGuidance.includes('delegation.allowSsh=false') && noSshGuidance.includes('不得声称 Worker 已被授权部署'),
);
check(
  '旧的无条件 deploy-tail 指令已移除',
  !sshGuidance.includes('登记完即交付完成') && !sshGuidance.includes('若仅剩部署则另建 deploy-tail'),
);
check(
  '编码任务外派规范注入 route_class 默认表',
  sshGuidance.includes('implement/fix→codex')
    && sshGuidance.includes('review/recon/mechanical→grok')
    && sshGuidance.includes('runner_override_reason')
    && sshGuidance.includes('必须显式传 route_class'),
  sshGuidance,
);

// 3. 含糊的裸版本号被拒，不能悄悄退回 Worker 默认模型
out = await byName.delegate_to_worker.exec({
  route_class: 'review',
  runner: 'claude',
  runner_override_reason: '覆盖 Claude 模型归一化测试',
  workspace: ws,
  prompt: 'x',
  model: '4.6',
});
check('Claude 裸版本号被拒', !out.ok && out.text.includes('不能只写 4.6'), out.text);

// 4. 正常派单
out = await byName.delegate_to_worker.exec({
  route_class: 'review',
  runner: 'claude',
  runner_override_reason: '覆盖 Claude 固定版本测试',
  workspace: ws,
  prompt: '修一下 README 的错别字，改完 commit',
  model: 'Opus 4.6',
  effort: 'max',
});
check('派单成功', out.ok, out.text);
const jobId = out.text.match(/任务 ([0-9a-f-]{36})/)?.[1] ?? '';
const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
check('job 落库 pending', row?.status === 'pending' && row?.requested_by === 'glm');
const options = JSON.parse(row?.options || '{}');
check(
  'Opus 4.6 归一化为固定模型 ID',
  options.model === 'claude-opus-4-6' && options.reasoning === 'max',
  JSON.stringify(options)
);
check(
  'origin 锚点记录（挂回原消息）',
  row?.origin_contact_id === 'glm' && row?.origin_anchor_id === anchorId,
  `origin=${row?.origin_contact_id}/${row?.origin_anchor_id}, expect glm/${anchorId}`
);

// 5. codex 不带 shell 被拒（allowShell 开着但 runner 规则仍要求显式 shell → 自动带上）
out = await byName.delegate_to_worker.exec({
  route_class: 'implement', runner: 'codex', workspace: ws, prompt: 'x', write: false,
});
check('codex 自动带 shell 可派', out.ok, out.text);
const readOnlyJobId = out.text.match(/任务 ([0-9a-f-]{36})/)?.[1] ?? '';
const readOnlyPermissions = JSON.parse(
  (db.prepare('SELECT permissions FROM jobs WHERE id = ?').get(readOnlyJobId) as any)?.permissions || '{}'
);
check('只读派单真实写入 write=false', readOnlyPermissions.write === false && readOnlyPermissions.shell === true);

// 5b. 不传 model/effort 时补默认：claude → Opus 5 / high，codex → gpt-5.6-sol / high，grok → 4.6 / high
const sshDelegate = sshTools.find((tool) => tool.name === 'delegate_to_worker')!;
const optionsOf = async (input: Record<string, unknown>) => {
  const res = await sshDelegate.exec(input);
  check(`默认值派单成功（${input.runner}）`, res.ok, res.text);
  const id = res.text.match(/任务 ([0-9a-f-]{36})/)?.[1] ?? '';
  return JSON.parse((db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined)?.options || '{}');
};
let defaults = await optionsOf({
  route_class: 'review', runner: 'claude', runner_override_reason: '覆盖 Claude 默认值测试', workspace: ws, prompt: 'x',
});
check(
  'claude 默认 Opus 5 + high',
  defaults.model === 'claude-opus-5' && defaults.reasoning === 'high',
  JSON.stringify(defaults)
);
defaults = await optionsOf({ route_class: 'implement', runner: 'codex', workspace: ws, prompt: 'x' });
check(
  'codex 默认 gpt-5.6-sol + high',
  defaults.model === 'gpt-5.6-sol' && defaults.reasoning === 'high',
  JSON.stringify(defaults)
);
defaults = await optionsOf({
  route_class: 'review', runner: 'claude', runner_override_reason: '覆盖 Claude 显式值测试',
  workspace: ws, prompt: 'x', model: 'Opus 4.6', effort: 'low',
});
check(
  '显式传参不被默认值覆盖',
  defaults.model === 'claude-opus-4-6' && defaults.reasoning === 'low',
  JSON.stringify(defaults)
);
defaults = await optionsOf({ route_class: 'review', runner: 'grok', workspace: ws, prompt: 'x' });
check(
  'grok 默认 grok-4.6 + high',
  defaults.model === 'grok-4.6' && defaults.reasoning === 'high',
  JSON.stringify(defaults)
);
defaults = await optionsOf({
  route_class: 'review', runner: 'grok', workspace: ws, prompt: 'x', model: 'grok-4.5', effort: 'medium',
});
check(
  'grok 显式传参覆盖默认值',
  defaults.model === 'grok-4.5' && defaults.reasoning === 'medium',
  JSON.stringify(defaults)
);

// 6. 状态查询（自己的 / 别人的）
out = await byName.worker_job_status.exec({ job_id: jobId });
check('状态查询 ok', out.ok && out.text.includes('pending'));
const foreign = buildDelegateTools(store, db, 'codex', { enabled: true, workspaces: [ws] });
out = await foreign.find((t) => t.name === 'worker_job_status')!.exec({ job_id: jobId });
check('别人的任务查不了', !out.ok);

// 7. open jobs 上限
await byName.delegate_to_worker.exec({ route_class: 'implement', runner: 'codex', workspace: ws, prompt: '3rd' });
out = await byName.delegate_to_worker.exec({ route_class: 'implement', runner: 'codex', workspace: ws, prompt: '4th' });
check('超过 maxOpenJobs 被拒', !out.ok && out.text.includes('队列'));

// 8. 完成 → onFinished 恰好一次
db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(jobId);
const jobRow = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow;
store.complete(jobRow, 'done', '改完了，commit abc123', null);
check('done 触发 onFinished 一次', finished.length === 1 && finished[0].id === jobId && finished[0].status === 'done');

// 9. 取消自己的 pending 任务；paused 不触发 onFinished
out = await byName.worker_job_cancel.exec({
  job_id: (db.prepare("SELECT id FROM jobs WHERE status='pending' AND requested_by='glm' LIMIT 1").get() as any).id,
});
check('取消 pending 任务', out.ok && out.text.includes('cancelled'));
check('cancel 不触发 continuation', finished.length === 1);

// 10. 外部续接：仅可把带交付阻塞元数据的 blocked job 自动回写为 done，且不重复触发 continuation
const reconciliation = store.create({
  requestedBy: 'glm',
  runner: 'codex',
  workspace: ws,
  prompt: '提交推送后自动回写',
  permissions: { write: true, shell: true, ssh: false },
});
if ('error' in reconciliation) throw new Error(reconciliation.error);
db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(reconciliation.job.id);
const blockedJob = reconciliation.job;
store.complete(
  blockedJob,
  'blocked',
  '本地提交尚未推送',
  null,
  'blocked_unpushed',
  JSON.stringify({ state: 'blocked_unpushed', head: 'abc1234', ahead: 1 })
);
const finishedAfterBlock = finished.length;
const reconciled = store.reconcileBlocked(
  store.get(blockedJob.id)!,
  'pc-User',
  JSON.stringify({ state: 'delivered', reconciliation: { head: 'def5678', ahead: 0 } }),
  'def5678'
);
const reconciledRow = store.get(blockedJob.id)!;
check('blocked 外部续接自动回写 done', 'status' in reconciled && reconciledRow.status === 'done');
check(
  '自动回写保留原结果且不重复 continuation',
  reconciledRow.result === '本地提交尚未推送' && finished.length === finishedAfterBlock
);
check(
  '自动回写追加审计消息',
  store.messages(blockedJob.id).some((message) => message.content.includes('外部续接已自动确认完成'))
);

// 11. 派单联系人可事后修改自己的交付结论
out = await byName.worker_job_update_delivery.exec({
  job_id: jobId,
  stage: 'closed_loop',
  summary: '验收完成。',
  next_owner: '无需后续动作',
});
check('AI 可事后回写交付结论', out.ok, out.text);
check(
  '交付结论与审计证据已持久化',
  JSON.parse(store.get(jobId)?.delivery_meta || '{}').declared?.stage === 'closed_loop'
    && store.messages(jobId).some((message) => message.content.includes('交付结论更新为 closed_loop'))
);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
