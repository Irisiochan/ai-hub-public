import { classifyRow, parseAmountCents, parseOccurredAt } from './classify.js';
import { rowsFromBillFile } from './decode.js';
import type { ClassifiedLedgerRow, LedgerSource, ParsedLedgerRow } from './types.js';
import { LEDGER_SOURCES } from './types.js';

type ColumnMap = Record<string, number>;

const ALIPAY_MARKERS = ['支付宝', 'alipay'];
const WECHAT_MARKERS = ['微信支付', '微信昵称', '微信支付账单'];
const CMB_MARKERS = ['招商银行', '招行信用卡', '掌上生活'];

function cell(row: string[], index: number | undefined): string {
  if (index === undefined || index < 0) return '';
  return (row[index] ?? '').trim();
}

function headerIndex(header: string[], names: string[]): number {
  const normalized = header.map((name) => name.replace(/\s/g, ''));
  for (const name of names) {
    const index = normalized.findIndex((item) => item === name.replace(/\s/g, ''));
    if (index >= 0) return index;
  }
  return -1;
}

function mapColumns(header: string[], aliases: Record<string, string[]>): ColumnMap {
  const map: ColumnMap = {};
  for (const [key, names] of Object.entries(aliases)) {
    const index = headerIndex(header, names);
    if (index >= 0) map[key] = index;
  }
  return map;
}

function findHeader(rows: string[][], required: string[][]): number {
  return rows.findIndex((row) => required.every((names) => headerIndex(row, names) >= 0));
}

function detectSourceFromRows(rows: string[][]): LedgerSource | null {
  const head = rows.slice(0, 12).flat().join('\n');
  if (WECHAT_MARKERS.some((marker) => head.includes(marker))) return 'wechat';
  if (ALIPAY_MARKERS.some((marker) => head.includes(marker))) return 'alipay';
  if (CMB_MARKERS.some((marker) => head.includes(marker))) return 'cmb-cc';
  const header = rows.find((row) => row.some((cell) => cell.includes('交易'))) ?? [];
  if (headerIndex(header, ['交易单号', '支付方式']) >= 0) return 'wechat';
  if (headerIndex(header, ['交易订单号', '收/付款方式']) >= 0 || headerIndex(header, ['交易号']) >= 0) {
    return 'alipay';
  }
  if (headerIndex(header, ['交易日', '记账日']) >= 0 || headerIndex(header, ['卡号后四位']) >= 0) {
    return 'cmb-cc';
  }
  return null;
}

export function resolveLedgerSource(requested: string | undefined, rows: string[][]): LedgerSource {
  const trimmed = (requested ?? '').trim();
  if (trimmed && trimmed !== 'auto') {
    if (!LEDGER_SOURCES.includes(trimmed as LedgerSource)) {
      throw new Error('来源只能是 alipay / wechat / cmb-cc');
    }
    return trimmed as LedgerSource;
  }
  const detected = detectSourceFromRows(rows);
  if (!detected) throw new Error('看不出是哪家账单，请选支付宝 / 微信 / 招行信用卡');
  return detected;
}

function parseAlipay(rows: string[][]): ParsedLedgerRow[] {
  const headerAt = findHeader(rows, [['收/支'], ['金额', '金额（元）']]);
  if (headerAt < 0) throw new Error('支付宝账单缺表头（需要「收/支」和金额列）');
  const cols = mapColumns(rows[headerAt], {
    time: ['交易时间', '付款时间', '交易创建时间'],
    category: ['交易分类'],
    payee: ['交易对方'],
    description: ['商品说明', '商品名称'],
    direction: ['收/支'],
    amount: ['金额（元）', '金额'],
    method: ['收/付款方式', '付款方式'],
    status: ['交易状态'],
    txnId: ['交易订单号', '交易号'],
  });
  return rows.slice(headerAt + 1).map((row) => ({
    occurredAt: parseOccurredAt(cell(row, cols.time)),
    amountCents: parseAmountCents(cell(row, cols.amount)),
    direction: cell(row, cols.direction),
    type: '',
    categoryHint: cell(row, cols.category),
    payee: cell(row, cols.payee),
    description: cell(row, cols.description),
    method: cell(row, cols.method),
    status: cell(row, cols.status),
    sourceTxnId: cell(row, cols.txnId),
    raw: Object.fromEntries(rows[headerAt].map((name, index) => [name, row[index] ?? ''])),
  }));
}

