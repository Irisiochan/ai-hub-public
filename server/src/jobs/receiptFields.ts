import type { JobRow } from '../platform/index.js';

type JsonRecord = Record<string, unknown>;

export interface ReceiptChangedFiles {
  files: string[];
  total: number;
  truncated: boolean;
}

export interface ReceiptTestConclusion {
  suite: string;
  status: 'pass' | 'fail';
  detail?: string;
}

/**
 * P1 cost ledger: runner-reported token usage carried in
 * `delivery_meta.receipt.usage`. Only worker-observed numbers are surfaced —
 * never estimated or fabricated. Null when the runner reported nothing.
 */
export interface AttemptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
}

function usageNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function receiptUsage(job: Pick<JobRow, 'delivery_meta'>): AttemptUsage | null {
  const receipt = record(deliveryMeta(job).receipt);
  const usage = record(receipt.usage);
  const inputTokens = usageNumber(usage.inputTokens);
  const outputTokens = usageNumber(usage.outputTokens);
  if (inputTokens === null || outputTokens === null) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: usageNumber(usage.cacheReadTokens),
  };
}

export interface StructuredReceiptFields {
  branch: string | null;
  head: string | null;
  diffstat: string | null;
  changedFiles: ReceiptChangedFiles | null;
  tests: ReceiptTestConclusion[] | null;
  /** P1: runner-reported usage, null when the runner reported nothing. */
  usage: AttemptUsage | null;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

export function deliveryMeta(job: Pick<JobRow, 'delivery_meta'>): JsonRecord {
  try { return job.delivery_meta ? record(JSON.parse(job.delivery_meta)) : {}; } catch { return {}; }
}

// A 600k patch (worker RECEIPT_PATCH_MAX_CHARS) can expand sixfold under
// JSON escaping (e.g. control chars); execution_get pages it in 120k slices.
export const DELIVERY_META_MAX_CHARS = 4_000_000;

/**
 * Serialize delivery_meta under the cap without ever slicing JSON. The raw
 * receipt patches are the only bulky fields, so they are dropped (and
 * flagged) first — cumulative patch before incremental delta.
 */
export function boundedDeliveryMeta(delivery: JsonRecord): string {
  const full = JSON.stringify(delivery);
  if (full.length <= DELIVERY_META_MAX_CHARS) return full;
  let current = delivery;
  const receipt = record(delivery.receipt);
  if (typeof receipt.patch === 'string') {
    const { patch: _dropped, ...rest } = receipt;
    current = { ...delivery, receipt: { ...rest, patchDropped: 'delivery_meta size cap' } };
    if (JSON.stringify(current).length <= DELIVERY_META_MAX_CHARS) return JSON.stringify(current);
  }
  const receiptWithoutPatch = record(current.receipt);
  if (typeof receiptWithoutPatch.patchDelta === 'string') {
    const { patchDelta: _droppedDelta, ...rest } = receiptWithoutPatch;
    const withoutDelta = { ...current, receipt: { ...rest, patchDeltaDropped: 'delivery_meta size cap' } };
    if (JSON.stringify(withoutDelta).length <= DELIVERY_META_MAX_CHARS) return JSON.stringify(withoutDelta);
  }
  return JSON.stringify({
    state: delivery.state ?? null,
    head: delivery.head ?? null,
    truncated: 'delivery_meta size cap',
  });
}

/** Raw diff captured by the worker, when present. */
export function receiptPatch(job: Pick<JobRow, 'delivery_meta'>): { patch: string; chars: number; truncated: boolean; dropped: boolean; patchBase?: unknown; patchBaseKind?: unknown; patchBaseFallback?: unknown } | null {
  const receipt = record(deliveryMeta(job).receipt);
  if (typeof receipt.patch !== 'string') {
    return receipt.patchDropped ? { patch: '', chars: Number(receipt.patchChars) || 0, truncated: true, dropped: true } : null;
  }
  return {
    patch: receipt.patch,
    chars: Number(receipt.patchChars) || receipt.patch.length,
    truncated: receipt.patchTruncated === true,
    dropped: false,
    patchBase: receipt.patchBase ?? null,
    patchBaseKind: receipt.patchBaseKind ?? null,
    patchBaseFallback: receipt.patchBaseFallback ?? null,
  };
}

/** Incremental diff since the last pinned candidate, captured by the worker. */
export function receiptPatchDelta(job: Pick<JobRow, 'delivery_meta'>): {
  patch: string; chars: number; truncated: boolean; dropped: boolean;
  patchDeltaBase?: unknown; patchDeltaKind?: unknown; patchSinceFallback?: unknown;
} | null {
  const receipt = record(deliveryMeta(job).receipt);
  if (typeof receipt.patchDelta !== 'string') {
    return receipt.patchDeltaDropped
      ? { patch: '', chars: Number(receipt.patchDeltaChars) || 0, truncated: true, dropped: true }
      : null;
  }
  return {
    patch: receipt.patchDelta,
    chars: Number(receipt.patchDeltaChars) || receipt.patchDelta.length,
    truncated: receipt.patchDeltaTruncated === true,
    dropped: false,
    patchDeltaBase: receipt.patchDeltaBase ?? null,
    patchDeltaKind: receipt.patchDeltaKind ?? null,
    patchSinceFallback: receipt.patchSinceFallback ?? null,
  };
}

function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, limit) : null;
}

