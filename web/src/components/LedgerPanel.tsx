import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type LedgerImportStats,
  type LedgerKind,
  type LedgerMonthSummary,
  type LedgerSource,
  type LedgerTransaction,
} from '../api';
import { Icon } from './icons';

interface Props {
  onClose(): void;
}

const SOURCE_LABEL: Record<LedgerSource | 'auto', string> = {
  auto: '自动识别',
  alipay: '支付宝',
  wechat: '微信',
  'cmb-cc': '招行信用卡',
};

const KIND_LABEL: Record<LedgerKind, string> = {
  expense: '支出',
  income: '收入',
  transfer: '还款/转账',
  ignored: '忽略',
};

function yuan(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}¥${(Math.abs(cents) / 100).toFixed(2)}`;
}

function currentYearMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`;
}

function shiftMonth(yearMonth: string, delta: number): string {
  const [year, month] = yearMonth.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default function LedgerPanel({ onClose }: Props) {
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState(currentYearMonth);
  const [summary, setSummary] = useState<LedgerMonthSummary | null>(null);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [source, setSource] = useState<LedgerSource | 'auto'>('auto');
  const [kindFilter, setKindFilter] = useState<'' | LedgerKind>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [importNote, setImportNote] = useState<LedgerImportStats | null>(null);

  const load = useCallback(async (nextMonth: string, nextKind: '' | LedgerKind) => {
    const [monthList, monthSummary, txn] = await Promise.all([
      api.ledgerMonths(),
      api.ledgerMonth(nextMonth),
      api.ledgerTransactions({ month: nextMonth, kind: nextKind || undefined }),
    ]);
    setMonths(monthList.months);
    setSummary(monthSummary);
    setTransactions(txn.transactions);
  }, []);

  useEffect(() => {
    void load(month, kindFilter).catch((err: Error) => setError(err.message));
  }, [kindFilter, load, month]);

  const stats = summary?.stats;
  const monthOptions = useMemo(() => {
    const set = new Set(months);
    set.add(month);
    return [...set].sort().reverse();
  }, [month, months]);

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    setBusy('import');
    setError('');
    try {
      const result = await api.ledgerImport(file, source);
      setImportNote(result);
      await load(month, kindFilter);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const onSummarize = async () => {
    setBusy('summary');
    setError('');
    try {
      setSummary(await api.ledgerSummarize(month, Boolean(summary?.advice)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal ledger-panel" onClick={(event) => event.stopPropagation()}>
        <header className="ledger-topbar">
          <b>账本</b>
          <small>官方导出导入 · 已去重 · 还款单列 · 不做手记</small>
          <span className="spacer" />
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭账本">
            <Icon name="close" />
          </button>
        </header>

        <div className="ledger-toolbar">
          <button type="button" className="ghost-btn compact" onClick={() => setMonth(shiftMonth(month, -1))}>
            上月
          </button>
          <select value={month} onChange={(event) => setMonth(event.target.value)} aria-label="选择月份">
            {monthOptions.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
          <button type="button" className="ghost-btn compact" onClick={() => setMonth(shiftMonth(month, 1))}>
            下月
          </button>
          <select
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value as '' | LedgerKind)}
            aria-label="筛选类型"
          >
            <option value="">全部类型</option>
            <option value="expense">支出</option>
            <option value="income">收入</option>
            <option value="transfer">还款/转账</option>
            <option value="ignored">忽略</option>
          </select>
        </div>

        <div className="ledger-import">
          <select
            value={source}
            onChange={(event) => setSource(event.target.value as LedgerSource | 'auto')}
            aria-label="账单来源"
          >
            <option value="auto">{SOURCE_LABEL.auto}</option>
            <option value="alipay">{SOURCE_LABEL.alipay}</option>
            <option value="wechat">{SOURCE_LABEL.wechat}</option>
            <option value="cmb-cc">{SOURCE_LABEL['cmb-cc']}</option>
          </select>
          <label className="primary-btn ledger-file">
            {busy === 'import' ? '导入中…' : '导入账单'}
            <input
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={busy === 'import'}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                void onImport(file);
              }}
            />
          </label>
          <span className="ledger-hint">支付宝 CSV · 微信 CSV/XLSX · 招行信用卡 CSV</span>
        </div>

        {error && <p className="ledger-error">{error}</p>}
        {importNote && (
          <p className="ledger-note">
            {importNote.reused ? '这份文件已经导过。' : `${SOURCE_LABEL[importNote.source]} 导入完成。`}
            入账 {importNote.insertedCount}，同源重复 {importNote.duplicateCount}，还款/转账 {importNote.transferCount}，忽略 {importNote.ignoredCount}
          </p>
        )}

        {stats && (
          <section className="ledger-stats">
            <div><small>收入</small><b>{yuan(stats.incomeCents)}</b></div>
            <div><small>支出</small><b>{yuan(stats.expenseCents)}</b></div>
            <div><small>净结余</small><b>{yuan(stats.netCents)}</b></div>
            <div><small>还款/转账</small><b>{yuan(stats.transferCents)}</b></div>
          </section>
        )}

        {stats && stats.byCategory.length > 0 && (
          <ul className="ledger-cats">
            {stats.byCategory.filter((item) => item.expenseCents > 0).slice(0, 6).map((item) => (
              <li key={item.category}>
                <span>{item.category}</span>
                <b>{yuan(item.expenseCents)}</b>
              </li>
            ))}
          </ul>
        )}

        <section className="ledger-advice">
          <div className="ledger-advice-head">
            <b>月结建议</b>
            <button type="button" className="ghost-btn compact" disabled={busy === 'summary'} onClick={() => void onSummarize()}>
              {busy === 'summary' ? '生成中…' : summary?.advice ? '重写本月建议' : '生成本月建议'}
            </button>
          </div>
          {summary?.advice ? <p>{summary.advice}</p> : <p className="ledger-hint">导入账单后，月初会自动写上一月建议；也可以现在生成。</p>}
        </section>

        <div className="ledger-table-wrap">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>金额</th>
                <th>分类</th>
                <th>对方</th>
                <th>渠道</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((row) => (
                <tr key={row.id} className={row.duplicateOf ? 'dup' : row.kind}>
                  <td>{row.occurredAt.slice(0, 16)}</td>
                  <td>{KIND_LABEL[row.kind]}{row.duplicateOf ? ' · 重复' : ''}</td>
                  <td>{yuan(row.kind === 'income' ? row.amountCents : row.kind === 'expense' ? -row.amountCents : row.amountCents)}</td>
                  <td>{row.category || '—'}</td>
                  <td title={row.description}>{row.payee || row.description || '—'}</td>
                  <td>{SOURCE_LABEL[row.source]}</td>
                </tr>
              ))}
              {transactions.length === 0 && (
                <tr><td colSpan={6} className="ledger-hint">这个月还没有账单。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
