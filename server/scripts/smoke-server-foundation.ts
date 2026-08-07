import assert from 'node:assert/strict';
import express from 'express';
import { createLogger } from '../src/logger.js';
import { sessionAuth } from '../src/middleware/auth.js';
import { localCors } from '../src/middleware/cors.js';
import { createServer } from '../src/server.js';

assert.equal(typeof createServer, 'function', 'server module must export a side-effect-free factory');
assert.equal(typeof createLogger().info, 'function', 'pino logger must be available');

const app = express();
app.use(localCors('capacitor://localhost'));
app.use(express.json());
const auth = sessionAuth('test-secret');
assert(auth, 'auth middleware should exist when HUB_TOKEN is set');
app.use(auth);
app.get('/api/check', (_req, res) => res.json({ ok: true }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/app/latest', (_req, res) => res.json({ version: 'test' }));
app.get('/api/events', (_req, res) => res.json({ event: true }));
app.get('/api/worker/check', (_req, res) => res.json({ exempt: true }));
app.get('/api/workers/check', (_req, res) => res.json({ management: true }));
app.get('/', (_req, res) => res.send('web'));

const listener = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => listener.once('listening', resolve));
const address = listener.address();
assert(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const denied = await fetch(`${baseUrl}/api/check`);
  assert.equal(denied.status, 401);

  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/app/latest`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/`)).status, 200);

  const apiQueryRejected = await fetch(`${baseUrl}/api/check?token=test-secret`);
  assert.equal(apiQueryRejected.status, 401, 'raw password query must only work on Web entry routes');

  const bearerAccepted = await fetch(`${baseUrl}/api/check`, {
    headers: { authorization: 'Bearer test-secret' },
  });
  assert.equal(bearerAccepted.status, 200);

  const invalidLogin = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(invalidLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test-secret' }),
  });
  assert.equal(login.status, 200);
  const loginBody = await login.json() as { sessionToken: string };
  assert.match(loginBody.sessionToken, /^v1\./);
  assert.ok(!loginBody.sessionToken.includes('test-secret'));
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie ?? '', /hub_session=v1\./);
  assert.ok(!(cookie ?? '').includes('test-secret'));

  const cookiePair = cookie?.split(';', 1)[0] ?? '';
  const cookieAccepted = await fetch(`${baseUrl}/api/check`, { headers: { cookie: cookiePair } });
  assert.equal(cookieAccepted.status, 200);

  const sessionBearerAccepted = await fetch(`${baseUrl}/api/check`, {
    headers: { authorization: `Bearer ${loginBody.sessionToken}` },
  });
  assert.equal(sessionBearerAccepted.status, 200);

  const sessionQueryAccepted = await fetch(
    `${baseUrl}/api/events?session=${encodeURIComponent(loginBody.sessionToken)}`
  );
  assert.equal(sessionQueryAccepted.status, 200);

  const legacyEntry = await fetch(`${baseUrl}/?token=test-secret`, { redirect: 'manual' });
  assert.equal(legacyEntry.status, 302);
  assert.equal(legacyEntry.headers.get('location'), '/');
  assert.match(legacyEntry.headers.get('set-cookie') ?? '', /hub_session=v1\./);

  const worker = await fetch(`${baseUrl}/api/worker/check`);
  assert.equal(worker.status, 200);

  const workerManagement = await fetch(`${baseUrl}/api/workers/check`);
  assert.equal(workerManagement.status, 401, '/api/workers must remain behind session auth');

  const preflight = await fetch(`${baseUrl}/api/check`, {
    method: 'OPTIONS',
    headers: { origin: 'capacitor://localhost', 'access-control-request-headers': 'content-type,x-test' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type,x-test');
} finally {
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
}

console.log('server foundation smoke: ok');
