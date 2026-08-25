import crypto from 'node:crypto';

const ACTIVE_JOB_STATUSES = new Set([
  'pending',
  'claimed',
  'running',
  'recovering',
  'pause_requested',
  'cancel_requested',
]);

const EXCEPTION_JOB_STATUSES = new Set([
  'failed',
  'interrupted',
  'blocked',
  'expired',
]);

const T3_PATTERN = /(?:删除|清空|force[ -]?push|强推|回滚生产|生产部署|正式部署|外发|发送给第三方|权限扩张|凭据|密钥|付费|付款)/iu;
const T2_PATTERN = /(?:依赖.{0,12}升级|升级.{0,12}依赖|数据库.{0,12}迁移|迁移.{0,12}数据库|部署|发布候选|共享环境|范围不清|待拆分|产品取舍|权限|账号设置)/iu;
const T0_PATTERN = /(?:只读|读取|扫描|审计|盘点|检查|验证|测试|报告|草稿|排序|去重)/iu;
const T1_PATTERN = /(?:修复|实现|新增|补齐|文档|格式化|重构|代码|回归测试)/iu;

function integer(value, fallback, label, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function normalizeAgendaConfig(raw = {}, coordination = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('agenda must be an object');
  }
  const inheritedRoomId = typeof coordination?.roomId === 'string' ? coordination.roomId.trim() : '';
  const inheritedHostName = typeof coordination?.hostName === 'string'
    ? coordination.hostName.trim()
    : '';
  return {
    enabled: raw.enabled !== false,
    atHour: integer(raw.atHour, 9, 'agenda.atHour', 0, 23),
    atMinute: integer(raw.atMinute, 0, 'agenda.atMinute', 0, 59),
    roomId: typeof raw.roomId === 'string' && raw.roomId.trim()
      ? raw.roomId.trim()
      : inheritedRoomId,
    hostName: typeof raw.hostName === 'string' && raw.hostName.trim()
      ? raw.hostName.trim()
      : inheritedHostName || 'DS 主持',
    maxAuto: integer(raw.maxAuto, 2, 'agenda.maxAuto', 1, 2),
    maxAsk: integer(raw.maxAsk, 3, 'agenda.maxAsk', 1, 3),
    jobsLimit: integer(raw.jobsLimit, 300, 'agenda.jobsLimit', 1, 300),
    resurfaceDays: integer(raw.resurfaceDays, 7, 'agenda.resurfaceDays', 1, 3650),
    tasksDir: typeof coordination?.tasksDir === 'string' ? coordination.tasksDir.trim() : '',
  };
}

