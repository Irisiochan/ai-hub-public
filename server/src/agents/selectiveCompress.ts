/**
 * Injection-time selective compression for tool outputs and large dumps.
 *
 * Design (SOMA lesson): never blindly cut ~80% of context — that crushed task
 * success from ~68% to ~13%. Prefer targeted compression of bulky tool dumps /
 * repeated logs while protecting model-critical evidence:
 * - failure/assertion lines
 * - file paths
 * - unified diffs
 * - stack frames with file:line
 *
 * Applied only to gateway tool-result text before it re-enters the prompt.
 * Does not touch assistant reasoning, history message text, or system preamble.
 */

/** Soft ceiling for a single tool result after selective compression. */
export const TOOL_RESULT_MAX_CHARS = 5_000;

const PROTECTED_LINE =
  /(?:^|\s)(?:assert(?:ion)?|expect|FAIL(?:ED)?|ERROR|Error:|TypeError|ReferenceError|SyntaxError|EACCES|ENOENT|EPERM)\b/i;

const DIFF_LINE = /^(?:diff --git |index [0-9a-f]+\.\.|--- |\+\+\+ |@@ )/;

const PATH_LINE =
  /(?:[A-Za-z]:[\\/][^\s:]+|\/(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|md|json|yml|yaml|toml|sql)\b)/;

const STACK_LINE = /(?:at\s+\S+\s+\(|^\s+at\s+).*(?:\.[a-z]{1,5}:\d+|:\d+:\d+)/i;

const REPEATED_LOG_NOISE =
  /^(?:\s*(?:DEBUG|TRACE|info|warn|verbose)\b|[0-9a-f]{32,}|[A-Za-z0-9+/=]{80,})/i;

export type CompressToolResultOptions = {
  maxChars?: number;
};

export type CompressToolResultMeta = {
  originalChars: number;
  finalChars: number;
  collapsedDupes: number;
  droppedCompressibleChars: number;
  protectedLinesKept: number;
  truncated: boolean;
};

function isProtectedLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (PROTECTED_LINE.test(t)) return true;
  if (DIFF_LINE.test(t)) return true;
  if (STACK_LINE.test(t)) return true;
  // Paths alone are protected when the line is short (likely a path list / error path).
  if (t.length <= 240 && PATH_LINE.test(t)) return true;
  // Long path-bearing lines (error messages with path) still count.
  if (PATH_LINE.test(t) && /(?:error|fail|cannot|unable|not found|denied)/i.test(t)) return true;
  return false;
}

function isCompressibleBulk(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (isProtectedLine(t)) return false;
  if (t.length >= 200) return true;
  if (REPEATED_LOG_NOISE.test(t)) return true;
  // Dense whitespace-collapsed dumps / hex-ish rows
  if (/^(?:[0-9a-f]{2}\s*){8,}$/i.test(t)) return true;
  return false;
}

/** Collapse consecutive identical lines: keep first + a single count marker. */
export function collapseConsecutiveDuplicates(text: string): { text: string; collapsed: number } {
  const lines = text.split('\n');
  if (lines.length <= 1) return { text, collapsed: 0 };
  const out: string[] = [];
  let collapsed = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let j = i + 1;
    while (j < lines.length && lines[j] === line) j++;
    const run = j - i;
    out.push(line);
    if (run > 1) {
      out.push(`…(×${run - 1} identical lines omitted)`);
      collapsed += run - 1;
    }
    i = j;
  }
  return { text: out.join('\n'), collapsed };
}

/**
 * Selectively compress tool-result text down to maxChars.
 * Protected lines are kept preferentially; bulk/repeated regions lose the middle first.
 */