function parseWechat(rows: string[][]): ParsedLedgerRow[] {
  const headerAt = findHeader(rows, [['交易时间'], ['收/支'], ['金额(元)', '金额（元）', '金额']]);
  if (headerAt < 0) throw new Error('微信账单缺表头（需要交易时间、收/支、金额）');
  const cols = mapColumns(rows[headerAt], {
    time: ['交易时间'],
    type: ['交易类型'],
    payee: ['交易对方'],
    description: ['商品'],
    direction: ['收/支'],
    amount: ['金额(元)', '金额（元）', '金额'],
    method: ['支付方式'],
    status: ['当前状态'],
    txnId: ['交易单号'],
  });
  return rows.slice(headerAt + 1).map((row) => ({
    occurredAt: parseOccurredAt(cell(row, cols.time)),
    amountCents: parseAmountCents(cell(row, cols.amount)),
    direction: cell(row, cols.direction),
    type: cell(row, cols.type),
    categoryHint: cell(row, cols.type),
    payee: cell(row, cols.payee),
    description: cell(row, cols.description),
    method: cell(row, cols.method),
    status: cell(row, cols.status),
    sourceTxnId: cell(row, cols.txnId),
    raw: Object.fromEntries(rows[headerAt].map((name, index) => [name, row[index] ?? ''])),
  }));
}

function parseCmb(rows: string[][]): ParsedLedgerRow[] {
  const headerAt = findHeader(rows, [['交易日', '交易日期']]);
  if (headerAt < 0) throw new Error('招行信用卡账单缺表头（需要交易日）');
  const cols = mapColumns(rows[headerAt], {
    time: ['交易日', '交易日期'],
    posted: ['记账日', '银行记账日'],
    description: ['交易说明', '交易描述'],
    amount: ['人民币金额', '交易金额'],
    expense: ['支出'],
    income: ['存入'],
    card: ['卡号后四位', '卡号末四位'],
  });
  return rows.slice(headerAt + 1).map((row) => {
    const expense = parseAmountCents(cell(row, cols.expense));
    const income = parseAmountCents(cell(row, cols.income));
    const amount = expense || income || parseAmountCents(cell(row, cols.amount));
    const direction = expense ? '支出' : income ? '存入' : Number(cell(row, cols.amount).replace(/[¥￥,\s]/g, '')) < 0 ? '存入' : '支出';
    const description = cell(row, cols.description);
    return {
      occurredAt: parseOccurredAt(cell(row, cols.time) || cell(row, cols.posted)),
      amountCents: amount,
      direction,
      type: '',
      categoryHint: '',
      payee: description,
      description,
      method: cell(row, cols.card) ? `招商银行信用卡(${cell(row, cols.card)})` : '招商银行信用卡',
      status: '成功',
      sourceTxnId: '',
      raw: Object.fromEntries(rows[headerAt].map((name, index) => [name, row[index] ?? ''])),
    };
  });
}

export function parseLedgerFile(buf: Buffer, requestedSource?: string): {
  source: LedgerSource;
  rows: ClassifiedLedgerRow[];
} {
  const table = rowsFromBillFile(buf);
  const source = resolveLedgerSource(requestedSource, table);
  const parsed = source === 'alipay'
    ? parseAlipay(table)
    : source === 'wechat'
      ? parseWechat(table)
      : parseCmb(table);
  const rows = parsed
    .map((row) => classifyRow(source, row))
    .filter((row): row is ClassifiedLedgerRow => row !== null);
  if (rows.length === 0) throw new Error('账单里没有可入账的交易');
  return { source, rows };
}
