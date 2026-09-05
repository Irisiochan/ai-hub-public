import { parseAgendaListing, sortAgendaItems, T3_PATTERN } from './agenda-core.mjs';

/**
 * 会议室路由初筛（route triage）的纯域函数。
 *
 * 形态：Agenda digest 之后，room-host 追发一条 nudge 点名 reviewer（默认 aye），
 * 把「无主任务」清单交给他按工作流协议给下一步路由建议（plan→cc / execute→codex、grok）。
 * v1 是纯影子：建议只落 worker SQLite 与群消息，不写 executor、不派单；
 * 改派率统计（User 实际派给谁 vs 建议给谁）按周贴回会议室。
 * v2（阶段二，autoDispatch）：建议落账后开一个否决窗口（默认 60 分钟），
 * User/Claude可在群里用 [VETO] 行否决；窗口过后未被否决、通过安全闸
 * （非 T3 敏感、非 mode:ask、仍无主、未过期）的建议由 room-host 自动派单闭环。
 */

export const ROUTE_TRIAGE_STAGES = ['plan', 'execute', 'review', 'maintenance'];

const DEFAULT_ALLOWED_RECIPIENTS = ['claude', 'codex', 'aye'];

// 与 triage-core buildDispatchableTaskContext 的尾巴任务排除保持同一语义。
const TAIL_TASK_PATH_RE = /^tasks\/(?:worker-tail-|deploy-)/i;

function integerConfig(value, fallback, label, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function normalizeRouteTriageConfig(raw = {}, coordination = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('routeTriage must be an object');
  }
  const inheritedRoomId = typeof coordination?.roomId === 'string' ? coordination.roomId.trim() : '';
  const inheritedHostName = typeof coordination?.hostName === 'string'
    ? coordination.hostName.trim()
    : '';
  const allowedRecipients = Array.isArray(raw.allowedRecipients) && raw.allowedRecipients.length
    ? [...new Set(raw.allowedRecipients.map((value) => String(value).trim().toLowerCase()).filter(Boolean))]
    : [...DEFAULT_ALLOWED_RECIPIENTS];
  const reviewer = String(raw.reviewer ?? 'aye').trim().toLowerCase();
  if (!reviewer) throw new Error('routeTriage.reviewer must be a contact id');
  const autoDispatchRaw = raw.autoDispatch ?? {};
  if (!autoDispatchRaw || typeof autoDispatchRaw !== 'object' || Array.isArray(autoDispatchRaw)) {
    throw new Error('routeTriage.autoDispatch must be an object');
  }
  // 'user' 是 User 在群消息里的 sender id；Claude的会议室习惯就是主动复核，所以默认双闸。
  const vetoSenders = Array.isArray(autoDispatchRaw.vetoSenders) && autoDispatchRaw.vetoSenders.length
    ? [...new Set(autoDispatchRaw.vetoSenders.map((value) => String(value).trim().toLowerCase()).filter(Boolean))]
    : ['user', 'claude'];
  return {
    enabled: raw.enabled === true,
    roomId: typeof raw.roomId === 'string' && raw.roomId.trim()
      ? raw.roomId.trim()
      : inheritedRoomId,
    hostName: typeof raw.hostName === 'string' && raw.hostName.trim()
      ? raw.hostName.trim().slice(0, 80)
      : inheritedHostName || 'DS 主持',
    reviewer,
    allowedRecipients,
    atHour: integerConfig(raw.atHour, 9, 'routeTriage.atHour', 0, 23),
    atMinute: integerConfig(raw.atMinute, 10, 'routeTriage.atMinute', 0, 59),
    maxItems: integerConfig(raw.maxItems, 8, 'routeTriage.maxItems', 1, 20),
    reactionRounds: integerConfig(raw.reactionRounds, 1, 'routeTriage.reactionRounds', 1, 3),
    roundPollMs: integerConfig(raw.roundPollMs, 2000, 'routeTriage.roundPollMs', 100, 60_000),
    roundTimeoutMs: integerConfig(
      raw.roundTimeoutMs,
      20 * 60_000,
      'routeTriage.roundTimeoutMs',
      10_000,
      60 * 60_000,
    ),
    resolveIntervalMinutes: integerConfig(
      raw.resolveIntervalMinutes,
      30,
      'routeTriage.resolveIntervalMinutes',
      1,
      24 * 60,
    ),
    resolveMaxAgeDays: integerConfig(raw.resolveMaxAgeDays, 30, 'routeTriage.resolveMaxAgeDays', 1, 365),
    // 0=周日 … 6=周六；默认周一贴一次改派率统计。
    statsWeekday: integerConfig(raw.statsWeekday, 1, 'routeTriage.statsWeekday', 0, 6),
    statsWindowDays: integerConfig(raw.statsWindowDays, 28, 'routeTriage.statsWindowDays', 7, 365),
    autoDispatch: {
      enabled: autoDispatchRaw.enabled === true,
      delayMinutes: integerConfig(
        autoDispatchRaw.delayMinutes,
        60,
        'routeTriage.autoDispatch.delayMinutes',
        5,
        24 * 60,
      ),
      // 超龄建议不自动派：躺了几天的 pending 突然开火只会吓人。
      maxAgeHours: integerConfig(
        autoDispatchRaw.maxAgeHours,
        48,
        'routeTriage.autoDispatch.maxAgeHours',
        1,
        24 * 14,
      ),
      dailyLimit: integerConfig(autoDispatchRaw.dailyLimit, 3, 'routeTriage.autoDispatch.dailyLimit', 1, 20),
      vetoSenders,
    },
  };
}

