import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {
  agendaFingerprint,
  buildAgendaPlan,
  formatAgendaDigest,
  hasAgendaIncrement,
  normalizeAgendaConfig,
  parseAgendaListing,
  sortAgendaItems,
} from './agenda-core.mjs';
import { HubClient } from './triage-clients.mjs';
import { agendaMethods, readAgendaTaskMetadata } from './worker-agenda.mjs';

const TASKS = [
  '## tasks',
  '- **只读审计 worker 状态 P0** (`tasks/audit-worker.md`)',
  '- **修复文档索引 P1** (`tasks/fix-doc-index.md`)',
  '- **升级数据库依赖 P0** (`tasks/upgrade-db-dependency.md`)',
  '- **生产部署并外发消息 P0** (`tasks/production-deploy.md`)',
].join('\n');

const INBOX = [
  '共 2 条待确认：',
  '- **req: 补充语音能力** (`inbox/2026-08-04_req-stt.md`)  [需求, 待拆分, ai-hub]',
  '- **生活事件** (`inbox/2026-08-07_life.md`)  [hub-auto, life_event]',
].join('\n');

function fakeWorker({
  taskText = TASKS,
  inboxText = INBOX,
  jobs = [],
  tasksDir = '',
  sharedState = new Map(),
} = {}) {
  const state = sharedState;
  const dispatches = [];
  const worker = {
    config: {
      coordination: { roomId: 'room-1', hostName: 'DS', tasksDir },
      agenda: normalizeAgendaConfig({}, { roomId: 'room-1', hostName: 'DS', tasksDir }),
    },
    maintenance: null,
    store: {
      getSourceState: (key) => state.get(key) ?? null,
      setSourceState: (key, value) => state.set(key, value),
    },
    vault: {
      enabled: true,
      call: async (name) => {
        assert.equal(name, 'list_inbox');
        return inboxText;
      },
      taskContext: async () => taskText,
    },
    hub: {
      jobs: async () => jobs,
      dispatchRoomHost: async (roomId, input) => {
        dispatches.push({ roomId, input });
        return { messageId: dispatches.length };
      },
    },
    timers: [],
    stopping: false,
  };
  Object.assign(worker, agendaMethods);
  return { worker, state, dispatches };
}

test('Agenda defaults to Shanghai 09:00 and inherits coordination room', () => {
  assert.deepEqual(normalizeAgendaConfig({}, { roomId: 'room-x', hostName: 'host-x' }), {
    enabled: true,
    atHour: 9,
    atMinute: 0,
    roomId: 'room-x',
    hostName: 'host-x',
    maxAuto: 2,
    maxAsk: 3,
    jobsLimit: 300,
    resurfaceDays: 7,
    tasksDir: '',
  });
});

test('deterministic sort is due, P priority, created, then path', () => {
  const items = [
    { path: 'tasks/2026-08-03_c.md', due: null, priority: 0, created: '2026-08-03' },
    { path: 'tasks/2026-08-02_b.md', due: '2026-08-21', priority: 2, created: '2026-08-02' },
    { path: 'tasks/2026-08-01_a.md', due: '2026-08-20', priority: 3, created: '2026-08-01' },
    { path: 'tasks/2026-08-01_d.md', due: '2026-08-21', priority: 1, created: '2026-08-01' },
  ];
  assert.deepEqual(sortAgendaItems(items).map((item) => item.path), [
    'tasks/2026-08-01_a.md',
    'tasks/2026-08-01_d.md',
    'tasks/2026-08-02_b.md',
    'tasks/2026-08-03_c.md',
  ]);
});

test('listing parser recognizes today due and priority without reading task files', () => {
  const [item] = parseAgendaListing(
    '- **今天验收 P1** (`tasks/review.md`) 今天到期',
    'task',
    { today: '2026-08-19' },
  );
  assert.equal(item.due, '2026-08-19');
  assert.equal(item.priority, 1);
});

