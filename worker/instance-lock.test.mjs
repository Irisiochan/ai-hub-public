import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireInstanceLock } from './instance-lock.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function tempLockPath(dir) {
  return path.join(dir, 'worker-state.json.instance.lock');
}

test('acquire is exclusive while held and reusable after release', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-lock-'));
  try {
    const lockPath = tempLockPath(dir);
    const first = acquireInstanceLock(lockPath);
    assert.equal(first.acquired, true);
    const second = acquireInstanceLock(lockPath);
    assert.equal(second.acquired, false, '持有期间第二个获取必须失败');
    assert.equal(second.holder.pid, process.pid);
    assert.equal(first.refresh(), true, '持有者心跳必须成功');
    first.release();
    assert.equal(fs.existsSync(lockPath), false);
    const third = acquireInstanceLock(lockPath);
    assert.equal(third.acquired, true, '释放后必须可重新获取');
    third.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('crash leftovers are reclaimed immediately when the holder pid is dead', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-lock-crash-'));
  try {
    const lockPath = tempLockPath(dir);
    // 异常退出残留：心跳还新鲜，但 pid 已死 → 立即接管，不用等租约
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999_999_999,
      nonce: 'dead-holder',
      startedAt: new Date().toISOString(),
      heartbeatAt: Date.now(),
      leaseMs: 60_000,
    }));
    const lock = acquireInstanceLock(lockPath, { isAlive: () => false });
    assert.equal(lock.acquired, true, '死进程残留必须被立即接管');
    lock.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pid reuse cannot hold the lock forever: stale heartbeat beats a live pid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-lock-reuse-'));
  try {
    const lockPath = tempLockPath(dir);
    // PID 复用：pid 指向一个确定存活的进程（本测试进程），但那不是 worker，
    // 永远不会刷心跳 → 租约过期后必须允许接管
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      nonce: 'reused-pid',
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      heartbeatAt: Date.now() - 3_600_000,
      leaseMs: 60_000,
    }));
    const lock = acquireInstanceLock(lockPath);
    assert.equal(lock.acquired, true, '存活但不刷心跳的 pid 不得永久占锁');
    lock.release();

    // 对照：心跳新鲜 + pid 存活 = 真持有者，必须拒绝
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      nonce: 'live-holder',
      startedAt: new Date().toISOString(),
      heartbeatAt: Date.now(),
      leaseMs: 60_000,
    }));
    const refused = acquireInstanceLock(lockPath);
    assert.equal(refused.acquired, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy pid-only records and corrupt files behave sanely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-lock-legacy-'));
  try {
    const lockPath = tempLockPath(dir);
    // 旧格式（无心跳）：pid 存活 → 拒绝
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: 'legacy' }));
    assert.equal(acquireInstanceLock(lockPath).acquired, false);
    // 旧格式：pid 已死 → 接管
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, startedAt: 'legacy' }));
    const takeover = acquireInstanceLock(lockPath, { isAlive: () => false });
    assert.equal(takeover.acquired, true);
    takeover.release();
    // 损坏文件 → 接管
    fs.writeFileSync(lockPath, 'not json at all');
    const corrupt = acquireInstanceLock(lockPath);
    assert.equal(corrupt.acquired, true);
    corrupt.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a holder detects takeover via refresh and must stand down', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-lock-takeover-'));
  try {
    const lockPath = tempLockPath(dir);
    const original = acquireInstanceLock(lockPath);
    assert.equal(original.acquired, true);
    // 模拟：租约过期后另一进程接管（覆盖成别人的 nonce）
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid + 1,
      nonce: 'foreign-nonce',
      startedAt: new Date().toISOString(),
      heartbeatAt: Date.now(),
      leaseMs: 60_000,
    }));
    assert.equal(original.refresh(), false, '被接管后 refresh 必须返回 false');
    original.release();
    assert.equal(fs.existsSync(lockPath), true, 'release 不得删除别人的锁');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two concurrent real processes: exactly one acquires', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-lock-race-'));
  try {
    const lockPath = tempLockPath(dir);
    const script = [
      `import { acquireInstanceLock } from ${JSON.stringify(new URL('instance-lock.mjs', `file://${moduleDir.replaceAll('\\', '/')}/`).href)};`,
      `const lock = acquireInstanceLock(${JSON.stringify(lockPath)});`,
      'if (!lock.acquired) process.exit(3);',
      // 持有一段时间再退出，保证两个进程的获取窗口重叠
      'setTimeout(() => { lock.release(); process.exit(0); }, 700);',
    ].join('\n');
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: moduleDir,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => resolve({ code, stderr }));
    });
    const [first, second] = await Promise.all([run(), run()]);
    const codes = [first.code, second.code].sort();
    assert.deepEqual(codes, [0, 3], `并发获取必须恰好一胜一败：${JSON.stringify([first, second])}`);
    assert.equal(fs.existsSync(lockPath), false, '胜者退出后锁必须被释放');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