export function routeTriageStateKey(date) {
  return `route-triage:v1:${date}`;
}

export function routeTriageStatsStateKey(date) {
  return `route-triage-stats:v1:${date}`;
}

export function routeAutoDispatchStateKey(date) {
  return `route-auto-dispatch:v1:${date}`;
}

export function routeAutoDispatchKey(suggestion) {
  return `route-auto:v1:${suggestion.item_path}:${suggestion.suggest_date}`;
}

/** T3 敏感任务（删库/强推/生产部署/凭据/付款等）永远不进自动派单。 */
export function isAutoDispatchSafeTitle(text) {
  return !T3_PATTERN.test(String(text ?? ''));
}

/** 上海日期字符串的星期（0=周日）。日期串本身已按上海日界生成，按 UTC 解析即可。 */
export function shanghaiWeekdayOf(date) {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(parsed) ? new Date(parsed).getUTCDay() : null;
}

/**
 * 从 get_task_context 文本 + 任务文件元数据里选出「无主」候选：
 * status open（快照即 open）、非 worker-tail/deploy 尾巴、frontmatter 没有
 * executor/verifier、且不存在未决建议。文件读不到时无法证明无主，跳过并计数。
 */
export function selectRouteTriageCandidates({
  taskContextText = '',
  taskMetadata = {},
  pendingPaths = [],
  today = '',
  maxItems = 8,
} = {}) {
  const pending = new Set(pendingPaths.map((value) => String(value)));
  const skipped = { tail: 0, routed: 0, unreadable: 0, pending: 0 };
  const eligible = [];
  for (const item of sortAgendaItems(parseAgendaListing(taskContextText, 'task', { today }))) {
    if (TAIL_TASK_PATH_RE.test(item.path)) {
      skipped.tail += 1;
      continue;
    }
    if (pending.has(item.path)) {
      skipped.pending += 1;
      continue;
    }
    const metadata = taskMetadata?.[item.path];
    if (!metadata?.readable) {
      skipped.unreadable += 1;
      continue;
    }
    if (metadata.executor || metadata.verifier) {
      skipped.routed += 1;
      continue;
    }
    eligible.push(item);
  }
  return {
    candidates: eligible.slice(0, Math.max(1, maxItems)),
    foldedCount: Math.max(0, eligible.length - maxItems),
    skipped,
  };
}

function candidateLine(item, index) {
  const due = item.due ? `，due ${item.due}` : '';
  const priority = Number(item.priority) <= 3 ? `，P${item.priority}` : '';
  const tags = item.tags.length ? `，tags: ${item.tags.join('/')}` : '';
  return `${index + 1}. ${item.title}（\`${item.path}\`${priority}${due}${tags}）`;
}

export function formatRouteTriageNudge({
  date,
  reviewer,
  candidates,
  foldedCount = 0,
  allowedRecipients = DEFAULT_ALLOWED_RECIPIENTS,
  stages = ROUTE_TRIAGE_STAGES,
  autoDispatch = null,
}) {
  const recipients = allowedRecipients.join('|');
  const stageList = stages.join('|');
  const autoFooter = autoDispatch?.enabled
    ? [
      '',
      `⚙️ 自动派单已开启：本轮 [ROUTE] 建议落账 ${autoDispatch.delayMinutes} 分钟后，`
        + '未被否决且通过安全闸（非敏感操作、非 mode:ask、仍无主）的会自动派给建议对象。',
      'Claude或 User 如需拦下某条，请在窗口内单独一行回：',
      '[VETO] tasks/<file>.md | 一句理由',
    ]
    : [];
  return [
    `@${reviewer} 路由初筛征集 · ${date}`,
    '',
    '以下 open 任务缺少 executor/verifier，没人认领。请按工作流协议给每条一个下一步路由建议：',
    '需要先出 Plan 的复杂任务 → stage=plan、to=claude；可直接执行的简单任务 → stage=execute、to=codex 或 aye；',
    '只读验收/巡检类 → stage=review 或 maintenance。',
    '',
    ...candidates.map(candidateLine),
    ...(foldedCount > 0 ? [`（另有 ${foldedCount} 条本次未展开，明天轮到）`] : []),
    '',
    '回复格式（每条一行，行首标记必须原样）：',
    `[ROUTE] tasks/<file>.md | stage=<${stageList}> | to=<${recipients}> | 一句理由`,
    '[HOLD] tasks/<file>.md | 一句为什么现在不该派（信息不足/等 User 拍板等）',
    '',
    '注意：这是普通讨论轮次的初筛征集，不是 coordination 派单——本轮不要接单、不要调用',
    'delegate_to_worker、不要写 vault 任务文件。',
    '每条候选都要有一行 [ROUTE] 或 [HOLD]；不要只回 [PASS]。',
    ...autoFooter,
  ].join('\n');
}