function parseTags(raw) {
  return String(raw ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function priorityFrom(text) {
  const match = String(text ?? '').match(/(?:^|[^a-z0-9])P([0-3])(?:$|[^a-z0-9])/iu);
  return match ? Number(match[1]) : 4;
}

function dateFromPath(path) {
  return String(path ?? '').match(/(?:^|\/)(\d{4}-\d{2}-\d{2})[_-]/u)?.[1] ?? null;
}

function dueFromLine(line, path, today) {
  const annotation = String(line).replace(`\`${path}\``, '');
  if (/今天到期/u.test(annotation)) return today;
  return annotation.match(/(?:到期|due[^\d]*|截止[^\d]*)(\d{4}-\d{2}-\d{2})/iu)?.[1]
    ?? annotation.match(/(\d{4}-\d{2}-\d{2})(?:[^\n]{0,12})(?:到期|截止)/u)?.[1]
    ?? null;
}

export function parseAgendaListing(text, kind, { today = '' } = {}) {
  const items = [];
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const match = line.match(/^\s*-\s+\*\*(.+?)\*\*\s+\(`([^`]+)`\)(?:\s+\[([^\]]*)\])?/u);
    if (!match) continue;
    const [, title, path, tagText] = match;
    const tags = parseTags(tagText);
    items.push({
      id: `${kind}:${path}`,
      kind,
      title: title.trim(),
      path,
      tags,
      due: kind === 'task' ? dueFromLine(line, path, today) : null,
      priority: priorityFrom(`${title} ${tags.join(' ')} ${line}`),
      created: dateFromPath(path),
    });
  }
  return items;
}

function compareNullableDate(left, right) {
  if (left && right) return left.localeCompare(right);
  if (left) return -1;
  if (right) return 1;
  return 0;
}

export function sortAgendaItems(items) {
  return [...items].sort((left, right) => (
    compareNullableDate(left.due, right.due)
    || Number(left.priority ?? 4) - Number(right.priority ?? 4)
    || compareNullableDate(left.created, right.created)
    || String(left.path ?? left.id).localeCompare(String(right.path ?? right.id), 'zh-CN')
  ));
}

function taskTier(item) {
  const text = `${item.title} ${item.tags.join(' ')}`;
  if (T3_PATTERN.test(text)) return 'T3';
  if (T2_PATTERN.test(text)) return 'T2';
  if (item.taskFileReadable) return item.mode === 'auto' ? 'T1' : 'T2';
  if (T0_PATTERN.test(text)) return 'T0';
  if (T1_PATTERN.test(text)) return 'T1';
  // Unknown scope is a decision, never an implicit auto candidate.
  return 'T2';
}

function inboxNeedsDecision(item) {
  const text = `${item.title} ${item.tags.join(' ')}`;
  return /(?:需求|待拆分|待办|req[:：]|bug线索)/iu.test(text);
}

function jobTaskPath(job) {
  const options = job?.options && typeof job.options === 'object' && !Array.isArray(job.options)
    ? job.options
    : {};
  return typeof options.taskPath === 'string' ? options.taskPath.trim() : '';
}

function timestamp(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function reconcileAgendaJobs(jobs, tasks, now = Date.now()) {
  const taskPaths = new Set(tasks.map((item) => item.path));
  const observations = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const status = String(job?.status ?? 'unknown');
    const taskPath = jobTaskPath(job);
    const leaseUntil = timestamp(job?.lease_until);
    let reason = '';
    if (ACTIVE_JOB_STATUSES.has(status) && leaseUntil !== null && leaseUntil <= now) {
      reason = 'lease 已过期';
    } else if (
      ['claimed', 'running', 'recovering'].includes(status)
      && (!taskPath || !taskPaths.has(taskPath))
    ) {
      reason = '幽灵 running：没有对应的 open task';
    } else if (
      EXCEPTION_JOB_STATUSES.has(status)
      || job?.delivery_summary?.state === 'failure_or_blocked'
    ) {
      reason = `异常回执：${status}`;
    }
    if (!reason) continue;
    observations.push({
      id: `job:${job.id}`,
      kind: 'job',
      title: `job ${job.id}`,
      path: taskPath,
      reason,
      status,
      updated: job.updated_at ?? null,
    });
  }
  return observations.sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function displayItem(item, suffix = '') {
  const due = item.due ? `，due ${item.due}` : '';
  const priority = Number(item.priority) <= 3 ? `，P${item.priority}` : '';
  return `- ${item.title}（${item.path}${priority}${due}${suffix}）`;
}

function contentFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function dueState(due, today) {
  if (!due) return 'none';
  if (!today) return 'dated';
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return 'future';
}

function itemPromptFingerprint(item, today) {
  return contentFingerprint({
    source: item.sourceFingerprint ?? {
      title: item.title,
      tags: item.tags,
      due: item.due,
    },
    priority: item.priority,
    dueState: dueState(item.due, today),
    tier: item.tier,
  });
}

function normalizePreviousState(previousState) {
  const value = previousState && typeof previousState === 'object' && !Array.isArray(previousState)
    ? previousState
    : {};
  return {
    items: value.items && typeof value.items === 'object' && !Array.isArray(value.items)
      ? value.items
      : {},
    jobs: value.jobs && typeof value.jobs === 'object' && !Array.isArray(value.jobs)
      ? value.jobs
      : {},
    health: typeof value.health === 'string' ? value.health : '',
  };
}

function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
}

function dayNumber(value) {
  const match = validDay(value)?.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000);
}

function elapsedDays(from, to) {
  const start = dayNumber(from);
  const end = dayNumber(to);
  return start === null || end === null ? 0 : Math.max(0, end - start);
}

function notificationState(raw, currentValue, today) {
  if (typeof raw === 'string') {
    // v2 stored only a fingerprint/status and marked overflow as seen. Treat it as
    // unshown once during the v3 upgrade so no legacy entry stays hidden forever.
    return { value: raw, lastShown: null, firstSeen: today, legacy: true };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      value: typeof raw.fp === 'string'
        ? raw.fp
        : typeof raw.status === 'string'
          ? raw.status
          : currentValue,
      lastShown: validDay(raw.lastShown),
      firstSeen: validDay(raw.firstSeen) ?? today,
      legacy: false,
    };
  }
  return { value: currentValue, lastShown: null, firstSeen: today, legacy: false };
}

function compareNotification(left, right) {
  if (Boolean(left.state.lastShown) !== Boolean(right.state.lastShown)) {
    return left.state.lastShown ? 1 : -1;
  }
  return String(left.state.lastShown ?? '').localeCompare(String(right.state.lastShown ?? ''))
    || String(left.state.firstSeen ?? '').localeCompare(String(right.state.firstSeen ?? ''))
    || left.order - right.order;
}

function prepareItemNotifications(items, previousItems, today, resurfaceDays) {
  return items.map((item, order) => {
    const fingerprint = itemPromptFingerprint(item, today);
    const state = notificationState(previousItems[item.id], fingerprint, today);
    const currentDueState = dueState(item.due, today);
    const eligible = state.legacy
      || !state.lastShown
      || state.value !== fingerprint
      || currentDueState === 'today'
      || currentDueState === 'overdue'
      || elapsedDays(state.lastShown, today) >= resurfaceDays;
    return { item, order, fingerprint, state, eligible };
  });
}

function selectNotifications(entries, limit = Infinity) {
  const eligible = entries.filter((entry) => entry.eligible).sort(compareNotification);
  return {
    selected: eligible.slice(0, limit),
    overflow: eligible.slice(limit),
    suppressed: entries.length - eligible.length,
  };
}

function nextItemState(entries, shownIds, today) {
  return Object.fromEntries(entries.map((entry) => {
    const shown = shownIds.has(entry.item.id);
    return [entry.item.id, {
      fp: shown ? entry.fingerprint : entry.state.value,
      lastShown: shown ? today : entry.state.lastShown,
      firstSeen: entry.state.firstSeen,
    }];
  }));
}

function prepareJobNotifications(items, previousJobs, today) {
  return items.map((item, order) => {
    const state = notificationState(previousJobs[item.id], item.status, today);
    return {
      item,
      order,
      state,
      eligible: state.legacy || !state.lastShown || state.value !== item.status,
    };
  });
}

function nextJobState(entries, shownIds, today) {
  return Object.fromEntries(entries.map((entry) => {
    const shown = shownIds.has(entry.item.id);
    return [entry.item.id, {
      status: shown ? entry.item.status : entry.state.value,
      lastShown: shown ? today : entry.state.lastShown,
      firstSeen: entry.state.firstSeen,
    }];
  }));
}

function stablePlanPayload(plan) {
  const displayFields = ({ id, title, path, tier, due, priority, reason, status }) => ({
    id,
    title,
    path,
    tier,
    due,
    priority,
    reason,
    status,
  });
  return {
    health: plan.health,
    wouldAuto: plan.wouldAuto.map(displayFields),
    wouldAsk: plan.wouldAsk.map(displayFields),
    deferred: plan.deferred.map(displayFields),
    reconcile: plan.reconcile.map(displayFields),
  };
}

export function agendaFingerprint(plan) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stablePlanPayload(plan)))
    .digest('hex');
}

export function buildAgendaPlan({
  inboxText = '',
  taskContextText = '',
  jobs = [],
  now = Date.now(),
  today,
  health = [],
  blockingHealth = health,
  taskMetadata = {},
  previousState = {},
  config = normalizeAgendaConfig({}),
} = {}) {
  const tasks = sortAgendaItems(parseAgendaListing(taskContextText, 'task', { today }).map((item) => {
    const metadata = taskMetadata?.[item.path];
    return metadata ? {
      ...item,
      mode: metadata.mode ?? null,
      taskFileReadable: metadata.readable === true,
      sourceFingerprint: metadata.contentFingerprint ?? null,
    } : item;
  }));
  const inbox = sortAgendaItems(parseAgendaListing(inboxText, 'inbox', { today }));
  const healthNotes = [...new Set((Array.isArray(health) ? health : []).map(String).filter(Boolean))];
  const blockingHealthNotes = [...new Set(
    (Array.isArray(blockingHealth) ? blockingHealth : []).map(String).filter(Boolean),
  )];
  const rawAutoCandidates = [];
  const rawAskCandidates = [];
  const rawDeferred = [];

  if (!blockingHealthNotes.length) {
    for (const item of tasks) {
      const tier = taskTier(item);
      if (tier === 'T0' || tier === 'T1') {
        rawAutoCandidates.push({ ...item, tier });
      } else {
        rawAskCandidates.push({ ...item, tier });
      }
    }
  } else {
    rawDeferred.push(...tasks.map((item) => ({ ...item, tier: taskTier(item), reason: 'health gate 未通过' })));
  }

  for (const item of inbox) {
    if (inboxNeedsDecision(item)) {
      if (!blockingHealthNotes.length) {
        rawAskCandidates.push({ ...item, tier: 'T2' });
      } else {
        rawDeferred.push({
          ...item,
          tier: 'T2',
          reason: 'health gate 未通过',
        });
      }
    } else {
      rawDeferred.push({ ...item, tier: 'T0', reason: 'inbox 非行动型，保持待确认' });
    }
  }

  const previous = normalizePreviousState(previousState);
  const agendaDate = validDay(today) ?? new Date(now).toISOString().slice(0, 10);
  const allItems = [...rawAutoCandidates, ...rawAskCandidates, ...rawDeferred];
  const itemEntries = prepareItemNotifications(
    allItems,
    previous.items,
    agendaDate,
    config.resurfaceDays,
  );
  const entriesById = new Map(itemEntries.map((entry) => [entry.item.id, entry]));
  const entriesFor = (items) => items.map((item) => entriesById.get(item.id)).filter(Boolean);
  const autoSelection = selectNotifications(entriesFor(rawAutoCandidates), config.maxAuto);
  const askSelection = selectNotifications(entriesFor(rawAskCandidates), config.maxAsk);
  const deferredEntries = [
    ...autoSelection.overflow.map((entry) => ({
      ...entry,
      item: { ...entry.item, reason: '超过每日 would-auto 上限' },
    })),
    ...askSelection.overflow.map((entry) => ({
      ...entry,
      item: { ...entry.item, reason: '超过单次决定上限' },
    })),
    ...entriesFor(rawDeferred).filter((entry) => entry.eligible),
  ];
  const deferredSelection = selectNotifications(deferredEntries, 8);
  const wouldAuto = autoSelection.selected.map((entry) => entry.item);
  const wouldAsk = askSelection.selected.map((entry) => entry.item);
  const deferred = deferredSelection.selected.map((entry) => entry.item);
  const shownItemIds = new Set([
    ...wouldAuto.map((item) => item.id),
    ...wouldAsk.map((item) => item.id),
    ...deferred.map((item) => item.id),
  ]);
  const nextItems = nextItemState(itemEntries, shownItemIds, agendaDate);
  const reconcileAll = reconcileAgendaJobs(jobs, tasks, now);
  const jobEntries = prepareJobNotifications(reconcileAll, previous.jobs, agendaDate);
  const jobSelection = selectNotifications(jobEntries, 8);
  const reconcile = jobSelection.selected.map((entry) => entry.item);
  const shownJobIds = new Set(reconcile.map((item) => item.id));
  const nextJobs = nextJobState(jobEntries, shownJobIds, agendaDate);
  const healthFingerprint = healthNotes.length ? contentFingerprint(healthNotes) : '';
  const visibleHealth = healthFingerprint !== previous.health ? healthNotes : [];
  const taskEntries = itemEntries.filter((entry) => entry.item.kind === 'task');
  const oldestTaskEntry = [...taskEntries].sort((left, right) => (
    String(left.state.firstSeen).localeCompare(String(right.state.firstSeen))
    || left.order - right.order
  ))[0] ?? null;
  const plan = {
    health: visibleHealth,
    wouldAuto,
    wouldAsk,
    deferred,
    reconcile,
    suppressedAutoCount: autoSelection.suppressed,
    suppressedDecisionCount: askSelection.suppressed
      + entriesFor(rawDeferred).filter((entry) => !entry.eligible).length,
    suppressedItemCount: itemEntries.filter((entry) => !entry.eligible).length,
    deferredFoldedCount: deferredSelection.overflow.length,
    reconcileFoldedCount: reconcileAll.length - reconcile.length,
    taskCount: tasks.length,
    inboxCount: inbox.length,
    overview: {
      openTaskCount: tasks.length,
      expandedTaskCount: new Set(
        [...shownItemIds].filter((id) => entriesById.get(id)?.item.kind === 'task'),
      ).size,
      suppressedTaskCount: taskEntries.filter((entry) => !entry.eligible).length,
      oldest: oldestTaskEntry ? {
        title: oldestTaskEntry.item.title,
        path: oldestTaskEntry.item.path,
        ageDays: elapsedDays(oldestTaskEntry.state.firstSeen, agendaDate),
      } : null,
    },
    sourceState: {
      schemaVersion: 3,
      items: nextItems,
      jobs: nextJobs,
      health: healthFingerprint,
    },
  };
  return { ...plan, fingerprint: agendaFingerprint(plan) };
}

export function hasAgendaIncrement(plan) {
  return Boolean(
    plan.health.length
    || plan.wouldAuto.length
    || plan.wouldAsk.length
    || plan.deferred.length
    || plan.reconcile.length
  );
}

export function formatAgendaDigest(plan, { date = '' } = {}) {
  const auto = plan.wouldAuto.length
    ? plan.wouldAuto.map((item) => displayItem(item, `，${item.tier}`))
    : ['- 无'];
  const ask = plan.wouldAsk.length
    ? plan.wouldAsk.map((item, index) => `${index + 1}. ${item.title}（${item.path}，${item.tier}）`)
    : ['- 无'];
  const tail = [
    ...plan.health.map((note) => `- health: ${note}`),
    ...plan.reconcile.map((item) => `- ${item.title}：${item.reason}${item.path ? `（${item.path}）` : ''}`),
    ...plan.deferred.map((item) => displayItem(item, `，${item.reason}`)),
  ];
  if (plan.deferredFoldedCount > 0) tail.push(`- 另有 ${plan.deferredFoldedCount} 项延后未展开`);
  if (plan.reconcileFoldedCount > 0) {
    tail.push(`- 另有 ${plan.reconcileFoldedCount} 项异常状态无变化或未展开`);
  }
  if (!tail.length) tail.push('- 无');
  const oldest = plan.overview?.oldest;
  const oldestText = oldest
    ? `${oldest.title}（${oldest.path}，${oldest.ageDays} 天）`
    : '无';
  tail.push(
    `- 总览：open 任务 ${plan.overview?.openTaskCount ?? plan.taskCount ?? 0} 项，`
    + `本次展开 ${plan.overview?.expandedTaskCount ?? 0} 项，`
    + `被抑制 ${plan.overview?.suppressedTaskCount ?? 0} 项；最老未处理：${oldestText}`,
  );
  return [
    `Agenda shadow${date ? ` · ${date}` : ''}`,
    '',
    '### would-auto（仅影子，不执行）',
    ...auto,
    '',
    '### would-ask',
    ...ask,
    '',
    '### deferred / 异常',
    ...tail,
  ].join('\n');
}
