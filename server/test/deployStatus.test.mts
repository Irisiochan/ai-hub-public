import assert from 'node:assert/strict';
import { deployLogRunning } from '../src/routes/system.js';

const now = Date.parse('2026-08-02T03:16:00Z');
const start = '== deploy start 2026-08-02T03:15:18Z ==';
const ok = '== deploy ok a50f72e 2026-08-02T03:15:43Z ==';

// 部署进行中：开工标记之后只有构建输出，没有收尾标记。
assert.equal(
  deployLogRunning([start, 'npm warn deprecated', '> vite build'].join('\n'), now),
  true,
  'build output after a start marker must read as running'
);

// 收尾之后回到 idle。
assert.equal(deployLogRunning([start, ok].join('\n'), now), false);

// 上一轮已收尾，新一轮又开工。
assert.equal(
  deployLogRunning(
    ['== deploy start 2026-08-02T00:22:00Z ==', '== deploy ok 5cc7c64 2026-08-02T00:22:19Z ==', start].join('\n'),
    now
  ),
  true
);

// 回滚过程中（先打 failed 提示，后打最终 fail 收尾）仍算在跑。
assert.equal(
  deployLogRunning([start, '== deploy failed, rolling back to 5cc7c64 =='].join('\n'), now),
  true
);
assert.equal(
  deployLogRunning(
    [start, '== deploy failed, rolling back to 5cc7c64 ==', '== deploy fail (rolled back to 5cc7c64, service healthy) =='].join('\n'),
    now
  ),
  false
);

// 被掐死、永远等不到收尾标记的部署不能把状态钉死在 running。
assert.equal(deployLogRunning(start, Date.parse('2026-08-02T04:00:00Z')), false);

// 日志窗口被截断，开头是半行时不误判成开工。
assert.equal(deployLogRunning('ploy start 2026-08-02T03:15:18Z ==\nnpm install', now), false);

// 空日志。
assert.equal(deployLogRunning('', now), false);

console.log('deploy status log-marker checks passed');