test('readable task frontmatter mode overrides title guesses and missing mode stays ask', async () => {
  const tasksDir = await mkdtemp(path.join(process.cwd(), '.agenda-mode-'));
  try {
    await writeFile(path.join(tasksDir, 'audit-ask.md'), [
      '---',
      'mode: ask',
      '---',
      '# 只读审计',
    ].join('\n'));
    await writeFile(path.join(tasksDir, 'fix-auto.md'), [
      '---',
      "mode: 'auto'",
      '---',
      '# 修复实现',
    ].join('\n'));
    await writeFile(path.join(tasksDir, 'missing-mode.md'), [
      '---',
      'status: open',
      '---',
      '# 只读审计但未声明 mode',
    ].join('\n'));
    const taskText = [
      '- **只读审计 side channel** (`tasks/audit-ask.md`)',
      '- **修复实现** (`tasks/fix-auto.md`)',
      '- **只读审计 missing** (`tasks/missing-mode.md`)',
      '- **只读审计 unreadable** (`tasks/not-there.md`)',
    ].join('\n');
    const taskMetadata = await readAgendaTaskMetadata(taskText, tasksDir);
    const plan = buildAgendaPlan({
      taskContextText: taskText,
      taskMetadata,
      today: '2026-08-22',
      config: normalizeAgendaConfig({ maxAuto: 2, maxAsk: 3 }),
    });
    assert.deepEqual(plan.wouldAuto.map((item) => item.path), [
      'tasks/fix-auto.md',
      'tasks/not-there.md',
    ]);
    assert.ok(plan.wouldAsk.some((item) => item.path === 'tasks/audit-ask.md' && item.tier === 'T2'));
    assert.ok(plan.wouldAsk.some((item) => item.path === 'tasks/missing-mode.md' && item.tier === 'T2'));
    assert.equal(taskMetadata['tasks/audit-ask.md'].mode, 'ask');
    assert.equal(taskMetadata['tasks/missing-mode.md'].mode, null);
    const priorFingerprint = taskMetadata['tasks/audit-ask.md'].contentFingerprint;
    await writeFile(path.join(tasksDir, 'audit-ask.md'), [
      '---',
      'mode: ask',
      '---',
      '# 只读审计',
      '补充了新的验收边界。',
    ].join('\n'));
    const changedMetadata = await readAgendaTaskMetadata(taskText, tasksDir);
    assert.notEqual(changedMetadata['tasks/audit-ask.md'].contentFingerprint, priorFingerprint);
    const changedPlan = buildAgendaPlan({
      taskContextText: taskText,
      taskMetadata: changedMetadata,
      previousState: plan.sourceState,
      today: '2026-08-22',
      config: normalizeAgendaConfig({ maxAuto: 2, maxAsk: 3 }),
    });
    assert.deepEqual(changedPlan.wouldAsk.map((item) => item.path), ['tasks/audit-ask.md']);
  } finally {
    await rm(tasksDir, { recursive: true, force: true });
  }
});

test('T2/T3 never enter would-auto and caps are enforced', () => {
  const plan = buildAgendaPlan({
    taskContextText: TASKS,
    inboxText: INBOX,
    today: '2026-08-19',
    config: normalizeAgendaConfig({}, { roomId: 'room-1' }),
  });
  assert.equal(plan.wouldAuto.length, 2);
  assert.ok(plan.wouldAuto.every((item) => item.tier === 'T0' || item.tier === 'T1'));
  assert.ok(plan.wouldAuto.every((item) => !/upgrade|deploy/u.test(item.path)));
  assert.ok(plan.wouldAsk.length <= 3);
  assert.ok(plan.wouldAsk.some((item) => item.path.endsWith('upgrade-db-dependency.md') && item.tier === 'T2'));
  assert.ok(plan.wouldAsk.some((item) => item.tier === 'T3'));
  assert.ok(plan.deferred.some((item) => item.path.endsWith('life.md')));
});

test('maintenance or Vault health gate suppresses would-auto', () => {
  const plan = buildAgendaPlan({
    taskContextText: TASKS,
    inboxText: INBOX,
    today: '2026-08-19',
    health: ['memory-vault 未配置'],
    config: normalizeAgendaConfig({}, { roomId: 'room-1' }),
  });
  assert.equal(plan.wouldAuto.length, 0);
  assert.ok(plan.deferred.every((item) => item.reason));
  assert.match(formatAgendaDigest(plan), /health: memory-vault 未配置/u);
});

