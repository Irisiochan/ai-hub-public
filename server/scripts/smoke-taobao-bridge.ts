/**
 * Smoke test: Taobao desktop-client bridge inside the companion heartbeat.
 * Covers the static tool catalog + mode filter, per-contact config defaults,
 * the tick prompt, the gateway bridge broker, the tool gates (heartbeat window,
 * worker online, browse-mode click guard), and the HTTP round trip
 * hub-mcp → /worker/claim → /worker/taobao/:id → MCP result.
 * Run with: npx tsx scripts/smoke-taobao-bridge.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HEARTBEAT_GUIDANCE } from '../src/agents/cameraTool.js';
import { CompanionHeartbeat, heartbeatPrompt } from '../src/agents/companionHeartbeat.js';
import { contactConfig } from '../src/agents/configSchemas.js';
import {
  TAOBAO_INPUT_SHAPES,
  TAOBAO_TOOL_CATALOG,
  buildTaobaoTools,
  flattenTaobaoContent,
  taobaoGuidance,
  taobaoModeFor,
  taobaoToolNames,
} from '../src/agents/taobaoTools.js';
import type { ContactRow } from '../src/db.js';
import { openDb } from '../src/db.js';
import { hubMcpRouter } from '../src/routes/hubMcp.js';
import { workersRouter } from '../src/routes/workers.js';
import { CameraSnapBroker } from '../src/workers/cameraSnap.js';
import { JobStore } from '../src/workers/jobStore.js';
import { TaobaoBridge } from '../src/workers/taobaoBridge.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-taobao-smoke-'));
const dbPath = path.join(dir, 'data', 'hub.db');
const db = openDb(dbPath);
const sse = { broadcast() {} } as any;
const broker = new CameraSnapBroker();
const taobao = new TaobaoBridge();
const heartbeat = new CompanionHeartbeat({
  db, sse, manager: { statusOf: () => ({ state: 'idle' }) } as any, broker, taobao, config: { dbPath, uploadsDir: path.join(dir, 'uploads') } as any,
});

const insertContact = (id: string, backend: string, config: Record<string, unknown>) => db.prepare(
  `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
   VALUES (?, ?, '🤖', '#888', ?, 'dm', ?, 0)`
).run(id, id, backend, JSON.stringify(config));
const contactRow = (id: string) => db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
// Taobao replies are double-wrapped: content[0].text is itself an MCP result document.
const wrapped = (inner: unknown) => [{
  type: 'text',
  text: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(inner) }] }),
}];
let server: http.Server | null = null;

try {
  // ── catalog + mode filter ──
  assert.equal(TAOBAO_TOOL_CATALOG.length, 22, 'catalog mirrors taobao-native-mcp 1.0.0 (22 tools)');
  assert.equal(new Set(TAOBAO_TOOL_CATALOG.map((t) => t.name)).size, 22, 'catalog names are unique');
  for (const entry of TAOBAO_TOOL_CATALOG) {
    assert.ok(TAOBAO_INPUT_SHAPES[`taobao_${entry.name}`], `zod shape exists for ${entry.name}`);
    assert.equal('sourceApp' in entry.properties, false, 'sourceApp is injected by the gateway, never exposed');
  }
  const browse = taobaoToolNames('browse');
  const cart = taobaoToolNames('cart');
  const full = taobaoToolNames('full');
  assert.equal(browse.length, 13);
  assert.equal(cart.length, 14);
  assert.equal(full.length, 22);
  for (const blocked of ['taobao_add_to_cart', 'taobao_input_text', 'taobao_open_chat', 'taobao_send_chat_message', 'taobao_submit_product_rating']) {
    assert.equal(browse.includes(blocked), false, `browse mode never offers ${blocked}`);
  }
  assert.ok(cart.includes('taobao_add_to_cart'));
  assert.equal(cart.includes('taobao_open_chat'), false, 'cart mode still cannot message merchants');
  const addToCartEntry = TAOBAO_TOOL_CATALOG.find((entry) => entry.name === 'add_to_cart');
  assert.match(addToCartEntry!.description, /必须开口告诉她加了什么/);
  for (const name of ['taobao_search_products', 'taobao_navigate_to_url', 'taobao_read_page_content', 'taobao_close_page']) {
    assert.ok(browse.includes(name), `browse offers ${name}`);
  }

  // ── per-contact config defaults ──
  insertContact('claude', 'claude-cli', { heartbeat: { enabled: true, taobao: { mode: 'browse' } } });
  insertContact('defaults', 'claude-cli', { heartbeat: { enabled: true } });
  insertContact('codex', 'codex', { heartbeat: { enabled: true, taobao: { enabled: false } } });
  insertContact('aye', 'grok-cli', { heartbeat: { enabled: true, taobao: { mode: 'full' } } });
  insertContact('quiet', 'claude-cli', { heartbeat: { enabled: false, taobao: { mode: 'full' } } });
  insertContact('odd', 'claude-cli', { heartbeat: { enabled: true, taobao: { mode: 'bogus' } } });
  const chengCfg = contactConfig(contactRow('claude'));
  assert.deepEqual(
    { enabled: chengCfg.heartbeat.taobao.enabled, mode: chengCfg.heartbeat.taobao.mode },
    { enabled: true, mode: 'browse' },
    'an explicit browse mode still wins',
  );
  assert.equal(taobaoModeFor(chengCfg), 'browse');
  const defaultCfg = contactConfig(contactRow('defaults'));
  assert.deepEqual(
    { enabled: defaultCfg.heartbeat.taobao.enabled, mode: defaultCfg.heartbeat.taobao.mode },
    { enabled: true, mode: 'cart' },
    'CLI contacts default to cart-mode Taobao inside the heartbeat',
  );
  assert.equal(taobaoModeFor(defaultCfg), 'cart');
  assert.equal(taobaoModeFor(contactConfig(contactRow('codex'))), null, 'taobao.enabled=false hides the tools');
  assert.equal(taobaoModeFor(contactConfig(contactRow('aye'))), 'full');
  assert.equal(taobaoModeFor(contactConfig(contactRow('quiet'))), null, 'heartbeat off means no Taobao either');
  // parseStoredContactConfig falls back to schema defaults on any invalid field, so a bad mode fails closed.
  assert.equal(taobaoModeFor(contactConfig(contactRow('odd'))), null, 'an unknown stored mode fails closed, never widens');

  // ── tick prompt ──
  const plainPrompt = heartbeatPrompt(1, 30);
  assert.equal(plainPrompt.includes('淘宝'), false, 'no Taobao line when the bridge is not offered');
  const browsePrompt = heartbeatPrompt(2, null, { taobaoMode: 'browse' });
  assert.match(browsePrompt, /taobao_search_products/);
  assert.match(browsePrompt, /只逛不买：不加购、不下单、不给商家发消息/);
  assert.match(browsePrompt, /看摄像头、逛淘宝、两样都做或都不做，全由你这一轮自己决定/);
  assert.match(browsePrompt, /camera_snap/, 'camera stays available alongside Taobao');
  assert.equal(browsePrompt.includes('必须开口'), false, 'browse may stay silent after looking');
  const cartPrompt = heartbeatPrompt(3, 5, { taobaoMode: 'cart' });
  assert.match(cartPrompt, /可以加购物车，但不下单/);
  assert.match(cartPrompt, /一旦加了购物车，必须开口告诉她加了什么/);
  assert.match(cartPrompt, /不能只回 HEARTBEAT_OK/);
  const fullPrompt = heartbeatPrompt(3, 5, { taobaoMode: 'full' });
  assert.match(fullPrompt, /付款永远由她本人完成/);
  assert.match(fullPrompt, /一旦加了购物车或给商家发了消息，必须开口告诉她/);
  assert.match(taobaoGuidance('cart'), /加了购物车必须开口告诉她加了什么/);
  assert.match(taobaoGuidance('browse'), /只看不动手/);
  assert.equal(taobaoGuidance('browse').includes('必须开口'), false);
  assert.match(HEARTBEAT_GUIDANCE, /一旦调用了 taobao_add_to_cart，必须开口告诉她加了什么/);

  // ── bridge broker ──
  assert.equal(taobao.takePending({ taobao: true }), null);
  const pendingResult = taobao.request('claude', 'get_current_tab', { sourceApp: 'ai-hub' }, 5_000);
  assert.equal(taobao.takePending({ camera: true }), null, 'a worker without the taobao capability never sees the request');
  assert.match((await taobao.request('claude', 'search_products', {}, 1_000)).text, /上一条淘宝操作还没返回/);
  const claimed = taobao.takePending({ taobao: true });
  assert.ok(claimed);
  assert.equal(claimed!.name, 'get_current_tab');
  assert.deepEqual(claimed!.arguments, { sourceApp: 'ai-hub' });
  assert.equal(taobao.takePending({ taobao: true }), null, 'claimed request is not handed out twice');
  assert.equal(taobao.fulfill(claimed!.id, { content: wrapped({ url: 'x', title: '首页' }), isError: false }), true);
  const fulfilled = await pendingResult;
  assert.equal(fulfilled.ok, true);
  assert.equal(fulfilled.isError, false);
  assert.equal(taobao.fulfill(claimed!.id, { content: [] }), false, 'late fulfill maps to HTTP 410 semantics');

  const failing = taobao.request('claude', 'navigate', { page: 'cart' }, 5_000);
  const failId = taobao.takePending({ taobao: true })!.id;
  assert.equal(taobao.fail(failId, 'taobao MCP unreachable'), true);
  assert.match((await failing).text, /淘宝操作失败：taobao MCP unreachable/);

  const timingOut = taobao.request('claude', 'navigate', { page: 'cart' }, 10);
  const keepTimeoutAlive = setTimeout(() => {}, 100); // bridge timers are unref'd
  assert.equal((await timingOut).ok, false);
  clearTimeout(keepTimeoutAlive);
  assert.equal(taobao.pendingCount(), 0, 'timed-out request is dropped');

  for (const contact of ['a', 'b', 'c', 'd']) void taobao.request(contact, 'x', {}, 200);
  assert.match((await taobao.request('e', 'x', {}, 200)).text, /排队已满/);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(taobao.pendingCount(), 0);

  // ── result flattening ──
  assert.equal(flattenTaobaoContent(wrapped({ url: 'u', title: 't' })), JSON.stringify({ url: 'u', title: 't' }));
  assert.equal(flattenTaobaoContent([{ type: 'text', text: 'plain' }]), 'plain');
  assert.match(flattenTaobaoContent([{ type: 'text', text: 'x'.repeat(30_000) }]), /淘宝返回已截断/);

  // ── tool gates ──
  const browseTools = buildTaobaoTools(taobao, heartbeat, db, 'claude', 'browse');
  assert.deepEqual(browseTools.map((t) => t.name), browse);
  const currentTab = browseTools.find((t) => t.name === 'taobao_get_current_tab')!;
  const click = browseTools.find((t) => t.name === 'taobao_click_element')!;
  let out = await currentTab.exec({});
  assert.match(out.text, /心跳窗口未激活/);
  assert.match(out.text, /不要用别的工具或命令绕过。$/);

  heartbeat.startSession('claude', 30);
  out = await currentTab.exec({});
  assert.match(out.text, /没有在线且开放淘宝桥接的 PC Worker/);

  const workerToken = 'taobao-worker.secret';
  db.prepare(
    `INSERT INTO workers (id, name, token_hash, capabilities, status, accepting_jobs, boot_id, last_seen_at)
     VALUES ('taobao-worker', 'PC', ?, '{"taobao":true}', 'online', 1, 'boot', datetime('now'))`
  ).run(crypto.createHash('sha256').update(workerToken).digest('hex'));

  out = await click.exec({ text: '立即购买' });
  assert.match(out.text, /browse 模式下不点「立即购买」/);
  assert.equal(taobao.pendingCount(), 0, 'guarded click never reaches the bridge');
  out = await click.exec({ text: '提交订单' });
  assert.equal(out.ok, false);

  const spoofedTab = await currentTab.exec({ sourceApp: 'spoofed' });
  assert.equal(spoofedTab.ok, false, 'hidden sourceApp cannot be supplied by the caller');
  assert.equal(taobao.pendingCount(), 0, 'invalid arguments never reach the PC Worker');
  const tabPromise = currentTab.exec({});
  await flush();
  const tabRequest = taobao.takePending({ taobao: true });
  assert.ok(tabRequest);
  assert.deepEqual(tabRequest!.arguments, { sourceApp: 'ai-hub' }, 'gateway pins sourceApp regardless of model input');
  taobao.fulfill(tabRequest!.id, { content: wrapped({ url: 'https://taobao.com', title: '首页' }) });
  out = await tabPromise;
  assert.equal(out.ok, true);
  assert.equal(out.text, JSON.stringify({ url: 'https://taobao.com', title: '首页' }));

  const fullTools = buildTaobaoTools(taobao, heartbeat, db, 'claude', 'full');
  const addToCart = fullTools.find((t) => t.name === 'taobao_add_to_cart')!;
  out = await addToCart.exec({ itemId: '1' });
  assert.match(out.text, /taobao_add_to_cart 在 browse 模式下不可用/, 'the stored contact policy wins over the mode the tool was built with');
  heartbeat.stopSession('claude', 'manual');

  // ── HTTP round trip: hub-mcp → claim → worker result ──
  const jobs = new JobStore(db, sse);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', workersRouter(db, sse, jobs, undefined, broker, taobao));
  app.use('/api', hubMcpRouter(db, jobs, {}, { broker, heartbeat, taobao }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api`;
  const workerHeaders = { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' };

  const mcpFor = async (contactId: string) => {
    const client = new Client({ name: 'taobao-smoke', version: '0.0.1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/hub-mcp/${contactId}`)));
    return client;
  };
  const codex = await mcpFor('codex');
  assert.deepEqual((await codex.listTools()).tools.map((t) => t.name), ['camera_snap'], 'taobao.enabled=false lists camera only');
  await codex.close();
  const aye = await mcpFor('aye');
  assert.equal((await aye.listTools()).tools.length, 1 + 22, 'full mode lists every Taobao tool');
  await aye.close();

  const claude = await mcpFor('claude');
  const listed = (await claude.listTools()).tools;
  assert.deepEqual(listed.map((t) => t.name), ['camera_snap', ...browse], 'browse contact lists camera + browse tools');
  const searchTool = listed.find((t) => t.name === 'taobao_search_products')!;
  assert.deepEqual(searchTool.inputSchema.required, ['keyword']);
  assert.equal('sourceApp' in (searchTool.inputSchema.properties as Record<string, unknown>), false);

  heartbeat.startSession('claude', 30);
  const searchPromise = claude.callTool({ name: 'taobao_search_products', arguments: { keyword: '猫粮' } });
  let claim: any = null;
  for (let attempt = 0; attempt < 50 && !claim?.taobaoRequest; attempt++) {
    claim = await (await fetch(`${base}/worker/claim?wait=0`, { headers: workerHeaders })).json();
    if (!claim.taobaoRequest) await flush();
  }
  assert.ok(claim?.taobaoRequest, 'worker claim loop receives the taobao request');
  assert.equal(claim.taobaoRequest.name, 'search_products');
  assert.deepEqual(claim.taobaoRequest.arguments, { keyword: '猫粮', sourceApp: 'ai-hub' });
  assert.ok(claim.taobaoRequest.timeoutMs <= 45_000);

  let post = await fetch(`${base}/worker/taobao/${claim.taobaoRequest.id}`, {
    method: 'POST', headers: workerHeaders, body: JSON.stringify({ nonsense: true }),
  });
  assert.equal(post.status, 400, 'malformed worker payload is rejected');
  const malformed = await searchPromise;
  assert.equal(malformed.isError, true);
  assert.match((malformed.content as Array<{ text: string }>)[0].text, /malformed taobao result/);

  const secondPromise = claude.callTool({ name: 'taobao_search_products', arguments: { keyword: '猫粮' } });
  claim = null;
  for (let attempt = 0; attempt < 50 && !claim?.taobaoRequest; attempt++) {
    claim = await (await fetch(`${base}/worker/claim?wait=0`, { headers: workerHeaders })).json();
    if (!claim.taobaoRequest) await flush();
  }
  assert.ok(claim?.taobaoRequest);
  post = await fetch(`${base}/worker/taobao/${claim.taobaoRequest.id}`, {
    method: 'POST',
    headers: workerHeaders,
    body: JSON.stringify({ result: { content: wrapped({ products: [{ title: '猫粮 10kg', price: '199' }] }), isError: false } }),
  });
  assert.equal(post.status, 200);
  const searchResult = await secondPromise;
  assert.equal(searchResult.isError, false);
  assert.deepEqual(searchResult.content, [
    { type: 'text', text: JSON.stringify({ products: [{ title: '猫粮 10kg', price: '199' }] }) },
  ], 'MCP result carries the innermost Taobao payload only');

  post = await fetch(`${base}/worker/taobao/${claim.taobaoRequest.id}`, {
    method: 'POST', headers: workerHeaders, body: JSON.stringify({ error: 'late' }),
  });
  assert.equal(post.status, 410, 'a settled request id is gone');
  post = await fetch(`${base}/worker/taobao/whatever`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'x' }),
  });
  assert.equal(post.status, 401, 'worker token is required to post results');

  const guarded = await claude.callTool({ name: 'taobao_click_element', arguments: { text: '加入购物车' } });
  assert.equal(guarded.isError, true);
  assert.match((guarded.content as Array<{ text: string }>)[0].text, /browse 模式下不点/);
  heartbeat.stopSession('claude', 'manual');
  await claude.close();

  console.log('taobao bridge smoke: ok');
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  heartbeat.stop();
  db.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
