import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectApiBackend } from '../src/agents/directApi.js';
import { openDb } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.prompt-cache-summary-rollover-smoke.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });

const requests: any[] = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    requests.push(JSON.parse(raw));
    const n = requests.length;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: [{ text: `ack-${n}` }] },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 1200 + n,
        candidatesTokenCount: 3,
        totalTokenCount: 1203 + n,
      },
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
const port = await new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
});

const db = openDb(dbPath);
try {
  db.prepare(
    `INSERT INTO contacts (id, name, backend, kind, config)
     VALUES ('gem-cache-smoke', 'Gem Cache Smoke', 'api', 'dm', '{}')`
  ).run();
  const insert = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status)
     VALUES ('gem-cache-smoke', ?, ?, 'text', ?, 'done')`
  );
  for (let i = 0; i < 12; i++) {
    const assistant = i % 2 === 1;
    insert.run(
      assistant ? 'gem-cache-smoke' : 'user',
      assistant ? 'assistant' : 'user',
      `seed-${i}`
    );
  }

  const logs: string[] = [];
  const backend = new DirectApiBackend({
    provider: 'gemini',
    baseUrl: `http://127.0.0.1:${port}/v1beta/models/{model}:streamGenerateContent?alt=sse`,
    apiKey: 'test-key',
    model: 'gemini-test',
    systemPrompt: 'stable persona + compact memory',
    memoryPreamble: 'compact memory',
    promptCache: 'auto',
    maxHistoryMessages: 10,
    historyTokenBudget: 10_000,
    minRecentTurns: 2,
    summaryMaxTokens: 1000,
    historySummaryStrategy: 'extractive',
    maxTokens: 64,
    turnTimeoutMs: 10_000,
    db,
    uploadsDir: path.join(here, '.prompt-cache-summary-rollover-uploads'),
    contactId: 'gem-cache-smoke',
    log: (line) => logs.push(line),
  });
  await backend.start(null);

  const summaryState = () => db.prepare(
    `SELECT version, through_message_id FROM conversation_summaries
     WHERE contact_id = 'gem-cache-smoke' AND member_id = ''`
  ).get() as { version: number; through_message_id: number };

  const runTurn = async (text: string) => {
    const user = insert.run('user', 'user', text);
    const events: any[] = [];
    for await (const event of backend.sendTurn({
      text,
      userMessageId: Number(user.lastInsertRowid),
    }).events) {
      events.push(event);
    }
    const done = events.find((event) => event.type === 'done');
    assert(done, `${text} 应完成 Gemini mock turn`);
    insert.run('gem-cache-smoke', 'assistant', done.finalText);
    return summaryState();
  };

  const first = await runTurn('turn-one');
  const second = await runTurn('turn-two');
  const third = await runTurn('turn-three');

  assert.equal(requests.length, 3, '应发出三轮 Gemini 请求');
  assert.equal(first.version, second.version, '低水位后下一轮不应立刻重写 summary');
  assert(
    third.version > second.version,
    'recent history 再次越过高水位后才应批量更新 summary'
  );
  assert.deepEqual(
    requests[0].systemInstruction,
    requests[1].systemInstruction,
    'summary version 未变时 systemInstruction 必须逐字节稳定'
  );
  // 当前 user 文本首次发送时不带历史时间锚；下一轮从 DB replay 时会带锚。
  // 因此 provider 真正可复用的 contents 前缀截止到上一轮的 live user 之前。
  const stableContents = requests[0].contents.slice(0, -1);
  assert.deepEqual(
    stableContents,
    requests[1].contents.slice(0, stableContents.length),
    '下一轮 contents 必须保留上一轮 live user 之前的完整请求前缀'
  );
  assert.notDeepEqual(
    requests[1].systemInstruction,
    requests[2].systemInstruction,
    '高水位触发后 summary/systemInstruction 应更新'
  );
  assert(
    logs.some((line) =>
      line.includes('history summary rollover')
      && line.includes('targetMessages=8')
      && line.includes('keepRatio=0.8')
    ),
    `应记录低水位 rollover：${logs.join(' | ')}`
  );

  console.log(JSON.stringify({
    ok: true,
    summaryVersions: [first.version, second.version, third.version],
    stablePrefixTurns: 2,
    stableContentItems: stableContents.length,
    requestContents: requests.map((request) => request.contents.length),
  }));
} finally {
  db.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
}