test('same Shanghai date is idempotent and room dispatch is zero-trigger/capture', async () => {
  const { worker, state, dispatches } = fakeWorker();
  const now = Date.parse('2026-08-19T01:00:00Z');
  const first = await worker.runAgendaShadow(now);
  const second = await worker.runAgendaShadow(now + 60_000);
  assert.equal(first.status, 'dispatched');
  assert.equal(second.status, 'quiet');
  assert.equal(dispatches.length, 1);
  assert.deepEqual(
    {
      roomId: dispatches[0].roomId,
      trigger: dispatches[0].input.trigger,
      capture: dispatches[0].input.capture,
      reactionRounds: dispatches[0].input.reactionRounds,
      idempotencyKey: dispatches[0].input.idempotencyKey,
    },
    {
      roomId: 'room-1',
      trigger: false,
      capture: false,
      reactionRounds: 0,
      idempotencyKey: 'agenda-shadow:v1:2026-08-19',
    },
  );
  assert.equal(JSON.parse(state.get('agenda-shadow:v1:2026-08-19')).status, 'dispatched');
  const incrementState = JSON.parse(state.get('agenda-shadow:v3:increment-state'));
  assert.equal(incrementState.schemaVersion, 3);
  assert.equal(Object.keys(incrementState.items).length, 6);
  assert.deepEqual(incrementState.jobs, {});
});

test('concurrent timer/manual calls share one in-process Agenda run', async () => {
  const { worker, dispatches } = fakeWorker();
  const now = Date.parse('2026-08-19T01:00:00Z');
  const [first, second] = await Promise.all([
    worker.runAgendaShadow(now),
    worker.runAgendaShadow(now),
  ]);
  assert.equal(first.status, 'dispatched');
  assert.equal(second.status, 'dispatched');
  assert.equal(dispatches.length, 1);
});

test('jobs API failure degrades reconcile without blocking task sections', async () => {
  const { worker, dispatches } = fakeWorker();
  worker.hub.jobs = async () => { throw new Error('connect refused'); };
  const result = await worker.runAgendaShadow(Date.parse('2026-08-19T01:00:00Z'));
  assert.equal(result.status, 'dispatched');
  assert.ok(result.plan.wouldAuto.length > 0);
  assert.match(result.plan.health.join('\n'), /jobs API 不可达/u);
  assert.match(dispatches[0].input.content, /connect refused/u);
});

test('unchanged next-day snapshot records quiet state and sends no second digest', async () => {
  const { worker, state, dispatches } = fakeWorker({
    taskText: '- **修复文档索引 P1** (`tasks/fix-doc-index.md`)',
    inboxText: '',
  });
  await worker.runAgendaShadow(Date.parse('2026-08-19T01:00:00Z'));
  const result = await worker.runAgendaShadow(Date.parse('2026-08-20T01:00:00Z'));
  assert.equal(result.status, 'quiet');
  assert.equal(result.reason, 'unchanged fingerprint');
  assert.equal(dispatches.length, 1);
  assert.equal(JSON.parse(state.get('agenda-shadow:v1:2026-08-20')).status, 'quiet');
});

test('unchanged decisions are suppressed while content and due-state changes reappear', () => {
  const initialText = [
    '- **升级数据库依赖** (`tasks/decision.md`) due 2026-08-21',
    '- **范围不清 P1** (`tasks/overflow.md`)',
  ].join('\n');
  const first = buildAgendaPlan({
    taskContextText: initialText,
    today: '2026-08-20',
    config: normalizeAgendaConfig({ maxAsk: 1 }),
  });
  const unchanged = buildAgendaPlan({
    taskContextText: initialText,
    today: '2026-08-20',
    previousState: first.sourceState,
    config: normalizeAgendaConfig({ maxAsk: 1 }),
  });
  assert.equal(unchanged.wouldAsk.length, 0);
  assert.equal(unchanged.deferred.length, 0);
  assert.equal(unchanged.suppressedDecisionCount, 2);
  assert.equal(hasAgendaIncrement(unchanged), false);

  const changed = buildAgendaPlan({
    taskContextText: initialText.replace('范围不清 P1', '范围不清且已补充 P1'),
    today: '2026-08-20',
    previousState: first.sourceState,
    config: normalizeAgendaConfig({ maxAsk: 1 }),
  });
  assert.deepEqual(changed.wouldAsk.map((item) => item.path), ['tasks/overflow.md']);
  assert.match(formatAgendaDigest(changed), /被抑制 1 项/u);

  const dueToday = buildAgendaPlan({
    taskContextText: initialText,
    today: '2026-08-21',
    previousState: first.sourceState,
    config: normalizeAgendaConfig({ maxAsk: 1 }),
  });
  assert.deepEqual(dueToday.wouldAsk.map((item) => item.path), ['tasks/decision.md']);
});

