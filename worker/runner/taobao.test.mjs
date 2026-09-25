import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TAOBAO_MCP_URL,
  TaobaoMcpClient,
  handleTaobaoRequest,
  parseMcpResponse,
  taobaoCapabilities,
  taobaoMcpUrl,
} from './taobao.mjs';

const sse = (messages) => messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join('');

function fakeResponse({ status = 200, body = '', contentType = 'application/json', sessionId } = {}) {
  const headers = new Map([['content-type', contentType]]);
  if (sessionId) headers.set('mcp-session-id', sessionId);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => headers.get(key.toLowerCase()) ?? null },
    text: async () => body,
  };
}

test('capabilities and url follow the local config gate', () => {
  assert.deepEqual(taobaoCapabilities({ allowTaobao: false }), {});
  assert.deepEqual(taobaoCapabilities({ allowTaobao: 'true' }), {}, 'only the boolean true opens the gate');
  assert.deepEqual(taobaoCapabilities({ allowTaobao: true }), { taobao: true });
  assert.equal(taobaoMcpUrl({}), DEFAULT_TAOBAO_MCP_URL);
  assert.equal(taobaoMcpUrl({ taobaoMcpUrl: ' http://127.0.0.1:4000/mcp ' }), 'http://127.0.0.1:4000/mcp');
});

test('parseMcpResponse reads SSE frames and plain JSON, surfaces JSON-RPC errors', () => {
  const result = parseMcpResponse(
    'text/event-stream',
    sse([{ jsonrpc: '2.0', id: 9, result: { ok: 1 } }]),
    9,
  );
  assert.deepEqual(result, { ok: 1 });
  assert.deepEqual(
    parseMcpResponse('application/json', JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }), 2),
    { tools: [] },
  );
  assert.throws(
    () => parseMcpResponse('application/json', JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: -32602, message: 'bad args' } }), 3),
    /bad args/,
  );
  assert.throws(() => parseMcpResponse('application/json', JSON.stringify({ id: 4, result: {} }), 5), /reply id=5/);
});

test('client initializes once, reuses the session id, and re-initializes after a lost session', async () => {
  const calls = [];
  let sessionCounter = 0;
  let rejectNextCall = false;
  const fetchFn = async (url, init) => {
    const payload = JSON.parse(init.body);
    calls.push({ url, method: payload.method, session: init.headers['mcp-session-id'] ?? null });
    if (payload.method === 'initialize') {
      sessionCounter += 1;
      return fakeResponse({
        contentType: 'text/event-stream',
        sessionId: `session-${sessionCounter}`,
        body: sse([{ jsonrpc: '2.0', id: payload.id, result: { protocolVersion: '2025-03-26' } }]),
      });
    }
    if (payload.method === 'notifications/initialized') return fakeResponse({ status: 202 });
    if (rejectNextCall) {
      rejectNextCall = false;
      return fakeResponse({ status: 404, body: 'Session not found' });
    }
    return fakeResponse({
      contentType: 'text/event-stream',
      body: sse([{ jsonrpc: '2.0', id: payload.id, result: { content: [{ type: 'text', text: `echo:${payload.params.name}` }] } }]),
    });
  };
  const client = new TaobaoMcpClient('http://localhost:3654/mcp', { fetch: fetchFn });
  const first = await client.callTool('get_current_tab', { sourceApp: 'ai-hub' });
  assert.equal(first.content[0].text, 'echo:get_current_tab');
  assert.deepEqual(calls.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(calls[2].session, 'session-1');

  await client.callTool('search_products', { keyword: 'x', sourceApp: 'ai-hub' });
  assert.equal(calls.length, 4, 'second call reuses the session without re-initializing');
  assert.equal(calls[3].session, 'session-1');

  rejectNextCall = true;
  const third = await client.callTool('get_current_tab', { sourceApp: 'ai-hub' });
  assert.equal(third.content[0].text, 'echo:get_current_tab');
  assert.deepEqual(
    calls.slice(4).map((c) => c.method),
    ['tools/call', 'initialize', 'notifications/initialized', 'tools/call'],
    'a 404 re-initializes exactly once and retries the call',
  );
  assert.equal(calls.at(-1).session, 'session-2');
});

test('allowTaobao false refuses a smuggled request without touching the client', async () => {
  let called = false;
  let posted = false;
  const handled = await handleTaobaoRequest(
    { allowTaobao: false },
    { id: 'req-1', name: 'search_products', arguments: { keyword: 'x' } },
    async () => { posted = true; },
    { callTool: async () => { called = true; return {}; } },
  );
  assert.equal(handled, false);
  assert.equal(called, false);
  assert.equal(posted, false);
});

test('enabled bridge posts bounded content or a bounded error', async () => {
  const posts = [];
  const cfg = { allowTaobao: true };
  const ok = await handleTaobaoRequest(
    cfg,
    { id: 'req-ok', name: 'get_current_tab', arguments: { sourceApp: 'ai-hub' } },
    async (id, payload) => posts.push({ id, payload }),
    { callTool: async (name, args) => {
      assert.equal(name, 'get_current_tab');
      assert.deepEqual(args, { sourceApp: 'ai-hub' });
      return { content: [{ type: 'text', text: 'tab' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] };
    } },
  );
  assert.equal(ok, true);
  assert.deepEqual(posts[0], {
    id: 'req-ok',
    payload: { result: { content: [{ type: 'text', text: 'tab' }, { type: 'text', text: '[image image/png omitted by worker bridge]' }], isError: false } },
  });

  await handleTaobaoRequest(
    cfg,
    { id: 'req-err', name: 'search_products', arguments: {} },
    async (id, payload) => posts.push({ id, payload }),
    { callTool: async () => { throw new Error('x'.repeat(5000)); } },
  );
  assert.equal(posts[1].id, 'req-err');
  assert.equal(posts[1].payload.error.length, 2000);

  assert.equal(await handleTaobaoRequest(cfg, { id: 'no-name' }, async () => {}, { callTool: async () => ({}) }), false);
});
