export function parsePositiveIntegerQuery(
  value: unknown,
  defaultValue: number,
  max: number,
): number {
  if (typeof value !== 'string') return defaultValue;
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, max);
}
