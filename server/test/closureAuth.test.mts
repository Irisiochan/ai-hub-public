import assert from 'node:assert/strict';
import express from 'express';
import { sessionAuth } from '../src/platform/middleware/auth.js';
import {
  CLOSURE_CLIENT_IDS,
  closureBearerMatches,
  closureBearerToken,
  closureScopeAllows,
} from '../src/platform/middleware/closureAuth.js';

const HUB_TOKEN = 'test-hub-token-0123456789abcdef0123456789abcdef';
const VPS_TOKEN = closureBearerToken(HUB_TOKEN, 'vps-dev');

// ── 派生与匹配 ──
assert.equal(CLOSURE_CLIENT_IDS.includes('vps-dev' as never), true);
assert.notEqual(VPS_TOKEN, HUB_TOKEN, '派生 token 不得等于 HUB_TOKEN 本身');
assert.equal(closureBearerToken(HUB_TOKEN, 'vps-dev'), VPS_TOKEN, '同输入必须确定性');
assert.notEqual(closureBearerToken(HUB_TOKEN, 'other'), VPS_TOKEN, 'clientId 参与派生');
assert.notEqual(closureBearerToken('another-hub-token', 'vps-dev'), VPS_TOKEN, '轮换 HUB_TOKEN 即失效');

assert.equal(closureBearerMatches(HUB_TOKEN, VPS_TOKEN), true);
assert.equal(closureBearerMatches(HUB_TOKEN, HUB_TOKEN), false, 'HUB_TOKEN 本身不是 closure bearer');
assert.equal(closureBearerMatches(HUB_TOKEN, ''), false);
assert.equal(closureBearerMatches(HUB_TOKEN, null), false);
assert.equal(closureBearerMatches(HUB_TOKEN, `${VPS_TOKEN}x`), false);
assert.equal(closureBearerMatches('', VPS_TOKEN), false, '没有 HUB_TOKEN 就没有可签的密钥');
assert.equal(closureBearerMatches(HUB_TOKEN, closureBearerToken(HUB_TOKEN, 'unlisted')), false,
  '未登记的 clientId 派生出来的 token 不接受');

// ── 作用域是允许清单，不是前缀 ──
assert.equal(closureScopeAllows('GET', '/api/room-tasks/room-a/task.md'), true);
assert.equal(closureScopeAllows('GET', '/api/contacts'), true);
assert.equal(closureScopeAllows('GET', '/api/contacts/room-a/messages'), true);
// 写操作一律不在范围内
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  assert.equal(closureScopeAllows(method, '/api/room-tasks/room-a/task.md'), false, `${method} 必须被拒`);
  assert.equal(closureScopeAllows(method, '/api/contacts'), false, `${method} 必须被拒`);
}
// 相邻路径不得被顺带打开
assert.equal(closureScopeAllows('GET', '/api/room-tasks/room-a'), false);
assert.equal(closureScopeAllows('GET', '/api/room-tasks/room-a/task.md/events'), false);
assert.equal(closureScopeAllows('GET', '/api/contacts/room-a'), false);
assert.equal(closureScopeAllows('GET', '/api/contacts/room-a/messages/1'), false);
assert.equal(closureScopeAllows('GET', '/api/workers'), false);
assert.equal(closureScopeAllows('GET', '/api/system/deploy/status'), false);
assert.equal(closureScopeAllows('GET', '/api/session'), false);

// ── 端到端：挂在真的 sessionAuth 后面 ──
const auth = sessionAuth(HUB_TOKEN);
assert.ok(auth, 'sessionAuth 必须在有 HUB_TOKEN 时启用');
const app = express();
app.use(express.json());
app.use(auth!);
app.get('/api/room-tasks/:room/:task', (_req, res) => res.json({ ok: 'ledger' }));
app.get('/api/workers', (_req, res) => res.json({ ok: 'workers' }));
app.post('/api/room-tasks/:room/:task', (_req, res) => res.json({ ok: 'written' }));

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const call = async (method: string, path: string, token?: string) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  return { status: res.status, body: await res.text() };
};

try {
  // 收口脚本真正要读的那个端点：通。
  const ledger = await call('GET', '/api/room-tasks/room-a/task.md', VPS_TOKEN);
  assert.equal(ledger.status, 200);
  assert.match(ledger.body, /ledger/);

  // room-deploy-job 的在途检查带 query string；express 的 req.path 不含 query，
  // 允许清单仍要命中（正则写错成 `$` 卡在 query 上时这条会红）。
  app.get('/api/contacts/:id/messages', (_req, res) => res.json({ ok: 'messages' }));
  const withQuery = await call('GET', '/api/contacts/room-a/messages?origin=all&after=0&limit=1000', VPS_TOKEN);
  assert.equal(withQuery.status, 200);

  // 同一个 token 读别的端点：401。这是「单独建」的意义所在——
  // 把 HUB_TOKEN 抄给 VPS 的话下面这条会是 200。
  assert.equal((await call('GET', '/api/workers', VPS_TOKEN)).status, 401);
  // 同一路径改成写：401。
  assert.equal((await call('POST', '/api/room-tasks/room-a/task.md', VPS_TOKEN)).status, 401);
  // 无 token 仍然 401，HUB_TOKEN 仍然全通（没有回归）。
  assert.equal((await call('GET', '/api/room-tasks/room-a/task.md')).status, 401);
  assert.equal((await call('GET', '/api/workers', HUB_TOKEN)).status, 200);

  // closure bearer 不能拿去登录换 session。
  const login = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: VPS_TOKEN }),
  });
  assert.equal(login.status, 401, 'closure bearer 不得签出 session');
  assert.equal(login.headers.get('set-cookie'), null);

  // 也不能当作 bearer 直接过 /api/session 的认证查询。
  const probe = await fetch(`${base}/api/session`, { headers: { Authorization: `Bearer ${VPS_TOKEN}` } });
  assert.deepEqual(await probe.json(), { enabled: true, authenticated: false });
} finally {
  server.close();
}

console.log('closure auth tests: ok');
