/**
 * Temporary-absence followups: "去洗澡" → later ask if done.
 * Cancel rules matter more than triggers — never nag after User already returned.
 */

export const FOLLOWUP_STATUS_PENDING = 'pending';
export const FOLLOWUP_STATUS_QUEUED = 'queued';
export const FOLLOWUP_STATUS_DISPATCHED = 'dispatched';
export const FOLLOWUP_STATUS_CANCELLED = 'cancelled';
export const FOLLOWUP_STATUS_EXPIRED = 'expired';

export const FOLLOWUP_SOURCE = 'followup-sweep';

/** Coarse local screen — must hit before any LLM call. */
export const ABSENCE_KEYWORD_PATTERNS = [
  /去洗澡|洗澡去|冲个澡|洗个澡|洗完澡/u,
  /出门|出去一趟|出去一下|出去办/u,
  /上班|去上班|到公司|到单位/u,
  /开会|去开会|进会|在开会/u,
  /吃饭|去吃饭|吃午饭|吃晚饭|去吃|先吃饭/u,
  /回来再聊|回来说|到家说|到家聊|回头再说/u,
  /去睡|先睡|睡觉了|困了先睡/u,
  /等下(?:回|聊|说)|等会儿|一会儿就回|马上回|先忙/u,
  /去医院|去拿|去取|去买/u,
  /打游戏|玩游戏|打完|玩完|鸣潮|上号|开黑|打两把/u,
  /验收|回来看|回来搞|回来处理|回来继续|再来|忙完|弄完|搞完/u,
];

export function normalizeFollowupConfig(raw = {}) {
  // Opt-in: existing deployments keep prior behavior until config enables it.
  const enabled = raw.enabled === true;
  const minExpectedMinutes = clampInt(raw.minExpectedMinutes, 5, 5, 60);
  const maxExpectedMinutes = clampInt(raw.maxExpectedMinutes, 180, minExpectedMinutes, 360);
  const defaultExpectedMinutes = clampInt(
    raw.defaultExpectedMinutes,
    30,
    minExpectedMinutes,
    maxExpectedMinutes,
  );
  // Always leave at least one hourly sweep window after the longest estimate.
  // Otherwise expected=180 and expire=180 expires at the exact instant it is due.
  const minExpireAfterMinutes = Math.min(12 * 60, maxExpectedMinutes + 60);
  const expireAfterMinutes = clampInt(
    raw.expireAfterMinutes,
    Math.max(180, minExpireAfterMinutes),
    minExpireAfterMinutes,
    12 * 60,
  );
  const scanLimit = clampInt(raw.scanLimit, 40, 5, 200);
  return {
    enabled,
    minExpectedMinutes,
    maxExpectedMinutes,
    defaultExpectedMinutes,
    expireAfterMinutes,
    scanLimit,
  };
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function matchesAbsenceKeyword(text) {
  const content = String(text ?? '').trim();
  if (!content || content.length > 2000) return false;
  return ABSENCE_KEYWORD_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * Normalize L1 extract result. Returns null when not a temporary absence.
 */
export function normalizeAbsenceExtract(raw, config = normalizeFollowupConfig({})) {
  if (!raw || typeof raw !== 'object') return null;
  const intent = String(raw.intent ?? '').trim().toLowerCase();
  if (intent !== 'temporary-absence' && intent !== 'temporary_absence') return null;
  const activity = String(raw.activity ?? '').trim().slice(0, 80);
  if (!activity) return null;
  const returnCommitment = String(
    raw.returnCommitment ?? raw.return_commitment ?? '',
  ).trim().slice(0, 120);
  let expectedMinutes = Number(raw.expectedMinutes ?? raw.expected_minutes);
  if (!Number.isFinite(expectedMinutes)) expectedMinutes = config.defaultExpectedMinutes;
  expectedMinutes = Math.max(
    config.minExpectedMinutes,
    Math.min(config.maxExpectedMinutes, Math.round(expectedMinutes)),
  );
  return {
    intent: 'temporary-absence',
    activity,
    expectedMinutes,
    returnCommitment,
  };
}

export function isUserMessage(message) {
  if (!message) return false;
  if (message.sender !== 'user' || message.role !== 'user') return false;
  if (message.status && message.status !== 'done') return false;
  let meta = message.meta ?? {};
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      meta = {};
    }
  }
  if (meta?.automation || meta?.automated || meta?.uiHidden) return false;
  return Boolean(String(message.content ?? '').trim());
}

