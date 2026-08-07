import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { shanghaiDateAt, TriageStore } from './triage-core.mjs';

const workerDir = path.dirname(fileURLToPath(import.meta.url));

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const portOf = (server) => server.address().port;
const close = (server) => new Promise((resolve) => server.close(resolve));

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw));
  });
}

function run(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
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
      reject(new Error(`${script} timed out\n${stdout}\n${stderr}`));
    }, 15_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function mockDeepSeek(entriesByDate) {
  return listen(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    // 抽取必须走 flash，别把日记跑成 pro 的账。
    assert.equal(body.model, 'deepseek-v4-flash');
    const asked = JSON.parse(body.messages[1].content);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ entries: entriesByDate[asked.date] ?? [] }) } }],
      usage: { prompt_tokens: 2000, completion_tokens: 120 },
    }));
  });
}

function mockHub(messagesByDate) {
  const seen = [];
  return listen(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/journal/day') {
      const date = url.searchParams.get('date');
      seen.push(date);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        date,
        truncated: false,
        messages: messagesByDate[date] ?? [],
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }).then((server) => ({ server, seen }));
}

function mockVault() {
  const writes = [];
  return listen(async (req, res) => {
    const message = JSON.parse(await readBody(req));
    if (message.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'diary-session' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } },
      }));
      return;
    }
    if (message.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    if (message.params?.name === 'log_daily') writes.push(message.params.arguments);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'ok' }] },
    }));
  }).then((server) => ({ server, writes }));
}

function chatDay(count = 8) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    contactId: 'claude',
    contactName: 'Claude',
    role: i % 2 ? 'assistant' : 'user',
    at: `${String(9 + i).padStart(2, '0')}:00`,
    content: `第 ${i} 条真实对话`,
    clipped: false,
  }));
}

function writeConfig(dir, { deepseek, hub, vault, diary, stateFile }) {
  const configPath = path.join(dir, 'triage.json');
  fs.writeFileSync(configPath, JSON.stringify({
    stateFile,
    categories: ['system', 'other'],
    deepseek: {
      baseUrl: `http://127.0.0.1:${deepseek}`,
      apiKeyEnv: 'TEST_DEEPSEEK_KEY',
      flashModel: 'deepseek-v4-flash',
      proModel: 'deepseek-v4-pro',
      pricing: { flash: { inputCnyPerMillion: 1, outputCnyPerMillion: 2 } },
    },
    hub: { baseUrl: `http://127.0.0.1:${hub}` },
    vault: { url: `http://127.0.0.1:${vault}/mcp` },
    proactive: { enabled: false, minDailyDispatches: 0 },
    diary,
    sources: [{ id: 'diary-rollup', type: 'diary-rollup' }],
  }));
  return configPath;
}