test('priority and tier changes resurface even with a stable content fingerprint', () => {
  const pathName = 'tasks/stable.md';
  const initial = buildAgendaPlan({
    taskContextText: `- **普通事项** (\`${pathName}\`) [P1]`,
    taskMetadata: {
      [pathName]: { readable: true, mode: 'ask', contentFingerprint: 'stable-content' },
    },
    today: '2026-08-20',
  });
  const priorityChanged = buildAgendaPlan({
    taskContextText: `- **普通事项** (\`${pathName}\`) [P2]`,
    taskMetadata: {
      [pathName]: { readable: true, mode: 'ask', contentFingerprint: 'stable-content' },
    },
    previousState: initial.sourceState,
    today: '2026-08-20',
  });
  assert.deepEqual(priorityChanged.wouldAsk.map((item) => item.path), [pathName]);

  const tierChanged = buildAgendaPlan({
    taskContextText: `- **普通事项** (\`${pathName}\`) [P2]`,
    taskMetadata: {
      [pathName]: { readable: true, mode: 'auto', contentFingerprint: 'stable-content' },
    },
    previousState: priorityChanged.sourceState,
    today: '2026-08-20',
  });
  assert.deepEqual(tierChanged.wouldAuto.map((item) => item.path), [pathName]);
});

test('unchanged undated tasks resurface on the configured TTL', () => {
  const taskText = '- **范围不清的长期任务 P1** (`tasks/long-running.md`)';
  const config = normalizeAgendaConfig({ maxAsk: 1, resurfaceDays: 3 });
  const first = buildAgendaPlan({ taskContextText: taskText, today: '2026-08-20', config });
  assert.deepEqual(first.wouldAsk.map((item) => item.path), ['tasks/long-running.md']);

  const dayOne = buildAgendaPlan({
    taskContextText: taskText,
    today: '2026-08-21',
    previousState: first.sourceState,
    config,
  });
  const dayTwo = buildAgendaPlan({
    taskContextText: taskText,
    today: '2026-08-22',
    previousState: dayOne.sourceState,
    config,
  });
  const dayThree = buildAgendaPlan({
    taskContextText: taskText,
    today: '2026-08-23',
    previousState: dayTwo.sourceState,
    config,
  });
  assert.equal(hasAgendaIncrement(dayOne), false);
  assert.equal(hasAgendaIncrement(dayTwo), false);
  assert.deepEqual(dayThree.wouldAsk.map((item) => item.path), ['tasks/long-running.md']);
  assert.equal(dayThree.sourceState.items['task:tasks/long-running.md'].lastShown, '2026-08-23');
});

test('today and overdue tasks resurface on every digest day', () => {
  const taskText = '- **范围不清的到期任务** (`tasks/due.md`) due 2026-08-20';
  const config = normalizeAgendaConfig({ maxAsk: 1, resurfaceDays: 30 });
  const today = buildAgendaPlan({ taskContextText: taskText, today: '2026-08-20', config });
  const overdueOne = buildAgendaPlan({
    taskContextText: taskText,
    today: '2026-08-21',
    previousState: today.sourceState,
    config,
  });
  const overdueTwo = buildAgendaPlan({
    taskContextText: taskText,
    today: '2026-08-22',
    previousState: overdueOne.sourceState,
    config,
  });
  assert.equal(today.wouldAsk.length, 1);
  assert.equal(overdueOne.wouldAsk.length, 1);
  assert.equal(overdueTwo.wouldAsk.length, 1);
});

