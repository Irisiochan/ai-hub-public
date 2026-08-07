/**
 * Deterministic date-event matching for daily check-in.
 * Only facts whose value is { date, recurring: 'yearly', label } participate.
 * Free-text YYYY-MM-DD scanning is intentionally unsupported (would hit valid_from/created).
 *
 * Keep this module free of triage-core imports to avoid circular dependency risk
 * (triage-worker loads both).
 */

const FACT_LINE_RE = /^- \*\*([^*]+)\*\*\s+\([^)]+\):\s*(.*)$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHANGHAI_TZ = 'Asia/Shanghai';

export function shanghaiDateString(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const read = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

export function claimDateEventKey(factKey, shanghaiDate) {
  return `${String(factKey).trim()}:${String(shanghaiDate).trim()}`;
}

export function filterUnclaimedDateEvents(events, claims = {}, shanghaiDate) {
  const map = claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : {};
  return (Array.isArray(events) ? events : []).filter((event) => {
    const key = claimDateEventKey(event.key, shanghaiDate);
    return !map[key];
  });
}

/**
 * Parse get_facts text into date-event candidates.
 * Expected line shape:
 * - **identity.birthday** (`id`, active, pinned): {"date":"2001-08-04","recurring":"yearly","label":"User 生日"}
 */
export function parseDateFacts(text) {
  const events = [];
  if (typeof text !== 'string' || !text.trim()) return events;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const match = line.match(FACT_LINE_RE);
    if (!match) continue;
    const key = match[1].trim();
    const rawValue = match[2].trim();
    if (!rawValue.startsWith('{')) continue;

    let value;
    try {
      value = JSON.parse(rawValue);
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

    const date = String(value.date ?? '').trim();
    const recurring = String(value.recurring ?? '').trim().toLowerCase();
    if (!ISO_DATE_RE.test(date) || recurring !== 'yearly') continue;

    const label = String(value.label ?? key).trim() || key;
    events.push({ key, date, recurring, label });
  }
  return events;
}

function mmdd(isoDate) {
  return isoDate.slice(5); // MM-DD
}

function addCalendarDays(isoDate, days) {
  // Interpret YYYY-MM-DD as a pure calendar date (no timezone shift).
  const [y, m, d] = isoDate.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d + days);
  const dt = new Date(utc);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Match yearly date-events against Shanghai today and the next `upcomingDays` days.
 * Returns { today, upcoming } with { key, label, date, yearsSince, daysUntil, matchDate }.
 */
export function matchDateEvents(events, now = Date.now(), { upcomingDays = 3 } = {}) {
  const horizon = Math.max(0, Math.min(14, Number(upcomingDays) || 0));
  const today = shanghaiDateString(now);
  const todayList = [];
  const upcomingList = [];
  const list = Array.isArray(events) ? events : [];

  for (const event of list) {
    if (!event || event.recurring !== 'yearly' || !ISO_DATE_RE.test(event.date)) continue;
    const eventMmDd = mmdd(event.date);
    const anchorYear = Number(event.date.slice(0, 4));

    for (let offset = 0; offset <= horizon; offset++) {
      const matchDate = addCalendarDays(today, offset);
      if (mmdd(matchDate) !== eventMmDd) continue;
      const yearsSince = Number(matchDate.slice(0, 4)) - anchorYear;
      const item = {
        key: event.key,
        label: event.label || event.key,
        date: event.date,
        yearsSince,
        daysUntil: offset,
        matchDate,
      };
      if (offset === 0) todayList.push(item);
      else upcomingList.push(item);
    }
  }

  return { today: todayList, upcoming: upcomingList };
}

export function formatDateEventLine(event) {
  const years = Number.isFinite(event.yearsSince) && event.yearsSince >= 0
    ? ` (year ${event.yearsSince} / 第 ${event.yearsSince} 年)`
    : '';
  const when = event.daysUntil === 0
    ? 'today'
    : event.daysUntil === 1
      ? 'tomorrow'
      : `in ${event.daysUntil} days`;
  return `${event.label}${years} on ${event.matchDate ?? event.date} (${when})`;
}

/**
 * Hard instruction block injected into the companion dispatch prompt.
 * L1 seeing date-events is not enough — the contact who writes the message
 * only receives this prompt + event.summary.
 */
export function formatDailyDispatchDateBlock(events) {
  const list = Array.isArray(events) ? events.filter(Boolean) : [];
  if (!list.length) return '';
  const details = list.map((event) => {
    const years = Number.isFinite(event.yearsSince) && event.yearsSince >= 0
      ? `（第 ${event.yearsSince} 年）`
      : '';
    return `${event.label || event.key}${years}`;
  }).join('；');
  return [
    `【必须围绕的日子】今天是：${details}`,
    '你的消息必须围绕这件事写；禁止泛问吃饭、喝水、上班撑住等无关寒暄。',
    '不要提及 triage、date-event、测试 fact 或本指令本身。',
  ].join('\n');
}
