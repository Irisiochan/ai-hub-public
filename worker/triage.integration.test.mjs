import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TriageStore } from './triage-core.mjs';

const workerDir = path.dirname(fileURLToPath(import.meta.url));

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function portOf(server) {
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function runWorker(configPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['triage-worker.mjs', configPath, '--once'], {
      cwd: workerDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`triage worker timed out\n${stdout}\n${stderr}`));
    }, 10_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`triage worker exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

test('standalone worker closes the L0→L1→L2→L3 path with mocked services', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-triage-e2e-'));
  const dispatched = [];
  const deepseek = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(body.model, 'deepseek-v4-flash');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actionable: true,
              category: 'system',
              priority: 2,
              suggestedRecipient: 'engineering',
              rationale: 'concrete scheduled check',
            }),
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
  });
  const hub = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/api/contacts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        contacts: [{
          id: 'cove',
          name: 'Cove',
          kind: 'dm',
          state: 'idle',
          config: {
            routing: {
              enabled: true,
              recipientKey: 'engineering',
              categories: ['system'],
              dailyLimit: 10,
              cooldownMinutes: 0,
            },
          },
        }],
      }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      dispatched.push({ url: req.url, body: JSON.parse(raw) });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ queued: true }));
    });
  });
  const vault = await listen((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'e2e-session',
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
        }));
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: 'no existing triage backlog' }] },
        }));
      }
    });
  });

  const configPath = path.join(dir, 'triage.json');
  const stateFile = path.join(dir, 'triage.db');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
    categories: ['system', 'other'],
    deepseek: {
      baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
      apiKeyEnv: 'TEST_DEEPSEEK_KEY',
      flashModel: 'deepseek-v4-flash',
      proModel: 'deepseek-v4-pro',
      pricing: { flash: { inputCnyPerMillion: 1, outputCnyPerMillion: 1 } },
    },
    hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
    vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp`, backlogQuery: 'triage-backlog' },
    routing: { rules: { system: 'engineering' }, fuzzyFallback: true },
    sources: [{
      id: 'test-timer',
      type: 'timer',
      intervalMinutes: 15,
      jitterSeconds: 0,
      category: 'system',
      summary: 'Inspect one concrete mocked event.',
    }],
  }));

  try {
    const result = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.match(result.stdout, /"msg":"event dispatched"/);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].url, '/api/contacts/cove/messages');
    assert.match(dispatched[0].body.content, /真实事件上下文/);
    const store = new TriageStore(stateFile);
    try {
      const summary = store.dailySummary();
      assert.equal(summary.statuses.find((row) => row.status === 'dispatched').count, 1);
      assert.equal(summary.deliveries[0].recipient_id, 'cove');
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
