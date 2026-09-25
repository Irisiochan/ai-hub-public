/** 输出因 token 上限提前结束的 finishReason（OpenAI: length；Gemini 归一后也是 length）。 */
export function isOutputLengthLimit(finishReason: unknown): boolean {
  if (typeof finishReason !== 'string') return false;
  const normalized = finishReason.trim().toLowerCase();
  return normalized === 'length' || normalized === 'max_tokens';
}

export function outputLimitWarning(meta: string | undefined): string | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as { usage?: { finishReason?: unknown } };
    return isOutputLengthLimit(parsed.usage?.finishReason)
      ? '达到输出上限，正文可能未写完'
      : null;
  } catch {
    return null;
  }
}
