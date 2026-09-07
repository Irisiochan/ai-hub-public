import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { openDb } from '../src/db.js';
import { classifyKind, parseAmountCents, parseOccurredAt } from '../src/ledger/classify.js';
import { parseCsv, parseXlsx, rowsFromBillFile, sha256Hex } from '../src/ledger/decode.js';
import { parseLedgerFile } from '../src/ledger/parse.js';
import {
  importLedgerRows,
  listMonths,
  listTransactions,
  monthStats,
  previousYearMonth,
  readMonthSummary,
} from '../src/ledger/store.js';
import { LedgerSummaryService } from '../src/ledger/summary.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
const db = openDb(path.join(dir, 'hub.db'));

const ALIPAY = `支付宝（中国）网络技术有限公司
账号:[User@example.com]
----------------------------------------------
交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注
2026-08-03 12:10:00,餐饮美食,美团,,"午餐",支出,28.00,招商银行信用卡,交易成功,ali-meituan,m1,
2026-08-05 09:00:00,信用还款,招商银行,,"信用卡还款",不计收支,1200.00,余额,交易成功,ali-repay,m2,
2026-08-10 18:00:00,退款,美团,,"退款-饮料",收入,12.00,招商银行信用卡,退款成功,ali-refund,m3,
`;

const WECHAT = `微信支付账单明细
微信昵称：[User]
起始时间：[2026-08-01 00:00:00] 终止时间：[2026-08-31 23:59:59]
交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
2026-08-04 08:00:00,商户消费,瑞幸咖啡,咖啡,支出,¥15.00,招商银行信用卡,支付成功,wx-luckin,m,
2026-08-04 09:00:00,商户消费,失败店,x,支出,¥9.00,零钱,已全额退款,wx-refunded,m,
2026-08-20 10:00:00,信用卡还款,招商银行信用卡,还款,不计收支,¥800.00,零钱通,支付成功,wx-repay,m,
`;

const CMB = `招商银行信用卡
交易日,记账日,卡号后四位,交易描述,支出,存入
2026-08-03,2026-08-04,1234,美团,28.00,
2026-08-04,2026-08-05,1234,瑞幸咖啡,15.00,
2026-08-06,2026-08-06,1234,自动还款,,1200.00
`;

