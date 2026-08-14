import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  buildDispatchableTaskContext,
  buildDailyCheckSummary,
  buildIdeaDiaryRequest,
  buildTaskReminders,
  classifyOutcomeMessage,
  chooseRecipient,
  coordinationPolicyState,
  coordinationWorkerPrompt,
  dailyPolicyState,
  DELIVERY_POOL_DAILY,
  DELIVERY_POOL_COORDINATION,
  DELIVERY_POOL_IDEA,
  DELIVERY_POOL_TASK,
  EXECUTED_VIA_CONTACT,
  EXECUTED_VIA_NONE,
  EXECUTED_VIA_WORKER,
  estimateCostCny,
  executionDispatchKey,
  executionFingerprint,
  formatCoordinationDispatchBlock,
  formatTaskReminderRoomNotice,
  formatVerificationDispatchBlock,
  isShanghaiSilentHour,
  isTaskCompletionMessage,
  isTaskReminderMode,
  ideaPolicyState,
  linkedReworkTail,
  nextTimerDelay,
  normalizeEvent,
  normalizeIdeaConfig,
  normalizeCoordinationConfig,
  normalizeOutcomeConfig,
  normalizeProactiveConfig,
  normalizeTaskReminderConfig,
  OUTCOME_LABEL_ACCEPTED,
  OUTCOME_LABEL_ENGAGED,
  OUTCOME_LABEL_REJECTED,
  OUTCOME_LABEL_REWORKED,
  OUTCOME_LABEL_UNKNOWN,
  parseTriageJson,
  parseCoordinationTask,
  parseVaultInboxList,
  parseVerificationTask,
  planHubAutoHygiene,
  shanghaiClock,
  summarizeTaskContext,
  taskReminderRoomRoute,
  timerSchedule,
  TriageStore,
  validateTriageMode,
  verificationDispatchKey,
  legacyExecutionDispatchKey,
  legacyVerificationDispatchKey,
} from './triage-core.mjs';
import { DeepSeekClient, HubClient, VaultClient } from './triage-clients.mjs';
import {
  evaluateFollowupGate,
  formatFollowupDispatchBlock,
  matchesAbsenceKeyword,
  normalizeAbsenceExtract,
  normalizeFollowupConfig,
} from './followups.mjs';
import { listenOnFetchSafePort } from './test-http.mjs';

test('strict triage JSON accepts the contract and rejects invalid priority/category', () => {
  const parsed = parseTriageJson(JSON.stringify({
    actionable: true,
    needsLocalExec: true,
    category: 'calendar',
    priority: 2,
    suggestedRecipient: 'codex',
    rationale: 'deadline is near',
  }));
  assert.equal(parsed.suggestedRecipient, 'codex');
  assert.equal(parsed.needsLocalExec, true);
  assert.equal(parsed.taskPath, null);
  assert.throws(() => parseTriageJson(JSON.stringify({
    ...parsed,
    priority: 4,
  })), /priority/);
  assert.throws(() => parseTriageJson(JSON.stringify({
    ...parsed,
    category: 'made-up',
  })), /category/);
  assert.throws(() => parseTriageJson(JSON.stringify({
    ...parsed,
    needsLocalExec: 'yes',
  })), /needsLocalExec/);
});

test('task reminders cover time boundaries and ignore future, no-due, or closed tasks', () => {
  const snapshot = [
    '任务快照日期：2026-08-01（Asia/Shanghai）',
    '',
    '## ⏰ 时间敏感事项',
    '',
    '- ⚠ **已过期任务** (`tasks/overdue.md`) 已过期 2 天——主动问问 User 完成了没',
    '- 🔔 **今天任务** (`tasks/today.md`) 今天到期',
    '- **明天任务** (`tasks/tomorrow.md`) 还有 1 天（2026-08-02 星期日）',
    '- **七天任务** (`tasks/upcoming.md`) 还有 7 天（2026-08-08 星期六）',
    '- **无期限任务** (`tasks/no-due.md`)（无期限，仍未完成）',
    '- **已完成任务** (`tasks/done.md`) 今天到期 done',
    '- **已作废任务** (`tasks/dropped.md`) 还有 3 天（2026-08-04 星期二） dropped',
  ].join('\n');
  const reminders = buildTaskReminders(snapshot);
  assert.deepEqual(reminders.map((item) => ({
    path: item.taskPath,
    stage: item.stage,
    due: item.dueDate,
    priority: item.priority,
  })), [
    { path: 'tasks/overdue.md', stage: 'overdue', due: '2026-07-30', priority: 3 },
    { path: 'tasks/today.md', stage: 'due-today', due: '2026-08-01', priority: 2 },
  ]);
  assert.match(reminders[0].summary, /下一步：确认完成、改期或作废。/);
  assert.match(reminders[0].summary, /需要 User 操作：是。/);
});

test('task reminder key is stable inside a stage and changes on escalation', () => {
  const dueToday = buildTaskReminders([
    '任务快照日期：2026-08-08（Asia/Shanghai）',
    '- 🔔 **同一任务** (`tasks/same.md`) 今天到期',
  ].join('\n'))[0];
  const overdueDayOne = buildTaskReminders([
    '任务快照日期：2026-08-09（Asia/Shanghai）',
    '- ⚠ **同一任务** (`tasks/same.md`) 已过期 1 天——主动问问 User 完成了没',
  ].join('\n'))[0];
  const overdueDayTwo = buildTaskReminders([
    '任务快照日期：2026-08-10（Asia/Shanghai）',
    '- ⚠ **同一任务** (`tasks/same.md`) 已过期 2 天——主动问问 User 完成了没',
  ].join('\n'))[0];
  assert.equal(overdueDayOne.reminderKey, overdueDayTwo.reminderKey);
  assert.notEqual(dueToday.reminderKey, overdueDayOne.reminderKey);
  assert.equal(isTaskReminderMode({ payload: { mode: 'task-reminder' } }), true);
});

test('task reminder config stays inside proactive routing allow-list', () => {
  const proactive = normalizeProactiveConfig({ recipients: ['claude', 'codex'] });
  assert.deepEqual(normalizeTaskReminderConfig({}, proactive), {
    enabled: false,
    intervalMinutes: 45,
    jitterSeconds: 900,
    recipient: 'claude',
  });
  assert.equal(normalizeTaskReminderConfig({ enabled: true }, proactive).enabled, true);
  assert.throws(
    () => normalizeTaskReminderConfig({ recipient: 'aye' }, proactive),
    /included in proactive.recipients/,
  );
});

test('task reminder room routing recognizes executor, verifier, and configured tags only', () => {
  const frontmatter = (lines) => ['---', 'status: open', ...lines, '---', '', '# Task'].join('\n');
  assert.equal(taskReminderRoomRoute(frontmatter(['executor: codex'])).route, 'room');
  assert.equal(taskReminderRoomRoute(frontmatter(['verifier: aye'])).route, 'room');
  assert.deepEqual(taskReminderRoomRoute(frontmatter([
    'tags:',
    '- AI-Hub',
    '- custom',
  ]), { roomTags: ['ai-hub'] }), {
    route: 'room',
    executor: '',
    verifier: '',
    tags: ['ai-hub', 'custom'],
  });
  assert.equal(taskReminderRoomRoute(frontmatter(['tags: [生活, 租房]'])).route, 'main');
  assert.equal(taskReminderRoomRoute('not frontmatter').route, 'main');
  const cases = [
    {
      title: '今日工程验收',
      stage: 'due-today',
      dueDate: '2026-08-01',
      daysUntilDue: 0,
      nextStep: '确认完成、改期或作废。',
      expected: /进度：今天到期（2026-08-01）。/,
    },
    {
      title: '逾期工程验收',
      stage: 'overdue',
      dueDate: '2026-07-30',
      daysUntilDue: -2,
      nextStep: '确认完成、改期或作废。',
      expected: /进度：已过期 2 天（原定 2026-07-30）。/,
    },
  ];
  for (const reminder of cases) {
    const notice = formatTaskReminderRoomNotice({ ...reminder, taskPath: 'tasks/demo.md' });
    assert.match(notice, reminder.expected);
    assert.match(notice, new RegExp(`下一步：${reminder.nextStep}`));
    assert.equal(notice.split(reminder.title).length - 1, 1, 'room notice title must appear exactly once');
    assert.match(notice, /纯通告，不需要群成员接单/);
  }
});

