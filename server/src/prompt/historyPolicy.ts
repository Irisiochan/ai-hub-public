import { defaultTokenizer, type Tokenizer } from './tokenEstimate.js';

export interface HistoryCandidate {
  content: string;
}

/** Select the first row kept as recent raw history, walking newest to oldest. */
export function chooseKeepFrom(
  rows: HistoryCandidate[],
  minimum: number,
  hardMax: number,
  tokenBudget: number,
  tokenizer: Tokenizer = defaultTokenizer
): number {
  let used = 0;
  let count = 0;
  let start = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    const cost = tokenizer.estimate(rows[i].content) + 4;
    if (count >= minimum && (count >= hardMax || used + cost > tokenBudget)) break;
    used += cost;
    count++;
    start = i;
  }
  return start;
}
