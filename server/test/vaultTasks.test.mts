import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { vaultTasksRouter, type VaultTaskClient } from '../src/routes/vaultTasks.js';

async function listen(vault: VaultTaskClient | null) {
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const app = express();
  app.use(express.json());
  app.use('/api/vault', vaultTasksRouter(vault && {
    async call(name, args) {
      calls.push({ name, args });
      return vault.call(name, args);
    },
  }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    calls,
    endpoint: `http://127.0.0.1:${address.port}/api/vault/task-status`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    ),
  };
}

const fakeVault: VaultTaskClient = {
  async call(name) {
    if (name === 'read_file') {
      return JSON.stringify({ result: '---\ntype: task\nstatus: open\n---\n# Demo' });
    }
    if (name === 'update_task') return 'updated';
    throw new Error(`unexpected ${name}`);
  },
};

const fixture = await listen(fakeVault);
try {
  const response = await fetch(fixture.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'tasks/demo.md',
      status: 'done',
      note: '真实验收通过',
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, path: 'tasks/demo.md', status: 'done' });
  assert.deepEqual(fixture.calls.map((call) => call.name), ['read_file', 'update_task']);
  assert.deepEqual(fixture.calls[1].args, {
    path: 'tasks/demo.md',
    status: 'done',
    note: '真实验收通过',
    source: 'User',
  });

  const tail = await fetch(fixture.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'tasks/worker-tail-demo.md',
      status: 'done',
      note: '不要误关尾巴',
    }),
  });
  assert.equal(tail.status, 409);
  assert.equal(fixture.calls.length, 2, 'tail rejection must not call the vault');
} finally {
  await fixture.close();
}

const offline = await listen(null);
try {
  const response = await fetch(offline.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'tasks/demo.md', status: 'done', note: '验收' }),
  });
  assert.equal(response.status, 503);
} finally {
  await offline.close();
}

const closedTask = await listen({
  async call() {
    return '---\ntype: task\nstatus: done\n---\n# Closed';
  },
});
try {
  const response = await fetch(closedTask.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'tasks/demo.md', status: 'done', note: '验收' }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(closedTask.calls.map((call) => call.name), ['read_file']);
} finally {
  await closedTask.close();
}

const failedWrite = await listen({
  async call(name) {
    if (name === 'read_file') return '---\ntype: task\nstatus: open\n---\n# Demo';
    throw new Error('vault offline');
  },
});
try {
  const response = await fetch(failedWrite.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'tasks/demo.md', status: 'done', note: '验收' }),
  });
  assert.equal(response.status, 502);
  assert.match((await response.json() as { error: string }).error, /vault offline/);
} finally {
  await failedWrite.close();
}

let releaseRead!: () => void;
const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
const concurrent = await listen({
  async call(name) {
    if (name === 'read_file') {
      await readGate;
      return '---\ntype: task\nstatus: open\n---\n# Demo';
    }
    return 'updated';
  },
});
try {
  const body = JSON.stringify({ path: 'tasks/demo.md', status: 'done', note: '验收' });
  const first = fetch(concurrent.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  while (concurrent.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  const duplicate = await fetch(concurrent.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(duplicate.status, 409);
  releaseRead();
  assert.equal((await first).status, 200);
  assert.deepEqual(concurrent.calls.map((call) => call.name), ['read_file', 'update_task']);
} finally {
  releaseRead();
  await concurrent.close();
}

console.log('vault task status HTTP checks passed');
