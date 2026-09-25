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

const VPS_TARGETS = {
  'ai-dashboard': {
    repoId: 'ai-dashboard', platform: 'linux' as const, workerId: 'vps-dev',
    workspace: '/srv/ai-dev/jobs', runners: ['codex', 'opencode'], ssh: false, shell: true,
  },
};

async function fixture(t: any, authenticated = true, projectTargets?: typeof VPS_TARGETS, baselineReaders?: {
  readReceiptCommit: () => string | null; readMasterSha: () => string | null; isAncestorOrEqual: () => boolean;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-entry-'));
  const db = openDb(path.join(dir, 'hub.db'));
  ensureTurnSchema(db);
  const events: unknown[] = [];
  const sse = { broadcast(...args: unknown[]) { events.push(args); } } as unknown as SseHub;
  const jobs = new JobStore(db, sse);
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']]) {
    db.prepare("INSERT INTO contacts (id,name,backend,kind,config) VALUES (?,?,?,'dm','{}')").run(id, id, backend);
  }
  for (const [id, enabled] of [['room', true], ['ordinary', false]] as const) {
    db.prepare("INSERT INTO contacts (id,name,backend,kind,config) VALUES (?,?,'room','room',?)")
      .run(id, id, JSON.stringify({ workflowEnabled: enabled, members: ['codex', 'muse', 'aye'] }));
  }
  // Production meeting room shape: no workflowEnabled flag, legacy coordination object.
  db.prepare("INSERT INTO contacts (id,name,backend,kind,config) VALUES ('legacy','legacy','room','room',?)")
    .run(JSON.stringify({ coordination: { orchestrator: 'codex' }, members: ['codex', 'muse', 'aye'] }));
  const capabilities = { workspaces: [dir], runners: ['codex', 'opencode', 'grok'] };
  db.prepare("INSERT INTO workers (id,name,token_hash,capabilities) VALUES ('pc','PC','test',?)").run(JSON.stringify(capabilities));
  if (projectTargets) {
    db.prepare("INSERT INTO workers (id,name,token_hash,capabilities) VALUES ('vps-dev','vps-dev','test',?)")
      .run(JSON.stringify({ workspaces: ['/srv/ai-dev/jobs'], runners: ['codex', 'opencode'] }));
  }
  const wakes: string[] = [];
  const app = express();
  app.use(express.json());
  if (authenticated) app.use(sessionAuth('test-secret')!);
  app.get('/api/workers', (_req, res) => res.json({ workers: [{ id: 'pc', capabilities }] }));
  app.use('/api', roomTasksRouter(db, jobs, {
    sse,
    ...(projectTargets ? { projectTargets } : {}),
    ...(baselineReaders ? { baselineReaders } : {}),
    readVaultTask: taskPath => taskPath === 'tasks/missing.md' ? null : '# Original requirements\nImplement the requested change.',
    dispatcher: {
      publishFact(id) { events.push(['fact', id]); },
      publishTaskChange(roomId) {
        assert.equal(db.inTransaction, false, 'ledger notifications follow the commit');
        events.push(['room-task', { roomId }]);
      },
      dispatchToModule(_room, module) {
        assert.equal(db.inTransaction, false, 'never wake a model before ledger commit');
        wakes.push(module); return { status: 'posted' };
      },
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
  const login = authenticated ? await fetch(`${url}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-secret' }),
  }).then(res => res.json()) as { sessionToken: string } : { sessionToken: '' };
  const post = (body: unknown, token: string | null = login.sessionToken, room = 'room', cookie = false) => fetch(`${url}/api/room-tasks/${room}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(token ? cookie ? { Cookie: `hub_session=${token}` } : { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const body = { task_path: 'tasks/entry.md', workspace: dir, dispatch: { to_module: 'execute', request: 'Implement and verify', auto_start: true } };
  const counts = () => Object.fromEntries(['messages', 'room_tasks', 'room_task_events', 'room_task_handoffs', 'jobs', 'room_task_callbacks', 'room_task_links']
    .map(table => [table, (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n]));
  return { dir, db, jobs, events, wakes, url, post, body, counts, login };
}

test('D3 session entry rejects non-session credentials and invalid inputs without rows', async t => {
  const fx = await fixture(t);
  const before = fx.counts();
  for (const token of [null, 'test-secret', 'pc.worker-token', 'forged-session']) {
    assert.equal((await fx.post(fx.body, token)).status, 401);
  }
  for (const [body, room, status] of [
    [fx.body, 'ordinary', 400], [fx.body, 'absent', 400],
    [{ ...fx.body, workspace: path.resolve(fx.dir, '..', 'outside') }, 'room', 403],
    [{ ...fx.body, task_path: 'tasks/../escape.md' }, 'room', 400],
    [{ ...fx.body, task_path: 'tasks/missing.md' }, 'room', 404],
    [{ ...fx.body, dispatch: { ...fx.body.dispatch, return_to_module: 'invalid' } }, 'room', 400],
    [{ ...fx.body, dispatch: { ...fx.body.dispatch, to_module: 'deploy' } }, 'room', 400],
  ] as const) assert.equal((await fx.post(body, fx.login.sessionToken, room)).status, status);
  assert.deepEqual(fx.counts(), before);
  assert.deepEqual(fx.events, []);
  assert.deepEqual(fx.wakes, []);
});

test('ledger creation announces a persisted room change without a model wake', async t => {
  const fx = await fixture(t);
  const res = await fx.post({ task_path: 'tasks/live.md', workspace: fx.dir, requirements: 'Live ledger', title: 'Live' });
  assert.equal(res.status, 201, await res.text());
  assert.ok(fx.events.some(event => Array.isArray(event) && event[0] === 'room-task' && (event[1] as any).roomId === 'room'));
  assert.deepEqual(fx.wakes, []);
});

test('D3 accepts a legacy coordination room (no workflowEnabled flag) like every other workflow check', async t => {
  const fx = await fixture(t);
  const res = await fx.post(fx.body, fx.login.sessionToken, 'legacy');
  assert.equal(res.status, 201, await res.text());
  assert.equal(fx.db.prepare("SELECT COUNT(*) AS n FROM room_tasks WHERE room_id = 'legacy'").get().n, 1);
});

test('D3 direct execute records User anchor and job, creates zero plan/execute turns, duplicate is atomic', async t => {
  const fx = await fixture(t);
  const response = await fx.post(fx.body, fx.login.sessionToken, 'room', true);
  assert.equal(response.status, 201, await response.clone().text());
  const result = await response.json() as any;
  assert.equal(result.task.created_by, 'User');
  assert.match(result.task.requirements, /Original requirements/);
  assert.equal(result.task.owner_module, 'execute');
  assert.equal(result.handoff.from_contact, 'User');
  assert.equal(result.handoff.decided_by, 'User');
  const job = fx.jobs.get(result.job.id)!;
  assert.equal(JSON.parse(job.options).initiatedBy, 'User');
  assert.equal(JSON.parse(job.options).roomTaskReturn, 'review');
  assert.equal(job.requested_by, 'muse');
  const anchor = fx.db.prepare('SELECT * FROM messages WHERE id = ?').get(result.anchorId) as any;
  assert.equal(anchor.sender, 'user');
  assert.equal(anchor.content, '建账：tasks/entry.md');
  assert.equal(result.task.anchor_message_id, anchor.id);
  assert.equal((fx.db.prepare('SELECT COUNT(*) n FROM room_task_turns').get() as any).n, 0);
  assert.deepEqual(fx.wakes, []);
  const before = fx.counts(); const eventCount = fx.events.length;
  assert.equal((await fx.post(fx.body)).status, 409);
  assert.deepEqual(fx.counts(), before);
  assert.equal(fx.events.length, eventCount);
});

test('D3 normal plan/execute dispatch wakes only its recipient after commit; plain creation is quiet', async t => {
  const fx = await fixture(t);
  for (const to_module of ['plan', 'execute']) {
    const res = await fx.post({ ...fx.body, task_path: `tasks/${to_module}.md`, dispatch: { to_module, request: 'Read and perform requirements' } });
    assert.equal(res.status, 201, await res.clone().text());
    const result = await res.json() as any;
    assert.equal(result.handoff.status, 'pending');
    assert.equal(result.job, undefined);
    assert.equal(result.delivery.status, 'posted');
  }
  assert.deepEqual(fx.wakes, ['plan', 'execute']);
  assert.equal((await fx.post({ task_path: 'tasks/plain.md', workspace: fx.dir, requirements: 'Explicit original', title: 'Explicit title' })).status, 201);
  assert.deepEqual(fx.wakes, ['plan', 'execute']);
});

test('D3 startup failure rolls back the anchor, ledger, job and all SSE', async t => {
  const fx = await fixture(t);
  fx.db.exec(`CREATE TRIGGER fail_callback BEFORE INSERT ON room_task_callbacks BEGIN SELECT RAISE(ABORT, 'injected callback failure'); END;`);
  const before = fx.counts();
  assert.equal((await fx.post(fx.body)).status, 500);
  assert.deepEqual(fx.counts(), before);
  assert.deepEqual(fx.events, []);
  assert.deepEqual(fx.wakes, []);
});

test('D3 refuses writes when no session authentication is configured', async t => {
  const fx = await fixture(t, false);
  assert.equal((await fx.post(fx.body, null)).status, 401);
  assert.equal(fx.counts().messages, 0);
});

test('D3 browser form creates a real ledger/job and refreshes with zero model turns', { skip: !process.env.D3_BROWSER_ACCEPTANCE }, async t => {
  const fx = await fixture(t);
  const { createServer } = await import('../../web/node_modules/vite/dist/node/index.js');
  const { default: react } = await import('../../web/node_modules/@vitejs/plugin-react/dist/index.js');
  const { findChrome, launchChromeCdp } = await import('../../web/visual-regression/cdp.mjs');
  const chrome = findChrome(); assert.ok(chrome, 'Chrome required');
  const webRoot = path.resolve(import.meta.dirname, '../../web');
  const vite = await createServer({ root: webRoot, configFile: false, plugins: [react()],
    server: { host: '127.0.0.1', port: 0, proxy: { '/api': fx.url } } });
  await vite.listen();
  t.after(() => vite.close());
  const addr = vite.httpServer!.address() as { port: number };
  const artifacts = path.resolve(process.env.D3_BROWSER_ACCEPTANCE!);
  fs.mkdirSync(artifacts, { recursive: true });
  // A fresh profile avoids reusing a stale DevToolsActivePort on repeated runs.
  const browser = await launchChromeCdp(chrome, path.join(artifacts, `chrome-profile-${process.pid}`));
  try {
    const page = await browser.page(`http://127.0.0.1:${addr.port}/visual-regression/room-task-entry-fixture.html`, 1050, 850);
    const evaluate = async (expression: string) => {
      const result = await page.evaluate(expression);
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const until = async (expression: string) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail(`UI condition timed out: ${expression}`);
    };
    await evaluate(`fetch('/api/session', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:'test-secret'}) }).then(r=>r.json())`);
    await evaluate(`document.querySelector('[aria-label="刷新任务账本"]').click()`);
    await until(`document.querySelector('.room-tasks-count')?.textContent.includes('0 个任务')`);
    await evaluate(`Array.from(document.querySelectorAll('button')).find(el=>el.textContent==='建账并派单').click()`);
    await until(`document.querySelector('[name="workspace"]')?.value`);
    await evaluate(`(() => {
      const input=document.querySelector('[name="task_path"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'tasks/browser-entry.md');
      input.dispatchEvent(new Event('input',{bubbles:true}));
      const request=document.querySelector('[name="request"]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(request,'Implement the original requirements and test');
      request.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    fs.writeFileSync(path.join(artifacts, 'form.png'), Buffer.from((await page.capture()).data, 'base64'));
    await evaluate(`document.querySelector('.room-task-create button[type="submit"]').click()`);
    await until(`document.querySelector('.room-task-head')?.textContent.includes('browser-entry')`);
    assert.match(await evaluate(`document.querySelector('[role="status"]').textContent`), /执行任务已入队/);
    await evaluate(`document.querySelector('.room-task-head').click()`);
    await until(`document.querySelector('[aria-label="尝试"]')?.textContent.includes('尝试 1')`);
    fs.writeFileSync(path.join(artifacts, 'created.png'), Buffer.from((await page.capture()).data, 'base64'));
    const task = fx.db.prepare("SELECT * FROM room_tasks WHERE task_path='tasks/browser-entry.md'").get() as any;
    const linked = fx.db.prepare('SELECT job_id FROM room_task_links WHERE task_id=?').all(task.id);
    assert.equal(linked.length, 1);
    assert.equal((fx.db.prepare('SELECT COUNT(*) n FROM room_task_turns').get() as any).n, 0);
    assert.deepEqual(fx.wakes, []);
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ taskId: task.id, revision: task.revision, linkedJobs: linked.length, planTurns: 0, executeTurns: 0 }));
  } finally { await browser.close(); await vite.close(); }
});

test('VPS-fenced tasks need a baseline at creation, or their first attempt could never be provisioned', async t => {
  // W3: 缺省 baseline 走部署回执 → ls-remote；此处桩全部取不到，保留“要求手填”的拒绝路径。
  const noDefaults = { readReceiptCommit: () => null, readMasterSha: () => null, isAncestorOrEqual: () => false };
  const fx = await fixture(t, true, VPS_TARGETS, noDefaults);
  const vps = { task_path: 'tasks/vps-doc.md', workspace: '/srv/ai-dev/jobs/vps-doc' };
  const before = fx.counts();

  // Missing baseline: refused with the reason, nothing written.
  const missing = await fx.post(vps);
  assert.equal(missing.status, 400);
  assert.match((await missing.json() as { error: string }).error, /baseline_sha/);
  assert.deepEqual(fx.counts(), before, 'a refused VPS create leaves no rows');

  // Malformed baseline: refused at the schema boundary.
  assert.equal((await fx.post({ ...vps, baseline_sha: 'main' })).status, 400);
  assert.equal((await fx.post({ ...vps, baseline_sha: 'a'.repeat(39) })).status, 400);
  assert.deepEqual(fx.counts(), before);

  // Valid baseline: stored on the task, normalised to lower case.
  const sha = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';
  const created = await fx.post({ ...vps, baseline_sha: sha });
  assert.equal(created.status, 201, await created.clone().text());
  const row = fx.db.prepare("SELECT baseline_sha, approved_workspace FROM room_tasks WHERE task_path = 'tasks/vps-doc.md'")
    .get() as { baseline_sha: string; approved_workspace: string };
  assert.equal(row.baseline_sha, sha.toLowerCase());
  assert.equal(row.approved_workspace, '/srv/ai-dev/jobs/vps-doc');
});

test('PC tasks keep learning their baseline from the first attempt (no regression)', async t => {
  const fx = await fixture(t, true, VPS_TARGETS);
  const created = await fx.post({ task_path: 'tasks/pc-task.md', workspace: fx.dir });
  assert.equal(created.status, 201, await created.clone().text());
  const row = fx.db.prepare("SELECT baseline_sha FROM room_tasks WHERE task_path = 'tasks/pc-task.md'")
    .get() as { baseline_sha: string | null };
  assert.equal(row.baseline_sha, null);
});
