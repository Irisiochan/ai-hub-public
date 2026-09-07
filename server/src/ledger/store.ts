import type { Db } from '../db.js';
import { daysBetween, methodLooksLikeCmbCredit, payeeSimilar } from './classify.js';
import type {
  ClassifiedLedgerRow,
  LargeExpense,
  LedgerImportStats,
  LedgerKind,
  LedgerSource,
  LedgerTransaction,
  MonthStats,
  MonthSummary,
} from './types.js';

interface ImportRow {
  id: number;
  source: LedgerSource;
  original_name: string;
  file_sha256: string;
  period_start: string | null;
  period_end: string | null;
  row_count: number;
  inserted_count: number;
  duplicate_count: number;
  transfer_count: number;
  ignored_count: number;
  created_at: string;
}

interface TxnRow {
  id: number;
  import_id: number;
  occurred_at: string;
  amount_cents: number;
  kind: LedgerKind;
  category: string;
  payee: string;
  description: string;
  source: LedgerSource;
  method: string;
  status_text: string;
  source_txn_id: string;
  fingerprint: string;
  duplicate_of: number | null;
}

const MONTH_RE = /^\d{4}-\d{2}$/;

export function isYearMonth(value: string): boolean {
  if (!MONTH_RE.test(value)) return false;
  const month = Number(value.slice(5));
  return month >= 1 && month <= 12;
}

export function monthRange(yearMonth: string): { start: string; end: string } {
  const [year, month] = yearMonth.split('-').map(Number);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return {
    start: `${yearMonth}-01 00:00:00`,
    end: `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01 00:00:00`,
  };
}

export function previousYearMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-').map(Number);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  return `${String(prevYear).padStart(4, '0')}-${String(prevMonth).padStart(2, '0')}`;
}

function mapTxn(row: TxnRow): LedgerTransaction {
  return {
    id: row.id,
    importId: row.import_id,
    occurredAt: row.occurred_at,
    amountCents: row.amount_cents,
    kind: row.kind,
    category: row.category,
    payee: row.payee,
    description: row.description,
    source: row.source,
    method: row.method,
    statusText: row.status_text,
    sourceTxnId: row.source_txn_id,
    fingerprint: row.fingerprint,
    duplicateOf: row.duplicate_of,
  };
}

function mapImport(row: ImportRow, reused = false): LedgerImportStats {
  return {
    id: row.id,
    source: row.source,
    originalName: row.original_name,
    fileSha256: row.file_sha256,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    rowCount: row.row_count,
    insertedCount: row.inserted_count,
    duplicateCount: row.duplicate_count,
    transferCount: row.transfer_count,
    ignoredCount: row.ignored_count,
    createdAt: row.created_at,
    reused,
  };
}

function periodOf(rows: ClassifiedLedgerRow[]): { start: string | null; end: string | null } {
  const times = rows.map((row) => row.occurredAt).filter(Boolean).sort();
  return { start: times[0] ?? null, end: times[times.length - 1] ?? null };
}

function linkCrossSourceKind(db: Db, kind: 'expense' | 'transfer'): number {
  const candidates = db.prepare(
    `SELECT id, occurred_at, amount_cents, payee, description, method
       FROM ledger_transactions
      WHERE source IN ('alipay', 'wechat')
        AND kind = ?
        AND duplicate_of IS NULL`
  ).all(kind) as Array<{
    id: number;
    occurred_at: string;
    amount_cents: number;
    payee: string;
    description: string;
    method: string;
  }>;
  const cmbRows = db.prepare(
    `SELECT id, occurred_at, amount_cents, payee, description
       FROM ledger_transactions AS cmb
      WHERE source = 'cmb-cc'
        AND kind = ?
        AND duplicate_of IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ledger_transactions AS linked WHERE linked.duplicate_of = cmb.id
        )`
  ).all(kind) as Array<{
    id: number;
    occurred_at: string;
    amount_cents: number;
    payee: string;
    description: string;
  }>;
  const used = new Set<number>();
  let linked = 0;
  const update = db.prepare('UPDATE ledger_transactions SET duplicate_of = ? WHERE id = ? AND duplicate_of IS NULL');
  for (const candidate of candidates) {
    if (kind === 'expense' && !methodLooksLikeCmbCredit(candidate.method)) continue;
    const match = cmbRows.find((row) => {
      if (used.has(row.id)) return false;
      if (row.amount_cents !== candidate.amount_cents) return false;
      if (daysBetween(row.occurred_at, candidate.occurred_at) > 2) return false;
      if (kind === 'transfer') return true;
      const left = [candidate.payee, candidate.description];
      const right = [row.payee, row.description];
      return left.some((a) => right.some((b) => payeeSimilar(a, b)));
    });
    if (!match) continue;
    used.add(match.id);
    update.run(match.id, candidate.id);
    linked += 1;
  }
  return linked;
}

