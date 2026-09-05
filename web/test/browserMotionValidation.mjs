import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findChrome, launchChromeCdp } from '../visual-regression/cdp.mjs';

const root = path.resolve(import.meta.dirname, '..');
const chrome = findChrome();
if (!chrome) throw new Error('Chrome is required for the motion performance validation');
const port = 4179;
const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', (chunk) => { viteLog += chunk; });
vite.stderr.on('data', (chunk) => { viteLog += chunk; });
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/visual-regression/fixture.html`)).ok) break;
  } catch {}
  if (attempt === 79) throw new Error(`Vite did not start:\n${viteLog}`);
  await delay(100);
}

const profile = path.join(tmpdir(), `ai-hub-motion-validation-${process.pid}`);
let browser;
try {
  browser = await launchChromeCdp(chrome, profile);
  const settingsPage = await browser.page(`http://127.0.0.1:${port}/visual-regression/fixture.html?scenario=themes`, 375, 812);
  const settingsMarkup = `<section class="motion-sound-card"><div class="motion-sound-head"><span><strong>动效与声音</strong><small>当前动效：完整 · 用户设置覆盖主题</small></span></div><div class="preference-group"><span class="preference-label">动画等级</span><div class="motion-level"><button>关闭</button><button>低动效</button><button class="selected">完整</button></div></div><div class="switch-row accent"><span><b>声音总开关</b><small>内置 Web Audio 合成音效，不含第三方音频资产。</small></span><button class="switch on"><span class="switch-knob"></span></button></div><div class="sound-cue-grid">${['发送', '回复完成', 'Worker 完成', '错误'].map((label) => `<div class="switch-row sub"><span><b>${label}</b><small>每个语义事件只提示一次</small></span><button class="switch on"><span class="switch-knob"></span></button></div>`).join('')}</div><div class="sound-volume-row"><label>音量</label><input type="range" value="45"><output>45%</output><button class="ghost-btn sound-preview">试听</button></div></section>`;
  await settingsPage.evaluate(`document.querySelector('.modal-body').insertAdjacentHTML('beforeend', ${JSON.stringify(settingsMarkup)})`);
  const layout = (await settingsPage.evaluate(`(() => {
    const card = document.querySelector('.motion-sound-card').getBoundingClientRect();
    return {
      viewport: innerWidth,
      pageOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      cardLeft: card.left,
      cardRight: card.right,
      previewWidth: document.querySelector('.sound-preview').getBoundingClientRect().width,
    };
  })()`)).result.value;
  if (layout.pageOverflow !== 0 || layout.cardLeft < 0 || layout.cardRight > 375) {
    throw new Error(`375px settings overflow: ${JSON.stringify(layout)}`);
  }
  await settingsPage.close();

  const streamPage = await browser.page(`http://127.0.0.1:${port}/visual-regression/fixture.html?scenario=group`, 1280, 900);
  await streamPage.evaluate(`document.querySelector('head style')?.remove(); document.querySelector('.chat-pane').dataset.motionState = 'enter'`);
  const motionModes = {};
  for (const level of ['full', 'reduced', 'off']) {
    motionModes[level] = (await streamPage.evaluate(`(() => {
      document.documentElement.dataset.motionLevel = '${level}';
      void document.documentElement.offsetWidth;
      const pane = getComputedStyle(document.querySelector('.chat-pane'));
      const send = getComputedStyle(document.querySelector('.send-btn'));
      return {
        animationName: pane.animationName,
        animationDuration: pane.animationDuration,
        transitionProperty: send.transitionProperty,
        transitionDuration: send.transitionDuration,
      };
    })()`)).result.value;
  }
  if (motionModes.full.animationName !== 'contact-enter'
    || motionModes.reduced.animationName !== 'fade-enter'
    || motionModes.reduced.transitionProperty !== 'opacity'
    || motionModes.off.animationDuration !== '0s'
    || motionModes.off.transitionDuration !== '0s') {
    throw new Error(`motion level mismatch: ${JSON.stringify(motionModes)}`);
  }
  await streamPage.evaluate(`document.documentElement.dataset.motionLevel = 'full'`);
  await delay(350);
  const beforeMetrics = await streamPage.metrics();
  const beforeAnimations = (await streamPage.evaluate(`document.getAnimations().map((item) => item.animationName).sort()`)).result.value;
  await streamPage.evaluate(`new Promise((resolve) => {
    const target = document.querySelector('.assistant-turn-cluster .markdown p');
    let frame = 0;
    const append = () => {
      target.textContent += 'x'.repeat(50);
      frame += 1;
      if (frame === 20) resolve(true);
      else requestAnimationFrame(append);
    };
    requestAnimationFrame(append);
  })`);
  await delay(50);
  const afterMetrics = await streamPage.metrics();
  const afterAnimations = (await streamPage.evaluate(`document.getAnimations().map((item) => item.animationName).sort()`)).result.value;
  await streamPage.close();
  if (JSON.stringify(beforeAnimations) !== JSON.stringify(afterAnimations)) {
    throw new Error(`delta-like text updates changed CSS animations: ${JSON.stringify({ beforeAnimations, afterAnimations })}`);
  }
  const metricMap = (result) => Object.fromEntries(result.metrics.map((metric) => [metric.name, metric.value]));
  const before = metricMap(beforeMetrics);
  const after = metricMap(afterMetrics);
  console.log(JSON.stringify({
    settings375: layout,
    motionModes,
    streamPerformance: {
      frames: 20,
      layoutCountDelta: after.LayoutCount - before.LayoutCount,
      recalcStyleCountDelta: after.RecalcStyleCount - before.RecalcStyleCount,
      cssAnimationsBefore: beforeAnimations,
      cssAnimationsAfter: afterAnimations,
      newCssAnimations: 0,
    },
  }));
} finally {
  if (browser) await browser.close();
  vite.kill();
  if (existsSync(profile)) rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
