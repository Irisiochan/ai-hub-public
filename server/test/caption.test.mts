import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type ContactRow, type MessageRow } from '../src/db.js';
import { CaptionService, captionsFromMeta } from '../src/captionService.js';
import { historicalMessageText } from '../src/agents/sideChannel.js';
import { journalDay } from '../src/routes/journal.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-'));
const uploadsDir = path.join(dir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const db = openDb(path.join(dir, 'hub.db'));

const addContact = (id: string): ContactRow => {
  db.prepare(`INSERT INTO contacts(id,name,avatar,color,backend,kind,config)
    VALUES(?,?,'x','#000','claude-cli','dm','{}')`).run(id, id);
  return db.prepare('SELECT * FROM contacts WHERE id=?').get(id) as ContactRow;
};
const addMessage = (contactId: string, content: string, meta = '{}'): MessageRow => {
  const r = db.prepare(`INSERT INTO messages(contact_id,sender,role,kind,content,status,meta,origin)
    VALUES(?,'user','user','text',?,'done',?,'main')`).run(contactId, content, meta);
  return db.prepare('SELECT * FROM messages WHERE id=?').get(Number(r.lastInsertRowid)) as MessageRow;
};
const addAttachment = (messageId: number, storedName: string): number => {
  fs.writeFileSync(path.join(uploadsDir, storedName), Buffer.from('fake-image-bytes'));
  const r = db.prepare(`INSERT INTO message_attachments(message_id,stored_name,original_name,mime_type,size)
    VALUES(?,?,?,'image/png',16)`).run(messageId, storedName, storedName);
  return Number(r.lastInsertRowid);
};
const attachmentRow = (id: number) =>
  db.prepare('SELECT caption, caption_status FROM message_attachments WHERE id=?').get(id) as
    { caption: string | null; caption_status: string };

try {
  addContact('claude');
  process.env.CAPTION_API_KEY = 'test-key';
  process.env.CAPTION_API_BASE_URL = 'https://caption.example';

  // 1. 双写一致：附件行 + messages.meta.$.captions，且保留 meta 其余键。
  const msg = addMessage('claude', '这是暴雨的照片', JSON.stringify({ keepMe: 1 }));
  const a1 = addAttachment(msg.id, 'a1.png');
  const a2 = addAttachment(msg.id, 'a2.png');
  let calls = 0;
  const service = new CaptionService(db, uploadsDir, () => {}, async ({ dataUrl }) => {
    calls++;
    assert.match(dataUrl, /^data:image\/png;base64,/);
    return { text: calls === 1 ? '文字内容：已倒灌进室内／画面：客厅积水' : '画面：跳闸的电闸箱', costCny: 0.001 };
  });
  await service.captureMessage(msg.id);
  assert.equal(calls, 2);
  assert.equal(attachmentRow(a1).caption_status, 'done');
  assert.equal(attachmentRow(a1).caption, '文字内容：已倒灌进室内／画面：客厅积水');
  const metaAfter = JSON.parse(
    (db.prepare('SELECT meta FROM messages WHERE id=?').get(msg.id) as { meta: string }).meta
  );
  assert.equal(metaAfter.keepMe, 1);
  assert.deepEqual(metaAfter.captions, [
    '文字内容：已倒灌进室内／画面：客厅积水',
    '画面：跳闸的电闸箱',
  ]);

  // 2. historicalMessageText：主窗用户消息追加 [图片内容：…]；后台回复不受影响。
  const row = db.prepare('SELECT * FROM messages WHERE id=?').get(msg.id) as MessageRow;
  const rendered = historicalMessageText(row);
  assert.match(rendered, /这是暴雨的照片/);
  assert.match(rendered, /\[图片内容：文字内容：已倒灌进室内／画面：客厅积水\]/);
  assert.match(rendered, /\[图片内容：画面：跳闸的电闸箱\]/);
  const sideRow = { ...row, origin: 'side' as const, role: 'assistant' as const };
  assert.doesNotMatch(historicalMessageText(sideRow), /图片内容/);

  // 3. journalDay 输出含转写（消息 created_at 是当前 UTC，即今天的上海日）。
  const today = (db.prepare("SELECT date('now','+8 hours') AS d").get() as { d: string }).d;
  const journal = journalDay(db, today);
  const entry = journal.find((m) => m.id === msg.id);
  assert.ok(entry, 'journalDay should include the captioned message');
  assert.match(entry!.content, /\[图片内容：文字内容：已倒灌进室内／画面：客厅积水\]/);

  // 4. fail-open：captioner 抛错 → failed，消息与 meta 不受影响。
  const failMsg = addMessage('claude', '再来一张');
  const a3 = addAttachment(failMsg.id, 'a3.png');
  const failing = new CaptionService(db, uploadsDir, () => {}, async () => {
    throw new Error('HTTP 500');
  });
  await failing.captureMessage(failMsg.id);
  assert.equal(attachmentRow(a3).caption_status, 'failed');
  assert.equal(attachmentRow(a3).caption, null);
  assert.deepEqual(captionsFromMeta(
    (db.prepare('SELECT meta FROM messages WHERE id=?').get(failMsg.id) as { meta: string }).meta
  ), []);
  assert.equal(
    (db.prepare('SELECT content FROM messages WHERE id=?').get(failMsg.id) as { content: string }).content,
    '再来一张'
  );

  // 5. 成本闸：预留额超过日限 → skipped，不调用 captioner。
  process.env.CAPTION_DAILY_COST_CNY = '0.001';
  process.env.CAPTION_RESERVED_COST_CNY = '0.01';
  const blockedMsg = addMessage('claude', '又一张');
  const a4 = addAttachment(blockedMsg.id, 'a4.png');
  let blockedCalls = 0;
  const blocked = new CaptionService(db, uploadsDir, () => {}, async () => {
    blockedCalls++;
    return { text: 'should not happen' };
  });
  await blocked.captureMessage(blockedMsg.id);
  assert.equal(blockedCalls, 0);
  assert.equal(attachmentRow(a4).caption_status, 'skipped');
  delete process.env.CAPTION_DAILY_COST_CNY;
  delete process.env.CAPTION_RESERVED_COST_CNY;

  // 6. 无 key → skipped（fail-open），不触碰网络。
  delete process.env.CAPTION_API_KEY;
  delete process.env.CAPTION_API_BASE_URL;
  const noKeyMsg = addMessage('claude', '没配 key');
  const a5 = addAttachment(noKeyMsg.id, 'a5.png');
  const noKey = new CaptionService(db, uploadsDir, () => {}, async () => {
    throw new Error('must not be called');
  });
  await noKey.captureMessage(noKeyMsg.id);
  assert.equal(attachmentRow(a5).caption_status, 'skipped');

  // 7. health 端点数据形状。
  const health = new CaptionService(db, uploadsDir).health();
  assert.equal(health.enabled, false);
  assert.ok((health.statusCounts as Record<string, number>).done >= 2);

  console.log('caption S1 checks passed');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
