import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  DELIVERY_POOL_DIARY,
  isDiaryMode,
  nextWallClockDelay,
  normalizeDiaryConfig,
  parseDiaryEntries,
  shanghaiDateAt,
} from './triage-core.mjs';
import { buildTranscript, rollupDay, shanghaiWeekday } from './diary-rollup.mjs';
import { DeepSeekClient } from './triage-clients.mjs';
import { listenOnFetchSafePort } from './test-http.mjs';

const HOUR = 60 * 60_000;

function at(shanghaiIso) {
  return Date.parse(`${shanghaiIso}+08:00`);
}

test('isDiaryMode only matches explicit diary sources', () => {
  assert.equal(isDiaryMode({ mode: 'diary' }), true);
  assert.equal(isDiaryMode({ categoryHint: 'diary' }), true);
  assert.equal(isDiaryMode({ payload: { mode: 'diary' } }), true);
  assert.equal(isDiaryMode({ mode: 'daily' }), false);
  assert.equal(isDiaryMode({ mode: 'idea' }), false);
  assert.equal(isDiaryMode(null), false);
});

test('shanghaiDateAt walks Shanghai calendar days, not host days', () => {
  // UTC 上还是 07-27，上海已经是 07-28。
  const nearMidnight = Date.parse('2026-07-27T16:30:00Z');
  assert.equal(shanghaiDateAt(nearMidnight, 0), '2026-07-28');
  assert.equal(shanghaiDateAt(nearMidnight, 1), '2026-07-27');
  assert.equal(shanghaiDateAt(nearMidnight, 7), '2026-07-21');
});

test('nextWallClockDelay always lands on the next Shanghai 02:30', () => {
  const config = { atHour: 2, atMinute: 30 };
  assert.equal(nextWallClockDelay(config, at('2026-07-28T01:30:00')), HOUR);
  assert.equal(nextWallClockDelay(config, at('2026-07-28T02:29:00')), 60_000);
  // 已经过了今天的点，就排到明天，绝不返回 0 或负数导致空转。
  assert.equal(nextWallClockDelay(config, at('2026-07-28T02:30:00')), 24 * HOUR);
  assert.equal(nextWallClockDelay(config, at('2026-07-28T23:30:00')), 3 * HOUR);
  for (let hour = 0; hour < 24; hour++) {
    for (const minute of [0, 29, 30, 31, 59]) {
      const stamp = `2026-07-28T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:45`;
      const delay = nextWallClockDelay(config, at(stamp));
      assert.ok(delay > 0 && delay <= 24 * HOUR, `delay out of range at ${stamp}: ${delay}`);
    }
  }
});

test('normalizeDiaryConfig defaults to disabled with safe bounds', () => {
  const config = normalizeDiaryConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.atHour, 2);
  assert.equal(config.targetOffsetDays, 1);
  assert.equal(config.source, 'hub-rollup');
  assert.equal(config.extractAttempts, 2);
  assert.equal(normalizeDiaryConfig({ enabled: true }).enabled, true);
  assert.equal(normalizeDiaryConfig({ extractAttempts: 1 }).extractAttempts, 1);
  assert.throws(() => normalizeDiaryConfig({ extractAttempts: 0 }), /diary\.extractAttempts/);
  assert.throws(() => normalizeDiaryConfig({ atHour: 24 }), /diary\.atHour/);
  assert.throws(() => normalizeDiaryConfig({ maxEntries: 0 }), /diary\.maxEntries/);
  assert.throws(() => normalizeDiaryConfig([]), /diary must be an object/);
});

test('parseDiaryEntries rejects anything it cannot vouch for', () => {
  assert.throws(() => parseDiaryEntries({}), /entries array/);
  assert.throws(() => parseDiaryEntries({ entries: [{ time: '9:00', text: 'x' }] }), /HH:MM/);
  assert.throws(() => parseDiaryEntries({ entries: [{ time: '24:00', text: 'x' }] }), /HH:MM/);
  assert.throws(() => parseDiaryEntries({ entries: [{ time: '09:00', text: '  ' }] }), /non-empty/);
  assert.throws(() => parseDiaryEntries({ entries: ['09:00 起床'] }), /must be an object/);
  assert.deepEqual(parseDiaryEntries({ entries: [] }), []);
});

