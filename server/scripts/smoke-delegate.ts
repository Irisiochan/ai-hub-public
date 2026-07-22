/**
 * Smoke test: PC-worker delegation tools + terminal-transition continuation
 * hook, against an on-disk temp SQLite (openDb runs real migrations).
 * Run with: npx tsx scripts/smoke-delegate.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDelegateTools } from '../src/agents/gatewayTools.js';
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
  normalizeWorkspace(String.raw`C:\\projects\\demo`) === String.raw`C:\projects\demo`,
);
check(
  'Windows workspace 跨平台允许匹配',
  workspaceAllowed(String.raw`C:\\projects\\demo`, [String.raw`C:\projects\demo`]),
);
check(
  'Windows 相邻目录仍不可越界',
  !workspaceAllowed(String.raw`C:\projects\demo-evil`, [String.raw`C:\projects\demo`]),
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

// 1. 越界 workspace 被拒
let out = await byName.delegate_to_worker.exec({ runner: 'claude', workspace: '/etc', prompt: 'x' });
check('workspace 越界被拒', !out.ok && out.text.includes('白名单'));

// 2. 含糊的裸版本号被拒，不能悄悄退回 Worker 默认模型
out = await byName.delegate_to_worker.exec({
  runner: 'claude',
  workspace: ws,
  prompt: 'x',
  model: '4.6',
});
check('Claude 裸版本号被拒', !out.ok && out.text.includes('不能只写 4.6'), out.text);

// 3. 正常派单
out = await byName.delegate_to_worker.exec({
  runner: 'claude',
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

// 4. codex 不带 shell 被拒（allowShell 开着但 runner 规则仍要求显式 shell → 自动带上）
out = await byName.delegate_to_worker.exec({ runner: 'codex', workspace: ws, prompt: 'x' });
check('codex 自动带 shell 可派', out.ok, out.text);

// 5. 状态查询（自己的 / 别人的）
out = await byName.worker_job_status.exec({ job_id: jobId });
check('状态查询 ok', out.ok && out.text.includes('pending'));
const foreign = buildDelegateTools(store, db, 'other-agent', { enabled: true, workspaces: [ws] });
out = await foreign.find((t) => t.name === 'worker_job_status')!.exec({ job_id: jobId });
check('别人的任务查不了', !out.ok);

// 6. open jobs 上限
await byName.delegate_to_worker.exec({ runner: 'claude', workspace: ws, prompt: '3rd' });
out = await byName.delegate_to_worker.exec({ runner: 'claude', workspace: ws, prompt: '4th' });
check('超过 maxOpenJobs 被拒', !out.ok && out.text.includes('队列'));

// 7. 完成 → onFinished 恰好一次
const jobRow = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow;
store.complete(jobRow, 'done', '改完了，commit abc123', null);
check('done 触发 onFinished 一次', finished.length === 1 && finished[0].id === jobId && finished[0].status === 'done');

// 8. 取消自己的 pending 任务；paused 不触发 onFinished
out = await byName.worker_job_cancel.exec({ job_id: (db.prepare("SELECT id FROM jobs WHERE status='pending' LIMIT 1").get() as any).id });
check('取消 pending 任务', out.ok && out.text.includes('cancelled'));
check('cancel 不触发 continuation', finished.length === 1);

// 9. 外部续接：仅可把带交付阻塞元数据的 blocked job 自动回写为 done，且不重复触发 continuation
const reconciliation = store.create({
  requestedBy: 'glm',
  runner: 'codex',
  workspace: ws,
  prompt: '提交推送后自动回写',
  permissions: { write: true, shell: true, ssh: false },
});
if ('error' in reconciliation) throw new Error(reconciliation.error);
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
  'worker-a',
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

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