test('task reminder event retry and repeat scans keep one durable delivery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-task-reminder-'));
  const store = new TriageStore(path.join(dir, 'triage.db'));
  try {
    const input = {
      source: 'task-reminder',
      summary: 'one reminder',
      dedupeKey: 'tasks/same.md:2026-08-08:due-today',
      payload: { mode: 'task-reminder' },
    };
    const first = store.enqueue(input);
    assert.equal(first.inserted, true);
    const claimed = store.claim(1000);
    store.retry(claimed.id, 'uncertain HTTP response', 1000, {}, 1000);
    assert.equal(store.enqueue(input).inserted, false);
    const retry = store.claim(2000);
    assert.equal(retry.id, claimed.id);
    store.recordDelivery(retry.id, 'claude', 2000, DELIVERY_POOL_DAILY);
    store.finish(retry.id, 'dispatched', {}, 2000);
    assert.equal(store.enqueue(input).inserted, false);
    assert.equal(store.poolUsage(DELIVERY_POOL_DAILY, 2000).count, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backlog task snapshot excludes tails, future tasks, and already claimed paths', () => {
  const snapshot = buildDispatchableTaskContext([
    '任务快照日期：2026-07-28（Asia/Shanghai）',
    '',
    '## ⏰ 时间敏感事项',
    '- **真正未处理任务** (`tasks/actionable.md`)（无期限，仍未完成）',
    '- **已派过一次的任务** (`tasks/already-claimed.md`)（无期限，仍未完成）',
    '- **Worker 尾巴** (`tasks/worker-tail-job-1.md`)（无期限，仍未完成）',
    '- **部署尾巴** (`tasks/deploy-ai-hub-deadbee.md`)（无期限，仍未完成）',
    '- **周五再验收** (`tasks/review-on-friday.md`) 还有 4 天（2026-08-01 星期六）',
  ].join('\n'), {
    claimedTaskPaths: ['tasks/already-claimed.md'],
  });

  assert.deepEqual(snapshot.taskPaths, ['tasks/actionable.md']);
  assert.deepEqual(snapshot.allTaskPaths, [
    'tasks/actionable.md',
    'tasks/already-claimed.md',
    'tasks/worker-tail-job-1.md',
    'tasks/deploy-ai-hub-deadbee.md',
    'tasks/review-on-friday.md',
  ]);
  assert.match(snapshot.summary, /真正未处理任务/);
  assert.doesNotMatch(snapshot.summary, /已派过一次|尾巴|周五/);
  assert.deepEqual(snapshot.ignored.map((item) => item.reason), [
    'claimed',
    'tail',
    'tail',
    'future',
  ]);
  assert.equal(snapshot.parseOk, true);
});

test('dispatchable snapshot soft-fails empty/garbage; well-formed zero is parseOk', () => {
  assert.equal(buildDispatchableTaskContext('').parseOk, false);
  assert.equal(buildDispatchableTaskContext('garbage without anchor').parseOk, false);
  assert.equal(
    buildDispatchableTaskContext([
      '任务快照日期：2026-08-11',
      '- **looks like a task but path missing**',
    ].join('\n')).parseOk,
    false,
  );
  const wellFormedZero = buildDispatchableTaskContext([
    '任务快照日期：2026-08-11',
    '',
    '## ⏰ 时间敏感事项',
    '- **尾巴** (`tasks/worker-tail-x.md`)（无期限，仍未完成）',
  ].join('\n'));
  assert.equal(wellFormedZero.parseOk, true);
  assert.equal(wellFormedZero.taskPaths.length, 0);
  assert.equal(wellFormedZero.allTaskPaths.length, 1);
});

test('backlog triage requires an exact eligible taskPath', () => {
  const actionable = parseTriageJson(JSON.stringify({
    actionable: true,
    needsLocalExec: true,
    category: 'backlog',
    priority: 2,
    suggestedRecipient: 'codex',
    rationale: 'one concrete task',
    taskPath: 'tasks/actionable.md',
  }));
  assert.equal(
    validateTriageMode(actionable, { allowedTaskPaths: ['tasks/actionable.md'] }),
    actionable,
  );
  assert.throws(
    () => validateTriageMode({ ...actionable, taskPath: 'tasks/worker-tail-job.md' }, {
      allowedTaskPaths: ['tasks/actionable.md'],
    }),
    /exact allowed taskPath/,
  );
  assert.throws(
    () => validateTriageMode({ ...actionable, actionable: false }, {
      allowedTaskPaths: ['tasks/actionable.md'],
    }),
    /NO_OP backlog/,
  );
});

test('events require real context and derive stable dedupe ids', () => {
  assert.throws(() => normalizeEvent({ source: 'timer' }), /real context/);
  const first = normalizeEvent({ source: 'file', summary: 'changed', payload: { path: 'a' } });
  const second = normalizeEvent({ source: 'file', summary: 'changed', payload: { path: 'a' } });
  assert.equal(first.id, second.id);
});

test('timer wakes keep at least one interval between them and never share a dedupe bucket', () => {
  const source = { id: 'quarter-hour-check', intervalMinutes: 15, jitterSeconds: 900 };
  const { intervalMs, jitterMs } = timerSchedule(source);
  assert.equal(intervalMs, 15 * 60_000);
  assert.equal(jitterMs, 900_000);

  // The first wake may land anywhere inside the jitter window; every later wake
  // must clear a full interval first.
  assert.equal(nextTimerDelay(source, { first: true, random: () => 0 }), 0);
  assert.equal(nextTimerDelay(source, { first: true, random: () => 0.999999 }), jitterMs);
  assert.equal(nextTimerDelay(source, { first: false, random: () => 0 }), intervalMs);
  assert.equal(nextTimerDelay(source, { first: false, random: () => 0.999999 }), intervalMs + jitterMs);

  // Worst case is a maximum jitter wake followed by a zero jitter wake, which
  // used to collapse to a few seconds on the old fixed-grid schedule.
  const draws = [0.999999, 0, 0.5, 0.999999, 0.25, 0];
  let now = 1_700_000_000_000;
  let previous = null;
  let previousBucket = null;
  for (const [index, draw] of draws.entries()) {
    now += nextTimerDelay(source, { first: index === 0, random: () => draw });
    if (previous !== null) assert.ok(now - previous >= intervalMs, `wake ${index} fired too early`);
    const bucket = Math.floor(now / intervalMs);
    if (previousBucket !== null) assert.notEqual(bucket, previousBucket);
    previous = now;
    previousBucket = bucket;
  }

  // A source without explicit settings still cannot go below the 15 minute floor.
  assert.ok(nextTimerDelay({ id: 'bare', intervalMinutes: 1 }, { random: () => 0 }) >= 15 * 60_000);
});

test('cost estimate uses separately configurable input and output prices', () => {
  assert.equal(estimateCostCny(
    { prompt_tokens: 1000, completion_tokens: 500 },
    { inputCnyPerMillion: 1, outputCnyPerMillion: 2 },
  ), 0.002);
});

test('idea config uses an independent one-per-day room pool', () => {
  const config = normalizeIdeaConfig({
    enabled: true,
    roomId: 'room',
    reactionRounds: 2,
    dailyDispatchLimit: 1,
  });
  assert.equal(config.hostName, 'DS 主持');
  assert.equal(config.writeDiary, true);
  assert.equal(config.reactionRounds, 2);
  assert.equal(
    normalizeIdeaConfig({ enabled: true, roomId: 'room' }).reactionRounds,
    2,
  );
  assert.equal(ideaPolicyState(config, { count: 0 }).poolFull, false);
  assert.equal(ideaPolicyState(config, { count: 1 }).poolFull, true);
  assert.throws(
    () => normalizeIdeaConfig({ enabled: true, roomId: 'room', reactionRounds: 4 }),
    /reactionRounds/,
  );
  assert.equal(normalizeIdeaConfig({ writeDiary: false }).writeDiary, false);
});