test('parseDiaryEntries sorts, dedupes, and caps', () => {
  const entries = parseDiaryEntries({
    entries: [
      { time: '18:20', text: '晚上给寿司剪指甲' },
      { time: '08:05', text: 'User  早上洗了\n两只大型犬' },
      { time: '08:40', text: '晚上给寿司剪指甲' },
    ],
  }, { maxEntries: 5 });
  assert.deepEqual(entries, [
    { time: '08:05', text: 'User 早上洗了 两只大型犬' },
    { time: '18:20', text: '晚上给寿司剪指甲' },
  ]);

  const capped = parseDiaryEntries({
    entries: Array.from({ length: 12 }, (_, i) => ({
      time: `0${i % 10}:00`,
      text: `第 ${i} 件事`,
    })),
  }, { maxEntries: 3 });
  assert.equal(capped.length, 3);
});

test('shanghaiWeekday resolves the local weekday', () => {
  assert.equal(shanghaiWeekday('2026-07-28'), '周二');
  assert.equal(shanghaiWeekday('2026-07-26'), '周日');
  assert.equal(shanghaiWeekday('not-a-date'), null);
});

test('buildTranscript drops AI replies before it drops User', () => {
  const messages = [
    { at: '09:00', role: 'user', contactName: 'Claude', content: 'a'.repeat(100) },
    { at: '09:01', role: 'assistant', contactName: 'Claude', content: 'b'.repeat(400) },
    { at: '09:02', role: 'user', contactName: 'Claude', content: 'c'.repeat(100) },
  ];
  const full = buildTranscript(messages, { maxChars: 10_000 });
  assert.equal(full.dropped, 'none');
  assert.ok(full.text.includes('b'.repeat(400)));

  const trimmed = buildTranscript(messages, { maxChars: 300 });
  assert.equal(trimmed.dropped, 'assistant');
  assert.ok(!trimmed.text.includes('b'.repeat(400)));
  assert.ok(trimmed.text.includes('a'.repeat(100)));
  assert.ok(trimmed.text.includes('c'.repeat(100)));

  const truncated = buildTranscript(messages, { maxChars: 120 });
  assert.equal(truncated.dropped, 'assistant+tail');
  assert.ok(truncated.text.includes('已截断'));
});

test('buildTranscript marks who said what so extraction cannot mix them up', () => {
  const { text } = buildTranscript([
    { at: '12:00', role: 'user', contactName: 'Codex', content: '洗了两只大型犬' },
    { at: '12:01', role: 'assistant', contactName: 'Codex', content: '辛苦了' },
    { at: '12:02', role: 'user', contactName: 'Codex', content: '很长的一段', clipped: true },
  ]);
  assert.equal(text.split('\n')[0], '12:00 | role=user | User → Codex: 洗了两只大型犬');
  assert.equal(text.split('\n')[1], '12:01 | role=assistant | Codex: 辛苦了');
  assert.ok(text.split('\n')[2].endsWith('…(截断)'));
});

function stubs({ messages, entries = [], truncated = false }) {
  const written = [];
  return {
    written,
    hub: { journalDay: async () => ({ date: '2026-07-27', truncated, messages }) },
    deepseek: {
      calls: 0,
      async diaryEntries() {
        this.calls += 1;
        return { result: entries, costCny: 0.0004, latencyMs: 900 };
      },
    },
    vault: { logDaily: async (input) => { written.push(input); } },
  };
}

const config = normalizeDiaryConfig({ enabled: true, source: 'hub-rollup' });

