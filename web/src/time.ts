/** SQLite CURRENT_TIMESTAMP is UTC but has no timezone suffix. */
export const DISPLAY_TIME_ZONE = 'Asia/Shanghai';
/** Date#getTimezoneOffset convention: UTC - local, so Shanghai is -480. */
export const SHANGHAI_TZ_OFFSET = -480;

export function parseUtcTimestamp(value: string): Date {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`;
  return new Date(zoned);
}

export function formatLocalTime(value: string, includeDate = true): string {
  const date = parseUtcTimestamp(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: DISPLAY_TIME_ZONE,
    ...(includeDate ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function shanghaiDateParts(date: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: DISPLAY_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
}

/** Compact conversation-list timestamp, including the "today" boundary, in Shanghai time. */
export function formatConversationListTime(value: string, now = new Date()): string {
  const date = parseUtcTimestamp(value);
  if (Number.isNaN(date.getTime())) return '';

  const valueParts = shanghaiDateParts(date);
  const nowParts = shanghaiDateParts(now);
  const sameDay = ['year', 'month', 'day'].every((part) => valueParts[part] === nowParts[part]);

  if (sameDay) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: DISPLAY_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  }

  return `${Number(valueParts.month)}/${Number(valueParts.day)}`;
}

/** Stable message timestamp independent of browser/device locale. */
export function formatMessageTimestamp(value: string): string {
  const date = parseUtcTimestamp(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}