export function compressToolResultForInjection(
  text: string,
  opts: CompressToolResultOptions = {}
): { text: string; meta: CompressToolResultMeta } {
  const maxChars = Math.max(256, opts.maxChars ?? TOOL_RESULT_MAX_CHARS);
  const originalChars = text.length;

  if (originalChars <= maxChars) {
    return {
      text,
      meta: {
        originalChars,
        finalChars: originalChars,
        collapsedDupes: 0,
        droppedCompressibleChars: 0,
        protectedLinesKept: text.split('\n').filter(isProtectedLine).length,
        truncated: false,
      },
    };
  }

  const collapsed = collapseConsecutiveDuplicates(text);
  let working = collapsed.text;
  let dropped = 0;

  if (working.length <= maxChars) {
    return {
      text: working,
      meta: {
        originalChars,
        finalChars: working.length,
        collapsedDupes: collapsed.collapsed,
        droppedCompressibleChars: originalChars - working.length,
        protectedLinesKept: working.split('\n').filter(isProtectedLine).length,
        truncated: true,
      },
    };
  }

  const lines = working.split('\n');
  const protectedFlags = lines.map(isProtectedLine);
  const bulkFlags = lines.map((line, i) => !protectedFlags[i] && isCompressibleBulk(line));
  const protectedCount = protectedFlags.filter(Boolean).length;

  // Budget for protected evidence first, then head/tail of the rest.
  const protectedText = lines.filter((_, i) => protectedFlags[i]).join('\n');
  const protectedBudget = Math.min(protectedText.length, Math.floor(maxChars * 0.55));
  const remainderBudget = Math.max(maxChars - protectedBudget - 80, Math.floor(maxChars * 0.35));

  // Drop middle of long compressible runs (keep head+tail of each run).
  const keptMask = lines.map(() => true);
  let i = 0;
  while (i < lines.length) {
    if (!bulkFlags[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && bulkFlags[j]) j++;
    const runLen = j - i;
    if (runLen > 6) {
      const keepHead = 2;
      const keepTail = 2;
      for (let k = i + keepHead; k < j - keepTail; k++) {
        keptMask[k] = false;
      }
    }
    i = j;
  }

  const afterBulk: string[] = [];
  let bulkDropNote = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    if (keptMask[idx]) {
      afterBulk.push(lines[idx]);
    } else if (idx === 0 || keptMask[idx - 1]) {
      afterBulk.push('…(bulk tool dump middle omitted; open source file if needed)');
      bulkDropNote++;
    }
  }
  working = afterBulk.join('\n');
  dropped += Math.max(0, lines.join('\n').length - working.length);

  if (working.length <= maxChars) {
    return {
      text: working,
      meta: {
        originalChars,
        finalChars: working.length,
        collapsedDupes: collapsed.collapsed,
        droppedCompressibleChars: dropped,
        protectedLinesKept: protectedCount,
        truncated: true,
      },
    };
  }

  // Final pass: keep all protected lines (clipped to protectedBudget) + head/tail of the rest.
  const finalLines = working.split('\n');
  const prot: string[] = [];
  const rest: string[] = [];
  for (const line of finalLines) {
    if (isProtectedLine(line)) prot.push(line);
    else rest.push(line);
  }

  let protBlock = prot.join('\n');
  if (protBlock.length > protectedBudget) {
    // Prefer keeping the tail of protected lines (latest failures/assertions).
    protBlock = protBlock.slice(protBlock.length - protectedBudget);
    const cut = protBlock.indexOf('\n');
    if (cut > 0 && cut < 80) protBlock = protBlock.slice(cut + 1);
    protBlock = `…(earlier protected evidence omitted)\n${protBlock}`;
  }

  const restJoined = rest.join('\n');
  let restBlock = restJoined;
  if (restJoined.length > remainderBudget) {
    const headLen = Math.floor(remainderBudget * 0.55);
    const tailLen = Math.max(remainderBudget - headLen - 40, 64);
    const head = restJoined.slice(0, headLen);
    const tail = restJoined.slice(restJoined.length - tailLen);
    restBlock = `${head}\n…(compressed bulk middle omitted)\n${tail}`;
  }

  const marker = '\n\n[tool result selectively compressed before injection]\n';
  let out = [protBlock, restBlock].filter(Boolean).join(marker);
  if (out.length > maxChars) {
    // Absolute last resort: hard slice but still try to keep a protected lead.
    const lead = protBlock.slice(0, Math.min(protBlock.length, Math.floor(maxChars * 0.5)));
    const room = maxChars - lead.length - 48;
    const tail = restBlock.slice(Math.max(0, restBlock.length - Math.max(room, 0)));
    out = `${lead}\n…(hard cap)\n${tail}`.slice(0, maxChars);
  }

  dropped = Math.max(dropped, originalChars - out.length);

  return {
    text: out,
    meta: {
      originalChars,
      finalChars: out.length,
      collapsedDupes: collapsed.collapsed,
      droppedCompressibleChars: dropped,
      protectedLinesKept: prot.length,
      truncated: true,
    },
  };
}