test('rollupDay skips thin days before spending a token', async () => {
  const s = stubs({ messages: [{ at: '09:00', role: 'user', content: '在吗' }] });
  const result = await rollupDay({ date: '2026-07-27', ...s, config });
  assert.equal(result.status, 'thin');
  assert.equal(result.written, 0);
  assert.equal(result.costCny, 0);
  assert.equal(s.deepseek.calls, 0, '没到门槛就不该调用模型');
  assert.deepEqual(s.written, []);
});

test('rollupDay treats a day with no diary-worthy content as empty, not an error', async () => {
  const messages = Array.from({ length: 8 }, (_, i) => ({
    at: `1${i}:00`,
    role: i % 2 ? 'assistant' : 'user',
    contactName: 'Claude',
    content: `纯工程讨论 ${i}`,
  }));
  const result = await rollupDay({ date: '2026-07-27', ...stubs({ messages }), config });
  assert.equal(result.status, 'empty');
  assert.equal(result.written, 0);
  assert.ok(result.costCny > 0, '模型跑过了，成本要如实记账');
});

test('rollupDay writes each entry with its own Shanghai date and time', async () => {
  const messages = Array.from({ length: 8 }, (_, i) => ({
    at: `0${i}:00`,
    role: i % 2 ? 'assistant' : 'user',
    contactName: 'Claude',
    content: `第 ${i} 条`,
  }));
  const s = stubs({
    messages,
    entries: [
      { time: '08:05', text: 'User 早上洗了两只大型犬' },
      { time: '22:40', text: 'User 晚上小腹疼' },
    ],
  });
  const result = await rollupDay({ date: '2026-07-27', ...s, config });
  assert.equal(result.status, 'written');
  assert.equal(result.written, 2);
  assert.deepEqual(s.written, [
    { content: 'User 早上洗了两只大型犬', date: '2026-07-27', time: '08:05', source: 'hub-rollup' },
    { content: 'User 晚上小腹疼', date: '2026-07-27', time: '22:40', source: 'hub-rollup' },
  ]);
});

test('rollupDay dry run reports entries without touching the vault', async () => {
  const messages = Array.from({ length: 8 }, (_, i) => ({
    at: `0${i}:00`,
    role: i % 2 ? 'assistant' : 'user',
    contactName: 'Claude',
    content: `第 ${i} 条`,
  }));
  const s = stubs({ messages, entries: [{ time: '08:05', text: '起床喂猫' }] });
  const result = await rollupDay({ date: '2026-07-27', ...s, config, dryRun: true });
  assert.equal(result.status, 'written');
  assert.equal(result.entries.length, 1);
  assert.equal(result.written, 0);
  assert.deepEqual(s.written, [], 'dry run 不允许写 vault');
});

test('rollupDay rejects a malformed extraction instead of writing part of it', async () => {
  const messages = Array.from({ length: 8 }, (_, i) => ({
    at: `0${i}:00`,
    role: i % 2 ? 'assistant' : 'user',
    contactName: 'Claude',
    content: `第 ${i} 条`,
  }));
  const s = stubs({
    messages,
    entries: [{ time: '08:05', text: '好的条目' }, { time: '晚上', text: '坏的条目' }],
  });
  await assert.rejects(
    rollupDay({ date: '2026-07-27', ...s, config }),
    /HH:MM/,
  );
  assert.deepEqual(s.written, [], '整批拒绝，不能只写通过校验的那半截');
});

test('the retry actually resamples instead of asking for the same tokens again', async () => {
  const client = new DeepSeekClient({ apiKeyEnv: 'DIARY_TEST_KEY' }, ['other']);
  const calls = [];
  client.callJson = async (model, system, user, pricing, maxTokens, options) => {
    calls.push({ maxTokens, temperature: options?.temperature });
    return { result: { entries: [] }, usage: {}, costCny: 0, latencyMs: 1 };
  };

  await client.diaryEntries({ date: '2026-07-25', transcript: 'x' });
  await client.diaryEntries({ date: '2026-07-25', transcript: 'x', attempt: 2 });

  assert.deepEqual(calls[0], { maxTokens: 1200, temperature: 0 }, '首次求稳定复现');
  assert.notEqual(
    calls[1].temperature,
    calls[0].temperature,
    'temperature 0 重试会原样再吐一遍同一份坏 JSON，那不叫重试'
  );
  assert.ok(calls[1].maxTokens > calls[0].maxTokens, '重试同时放宽长度，排除截断这一路');
});

