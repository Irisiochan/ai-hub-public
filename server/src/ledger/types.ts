export const LEDGER_SOURCES = ['alipay', 'wechat', 'cmb-cc'] as const;
export type LedgerSource = (typeof LEDGER_SOURCES)[number];

export const LEDGER_KINDS = ['expense', 'income', 'transfer', 'ignored'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export interface ParsedLedgerRow {
  occurredAt: string;
  amountCents: number;
  direction: string;
  type: string;
  categoryHint: string;
  payee: string;
  description: string;
  method: string;
  status: string;
  sourceTxnId: string;
  raw: Record<string, string>;
}

export interface ClassifiedLedgerRow extends ParsedLedgerRow {
  kind: LedgerKind;
  category: string;
  fingerprint: string;
}

export interface LedgerImportStats {
  id: number;
  source: LedgerSource;
  originalName: string;
  fileSha256: string;
  periodStart: string | null;
  periodEnd: string | null;
  rowCount: number;
  insertedCount: number;
  duplicateCount: number;
  transferCount: number;
  ignoredCount: number;
  createdAt: string;
  reused?: boolean;
}

export interface LedgerTransaction {
  id: number;
  importId: number;
  occurredAt: string;
  amountCents: number;
  kind: LedgerKind;
  category: string;
  payee: string;
  description: string;
  source: LedgerSource;
  method: string;
  statusText: string;
  sourceTxnId: string;
  fingerprint: string;
  duplicateOf: number | null;
}

export interface CategorySlice {
  category: string;
  expenseCents: number;
  incomeCents: number;
}

export interface SourceSlice {
  source: LedgerSource;
  expenseCents: number;
  incomeCents: number;
}

export interface LargeExpense {
  id: number;
  occurredAt: string;
  amountCents: number;
  category: string;
  payee: string;
  description: string;
  source: LedgerSource;
}

export interface MonthStats {
  yearMonth: string;
  incomeCents: number;
  expenseCents: number;
  transferCents: number;
  netCents: number;
  txnCount: number;
  duplicateCount: number;
  transferCount: number;
  byCategory: CategorySlice[];
  bySource: SourceSlice[];
  largeExpenses: LargeExpense[];
}

export interface MonthSummary {
  yearMonth: string;
  stats: MonthStats;
  previous?: MonthStats | null;
  advice: string | null;
  generatedAt: string | null;
  model: string | null;
}
