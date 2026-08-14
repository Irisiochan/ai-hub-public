/**
 * Triage $0 wake-gate smoke (anti-regression).
 *
 * Asserts (each has a distinguishing negative path — not tautologies):
 *  1) system timer with zero eligible tasks → zero model calls
 *  2) system timer with eligible tasks → L1 still wakes (gate must not block real work)
 *  2b) empty backlog + categoryHint:'system' WITHOUT scheduler origin → L1 still runs
 *      (gate must not swallow real webhook/http-diff events)
 *  2c) system timer + vault empty string / garbage text → fail-open to L1 (no short-circuit)
 *  3) User present within threshold → daily skips L1; idle beyond threshold → daily evaluates
 *  4) webhook kind:"probe" → acknowledged, never enqueued; real non-probe system event reaches L1
 *
 * Removing the system-timer gate makes (1) fail (model is called).
 * Broadening isSystemTimerEvent to categoryHint==='system' alone makes (2b)/(4) fail.
 * Treating empty/garbage vault as zero-tasks makes (2c) fail.
 * Removing the presence gate makes (3a) fail (model is called while present).
 * Removing the probe bypass makes (4) fail (event is enqueued/dispatched).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDispatchableTaskContext,
  fileWatchContentDigest,
  isSystemTimerEvent,
  isWebhookProbeInput,
  shouldSuppressUnchangedFileWatch,
} from '../../worker/triage-core.mjs';
import { irisPresenceFromMessages } from '../../worker/followups.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(here, '../../worker');

function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function portOf(server: http.Server): number {
  return (server.address() as { port: number }).port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function runWorker(
  configPath: string,
  env: Record<string, string>,
  args: string[] = ['--once'],
  timeoutMs = 12_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['triage-worker.mjs', configPath, ...args], {
      cwd: workerDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`triage worker timed out\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function vaultHandler(taskText: string): http.RequestListener {
  return (req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const message = JSON.parse(raw || '{}');
      if (message.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'wake-gate-session',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 'mock', version: '1' },
            },
          }),
        );
        return;
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      const name = message.params?.name;
      const text =
        name === 'get_facts'
          ? '找到 0 条 facts：'
          : taskText;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text }] },
        }),
      );
    });
  };
}

const EMPTY_SNAPSHOT = [
  '任务快照日期：2026-08-11',
  '',
  '## ⏰ 时间敏感事项',
  '- **已有 Worker 尾巴** (`tasks/worker-tail-old-job.md`)（无期限，仍未完成）',
  '- **未来事项** (`tasks/future-work.md`) 还有 5 天（2026-08-16 星期六）',
].join('\n');

const ELIGIBLE_SNAPSHOT = [
  '任务快照日期：2026-08-11',
  '',
  '## ⏰ 时间敏感事项',
  '- **真实工作** (`tasks/real-work.md`)（无期限，仍未完成）',
].join('\n');

// --- pure helper checks (fast, distinguish true/false paths) ---
{
  const empty = buildDispatchableTaskContext(EMPTY_SNAPSHOT);
  const eligible = buildDispatchableTaskContext(ELIGIBLE_SNAPSHOT);
  const headerOnly = buildDispatchableTaskContext('任务快照日期：2026-08-11\n\n## ⏰ 时间敏感事项\n');
  const emptyRaw = buildDispatchableTaskContext('');
  const garbage = buildDispatchableTaskContext('not a vault snapshot at all');
  const malformedTaskLine = buildDispatchableTaskContext([
    '任务快照日期：2026-08-11',
    '',
    '## ⏰ 时间敏感事项',
    '- **broken entry without path** still looks like a task',
  ].join('\n'));

  assert.equal(empty.taskPaths.length, 0, 'empty eligible set must be empty');
  assert.equal(empty.parseOk, true, 'well-formed zero-eligible snapshot is parseOk');
  assert.ok(eligible.taskPaths.includes('tasks/real-work.md'), 'eligible task must be selected');
  assert.equal(eligible.parseOk, true);
  assert.equal(headerOnly.parseOk, true, 'header-only explicit empty body is parseOk');
  assert.equal(headerOnly.taskPaths.length, 0);
  assert.equal(emptyRaw.parseOk, false, 'empty string is not a zero-task snapshot');
  assert.equal(garbage.parseOk, false, 'garbage text is not a zero-task snapshot');
  assert.equal(malformedTaskLine.parseOk, false, 'task-looking unmatched lines soft-fail');

  // Positive scheduler identity only — categoryHint system alone must NOT match.
  assert.equal(
    isSystemTimerEvent({ category_hint: 'system', payload: { mode: 'task' } }),
    false,
    'categoryHint system without origin must not be treated as system timer',
  );
  assert.equal(
    isSystemTimerEvent({
      category_hint: 'system',
      payload: { mode: 'task', origin: 'scheduler-timer' },
    }),
    true,
    'stamped scheduler-timer origin must match',
  );
  assert.equal(isSystemTimerEvent({ category_hint: 'daily', payload: { mode: 'daily' } }), false);
  assert.equal(isSystemTimerEvent({ category_hint: 'backlog' }), false);
  assert.equal(
    isSystemTimerEvent({
      categoryHint: 'system',
      source: 'webhook',
      payload: { mode: 'task', note: 'external' },
    }),
    false,
    'webhook-shaped system event must fail-open (not a timer)',
  );

  assert.equal(isWebhookProbeInput({ kind: 'probe' }), true);
  assert.equal(isWebhookProbeInput({ payload: { kind: 'probe' } }), true);
  assert.equal(isWebhookProbeInput({ summary: 'real event' }), false);

  const digA = fileWatchContentDigest({ mtimeMs: 1000, size: 10 }, 'a.ts');
  const digB = fileWatchContentDigest({ mtimeMs: 1000, size: 10 }, 'a.ts');
  const digC = fileWatchContentDigest({ mtimeMs: 2000, size: 10 }, 'a.ts');
  assert.equal(shouldSuppressUnchangedFileWatch(digA, digB), true);
  assert.equal(shouldSuppressUnchangedFileWatch(digA, digC), false);
  assert.equal(shouldSuppressUnchangedFileWatch(null, digA), false);

  const now = Date.now();
  const present = irisPresenceFromMessages(
    [{ sender: 'user', role: 'user', content: 'hi', status: 'done', created_at: now - 5 * 60_000 }],
    { now, idleMinutes: 30 },
  );
  const idle = irisPresenceFromMessages(
    [{ sender: 'user', role: 'user', content: 'hi', status: 'done', created_at: now - 90 * 60_000 }],
    { now, idleMinutes: 30 },
  );
  const aiOnly = irisPresenceFromMessages(
    [{ sender: 'assistant', role: 'assistant', content: 'hello', status: 'done', created_at: now - 1_000 }],
    { now, idleMinutes: 30 },
  );
  assert.equal(present.active, true);
  assert.equal(idle.active, false);
  assert.equal(aiOnly.active, false, 'AI output must not count as User presence');
}

async function systemTimerScenario(taskText: string): Promise<{ deepseekCalls: number; stdout: string }> {
  let deepseekCalls = 0;
  const deepseek = await listen((_req, res) => {
    deepseekCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actionable: true,
              needsLocalExec: false,
              category: 'system',
              priority: 2,
              suggestedRecipient: 'codex',
              rationale: 'eligible work exists',
            }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
  const hub = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/api/contacts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          contacts: [{
            id: 'codex',
            name: 'Codex',
            kind: 'dm',
            state: 'idle',
            config: {
              routing: {
                enabled: true,
                recipientKey: 'codex',
                categories: ['system'],
                dailyLimit: 10,
                cooldownMinutes: 0,
              },
            },
          }],
        }),
      );
      return;
    }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ queued: true, messageId: 1 }));
  });
  const vault = await listen(vaultHandler(taskText));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-wake-sys-'));
  const configPath = path.join(dir, 'triage.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      stateFile: path.join(dir, 'triage.db'),
      categories: ['system', 'other'],
      deepseek: {
        baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        flashModel: 'deepseek-v4-flash',
        proModel: 'deepseek-v4-pro',
      },
      hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
      vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp` },
      routing: { rules: { system: 'codex' }, fuzzyFallback: false },
      outcomes: { enabled: false },
      followups: { enabled: false },
      sources: [{
        id: 'quarter-hour-check',
        type: 'timer',
        intervalMinutes: 15,
        jitterSeconds: 0,
        category: 'system',
        summary: 'Review current backlog and only act when there is concrete unfinished work.',
      }],
    }),
  );
  try {
    const result = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return { deepseekCalls, stdout: result.stdout };
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ① zero eligible → zero model calls
{
  const empty = await systemTimerScenario(EMPTY_SNAPSHOT);
  assert.equal(empty.deepseekCalls, 0, 'system timer with no eligible task must not call the model');
  assert.match(empty.stdout, /system timer suppressed before L1/);
}

// ② eligible → still wakes (if gate were wrong-open always, ① fails; if wrong-closed always, ② fails)
{
  const open = await systemTimerScenario(ELIGIBLE_SNAPSHOT);
  assert.ok(open.deepseekCalls >= 1, 'system timer with eligible task must still wake L1');
  assert.doesNotMatch(open.stdout, /system timer suppressed before L1/);
}

// ②c vault empty / garbage → fail-open (must NOT short-circuit as "zero tasks")
{
  const blank = await systemTimerScenario('');
  assert.ok(blank.deepseekCalls >= 1, 'empty vault string must fail-open to L1');
  assert.doesNotMatch(blank.stdout, /system timer suppressed before L1/);
  assert.match(blank.stdout, /system timer task snapshot unparseable|event dispatched|event classified/);

  const garbage = await systemTimerScenario('totally not a task snapshot\njust noise');
  assert.ok(garbage.deepseekCalls >= 1, 'garbage vault text must fail-open to L1');
  assert.doesNotMatch(garbage.stdout, /system timer suppressed before L1/);
}

/**
 * Webhook-shaped real event: categoryHint system, empty backlog, NO scheduler origin.
 * Must reach L1 (fix before: isSystemTimerEvent matched category alone → swallowed).
 */