test('a broken extraction reports the raw body, not just an offset', async () => {
  // 生产 2026-07-25 的形态：未转义引号把 text 提前闭合，后面的字无处安放。
  // 走真实 HTTP + 真实解析路径，否则测的只是我自己编的报错字符串。
  const broken = '{"entries":[{"time":"21:42","text":"User 说"好吃"然后又点了一份"}]}';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: broken } }], usage: {} }));
  });
  await listenOnFetchSafePort(server);
  process.env.DIARY_TEST_KEY = 'test-only';
  try {
    const client = new DeepSeekClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKeyEnv: 'DIARY_TEST_KEY',
    }, ['other']);
    await assert.rejects(
      client.diaryEntries({ date: '2026-07-25', transcript: 'x' }),
      (error) => {
        assert.match(error.message, /raw:/, '报错必须带上原文，否则事后只能靠 position 猜成因');
        assert.match(error.message, /User 说/, '原文片段要能看出坏在哪一句');
        assert.match(error.message, /position/, '原始的 JSON 报错也要保留');
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.DIARY_TEST_KEY;
  }
});

test('an oversized broken body is clipped and labelled with its real length', async () => {
  const broken = `{"entries":[{"time":"21:42","text":"${'长'.repeat(900)}"x"}]}`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: broken } }], usage: {} }));
  });
  await listenOnFetchSafePort(server);
  process.env.DIARY_TEST_KEY = 'test-only';
  try {
    const client = new DeepSeekClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      apiKeyEnv: 'DIARY_TEST_KEY',
    }, ['other']);
    await assert.rejects(
      client.diaryEntries({ date: '2026-07-25', transcript: 'x' }),
      (error) => {
        assert.ok(error.message.length < 900, '日志片段不能把整份坏正文原样倒进去');
        assert.match(error.message, /…\(共 \d+ 字\)/, '截断了就要说明原文多长');
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.DIARY_TEST_KEY;
  }
});

test('rollupDay retries one bad extraction before giving the day up', async () => {
  const messages = Array.from({ length: 8 }, (_, i) => ({
    at: `0${i}:00`,
    role: i % 2 ? 'assistant' : 'user',
    contactName: 'Claude',
    content: `第 ${i} 条`,
  }));
  const written = [];
  let calls = 0;
  const deepseek = {
    async diaryEntries() {
      calls += 1;
      // 生产 2026-07-25 就是这样丢掉的：热闹的一天 Flash 吐了带未转义引号的 JSON。
      if (calls === 1) throw new SyntaxError("Expected ',' or '}' after property value in JSON");
      return { result: [{ time: '21:42', text: '晚上吃了三文鱼和抹茶芋圆西米露' }], costCny: 0.002, latencyMs: 800 };
    },
  };
  const result = await rollupDay({
    date: '2026-07-25',
    hub: { journalDay: async () => ({ date: '2026-07-25', truncated: false, messages }) },
    deepseek,
    vault: { logDaily: async (input) => { written.push(input); } },
    config,
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'written');
  assert.equal(written.length, 1);
  assert.equal(written[0].date, '2026-07-25');

  // 两次都坏就如实失败，不能把空日记当成「这天没事」。
  let always = 0;
  await assert.rejects(rollupDay({
    date: '2026-07-25',
    hub: { journalDay: async () => ({ date: '2026-07-25', truncated: false, messages }) },
    deepseek: { async diaryEntries() { always += 1; throw new SyntaxError('still broken'); } },
    vault: { logDaily: async () => {} },
    config,
  }), /still broken/);
  assert.equal(always, 2);
});

test('diary delivery pool is its own bucket', () => {
  assert.equal(DELIVERY_POOL_DIARY, 'diary');
});
