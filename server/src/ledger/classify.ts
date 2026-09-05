import crypto from 'node:crypto';
import type { ClassifiedLedgerRow, LedgerKind, ParsedLedgerRow } from './types.js';

const IGNORE_STATUS = /失败|关闭|未付款|待付款|待支付|已全额退款|已退款|对方已退还|已撤销/;
const REPAY = /信用卡还款|还信用卡|还款/;
const TRANSFER_HINT = /余额宝|余利宝|零钱通|基金|理财|转入|转出|提现|充值到|亲情卡/;
const INVEST_CAT = /投资理财|信用还款|转账红包|微信红包/;

const CATEGORY_RULES: Array<{ re: RegExp; category: string }> = [
  { re: /工资|公积金|奖金/, category: '工资' },
  { re: /房租|房东|物业|水电|燃气|电费|水费/, category: '住房' },
  { re: /餐饮|美食|外卖|早餐|午餐|晚餐|麦当劳|肯德基|瑞幸|星巴克|奈雪|喜茶|美团|饿了么|食堂/, category: '餐饮' },
  { re: /交通|滴滴|地铁|公交|高铁|火车|出行|加油|停车/, category: '交通' },
  { re: /超市|便利店|盒马|永辉|日用|杂货/, category: '日用' },
  { re: /淘宝|天猫|京东|拼多多|购物|服饰|数码/, category: '购物' },
  { re: /医疗|医院|药店|挂号/, category: '医疗' },
  { re: /娱乐|电影|游戏|会员/, category: '娱乐' },
  { re: /话费|通信|流量/, category: '通讯' },
];

export function parseAmountCents(raw: string): number {
  const cleaned = raw.replace(/[¥￥,\s]/g, '').replace(/[()（）]/g, '');
  if (!cleaned) return 0;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.abs(value) * 100);
}

export function parseOccurredAt(raw: string): string {
  const trimmed = raw.trim();
  const compact = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]} 00:00:00`;
  const slash = trimmed.replace(/\//g, '-');
  const match = slash.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?/);
  if (!match) return '';
  const time = match[2] ? `${match[2]}:${match[3] ?? '00'}` : '00:00:00';
  return `${match[1]} ${time.length === 5 ? `${time}:00` : time}`;
}

export function methodLooksLikeCmbCredit(method: string): boolean {
  return /招商|招行|CMB/i.test(method) && /信用|信用卡/.test(method);
}

function blob(row: ParsedLedgerRow): string {
  return [row.direction, row.type, row.categoryHint, row.payee, row.description, row.method, row.status].join(' ');
}

export function categorize(row: ParsedLedgerRow): string {
  const text = blob(row);
  if (REPAY.test(text) || INVEST_CAT.test(row.categoryHint) || INVEST_CAT.test(row.type)) {
    return '还款与转账';
  }
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(text)) return rule.category;
  }
  const hint = row.categoryHint.trim();
  if (hint && hint !== '其他' && hint !== '-') return hint;
  return '其他';
}

export function classifyKind(row: ParsedLedgerRow, source?: string): LedgerKind {
  const text = blob(row);
  if (IGNORE_STATUS.test(row.status)) return 'ignored';
  if (REPAY.test(text) || INVEST_CAT.test(row.type) || INVEST_CAT.test(row.categoryHint)) {
    return 'transfer';
  }
  const direction = row.direction.replace(/\s/g, '');
  if (direction === '不计收支' || direction === '其他' || direction === '/') {
    if (TRANSFER_HINT.test(text) || REPAY.test(text)) return 'transfer';
    return 'ignored';
  }
  if (TRANSFER_HINT.test(text) && (direction === '不计收支' || /转账/.test(row.type))) {
    return 'transfer';
  }
  if (direction === '收入' || direction === '存入') {
    if (source === 'cmb-cc' && !/退款|退货/.test(text)) return 'transfer';
    return 'income';
  }
  if (direction === '支出') return 'expense';
  if (row.amountCents > 0 && /退款|退货/.test(text)) return 'income';
  return 'expense';
}

export function fingerprintFor(source: string, row: ParsedLedgerRow): string {
  if (row.sourceTxnId) return `id:${row.sourceTxnId}`;
  const basis = [
    source,
    row.occurredAt,
    String(row.amountCents),
    row.payee,
    row.description,
    row.method,
  ].join('|');
  return `h:${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 24)}`;
}

export function classifyRow(source: string, row: ParsedLedgerRow): ClassifiedLedgerRow | null {
  if (!row.occurredAt || row.amountCents <= 0) return null;
  const kind = classifyKind(row, source);
  return {
    ...row,
    kind,
    category: kind === 'ignored' ? '' : categorize(row),
    fingerprint: fingerprintFor(source, row),
  };
}

export function normalizePayee(value: string): string {
  return value.toLowerCase().replace(/[\s\-_/（）()【】\[\]·]/g, '');
}

export function payeeSimilar(a: string, b: string): boolean {
  const left = normalizePayee(a);
  const right = normalizePayee(b);
  if (!left || !right) return true;
  return left.includes(right) || right.includes(left);
}

export function daysBetween(a: string, b: string): number {
  const left = Date.parse(a.replace(' ', 'T') + '+08:00');
  const right = Date.parse(b.replace(' ', 'T') + '+08:00');
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 99;
  return Math.abs(left - right) / 86_400_000;
}
