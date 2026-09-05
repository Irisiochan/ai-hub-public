import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function findChrome() {
  return [
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean).find(existsSync);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result ?? {});
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

export async function launchChromeCdp(chrome, profile) {
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-features=TranslateUI',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--no-first-run',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const activePortFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100 && !existsSync(activePortFile); attempt += 1) await delay(50);
  if (!existsSync(activePortFile)) {
    child.kill();
    throw new Error(`Chrome DevTools did not start:\n${stderr}`);
  }
  const [port, browserPath] = readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
  const socket = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const connection = new CdpConnection(socket);

  return {
    async page(url, width, height) {
      const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
      await connection.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: width,
        screenHeight: height,
      }, sessionId);
      await connection.send('Page.enable', {}, sessionId);
      await connection.send('Runtime.enable', {}, sessionId);
      await connection.send('Performance.enable', {}, sessionId);
      await connection.send('Page.navigate', { url }, sessionId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await connection.send('Runtime.evaluate', {
          expression: "document.documentElement?.dataset.visualReady === 'true'",
          returnByValue: true,
        }, sessionId).catch(() => ({}));
        if (result.result?.value === true) break;
        if (attempt === 99) throw new Error(`Fixture did not become ready: ${url}`);
        await delay(50);
      }
      await delay(100);
      return {
        evaluate: (expression) => connection.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId),
        metrics: () => connection.send('Performance.getMetrics', {}, sessionId),
        capture: () => connection.send('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false,
        }, sessionId),
        close: () => connection.send('Target.closeTarget', { targetId }),
      };
    },
    async close() {
      await connection.send('Browser.close').catch(() => {});
      socket.close();
      for (let attempt = 0; attempt < 40 && child.exitCode === null; attempt += 1) await delay(50);
      if (child.exitCode === null) child.kill();
      for (let attempt = 0; attempt < 20 && child.exitCode === null; attempt += 1) await delay(50);
    },
  };
}
