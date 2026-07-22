import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DirectApiBackend,
  IMAGE_OMITTED_PLACEHOLDER,
  defaultSupportsImages,
} from '../src/agents/directApi.js';
import { openDb } from '../src/db.js';

// --- 纯能力推断：provider + model 名 ---
assert.equal(defaultSupportsImages('anthropic', 'claude-x'), true, 'anthropic 默认多模态');
assert.equal(defaultSupportsImages('gemini', 'gemini-2'), true, 'gemini 默认多模态');
assert.equal(defaultSupportsImages('openai-compat', 'gpt-4o'), true, 'gpt-4o 是多模态');
assert.equal(defaultSupportsImages('openai-compat', 'qwen3-vl-plus'), true, '*-vl 视为多模态');
assert.equal(defaultSupportsImages('openai-compat', 'glm-4v-plus'), true, '*-4v 视为多模态');
assert.equal(defaultSupportsImages('openai-compat', 'deepseek-v4-pro'), false, 'deepseek 纯文字');
assert.equal(defaultSupportsImages('openai-compat', 'deepseek-chat'), false, 'deepseek 纯文字');
assert.equal(defaultSupportsImages('openai-compat', 'deepseek-vl-7b'), true, 'deepseek-vl 显式视觉标记放行');
assert.equal(defaultSupportsImages('openai-compat', 'glm-4-plus'), true, '未知 openai-compat 保持发图');

// --- 集成：组装后的 messages 对纯文字模型无 image_url ---
const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.image-capability-smoke.db');
const uploadsDir = path.join(here, '.image-capability-smoke-uploads');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
fs.rmSync(uploadsDir, { recursive: true, force: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const requests: Array<{ url: string; body: any }> = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    requests.push({ url: req.url ?? '', body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
const port = await new Promise<number>((resolve) =>
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
);

const db = openDb(dbPath);
const consume = async (backend: DirectApiBackend, input: { text: string; userMessageId?: number }) => {
  for await (const _event of backend.sendTurn(input).events) {
    /* drain the turn */
  }
};
const imageParts = (body: any): any[] =>
  (body.messages ?? [])
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((part: any) => part?.type === 'image_url');
const bodyText = (body: any): string =>
  (body.messages ?? [])
    .map((m: any) =>
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')
          : ''
    )
    .join('\n');

try {
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room', 'Room', 'api', 'room', '{}')`).run();
  // 群聊历史：用户发的一条带手机截图的消息（重现「小巷」场景）
  const imgMsg = Number(
    db
      .prepare(
        `INSERT INTO messages (contact_id, sender, role, kind, content, status) VALUES ('room', 'user', 'user', 'text', '手机截图', 'done')`
      )
      .run().lastInsertRowid
  );
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  fs.writeFileSync(path.join(uploadsDir, 'alley.png'), bytes);
  db.prepare(
    `INSERT INTO message_attachments (message_id, stored_name, original_name, mime_type, size) VALUES (?, 'alley.png', 'alley.png', 'image/png', ?)`
  ).run(imgMsg, bytes.length);

  const common = {
    apiKey: 'test',
    systemPrompt: '',
    memoryPreamble: '',
    maxHistoryMessages: 20,
    historyTokenBudget: 4096,
    minRecentTurns: 1,
    summaryMaxTokens: 256,
    historySummaryStrategy: 'extractive' as const,
    maxTokens: 64,
    contextWindowTokens: 128_000,
    turnTimeoutMs: 5000,
    db,
    uploadsDir,
    provider: 'openai-compat' as const,
    baseUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
    contactId: 'room',
    memberId: 'deepseek-member',
    roomMode: { selfId: 'deepseek-member', nameOf: (s: string) => (s === 'user' ? 'Iris' : s) },
    log: () => {},
  };
  const roomTurn = { text: '（群里有新消息，见对话历史。）' };

  // 1) 纯文字 deepseek：图片被剥离、留占位、模型名不变
  const deepseek = new DirectApiBackend({ ...common, model: 'deepseek-v4-pro' });
  await deepseek.start(null);
  await consume(deepseek, roomTurn);
  const dsBody = requests.at(-1)!.body;
  assert.equal(dsBody.model, 'deepseek-v4-pro', '纯文字模型不应被替换');
  assert.equal(imageParts(dsBody).length, 0, 'deepseek 请求不得含 image_url');
  assert(!JSON.stringify(dsBody).includes('base64'), '不得把图片 base64 塞进上游请求');
  assert(bodyText(dsBody).includes(IMAGE_OMITTED_PLACEHOLDER), '应保留图片省略占位');

  // 2) 显式 supportsImages=true 覆盖纯文字默认（真多模态 deepseek 变体等）
  const forced = new DirectApiBackend({ ...common, model: 'deepseek-v4-pro', supportsImages: true });
  await forced.start(null);
  await consume(forced, roomTurn);
  assert(imageParts(requests.at(-1)!.body).length > 0, 'supportsImages=true 应强制发图');

  // 3) 配了 visionModel：含图回合切到图片模型且携带图片（原行为不回归）
  const vision = new DirectApiBackend({ ...common, model: 'deepseek-v4-pro', visionModel: 'qwen3-vl-plus' });
  await vision.start(null);
  await consume(vision, roomTurn);
  const vBody = requests.at(-1)!.body;
  assert.equal(vBody.model, 'qwen3-vl-plus', '含图回合应切到图片模型');
  assert(imageParts(vBody).length > 0, '图片模型请求应携带 image_url');

  // 4) 未知多模态 openai-compat 模型默认继续发图
  const glm = new DirectApiBackend({ ...common, model: 'glm-4-plus' });
  await glm.start(null);
  await consume(glm, roomTurn);
  assert(imageParts(requests.at(-1)!.body).length > 0, '未知 openai-compat 模型默认应发图');

  console.log('image capability smoke: ok');
} finally {
  db.close();
  server.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.rmSync(uploadsDir, { recursive: true, force: true });
}