test('coordination parser requires open executor Plan and hashes only the Plan version', () => {
  const taskText = [
    '---',
    'type: task',
    'status: open',
    'executor: codex',
    '---',
    '',
    '# 自动派单测试',
    '',
    '## 背景',
    '这段背景修订不应影响 Plan hash。',
    '',
    '## Plan（Claude，2026-08-06）',
    '',
    '- 生产配置：`/etc/ai-hub/triage.json`。',
    '',
    '### 执行者与工作区',
    '- 工作区：`C:\\ai-hub-codex`：`git checkout -b coordination-demo origin/master`。',
    '- 验证：npm test。',
  ].join('\n');
  const parsed = parseCoordinationTask(taskText, { taskPath: 'tasks/demo.md' });
  assert.equal(parsed.executor, 'codex');
  assert.equal(parsed.workspace, 'C:/ai-hub-codex');
  assert.equal(parsed.branch, 'coordination-demo');
  assert.equal(parsed.taskPath, 'tasks/demo.md');
  assert.equal(parsed.planHash.length, 64);

  const backgroundOnly = taskText.replace('这段背景修订', '背景再次修订');
  assert.equal(
    parseCoordinationTask(backgroundOnly, { taskPath: 'tasks/demo.md' }).planHash,
    parsed.planHash,
  );
  const reviewed = `${taskText}\n\n## Review\n\nPASS，等待 User。`;
  assert.equal(
    parseCoordinationTask(reviewed, { taskPath: 'tasks/demo.md' }).planHash,
    parsed.planHash,
  );
  const revised = taskText.replace('验证：npm test', '验证：npm test && npm run build');
  assert.notEqual(
    parseCoordinationTask(revised, { taskPath: 'tasks/demo.md' }).planHash,
    parsed.planHash,
  );
  assert.equal(parseCoordinationTask(taskText.replace('executor: codex\n', ''), { taskPath: 'tasks/demo.md' }), null);
  assert.equal(parseCoordinationTask(taskText.replace('status: open', 'status: done'), { taskPath: 'tasks/demo.md' }), null);

  const fixedPrompt = coordinationWorkerPrompt(parsed);
  assert.match(fixedPrompt, /^\[AI_HUB_COORDINATION_V2\]/);
  assert.match(fixedPrompt, /taskPath=tasks\/demo\.md/);
  assert.match(fixedPrompt, /planHash=[a-f0-9]{64}/);
  assert.match(fixedPrompt, new RegExp(`fingerprint=${executionFingerprint(parsed)}`));
  const dispatch = formatCoordinationDispatchBlock(parsed);
  assert.match(dispatch, /@codex/);
  assert.match(dispatch, /delegate_to_worker\.prompt 必须逐字/);
  assert.match(dispatch, /PASS tasks\/demo\.md/);

  const config = normalizeCoordinationConfig({
    enabled: true,
    roomId: 'room',
    dailyLimit: 8,
  });
  assert.equal(config.tasksDir, '/opt/memory-vault/tasks');
  assert.deepEqual(config.reminderRoomTags, ['ai-hub', 'worker', 'deploy', '工程']);
  assert.deepEqual(config.hubAutoHygiene, { enabled: false, staleDays: 14 });
  assert.deepEqual(
    normalizeCoordinationConfig({ hubAutoHygiene: { enabled: true, staleDays: 21 } }).hubAutoHygiene,
    { enabled: true, staleDays: 21 },
  );
  assert.equal(coordinationPolicyState(config, { count: 7 }).poolFull, false);
  assert.equal(coordinationPolicyState(config, { count: 7 }).remaining, 1);
  assert.equal(coordinationPolicyState(config, { count: 8 }).poolFull, true);
  assert.equal(coordinationPolicyState({ enabled: true, roomId: '', dailyLimit: 8 }).poolFull, true);
});

test('fingerprint v2 covers executor/workspace/branch and canonicalizes workspace paths', () => {
  const base = {
    taskPath: 'tasks/demo.md',
    planHash: 'a'.repeat(64),
    executor: 'codex',
    workspace: 'C:/ai-hub-codex',
    branch: 'coordination-demo',
  };
  const fingerprint = executionFingerprint(base);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  // 语义等价的写法必须得到同一个 fingerprint
  assert.equal(executionFingerprint({ ...base, workspace: 'c:\\ai-hub-codex\\' }), fingerprint);
  assert.equal(executionFingerprint({ ...base, executor: ' Codex ' }), fingerprint);
  // 任一语义字段变化都必须产生新 fingerprint —— 特别是 Plan 不变、只改派 executor
  assert.notEqual(executionFingerprint({ ...base, executor: 'aye' }), fingerprint);
  assert.notEqual(executionFingerprint({ ...base, workspace: 'D:/other' }), fingerprint);
  assert.notEqual(executionFingerprint({ ...base, branch: 'other-branch' }), fingerprint);
  assert.notEqual(executionFingerprint({ ...base, planHash: 'b'.repeat(64) }), fingerprint);
  assert.notEqual(executionFingerprint({ ...base, taskPath: 'tasks/other.md' }), fingerprint);
  // Linux 路径大小写敏感，不做小写化
  assert.notEqual(
    executionFingerprint({ ...base, workspace: '/opt/Repo' }),
    executionFingerprint({ ...base, workspace: '/opt/repo' }),
  );

  assert.equal(executionDispatchKey(base), `coordination:v2:tasks/demo.md:${fingerprint}`);
  assert.equal(legacyExecutionDispatchKey(base), `coordination:tasks/demo.md:${'a'.repeat(64)}`);
  const verification = { taskPath: 'tasks/demo.md', due: '2026-08-14', verifier: 'Aye' };
  assert.equal(
    verificationDispatchKey(verification),
    'verification:v2:tasks/demo.md:2026-08-14:aye',
  );
  assert.equal(
    legacyVerificationDispatchKey(verification),
    'verification:v1:tasks/demo.md:2026-08-14',
  );
});