test('deferred overflow is not marked shown and rotates until every item expands', () => {
  const inboxText = Array.from({ length: 10 }, (_, index) => (
    `- **生活事件 ${index}** (\`inbox/life-${index}.md\`)  [life_event]`
  )).join('\n');
  const first = buildAgendaPlan({ inboxText, today: '2026-08-20' });
  assert.equal(first.deferred.length, 8);
  assert.equal(first.deferredFoldedCount, 2);
  assert.equal(first.sourceState.items['inbox:inbox/life-8.md'].lastShown, null);
  assert.equal(first.sourceState.items['inbox:inbox/life-9.md'].lastShown, null);

  const second = buildAgendaPlan({
    inboxText,
    today: '2026-08-21',
    previousState: first.sourceState,
  });
  assert.deepEqual(second.deferred.map((item) => item.path), [
    'inbox/life-8.md',
    'inbox/life-9.md',
  ]);
  const expanded = new Set([...first.deferred, ...second.deferred].map((item) => item.path));
  assert.equal(expanded.size, 10);

  const third = buildAgendaPlan({
    inboxText,
    today: '2026-08-22',
    previousState: second.sourceState,
  });
  assert.equal(hasAgendaIncrement(third), false);
});

test('v2 fingerprint maps migrate by resurfacing once into v3 notification state', () => {
  const taskText = '- **范围不清的旧任务** (`tasks/legacy.md`)';
  const plan = buildAgendaPlan({
    taskContextText: taskText,
    today: '2026-08-23',
    previousState: {
      items: { 'task:tasks/legacy.md': 'legacy-fingerprint' },
      jobs: {},
      health: '',
    },
  });
  assert.deepEqual(plan.wouldAsk.map((item) => item.path), ['tasks/legacy.md']);
  assert.equal(plan.sourceState.schemaVersion, 3);
  assert.equal(plan.sourceState.items['task:tasks/legacy.md'].lastShown, '2026-08-23');
  assert.equal(typeof plan.sourceState.items['task:tasks/legacy.md'].fp, 'string');
});

test('persisted v3 suppression survives worker restart and resurfaces on day seven', async () => {
  const sharedState = new Map();
  const taskText = '- **范围不清的重启任务** (`tasks/restart.md`)';
  const firstWorker = fakeWorker({ taskText, inboxText: '', sharedState });
  const first = await firstWorker.worker.runAgendaShadow(Date.parse('2026-08-19T01:00:00Z'));
  assert.equal(first.status, 'dispatched');

  const restartedNextDay = fakeWorker({ taskText, inboxText: '', sharedState });
  const quiet = await restartedNextDay.worker.runAgendaShadow(Date.parse('2026-08-20T01:00:00Z'));
  assert.equal(quiet.status, 'quiet');
  assert.equal(restartedNextDay.dispatches.length, 0);

  const restartedDaySeven = fakeWorker({ taskText, inboxText: '', sharedState });
  const resurfaced = await restartedDaySeven.worker.runAgendaShadow(Date.parse('2026-08-26T01:00:00Z'));
  assert.equal(resurfaced.status, 'dispatched');
  assert.equal(restartedDaySeven.dispatches.length, 1);
});

test('reconcile observes expired lease, ghost running, and failed receipt without acting', () => {
  const plan = buildAgendaPlan({
    taskContextText: '- **Known task** (`tasks/known.md`)',
    jobs: [
      { id: 'expired', status: 'running', lease_until: '2026-08-19T00:00:00Z', options: { taskPath: 'tasks/known.md' } },
      { id: 'ghost', status: 'running', lease_until: '2026-08-20T00:00:00Z', options: { taskPath: 'tasks/closed.md' } },
      { id: 'failed', status: 'failed', options: { taskPath: 'tasks/known.md' } },
    ],
    now: Date.parse('2026-08-19T01:00:00Z'),
    today: '2026-08-19',
  });
  assert.deepEqual(plan.reconcile.map((item) => item.id), ['job:expired', 'job:failed', 'job:ghost']);
  assert.match(plan.reconcile[0].reason, /过期/u);
  assert.match(formatAgendaDigest(plan), /幽灵 running/u);
});

