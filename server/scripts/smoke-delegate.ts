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
import { JobStore } from '../src/workers/jobStore.js';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures++;
}

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

// 2. 正常派单
out = await byName.delegate_to_worker.exec({
  runner: 'claude',
  workspace: ws,
  prompt: '修一下 README 的错别字，改完 commit',
});
check('派单成功', out.ok, out.text);
const jobId = out.text.match(/任务 ([0-9a-f-]{36})/)?.[1] ?? '';
const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
check('job 落库 pending', row?.status === 'pending' && row?.requested_by === 'glm');
check(
  'origin 锚点记录（挂回原消息）',
  row?.origin_contact_id === 'glm' && row?.origin_anchor_id === anchorId,
  `origin=${row?.origin_contact_id}/${row?.origin_anchor_id}, expect glm/${anchorId}`
);

// 3. codex 不带 shell 被拒（allowShell 开着但 runner 规则仍要求显式 shell → 自动带上）
out = await byName.delegate_to_worker.exec({ runner: 'codex', workspace: ws, prompt: 'x' });
check('codex 自动带 shell 可派', out.ok, out.text);

// 4. 状态查询（自己的 / 别人的）
out = await byName.worker_job_status.exec({ job_id: jobId });
check('状态查询 ok', out.ok && out.text.includes('pending'));
const foreign = buildDelegateTools(store, db, 'codex', { enabled: true, workspaces: [ws] });
out = await foreign.find((t) => t.name === 'worker_job_status')!.exec({ job_id: jobId });
check('别人的任务查不了', !out.ok);

// 5. open jobs 上限
await byName.delegate_to_worker.exec({ runner: 'claude', workspace: ws, prompt: '3rd' });
out = await byName.delegate_to_worker.exec({ runner: 'claude', workspace: ws, prompt: '4th' });
check('超过 maxOpenJobs 被拒', !out.ok && out.text.includes('队列'));

// 6. 完成 → onFinished 恰好一次
const jobRow = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow;
store.complete(jobRow, 'done', '改完了，commit abc123', null);
check('done 触发 onFinished 一次', finished.length === 1 && finished[0].id === jobId && finished[0].status === 'done');

// 7. 取消自己的 pending 任务；paused 不触发 onFinished
out = await byName.worker_job_cancel.exec({ job_id: (db.prepare("SELECT id FROM jobs WHERE status='pending' LIMIT 1").get() as any).id });
check('取消 pending 任务', out.ok && out.text.includes('cancelled'));
check('cancel 不触发 continuation', finished.length === 1);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