export function linkCrossSourceDuplicates(db: Db): number {
  return linkCrossSourceKind(db, 'expense') + linkCrossSourceKind(db, 'transfer');
}

export function importLedgerRows(
  db: Db,
  input: {
    source: LedgerSource;
    originalName: string;
    fileSha256: string;
    rows: ClassifiedLedgerRow[];
  },
): LedgerImportStats {
  const existing = db.prepare('SELECT * FROM ledger_imports WHERE file_sha256 = ?').get(input.fileSha256) as ImportRow | undefined;
  if (existing) return mapImport(existing, true);

  const period = periodOf(input.rows);
  return db.transaction(() => {
    const created = db.prepare(
      `INSERT INTO ledger_imports (
         source, original_name, file_sha256, period_start, period_end,
         row_count, inserted_count, duplicate_count, transfer_count, ignored_count
       ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`
    ).run(
      input.source,
      input.originalName,
      input.fileSha256,
      period.start,
      period.end,
      input.rows.length,
    );
    const importId = Number(created.lastInsertRowid);
    const insert = db.prepare(
      `INSERT INTO ledger_transactions (
         import_id, occurred_at, amount_cents, kind, category, payee, description,
         source, method, status_text, source_txn_id, fingerprint, raw_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let inserted = 0;
    let duplicate = 0;
    let transfer = 0;
    let ignored = 0;
    for (const row of input.rows) {
      try {
        insert.run(
          importId,
          row.occurredAt,
          row.amountCents,
          row.kind,
          row.category,
          row.payee,
          row.description,
          input.source,
          row.method,
          row.status,
          row.sourceTxnId,
          row.fingerprint,
          JSON.stringify(row.raw),
        );
        inserted += 1;
        if (row.kind === 'transfer') transfer += 1;
        if (row.kind === 'ignored') ignored += 1;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
          // 同一交易再次导入时状态可能已变（如退款）：按 (source, fingerprint)
          // 找到旧行并刷新可变字段，让 kind/统计跟着最新账单走。
          const existingTxn = db.prepare(
            'SELECT id, kind, status_text, amount_cents, duplicate_of FROM ledger_transactions WHERE source = ? AND fingerprint = ?'
          ).get(input.source, row.fingerprint) as
            | { id: number; kind: LedgerKind; status_text: string; amount_cents: number; duplicate_of: number | null }
            | undefined;
          if (
            existingTxn &&
            (existingTxn.kind !== row.kind ||
              existingTxn.status_text !== row.status ||
              existingTxn.amount_cents !== row.amountCents)
          ) {
            db.prepare(
              `UPDATE ledger_transactions
                  SET kind = ?, category = ?, status_text = ?, amount_cents = ?, raw_json = ?
                WHERE id = ?`
            ).run(
              row.kind,
              row.category,
              row.status,
              row.amountCents,
              JSON.stringify(row.raw),
              existingTxn.id,
            );
            // 跨来源去重后，统计计入的是被指向的银行流水行；钱包侧整单作废
            // （退款/撤销 → ignored）时要把同一笔钱的银行行一并置 ignored，
            // 否则月支出仍会保留已退款的金额。链接仍保留，防止该银行行被
            // 后续批次重新当成可匹配流水。
            if (row.kind === 'ignored' && existingTxn.kind !== 'ignored' && existingTxn.duplicate_of !== null) {
              db.prepare('UPDATE ledger_transactions SET kind = ? WHERE id = ?')
                .run('ignored', existingTxn.duplicate_of);
            }
          }
          duplicate += 1;
          continue;
        }
        throw error;
      }
    }
    linkCrossSourceDuplicates(db);
    db.prepare(
      `UPDATE ledger_imports
          SET inserted_count = ?, duplicate_count = ?, transfer_count = ?, ignored_count = ?
        WHERE id = ?`
    ).run(inserted, duplicate, transfer, ignored, importId);
    const saved = db.prepare('SELECT * FROM ledger_imports WHERE id = ?').get(importId) as ImportRow;
    return mapImport(saved);
  })();
}

export function listMonths(db: Db): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT substr(occurred_at, 1, 7) AS month
       FROM ledger_transactions
      ORDER BY month DESC`
  ).all() as Array<{ month: string }>;
  return rows.map((row) => row.month).filter(isYearMonth);
}

export function listTransactions(
  db: Db,
  opts: { month?: string; source?: LedgerSource; kind?: LedgerKind; limit?: number },
): LedgerTransaction[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.month && isYearMonth(opts.month)) {
    const range = monthRange(opts.month);
    clauses.push('occurred_at >= ? AND occurred_at < ?');
    params.push(range.start, range.end);
  }
  if (opts.source) {
    clauses.push('source = ?');
    params.push(opts.source);
  }
  if (opts.kind) {
    clauses.push('kind = ?');
    params.push(opts.kind);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(opts.limit ?? 400, 1), 2000);
  const rows = db.prepare(
    `SELECT * FROM ledger_transactions ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`
  ).all(...params, limit) as TxnRow[];
  return rows.map(mapTxn);
}

export function monthStats(db: Db, yearMonth: string): MonthStats {
  const range = monthRange(yearMonth);
  const rows = db.prepare(
    `SELECT * FROM ledger_transactions
      WHERE occurred_at >= ? AND occurred_at < ?`
  ).all(range.start, range.end) as TxnRow[];
  const unique = rows.filter((row) => row.kind !== 'ignored' && row.duplicate_of === null);
  const expenses = unique.filter((row) => row.kind === 'expense');
  const incomes = unique.filter((row) => row.kind === 'income');
  const transfers = unique.filter((row) => row.kind === 'transfer');
  const categoryMap = new Map<string, { expenseCents: number; incomeCents: number }>();
  const sourceMap = new Map<LedgerSource, { expenseCents: number; incomeCents: number }>();
  const add = (
    map: Map<string, { expenseCents: number; incomeCents: number }>,
    key: string,
    field: 'expenseCents' | 'incomeCents',
    amount: number,
  ) => {
    const current = map.get(key) ?? { expenseCents: 0, incomeCents: 0 };
    current[field] += amount;
    map.set(key, current);
  };
  for (const row of expenses) {
    add(categoryMap, row.category || '其他', 'expenseCents', row.amount_cents);
    add(sourceMap, row.source, 'expenseCents', row.amount_cents);
  }
  for (const row of incomes) {
    add(categoryMap, row.category || '其他', 'incomeCents', row.amount_cents);
    add(sourceMap, row.source, 'incomeCents', row.amount_cents);
  }
  const largeExpenses: LargeExpense[] = expenses
    .slice()
    .sort((a, b) => b.amount_cents - a.amount_cents)
    .slice(0, 8)
    .map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      amountCents: row.amount_cents,
      category: row.category,
      payee: row.payee,
      description: row.description,
      source: row.source,
    }));
  const incomeCents = incomes.reduce((sum, row) => sum + row.amount_cents, 0);
  const expenseCents = expenses.reduce((sum, row) => sum + row.amount_cents, 0);
  return {
    yearMonth,
    incomeCents,
    expenseCents,
    transferCents: transfers.reduce((sum, row) => sum + row.amount_cents, 0),
    netCents: incomeCents - expenseCents,
    txnCount: unique.length,
    duplicateCount: rows.filter((row) => row.duplicate_of !== null).length,
    transferCount: transfers.length,
    byCategory: [...categoryMap.entries()]
      .map(([category, value]) => ({ category, ...value }))
      .sort((a, b) => b.expenseCents - a.expenseCents),
    bySource: [...sourceMap.entries()].map(([source, value]) => ({ source, ...value })),
    largeExpenses,
  };
}

