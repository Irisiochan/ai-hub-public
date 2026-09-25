import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../src/platform/db.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { sessionAuth } from '../src/platform/middleware/auth.js';
import { roomTasksRouter } from '../src/roomTasks/roomTaskRoutes.js';
import { ensureTurnSchema } from '../src/roomTasks/turnAttribution.js';
import type { SseHub } from '../src/platform/sse.js';

const RECEIPT = 'a'.repeat(40);
const MASTER = 'b'.repeat(40);
const MANUAL = 'c'.repeat(40);

const VPS_TARGETS = {
  'ai-hub': {
    repoId: 'ai-hub', platform: 'linux' as const, workerId: 'vps-dev',
    workspace: '/srv/ai-dev/jobs', runners: ['codex', 'opencode'], ssh: false, shell: true,
  },
};

interface BaselineStub {
  receipt: string | null;
  master: string | null;
  ancestor: boolean;
  ancestorCalls?: number;
}

function stubReaders(stub: BaselineStub) {
  return {
    readReceiptCommit: () => stub.receipt,
    readMasterSha: () => stub.master,
    isAncestorOrEqual: () => {
      stub.ancestorCalls = (stub.ancestorCalls ?? 0) + 1;
      return stub.ancestor;
    },
  };
}

async function fixture(
  t: any,
  options: { stub?: BaselineStub; withVpsWorker?: boolean; withPcIris?: 'online' | 'offline' } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-w3-'));
  const db = openDb(path.join(dir, 'hub.db'));
  ensureTurnSchema(db);
  const events: unknown[] = [];
  const sse = { broadcast(...args: unknown[]) { events.push(args); } } as unknown as SseHub;
  const jobs = new JobStore(db, sse);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]) {
    db.prepare("INSERT INTO contacts (id,name,backend,kind,config) VALUES (?,?,?,'dm','{}')").run(id, id, backend);
  }
  db.prepare("INSERT INTO contacts (id,name,backend,kind,config) VALUES (?,?,'room','room',?)")
    .run('room', 'room', JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse', 'aye'] }));
  const capabilities = { workspaces: [dir], runners: ['codex', 'opencode', 'grok'], shell: true };
  db.prepare("INSERT INTO workers (id,name,token_hash,capabilities) VALUES ('pc','PC','test',?)").run(JSON.stringify(capabilities));
  db.prepare("INSERT INTO workers (id,name,token_hash,capabilities) VALUES ('vps-dev','vps-dev','test',?)")
    .run(JSON.stringify({ workspaces: ['/srv/ai-dev/jobs'], runners: ['codex', 'opencode'], shell: true }));
  if (options.withPcIris) {
    const lastSeen = options.withPcIris === 'online' ? "datetime('now')" : "datetime('now', '-1 hour')";
    db.prepare(`INSERT INTO workers (id,name,token_hash,capabilities,accepting_jobs,last_seen_at)
      VALUES ('pc-User','pc-User','test',?,1,${lastSeen})`)
      .run(JSON.stringify({ workspaces: [dir], runners: ['codex', 'opencode', 'grok'], shell: true }));
  }
  const app = express();
  app.use(express.json());
  app.use(sessionAuth('test-secret')!);
  app.use('/api', roomTasksRouter(db, jobs, {
    sse,
    projectTargets: VPS_TARGETS,
    ...(options.stub ? { baselineReaders: stubReaders(options.stub) } : {}),
    readVaultTask: () => '# Original requirements\nImplement the requested change.',
    dispatcher: {
      publishFact() {},
      dispatchToModule() { return { status: 'posted' }; },
    },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const login = await fetch(`${url}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-secret' }),
  }).then(res => res.json()) as { sessionToken: string };
  const post = (body: unknown) => fetch(`${url}/api/room-tasks/room`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.sessionToken}` },
    body: JSON.stringify(body),
  });
  const get = (pathSuffix: string) => fetch(`${url}${pathSuffix}`, {
    headers: { Authorization: `Bearer ${login.sessionToken}` },
  });
  const taskRow = (taskPath: string) =>
    db.prepare('SELECT * FROM room_tasks WHERE task_path = ?').get(taskPath) as any;
  const eventKinds = (taskId: string) =>
    (db.prepare('SELECT kind, payload FROM room_task_events WHERE task_id = ? ORDER BY id').all(taskId) as any[]);
  return { dir, db, jobs, url, post, get, taskRow, eventKinds };
}

test('W3: repo 有映射时默认选 VPS 围栏工作区，baseline 取部署回执（祖先）', async t => {
  const stub: BaselineStub = { receipt: RECEIPT, master: MASTER, ancestor: true };
  const fx = await fixture(t, { stub });
  const res = await fx.post({ task_path: 'tasks/w3-default.md', repo_id: 'ai-hub' });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json() as any;
  assert.equal(body.baseline_source, 'deploy-receipt');
  const row = fx.taskRow('tasks/w3-default.md');
  assert.equal(row.approved_workspace, '/srv/ai-dev/jobs/w3-default');
  assert.equal(row.baseline_sha, RECEIPT);
  assert.equal(row.baseline_source, 'deploy-receipt');
  assert.equal(stub.ancestorCalls, 1);
});

test('W3: 部署回执非祖先时回退 ls-remote 并记 baseline-fallback 事件', async t => {
  const stub: BaselineStub = { receipt: RECEIPT, master: MASTER, ancestor: false };
  const fx = await fixture(t, { stub });
  const res = await fx.post({ task_path: 'tasks/w3-fallback.md', repo_id: 'ai-hub' });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json() as any;
  assert.equal(body.baseline_source, 'ls-remote');
  const row = fx.taskRow('tasks/w3-fallback.md');
  assert.equal(row.baseline_sha, MASTER);
  const kinds = fx.eventKinds(row.id);
  const fallback = kinds.find(item => item.kind === 'baseline-fallback');
  assert.ok(fallback, 'must record a baseline-fallback event');
  const payload = JSON.parse(fallback.payload);
  assert.equal(payload.receiptCommit, RECEIPT);
  assert.equal(payload.masterSha, MASTER);
});

test('W3: 回执与远端都取不到则报错要求手填；手填来源为 manual', async t => {
  const fx = await fixture(t, { stub: { receipt: null, master: null, ancestor: false } });
  const missing = await fx.post({ task_path: 'tasks/w3-nobase.md', repo_id: 'ai-hub' });
  assert.equal(missing.status, 400);
  assert.match((await missing.json() as { error: string }).error, /baseline_sha/);
  assert.equal(fx.taskRow('tasks/w3-nobase.md'), undefined);

  const manual = await fx.post({ task_path: 'tasks/w3-manual.md', repo_id: 'ai-hub', baseline_sha: MANUAL });
  assert.equal(manual.status, 201, await manual.clone().text());
  const body = await manual.json() as any;
  assert.equal(body.baseline_source, 'manual');
  assert.equal(fx.taskRow('tasks/w3-manual.md').baseline_source, 'manual');
});

test('W3: 声明 camera 时 VPS 工作区被拒，PC 工作区放行并落账 needs_pc', async t => {
  const stub: BaselineStub = { receipt: RECEIPT, master: RECEIPT, ancestor: true };
  const fx = await fixture(t, { stub });
  const refused = await fx.post({
    task_path: 'tasks/w3-cam-vps.md', workspace: '/srv/ai-dev/jobs/w3-cam-vps',
    baseline_sha: MANUAL, needs_camera: true,
  });
  assert.equal(refused.status, 400);
  assert.match((await refused.json() as { error: string }).error, /camera/);

  const allowed = await fx.post({
    task_path: 'tasks/w3-cam-pc.md', workspace: fx.dir, baseline_sha: MANUAL, needs_camera: true,
  });
  assert.equal(allowed.status, 201, await allowed.clone().text());
  assert.equal(fx.taskRow('tasks/w3-cam-pc.md').needs_pc, JSON.stringify(['camera']));
});

test('W3: 未映射 repo 不给默认工作区；显式 VPS 工作区仍走 baseline 缺省', async t => {
  const stub: BaselineStub = { receipt: RECEIPT, master: RECEIPT, ancestor: true };
  const fx = await fixture(t, { stub });
  assert.equal((await fx.post({ task_path: 'tasks/w3-unknown.md', repo_id: 'nope' })).status, 400);
  assert.equal((await fx.post({ task_path: 'tasks/w3-nowhere.md' })).status, 400);
  const explicit = await fx.post({ task_path: 'tasks/w3-explicit.md', workspace: '/srv/ai-dev/jobs/w3-explicit' });
  assert.equal(explicit.status, 201, await explicit.clone().text());
  assert.equal((await explicit.json() as any).baseline_source, 'deploy-receipt');
});

test('W3: GET /api/project-targets 暴露映射（无凭据）', async t => {
  const fx = await fixture(t, {});
  const res = await fx.get('/api/project-targets');
  assert.equal(res.status, 200);
  const body = await res.json() as { targets: Array<{ repoId: string; workerId: string; workspace: string }> };
  const aiHub = body.targets.find(item => item.repoId === 'ai-hub');
  assert.ok(aiHub);
  assert.equal(aiHub.workerId, 'vps-dev');
  assert.equal(aiHub.workspace, '/srv/ai-dev/jobs');
  assert.ok(!JSON.stringify(body).includes('token'), 'no credentials leak');
});

test('W3: execute 绑定 pc-User 且离线、无 PC 能力时记 fallback 事件且不改绑定', async t => {
  const stub: BaselineStub = { receipt: RECEIPT, master: RECEIPT, ancestor: true };
  const fx = await fixture(t, { stub, withPcIris: 'offline' });
  fx.db.prepare("UPDATE contacts SET config = ? WHERE id = 'muse'")
    .run(JSON.stringify({ delegation: { enabled: true, workspaces: [fx.dir], workerId: 'pc-User' } }));
  const res = await fx.post({
    task_path: 'tasks/w3-pc-offline.md', workspace: fx.dir,
    dispatch: { to_module: 'execute', request: 'Implement and verify', auto_start: true },
  });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json() as any;
  const row = fx.taskRow('tasks/w3-pc-offline.md');
  assert.equal(row.approved_workspace, fx.dir, 'workspace binding untouched');
  assert.equal(body.handoff.to_contact, 'muse', 'execute binding untouched');
  const kinds = fx.eventKinds(row.id).map(item => item.kind);
  assert.ok(kinds.includes('execute-pc-offline-fallback'), `fallback hint event missing: ${kinds.join(',')}`);
  const fallback = fx.eventKinds(row.id).find(item => item.kind === 'execute-pc-offline-fallback');
  const payload = JSON.parse(fallback.payload);
  assert.equal(payload.pinnedWorkerId, 'pc-User');
  assert.match(payload.suggestion, /VPS/);
  // 绑定语义不变：job 仍是 muse 发起的 pending 执行任务，没有被改派到 vps-dev。
  const job = fx.jobs.get(body.job.id)!;
  assert.equal(job.status, 'pending');
  assert.equal(job.worker_id, null);
});

test('W3: pc-User 在线时不打扰；VPS 任务不受 PC 提示影响', async t => {
  const stub: BaselineStub = { receipt: RECEIPT, master: RECEIPT, ancestor: true };
  const online = await fixture(t, { stub, withPcIris: 'online' });
  online.db.prepare("UPDATE contacts SET config = ? WHERE id = 'muse'")
    .run(JSON.stringify({ delegation: { enabled: true, workspaces: [online.dir], workerId: 'pc-User' } }));
  const res = await online.post({
    task_path: 'tasks/w3-pc-online.md', workspace: online.dir,
    dispatch: { to_module: 'execute', request: 'Implement and verify', auto_start: true },
  });
  assert.equal(res.status, 201, await res.clone().text());
  const row = online.taskRow('tasks/w3-pc-online.md');
  assert.ok(!online.eventKinds(row.id).some(item => item.kind === 'execute-pc-offline-fallback'));

  const vps = await online.post({
    task_path: 'tasks/w3-vps-quiet.md', repo_id: 'ai-hub',
    dispatch: { to_module: 'execute', request: 'Implement and verify', auto_start: true },
  });
  assert.equal(vps.status, 201, await vps.clone().text());
  const vpsRow = online.taskRow('tasks/w3-vps-quiet.md');
  assert.ok(!online.eventKinds(vpsRow.id).some(item => item.kind === 'execute-pc-offline-fallback'),
    'VPS tasks never get the PC-offline hint');
});

test('W3: 声明 PC 能力的任务离线也不提示（真需要 PC）', async t => {
  const stub: BaselineStub = { receipt: RECEIPT, master: RECEIPT, ancestor: true };
  const fx = await fixture(t, { stub, withPcIris: 'offline' });
  const res = await fx.post({
    task_path: 'tasks/w3-needspc.md', workspace: fx.dir, baseline_sha: MANUAL, needs_ssh: true,
    dispatch: { to_module: 'execute', request: 'SSH job', auto_start: true },
  });
  assert.equal(res.status, 201, await res.clone().text());
  const row = fx.taskRow('tasks/w3-needspc.md');
  assert.ok(!fx.eventKinds(row.id).some(item => item.kind === 'execute-pc-offline-fallback'));
});
