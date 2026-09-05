import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  formatRouteTriageNudge,
  formatRouteTriageStats,
  isAutoDispatchSafeTitle,
  normalizeRouteTriageConfig,
  parseRouteTriageReply,
  parseRouteVetoes,
  resolveRouteSuggestion,
  routeTriageStateKey,
  selectRouteTriageCandidates,
  shanghaiWeekdayOf,
} from './route-triage-core.mjs';
import { shanghaiDateAt, TriageStore } from './triage-core.mjs';
import { migrateTriageDb, TRIAGE_MIGRATIONS } from './triage-migrations.mjs';
import { routeTriageMethods } from './worker-route-triage.mjs';

test('normalizeRouteTriageConfig inherits coordination and validates', () => {
  const config = normalizeRouteTriageConfig({}, { roomId: 'room-9', hostName: 'DS' });
  assert.equal(config.enabled, false);
  assert.equal(config.roomId, 'room-9');
  assert.equal(config.hostName, 'DS');
  assert.equal(config.reviewer, 'aye');
  assert.deepEqual(config.allowedRecipients, ['claude', 'codex', 'aye']);
  assert.equal(config.atMinute, 10);
  assert.equal(config.statsWeekday, 1);
  const custom = normalizeRouteTriageConfig({
    enabled: true,
    roomId: 'room-x',
    reviewer: 'Codex',
    allowedRecipients: ['Claude', 'codex'],
  }, {});
  assert.equal(custom.reviewer, 'codex');
  assert.deepEqual(custom.allowedRecipients, ['claude', 'codex']);
  assert.throws(() => normalizeRouteTriageConfig({ atHour: 99 }, {}), /atHour/);
  assert.throws(() => normalizeRouteTriageConfig({ reviewer: ' ' }, {}), /reviewer/);
});

const TASK_LISTING = [
  '## tasks',
  '- **复杂改造 alpha P1** (`tasks/2026-08-20_alpha.md`)',
  '- **已有归属 beta** (`tasks/2026-08-21_beta.md`)',
  '- **尾巴任务** (`tasks/worker-tail-old.md`)',
  '- **读不到的任务** (`tasks/2026-08-22_gamma.md`)',
  '- **待定 delta** (`tasks/2026-08-23_delta.md`)',
].join('\n');

const METADATA = {
  'tasks/2026-08-20_alpha.md': { readable: true, executor: '', verifier: '' },
  'tasks/2026-08-21_beta.md': { readable: true, executor: 'codex', verifier: '' },
  'tasks/2026-08-23_delta.md': { readable: true, executor: '', verifier: '' },
};

test('selectRouteTriageCandidates keeps only provably unrouted open tasks', () => {
  const { candidates, foldedCount, skipped } = selectRouteTriageCandidates({
    taskContextText: TASK_LISTING,
    taskMetadata: METADATA,
    pendingPaths: ['tasks/2026-08-23_delta.md'],
    today: '2026-08-30',
    maxItems: 8,
  });
  assert.deepEqual(candidates.map((item) => item.path), ['tasks/2026-08-20_alpha.md']);
  assert.equal(foldedCount, 0);
  assert.deepEqual(skipped, { tail: 1, routed: 1, unreadable: 1, pending: 1 });
});

test('selectRouteTriageCandidates folds beyond maxItems', () => {
  const { candidates, foldedCount } = selectRouteTriageCandidates({
    taskContextText: TASK_LISTING,
    taskMetadata: METADATA,
    maxItems: 1,
  });
  assert.equal(candidates.length, 1);
  assert.equal(foldedCount, 1);
});

test('formatRouteTriageNudge names reviewer, tasks and the reply contract', () => {
  const nudge = formatRouteTriageNudge({
    date: '2026-08-30',
    reviewer: 'aye',
    candidates: [{ title: '复杂改造 alpha', path: 'tasks/2026-08-20_alpha.md', tags: ['ai-hub'], due: '2026-09-01', priority: 1 }],
    foldedCount: 2,
    allowedRecipients: ['claude', 'codex', 'aye'],
  });
  assert.match(nudge, /^@aye 路由初筛征集 · 2026-08-30/);
  assert.match(nudge, /tasks\/2026-08-20_alpha\.md/);
  assert.match(nudge, /due 2026-09-01/);
  assert.match(nudge, /另有 2 条/);
  assert.match(nudge, /\[ROUTE\] tasks\/<file>\.md \| stage=<plan\|execute\|review\|maintenance> \| to=<claude\|codex\|aye>/);
  assert.match(nudge, /不是 coordination 派单/);
});