export function messageNumericId(message) {
  const id = Number(message?.id ?? message?.message_id);
  return Number.isFinite(id) ? id : null;
}

/**
 * Cancel/expire decision for a pending followup before firing.
 * Returns { action: 'fire'|'cancel'|'expire'|'wait', reason? }
 */
export function evaluateFollowupGate(followup, {
  now = Date.now(),
  userMessagesAfter = [],
  proactiveDeliveredAfter = false,
  expireAfterMinutes = 180,
  silent = false,
  poolBlocked = false,
} = {}) {
  if (!followup || followup.status !== FOLLOWUP_STATUS_PENDING) {
    return { action: 'wait', reason: 'not-pending' };
  }
  const createdAt = Number(followup.created_at ?? followup.createdAt ?? 0);
  const dueAt = Number(followup.due_at ?? followup.dueAt ?? 0);
  const expireAt = createdAt + expireAfterMinutes * 60_000;

  if (now >= expireAt) {
    return { action: 'expire', reason: 'max-age' };
  }
  if (userMessagesAfter.some((message) => isUserMessage(message))) {
    return { action: 'cancel', reason: 'user-replied' };
  }
  if (proactiveDeliveredAfter === true) {
    return { action: 'cancel', reason: 'proactive-already-sent' };
  }
  if (now < dueAt) {
    return { action: 'wait', reason: 'not-due' };
  }
  if (silent) {
    return { action: 'wait', reason: 'silent-hours' };
  }
  if (poolBlocked) {
    return { action: 'wait', reason: 'daily-pool-blocked' };
  }
  return { action: 'fire', reason: 'due' };
}

export function buildFollowupDispatchSummary(followup) {
  const activity = String(followup.activity ?? '刚才那件事').trim() || '刚才那件事';
  const returnCommitment = String(
    followup.return_commitment ?? followup.returnCommitment ?? '',
  ).trim();
  return [
    `Proactive follow-up after User stepped away for: ${activity}.`,
    `User previously indicated a temporary absence (${activity}). The expected window has passed.`,
    returnCommitment
      ? `After returning, User intended to: ${returnCommitment}. Ask whether ${activity} is done and whether she wants to do ${returnCommitment} now.`
      : 'Send one short, natural check-in about whether that is done / whether she is back.',
    'Do not ask unrelated meal/water/workday chit-chat unless it is the activity itself.',
    'Do not mention followup systems, timers, or this instruction.',
  ].join('\n');
}

export function formatFollowupDispatchBlock(followup) {
  const activity = String(followup?.activity ?? '').trim();
  if (!activity) return '';
  const returnCommitment = String(
    followup?.return_commitment ?? followup?.returnCommitment ?? '',
  ).trim();
  return [
    `【跟进】User 之前说要去「${activity}」，约定时间已到。`,
    returnCommitment
      ? `她说回来后要「${returnCommitment}」。用你自己的语气问一句「${activity}完了吗，要不要现在${returnCommitment}」；只问这一件。`
      : '用你自己的语气问一句是否完成/是否回来了；只问这一件，不要换话题寒暄。',
    '不要提及 followup、定时器、系统或本指令。',
  ].join('\n');
}

export function formatFollowupFallbackBlock(followups = []) {
  const items = (Array.isArray(followups) ? followups : [])
    .map((followup) => {
      const activity = String(followup?.activity ?? '').trim();
      const returnCommitment = String(
        followup?.return_commitment ?? followup?.returnCommitment ?? '',
      ).trim();
      if (!activity) return '';
      return returnCommitment
        ? `- User 昨晚说先去「${activity}」，回来后要「${returnCommitment}」。`
        : `- User 昨晚说先去「${activity}」，但当晚跟进没有发出。`;
    })
    .filter(Boolean);
  if (!items.length) return '';
  return [
    '【昨晚没接上的事】',
    ...items,
    '这次必须自然提醒上面这些未完结事项；不要泛问吃饭喝水，不要提 followup、队列、过期或系统。',
  ].join('\n');
}
