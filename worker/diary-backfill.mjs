#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { normalizeDiaryConfig, shanghaiDateAt, TriageStore } from './triage-core.mjs';
import { rollupDay } from './diary-rollup.mjs';
import { DeepSeekClient, HubClient, VaultClient } from './triage-clients.mjs';

/**
 * 一次性补写历史日记流水，走 diary-rollup.mjs 同一条链路。
 *
 *   node diary-backfill.mjs --from 2026-07-21 --to 2026-07-27 [--dry-run]
 *     [--config triage.config.json] [--source hub-rollup-backfill] [--force]
 *
 * 默认 source 与每日 rollup 不同（`hub-rollup-backfill`），这样日记里一眼能看出
 * 哪几条是事后重建的，哪几条是当天记的。
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

function has(name) {
  return process.argv.includes(`--${name}`);
}

function log(level, message, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    level,
    time: new Date().toISOString(),
    component: 'diary-backfill',
    msg: message,
    ...fields,
  })}\n`);
}

function datesBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00+08:00`);
  const end = Date.parse(`${to}T00:00:00+08:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('invalid date range');
  if (end < start) throw new Error('--to must not be earlier than --from');
  const days = [];
  for (let at = start; at <= end; at += 24 * 60 * 60_000) {
    days.push(shanghaiDateAt(at, 0));
  }
  return days;
}

// 退出码走 process.exitCode 而不是 process.exit()：Windows 上 process.exit()
// 会在 stdout 还有 pending 写入时触发 libuv 的 UV_HANDLE_CLOSING 断言直接崩掉。
async function main() {
  const from = flag('from');
  const to = flag('to', from);
  if (!DATE_RE.test(String(from)) || !DATE_RE.test(String(to))) {
    process.stderr.write('usage: diary-backfill.mjs --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run]\n');
    return 2;
  }

  const today = shanghaiDateAt(Date.now(), 0);
  if (to >= today && !has('force')) {
    process.stderr.write(
      `refusing to backfill ${to}: 当天还没过完，rollup 会漏掉后面的对话。要么等明天，要么加 --force。\n`
    );
    return 2;
  }

  const configPath = path.resolve(flag('config') ?? path.join(scriptDir, 'triage.config.json'));
  if (!fs.existsSync(configPath)) {
    process.stderr.write(`missing config: ${configPath}\n`);
    return 2;
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const diary = normalizeDiaryConfig({
    ...(raw.diary ?? {}),
    // backfill 是人工触发的，不受 diary.enabled 开关约束。
    enabled: true,
    source: flag('source') ?? 'hub-rollup-backfill',
  });

  const dryRun = has('dry-run');
  const hub = new HubClient(raw.hub ?? {});
  const deepseek = new DeepSeekClient(raw.deepseek ?? {}, raw.categories ?? []);
  const vault = new VaultClient(raw.vault ?? {});
  if (!dryRun && !vault.enabled) {
    process.stderr.write('vault.url is not configured; nothing could be written\n');
    return 2;
  }

  // 补过的日子要在 worker 的状态表里销账，否则定时 rollup 撞上同一天会写第二遍。
  // dry-run 不销账；--force 重跑时覆盖旧值即可，backfill 自己从不读这张表。
  const store = !dryRun && raw.stateFile ? new TriageStore(raw.stateFile) : null;

  const days = datesBetween(from, to);
  log('info', 'backfill starting', { from, to, days: days.length, dryRun, source: diary.source });

  let totalEntries = 0;
  let totalCost = 0;
  let failures = 0;

  for (const date of days) {
    try {
      const result = await rollupDay({ date, hub, deepseek, vault, config: diary, log, dryRun });
      totalCost += Number(result.costCny ?? 0);
      totalEntries += result.entries.length;
      store?.setSourceState(`diary-rollup:${date}`, `backfill-${result.status}:${new Date().toISOString()}`);
      log('info', 'day settled', {
        date,
        status: result.status,
        entries: result.entries.length,
        written: result.written,
        reason: result.reason ?? null,
        costCny: result.costCny,
      });
      for (const entry of result.entries) {
        log('info', dryRun ? 'would write' : 'wrote', {
          date,
          time: entry.time,
          text: entry.text,
        });
      }
    } catch (error) {
      failures += 1;
      log('error', 'day failed', { date, error: error.message });
    }
  }

  await vault.close();
  store?.close();
  log('info', 'backfill finished', {
    days: days.length,
    entries: totalEntries,
    costCny: Number(totalCost.toFixed(6)),
    failures,
    dryRun,
  });
  return failures ? 1 : 0;
}

process.exitCode = await main();
