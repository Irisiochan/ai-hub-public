import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findChrome, launchChromeCdp } from '../visual-regression/cdp.mjs';

const root = path.resolve(import.meta.dirname, '..');
const chrome = findChrome();
if (!chrome) throw new Error('Chrome is required for workflow UI validation');
const port = 4183;
const artifacts = path.resolve(tmpdir(), `ai-hub-workflow-browser-${process.pid}`);
const profile = path.join(artifacts, 'chrome');
mkdirSync(artifacts, { recursive: true });
const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let viteLog = '';
vite.stdout.on('data', (chunk) => { viteLog += chunk; });
vite.stderr.on('data', (chunk) => { viteLog += chunk; });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let browser;
const report = {};
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/visual-regression/workflow-fixture.html`)).ok) break; } catch {}
    if (attempt === 79) throw new Error(`Vite did not start: ${viteLog}`);
    await delay(100);
  }
  browser = await launchChromeCdp(chrome, profile);
  const page = await browser.page(`http://127.0.0.1:${port}/visual-regression/workflow-fixture.html`, 1280, 900);
  const evaluate = async (expression) => {
    const result = await page.evaluate(expression);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + JSON.stringify(result.exceptionDetails.exception));
    return result.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 60; i++) { if (await evaluate(expression)) return; await delay(50); }
    throw new Error(`UI condition timed out: ${expression}`);
  };
  await evaluate(`Array.from(document.querySelectorAll('.workflow-node')).find(el => el.textContent.includes('独立评审')).click()`);
  await until(`document.querySelector('.workflow-module-editor')?.textContent.includes('Grok 额度已耗尽')`);
  assert.equal(await evaluate(`document.querySelector('.workflow-save').disabled`), true);
  await evaluate(`(() => { const el = document.querySelector('.workflow-binding-fields select'); el.value = 'codex'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`document.querySelector('.workflow-save').disabled === false`);
  await evaluate(`document.querySelector('.workflow-save').click()`);
  await until(`document.querySelector('.workflow-saved')?.textContent.includes('已更新')`);
  const mutation = await evaluate(`workflowFixture.requests.find(item => item.method === 'PATCH')`);
  assert.equal(mutation.body.expectedRevision, 7);
  assert.equal(mutation.url, '/api/workflow-modules/review');
  assert.deepEqual(mutation.body.binding, { contactId: 'codex', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' });
  assert.equal(await evaluate(`document.querySelector('.workflow-module-jobs').textContent.includes('grok-4.6')`), true,
    'changing a binding must not relabel the old task snapshot');
  await evaluate(`(() => { const el = document.querySelectorAll('.workflow-binding-fields select')[2]; el.value = 'ultra'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`document.querySelector('.workflow-save').disabled === false`);
  await evaluate('workflowFixture.bumpRevision()');
  await until(`document.querySelector('.workflow-save').disabled && document.querySelector('.workflow-editor-actions').textContent.includes('载入最新配置')`);
  assert.equal(await evaluate(`document.querySelectorAll('.workflow-binding-fields select')[2].value`), 'ultra',
    'a concurrent change must preserve the visible unsaved draft until explicit reload');
  await evaluate(`Array.from(document.querySelectorAll('.workflow-editor-actions button')).find(el => el.textContent.includes('载入最新配置')).click()`);
  await until(`document.querySelectorAll('.workflow-binding-fields select')[2].value === 'high'`);
  await evaluate(`document.querySelector('.workflow-module-job button').click()`);
  await until(`workflowFixture.requests.some(item => item.method === 'POST')`);
  await until(`document.querySelector('.workflow-module-jobs').textContent.includes('gpt-6-astra')`);
  const takeover = await evaluate(`workflowFixture.requests.filter(item => item.method === 'POST')`);
  assert.equal(takeover.length, 1);
  assert.equal(takeover[0].body.expectedRevision, 9);
  assert.equal(takeover[0].url, '/api/workflow-modules/jobs/review-blocked-1/takeover');
  assert.equal(await evaluate(`document.querySelectorAll('.workflow-reserve-agent.dormant').length > 0
    && document.querySelector('.workflow-reserve-divider')?.textContent === '休眠'`), true);
  assert.equal(await evaluate('workflowFixture.errors()'), 0);
  await evaluate(`document.querySelector('.workflow-worker-button').click()`);
  await until(`document.querySelector('.workflow-worker-picker select')?.options.length === 2`);
  await evaluate(`(() => { const select = document.querySelector('.workflow-worker-picker select');
    select.selectedIndex = 1; select.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.workflow-worker-picker button').click(); })()`);
  await until(`workflowFixture.data().workerTarget?.repoId === 'ai-hub'`);
  assert.equal(await evaluate(`workflowFixture.requests.filter(item => item.url === '/api/workflow-modules/worker-target' && item.method === 'PATCH').length`), 1);
  assert.equal(await evaluate(`workflowFixture.errors()`), 0);
  const shot = await page.capture();
  writeFileSync(path.join(artifacts, 'workflow-desktop.png'), Buffer.from(shot.data, 'base64'));
  report.desktop = { bindingSaved: true, immutableTaskDisplay: true, concurrentEditBlocked: true, takeoverRequests: 1, workerDefaultSaved: true, errors: 0 };
  await page.close();

  for (const theme of ['dark', 'light']) {
    const mobile = await browser.page(`http://127.0.0.1:${port}/visual-regression/workflow-fixture.html?theme=${theme}`, 375, 812);
    await mobile.evaluate(`Array.from(document.querySelectorAll('.workflow-node')).find(el => el.textContent.includes('执行／修复')).click()`);
    await delay(100);
    const result = (await mobile.evaluate(`(() => {
      const panel = document.querySelector('.workflow-board').getBoundingClientRect();
      const selects = Array.from(document.querySelectorAll('.workflow-binding-fields select'));
      return { overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth), left: panel.left, right: panel.right,
        clippedSelects: selects.filter(el => el.getBoundingClientRect().right > innerWidth || el.getBoundingClientRect().left < 0).length,
        clippedHeaderControls: Array.from(document.querySelectorAll('.workflow-board-header button')).filter(el => {
          const rect = el.getBoundingClientRect(); return rect.right > panel.right || rect.left < panel.left;
        }).length,
        efforts: Array.from(selects[2].options).map(el => el.value), errors: workflowFixture.errors() };
    })()`)).result.value;
    assert.equal(result.overflow, 0); assert.ok(result.left >= 0 && result.right <= 375);
    assert.equal(result.clippedSelects, 0); assert.equal(result.errors, 0);
    assert.equal(result.clippedHeaderControls, 0, 'all workflow header actions stay inside the mobile panel');
    assert.deepEqual(result.efforts, ['high', 'max'], 'only supported efforts appear for Muse');
    await mobile.evaluate(`document.querySelector('.workflow-worker-button').click()`);
    for (let attempt = 0; attempt < 40; attempt++) {
      const ready = (await mobile.evaluate(`document.querySelector('.workflow-worker-picker select')?.options.length === 2`)).result.value;
      if (ready) break;
      await delay(50);
    }
    const picker = (await mobile.evaluate(`(() => {
      const panel = document.querySelector('.workflow-board').getBoundingClientRect();
      const select = document.querySelector('.workflow-worker-picker select').getBoundingClientRect();
      return { left: select.left, right: select.right, panelLeft: panel.left, panelRight: panel.right };
    })()`)).result.value;
    assert.ok(picker.left >= picker.panelLeft && picker.right <= picker.panelRight, 'Worker picker fits mobile panel');
    const mobileShot = await mobile.capture();
    writeFileSync(path.join(artifacts, `workflow-mobile-${theme}.png`), Buffer.from(mobileShot.data, 'base64'));
    report[theme] = result;
    await mobile.close();
  }
  console.log(JSON.stringify({ workflowBrowser: report, artifacts }, null, 2));
} finally {
  if (browser) await browser.close();
  vite.kill();
  // Only this test's browser profile is ephemeral; retain verification PNGs.
  if (path.dirname(path.resolve(profile)) !== artifacts || !artifacts.startsWith(path.resolve(tmpdir()) + path.sep)) {
    throw new Error('Refusing cleanup outside this test workspace');
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
}
