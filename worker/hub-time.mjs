const NAIVE_UTC_DATETIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/**
 * Parse timestamps returned by AI Hub.
 *
 * SQLite datetime('now') values are UTC but carry no timezone marker. Explicit
 * ISO zones/offsets retain their native Date.parse behavior.
 */
export function parseHubTimestampMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && !/[-T:]/.test(raw)) return asNumber;
  const normalized = NAIVE_UTC_DATETIME_RE.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