function changedFiles(value: unknown): ReceiptChangedFiles | null {
  const item = record(value);
  const rawFiles = Array.isArray(value)
    ? value
    : Array.isArray(item.files) ? item.files : [];
  const files = [...new Set(rawFiles
    .filter((file): file is string => typeof file === 'string')
    .map((file) => file.trim().replaceAll('\\', '/'))
    .filter(Boolean))]
    .slice(0, 50);
  const rawTotal = Number(item.total);
  const total = Number.isSafeInteger(rawTotal) && rawTotal >= 0
    ? Math.max(rawTotal, files.length)
    : files.length;
  if (total === 0 && files.length === 0) return null;
  return {
    files,
    total,
    truncated: item.truncated === true || total > files.length,
  };
}

function tests(value: unknown): ReceiptTestConclusion[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value.flatMap((entry) => {
    const item = record(entry);
    const suite = text(item.suite, 160);
    const status = text(item.status, 20)?.toLowerCase();
    if (!suite || !['pass', 'fail'].includes(status ?? '')) return [];
    const detail = text(item.detail, 300);
    return [{
      suite,
      status: status as 'pass' | 'fail',
      ...(detail ? { detail } : {}),
    }];
  }).slice(0, 100);
  return normalized.length > 0 ? normalized : null;
}

/**
 * Last-resort fallback: a runner declaration embedded in the stored result
 * text (fenced ```json or a bare top-level object carrying
 * {"delivery":{committed,pushed,...}}). Old worker releases (before ba8b0e4)
 * never scanned the joined OpenCode result, so their delivery_meta carries no
 * declared block even though the receipt text ends with a valid one
 * (2026-09-15 job e1755b61: five green suites, tests=[] in delivery_meta).
 * Reading it here keeps review/merge gates honest without rewriting rows.
 */
export function declarationFromResultText(result: unknown): JsonRecord | null {
  if (typeof result !== 'string' || !result.includes('"delivery"')) return null;
  const candidates: string[] = [];
  for (const match of result.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1]);
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < result.length; index++) {
    const char = result[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(result.slice(start, index + 1));
        start = -1;
      }
    }
  }
  for (const rawCandidate of candidates.reverse()) {
    const candidate = rawCandidate.trim();
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = record(JSON.parse(candidate));
      const delivery = record(parsed.delivery);
      if (typeof delivery.committed === 'boolean' && typeof delivery.pushed === 'boolean') return delivery;
    } catch { /* not this candidate */ }
  }
  return null;
}

/**
 * The worker-owned `delivery_meta.receipt` object is the canonical source for
 * new receipts. Legacy fallbacks keep old rows readable without making each
 * serializer invent its own branch/test/diff rules.
 */
