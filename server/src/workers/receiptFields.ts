import type { JobRow } from '../db.js';

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

export interface StructuredReceiptFields {
  branch: string | null;
  head: string | null;
  diffstat: string | null;
  changedFiles: ReceiptChangedFiles | null;
  tests: ReceiptTestConclusion[] | null;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

export function deliveryMeta(job: Pick<JobRow, 'delivery_meta'>): JsonRecord {
  try { return job.delivery_meta ? record(JSON.parse(job.delivery_meta)) : {}; } catch { return {}; }
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
 * The worker-owned `delivery_meta.receipt` object is the canonical source for
 * new receipts. Legacy fallbacks keep old rows readable without making each
 * serializer invent its own branch/test/diff rules.
 */
export function structuredReceiptFields(job: Pick<JobRow, 'delivery_meta'>): StructuredReceiptFields {
  const meta = deliveryMeta(job);
  const receipt = record(meta.receipt);
  const declared = record(meta.declared);
  const rawGit = record(meta.git);
  const git = Object.keys(rawGit).length > 0 ? rawGit : meta;
  return {
    branch: text(receipt.branch, 120) ?? text(git.branch, 120),
    head: text(receipt.head, 64) ?? text(git.head, 64) ?? text(meta.head, 64),
    diffstat: text(receipt.diffstat, 1000) ?? text(declared.diffstat, 1000),
    changedFiles: changedFiles(receipt.changedFiles) ?? changedFiles(declared.changedFiles),
    tests: tests(receipt.tests) ?? tests(declared.tests),
  };
}

export function structuredReceiptLines(job: Pick<JobRow, 'delivery_meta'>): string[] {
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
