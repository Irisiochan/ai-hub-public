import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const updateScript = fs.readFileSync(
  fileURLToPath(new URL('../../deploy/update.sh', import.meta.url)),
  'utf8'
);

assert.match(
  updateScript,
  /chmod -R a\+rX server\/agents server\/migrations worker shared\/coordination-keys/,
  'runtime-read agents, migrations, worker and shared coordination keys must be readable after deploy with UMask=0077'
);

assert.match(
  updateScript,
  /write_deploy_receipt/,
  'successful one-click deployments must emit a local deployment receipt for delivery reconciliation'
);

// 每条早退路径都要写终止标记：网关的 deployLogRunning 只看「最后一个 start 后面
// 有没有 ok/fail」，缺标记就会把会议室 drain 卡到 30 分钟 stale 阈值（2026-09-16 实测）。
assert.match(
  updateScript,
  /trap on_exit EXIT/,
  'every early exit must emit a deploy terminator marker so the gateway releases the room drain',
);
assert.match(
  updateScript,
  /== deploy fail \(aborted before rollout, exit \$code\) ==/,
  'the exit trap must write a fail marker the gateway can recognise',
);

console.log('deploy runtime input permission check passed');