test('parseRouteTriageReply accepts valid lines and rejects the rest', () => {
  const reply = [
    '收到，我的初筛：',
    '- [ROUTE] tasks/2026-08-20_alpha.md | stage=plan | to=claude | 需要先出 Plan',
    '[ROUTE] `tasks/2026-08-23_delta.md` | stage=execute | to=codex | 单文件小修',
    '[HOLD] tasks/2026-08-24_epsilon.md | 范围不清',
    '[ROUTE] tasks/2026-08-25_unknown.md | stage=execute | to=codex | 不在候选集',
    '[ROUTE] tasks/2026-08-20_alpha.md | stage=execute | to=aye | 重复路径',
    '[route] tasks/2026-08-24_epsilon.md | stage=deploy | to=codex | stage 非法',
  ].join('\n');
  const parsed = parseRouteTriageReply(reply, {
    candidatePaths: [
      'tasks/2026-08-20_alpha.md',
      'tasks/2026-08-23_delta.md',
      'tasks/2026-08-24_epsilon.md',
    ],
    allowedRecipients: ['claude', 'codex', 'aye'],
  });
  assert.deepEqual(parsed.suggestions, [
    { path: 'tasks/2026-08-20_alpha.md', stage: 'plan', recipient: 'claude', reason: '需要先出 Plan' },
    { path: 'tasks/2026-08-23_delta.md', stage: 'execute', recipient: 'codex', reason: '单文件小修' },
  ]);
  assert.deepEqual(parsed.holds, [{ path: 'tasks/2026-08-24_epsilon.md', reason: '范围不清' }]);
  assert.equal(parsed.invalid.length, 3);
});

test('resolveRouteSuggestion covers every deterministic outcome', () => {
  const suggestion = { recipient: 'claude', createdAt: 0 };
  assert.equal(
    resolveRouteSuggestion({ suggestion, current: { exists: false, open: false } }).status,
    'closed',
  );
  assert.deepEqual(
    resolveRouteSuggestion({ suggestion, current: { exists: true, open: true, executor: 'Claude' } }),
    { status: 'followed', resolvedRecipient: 'claude', resolvedVia: 'frontmatter' },
  );
  assert.deepEqual(
    resolveRouteSuggestion({ suggestion, current: { exists: true, open: true, executor: 'codex' } }),
    { status: 'overridden', resolvedRecipient: 'codex', resolvedVia: 'frontmatter' },
  );
  assert.deepEqual(
    resolveRouteSuggestion({
      suggestion,
      current: { exists: true, open: true, executor: '' },
      dispatchRecipient: 'codex',
    }),
    { status: 'overridden', resolvedRecipient: 'codex', resolvedVia: 'backlog-dispatch' },
  );
  assert.equal(
    resolveRouteSuggestion({
      suggestion: { recipient: 'claude', createdAt: 0 },
      current: { exists: true, open: true, executor: '' },
      now: 31 * 86_400_000,
      maxAgeDays: 30,
    }).status,
    'expired',
  );
  assert.equal(
    resolveRouteSuggestion({
      suggestion: { recipient: 'claude', createdAt: Date.now() },
      current: { exists: true, open: true, executor: '' },
    }).status,
    'pending',
  );
});

test('formatRouteTriageStats reports override rate and stays quiet on empty', () => {
  assert.equal(formatRouteTriageStats({
    date: '2026-08-31',
    windowDays: 28,
    stats: { pending: 0, followed: 0, overridden: 0, closed: 0, expired: 0, byRecipient: {} },
  }), null);
  const text = formatRouteTriageStats({
    date: '2026-08-31',
    windowDays: 28,
    stats: {
      pending: 2,
      followed: 3,
      overridden: 1,
      closed: 1,
      expired: 0,
      byRecipient: { claude: { followed: 2, overridden: 1 }, codex: { followed: 1, overridden: 0 } },
    },
  });
  assert.match(text, /近 28 天/);
  assert.match(text, /采纳 3 ｜ 改派 1/);
  assert.match(text, /改派率：25%（改派 1\/4）/);
  assert.match(text, /claude 采纳 2\/改派 1；codex 采纳 1\/改派 0/);
});