test('the diary rollup source settles yesterday into vault 流水条目', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-diary-e2e-'));
  const yesterday = shanghaiDateAt(Date.now(), 1);
  const deepseek = await mockDeepSeek({
    [yesterday]: [
      { time: '09:30', text: 'User 上午洗了两只大型犬' },
      { time: '21:10', text: 'User 晚上说小腹一直疼' },
    ],
  });
  const { server: hub, seen } = await mockHub({ [yesterday]: chatDay() });
  const { server: vault, writes } = await mockVault();
  const stateFile = path.join(dir, 'triage.db');
  const configPath = writeConfig(dir, {
    deepseek: portOf(deepseek),
    hub: portOf(hub),
    vault: portOf(vault),
    stateFile,
    diary: { enabled: true, minMessages: 4, minUserMessages: 2, source: 'hub-rollup' },
  });

  try {
    const first = await run('triage-worker.mjs', [configPath, '--once'], { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /"msg":"diary rollup written"/);
    assert.deepEqual(seen, [yesterday], 'rollup 必须结算前一个上海日');
    assert.deepEqual(writes, [
      { content: 'User 上午洗了两只大型犬', date: yesterday, time: '09:30', source: 'hub-rollup' },
      { content: 'User 晚上说小腹一直疼', date: yesterday, time: '21:10', source: 'hub-rollup' },
    ]);

    const store = new TriageStore(stateFile);
    try {
      const summary = store.dailySummary();
      assert.equal(summary.diaryPoolDispatched, 1);
      assert.equal(summary.diaryRollups, 1);
      assert.ok(summary.lastDiaryRollupAt, '写成功必须留下时间戳');
      assert.ok(summary.costCny > 0);
      assert.equal(store.getSourceState(`diary-rollup:${yesterday}`)?.startsWith('written:'), true);
    } finally {
      store.close();
    }

    // 同一个上海日再跑一次不能重复写日记：事件去重 + 日期状态两道闸。
    const second = await run('triage-worker.mjs', [configPath, '--once'], { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(writes.length, 2, '重跑不得重复写入');
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a day lost to broken JSON is recovered by a genuinely different second sample', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-diary-retry-'));
  const yesterday = shanghaiDateAt(Date.now(), 1);
  const sampling = [];
  // 第一次照抄生产 2026-07-25 的坏 JSON；第二次才给合法结果。
  const broken = '{"entries":[{"time":"21:42","text":"User 说"好吃"然后又点了一份"}]}';
  const deepseek = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    sampling.push({ temperature: body.temperature, maxTokens: body.max_tokens });
    const content = sampling.length === 1
      ? broken
      : JSON.stringify({ entries: [{ time: '21:42', text: 'User 吃宵夜点了三文鱼' }] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 2000, completion_tokens: 120 },
    }));
  });
  const { server: hub } = await mockHub({ [yesterday]: chatDay() });
  const { server: vault, writes } = await mockVault();
  const stateFile = path.join(dir, 'triage.db');
  const configPath = writeConfig(dir, {
    deepseek: portOf(deepseek),
    hub: portOf(hub),
    vault: portOf(vault),
    stateFile,
    diary: { enabled: true, minMessages: 4, minUserMessages: 2, source: 'hub-rollup' },
  });

  try {
    const result = await run('triage-worker.mjs', [configPath, '--once'], { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(sampling.length, 2, '坏 JSON 必须触发第二次抽取');
    assert.notEqual(
      sampling[1].temperature,
      sampling[0].temperature,
      '重试不换采样等于把同一份坏 JSON 再要一遍'
    );
    assert.ok(sampling[1].maxTokens > sampling[0].maxTokens);
    assert.match(result.stdout, /"msg":"diary extraction attempt failed"/);
    assert.match(result.stdout, /raw:/, '失败日志要留下原文，事后不用靠 position 猜');
    assert.match(result.stdout, /"msg":"diary rollup written"/);
    assert.deepEqual(writes, [
      { content: 'User 吃宵夜点了三文鱼', date: yesterday, time: '21:42', source: 'hub-rollup' },
    ], '救回来的那一天要照常落库');

    const store = new TriageStore(stateFile);
    try {
      // 两次调用的钱都要认，别把重试的成本记漏。
      assert.ok(store.dailySummary().costCny > 0);
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a disabled diary config never reaches the hub or the model', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-diary-off-'));
  const yesterday = shanghaiDateAt(Date.now(), 1);
  const deepseek = await mockDeepSeek({});
  const { server: hub, seen } = await mockHub({ [yesterday]: chatDay() });
  const { server: vault, writes } = await mockVault();
  const configPath = writeConfig(dir, {
    deepseek: portOf(deepseek),
    hub: portOf(hub),
    vault: portOf(vault),
    stateFile: path.join(dir, 'triage.db'),
    diary: { enabled: false },
  });

  try {
    const result = await run('triage-worker.mjs', [configPath, '--once'], { TEST_DEEPSEEK_KEY: 'test-only' });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(seen, [], '关掉时不该去拉对话');
    assert.deepEqual(writes, []);
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('diary-backfill walks a date range and refuses to settle today', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-diary-backfill-'));
  const dayOne = shanghaiDateAt(Date.now(), 3);
  const dayTwo = shanghaiDateAt(Date.now(), 2);
  const today = shanghaiDateAt(Date.now(), 0);
  const deepseek = await mockDeepSeek({
    [dayOne]: [{ time: '10:00', text: '第一天的事' }],
    [dayTwo]: [{ time: '11:00', text: '第二天的事' }],
  });
  const { server: hub, seen } = await mockHub({ [dayOne]: chatDay(), [dayTwo]: chatDay() });
  const { server: vault, writes } = await mockVault();
  const configPath = writeConfig(dir, {
    deepseek: portOf(deepseek),
    hub: portOf(hub),
    vault: portOf(vault),
    stateFile: path.join(dir, 'triage.db'),
    diary: { enabled: false, minMessages: 4, minUserMessages: 2 },
  });

  try {
    const refused = await run('diary-backfill.mjs', ['--from', dayOne, '--to', today, '--config', configPath], {});
    assert.equal(refused.code, 2, '默认不允许补写还没过完的今天');
    assert.match(refused.stderr, /当天还没过完/);
    assert.deepEqual(writes, []);

    const dry = await run(
      'diary-backfill.mjs',
      ['--from', dayOne, '--to', dayTwo, '--config', configPath, '--dry-run'],
      { TEST_DEEPSEEK_KEY: 'test-only' },
    );
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /"msg":"would write"/);
    assert.deepEqual(writes, [], 'dry run 不写 vault');

    seen.length = 0;
    const real = await run(
      'diary-backfill.mjs',
      ['--from', dayOne, '--to', dayTwo, '--config', configPath],
      { TEST_DEEPSEEK_KEY: 'test-only' },
    );
    assert.equal(real.code, 0, real.stderr);
    assert.deepEqual(seen, [dayOne, dayTwo], '按日期顺序逐天结算');
    assert.deepEqual(writes, [
      { content: '第一天的事', date: dayOne, time: '10:00', source: 'hub-rollup-backfill' },
      { content: '第二天的事', date: dayTwo, time: '11:00', source: 'hub-rollup-backfill' },
    ], 'backfill 条目必须带可区分的 source');

    // 补过的日子必须在 worker 状态表里销账，否则定时 rollup 撞上同一天会写第二遍。
    const store = new TriageStore(path.join(dir, 'triage.db'));
    try {
      for (const date of [dayOne, dayTwo]) {
        assert.match(
          store.getSourceState(`diary-rollup:${date}`) ?? '',
          /^backfill-written:/,
          `${date} 应已销账`
        );
      }
    } finally {
      store.close();
    }
  } finally {
    await Promise.all([close(deepseek), close(hub), close(vault)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
