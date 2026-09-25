import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveListenHosts } from '../src/platform/config.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-config-test-'));
const configPath = path.join(tempDir, 'config.json');
const previousHubConfig = process.env.HUB_CONFIG;
const previousHubDataDir = process.env.HUB_DATA_DIR;

try {
  // 生产 config.json 里仍留着已删除的 turnTimeoutMs：未知键必须被忽略而不是让加载炸掉。
  fs.writeFileSync(configPath, JSON.stringify({
    claude: { turnTimeoutMs: 300_000 },
  }));
  process.env.HUB_CONFIG = configPath;
  process.env.HUB_DATA_DIR = tempDir;

  const config = loadConfig();
  assert.deepEqual(
    {
      idleTimeoutMs: config.claude.turnIdleTimeoutMs,
      hardTimeoutMs: config.claude.turnHardTimeoutMs,
    },
    { idleTimeoutMs: 300_000, hardTimeoutMs: 900_000 },
  );
  assert.equal(config.opencode.turnIdleTimeoutMs, 300_000);
  assert.equal(config.opencode.turnHardTimeoutMs, 900_000);
  assert.equal(config.kimi.cliPath, 'kimi');
  assert.equal(config.kimi.turnIdleTimeoutMs, 300_000);
  assert.equal(config.kimi.turnHardTimeoutMs, 900_000);
  assert.equal(
    (config.claude as unknown as Record<string, unknown>).turnTimeoutMs,
    300_000,
    '未知键原样带过即可，但不许参与任何超时计算',
  );
  // backend=api 的硬截止独立于 CLI 两段计时，不再借用 claude 段
  assert.equal(config.api.turnTimeoutMs, 300_000);
} finally {
  if (previousHubConfig === undefined) delete process.env.HUB_CONFIG;
  else process.env.HUB_CONFIG = previousHubConfig;
  if (previousHubDataDir === undefined) delete process.env.HUB_DATA_DIR;
  else process.env.HUB_DATA_DIR = previousHubDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// 网关绑在 tailnet 地址时，同机客户端（vps-dev worker、收口脚本、curl）
// 仍必须能走 127.0.0.1，否则本机进程反过来依赖 tailnet 在线。
assert.deepEqual(
  resolveListenHosts({ host: '100.64.0.10', extraHosts: [] }),
  ['100.64.0.10', '127.0.0.1'],
  '非回环单播地址必须自动补一个回环监听',
);
// 通配与回环本身已经覆盖回环，不重复绑（重复绑同端口会 EADDRINUSE）。
assert.deepEqual(resolveListenHosts({ host: '0.0.0.0', extraHosts: [] }), ['0.0.0.0']);
assert.deepEqual(resolveListenHosts({ host: '::', extraHosts: [] }), ['::']);
assert.deepEqual(resolveListenHosts({ host: '127.0.0.1', extraHosts: [] }), ['127.0.0.1']);
assert.deepEqual(resolveListenHosts({ host: 'localhost', extraHosts: [] }), ['localhost']);
// 显式写了回环就不再自动追加；大小写与空白不算新地址。
assert.deepEqual(
  resolveListenHosts({ host: '100.64.0.10', extraHosts: [' 127.0.0.1 ', '192.168.1.5'] }),
  ['100.64.0.10', '127.0.0.1', '192.168.1.5'],
);
assert.deepEqual(resolveListenHosts({ host: '', extraHosts: [] }), ['']);

{
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-config-hosts-'));
  const hostConfig = path.join(hostDir, 'config.json');
  const prevConfig = process.env.HUB_CONFIG;
  const prevDataDir = process.env.HUB_DATA_DIR;
  const prevExtraHosts = process.env.HUB_EXTRA_HOSTS;
  try {
    fs.writeFileSync(hostConfig, JSON.stringify({ host: '100.64.0.10', extraHosts: ['192.168.1.5', ''] }));
    process.env.HUB_CONFIG = hostConfig;
    process.env.HUB_DATA_DIR = hostDir;
    delete process.env.HUB_EXTRA_HOSTS;
    assert.deepEqual(
      resolveListenHosts(loadConfig()),
      ['100.64.0.10', '192.168.1.5', '127.0.0.1'],
      'config.json 的 extraHosts 生效，空串被丢掉',
    );
    process.env.HUB_EXTRA_HOSTS = '10.0.0.2, 10.0.0.3';
    assert.deepEqual(
      resolveListenHosts(loadConfig()),
      ['100.64.0.10', '10.0.0.2', '10.0.0.3', '127.0.0.1'],
      'HUB_EXTRA_HOSTS 覆盖文件配置',
    );
  } finally {
    if (prevConfig === undefined) delete process.env.HUB_CONFIG;
    else process.env.HUB_CONFIG = prevConfig;
    if (prevDataDir === undefined) delete process.env.HUB_DATA_DIR;
    else process.env.HUB_DATA_DIR = prevDataDir;
    if (prevExtraHosts === undefined) delete process.env.HUB_EXTRA_HOSTS;
    else process.env.HUB_EXTRA_HOSTS = prevExtraHosts;
    fs.rmSync(hostDir, { recursive: true, force: true });
  }
}

console.log('config tests: ok');