test('shanghaiWeekdayOf maps dates to UTC weekday of the Shanghai date string', () => {
  assert.equal(shanghaiWeekdayOf('2026-08-31'), 1); // Monday
  assert.equal(shanghaiWeekdayOf('2026-08-30'), 0); // Sunday
  assert.equal(shanghaiWeekdayOf('not-a-date'), null);
});

async function makeWorker({ statsWeekday, autoDispatch, roomMessages, roomRoundResult } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'route-triage-'));
  const tasksDir = path.join(dir, 'tasks');
  await mkdir(tasksDir, { recursive: true });
  await writeFile(path.join(tasksDir, '2026-08-20_alpha.md'), [
    '---',
    'status: open',
    '---',
    '# 复杂改造 alpha',
  ].join('\n'));
  await writeFile(path.join(tasksDir, '2026-08-21_beta.md'), [
    '---',
    'status: open',
    'executor: codex',
    '---',
    '# 已有归属 beta',
  ].join('\n'));
  await writeFile(path.join(tasksDir, '2026-08-22_gamma.md'), [
    '---',
    'status: done',
    '---',
    '# 已关闭 gamma',
  ].join('\n'));
  const store = new TriageStore(path.join(dir, 'triage.db'));
  const hostDispatches = [];
  const worker = Object.assign(Object.create(routeTriageMethods), {
    maintenance: null,
    store,
    nextRouteResolveAt: 0,
    config: {
      coordination: { roomId: 'room-1', hostName: 'DS 主持', tasksDir },
      routeTriage: normalizeRouteTriageConfig({
        enabled: true,
        ...(statsWeekday === undefined ? {} : { statsWeekday }),
        ...(autoDispatch === undefined ? {} : { autoDispatch }),
      }, { roomId: 'room-1', hostName: 'DS 主持' }),
    },
    coordinationConfig() {
      return this.config.coordination;
    },
    proactiveConfig: () => ({ silentStartHour: 0, silentEndHour: 0 }),
    coordinationPolicy: () => ({ poolFull: false }),
    claims: {},
    backlogClaims() {
      return this.claims;
    },
    claimBacklogTask(taskPath, eventId) {
      this.claims[taskPath] = { eventId, claimedAt: Date.now() };
    },
    releaseBacklogClaim(taskPath, eventId) {
      const claim = this.claims[taskPath];
      if (!claim || claim.eventId !== eventId) return false;
      delete this.claims[taskPath];
      return true;
    },
    enqueue(event) {
      return this.store.enqueue(event);
    },
    vault: {
      enabled: true,
      taskContext: async () => [
        '## tasks',
        '- **复杂改造 alpha P1** (`tasks/2026-08-20_alpha.md`)',
        '- **已有归属 beta** (`tasks/2026-08-21_beta.md`)',
        '- **已关闭 gamma** (`tasks/2026-08-22_gamma.md`)',
        '- **尾巴任务** (`tasks/worker-tail-old.md`)',
      ].join('\n'),
    },
    hub: {
      hostDispatches,
      dispatchRoomHost: async (roomId, input) => {
        hostDispatches.push({ roomId, input });
        return { messageId: 500 + hostDispatches.length, roundId: `round-${hostDispatches.length}` };
      },
      waitRoomRound: async () => ({ status: 'done', outcome: 'completed' }),
      roomRound: async () => roomRoundResult ?? {
        status: 'done',
        outcome: { normal: { spoke: 1, passed: 0, silent: 0, error: 0 }, reactions: [] },
      },
      messages: async () => roomMessages ?? [
        { kind: 'text', status: 'done', sender: 'codex', content: '[PASS]' },
        {
          kind: 'text',
          status: 'done',
          sender: 'aye',
          content: '[ROUTE] tasks/2026-08-20_alpha.md | stage=plan | to=claude | 复杂改造需要 Plan',
        },
      ],
    },
  });
  return {
    worker,
    store,
    tasksDir,
    hostDispatches,
    async cleanup() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('route triage scan → nudge round → suggestion ledger, idempotent per day', async () => {
  const { worker, store, hostDispatches, cleanup } = await makeWorker();
  try {
    const scan = await worker.runRouteTriageScan();
    assert.equal(scan.status, 'queued');
    const again = await worker.runRouteTriageScan();
    assert.equal(again.reason, 'Shanghai date already settled');

    const event = store.claim();
    assert.equal(event.source, 'route-triage');
    await worker.processRouteTriage(event);

    assert.equal(hostDispatches.length, 1);
    const nudge = hostDispatches[0];
    assert.equal(nudge.roomId, 'room-1');
    assert.deepEqual(nudge.input.targetIds, ['aye']);
    assert.match(nudge.input.content, /tasks\/2026-08-20_alpha\.md/);
    assert.doesNotMatch(nudge.input.content, /2026-08-21_beta/);

    const pending = store.pendingRouteSuggestions();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].item_path, 'tasks/2026-08-20_alpha.md');
    assert.equal(pending[0].recipient, 'claude');
    assert.equal(pending[0].stage, 'plan');

    const state = JSON.parse(store.getSourceState(routeTriageStateKey(scan.date)));
    assert.equal(state.status, 'dispatched');
    assert.equal(state.suggested, 1);

    // 同任务已有 pending 建议：再扫一天也不会重复征集。
    const rescan = await worker.collectRouteTriageCandidates(worker.routeTriageConfig(), scan.date);
    assert.equal(rescan.candidates.length, 0);
  } finally {
    await cleanup();
  }
});

