import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { claudePermissionDecision, claudeTurnText } from '../src/agents/claudeCli.js';
import { codexTurnInput } from '../src/agents/codexAppServer.js';
import { DirectApiBackend } from '../src/agents/directApi.js';
import { attachmentPathsForMessages } from '../src/attachments.js';
import { openDb } from '../src/db.js';
import { attachmentsRouter } from '../src/routes/attachments.js';
import { messagesRouter } from '../src/routes/messages.js';
import { SseHub } from '../src/sse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.images-smoke.db');
const uploadsDir = path.join(here, '.images-smoke-uploads');
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
    if (req.url?.includes('/chat/completions')) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '看到了图片' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
    } else {
      res.write(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '看到了图片' } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })}\n\n`);
    }
    res.end();
  });
});
const port = await new Promise<number>((resolve) =>
  server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
);

const db = openDb(dbPath);
const consume = async (backend: DirectApiBackend, input: { text: string; userMessageId?: number }) => {
  const events = [];
  for await (const event of backend.sendTurn(input).events) events.push(event);
  assert(events.some((event) => event.type === 'done'), '多模态回合应正常完成');
};

try {
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('dm', 'DM', 'api', 'dm', '{}')`).run();
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room', 'Room', 'api', 'room', '{}')`).run();
  const addMessage = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status) VALUES (?, 'user', 'user', 'text', ?, 'done')`
  );
  const addImage = (messageId: number, name: string) => {
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
    fs.writeFileSync(path.join(uploadsDir, name), bytes);
    db.prepare(
      `INSERT INTO message_attachments (message_id, stored_name, original_name, mime_type, size) VALUES (?, ?, ?, 'image/png', ?)`
    ).run(messageId, name, name, bytes.length);
  };

  const dmId = Number(addMessage.run('dm', '这张图里是什么？').lastInsertRowid);
  addImage(dmId, 'dm.png');
  const dmImagePaths = attachmentPathsForMessages(db, uploadsDir, [dmId]);
  assert.deepEqual(dmImagePaths, [path.resolve(uploadsDir, 'dm.png')]);
  assert.deepEqual(codexTurnInput('看图', dmImagePaths), [
    { type: 'text', text: '看图' },
    { type: 'localImage', path: path.resolve(uploadsDir, 'dm.png') },
  ]);
  const claudeInput = claudeTurnText('看图', dmImagePaths);
  assert(claudeInput.includes(path.resolve(uploadsDir, 'dm.png')));
  assert(claudeInput.includes('使用 Read 工具'));
  assert.deepEqual(
    claudePermissionDecision(
      { tool_name: 'Read', input: { file_path: dmImagePaths[0] } },
      dmImagePaths
    ),
    { behavior: 'allow', updatedInput: { file_path: dmImagePaths[0] } }
  );
  assert.equal(
    claudePermissionDecision(
      { tool_name: 'Read', input: { file_path: path.resolve(uploadsDir, 'other.png') } },
      dmImagePaths
    ).behavior,
    'deny'
  );
  assert.equal(
    claudePermissionDecision(
      { tool_name: 'Bash', input: { command: 'cat image.png' } },
      dmImagePaths
    ).behavior,
    'deny'
  );
  const common = {
    apiKey: 'test', model: 'text-test', visionModel: 'vision-test', systemPrompt: '', memoryPreamble: '',
    maxHistoryMessages: 20, historyTokenBudget: 4096, minRecentTurns: 1,
    summaryMaxTokens: 256, historySummaryStrategy: 'extractive' as const,
    maxTokens: 64, turnTimeoutMs: 5000, db, uploadsDir, log: () => {},
  };
  const openai = new DirectApiBackend({
    ...common, provider: 'openai-compat', baseUrl: `http://127.0.0.1:${port}`, contactId: 'dm',
  });
  await openai.start(null);
  await consume(openai, { text: '这张图里是什么？', userMessageId: dmId });
  const openaiContent = requests[0].body.messages.at(-1).content;
  assert(Array.isArray(openaiContent), 'OpenAI 图片消息应使用 content parts');
  assert.equal(requests[0].body.model, 'vision-test', '含图回合应切到独立图片模型');
  assert(openaiContent.some((part: any) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,')));

  const roomId = Number(addMessage.run('room', '订单截图').lastInsertRowid);
  addImage(roomId, 'room.png');
  const anthropic = new DirectApiBackend({
    ...common, provider: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, contactId: 'room', memberId: 'api-member',
    roomMode: { selfId: 'api-member', nameOf: (sender: string) => sender === 'user' ? 'User' : sender },
  });
  await anthropic.start(null);
  await consume(anthropic, { text: '（群里有新消息，见对话历史。）' });
  const anthropicImage = requests[1].body.messages
    .flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
    .find((part: any) => part.type === 'image');
  assert.equal(anthropicImage?.source?.media_type, 'image/png');
  assert(anthropicImage?.source?.data, 'Anthropic 图片应以内联 base64 source 发送');

  const events = new SseHub();
  let imageRoomMembersCalls = 0;
  let dispatchedRoomTargets: any[] | undefined;
  const imageMembers = [
    { id: 'codex-member', name: 'Codex', backend: 'codex' },
    { id: 'claude-member', name: 'Claude', backend: 'claude-cli' },
  ];
  const fakeManager = {
    get: () => ({ enqueue: () => 'queued' }),
    parseTargets: () => [],
    imageRoomMembers: () => {
      imageRoomMembersCalls++;
      return imageMembers;
    },
    dispatchRoomMessage: (_room: any, _content: string, targets?: any[]) => {
      dispatchedRoomTargets = targets;
      return targets?.map((target) => target.id) ?? [];
    },
    invalidateConversation: async () => {},
    interruptAll: () => {},
    resetConversation: async () => {},
  };
  const app = express();
  app.use(express.json());
  app.use('/api/contacts', messagesRouter(db, events, fakeManager as any, uploadsDir));
  app.use('/api/attachments', attachmentsRouter(db, uploadsDir));
  const uploadServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => uploadServer.once('listening', resolve));
  const uploadPort = (uploadServer.address() as { port: number }).port;
  try {
    const form = new FormData();
    form.set('content', '上传管线测试');
    form.append('images', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'upload.png');
    const uploaded = await fetch(`http://127.0.0.1:${uploadPort}/api/contacts/dm/messages`, { method: 'POST', body: form });
    assert.equal(uploaded.status, 202);
    const { messageId } = await uploaded.json() as { messageId: number };
    const history = await fetch(`http://127.0.0.1:${uploadPort}/api/contacts/dm/messages`).then((res) => res.json()) as any;
    const message = history.messages.find((item: any) => item.id === messageId);
    assert.equal(message.attachments.length, 1, '历史回放应携带附件元数据');
    const imageResponse = await fetch(`http://127.0.0.1:${uploadPort}${message.attachments[0].url}`);
    assert.equal(imageResponse.status, 200, '有效消息的图片端点应可读取');
    assert.equal(imageResponse.headers.get('x-content-type-options'), 'nosniff');
    const deleted = await fetch(`http://127.0.0.1:${uploadPort}/api/contacts/dm/messages/${messageId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const afterDelete = await fetch(`http://127.0.0.1:${uploadPort}${message.attachments[0].url}`);
    assert.equal(afterDelete.status, 404, '消息删除后附件应立即失效并清理');

    for (const [id, backend] of [['codex-dm', 'codex'], ['claude-dm', 'claude-cli']] as const) {
      db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')`)
        .run(id, id, backend);
      const cliForm = new FormData();
      cliForm.set('content', `${backend} 图片`);
      cliForm.append('images', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), `${id}.png`);
      const cliUpload = await fetch(`http://127.0.0.1:${uploadPort}/api/contacts/${id}/messages`, {
        method: 'POST', body: cliForm,
      });
      assert.equal(cliUpload.status, 202, `${backend} 私聊应接受图片上传`);
    }

    const roomForm = new FormData();
    roomForm.append('images', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'room-upload.png');
    const roomUpload = await fetch(`http://127.0.0.1:${uploadPort}/api/contacts/room/messages`, {
      method: 'POST', body: roomForm,
    });
    assert.equal(roomUpload.status, 202, '纯图片群消息应允许全部识图成员参与');
    assert.equal(imageRoomMembersCalls, 1);
    assert.deepEqual(dispatchedRoomTargets, imageMembers);
  } finally {
    uploadServer.close();
    events.close();
  }

  console.log('image multimodal smoke: ok');
} finally {
  db.close();
  server.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.rmSync(uploadsDir, { recursive: true, force: true });
}
