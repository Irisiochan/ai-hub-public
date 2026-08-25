import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const workerDir = path.dirname(fileURLToPath(import.meta.url));

function corruptDb(stateFile) {
  // 版本号高于本 worker 支持的 schema：migrateTriageDb 启动即抛「降级拒绝」。
  const db = new DatabaseSync(stateFile);
  db.exec('PRAGMA user_version = 999');
  db.close();
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function spawnWorker(configPath, env, args = []) {
  const child = spawn(process.execPath, ['triage-worker.mjs', configPath, ...args], {
    cwd: workerDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, output, exited };
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function waitFor(check, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`waitFor timed out${lastError ? `: ${lastError.message}` : ''}`);
}

test('one-shot runs against a broken store fail fast with a maintenance log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-maintenance-once-'));
  const stateFile = path.join(dir, 'triage.db');
  corruptDb(stateFile);
  const configPath = path.join(dir, 'triage.json');
  // hub.baseUrl 只为过构造器校验；maintenance 下不会发起任何 hub 请求。
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
    sources: [],
    hub: { baseUrl: 'http://127.0.0.1:9' },
  }));

  const { output, exited } = spawnWorker(configPath, {}, ['--once']);
  const code = await exited;
  assert.equal(code, 1, `--once in maintenance must exit 1\n${output.stdout}\n${output.stderr}`);
  assert.match(output.stdout, /maintenance mode/, 'maintenance entry must be logged');
  assert.match(output.stdout, /newer than this worker supports/, 'log must carry the store failure reason');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('maintenance mode keeps webhook intake alive and journals events instead of dispatching', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-maintenance-intake-'));
  const stateFile = path.join(dir, 'triage.db');
  corruptDb(stateFile);
  const port = await freePort();
  const configPath = path.join(dir, 'triage.json');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
    sources: [],
    pollMs: 50,
    hub: { baseUrl: 'http://127.0.0.1:9' },
    webhook: { enabled: true, host: '127.0.0.1', port },
  }));

  const { child, output } = spawnWorker(configPath, { TRIAGE_WEBHOOK_TOKEN: 'maintenance-test-token' });
  try {
    const health = await waitFor(() => fetchJson(`http://127.0.0.1:${port}/health`));
    assert.equal(health.body.status, 'maintenance', 'health must report maintenance, not ok');
    assert.match(String(health.body.reason), /newer than this worker supports/);

    const accepted = await fetchJson(`http://127.0.0.1:${port}/event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer maintenance-test-token',
      },
      body: JSON.stringify({
        source: 'e2e',
        summary: 'event captured during maintenance',
        dedupeKey: 'maintenance-e2e-1',
      }),
    });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.status, 'maintenance-intake');
    assert.equal(accepted.body.enqueued, false);

    const journal = `${path.resolve(stateFile)}.maintenance-intake.jsonl`;
    const lines = fs.readFileSync(journal, 'utf8').split('\n').filter((line) => line.trim());
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).input.dedupeKey, 'maintenance-e2e-1');

    // runner 面必须完全没动：没有 source/reminder/coordination 启动日志。
    assert.doesNotMatch(output.stdout, /event queued/);
    assert.match(output.stdout, /maintenance mode/);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('healthy startup replays the maintenance intake journal with dedupe and archives it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-maintenance-replay-'));
  const stateFile = path.join(dir, 'triage.db');
  const journal = `${path.resolve(stateFile)}.maintenance-intake.jsonl`;
  const eventA = { source: 'e2e', summary: 'first maintenance event', dedupeKey: 'replay-a' };
  const eventB = { source: 'e2e', summary: 'second maintenance event', dedupeKey: 'replay-b' };
  fs.writeFileSync(journal, [
    JSON.stringify({ receivedAt: Date.now(), input: eventA }),
    JSON.stringify({ receivedAt: Date.now(), input: eventA }), // 同 dedupeKey：回放必须只落一行
    JSON.stringify({ receivedAt: Date.now(), input: eventB }),
    'not-json{',
    '',
  ].join('\n'));

  const deepseek = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actionable: false,
              category: 'other',
              priority: 3,
              summary: 'noop',
            }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
  });
  const hub = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ contacts: [] }));
  });

  const configPath = path.join(dir, 'triage.json');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
    categories: ['system', 'other'],
    sources: [],
    deepseek: {
      baseUrl: `http://127.0.0.1:${deepseek.address().port}`,
      apiKeyEnv: 'TEST_DEEPSEEK_KEY',
      flashModel: 'deepseek-v4-flash',
      proModel: 'deepseek-v4-pro',
    },
    hub: { baseUrl: `http://127.0.0.1:${hub.address().port}` },
  }));

  const { output, exited } = spawnWorker(configPath, { TEST_DEEPSEEK_KEY: 'k' }, ['--once']);
  const code = await exited;
  await new Promise((resolve) => deepseek.close(resolve));
  await new Promise((resolve) => hub.close(resolve));
  try {
    assert.equal(code, 0, `healthy --once must succeed\n${output.stdout}\n${output.stderr}`);
    assert.match(output.stdout, /maintenance intake replayed/);

    assert.equal(fs.existsSync(journal), false, 'journal must be archived after replay');
    const archived = fs.readdirSync(dir).filter((name) => name.includes('.maintenance-intake.jsonl.replayed-'));
    assert.equal(archived.length, 1, 'exactly one archived journal expected');

    const db = new DatabaseSync(stateFile, { readOnly: true });
    const rows = db.prepare("SELECT COUNT(*) AS n FROM triage_events WHERE source = 'e2e'").get();
    db.close();
    assert.equal(Number(rows.n), 2, 'duplicate dedupeKey must collapse to one row');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