test('resolution labels overridden via frontmatter and posts weekly stats', async () => {
  const today = shanghaiDateAt(Date.now(), 0);
  const { worker, store, tasksDir, hostDispatches, cleanup } = await makeWorker({
    statsWeekday: shanghaiWeekdayOf(today),
  });
  try {
    await worker.runRouteTriageScan();
    await worker.processRouteTriage(store.claim());
    // User 把任务实际派给了 codex（写 executor），建议是 claude → overridden。
    await writeFile(path.join(tasksDir, '2026-08-20_alpha.md'), [
      '---',
      'status: open',
      'executor: codex',
      '---',
      '# 复杂改造 alpha',
    ].join('\n'));
    const worked = await worker.resolveRouteSuggestionsIfDue(Date.now());
    assert.equal(worked, true);
    assert.equal(store.pendingRouteSuggestions().length, 0);
    const stats = store.routeSuggestionStats(0);
    assert.equal(stats.overridden, 1);
    assert.deepEqual(stats.byRecipient.claude, { followed: 0, overridden: 1 });

    const statsPost = hostDispatches.find(({ input }) => /改派率/.test(input.content));
    assert.ok(statsPost, 'weekly stats should be posted to the room');
    assert.equal(statsPost.input.trigger, false);
    assert.equal(statsPost.input.capture, false);
    assert.match(statsPost.input.content, /改派 1\/1/);

    // 同日重复对账不再重复贴统计。
    worker.nextRouteResolveAt = 0;
    await worker.resolveRouteSuggestionsIfDue(Date.now());
    assert.equal(
      hostDispatches.filter(({ input }) => /改派率/.test(input.content)).length,
      1,
    );
  } finally {
    await cleanup();
  }
});