test('hub-auto hygiene parses inbox rows, applies the 14-day boundary, and groups the digest', () => {
  const inbox = [
    '共 6 条待确认：',
    '',
    '- **无标签** (`inbox/2026-07-01_no-tags.md`)',
    '- **13 天偏好** (`inbox/2026-07-27_fresh.md`)  [hub-auto, claude, 偏好]',
    '- **14 天承诺** (`inbox/2026-07-26_temporal.md`)  [hub-auto, claude, 承诺与待办, llm-review-pending]',
    '- **20 天人生事件** (`inbox/2026-07-20_manual.md`)  [hub-auto, 人生事件]',
    '- **非法日期** (`inbox/2026-02-30_invalid.md`)  [hub-auto, 时间与计划]',
    '- **普通需求** (`inbox/2026-07-01_req.md`)  [需求, ai-hub]',
  ].join('\n');

  const parsed = parseVaultInboxList(inbox);
  assert.equal(parsed.length, 6);
  assert.deepEqual(parsed[0].tags, []);
  assert.deepEqual(parsed[2].tags, ['hub-auto', 'claude', '承诺与待办', 'llm-review-pending']);
  assert.equal(parsed[4].date, null);

  const plan = planHubAutoHygiene(inbox, { today: '2026-08-09', staleDays: 14 });
  assert.deepEqual(plan.metrics, {
    hubAutoTotal: 4,
    staleCount: 2,
    oldestDays: 20,
    invalidDateCount: 1,
  });
  assert.deepEqual(plan.stale.map((item) => [item.path, item.ageDays, item.group]), [
    ['inbox/2026-07-20_manual.md', 20, 'manual'],
    ['inbox/2026-07-26_temporal.md', 14, 'temporal'],
  ]);
  assert.match(plan.digest, /时效类（时间与计划\/承诺与待办）可归档提案/);
  assert.match(plan.digest, /偏好\/人生事件类需人工判断/);
  assert.match(plan.digest, /2026-07-26_temporal\.md`｜14 天｜分类：承诺与待办/);
  assert.match(plan.digest, /hub-auto 存量 4｜超期 2｜最老 20 天｜日期前缀不可解析 1/);
  assert.doesNotMatch(plan.digest, /2026-07-27_fresh/);

  const quiet = planHubAutoHygiene(
    '- **13 天偏好** (`inbox/2026-07-27_fresh.md`)  [hub-auto, 偏好]',
    { today: '2026-08-09', staleDays: 14 },
  );
  assert.equal(quiet.metrics.staleCount, 0);
  assert.equal(quiet.digest, '');
});

test('verification parser requires open verifier and a real due date, with a fixed read-only template', () => {
  const taskText = [
    '---',
    'type: task',
    'status: "open"',
    "verifier: 'aye'",
    "due: '2026-08-06'",
    '---',
    '',
    '# 到期验收测试',
    '',
    '## 验收标准',
    '- 逐条取证。',
  ].join('\n');
  const parsed = parseVerificationTask(taskText, { taskPath: 'tasks/verification.md' });
  assert.deepEqual(parsed, {
    taskPath: 'tasks/verification.md',
    title: '到期验收测试',
    verifier: 'aye',
    due: '2026-08-06',
  });
  assert.equal(
    parseVerificationTask(taskText.replace("verifier: 'aye'\n", ''), { taskPath: 'tasks/verification.md' }),
    null,
  );
  assert.equal(
    parseVerificationTask(taskText.replace('status: "open"', 'status: done'), { taskPath: 'tasks/verification.md' }),
    null,
  );
  assert.equal(
    parseVerificationTask(taskText.replace("due: '2026-08-06'", 'due: none'), { taskPath: 'tasks/verification.md' }),
    null,
  );
  assert.equal(
    parseVerificationTask(taskText.replace("due: '2026-08-06'", 'due: 2026-02-30'), { taskPath: 'tasks/verification.md' }),
    null,
  );

  const dispatch = formatVerificationDispatchBlock(parsed);
  assert.match(dispatch, /^@aye 验收派单/);
  assert.match(dispatch, /只读：不改代码，不部署/);
  assert.match(dispatch, /按其中验收标准逐条取证/);
  assert.match(dispatch, /证据写回任务 note/);
  assert.match(dispatch, /验收结论 PASS\/FAIL\/样本不足 \+ tasks\/verification\.md/);
  assert.match(dispatch, /不得将任务置 done，不得改期，不得作废/);
  assert.doesNotMatch(dispatch, /delegate_to_worker/);
});

test('idea diary request is stable, Shanghai-dated, distilled, and transcript-free', () => {
  const input = {
    eventId: 'idea-event-1',
    room: { id: 'room', name: '会议室' },
    topic: '什么日常摩擦最值得被 AI 消除？',
    topicCategory: 'daily-life',
    targetNames: ['Claude', 'Codex'],
    participantNames: ['Claude', 'Codex'],
    outcome: { normal: { spoke: 2, passed: 0 }, reactions: [{ spoke: 1, passed: 1 }] },
    roundId: 'round-1',
    topicMessageId: 10,
    summaryMessageId: 20,
    summary: 'DS 收尾：便利不能替代人的选择权。',
    completedAt: Date.parse('2026-07-28T16:30:00Z'),
  };
  const first = buildIdeaDiaryRequest(input);
  const replay = buildIdeaDiaryRequest(input);
  assert.deepEqual(replay, first);
  assert.match(first.slug, /^idea-2026-07-29-[a-f0-9]{16}$/);
  assert.equal(first.title, 'Idea 讨论：什么日常摩擦最值得被 AI 消除？');
  assert.deepEqual(first.tags, ['日记', 'ai-hub', 'idea-discussion', 'daily-life']);
  assert.equal(first.source, 'ai-hub-triage');
  assert.match(first.content, /什么日常摩擦/);
  assert.match(first.content, /DS 收尾/);
  assert.match(first.content, /实际发言：Claude、Codex/);
  assert.match(first.content, /消息 `10` 到 `20`/);
  assert.doesNotMatch(first.content, /我想删掉反复确认同一件小事/);
  assert.equal(Object.hasOwn(first, 'transcript'), false);
});

test('idea completion and diary outbox are atomic, retryable, and idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-idea-diary-outbox-'));
  const store = new TriageStore(path.join(dir, 'triage.db'));
  try {
    const queued = store.enqueue({
      source: 'daily-idea-room',
      summary: 'Host one discussion.',
      dedupeKey: 'idea-outbox-event',
    });
    const event = store.claim(1000);
    const triageResult = {
      actionable: true,
      category: 'idea',
      priority: 1,
      suggestedRecipient: 'room',
      rationale: 'novel topic',
      stage: 'completed',
      topic: '一个话题',
      ideaCategory: 'daily-life',
      summary: '一个收尾',
      summaryMessageId: 20,
    };
    const payload = buildIdeaDiaryRequest({
      eventId: queued.id,
      room: { id: 'room', name: '会议室' },
      topic: triageResult.topic,
      topicCategory: triageResult.ideaCategory,
      summary: triageResult.summary,
      summaryMessageId: 20,
      topicMessageId: 10,
      roundId: 'round-1',
      completedAt: 2000,
    });
    const vaultWrite = {
      id: 'idea-diary:stable',
      dedupeKey: `idea:${queued.id}:summary:20`,
      payload,
    };
    store.completeIdea(event.id, {
      roomId: 'room',
      triageResult,
      vaultWrite,
    }, 2000);
    assert.equal(store.db.prepare('SELECT status FROM triage_events WHERE id = ?').get(event.id).status, 'dispatched');
    assert.equal(store.dailySummary(2000).ideaDiaryPending, 1);

    const first = store.claimVaultWrite(2000);
    assert.equal(first.id, vaultWrite.id);
    store.retryVaultWrite(first.id, 'vault unavailable', 1000, 2000);
    assert.equal(store.db.prepare('SELECT status FROM triage_events WHERE id = ?').get(event.id).status, 'dispatched');
    assert.equal(store.dailySummary(2000).ideaDiaryRetrying, 1);
    assert.equal(store.dailySummary(2000).ideaDiaryLastError, 'vault unavailable');
    assert.equal(store.claimVaultWrite(2500), null);

    const retry = store.claimVaultWrite(3000);
    store.finishVaultWrite(retry.id, 3000);
    store.completeIdea(event.id, {
      roomId: 'room',
      triageResult,
      vaultWrite,
    }, 4000);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM triage_vault_outbox').get().count, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM triage_deliveries WHERE pool = ?').get(DELIVERY_POOL_IDEA).count, 1);
    assert.equal(store.dailySummary(4000).ideaDiariesWritten, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordination settle is atomic and idempotent across state, delivery, and event finish', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-settle-'));
  const store = new TriageStore(path.join(dir, 'triage.db'));
  try {
    const event = store.enqueue({
      source: 'coordination-sweep',
      summary: 'settle test',
      dedupeKey: 'settle-1',
    });
    const settleInput = {
      recipientId: 'room',
      pool: DELIVERY_POOL_COORDINATION,
      messageId: 501,
      executedVia: EXECUTED_VIA_CONTACT,
      taskPath: 'tasks/settle.md',
      sourceStates: [{ key: 'coordination:v1', value: '{"tasks/settle.md":"fp"}' }],
      triageResult: {
        actionable: true,
        needsLocalExec: true,
        category: 'coordination',
        priority: 2,
        suggestedRecipient: 'codex',
        rationale: 'settle test',
      },
      finishRecipientId: 'codex',
    };
    store.settleCoordinationDispatch(event.id, settleInput, 4000);
    // 幂等：重复 settle（崩溃后重放）不得二次计池或重复 outcome
    store.settleCoordinationDispatch(event.id, settleInput, 5000);
    assert.equal(store.getSourceState('coordination:v1'), '{"tasks/settle.md":"fp"}');
    assert.equal(store.poolUsage(DELIVERY_POOL_COORDINATION, 5000).count, 1);
    const deliveries = store.db.prepare(
      'SELECT * FROM triage_deliveries WHERE event_id = ?',
    ).all(event.id);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].message_id, 501);
    const outcomes = store.db.prepare(
      'SELECT * FROM triage_outcomes WHERE event_id = ?',
    ).all(event.id);
    assert.equal(outcomes.length, 1);
    const eventRow = store.db.prepare('SELECT * FROM triage_events WHERE id = ?').get(event.id);
    assert.equal(eventRow.status, 'dispatched');
    assert.equal(eventRow.recipient_id, 'codex');

    // 原子性：事务内任一步失败必须整体回滚，不得留下半套账
    const broken = store.enqueue({
      source: 'coordination-sweep',
      summary: 'settle rollback test',
      dedupeKey: 'settle-2',
    });
    assert.throws(() => store.settleCoordinationDispatch(broken.id, {
      ...settleInput,
      sourceStates: [
        { key: 'rollback-probe', value: 'written-first' },
        // 注入：第二条 state 读取即抛错，模拟事务中途任意一步失败
        { get key() { throw new Error('injected mid-transaction failure'); }, value: '' },
      ],
    }, 6000));
    assert.equal(store.getSourceState('rollback-probe'), null, '事务失败后先写的 state 必须回滚');
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS c FROM triage_deliveries WHERE event_id = ?').get(broken.id).c,
      0,
    );
    assert.equal(
      store.db.prepare('SELECT status FROM triage_events WHERE id = ?').get(broken.id).status,
      'queued',
      '事务失败后 event 必须保持可重试',
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite queue deduplicates, recovers leases, retries, and reports metrics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-'));
  const store = new TriageStore(path.join(dir, 'triage.db'));
  try {
    const event = { source: 'test', summary: 'real payload', dedupeKey: 'same' };
    assert.equal(store.enqueue(event).inserted, true);
    assert.equal(store.enqueue(event).inserted, false);
    const claimed = store.claim(1000);
    assert.equal(claimed.status, 'processing');
    assert.equal(store.recoverStale(10, 2000), 1);
    const reclaimed = store.claim(2000);
    store.retry(reclaimed.id, 'temporary', 1000, {
      triageResult: {
        actionable: true,
        category: 'system',
        priority: 1,
        suggestedRecipient: null,
        rationale: 'cached',
      },
      costCny: 0.0002,
      triageLatencyMs: 123,
    }, 2000);
    assert.equal(store.claim(2500), null);
    const final = store.claim(3000);
    assert.equal(final.triageResult.rationale, 'cached');
    assert.equal(final.cost_cny, 0.0002);
    assert.equal(final.triage_latency_ms, 123);
    store.recordDelivery(final.id, 'codex', 3000);
    store.recordDelivery(final.id, 'room', 3000, DELIVERY_POOL_IDEA);
    store.finish(final.id, 'dispatched', {
      recipientId: 'codex',
      triageResult: { fallbackUsed: false },
      costCny: 0.0005,
      triageLatencyMs: 123,
    }, 3000);
    assert.equal(store.recipientUsage('codex', 3000).count, 1);
    const summary = store.dailySummary(3000);
    assert.equal(summary.total, 1);
    assert.equal(summary.deliveries[0].recipient_id, 'codex');
    assert.equal(summary.triagedCount, 1);
    assert.equal(summary.avgTriageLatencyMs, 123);
    assert.equal(summary.ideaPoolDispatched, 1);
    assert.ok(summary.lastIdeaDeliveryAt);
    // A signal-driven shutdown and the run() finally block both close the
    // store; the second call must not throw ERR_INVALID_STATE.
    store.close();
    assert.doesNotThrow(() => store.close());
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('router prefers explicit idle target then applies daily and cooldown limits', () => {
  const contacts = [
    {
      id: 'claude',
      name: 'Claude',
      state: 'active',
      config: {
        routing: {
          enabled: true,
          recipientKey: 'engineering',
          categories: ['file-change'],
          dailyLimit: 10,
          cooldownMinutes: 30,
        },
      },
    },
    {
      id: 'codex',
      name: 'Codex',
      state: 'idle',
      config: {
        routing: {
          enabled: true,
          recipientKey: 'engineering-backup',
          categories: ['file-change'],
          dailyLimit: 10,
          cooldownMinutes: 30,
        },
      },
    },
  ];
  const result = {
    actionable: true,
    category: 'file-change',
    priority: 2,
    suggestedRecipient: null,
    rationale: 'change',
  };
  const routed = chooseRecipient({
    contacts,
    result,
    rules: { 'file-change': 'engineering' },
    usageOf: () => ({ count: 0, lastAt: null }),
    now: 100_000,
  });
  assert.equal(routed.contact.id, 'codex');

  const limited = chooseRecipient({
    contacts: contacts.map((contact) => ({ ...contact, state: 'idle' })),
    result,
    usageOf: () => ({ count: 10, lastAt: 99_000 }),
    now: 100_000,
  });
  assert.equal(limited.contact, null);
  assert.equal(limited.reason, 'all-candidates-rate-limited');
});

test('daily model routing ignores rules and task recipient quotas', () => {
  const contacts = [
    { id: 'claude', name: 'Claude', state: 'idle', config: { routing: { enabled: true, recipientKey: 'claude', categories: ['system'], dailyLimit: 1, cooldownMinutes: 60 } } },
    { id: 'codex', name: 'Codex', state: 'idle', config: { routing: { enabled: true, recipientKey: 'codex', categories: ['system'], dailyLimit: 1, cooldownMinutes: 60 } } },
    { id: 'aye', name: '阿野', state: 'idle', config: { routing: { enabled: true, recipientKey: 'aye', categories: ['system'], dailyLimit: 1, cooldownMinutes: 60 } } },
    { id: 'gem', name: 'Gemini', state: 'idle', config: { routing: { enabled: true, recipientKey: 'gem', categories: ['daily'], dailyLimit: 100, cooldownMinutes: 0 } } },
  ];
  const result = {
    actionable: true,
    category: 'daily',
    priority: 1,
    suggestedRecipient: 'aye',
    rationale: 'light check-in fits Grok',
  };
  const routed = chooseRecipient({
    contacts,
    result,
    rules: { daily: 'claude' },
    // Task quota already exhausted must not block the daily pool.
    usageOf: () => ({ count: 99, lastAt: 1 }),
    allowedRecipientKeys: ['claude', 'codex', 'aye'],
    ignoreRecipientLimits: true,
    modelOnly: true,
    now: 100_000,
  });
  assert.equal(routed.contact.id, 'aye');
  assert.equal(routed.reason, 'model-suggestion');

  const missing = chooseRecipient({
    contacts,
    result: { ...result, suggestedRecipient: null },
    rules: { daily: 'claude' },
    allowedRecipientKeys: ['claude', 'codex', 'aye'],
    ignoreRecipientLimits: true,
    modelOnly: true,
  });
  assert.equal(missing.contact, null);
  assert.equal(missing.reason, 'no-route');
});

test('needsLocalExec only routes to delegation-enabled contacts', () => {
  const contacts = [
    {
      id: 'frontend-only',
      name: 'Frontend',
      state: 'idle',
      config: {
        routing: {
          enabled: true,
          recipientKey: 'frontend',
          categories: ['backlog'],
          dailyLimit: 10,
          cooldownMinutes: 0,
        },
        delegation: { enabled: false },
      },
    },
    {
      id: 'local-bridge',
      name: 'Local bridge',
      state: 'idle',
      config: {
        routing: {
          enabled: true,
          recipientKey: 'worker-bridge',
          categories: ['backlog'],
          dailyLimit: 10,
          cooldownMinutes: 0,
        },
        delegation: { enabled: true },
      },
    },
  ];
  const local = chooseRecipient({
    contacts,
    result: {
      actionable: true,
      needsLocalExec: true,
      category: 'backlog',
      priority: 2,
      suggestedRecipient: 'frontend',
      rationale: 'requires repository state',
    },
  });
  assert.equal(local.contact.id, 'local-bridge');

  const companion = chooseRecipient({
    contacts,
    result: {
      actionable: true,
      needsLocalExec: false,
      category: 'backlog',
      priority: 1,
      suggestedRecipient: 'frontend',
      rationale: 'chat-only follow-up',
    },
  });
  assert.equal(companion.contact.id, 'frontend-only');
});

test('fuzzy L2.5 preserves needsLocalExec and only sees delegation recipients', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push(body);
      const user = JSON.parse(body.messages[1].content);
      assert.deepEqual(user.recipients.map((recipient) => recipient.id), ['local-bridge']);
      assert.match(body.messages[0].content, /needsLocalExec/);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actionable: true,
              needsLocalExec: true,
              category: 'backlog',
              priority: 2,
              suggestedRecipient: 'worker-bridge',
              rationale: 'delegate-capable route',
            }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
  });
  await listenOnFetchSafePort(server);
  const previous = process.env.TEST_TRIAGE_ROUTE_KEY;
  process.env.TEST_TRIAGE_ROUTE_KEY = 'test-only';
  try {
    const client = new DeepSeekClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKeyEnv: 'TEST_TRIAGE_ROUTE_KEY',
      proModel: 'deepseek-v4-pro',
    }, ['backlog', 'other']);
    const response = await client.fuzzyRoute(
      { source: 'test', summary: 'inspect repository state' },
      {
        actionable: true,
        needsLocalExec: true,
        category: 'backlog',
        priority: 2,
        suggestedRecipient: null,
        rationale: 'requires local state',
      },
      [
        {
          id: 'frontend-only',
          name: 'Frontend',
          config: {
            routing: { recipientKey: 'frontend', categories: ['backlog'] },
            delegation: { enabled: false },
          },
        },
        {
          id: 'local-bridge',
          name: 'Local bridge',
          config: {
            routing: { recipientKey: 'worker-bridge', categories: ['backlog'] },
            delegation: { enabled: true },
          },
        },
      ],
    );
    assert.equal(response.result.needsLocalExec, true);
    assert.equal(response.result.suggestedRecipient, 'worker-bridge');
    assert.equal(seen.length, 1);
  } finally {
    if (previous === undefined) delete process.env.TEST_TRIAGE_ROUTE_KEY;
    else process.env.TEST_TRIAGE_ROUTE_KEY = previous;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('daily mode is source-owned and proactive safety config fails closed', () => {
  const dailyResult = {
    actionable: true,
    category: 'daily',
    priority: 1,
    suggestedRecipient: 'aye',
    rationale: 'natural check-in',
  };
  assert.throws(
    () => validateTriageMode(dailyResult, { mode: 'task' }),
    /task triage cannot return category daily/,
  );
  assert.equal(validateTriageMode(dailyResult, {
    mode: 'daily',
    dailyRecipients: ['claude', 'codex', 'aye'],
  }), dailyResult);
  assert.throws(
    () => validateTriageMode({ ...dailyResult, suggestedRecipient: 'gem' }, {
      mode: 'daily',
      dailyRecipients: ['claude', 'codex', 'aye'],
    }),
    /allowed recipient/,
  );
  assert.throws(
    () => validateTriageMode({ ...dailyResult, actionable: false, suggestedRecipient: null }, {
      mode: 'daily',
      forceActionable: true,
    }),
    /guaranteed daily slot/,
  );
  assert.throws(
    () => normalizeProactiveConfig({ dailyDispatchLimit: 'not-a-number' }),
    /dailyDispatchLimit/,
  );
  assert.throws(
    () => normalizeProactiveConfig({ dailyDispatchLimit: 1, minDailyDispatches: 2 }),
    /cannot exceed/,
  );

  const beforeFloor = Date.parse('2026-07-26T09:59:00Z'); // 17:59 Shanghai
  const afterFloor = Date.parse('2026-07-26T10:01:00Z'); // 18:01 Shanghai
  const proactive = normalizeProactiveConfig({
    dailyDispatchLimit: 10,
    minDailyDispatches: 1,
    forceAfterHour: 18,
    minimumGapMinutes: 180,
  });
  assert.equal(dailyPolicyState(proactive, { count: 0, lastAt: null }, beforeFloor).forceActionable, false);
  assert.equal(dailyPolicyState(proactive, { count: 0, lastAt: null }, afterFloor).forceActionable, true);
  assert.equal(dailyPolicyState(proactive, {
    count: 1,
    lastAt: afterFloor - 60 * 60_000,
  }, afterFloor).gapBlocked, true);

  // Marked date-event day: force actionable even before forceAfterHour; clear gap only.
  const dateHitBeforeFloor = dailyPolicyState(
    proactive,
    { count: 1, lastAt: beforeFloor - 60 * 60_000 },
    beforeFloor,
    { hasTodayDateEvent: true },
  );
  assert.equal(dateHitBeforeFloor.forceActionable, true);
  assert.equal(dateHitBeforeFloor.gapBlocked, false);
  assert.equal(dateHitBeforeFloor.poolFull, false);
  // Pool hard cap still applies on date-event days.
  assert.equal(
    dailyPolicyState(
      proactive,
      { count: 10, lastAt: null },
      afterFloor,
      { hasTodayDateEvent: true },
    ).poolFull,
    true,
  );

  const compactTasks = summarizeTaskContext([
    '任务快照日期：2026-07-26（Asia/Shanghai）',
    '',
    '## 时间敏感事项',
    ...Array.from({ length: 8 }, (_, index) => `- **任务 ${index + 1}** (tasks/t${index + 1}.md)`),
  ].join('\n'));
  assert.equal(compactTasks.match(/^- \*\*/gm).length, 5);
  assert.ok(compactTasks.length <= 800);
  assert.doesNotMatch(compactTasks, /任务 6/);
});

test('date-event facts force daily actionable once per Shanghai day', async () => {
  const {
    claimDateEventKey,
    filterUnclaimedDateEvents,
    formatDailyDispatchDateBlock,
    matchDateEvents,
    parseDateFacts,
  } = await import('./date-events.mjs');

  const factsText = [
    '找到 3 条 facts：',
    '',
    '- **identity.birth** (`identity.birth--1`, active, high): 山东枣庄',
    '- **identity.birthday** (`identity.birthday--2`, active, pinned): {"date":"2001-08-04","recurring":"yearly","label":"User 生日"}',
    '- **relationships.anniversary.cheng_wedding** (`relationships.anniversary-claude-wedding--3`, active, high): {"date":"2026-05-21","recurring":"yearly","label":"Claude与 User 新婚纪念日"}',
    // free-text / metadata dates must NOT be scraped
    '- **work.something** (`work.something--4`, active, normal): started 2026-08-04 without structure',
  ].join('\n');
  const parsed = parseDateFacts(factsText);
  assert.deepEqual(parsed.map((item) => item.key).sort(), [
    'identity.birthday',
    'relationships.anniversary.cheng_wedding',
  ]);

  // 2026-08-04 12:00 Shanghai = 2026-08-04 04:00 UTC
  const birthdayNoon = Date.parse('2026-08-04T04:00:00Z');
  const matched = matchDateEvents(parsed, birthdayNoon, { upcomingDays: 3 });
  assert.equal(matched.today.length, 1);
  assert.equal(matched.today[0].key, 'identity.birthday');
  assert.equal(matched.today[0].yearsSince, 25);
  assert.equal(matched.today[0].daysUntil, 0);
  assert.equal(matched.upcoming.length, 0);

  // 2026-05-19 Shanghai → wedding in 2 days
  const twoDaysBefore = Date.parse('2026-05-19T04:00:00Z');
  const upcoming = matchDateEvents(parsed, twoDaysBefore, { upcomingDays: 3 });
  assert.equal(upcoming.today.length, 0);
  assert.equal(upcoming.upcoming.length, 1);
  assert.equal(upcoming.upcoming[0].key, 'relationships.anniversary.cheng_wedding');
  assert.equal(upcoming.upcoming[0].daysUntil, 2);

  const summary = buildDailyCheckSummary(
    { summary: 'daily wake' },
    birthdayNoon,
    {
      forceActionable: true,
      todayDateEvents: matched.today,
    },
  );
  assert.match(summary, /TODAY IS A MARKED DATE/);
  assert.match(summary, /User 生日/);
  assert.match(summary, /第 25 年/);
  assert.match(summary, /do not ask about meals/i);
  assert.doesNotMatch(summary, /Prefer NO_OP/);

  // Same-day claim: after first dispatch the fact is filtered out.
  const shanghaiDate = '2026-08-04';
  const claims = {
    [claimDateEventKey('identity.birthday', shanghaiDate)]: { claimedAt: birthdayNoon },
  };
  assert.deepEqual(
    filterUnclaimedDateEvents(matched.today, claims, shanghaiDate),
    [],
  );
  assert.equal(
    filterUnclaimedDateEvents(matched.today, {}, shanghaiDate).length,
    1,
  );

  const block = formatDailyDispatchDateBlock(matched.today);
  assert.match(block, /【必须围绕的日子】/);
  assert.match(block, /User 生日/);
  assert.match(block, /禁止泛问吃饭/);
  assert.equal(formatDailyDispatchDateBlock([]), '');
});

test('followup keyword screen, extract normalize, and cancel-before-fire gates', () => {
  assert.equal(matchesAbsenceKeyword('我去洗澡了，回头聊'), true);
  assert.equal(matchesAbsenceKeyword('今天天气不错'), false);
  assert.equal(matchesAbsenceKeyword('开会去了，有事留言'), true);
  assert.equal(matchesAbsenceKeyword('鸣潮玩完之后验收 toy 我再来'), true);

  const cfg = normalizeFollowupConfig({ minExpectedMinutes: 10, maxExpectedMinutes: 120 });
  assert.deepEqual(
    normalizeAbsenceExtract({
      intent: 'temporary-absence',
      activity: '玩鸣潮',
      expectedMinutes: 999,
      returnCommitment: '验收 toy',
    }, cfg),
    { intent: 'temporary-absence', activity: '玩鸣潮', expectedMinutes: 120, returnCommitment: '验收 toy' },
  );
  assert.match(formatFollowupDispatchBlock({ activity: '玩鸣潮', return_commitment: '验收 toy' }), /要不要现在验收 toy/);
  assert.equal(normalizeAbsenceExtract({ intent: 'none' }, cfg), null);

  const now = Date.parse('2026-08-05T06:00:00Z');
  const maxWindowCfg = normalizeFollowupConfig({
    maxExpectedMinutes: 180,
    expireAfterMinutes: 180,
  });
  assert.equal(maxWindowCfg.expireAfterMinutes, 240);
  assert.equal(
    evaluateFollowupGate({
      status: 'pending',
      created_at: now,
      due_at: now + 180 * 60_000,
    }, {
      now: now + 239 * 60_000,
      expireAfterMinutes: maxWindowCfg.expireAfterMinutes,
    }).action,
    'fire',
  );
  const followup = {
    status: 'pending',
    created_at: now - 40 * 60_000,
    due_at: now - 5 * 60_000,
  };
  assert.equal(
    evaluateFollowupGate(followup, {
      now,
      userMessagesAfter: [{ sender: 'user', role: 'user', status: 'done', content: '洗完了' }],
    }).action,
    'cancel',
  );
  assert.equal(
    evaluateFollowupGate(followup, {
      now,
      userMessagesAfter: [],
      proactiveDeliveredAfter: true,
    }).reason,
    'proactive-already-sent',
  );
  assert.equal(
    evaluateFollowupGate(followup, {
      now: now + 200 * 60_000,
      userMessagesAfter: [],
      expireAfterMinutes: 180,
    }).action,
    'expire',
  );
  assert.equal(
    evaluateFollowupGate(followup, {
      now,
      userMessagesAfter: [],
      silent: true,
    }).action,
    'wait',
  );
  assert.equal(
    evaluateFollowupGate(followup, {
      now,
      userMessagesAfter: [],
      poolBlocked: true,
    }).reason,
    'daily-pool-blocked',
  );
  assert.equal(
    evaluateFollowupGate(followup, {
      now,
      userMessagesAfter: [],
    }).action,
    'fire',
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-followup-store-'));
  const store = new TriageStore(path.join(dir, 'triage.db'));
  try {
    assert.equal(store.insertFollowup({
      id: 'fu-1',
      contactId: 'claude',
      messageId: 42,
      activity: '洗澡',
      returnCommitment: '验收 toy',
      expectedMinutes: 30,
      dueAt: now - 1000,
      recipientKey: 'claude',
      now: now - 40 * 60_000,
    }), true);
    assert.equal(store.insertFollowup({
      id: 'fu-dup',
      contactId: 'claude',
      messageId: 42,
      activity: '洗澡',
      expectedMinutes: 30,
      dueAt: now,
      recipientKey: 'claude',
      now,
    }), false);
    assert.equal(store.hasOpenFollowupForContact('claude'), true);
    assert.equal(store.pendingFollowups().length, 1);
    assert.equal(store.updateFollowupStatus('fu-1', 'cancelled', { cancelReason: 'user-replied' }), 1);
    assert.equal(store.hasOpenFollowupForContact('claude'), false);
    assert.equal(store.getFollowup('fu-1').cancel_reason, 'user-replied');
    assert.equal(store.getFollowup('fu-1').return_commitment, '验收 toy');
    assert.equal(store.insertFollowup({
      id: 'fu-fallback',
      contactId: 'codex',
      messageId: 99,
      activity: '玩鸣潮',
      returnCommitment: '验收 toy',
      expectedMinutes: 120,
      dueAt: now - 60_000,
      recipientKey: 'codex',
      now: now - 5 * 60 * 60_000,
    }), true);
    assert.equal(store.updateFollowupStatus('fu-fallback', 'expired', {
      cancelReason: 'max-age',
      now,
    }), 1);
    assert.deepEqual(store.expiredFollowupsForFallback({ since: now - 1000 }).map((row) => row.id), ['fu-fallback']);
    assert.equal(store.markFollowupsFallbackReminded(['fu-fallback'], now + 1), 1);
    assert.equal(store.expiredFollowupsForFallback({ since: 0 }).length, 0);
    assert.equal(store.getFollowup('fu-fallback').fallback_reminded_at, now + 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy SQLite deliveries and followups migrate on open', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-legacy-'));
  const file = path.join(dir, 'triage.db');
  const seed = new DatabaseSync(file);
  try {
    seed.exec(`
      CREATE TABLE triage_events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT,
        category_hint TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        triage_result TEXT,
        recipient_id TEXT,
        error TEXT,
        cost_cny REAL NOT NULL DEFAULT 0,
        triage_latency_ms INTEGER
      );
      CREATE TABLE triage_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        delivered_at INTEGER NOT NULL
      );
      CREATE TABLE triage_source_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE triage_followups (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        activity TEXT NOT NULL,
        expected_minutes INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'queued', 'dispatched', 'cancelled', 'expired')),
        recipient_key TEXT,
        event_id TEXT,
        cancel_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(contact_id, message_id)
      );
    `);
  } finally {
    seed.close();
  }
  const store = new TriageStore(file);
  try {
    store.enqueue({ source: 'legacy', summary: 'after migrate', dedupeKey: 'legacy-1' });
    const claimed = store.claim();
    store.recordDelivery(claimed.id, 'codex', Date.now(), DELIVERY_POOL_DAILY);
    assert.equal(store.poolUsage(DELIVERY_POOL_DAILY).count, 1);
    const deliveryColumns = store.db.prepare('PRAGMA table_info(triage_deliveries)').all();
    assert.ok(deliveryColumns.some((column) => column.name === 'message_id'));
    assert.ok(deliveryColumns.some((column) => column.name === 'executed_via'));
    assert.equal(
      store.db.prepare('SELECT executed_via FROM triage_deliveries LIMIT 1').get().executed_via,
      EXECUTED_VIA_NONE,
    );
    assert.ok(store.db.prepare('PRAGMA table_info(triage_outcomes)').all().length > 0);
    const followupColumns = store.db.prepare('PRAGMA table_info(triage_followups)').all();
    assert.ok(followupColumns.some((column) => column.name === 'return_commitment'));
    assert.ok(followupColumns.some((column) => column.name === 'fallback_reminded_at'));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('outcome labels stay conservative, monotonic, and visible in health metrics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-outcomes-'));
  const store = new TriageStore(path.join(dir, 'triage.db'));
  try {
    const now = Date.parse('2026-07-29T10:00:00Z');
    store.enqueue({ source: 'backlog', summary: 'ship exact task', dedupeKey: 'outcome-1' });
    const event = store.claim(now);
    store.finish(event.id, 'dispatched', {
      recipientId: 'codex',
      triageResult: {
        actionable: true,
        category: 'backlog',
        priority: 2,
        suggestedRecipient: 'codex',
        rationale: 'real task',
        taskPath: 'tasks/real-task.md',
      },
    }, now);
    const deliveryId = store.recordDelivery(
      event.id,
      'codex',
      now,
      DELIVERY_POOL_TASK,
      {
        messageId: 101,
        taskPath: 'tasks/real-task.md',
        executedVia: EXECUTED_VIA_WORKER,
      },
    );

    assert.equal(store.outcomeCandidates()[0].label, OUTCOME_LABEL_UNKNOWN);
    assert.equal(store.recordOutcome(
      deliveryId,
      OUTCOME_LABEL_ENGAGED,
      { replyMessageId: 102 },
      now + 1,
    ), true);
    assert.equal(store.recordOutcome(
      deliveryId,
      OUTCOME_LABEL_ACCEPTED,
      { taskPath: 'tasks/real-task.md' },
      now + 2,
    ), true);
    assert.equal(store.recordOutcome(
      deliveryId,
      OUTCOME_LABEL_ENGAGED,
      { replyMessageId: 103 },
      now + 3,
    ), false);
    assert.equal(store.recordOutcome(
      deliveryId,
      OUTCOME_LABEL_REWORKED,
      { tailPath: 'tasks/worker-tail-job.md' },
      now + 4,
    ), true);
    assert.equal(store.recordOutcome(
      deliveryId,
      OUTCOME_LABEL_REJECTED,
      { replyMessageId: 104 },
      now + 5,
    ), true);

    const outcomes = store.dailySummary(now + 5).outcomes;
    assert.equal(outcomes.total, 1);
    assert.equal(outcomes.labels.rejected, 1);
    assert.equal(outcomes.unknownRatio, 0);
    assert.equal(outcomes.strongRatio, 1);
    assert.equal(outcomes.byExecutedVia.worker.total, 1);
    assert.equal(outcomes.byExecutedVia.worker.labels.rejected, 1);
    assert.equal(outcomes.byExecutedVia.contact.total, 0);
    assert.equal(outcomes.byExecutedVia.none.total, 0);
    assert.equal(store.outcomeCandidates().length, 0);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('outcome evidence only accepts manual user replies and exact linked tails', () => {
  assert.equal(classifyOutcomeMessage({
    sender: 'assistant', role: 'assistant', status: 'done', content: 'reply',
  }), null);
  assert.equal(classifyOutcomeMessage({
    sender: 'system', role: 'user', status: 'done', content: 'automated trigger',
  }), null);
  assert.equal(classifyOutcomeMessage({
    sender: 'user', role: 'user', status: 'done', content: '好，我看到了',
  }), OUTCOME_LABEL_ENGAGED);
  assert.equal(classifyOutcomeMessage({
    sender: 'user', role: 'user', status: 'done', content: '不要再发这种提醒了',
  }), OUTCOME_LABEL_REJECTED);
  // True stop-delivery rejections (must keep matching after pattern tighten)
  assert.equal(classifyOutcomeMessage({
    sender: 'user', role: 'user', status: 'done', content: '别再发了',
  }), OUTCOME_LABEL_REJECTED);
  assert.equal(classifyOutcomeMessage({
    sender: 'user', role: 'user', status: 'done', content: '不要再提醒我',
  }), OUTCOME_LABEL_REJECTED);
  assert.equal(classifyOutcomeMessage({
    sender: 'user', role: 'user', status: 'done', content: '别推送这个',
  }), OUTCOME_LABEL_REJECTED);
  assert.equal(classifyOutcomeMessage({
    sender: 'user', role: 'user', status: 'done', content: '不要再派这种任务了',
  }), OUTCOME_LABEL_REJECTED);
  // M1 false positive: engineering instruction with "不要…。只派" across sentences
  // must stay engaged — not rejected (delivery_id=24 root cause).
  assert.equal(classifyOutcomeMessage({
    sender: 'user',
    role: 'user',
    status: 'done',
    content: '禁止改文件、commit、push、部署；不要自己用终端代查。只派一次；…',
  }), OUTCOME_LABEL_ENGAGED);
  assert.equal(classifyOutcomeMessage({
    sender: 'user', role: 'user', status: 'done', content: '不要自己用终端代查。只派一次',
  }), OUTCOME_LABEL_ENGAGED);
  assert.equal(classifyOutcomeMessage({
    sender: 'user', role: 'user', status: 'done', content: '不要主动改文件',
  }), OUTCOME_LABEL_ENGAGED);
  assert.equal(classifyOutcomeMessage({
    sender: 'user',
    role: 'user',
    status: 'done',
    content: 'looks manual',
    meta: JSON.stringify({ automation: { messageType: 'background-event' } }),
  }), null);
  assert.equal(isTaskCompletionMessage({
    id: 9,
    sender: 'assistant',
    role: 'assistant',
    status: 'done',
    content: '已更新并归档：tasks/real-task.md → done；_archive/retired/real-task.md',
  }, 'tasks/real-task.md'), true);
  assert.equal(isTaskCompletionMessage({
    id: 10,
    sender: 'assistant',
    role: 'assistant',
    status: 'done',
    content: '已更新并归档：tasks/other-task.md → done',
  }, 'tasks/real-task.md'), false);
  assert.equal(isTaskCompletionMessage({
    id: 11,
    sender: 'user',
    role: 'user',
    status: 'done',
    content: '已更新并归档：tasks/real-task.md → done',
  }, 'tasks/real-task.md'), false);

  assert.equal(linkedReworkTail('tasks/real-task.md', 'event-1', [
    { taskPath: 'tasks/worker-tail-unrelated.md', content: 'tasks/other.md' },
    { taskPath: 'tasks/deploy-ai-hub-deadbee.md', content: 'from tasks/real-task.md' },
  ])?.taskPath, 'tasks/deploy-ai-hub-deadbee.md');
  assert.equal(linkedReworkTail('tasks/missing.md', 'event-missing', [
    { taskPath: 'tasks/worker-tail-unrelated.md', content: 'tasks/other.md' },
  ]), null);
  assert.deepEqual(normalizeOutcomeConfig({}), {
    enabled: true,
    intervalMinutes: 5,
    maxAgeDays: 30,
    batchSize: 50,
  });
});

test('Shanghai silent window and daily delivery pools stay separate from task quotas', () => {
  // 2026-07-25 16:30 UTC = 2026-07-26 00:30 Asia/Shanghai → silent
  assert.equal(isShanghaiSilentHour(Date.parse('2026-07-25T16:30:00Z'), 0, 9), true);
  // 2026-07-26 01:15 UTC = 09:15 Asia/Shanghai → open
  assert.equal(isShanghaiSilentHour(Date.parse('2026-07-26T01:15:00Z'), 0, 9), false);
  assert.match(buildDailyCheckSummary({ summary: 'hello' }, Date.parse('2026-07-26T01:15:00Z')), /Asia\/Shanghai/);
  assert.match(buildDailyCheckSummary(
    { summary: 'hello' },
    Date.parse('2026-07-26T10:15:00Z'),
    {
      proactive: { silentStartHour: 1, silentEndHour: 8 },
      forceActionable: true,
    },
  ), /guaranteed daily slot/);
  assert.equal(shanghaiClock(Date.parse('2026-07-26T01:15:00Z')).hour, 9);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-pool-'));
  const store = new TriageStore(path.join(dir, 'triage.db'));
  try {
    const now = Date.parse('2026-07-26T04:00:00Z'); // 12:00 Shanghai
    store.enqueue({ source: 'task', summary: 'work item', dedupeKey: 't1' });
    store.enqueue({ source: 'daily', summary: 'care item', dedupeKey: 'd1' });
    const task = store.claim(now);
    store.recordDelivery(task.id, 'claude', now, DELIVERY_POOL_TASK);
    store.finish(task.id, 'dispatched', {
      recipientId: 'claude',
      triageResult: {
        actionable: true,
        category: 'system',
        priority: 1,
        suggestedRecipient: 'claude',
        rationale: 'task',
      },
    }, now);
    const daily = store.claim(now + 1);
    store.recordDelivery(daily.id, 'claude', now + 1, DELIVERY_POOL_DAILY);
    store.finish(daily.id, 'dispatched', {
      recipientId: 'claude',
      triageResult: {
        actionable: true,
        category: 'daily',
        priority: 1,
        suggestedRecipient: 'claude',
        rationale: 'care',
      },
    }, now + 1);

    assert.equal(store.recipientUsage('claude', now + 1, DELIVERY_POOL_TASK).count, 1);
    assert.equal(store.recipientUsage('claude', now + 1, DELIVERY_POOL_DAILY).count, 1);
    // Task quota path only sees the task pool.
    assert.equal(store.recipientUsage('claude', now + 1).count, 1);
    assert.deepEqual(store.poolUsage(DELIVERY_POOL_DAILY, now + 1), {
      count: 1,
      lastAt: now + 1,
      since: Date.parse('2026-07-25T16:00:00Z'),
    });
    const summary = store.dailySummary(now + 1);
    assert.equal(summary.dailyPoolDispatched, 1);
    assert.equal(summary.dailyChecks, 1);
    assert.equal(summary.dailyNoops, 0);
    assert.equal(summary.lastDailyDeliveryAt, new Date(now + 1).toISOString());
    assert.equal(summary.pools.task, 1);
    assert.equal(summary.pools.daily, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('minimal streamable HTTP MCP client initializes a session and calls a vault tool', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      seen.push({ message, session: req.headers['mcp-session-id'] });
      if (message.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'session-1',
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: 'vault result' }] },
        })}\n\n`);
      }
    });
  });
  const address = await listenOnFetchSafePort(server);
  const client = new VaultClient({ url: `http://127.0.0.1:${address.port}/mcp` });
  try {
    assert.equal(await client.call('search_vault', { query: 'triage-backlog' }), 'vault result');
    assert.equal(await client.taskContext(), 'vault result');
    assert.equal(seen[0].message.method, 'initialize');
    assert.equal(seen[1].session, 'session-1');
    assert.equal(seen[2].message.method, 'tools/call');
    assert.equal(seen[3].message.params.name, 'get_task_context');
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('controlled idea diary delivery retries without reopening or duplicating the idea', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-idea-diary-mcp-'));
  const store = new TriageStore(path.join(dir, 'triage.db'));
  const toolCalls = [];
  let failWrites = true;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': `idea-session-${message.id}`,
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else {
        toolCalls.push(message.params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: failWrites
            ? { isError: true, content: [{ type: 'text', text: 'mock vault unavailable' }] }
            : { content: [{ type: 'text', text: 'diary/mock.md' }] },
        }));
      }
    });
  });
  const address = await listenOnFetchSafePort(server);
  const vault = new VaultClient({ url: `http://127.0.0.1:${address.port}/mcp` });
  try {
    const queued = store.enqueue({
      source: 'daily-idea-room',
      summary: 'Host one discussion.',
      dedupeKey: 'controlled-idea-diary',
    });
    const event = store.claim(1000);
    const triageResult = {
      actionable: true,
      category: 'idea',
      priority: 1,
      suggestedRecipient: 'room',
      rationale: 'novel topic',
      stage: 'completed',
      topic: '如果 AI 能消除一种摩擦，会是什么？',
      ideaCategory: 'daily-life',
      summary: 'DS 收尾：便利与自主需要平衡。',
      summaryMessageId: 20,
    };
    const payload = buildIdeaDiaryRequest({
      eventId: queued.id,
      room: { id: 'room', name: '会议室' },
      topic: triageResult.topic,
      topicCategory: triageResult.ideaCategory,
      participantNames: ['Claude', 'Codex'],
      summary: triageResult.summary,
      summaryMessageId: 20,
      topicMessageId: 10,
      roundId: 'round-1',
      completedAt: 2000,
    });
    const vaultWrite = {
      id: 'idea-diary:controlled',
      dedupeKey: `idea:${queued.id}:summary:20`,
      payload,
    };
    store.completeIdea(event.id, { roomId: 'room', triageResult, vaultWrite }, 2000);

    const first = store.claimVaultWrite(2000);
    await assert.rejects(() => vault.writeDiary(first.payload), /mock vault unavailable/);
    store.retryVaultWrite(first.id, 'mock vault unavailable', 1000, 2000);
    assert.equal(store.db.prepare('SELECT status FROM triage_events WHERE id = ?').get(event.id).status, 'dispatched');

    failWrites = false;
    const retry = store.claimVaultWrite(3000);
    await vault.writeDiary(retry.payload);
    store.finishVaultWrite(retry.id, 3000);
    store.completeIdea(event.id, { roomId: 'room', triageResult, vaultWrite }, 4000);

    assert.equal(toolCalls.filter((call) => call.name === 'write_diary').length, 3);
    assert.equal(toolCalls.filter((call) => call.name === 'write_diary' && call.arguments.slug === payload.slug).length, 3);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM triage_vault_outbox').get().count, 1);
    assert.equal(store.dailySummary(4000).ideaDiariesWritten, 1);
    assert.doesNotMatch(toolCalls.at(-1).arguments.content, /完整发言正文/);
  } finally {
    await vault.close();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub dispatch defaults to main and declares automation source', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.method === 'GET'
        ? { messages: [{ id: 43, sender: 'user', role: 'user', content: '收到' }] }
        : { queued: true, messageId: received.length }));
    });
  });
  const address = await listenOnFetchSafePort(server);
  const client = new HubClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    timeoutMs: 2000,
  });
  try {
    await client.dispatch('codex', 'task flow', {
      automation: {
        messageType: 'background-event', eventSource: 'quarter-hour-check', eventId: 'event-task',
        eventCategory: 'backlog', eventPriority: 2,
      },
    });
    await client.dispatch('codex', 'daily flow', {
      origin: 'main', hidden: true,
      automation: {
        messageType: 'proactive-trigger', eventSource: 'daily-check-in', eventId: 'event-daily',
        eventCategory: 'daily', eventPriority: 1,
      },
    });
    const outcomeMessages = await client.messages('codex', 42, 200, 'all');
    assert.equal(outcomeMessages[0].id, 43);
    assert.deepEqual(received.slice(0, 2), [
      {
        url: '/api/contacts/codex/messages',
        body: {
          content: 'task flow', origin: 'main', automated: true, hidden: false,
          automation: {
            messageType: 'background-event', eventSource: 'quarter-hour-check', eventId: 'event-task',
            eventCategory: 'backlog', eventPriority: 2,
          },
        },
      },
      {
        url: '/api/contacts/codex/messages',
        body: {
          content: 'daily flow', origin: 'main', automated: true, hidden: true,
          automation: {
            messageType: 'proactive-trigger', eventSource: 'daily-check-in', eventId: 'event-daily',
            eventCategory: 'daily', eventPriority: 1,
          },
        },
      },
    ]);
    assert.equal(received.length, 3);
    const messagesUrl = new URL(received[2].url, 'http://localhost');
    assert.equal(messagesUrl.pathname, '/api/contacts/codex/messages');
    assert.deepEqual([...messagesUrl.searchParams.keys()].sort(), ['after', 'limit', 'origin']);
    assert.equal(messagesUrl.searchParams.get('after'), '42');
    assert.equal(messagesUrl.searchParams.get('limit'), '200');
    assert.equal(messagesUrl.searchParams.get('origin'), 'all');
    assert.equal(received[2].body, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