export function readMonthSummary(db: Db, yearMonth: string): MonthSummary {
  const stats = monthStats(db, yearMonth);
  const previousMonth = previousYearMonth(yearMonth);
  const previous = listMonths(db).includes(previousMonth) ? monthStats(db, previousMonth) : null;
  const saved = db.prepare(
    'SELECT advice, generated_at, model FROM ledger_monthly_summaries WHERE year_month = ?'
  ).get(yearMonth) as { advice: string | null; generated_at: string; model: string | null } | undefined;
  return {
    yearMonth,
    stats,
    previous,
    advice: saved?.advice ?? null,
    generatedAt: saved?.generated_at ?? null,
    model: saved?.model ?? null,
  };
}

export function saveMonthAdvice(
  db: Db,
  yearMonth: string,
  stats: MonthStats,
  advice: string,
  model: string,
): void {
  db.prepare(
    `INSERT INTO ledger_monthly_summaries (year_month, stats_json, advice, generated_at, model)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(year_month) DO UPDATE SET
       stats_json = excluded.stats_json,
       advice = excluded.advice,
       generated_at = excluded.generated_at,
       model = excluded.model`
  ).run(yearMonth, JSON.stringify(stats), advice, model);
}

export function shanghaiYearMonth(now = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(now));
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  return `${year}-${month}`;
}

export function shanghaiDayOfMonth(now = Date.now()): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    day: '2-digit',
  }).formatToParts(new Date(now));
  return Number(parts.find((part) => part.type === 'day')?.value ?? '0');
}