/** 否决行解析：只认 vetoSenders 名单内发言人的 `[VETO] <path>` 行，路径必须命中给定集合。 */
export function parseRouteVetoes(rows, { paths = [], vetoSenders = ['user', 'claude'] } = {}) {
  const pathSet = new Set(paths.map((value) => String(value)));
  const senderSet = new Set(vetoSenders.map((value) => String(value).toLowerCase()));
  const vetoes = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.kind !== 'text' || row?.status !== 'done') continue;
    const sender = String(row.sender ?? '').toLowerCase();
    if (!senderSet.has(sender)) continue;
    for (const rawLine of String(row.content ?? '').split(/\r?\n/u)) {
      const match = rawLine.trim().replace(/^[-*]\s+/u, '').match(/^\[VETO\]\s*(\S+?)(?:\s*\|\s*(.*))?$/iu);
      if (!match) continue;
      const path = match[1].replace(/^`|`$/gu, '');
      if (!pathSet.has(path) || vetoes.has(path)) continue;
      vetoes.set(path, { path, sender, reason: (match[2] ?? '').slice(0, 300) });
    }
  }
  return [...vetoes.values()];
}

/** 阶段二派单块：execute/review/maintenance 直接派给建议对象。 */
export function formatAutoDispatchBlock({ suggestion, title }) {
  return [
    `@${suggestion.recipient} 路由派单（初筛闭环）：${title || suggestion.item_path}`,
    `任务文件：${suggestion.item_path}`,
    `建议阶段：${suggestion.stage}｜初筛理由：${suggestion.reason || '（未附）'}`,
    `来源：${suggestion.suggest_date} 阿野初筛，否决窗口已过，自动派单。`,
    '',
    '请先通过 memory-vault read_file 读取任务文件，再按下面三选一，不要扩写成第四种：',
    '1. [PASS]：读完确认当前无事可做（说明一句原因）。',
    '2. 就地完成：纯对话/记忆/登记类工作直接做完，回执写清做了什么。',
    '3. delegate_to_worker：凡需要真实仓库/文件状态、运行测试或 shell、改代码、构建部署的，转给本机执行；只传目标、约束和可判定验收标准。',
    '完成或受阻都在群里回执；不要自行把任务置 done，关单仍由 User 决定。',
  ].join('\n');
}

/** 阶段二 Plan 征集块：复杂件先向 claude 要 Plan，写回任务文件后由既有 coordination sweep 接手派执行。 */
export function formatPlanRequestBlock({ suggestion, title }) {
  return [
    `@${suggestion.recipient} Plan 征集（初筛闭环）：${title || suggestion.item_path}`,
    `任务文件：${suggestion.item_path}`,
    `初筛理由：${suggestion.reason || '（未附）'}`,
    `来源：${suggestion.suggest_date} 阿野初筛判定为需先出 Plan 的复杂件，否决窗口已过。`,
    '',
    '请读取任务文件后为它补一个可执行 Plan：在任务文件中写入 `## Plan（…）` 区块，',
    '包含固定步骤、验收标准，以及 `### 执行者与工作区`（executor、workspace 反引号路径、checkout -b 分支）。',
    'Plan 写回并把 frontmatter 标好 executor 后，coordination sweep 会自动向执行者派单——不需要你手工派。',
    '如判断该任务其实不需要 Plan 或范围不清，请在群里说明并 @User 定夺，不要硬编。',
  ].join('\n');
}

