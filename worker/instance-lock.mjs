import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * PC Worker 单实例锁。
 *
 * 旧实现是「读锁 → kill(pid,0) → 普通 writeFileSync 覆盖」：两个进程并发启动
 * 可以同时通过检查后各写一遍（TOCTOU），死进程的 PID 被无关进程复用时又会
 * 永远拒绝启动。现在：
 * - 获取 = `open(...,'wx')` 原子创建，OS 保证并发下最多一个赢家；
 * - 记录绑定 pid + 随机 nonce + 心跳时间；持有者周期 refresh 心跳；
 * - 接管条件：持有者 pid 已死（崩溃残留，立即接管），或心跳超过租约
 *   （PID 复用/持有者卡死——kill(0) 存活不算数，心跳才是身份证明）；
 * - 接管 = unlink + 重试 'wx'，并发接管者仍最多一个能赢；赢家复核文件里
 *   是自己的 nonce，真持有者下一次 refresh 发现 nonce 变了返回 false，
 *   调用方据此退出，极端竞态收敛为单实例；
 * - 兼容旧格式（只有 pid 无心跳）：pid 存活即视为持有。
 */

const DEFAULT_LEASE_MS = 60_000;

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readRecord(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

export function acquireInstanceLock(lockPath, {
  pid = process.pid,
  leaseMs = DEFAULT_LEASE_MS,
  now = () => Date.now(),
  isAlive = defaultIsAlive,
} = {}) {
  const nonce = crypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({
          pid,
          nonce,
          startedAt: new Date(now()).toISOString(),
          heartbeatAt: now(),
          leaseMs,
        }));
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readRecord(lockPath);
      if (existing && Number.isInteger(existing.pid)) {
        const heartbeatAt = Number(existing.heartbeatAt ?? 0);
        const existingLease = Number(existing.leaseMs) > 0 ? Number(existing.leaseMs) : leaseMs;
        const held = heartbeatAt > 0
          ? now() - heartbeatAt < existingLease && isAlive(existing.pid)
          : isAlive(existing.pid);
        if (held) return { acquired: false, holder: existing };
      }
      // stale/corrupt：清掉后重试原子创建
      try {
        fs.unlinkSync(lockPath);
      } catch {}
      continue;
    }
    const check = readRecord(lockPath);
    if (check?.nonce !== nonce) return { acquired: false, holder: check };
    return {
      acquired: true,
      nonce,
      /** 心跳；返回 false 表示锁已被接管，调用方必须停止工作并退出。 */
      refresh() {
        const current = readRecord(lockPath);
        if (current?.nonce !== nonce) return false;
        const tmp = `${lockPath}.${nonce.slice(0, 8)}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ ...current, heartbeatAt: now() }), 'utf8');
        fs.renameSync(tmp, lockPath);
        return true;
      },
      release() {
        const current = readRecord(lockPath);
        if (current?.nonce !== nonce) return;
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      },
    };
  }
  return { acquired: false, holder: readRecord(lockPath) };
}