test('late harvest picks up a delayed reviewer reply exactly once', async () => {
  const today = shanghaiDateAt(Date.now(), 0);
  const { worker, store, cleanup } = await makeWorker();
  try {
    // 轮次窗口内 reviewer 后端崩了：状态 dispatched 但 0 条建议（首日真实事故形态）。
    store.setSourceState(routeTriageStateKey(today), JSON.stringify({
      status: 'dispatched',
      date: today,
      eventId: 'event-1',
      messageId: 501,
      candidatePaths: ['tasks/2026-08-20_alpha.md'],
      suggested: 0,
      held: 0,
      invalid: 0,
    }));
    const harvested = await worker.harvestLateRouteRepliesIfNeeded(Date.now());
    assert.equal(harvested, true);
    const pending = store.pendingRouteSuggestions();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].recipient, 'claude');
    assert.equal(pending[0].message_id, 501);
    const state = JSON.parse(store.getSourceState(routeTriageStateKey(today)));
    assert.equal(state.suggested, 1);
    assert.equal(state.lateHarvested, true);
    // 第二次不再补收，也不重复插行。
    assert.equal(await worker.harvestLateRouteRepliesIfNeeded(Date.now()), false);
    assert.equal(store.pendingRouteSuggestions().length, 1);
  } finally {
    await cleanup();
  }
});

test('late harvest stays quiet without state, replies, or when round already parsed', async () => {
  const today = shanghaiDateAt(Date.now(), 0);
  const { worker, store, cleanup } = await makeWorker();
  try {
    assert.equal(await worker.harvestLateRouteRepliesIfNeeded(Date.now()), false);
    // 轮次内已解析出建议的日子不补收。
    store.setSourceState(routeTriageStateKey(today), JSON.stringify({
      status: 'dispatched',
      messageId: 501,
      candidatePaths: ['tasks/2026-08-20_alpha.md'],
      suggested: 2,
    }));
    assert.equal(await worker.harvestLateRouteRepliesIfNeeded(Date.now()), false);
    // 有状态但 reviewer 还没回（消息里没有他的合法行）：保持等待，不落 lateHarvested。
    store.setSourceState(routeTriageStateKey(today), JSON.stringify({
      status: 'dispatched',
      messageId: 501,
      candidatePaths: ['tasks/2026-08-21_beta.md'],
      suggested: 0,
    }));
    assert.equal(await worker.harvestLateRouteRepliesIfNeeded(Date.now()), false);
    assert.equal(
      JSON.parse(store.getSourceState(routeTriageStateKey(today))).lateHarvested,
      undefined,
    );
  } finally {
    await cleanup();
  }
});

test('route suggestion summary is exposed for health metrics', async () => {
  const { worker, store, cleanup } = await makeWorker();
  try {
    await worker.runRouteTriageScan();
    await worker.processRouteTriage(store.claim());
    const summary = store.routeSuggestionSummary();
    assert.equal(summary.pending, 1);
    assert.equal(typeof summary.lastSuggestedAt, 'string');
    assert.equal(store.dailySummary().routeSuggestions.pending, 1);
  } finally {
    await cleanup();
  }
});

test('autoDispatch config defaults, veto parsing and the T3 safety gate', () => {
  const config = normalizeRouteTriageConfig({ enabled: true }, { roomId: 'room-1' });
  assert.equal(config.autoDispatch.enabled, false);
  assert.equal(config.autoDispatch.delayMinutes, 60);
  assert.equal(config.autoDispatch.maxAgeHours, 48);
  assert.equal(config.autoDispatch.dailyLimit, 3);
  assert.deepEqual(config.autoDispatch.vetoSenders, ['user', 'claude']);
  assert.throws(
    () => normalizeRouteTriageConfig({ autoDispatch: { delayMinutes: 1 } }, {}),
    /delayMinutes/,
  );

  const vetoes = parseRouteVetoes([
    { kind: 'text', status: 'done', sender: 'user', content: '别派这个\n[VETO] tasks/a.md | 我自己来' },
    { kind: 'text', status: 'done', sender: 'claude', content: '- [VETO] `tasks/b.md` | 范围不对' },
    { kind: 'text', status: 'done', sender: 'codex', content: '[VETO] tasks/a.md | 无权否决' },
    { kind: 'text', status: 'done', sender: 'user', content: '[VETO] tasks/unknown.md | 路径不在集合' },
    { kind: 'thinking', status: 'done', sender: 'user', content: '[VETO] tasks/b.md' },
  ], { paths: ['tasks/a.md', 'tasks/b.md'], vetoSenders: ['user', 'claude'] });
  assert.deepEqual(vetoes.map((veto) => [veto.path, veto.sender]), [
    ['tasks/a.md', 'user'],
    ['tasks/b.md', 'claude'],
  ]);

  assert.equal(isAutoDispatchSafeTitle('修复文档索引'), true);
  assert.equal(isAutoDispatchSafeTitle('生产部署 新版本'), false);
  assert.equal(isAutoDispatchSafeTitle('轮换 凭据'), false);
});

