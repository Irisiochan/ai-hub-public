/**
 * Smoke test: DbBackup 在线备份、integrity 校验、修剪与状态。
 * Run with: npx tsx scripts/smoke-backup.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DbBackup } from '../src/backup.js';
import { openDb } from '../src/db.js';

let failures = 0;
function check(label: string, cond: boolean, detail = '') {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : `  ${detail}`}`);
  if (!cond) failures++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-backup-smoke-'));
const backupDir = path.join(dir, 'backups');
const db = openDb(path.join(dir, 'hub.db'));
db.prepare(
  `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
   VALUES ('c1', '测试', '🧪', '#888', 'api', 'dm', '{}', 0)`
).run();
for (let i = 0; i < 5; i++) {
  db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status)
     VALUES ('c1', 'User', 'user', 'text', ?, 'done')`
  ).run(`msg ${i}`);
}

const noop = () => {};
const backup = new DbBackup(db, { enabled: true, dir: backupDir, intervalHours: 24, keep: 3 }, noop);

// 1. 备份成功 + 快照可读且数据一致
const file = await backup.runOnce();
const snapPath = path.join(backupDir, file);
check('快照文件生成', fs.existsSync(snapPath), snapPath);
{
  const snap = new Database(snapPath, { readonly: true });
  const n = (snap.prepare('SELECT COUNT(*) AS c FROM messages').get() as any).c;
  const integ = (snap.prepare('PRAGMA integrity_check').get() as any).integrity_check;
  snap.close();
  check('快照 5 条消息 + integrity ok', n === 5 && integ === 'ok', `n=${n} integrity=${integ}`);
}

// 2. 备份期间写入不受影响（在线备份），第二份快照包含新数据
db.prepare(
  `INSERT INTO messages (contact_id, sender, role, kind, content, status)
   VALUES ('c1', 'User', 'user', 'text', 'after backup', 'done')`
).run();
await new Promise((r) => setTimeout(r, 1100)); // 时间戳粒度到秒，避免同名
const file2 = await backup.runOnce();
{
  const snap = new Database(path.join(backupDir, file2), { readonly: true });
  const n = (snap.prepare('SELECT COUNT(*) AS c FROM messages').get() as any).c;
  snap.close();
  check('第二份快照含新写入（6 条）', file2 !== file && n === 6, `file2=${file2} n=${n}`);
}

// 3. 修剪：伪造 4 份旧快照，keep=3 → 只留最新 3 份
for (const stamp of ['20260101T000000Z', '20260102T000000Z', '20260103T000000Z', '20260104T000000Z']) {
  fs.copyFileSync(snapPath, path.join(backupDir, `hub-${stamp}.db`));
}
fs.writeFileSync(path.join(backupDir, 'hub-stale.db.tmp'), 'junk');
await new Promise((r) => setTimeout(r, 1100));
const file3 = await backup.runOnce();
{
  const left = fs.readdirSync(backupDir).sort();
  const snaps = left.filter((n) => /^hub-\d{8}T\d{6}Z\.db$/.test(n));
  check(
    'keep=3 修剪 + 清理 .tmp',
    snaps.length === 3 && snaps.includes(file3) && !left.some((n) => n.endsWith('.tmp')),
    left.join(',')
  );
}

// 4. 状态接口
{
  const s = backup.status();
  check(
    'status 报告 ok + 文件列表',
    s.enabled && s.lastResult === 'ok' && s.lastFile === file3 && s.files.length === 3,
    JSON.stringify(s)
  );
}

db.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nsmoke-backup: all pass ✅' : `\nsmoke-backup: ${failures} failure(s) ❌`);
process.exitCode = failures === 0 ? 0 : 1;
