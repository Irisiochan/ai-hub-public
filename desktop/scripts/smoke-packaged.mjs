// Post-package startup check: boot the gateway from the packaged
// release/win-unpacked tree with the shipped Electron binary
// (ELECTRON_RUN_AS_NODE, so the native-module ABI matches the app) and
// require /api/health to answer. Catches missing runtime dependencies,
// missing migrations, and broken imports that `electron-builder` alone
// never exercises — it only proves the installer can be generated.
//
//   node scripts/smoke-packaged.mjs            # after `npm run dist`
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unpacked = path.join(desktopRoot, 'release', 'win-unpacked');
const exe = path.join(unpacked, 'ai-hub.exe');
const appRoot = path.join(unpacked, 'resources', 'app');
const entry = path.join(appRoot, 'server-dist', 'index.js');

for (const required of [exe, entry, path.join(appRoot, 'migrations'), path.join(appRoot, 'web-dist')]) {
  if (!fs.existsSync(required)) {
    console.error(`smoke-packaged: missing ${required} — run \`npm run dist\` first`);
    process.exit(1);
  }
}

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const chosen = probe.address().port;
    probe.close(() => resolve(chosen));
  });
});
const token = 'smoke-packaged-token';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-smoke-'));

const child = spawn(exe, [entry], {
  cwd: appRoot,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    HUB_PORT: String(port),
    HUB_HOST: '127.0.0.1',
    HUB_TOKEN: token,
    HUB_DATA_DIR: path.join(dataDir, 'data'),
    HUB_WEB_DIST: path.join(appRoot, 'web-dist'),
    HUB_CONFIG: path.join(dataDir, 'config.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (c) => { output += String(c); });
child.stderr.on('data', (c) => { output += String(c); });
let exited = null;
child.once('exit', (code) => { exited = code ?? -1; });

const fail = (reason) => {
  console.error(`smoke-packaged: ${reason}`);
  console.error(output.slice(-4000));
  child.kill();
  process.exit(1);
};

const deadline = Date.now() + 90_000;
let healthy = false;
while (Date.now() < deadline) {
  if (exited !== null) fail(`gateway exited early (code=${exited})`);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health?token=${token}`);
    if (res.ok) {
      healthy = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
if (!healthy) fail('gateway did not become healthy within 90s');

console.log('smoke-packaged: packaged gateway booted and /api/health ok');
child.kill();
// 清理是尽力而为：Windows 上刚被 kill 的子进程可能仍锁着 sqlite 文件，
// 等退出后带重试删除，删不掉也不影响冒烟结论（临时目录留给系统清理）。
await new Promise((r) => {
  if (exited !== null) return r(undefined);
  child.once('exit', () => r(undefined));
  setTimeout(r, 5000);
});
try {
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {}
process.exit(0);