test('reconcile rotates unseen overflow, folds repeats, and reopens on status change', () => {
  const jobs = Array.from({ length: 10 }, (_, index) => ({
    id: `j${index}`,
    status: 'failed',
    options: { taskPath: 'tasks/known.md' },
  }));
  const first = buildAgendaPlan({
    taskContextText: '- **Known task** (`tasks/known.md`)',
    jobs,
    today: '2026-08-22',
  });
  assert.equal(first.reconcile.length, 8);
  assert.equal(first.reconcileFoldedCount, 2);

  const unchanged = buildAgendaPlan({
    taskContextText: '- **Known task** (`tasks/known.md`)',
    jobs,
    today: '2026-08-23',
    previousState: first.sourceState,
  });
  assert.deepEqual(unchanged.reconcile.map((item) => item.id), ['job:j8', 'job:j9']);
  assert.equal(unchanged.reconcileFoldedCount, 8);
  assert.equal(hasAgendaIncrement(unchanged), true);

  const allShown = buildAgendaPlan({
    taskContextText: '- **Known task** (`tasks/known.md`)',
    jobs,
    today: '2026-08-24',
    previousState: unchanged.sourceState,
  });
  assert.equal(allShown.reconcile.length, 0);
  assert.equal(allShown.reconcileFoldedCount, 10);
  assert.equal(hasAgendaIncrement(allShown), false);

  const changedJobs = jobs.map((job) => job.id === 'j9' ? { ...job, status: 'blocked' } : job);
  const changed = buildAgendaPlan({
    taskContextText: '- **Known task** (`tasks/known.md`)',
    jobs: changedJobs,
    today: '2026-08-23',
    previousState: allShown.sourceState,
  });
  assert.deepEqual(changed.reconcile.map((item) => item.id), ['job:j9']);
  assert.equal(changed.reconcileFoldedCount, 9);
  assert.match(formatAgendaDigest(changed), /另有 9 项异常状态无变化或未展开/u);
});

test('fold-only counts do not change the displayed-increment fingerprint', () => {
  const base = {
    health: [],
    wouldAuto: [],
    wouldAsk: [],
    deferred: [],
    reconcile: [],
  };
  assert.equal(
    agendaFingerprint({ ...base, suppressedDecisionCount: 1, reconcileFoldedCount: 2 }),
    agendaFingerprint({ ...base, suppressedDecisionCount: 99, reconcileFoldedCount: 300 }),
  );
  assert.notEqual(
    agendaFingerprint({ ...base, wouldAsk: [{ id: 'task:a', title: '旧标题', path: 'tasks/a.md', tier: 'T2' }] }),
    agendaFingerprint({ ...base, wouldAsk: [{ id: 'task:a', title: '新标题', path: 'tasks/a.md', tier: 'T2' }] }),
  );
  assert.equal(
    agendaFingerprint({ ...base, overview: { oldest: { ageDays: 1 } } }),
    agendaFingerprint({ ...base, overview: { oldest: { ageDays: 99 } } }),
  );
});

test('overview reports open, expanded, suppressed, and oldest age without breaking quiet', () => {
  const taskText = [
    '- **范围不清 A** (`tasks/a.md`)',
    '- **范围不清 B** (`tasks/b.md`)',
  ].join('\n');
  const first = buildAgendaPlan({ taskContextText: taskText, today: '2026-08-20' });
  const quiet = buildAgendaPlan({
    taskContextText: taskText,
    today: '2026-08-21',
    previousState: first.sourceState,
  });
  assert.equal(hasAgendaIncrement(quiet), false);
  assert.deepEqual(quiet.overview, {
    openTaskCount: 2,
    expandedTaskCount: 0,
    suppressedTaskCount: 2,
    oldest: {
      title: '范围不清 A',
      path: 'tasks/a.md',
      ageDays: 1,
    },
  });
  assert.match(formatAgendaDigest(quiet), /总览：open 任务 2 项，本次展开 0 项，被抑制 2 项/u);
});

test('HubClient.jobs performs a read-only GET with query params', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jobs: [{ id: 'j1', status: 'running' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const client = new HubClient({ baseUrl: `http://127.0.0.1:${address.port}` });
  try {
    assert.deepEqual(await client.jobs({ limit: 300 }), [{ id: 'j1', status: 'running' }]);
    assert.deepEqual(seen, [{ method: 'GET', url: '/api/jobs?limit=300' }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