async function nonTimerSystemEventScenario(taskText: string): Promise<{ deepseekCalls: number; stdout: string }> {
  let deepseekCalls = 0;
  const deepseek = await listen((_req, res) => {
    deepseekCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actionable: true,
              needsLocalExec: false,
              category: 'system',
              priority: 2,
              suggestedRecipient: 'codex',
              rationale: 'real external system event',
            }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
  const hub = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/api/contacts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          contacts: [{
            id: 'codex',
            name: 'Codex',
            kind: 'dm',
            state: 'idle',
            config: {
              routing: {
                enabled: true,
                recipientKey: 'codex',
                categories: ['system'],
                dailyLimit: 10,
                cooldownMinutes: 0,
              },
            },
          }],
        }),
      );
      return;
    }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ queued: true, messageId: 1 }));
  });
  const vault = await listen(vaultHandler(taskText));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-wake-nontimer-'));
  const configPath = path.join(dir, 'triage.json');
  const webhookPort = 39_100 + Math.floor(Math.random() * 900);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      stateFile: path.join(dir, 'triage.db'),
      pollMs: 200,
      categories: ['system', 'other'],
      deepseek: {
        baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        flashModel: 'deepseek-v4-flash',
        proModel: 'deepseek-v4-pro',
      },
      hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
      vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp` },
      routing: { rules: { system: 'codex' }, fuzzyFallback: false },
      outcomes: { enabled: false },
      followups: { enabled: false },
      sources: [],
      webhook: {
        enabled: true,
        host: '127.0.0.1',
        port: webhookPort,
        tokenEnv: 'TRIAGE_WEBHOOK_TOKEN',
      },
    }),
  );

  const child = spawn(process.execPath, ['triage-worker.mjs', configPath], {
    cwd: workerDir,
    env: {
      ...process.env,
      TEST_DEEPSEEK_KEY: 'test-only',
      TRIAGE_WEBHOOK_TOKEN: 'nontimer-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const waitForListen = async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (stdout.includes('webhook listening')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`webhook did not start\n${stdout}\n${stderr}`);
  };

  try {
    await waitForListen();
    const realRes = await fetch(`http://127.0.0.1:${webhookPort}/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer nontimer-token',
      },
      body: JSON.stringify({
        source: 'webhook',
        summary: 'real non-timer system event with empty backlog',
        categoryHint: 'system',
        dedupeKey: `nontimer-${Date.now()}`,
        payload: { mode: 'task', note: 'external-not-scheduler' },
      }),
    });
    const realBody = await realRes.json() as { inserted?: boolean; error?: string };
    assert.equal(realRes.status, 202, JSON.stringify(realBody));
    assert.equal(realBody.inserted, true);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (
        deepseekCalls > 0
        || stdout.includes('event dispatched')
        || stdout.includes('event classified NO_OP')
        || stdout.includes('system timer suppressed before L1')
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { deepseekCalls, stdout };
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ②b empty backlog + real categoryHint system non-timer → L1 still runs
{
  const result = await nonTimerSystemEventScenario(EMPTY_SNAPSHOT);
  assert.ok(
    result.deepseekCalls >= 1,
    'real categoryHint:system without scheduler origin must reach L1 even with empty backlog',
  );
  assert.doesNotMatch(
    result.stdout,
    /system timer suppressed before L1/,
    'non-timer system event must not be short-circuited by the system-timer gate',
  );
}

async function dailyPresenceScenario(opts: {
  userMessageAgeMs: number | null;
  aiOnly?: boolean;
}): Promise<{ deepseekCalls: number; stdout: string }> {
  let deepseekCalls = 0;
  const now = Date.now();
  const deepseek = await listen((_req, res) => {
    deepseekCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actionable: false,
              needsLocalExec: false,
              category: 'daily',
              priority: 1,
              suggestedRecipient: null,
              rationale: 'nothing pressing',
            }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  });
  const hub = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/api/contacts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          contacts: [{
            id: 'codex',
            name: 'Codex',
            kind: 'dm',
            state: 'idle',
            last_at: new Date(now - 60_000).toISOString(),
            config: {
              routing: {
                enabled: true,
                recipientKey: 'codex',
                categories: ['daily', 'system'],
                dailyLimit: 10,
                cooldownMinutes: 0,
              },
            },
          }],
        }),
      );
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/contacts/codex/messages')) {
      const messages =
        opts.userMessageAgeMs == null
          ? []
          : opts.aiOnly
            ? [{
              id: 1,
              sender: 'assistant',
              role: 'assistant',
              content: 'AI only',
              status: 'done',
              created_at: now - opts.userMessageAgeMs,
            }]
            : [{
              id: 1,
              sender: 'user',
              role: 'user',
              content: '我在',
              status: 'done',
              created_at: now - opts.userMessageAgeMs,
            }];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages }));
      return;
    }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ queued: true }));
  });
  const vault = await listen(vaultHandler(ELIGIBLE_SNAPSHOT));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-wake-daily-'));
  const configPath = path.join(dir, 'triage.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      stateFile: path.join(dir, 'triage.db'),
      categories: ['daily', 'system', 'other'],
      deepseek: {
        baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        flashModel: 'deepseek-v4-flash',
        proModel: 'deepseek-v4-pro',
      },
      hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
      vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp` },
      routing: { rules: {}, fuzzyFallback: false },
      proactive: {
        enabled: true,
        // Disable guaranteed-slot force so presence damping can be observed in isolation.
        minDailyDispatches: 0,
        dailyDispatchLimit: 10,
        forceAfterHour: 23,
        minimumGapMinutes: 0,
        silentStartHour: 0,
        silentEndHour: 0,
        presenceIdleMinutes: 30,
        recipients: ['codex'],
      },
      outcomes: { enabled: false },
      followups: { enabled: false },
      sources: [{
        id: 'daily-check-in',
        type: 'timer',
        mode: 'daily',
        intervalMinutes: 45,
        jitterSeconds: 0,
        category: 'daily',
        summary: 'Proactive daily companion check for User.',
      }],
    }),
  );
  try {
    const result = await runWorker(configPath, { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    return { deepseekCalls, stdout: result.stdout };
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ③a User present → daily skips
{
  const present = await dailyPresenceScenario({ userMessageAgeMs: 5 * 60_000 });
  assert.equal(present.deepseekCalls, 0, 'daily must not call model while User is present');
  assert.match(present.stdout, /daily suppressed by User presence/);
}

// ③b idle beyond threshold → still evaluates
{
  const idle = await dailyPresenceScenario({ userMessageAgeMs: 90 * 60_000 });
  assert.ok(idle.deepseekCalls >= 1, 'daily must still evaluate when User is idle past threshold');
  assert.doesNotMatch(idle.stdout, /daily suppressed by User presence/);
}

// ④ webhook probe: never enqueue / never dispatch
{
  let deepseekCalls = 0;
  let dispatchCount = 0;
  let enqueuedViaWebhook = 0;
  const deepseek = await listen((_req, res) => {
    deepseekCalls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              actionable: true,
              needsLocalExec: false,
              category: 'system',
              priority: 1,
              suggestedRecipient: 'codex',
              rationale: 'should not reach here for probe',
            }),
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  });
  const hub = await listen((req, res) => {
    if (req.method === 'GET' && req.url === '/api/contacts') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        contacts: [{
          id: 'codex',
          name: 'Codex',
          kind: 'dm',
          state: 'idle',
          config: {
            routing: {
              enabled: true,
              recipientKey: 'codex',
              categories: ['system'],
              dailyLimit: 10,
              cooldownMinutes: 0,
            },
          },
        }],
      }));
      return;
    }
    if (req.method === 'POST') {
      dispatchCount += 1;
    }
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ queued: true }));
  });
  const vault = await listen(vaultHandler(ELIGIBLE_SNAPSHOT));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-wake-probe-'));
  const configPath = path.join(dir, 'triage.json');
  const webhookPort = 39_000 + Math.floor(Math.random() * 1000);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      stateFile: path.join(dir, 'triage.db'),
      pollMs: 200,
      categories: ['system', 'other'],
      deepseek: {
        baseUrl: `http://127.0.0.1:${portOf(deepseek)}`,
        apiKeyEnv: 'TEST_DEEPSEEK_KEY',
        flashModel: 'deepseek-v4-flash',
        proModel: 'deepseek-v4-pro',
      },
      hub: { baseUrl: `http://127.0.0.1:${portOf(hub)}` },
      vault: { url: `http://127.0.0.1:${portOf(vault)}/mcp` },
      routing: { rules: { system: 'codex' }, fuzzyFallback: false },
      outcomes: { enabled: false },
      followups: { enabled: false },
      sources: [],
      webhook: {
        enabled: true,
        host: '127.0.0.1',
        port: webhookPort,
        tokenEnv: 'TRIAGE_WEBHOOK_TOKEN',
      },
    }),
  );

  const child = spawn(process.execPath, ['triage-worker.mjs', configPath], {
    cwd: workerDir,
    env: {
      ...process.env,
      TEST_DEEPSEEK_KEY: 'test-only',
      TRIAGE_WEBHOOK_TOKEN: 'probe-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const waitForListen = async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (stdout.includes('webhook listening')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`webhook did not start\n${stdout}\n${stderr}`);
  };

  try {
    await waitForListen();
    const probeRes = await fetch(`http://127.0.0.1:${webhookPort}/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer probe-token',
      },
      body: JSON.stringify({ kind: 'probe', source: 'healthcheck', summary: 'ping' }),
    });
    assert.equal(probeRes.status, 200);
    const probeBody = await probeRes.json() as { status?: string; enqueued?: boolean };
    assert.equal(probeBody.status, 'probe-ok');
    assert.equal(probeBody.enqueued, false);

    // Real event still works (distinguishes "webhook broken" from "probe bypass").
    const realRes = await fetch(`http://127.0.0.1:${webhookPort}/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer probe-token',
      },
      body: JSON.stringify({
        source: 'webhook',
        summary: 'real non-probe event',
        categoryHint: 'system',
        dedupeKey: `real-${Date.now()}`,
        payload: { mode: 'task', note: 'not-a-probe' },
      }),
    });
    assert.equal(realRes.status, 202);
    const realBody = await realRes.json() as { inserted?: boolean };
    assert.equal(realBody.inserted, true);
    enqueuedViaWebhook = 1;

    // Let the worker drain the real event.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (stdout.includes('event dispatched') || stdout.includes('event classified NO_OP')
        || stdout.includes('system timer suppressed before L1')
        || deepseekCalls > 0) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(enqueuedViaWebhook, 1);
    assert.match(stdout, /webhook probe acknowledged/);
    // Real non-probe event with categoryHint system must reach L1 (not swallowed
    // by the system-timer gate). Probe itself already asserted enqueued:false.
    assert.ok(
      deepseekCalls >= 1,
      'real non-probe webhook event must call the model (probe water removed)',
    );
    assert.doesNotMatch(
      stdout,
      /system timer suppressed before L1/,
      'webhook categoryHint:system without scheduler origin must not short-circuit',
    );
    // Hard check: probe was acknowledged; real path may dispatch.
    assert.ok(stdout.includes('webhook probe acknowledged'));
    // Real event should either dispatch or classify — not be silently dropped.
    assert.ok(
      stdout.includes('event dispatched')
        || stdout.includes('event classified')
        || deepseekCalls >= 1,
      'real webhook event must be processed past enqueue',
    );
    void dispatchCount;
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('smoke-triage-wake-gate: ok');
