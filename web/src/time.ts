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
