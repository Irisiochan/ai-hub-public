import type { Db } from '../db.js';
import {
  listMonths,
  monthStats,
  previousYearMonth,
  readMonthSummary,
  saveMonthAdvice,
  shanghaiDayOfMonth,
  shanghaiYearMonth,
} from './store.js';
import type { MonthStats, MonthSummary } from './types.js';

const DEFAULT_DAILY_COST_CNY = 1;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ADVICE_CHARS = 800;

export type LedgerAdvisor = (input: {
  yearMonth: string;
  stats: MonthStats;
  previous: MonthStats | null;
}) => Promise<{ text: string; model: string; costCny?: number }>;

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function yuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

function endpoint(): string {
  const base = (
    process.env.LEDGER_SUMMARY_API_BASE_URL
    || process.env.CAPTION_API_BASE_URL
    || ''
  ).trim().replace(/\/+$/, '');
  if (!base) throw new Error('LEDGER_SUMMARY_API_BASE_URL 未配置');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function tokenCostCny(usage: Record<string, unknown> | undefined): number {
  const input = finite(usage?.prompt_tokens, 0);
  const output = finite(usage?.completion_tokens, 0);
  const inputRate = finite(process.env.LEDGER_SUMMARY_INPUT_CNY_PER_MILLION, finite(process.env.CAPTION_INPUT_CNY_PER_MILLION, 0));
  const outputRate = finite(process.env.LEDGER_SUMMARY_OUTPUT_CNY_PER_MILLION, finite(process.env.CAPTION_OUTPUT_CNY_PER_MILLION, 0));
  return (input * inputRate + output * outputRate) / 1_000_000;
}

function statsBlock(label: string, stats: MonthStats): string {
  const categories = stats.byCategory
    .filter((item) => item.expenseCents > 0)
    .slice(0, 8)
    .map((item) => `${item.category} ${yuan(item.expenseCents)}`)
    .join('；');
  const large = stats.largeExpenses
    .slice(0, 5)
    .map((item) => `${item.occurredAt.slice(0, 10)} ${item.payee || item.description} ${yuan(item.amountCents)}`)
    .join('；');
  return [
    `${label}：收入 ${yuan(stats.incomeCents)}，支出 ${yuan(stats.expenseCents)}，净结余 ${yuan(stats.netCents)}`,
    `还款/转账 ${yuan(stats.transferCents)}（${stats.transferCount} 笔，不计入支出）`,
    `已去重 ${stats.duplicateCount} 笔跨渠道重复`,
    categories ? `支出类目：${categories}` : '支出类目：无',
    large ? `大额：${large}` : '大额：无',
  ].join('\n');
}

const SYSTEM_PROMPT = [
  '你是 User 的私人账本顾问。根据已经去重、并把还款/转账单列的月度数字写建议。',
  '不要说教，不要鸡汤，不要让她省不该省的钱。',
  '指出最大支出类目、和上月比（如有）、异常大额、还款压力、下月可执行的一两件小事。',
  '纯中文，最多 400 字，不要标题党。',
].join('');

export const adviseWithLanguageModel: LedgerAdvisor = async ({ yearMonth, stats, previous }) => {
  const apiKey = (process.env.LEDGER_SUMMARY_API_KEY || process.env.CAPTION_API_KEY || '').trim();
  if (!apiKey) throw new Error('LEDGER_SUMMARY_API_KEY 未配置');
  const model = (process.env.LEDGER_SUMMARY_MODEL || process.env.CAPTION_MODEL || 'gemini-flash-latest').trim();
  const timeoutMs = finite(process.env.LEDGER_SUMMARY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const user = [
    `月份：${yearMonth}`,
    statsBlock('本月', stats),
    previous ? statsBlock('上月', previous) : '上月：暂无账本',
  ].join('\n');
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 700,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({})) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: Record<string, unknown>;
  };
  if (!response.ok) throw new Error(payload.error?.message ?? `ledger summary HTTP ${response.status}`);
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('月结模型返回空内容');
  return { text: text.slice(0, MAX_ADVICE_CHARS), model, costCny: tokenCostCny(payload.usage) };
};

export class LedgerSummaryService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: (message: string) => void = () => {},
    private readonly advisor: LedgerAdvisor = adviseWithLanguageModel,
  ) {}

  get enabled(): boolean {
    return Boolean(
      (process.env.LEDGER_SUMMARY_API_KEY || process.env.CAPTION_API_KEY || '').trim()
      && (process.env.LEDGER_SUMMARY_API_BASE_URL || process.env.CAPTION_API_BASE_URL || '').trim(),
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 6 * 3600_000);
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private reserveDailyCost(limitCny: number, amountCny: number): boolean {
    if (limitCny <= 0) return true;
    const amount = Math.max(amountCny, 0);
    return this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT cost_cny FROM ledger_summary_usage WHERE day = date('now', '+8 hours')"
      ).get() as { cost_cny: number } | undefined;
      if (finite(row?.cost_cny, 0) + amount > limitCny) return false;
      this.db.prepare(`
        INSERT INTO ledger_summary_usage (day, requests, cost_cny)
        VALUES (date('now', '+8 hours'), 1, ?)
        ON CONFLICT(day) DO UPDATE SET
          requests = requests + 1,
          cost_cny = cost_cny + excluded.cost_cny
      `).run(amount);
      return true;
    })();
  }

  async generate(yearMonth: string, force = false): Promise<MonthSummary> {
    const current = readMonthSummary(this.db, yearMonth);
    if (current.stats.txnCount === 0) throw new Error(`${yearMonth} 没有可结算的交易`);
    if (current.advice && !force) return current;
    if (!this.enabled) throw new Error('月结模型未配置');
    const limitCny = finite(process.env.LEDGER_SUMMARY_DAILY_COST_CNY, DEFAULT_DAILY_COST_CNY);
    if (!this.reserveDailyCost(limitCny, 0.01)) throw new Error('本日月结额度用完了');
    const result = await this.advisor({
      yearMonth,
      stats: current.stats,
      previous: current.previous ?? null,
    });
    saveMonthAdvice(this.db, yearMonth, current.stats, result.text, result.model);
    return readMonthSummary(this.db, yearMonth);
  }

  async tick(now = Date.now()): Promise<void> {
    if (!this.enabled) return;
    if (shanghaiDayOfMonth(now) > 7) return;
    const target = previousYearMonth(shanghaiYearMonth(now));
    if (!listMonths(this.db).includes(target)) return;
    const current = readMonthSummary(this.db, target);
    if (current.advice || current.stats.txnCount === 0) return;
    try {
      await this.generate(target);
      this.log(`ledger monthly summary wrote ${target}`);
    } catch (error) {
      this.log(`ledger monthly summary failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  snapshot(yearMonth: string): MonthSummary {
    return readMonthSummary(this.db, yearMonth);
  }

  statsFor(yearMonth: string): MonthStats {
    return monthStats(this.db, yearMonth);
  }
}
