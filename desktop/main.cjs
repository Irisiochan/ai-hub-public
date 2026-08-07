// ai-hub desktop shell — Electron main process.
// Hosts the existing gateway (server-dist, ESM) in a utilityProcess bound to
// 127.0.0.1 on a random port with a per-launch session token, then points a
// sandboxed BrowserWindow at it. No nodeIntegration anywhere; the renderer is
// just the same web UI the browser gets.
const { app, BrowserWindow, dialog, utilityProcess } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  const appRoot = app.getAppPath();
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  const logDir = path.join(userData, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'gateway.log');
  const token = crypto.randomBytes(24).toString('hex');

  // Remote mode: %APPDATA%/ai-hub/desktop.json {"remoteUrl": "http://…"}
  // skips the local gateway entirely and wraps an existing hub (e.g. the VPS
  // instance) so desktop and web share one database. No file → local mode.
  let desktopCfg = {};
  try { desktopCfg = JSON.parse(fs.readFileSync(path.join(userData, 'desktop.json'), 'utf8')); } catch {}
  const remoteUrl = typeof desktopCfg.remoteUrl === 'string' && /^https?:\/\//.test(desktopCfg.remoteUrl)
    ? desktopCfg.remoteUrl.replace(/\/$/, '')
    : null;

  /** @type {import('electron').UtilityProcess | null} */
  let server = null;
  /** @type {BrowserWindow | null} */
  let win = null;
  let port = 0;
  let quitting = false;
  let restarts = [];

  const log = (line) => {
    const text = `[${new Date().toISOString()}] ${line}`;
    console.log(text);
    try { fs.appendFileSync(logFile, text + '\n', 'utf8'); } catch {}
  };

  const pickPort = () =>
    new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const chosen = probe.address().port;
        probe.close(() => resolve(chosen));
      });
    });

  const startServer = async () => {
    port = await pickPort();
    const entry = path.join(appRoot, 'server-dist', 'index.js');
    if (!fs.existsSync(entry)) {
      dialog.showErrorBox('ai-hub', `gateway bundle missing: ${entry}\nrun \`npm run prepare:app\` first`);
      app.quit();
      return;
    }
    server = utilityProcess.fork(entry, [], {
      serviceName: 'ai-hub-gateway',
      stdio: 'pipe',
      cwd: appRoot,
      env: {
        ...process.env,
        HUB_PORT: String(port),
        HUB_HOST: '127.0.0.1',
        HUB_TOKEN: token,
        HUB_DATA_DIR: dataDir,
        HUB_WEB_DIST: path.join(appRoot, 'web-dist'),
        HUB_CONFIG: path.join(userData, 'config.json'),
      },
    });
    server.stdout?.on('data', (c) => log(`[gateway] ${String(c).trimEnd()}`));
    server.stderr?.on('data', (c) => log(`[gateway!] ${String(c).trimEnd()}`));
    server.once('exit', (code) => {
      server = null;
      if (quitting) return;
      log(`gateway exited unexpectedly (code=${code})`);
      restarts = restarts.filter((t) => Date.now() - t < 5 * 60_000);
      restarts.push(Date.now());
      if (restarts.length > 5) {
        dialog.showErrorBox('ai-hub', `网关连续崩溃（5 分钟内 ${restarts.length} 次），已停止重试。\n日志：${logFile}`);
        app.quit();
        return;
      }
      setTimeout(() => {
        void startServer().then(() => {
          if (win && !win.isDestroyed()) void win.loadURL(homeUrl());
        });
      }, 1500);
    });
    await waitHealthy();
    log(`gateway ready on 127.0.0.1:${port} (db under ${dataDir})`);
    if (!app.isPackaged) log(`dev url: ${homeUrl()}`);
  };

  const homeUrl = () => remoteUrl ?? `http://127.0.0.1:${port}/?token=${token}`;

  const waitHealthy = async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health?token=${token}`);
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('gateway did not become healthy within 30s');
  };

  const createWindow = () => {
    win = new BrowserWindow({
      width: 1280,
      height: 860,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.on('closed', () => { win = null; });
    void win.loadURL(homeUrl());
  };

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    if (remoteUrl) {
      log(`remote mode → ${remoteUrl} (no local gateway)`);
    } else {
      try {
        await startServer();
      } catch (e) {
        log(`startup failed: ${e.message}`);
        dialog.showErrorBox('ai-hub', `网关启动失败：${e.message}\n日志：${logFile}`);
        app.quit();
        return;
      }
    }
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    quitting = true;
    server?.kill();
  });
}