/** 逐行解析 reviewer 的结构化回复；路径必须命中候选集，不合法行原样带回供审计。 */
export function parseRouteTriageReply(text, {
  candidatePaths = [],
  allowedRecipients = DEFAULT_ALLOWED_RECIPIENTS,
  stages = ROUTE_TRIAGE_STAGES,
} = {}) {
  const candidates = new Set(candidatePaths.map((value) => String(value)));
  const recipients = new Set(allowedRecipients.map((value) => String(value).toLowerCase()));
  const stageSet = new Set(stages);
  const suggestions = [];
  const holds = [];
  const invalid = [];
  const seen = new Set();
  for (const rawLine of String(text ?? '').split(/\r?\n/u)) {
    const line = rawLine.trim().replace(/^[-*]\s+/u, '');
    const match = line.match(/^\[(ROUTE|HOLD)\]\s*(.+)$/iu);
    if (!match) continue;
    const kind = match[1].toUpperCase();
    const parts = match[2].split('|').map((part) => part.trim());
    const path = String(parts[0] ?? '').replace(/^`|`$/gu, '');
    if (!candidates.has(path) || seen.has(path)) {
      invalid.push(line.slice(0, 300));
      continue;
    }
    if (kind === 'HOLD') {
      seen.add(path);
      holds.push({ path, reason: (parts[1] ?? '').slice(0, 300) });
      continue;
    }
    const stage = parts[1]?.match(/^stage\s*=\s*(\S+)$/iu)?.[1]?.toLowerCase() ?? '';
    const recipient = parts[2]?.match(/^to\s*=\s*(\S+)$/iu)?.[1]?.toLowerCase() ?? '';
    const reason = (parts[3] ?? '').slice(0, 300);
    if (!stageSet.has(stage) || !recipients.has(recipient)) {
      invalid.push(line.slice(0, 300));
      continue;
    }
    seen.add(path);
    suggestions.push({ path, stage, recipient, reason });
  }
  return { suggestions, holds, invalid };
}

/**
 * 单条未决建议的确定性归宿判断。current 来自派前重读任务文件：
 * { exists, open, executor }；dispatchRecipient 是本 worker 账本里
 * （backlog claim → event）实际派出的联系人，可为空。
 */
export function resolveRouteSuggestion({
  suggestion,
  current,
  dispatchRecipient = '',
  now = Date.now(),
  maxAgeDays = 30,
}) {
  if (!current?.exists || !current.open) {
    return { status: 'closed', resolvedRecipient: null, resolvedVia: 'task-closed' };
  }
  const executor = String(current.executor ?? '').trim().toLowerCase();
  if (executor) {
    return {
      status: executor === suggestion.recipient ? 'followed' : 'overridden',
      resolvedRecipient: executor,
      resolvedVia: 'frontmatter',
    };
  }
  const dispatched = String(dispatchRecipient ?? '').trim().toLowerCase();
  if (dispatched) {
    return {
      status: dispatched === suggestion.recipient ? 'followed' : 'overridden',
      resolvedRecipient: dispatched,
      resolvedVia: 'backlog-dispatch',
    };
  }
  if (now - Number(suggestion.createdAt ?? now) > maxAgeDays * 86_400_000) {
    return { status: 'expired', resolvedRecipient: null, resolvedVia: 'aged-out' };
  }
  return { status: 'pending', resolvedRecipient: null, resolvedVia: null };
}

/** 周报正文；stats 来自 store.routeSuggestionStats。样本为空时返回 null（不发）。 */
export function formatRouteTriageStats({ date, windowDays, stats }) {
  const dispatched = Number(stats.dispatched ?? 0);
  const vetoed = Number(stats.vetoed ?? 0);
  const passed = Number(stats.passed ?? 0);
  const resolvedTotal = stats.followed + stats.overridden;
  const settled = resolvedTotal + stats.closed + stats.expired + dispatched + vetoed + passed;
  if (settled + stats.pending === 0) return null;
  const manualText = resolvedTotal
    ? `${Math.round((stats.overridden / resolvedTotal) * 100)}%（改派 ${stats.overridden}/${resolvedTotal}）`
    : '暂无样本';
  const autoTotal = dispatched + vetoed;
  const lines = [
    `路由初筛统计 · ${date}（近 ${windowDays} 天）`,
    `- 建议 ${settled + stats.pending} 条：采纳 ${stats.followed} ｜ 改派 ${stats.overridden} ｜ `
      + `自动派单 ${dispatched} ｜ 被否决 ${vetoed} ｜ 任务关闭 ${stats.closed} ｜ `
      + `无人回应 ${passed} ｜ 过期 ${stats.expired} ｜ 待定 ${stats.pending}`,
    `- 人工路径改派率：${manualText}`,
  ];
  if (autoTotal) {
    lines.push(`- 自动路径否决率：${Math.round((vetoed / autoTotal) * 100)}%（否决 ${vetoed}/${autoTotal}）`);
  }
  const byRecipient = Object.entries(stats.byRecipient ?? {})
    .filter(([, value]) => value.followed + value.overridden > 0)
    .map(([recipient, value]) => `${recipient} 采纳 ${value.followed}/改派 ${value.overridden}`);
  if (byRecipient.length) lines.push(`- 按建议对象：${byRecipient.join('；')}`);
  lines.push('（统计衡量初筛建议与人工/否决决定的偏差；自动派单的执行结果见各自任务回执）');
  return lines.join('\n');
}
