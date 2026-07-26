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
const auth = sessionAuth('test-secret');
assert(auth, 'auth middleware should exist when HUB_TOKEN is set');
app.use(auth);
app.get('/api/check', (_req, res) => res.json({ ok: true }));
app.get('/api/worker/connect', (_req, res) => res.json({ exempt: true }));
app.get('/api/workers', (_req, res) => res.json({ management: true }));

const listener = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => listener.once('listening', resolve));
const address = listener.address();
assert(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const denied = await fetch(`${baseUrl}/api/check`);
  assert.equal(denied.status, 401);

  const accepted = await fetch(`${baseUrl}/api/check?token=test-secret`);
  assert.equal(accepted.status, 200);
  const cookie = accepted.headers.get('set-cookie');
  assert.match(cookie ?? '', /hub_session=test-secret/);

  const cookieAccepted = await fetch(`${baseUrl}/api/check`, { headers: { cookie: 'hub_session=test-secret' } });
  assert.equal(cookieAccepted.status, 200);

  const worker = await fetch(`${baseUrl}/api/worker/connect`);
  assert.equal(worker.status, 200);
  const workerManagement = await fetch(`${baseUrl}/api/workers`);
  assert.equal(workerManagement.status, 401);

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