export function structuredReceiptFields(job: Pick<JobRow, 'delivery_meta'> & { result?: string | null }): StructuredReceiptFields {
  const meta = deliveryMeta(job);
  const receipt = record(meta.receipt);
  const declared = record(meta.declared);
  // Consulted per field, only where neither the worker receipt nor the declared block
  // carries a value (a deploy event may rewrite declared to stage-only); git-collected receipt facts always win.
  const embedded = declarationFromResultText(job.result) ?? {};
  const rawGit = record(meta.git);
  const git = Object.keys(rawGit).length > 0 ? rawGit : meta;
  return {
    branch: text(receipt.branch, 120) ?? text(git.branch, 120),
    head: text(receipt.head, 64) ?? text(git.head, 64) ?? text(meta.head, 64),
    diffstat: text(receipt.diffstat, 1000) ?? text(declared.diffstat, 1000) ?? text(embedded.diffstat, 1000),
    changedFiles: changedFiles(receipt.changedFiles) ?? changedFiles(declared.changedFiles) ?? changedFiles(embedded.changedFiles),
    tests: tests(receipt.tests) ?? tests(declared.tests) ?? tests(embedded.tests),
    usage: receiptUsage(job),
  };
}

export function structuredReceiptLines(job: Pick<JobRow, 'delivery_meta'> & { result?: string | null }): string[] {
  const fields = structuredReceiptFields(job);
  const previewFiles = fields.changedFiles?.files.slice(0, 12) ?? [];
  const previewFilesTruncated = Boolean(fields.changedFiles
    && (fields.changedFiles.truncated || fields.changedFiles.files.length > previewFiles.length));
  const changed = fields.changedFiles
    ? `${fields.changedFiles.total} 个：${previewFiles.join(', ') || '未列清单'}${previewFilesTruncated ? '（清单已截断）' : ''}`
    : '未报告';
  const testLine = fields.tests
    ? `${fields.tests.slice(0, 12).map((item) => `${item.suite}=${item.status.toUpperCase()}${item.detail ? `(${item.detail})` : ''}`).join('；')}${fields.tests.length > 12 ? `（另 ${fields.tests.length - 12} 项已截断）` : ''}`
    : '未报告';
  return [
    `branch：${fields.branch ?? '未报告'}`,
    `diffstat：${fields.diffstat ?? '未报告'}`,
    `changedFiles：${changed}`,
    `测试结论：${testLine}`,
  ];
}

/** One file's hunk block inside a unified diff, as char offsets. */
export interface PatchFileBlock {
  path: string;
  start: number;
  end: number;
}

const PATCH_MAX_FILES = 200;

function unquoteDiffPath(raw: string): string {
  let out = raw.trim();
  if (out.length >= 2 && out.startsWith('"') && out.endsWith('"')) {
    try {
      out = JSON.parse(out) as string;
    } catch {
      out = out.slice(1, -1);
    }
  }
  return out.replace(/^a\//, '').replace(/^b\//, '');
}

/**
 * Split a unified diff into per-file blocks by `diff --git` headers.
 * Pure string surgery for execution_get patch paging: offsets stay in the
 * original text so pages remain continuous. File list is capped (200).
 */
export function splitPatchByFile(patch: string, maxFiles = PATCH_MAX_FILES): { files: string[]; blocks: PatchFileBlock[] } {
  const header = /^diff --git ("[^"\n]+"|\S+) ("[^"\n]+"|\S+)\s*$/gm;
  const starts: Array<{ path: string; start: number }> = [];
  for (const match of patch.matchAll(header)) {
    const bPath = unquoteDiffPath(match[2]);
    const aPath = unquoteDiffPath(match[1]);
    starts.push({ path: bPath || aPath, start: match.index ?? 0 });
  }
  const files: string[] = [];
  const blocks: PatchFileBlock[] = [];
  for (let i = 0; i < starts.length && files.length < maxFiles; i++) {
    files.push(starts[i].path);
    blocks.push({
      path: starts[i].path,
      start: starts[i].start,
      end: i + 1 < starts.length ? starts[i + 1].start : patch.length,
    });
  }
  return { files, blocks };
}

/** Ordered file list parsed from diff headers (capped at 200). */
export function listPatchFiles(patch: string, maxFiles = PATCH_MAX_FILES): string[] {
  return splitPatchByFile(patch, maxFiles).files;
}
