import type { MessageRow } from '../db.js';
import { compactSummaryText } from './conversationSummary.js';
import { chooseKeepFrom } from './historyPolicy.js';
import { estimateTokens } from './tokenEstimate.js';

/** Request-local view only; never writes summaries or removes stored conversation history. */
export function gemHeartbeatHistory(rows: MessageRow[], textOf: (row: MessageRow) => string) {
  const before = estimateTokens(rows.map(textOf).join('\n'));
  const from = chooseKeepFrom(rows.map((r) => ({ content: textOf(r) })), Math.min(5, rows.length), 13, 4000);
  if (!from) return { rows, digest: '', before, after: before };
  const digest = compactSummaryText('', rows.slice(0, from), { summaryMaxTokens: 1200, historyTokenBudget: 4000 });
  const kept = rows.slice(from);
  const after = estimateTokens(kept.map(textOf).join('\n')) + estimateTokens(digest);
  // Do not trade away detail when the saving is negligible.
  return after < before * 0.9 ? { rows: kept, digest, before, after } : { rows, digest: '', before, after: before };
}