test('nudge advertises the veto window only when autoDispatch is on', () => {
  const base = {
    date: '2026-09-01',
    reviewer: 'aye',
    candidates: [{ title: 'A', path: 'tasks/a.md', tags: [], due: null, priority: 4 }],
  };
  const off = formatRouteTriageNudge(base);
  assert.doesNotMatch(off, /VETO/);
  const on = formatRouteTriageNudge({
    ...base,
    autoDispatch: { enabled: true, delayMinutes: 60 },
  });
  assert.match(on, /60 分钟后/);
  assert.match(on, /\[VETO\] tasks\/<file>\.md/);
});

test('stats formatter reports auto-dispatch and veto counts', () => {
  const text = formatRouteTriageStats({
    date: '2026-09-07',
    windowDays: 28,
    stats: {
      pending: 1,
      followed: 2,
      overridden: 1,
      closed: 0,
      expired: 0,
      dispatched: 3,
      vetoed: 1,
      byRecipient: { codex: { followed: 1, overridden: 0 } },
    },
  });
  assert.match(text, /自动派单 3 ｜ 被否决 1/);
  assert.match(text, /自动路径否决率：25%（否决 1\/4）/);
});

test('migration v11 preserves v9 rows and accepts route-auto terminal statuses', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'route-triage-mig-'));
  const db = new DatabaseSync(path.join(dir, 'triage.db'));
  try {
    migrateTriageDb(db, TRIAGE_MIGRATIONS.filter((migration) => migration.version <= 9));
    db.prepare(`
      INSERT INTO route_suggestions
        (item_path, kind, suggest_date, stage, recipient, reason, created_at)
      VALUES ('tasks/x.md', 'task', '2026-08-30', 'plan', 'claude', 'why', 1)
    `).run();
    const result = migrateTriageDb(db);
    assert.equal(result.to, 11);
    const row = db.prepare('SELECT * FROM route_suggestions WHERE item_path = ?').get('tasks/x.md');
    assert.equal(row.status, 'pending');
    assert.equal(row.recipient, 'claude');
    db.prepare(`
      UPDATE route_suggestions SET status = 'dispatched' WHERE item_path = 'tasks/x.md'
    `).run();
    db.prepare(`
      UPDATE route_suggestions SET status = 'passed' WHERE item_path = 'tasks/x.md'
    `).run();
    assert.throws(() => db.prepare(`
      UPDATE route_suggestions SET status = 'nonsense' WHERE item_path = 'tasks/x.md'
    `).run(), /CHECK/);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const AUTO = { enabled: true, delayMinutes: 5, maxAgeHours: 48, dailyLimit: 3 };

function seedSuggestion(store, {
  path: itemPath,
  stage = 'execute',
  recipient = 'codex',
  messageId = 501,
  ageMs = 10 * 60_000,
} = {}) {
  return store.insertRouteSuggestions([{
    path: itemPath,
    kind: 'task',
    suggestDate: shanghaiDateAt(Date.now(), 0),
    stage,
    recipient,
    reason: 'seeded',
    eventId: null,
    messageId,
  }], Date.now() - ageMs);
}

test('auto-dispatch fires after the veto window and claims the path', async () => {
  const { worker, store, hostDispatches, cleanup } = await makeWorker({
    autoDispatch: AUTO,
    roomMessages: [{ kind: 'text', status: 'done', sender: 'aye', content: '闲聊，无否决' }],
  });
  try {
    seedSuggestion(store, { path: 'tasks/2026-08-20_alpha.md', stage: 'execute', recipient: 'codex' });
    const acted = await worker.autoDispatchRouteSuggestionsIfDue(Date.now());
    assert.equal(acted, true);
    assert.equal(hostDispatches.length, 1);
    const dispatch = hostDispatches[0];
    assert.deepEqual(dispatch.input.targetIds, ['codex']);
    assert.match(dispatch.input.content, /^@codex 路由派单/);
    assert.match(dispatch.input.content, /tasks\/2026-08-20_alpha\.md/);
    assert.match(dispatch.input.content, /delegate_to_worker/);
    const row = store.db.prepare(
      "SELECT status, resolved_recipient, resolved_via FROM route_suggestions WHERE item_path = 'tasks/2026-08-20_alpha.md'",
    ).get();
    assert.equal(row.status, 'dispatched');
    assert.equal(row.resolved_recipient, 'codex');
    assert.equal(row.resolved_via, 'auto-dispatch');
    assert.ok(worker.claims['tasks/2026-08-20_alpha.md']);
    // 幂等：再跑一轮不再派。
    assert.equal(await worker.autoDispatchRouteSuggestionsIfDue(Date.now()), false);
    assert.equal(hostDispatches.length, 1);
  } finally {
    await cleanup();
  }
});

test('route-auto round with spoke=0 releases its claim, marks passed and leaves task open', async () => {
  const { worker, store, cleanup } = await makeWorker({
    autoDispatch: AUTO,
    roomMessages: [],
    roomRoundResult: {
      status: 'done',
      outcome: { normal: { spoke: 0, passed: 1, silent: 0, error: 0 }, reactions: [] },
    },
  });
  try {
    seedSuggestion(store, { path: 'tasks/2026-08-20_alpha.md' });
    await worker.autoDispatchRouteSuggestionsIfDue(Date.now());
    assert.ok(worker.claims['tasks/2026-08-20_alpha.md']);

    const result = await worker.reconcileRouteAutoDispatches(Date.now());
    assert.equal(result.checked, 1);
    assert.equal(result.passed, 1);
    assert.equal(result.released, 1);
    assert.deepEqual(result.settledPaths, ['tasks/2026-08-20_alpha.md']);
    assert.deepEqual(result.remainingClaimPaths, []);
    assert.equal(worker.claims['tasks/2026-08-20_alpha.md'], undefined);
    const row = store.db.prepare(
      "SELECT status, resolved_via FROM route_suggestions WHERE item_path = 'tasks/2026-08-20_alpha.md'",
    ).get();
    assert.equal(row.status, 'passed');
    assert.equal(row.resolved_via, 'auto-dispatch-no-spoke');
    assert.equal(worker.routeTaskCurrentState('tasks/2026-08-20_alpha.md').open, true);
  } finally {
    await cleanup();
  }
});

test('legacy dispatched suggestion discovers its finished round and clears the stuck claim', async () => {
  const legacyHost = {
    id: 777,
    sender: 'room-host',
    meta: JSON.stringify({
      roomHost: {
        idempotencyKey: 'route-auto:v1:tasks/2026-08-20_alpha.md:2026-09-03',
        roundId: 'legacy-round',
      },
    }),
  };
  const { worker, store, cleanup } = await makeWorker({
    autoDispatch: AUTO,
    roomMessages: [legacyHost],
    roomRoundResult: {
      status: 'done',
      outcome: { normal: { spoke: 0, passed: 1, silent: 0, error: 0 }, reactions: [] },
    },
  });
  try {
    store.insertRouteSuggestions([{
      path: 'tasks/2026-08-20_alpha.md',
      kind: 'task',
      suggestDate: '2026-09-03',
      stage: 'execute',
      recipient: 'aye',
      reason: 'legacy fixture',
      messageId: 501,
    }], Date.now() - 10 * 60_000);
    const seeded = store.db.prepare(
      "SELECT id FROM route_suggestions WHERE item_path = 'tasks/2026-08-20_alpha.md'",
    ).get();
    store.resolveRouteSuggestionRow(seeded.id, 'dispatched', {
      resolvedRecipient: 'aye',
      resolvedVia: 'auto-dispatch',
    });
    worker.claims['tasks/2026-08-20_alpha.md'] = {
      eventId: `route-auto:${seeded.id}`,
      claimedAt: Date.now(),
    };

    const result = await worker.reconcileRouteAutoDispatches(Date.now());
    assert.equal(result.checked, 1);
    assert.equal(result.passed, 1);
    assert.equal(result.released, 1);
    assert.deepEqual(result.passedPaths, ['tasks/2026-08-20_alpha.md']);
    assert.deepEqual(result.remainingClaimPaths, []);
    const row = store.db.prepare(
      "SELECT status, dispatch_message_id, dispatch_round_id FROM route_suggestions WHERE id = ?",
    ).get(seeded.id);
    assert.equal(row.status, 'passed');
    assert.equal(row.dispatch_message_id, 777);
    assert.equal(row.dispatch_round_id, 'legacy-round');
    assert.equal(worker.claims['tasks/2026-08-20_alpha.md'], undefined);
    assert.equal(worker.routeTaskCurrentState('tasks/2026-08-20_alpha.md').open, true);
  } finally {
    await cleanup();
  }
});

test('a veto line inside the window marks the suggestion vetoed instead of dispatching', async () => {
  const { worker, store, hostDispatches, cleanup } = await makeWorker({
    autoDispatch: AUTO,
    roomMessages: [
      { kind: 'text', status: 'done', sender: 'claude', content: '[VETO] tasks/2026-08-20_alpha.md | 我另有安排' },
    ],
  });
  try {
    seedSuggestion(store, { path: 'tasks/2026-08-20_alpha.md' });
    const acted = await worker.autoDispatchRouteSuggestionsIfDue(Date.now());
    assert.equal(acted, true);
    assert.equal(hostDispatches.length, 0);
    const row = store.db.prepare(
      "SELECT status, resolved_via FROM route_suggestions WHERE item_path = 'tasks/2026-08-20_alpha.md'",
    ).get();
    assert.equal(row.status, 'vetoed');
    assert.equal(row.resolved_via, 'veto:claude');
  } finally {
    await cleanup();
  }
});

test('safety gates hold T3 titles, mode:ask, young rows and respect the daily limit', async () => {
  const { worker, store, tasksDir, hostDispatches, cleanup } = await makeWorker({
    autoDispatch: { ...AUTO, dailyLimit: 1 },
    roomMessages: [],
  });
  try {
    await writeFile(path.join(tasksDir, '2026-09-01_deploy.md'), [
      '---',
      'status: open',
      '---',
      '# 生产部署 新版本',
    ].join('\n'));
    await writeFile(path.join(tasksDir, '2026-09-01_ask.md'), [
      '---',
      'status: open',
      'mode: ask',
      '---',
      '# 需要 User 拍板的事',
    ].join('\n'));
    await writeFile(path.join(tasksDir, '2026-09-01_plain.md'), [
      '---',
      'status: open',
      '---',
      '# 普通小修',
    ].join('\n'));
    seedSuggestion(store, { path: 'tasks/2026-09-01_deploy.md' });
    seedSuggestion(store, { path: 'tasks/2026-09-01_ask.md' });
    seedSuggestion(store, { path: 'tasks/2026-08-20_alpha.md', stage: 'plan', recipient: 'claude' });
    seedSuggestion(store, { path: 'tasks/2026-09-01_plain.md' });
    // 否决窗口未满的新建议不动。
    seedSuggestion(store, { path: 'tasks/2026-08-21_beta.md', ageMs: 60_000 });

    await worker.autoDispatchRouteSuggestionsIfDue(Date.now());
    // dailyLimit=1：T3 与 mode:ask 被安全闸拦下后，第一条合格行（plan → claude 的 alpha）派出。
    assert.equal(hostDispatches.length, 1);
    assert.deepEqual(hostDispatches[0].input.targetIds, ['claude']);
    assert.match(hostDispatches[0].input.content, /Plan 征集/);
    const statuses = Object.fromEntries(store.db.prepare(
      'SELECT item_path, status FROM route_suggestions',
    ).all().map((row) => [row.item_path, row.status]));
    assert.equal(statuses['tasks/2026-08-20_alpha.md'], 'dispatched');
    assert.equal(statuses['tasks/2026-09-01_deploy.md'], 'pending');
    assert.equal(statuses['tasks/2026-09-01_ask.md'], 'pending');
    assert.equal(statuses['tasks/2026-09-01_plain.md'], 'pending');
    assert.equal(statuses['tasks/2026-08-21_beta.md'], 'pending');
  } finally {
    await cleanup();
  }
});
