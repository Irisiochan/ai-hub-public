import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import type { Db } from '../db.js';
import { sha256Hex } from '../ledger/decode.js';
import { parseLedgerFile } from '../ledger/parse.js';
import { importLedgerRows, isYearMonth, listMonths, listTransactions } from '../ledger/store.js';
import type { LedgerSummaryService } from '../ledger/summary.js';
import { LEDGER_KINDS, LEDGER_SOURCES, type LedgerKind, type LedgerSource } from '../ledger/types.js';
import { parsePositiveIntegerQuery } from '../queryParams.js';

const MAX_BILL_BYTES = 8 * 1024 * 1024;

function asSource(value: unknown): LedgerSource | undefined {
  if (typeof value !== 'string' || value === '' || value === 'auto') return undefined;
  if (!LEDGER_SOURCES.includes(value as LedgerSource)) {
    throw new Error('来源只能是 alipay / wechat / cmb-cc');
  }
  return value as LedgerSource;
}

function asKind(value: unknown): LedgerKind | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  if (!LEDGER_KINDS.includes(value as LedgerKind)) throw new Error('kind 不合法');
  return value as LedgerKind;
}

export function ledgerRouter(db: Db, summaries: LedgerSummaryService): Router {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_BILL_BYTES, files: 1 },
  });

  const receiveBill: RequestHandler = (req, res, next) => {
    upload.single('file')(req, res, (error) => {
      if (!error) return next();
      const message = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
        ? '账单文件不能超过 8 MB'
        : error instanceof Error ? error.message : '账单上传失败';
      res.status(400).json({ error: message });
    });
  };

  router.get('/months', (_req, res) => {
    res.json({ months: listMonths(db) });
  });

  router.get('/months/:yearMonth', (req, res) => {
    const yearMonth = String(req.params.yearMonth ?? '');
    if (!isYearMonth(yearMonth)) return res.status(400).json({ error: '月份格式是 YYYY-MM' });
    res.json(summaries.snapshot(yearMonth));
  });

  router.post('/months/:yearMonth/summarize', async (req, res) => {
    const yearMonth = String(req.params.yearMonth ?? '');
    if (!isYearMonth(yearMonth)) return res.status(400).json({ error: '月份格式是 YYYY-MM' });
    try {
      const force = req.body?.force === true || req.query.force === '1';
      res.json(await summaries.generate(yearMonth, force));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/transactions', (req, res) => {
    try {
      const month = typeof req.query.month === 'string' ? req.query.month : undefined;
      if (month && !isYearMonth(month)) return res.status(400).json({ error: '月份格式是 YYYY-MM' });
      res.json({
        transactions: listTransactions(db, {
          month,
          source: asSource(req.query.source),
          kind: asKind(req.query.kind),
          limit: parsePositiveIntegerQuery(req.query.limit, 400, 2000),
        }),
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/import', receiveBill, (req, res) => {
    const file = req.file;
    if (!file?.buffer?.length) return res.status(400).json({ error: '请上传支付宝 / 微信 / 招行信用卡账单文件' });
    try {
      const requested = typeof req.body?.source === 'string' ? req.body.source : req.query.source;
      const parsed = parseLedgerFile(file.buffer, typeof requested === 'string' ? requested : undefined);
      const result = importLedgerRows(db, {
        source: parsed.source,
        originalName: file.originalname || 'bill.csv',
        fileSha256: sha256Hex(file.buffer),
        rows: parsed.rows,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