function cell(ref: string, text: string): string {
  return `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
}

function wechatXlsx(): Buffer {
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1">${cell('A1', '微信支付账单明细')}</row>
<row r="2">${cell('A2', '交易时间')}${cell('B2', '交易类型')}${cell('C2', '交易对方')}${cell('D2', '商品')}${cell('E2', '收/支')}${cell('F2', '金额(元)')}${cell('G2', '支付方式')}${cell('H2', '当前状态')}${cell('I2', '交易单号')}</row>
<row r="3">${cell('A3', '2026-08-11 11:00:00')}${cell('B3', '商户消费')}${cell('C3', '盒马')}${cell('D3', '菜')}${cell('E3', '支出')}${cell('F3', '¥42.00')}${cell('G3', '零钱')}${cell('H3', '支付成功')}${cell('I3', 'wx-hema')}</row>
</sheetData></worksheet>`;
  const zipped = zipSync({
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
  return Buffer.from(zipped);
}

try {
  assert.equal(parseAmountCents('¥1,234.56'), 123456);
  assert.equal(parseOccurredAt('20260803'), '2026-08-03 00:00:00');
  assert.equal(parseOccurredAt('2026/08/03 12:03'), '2026-08-03 12:03:00');
  assert.equal(classifyKind({
    occurredAt: '2026-08-01 00:00:00',
    amountCents: 100,
    direction: '存入',
    type: '',
    categoryHint: '',
    payee: '退货退款',
    description: '退货退款',
    method: '招商银行信用卡(1234)',
    status: '成功',
    sourceTxnId: '',
    raw: {},
  }, 'cmb-cc'), 'income');
  assert.equal(classifyKind({
    occurredAt: '2026-08-01 00:00:00',
    amountCents: 100,
    direction: '存入',
    type: '',
    categoryHint: '',
    payee: '转账存入',
    description: '转账存入',
    method: '招商银行信用卡(1234)',
    status: '成功',
    sourceTxnId: '',
    raw: {},
  }, 'cmb-cc'), 'transfer');

  const csvRows = parseCsv('a,"b,c",d\n1,2,3\n');
  assert.deepEqual(csvRows[0], ['a', 'b,c', 'd']);

  const alipay = parseLedgerFile(Buffer.from(ALIPAY), 'alipay');
  assert.equal(alipay.rows.length, 3);
  assert.equal(alipay.rows.find((row) => row.sourceTxnId === 'ali-meituan')?.kind, 'expense');
  assert.equal(alipay.rows.find((row) => row.sourceTxnId === 'ali-repay')?.kind, 'transfer');
  assert.equal(alipay.rows.find((row) => row.sourceTxnId === 'ali-refund')?.kind, 'income');

  const wechat = parseLedgerFile(Buffer.from(WECHAT), 'auto');
  assert.equal(wechat.source, 'wechat');
  assert.equal(wechat.rows.find((row) => row.sourceTxnId === 'wx-luckin')?.kind, 'expense');
  assert.equal(wechat.rows.find((row) => row.sourceTxnId === 'wx-refunded')?.kind, 'ignored');
  assert.equal(wechat.rows.find((row) => row.sourceTxnId === 'wx-repay')?.kind, 'transfer');

  const cmb = parseLedgerFile(Buffer.from(CMB), 'cmb-cc');
  assert.equal(cmb.rows.length, 3);
  assert.equal(cmb.rows.filter((row) => row.kind === 'expense').length, 2);
  assert.equal(cmb.rows.filter((row) => row.kind === 'transfer').length, 1);

  const alipayImport = importLedgerRows(db, {
    source: alipay.source,
    originalName: 'alipay.csv',
    fileSha256: sha256Hex(Buffer.from(ALIPAY)),
    rows: alipay.rows,
  });
  assert.equal(alipayImport.insertedCount, 3);
  const reused = importLedgerRows(db, {
    source: alipay.source,
    originalName: 'alipay.csv',
    fileSha256: sha256Hex(Buffer.from(ALIPAY)),
    rows: alipay.rows,
  });
  assert.equal(reused.reused, true);

  importLedgerRows(db, {
    source: wechat.source,
    originalName: 'wechat.csv',
    fileSha256: sha256Hex(Buffer.from(WECHAT)),
    rows: wechat.rows,
  });
  importLedgerRows(db, {
    source: cmb.source,
    originalName: 'cmb.csv',
    fileSha256: sha256Hex(Buffer.from(CMB)),
    rows: cmb.rows,
  });

  const txns = listTransactions(db, { month: '2026-08' });
  const meituanAlipay = txns.find((row) => row.sourceTxnId === 'ali-meituan');
  const luckin = txns.find((row) => row.sourceTxnId === 'wx-luckin');
  const cmbMeituan = txns.find((row) => row.source === 'cmb-cc' && row.payee === '美团');
  const cmbLuckin = txns.find((row) => row.source === 'cmb-cc' && row.payee === '瑞幸咖啡');
  assert.ok(meituanAlipay && luckin && cmbMeituan && cmbLuckin);
  assert.equal(meituanAlipay.duplicateOf, cmbMeituan.id);
  assert.equal(luckin.duplicateOf, cmbLuckin.id);
  const aliRepay = txns.find((row) => row.sourceTxnId === 'ali-repay');
  const cmbRepay = txns.find((row) => row.source === 'cmb-cc' && row.description === '自动还款');
  assert.ok(aliRepay && cmbRepay);
  assert.equal(aliRepay.kind, 'transfer');
  assert.equal(cmbRepay.kind, 'transfer');
  assert.equal(aliRepay.duplicateOf, cmbRepay.id);

  const stats = monthStats(db, '2026-08');
  assert.equal(stats.expenseCents, 28_00 + 15_00);
  assert.equal(stats.incomeCents, 12_00);
  assert.equal(stats.netCents, 12_00 - 43_00);
  assert.equal(stats.transferCents, 1200_00 + 800_00);
  assert.equal(stats.duplicateCount, 3);
  assert.ok(stats.byCategory.some((item) => item.category === '餐饮' && item.expenseCents === 43_00));
  assert.deepEqual(listMonths(db), ['2026-08']);
  assert.equal(previousYearMonth('2026-01'), '2025-12');

  const xlsxBuf = wechatXlsx();
  const xlsxRows = parseXlsx(xlsxBuf);
  assert.equal(xlsxRows[1][0], '交易时间');
  const xlsxParsed = parseLedgerFile(xlsxBuf, 'wechat');
  assert.equal(xlsxParsed.rows[0].payee, '盒马');
  assert.equal(xlsxParsed.rows[0].amountCents, 4200);

  assert.throws(() => rowsFromBillFile(Buffer.from('%PDF-1.7 fake')), /PDF/);

  let advised = 0;
  const summaries = new LedgerSummaryService(db, () => {}, async ({ yearMonth, stats: month }) => {
    advised += 1;
    assert.equal(yearMonth, '2026-08');
    assert.equal(month.expenseCents, 43_00);
    return { text: '餐饮占大头，还款已单列。', model: 'test-model', costCny: 0 };
  });
  process.env.LEDGER_SUMMARY_API_KEY = 'test';
  process.env.LEDGER_SUMMARY_API_BASE_URL = 'https://ledger.example';
  const first = await summaries.generate('2026-08');
  assert.equal(first.advice, '餐饮占大头，还款已单列。');
  const second = await summaries.generate('2026-08');
  assert.equal(advised, 1);
  const forced = await summaries.generate('2026-08', true);
  assert.equal(advised, 2);
  assert.equal(readMonthSummary(db, '2026-08').model, 'test-model');
  assert.equal(forced.stats.txnCount > 0, true);

  await summaries.tick(Date.parse('2026-09-02T04:00:00+08:00'));

  // —— 跨批次一对一匹配：已被消费的银行流水不能再吃掉后续批次的新消费 ——
  const ALIPAY_BATCH2 = `支付宝（中国）网络技术有限公司
账号:[User@example.com]
----------------------------------------------
交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注
2026-08-03 13:00:00,餐饮美食,美团,,"午餐二号",支出,28.00,招商银行信用卡,交易成功,ali-meituan-2,m9,
`;
  const alipay2 = parseLedgerFile(Buffer.from(ALIPAY_BATCH2), 'alipay');
  importLedgerRows(db, {
    source: alipay2.source,
    originalName: 'alipay-batch2.csv',
    fileSha256: sha256Hex(Buffer.from(ALIPAY_BATCH2)),
    rows: alipay2.rows,
  });
  const meituan2 = listTransactions(db, { month: '2026-08' }).find(
    (row) => row.sourceTxnId === 'ali-meituan-2',
  );
  assert.ok(meituan2);
  assert.equal(meituan2.duplicateOf, null, '银行侧 28 元已被首批消费，第二笔必须保持独立');
  assert.equal(monthStats(db, '2026-08').expenseCents, 43_00 + 28_00);

  // —— 重导带退款状态的同一订单：按交易 ID 更新状态并反映进统计 ——
  const WECHAT_NOODLE = `微信支付账单明细
微信昵称：[User]
起始时间：[2026-08-01 00:00:00] 终止时间：[2026-08-31 23:59:59]
交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
2026-08-12 10:00:00,商户消费,面馆,面,支出,¥28.00,零钱,支付成功,wx-noodle,m,
`;
  const noodlePaid = parseLedgerFile(Buffer.from(WECHAT_NOODLE), 'wechat');
  importLedgerRows(db, {
    source: noodlePaid.source,
    originalName: 'wechat-noodle.csv',
    fileSha256: sha256Hex(Buffer.from(WECHAT_NOODLE)),
    rows: noodlePaid.rows,
  });
  assert.equal(monthStats(db, '2026-08').expenseCents, 71_00 + 28_00);

  const WECHAT_NOODLE_REFUND = WECHAT_NOODLE.replace('支付成功,wx-noodle', '已全额退款,wx-noodle');
  const noodleRefund = parseLedgerFile(Buffer.from(WECHAT_NOODLE_REFUND), 'wechat');
  const refundImport = importLedgerRows(db, {
    source: noodleRefund.source,
    originalName: 'wechat-noodle-refund.csv',
    fileSha256: sha256Hex(Buffer.from(WECHAT_NOODLE_REFUND)),
    rows: noodleRefund.rows,
  });
  assert.equal(refundImport.duplicateCount, 1);
  const noodleTxn = listTransactions(db, { month: '2026-08' }).find(
    (row) => row.sourceTxnId === 'wx-noodle',
  );
  assert.ok(noodleTxn);
  assert.equal(noodleTxn.kind, 'ignored', '全额退款后同一订单要更新为不计支出');
  assert.equal(noodleTxn.statusText, '已全额退款');
  assert.equal(monthStats(db, '2026-08').expenseCents, 71_00);

  console.log('ledger tests ok');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
