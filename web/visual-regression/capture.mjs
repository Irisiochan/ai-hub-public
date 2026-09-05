import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { findChrome, launchChromeCdp } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputArg = process.argv.find((arg) => arg.startsWith('--output='));
if (!outputArg) throw new Error('Usage: node visual-regression/capture.mjs --output=<directory>');
const output = path.resolve(root, outputArg.slice('--output='.length));
const theme = process.argv.find((arg) => arg.startsWith('--theme='))?.slice('--theme='.length) ?? 'violet-purple';
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) ?? 'dark';
mkdirSync(output, { recursive: true });

const chrome = findChrome();
if (!chrome) throw new Error('Chrome not found. Set CHROME_PATH to a Chrome/Chromium executable.');
const port = 4178;
const viteBin = path.join(root, 'node_modules/vite/bin/vite.js');
if (!existsSync(viteBin)) throw new Error('web/node_modules is missing; run npm ci in web first.');
const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', (chunk) => { viteLog += chunk; });
vite.stderr.on('data', (chunk) => { viteLog += chunk; });
const waitForVite = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/visual-regression/fixture.html`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not start:\n${viteLog}`);
};

const matrix = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 375, height: 812 },
];
const scenarios = ['contacts', 'private', 'group', 'worker', 'themes'];
const profile = path.join(tmpdir(), `ai-hub-visual-${process.pid}`);
let browser;

try {
  await waitForVite();
  browser = await launchChromeCdp(chrome, profile);
  for (const viewport of matrix) {
    for (const scenario of scenarios) {
      const filename = `${scenario}-${viewport.name}.png`;
      const screenshot = path.join(output, filename);
      const url = `http://127.0.0.1:${port}/visual-regression/fixture.html?scenario=${scenario}&theme=${encodeURIComponent(theme)}&mode=${encodeURIComponent(mode)}`;
      const page = await browser.page(url, viewport.width, viewport.height);
      try {
        const metrics = await page.evaluate(`({ width: innerWidth, height: innerHeight, ready: document.documentElement.dataset.visualReady })`);
        if (metrics.result?.value?.width !== viewport.width || metrics.result?.value?.height !== viewport.height) {
          throw new Error(`${filename}: expected ${viewport.width}x${viewport.height} CSS px, got ${JSON.stringify(metrics.result?.value)}`);
        }
        const result = await page.capture();
        writeFileSync(screenshot, Buffer.from(result.data, 'base64'));
      } finally {
        await page.close();
      }
      console.log(`captured ${filename} at ${viewport.width}x${viewport.height} CSS px`);
    }
  }
} finally {
  if (browser) await browser.close();
  vite.kill();
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
