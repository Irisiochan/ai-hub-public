import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChromeCdp } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = findChrome();
if (!chrome) throw new Error('Chrome not found');
const port = 4179;
const viteBin = path.join(root, 'node_modules/vite/bin/vite.js');
if (!existsSync(viteBin)) throw new Error('web/node_modules is missing');
const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const waitForVite = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/visual-regression/fixture.html`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Vite did not start');
};
const profile = path.join(tmpdir(), `ai-hub-layout-${process.pid}`);
let browser;

try {
  await waitForVite();
  browser = await launchChromeCdp(chrome, profile);
  for (const scenario of ['contacts', 'private', 'group', 'worker', 'themes']) {
    const page = await browser.page(`http://127.0.0.1:${port}/visual-regression/fixture.html?scenario=${scenario}`, 375, 812);
    try {
      const result = await page.evaluate(`({
        width: innerWidth,
        height: innerHeight,
        pageOverflow: Number(document.documentElement.dataset.pageOverflow),
        messageOverflow: Number(document.documentElement.dataset.messageOverflow),
        messageScrollTop: Number(document.documentElement.dataset.messageScrollTop),
        consoleErrors: Number(document.documentElement.dataset.consoleErrors)
      })`);
      const metrics = result.result?.value;
      if (
        metrics?.width !== 375
        || metrics?.height !== 812
        || metrics?.pageOverflow !== 0
        || metrics?.messageOverflow !== 0
        || metrics?.messageScrollTop !== 0
        || metrics?.consoleErrors !== 0
      ) {
        throw new Error(`${scenario}: ${JSON.stringify(metrics)}`);
      }
      console.log(`${scenario}: true 375px layout has no horizontal overflow or console errors`);
    } finally {
      await page.close();
    }
  }
} finally {
  if (browser) await browser.close();
  vite.kill();
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
