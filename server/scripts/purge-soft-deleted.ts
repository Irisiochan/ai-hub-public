/**
 * 一键 purge 过期软删数据。
 *
 *   npx tsx scripts/purge-soft-deleted.ts           # 用默认 hub.db + 默认保留期
 *   npx tsx scripts/purge-soft-deleted.ts --dry-run
 *   HUB_CONFIG=... npx tsx scripts/purge-soft-deleted.ts
 *
 * 环境变量覆盖：
 *   PURGE_MESSAGES_DAYS  默认取 config.purge.messagesRetentionDays
 *   PURGE_JOBS_DAYS
 *   PURGE_BATCH
 */
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { SoftDeletePurge } from '../src/purge.js';

const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');
const config = loadConfig();
const messagesDays = Number(process.env.PURGE_MESSAGES_DAYS ?? config.purge.messagesRetentionDays);
const jobsDays = Number(process.env.PURGE_JOBS_DAYS ?? config.purge.jobsRetentionDays);
const batchSize = Number(process.env.PURGE_BATCH ?? config.purge.batchSize);

const db = openDb(config.dbPath);
const purge = new SoftDeletePurge(
  db,
  config.uploadsDir,
  {
    enabled: true,
    messagesRetentionDays: messagesDays,
    jobsRetentionDays: jobsDays,
    intervalHours: config.purge.intervalHours,
    batchSize,
  },
  (m) => console.log(`  ${m}`)
);

console.log(`db: ${config.dbPath}`);
console.log(`uploads: ${config.uploadsDir}`);
console.log(`retention: messages=${messagesDays}d jobs=${jobsDays}d batch=${batchSize}`);
console.log(`mode: ${dryRun ? 'dry-run' : 'apply'}`);
console.log('status before:', purge.status());

try {
  const result = await purge.runOnce({ dryRun });
  console.log('result:', result);
  console.log('status after:', purge.status());
} finally {
  db.close();
}
