import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type ContactRow, type MessageRow } from '../src/db.js';
import { WechatChannel } from '../src/wechat/channel.js';
import { loadWechatChannelConfig, type WechatChannelConfig } from '../src/wechat/config.js';
import { downloadWechatImage, parseWechatAesKey } from '../src/wechat/media.js';
import { WechatApiClient, WECHAT_ITEM_TYPE, WECHAT_MESSAGE_TYPE } from '../src/wechat/protocol.js';
import { routeWechatInput } from '../src/wechat/routing.js';

assert.deepEqual(routeWechatInput('Claude 你好', null), {
  targetId: 'claude',
  text: '你好',
  explicit: true,
});
assert.deepEqual(routeWechatInput('/Codex：看这里', null), {
  targetId: 'codex',
  text: '看这里',
  explicit: true,
});
assert.equal(
  routeWechatInput('继续', { targetId: 'aye', touchedAt: 1_000 }, 1_000 + 30 * 60_000)?.targetId,
  'aye',
);
assert.equal(
  routeWechatInput('继续', { targetId: 'aye', touchedAt: 1_000 }, 1_000 + 30 * 60_000 + 1),
  null,
);

assert.throws(() => loadWechatChannelConfig(os.tmpdir(), {
  WECHAT_CHANNEL_ENABLED: 'true',
} as NodeJS.ProcessEnv), /WECHAT_BOT_TOKEN/);
const parsedConfig = loadWechatChannelConfig(os.tmpdir(), {
  WECHAT_CHANNEL_ENABLED: 'true',
  WECHAT_BOT_TOKEN: 'secret-token',
  WECHAT_BOT_ID: 'bot@im.bot',
  WECHAT_ALLOW_FROM: 'User-id, second-id',
  WECHAT_STATE_FILE: path.join(os.tmpdir(), 'wechat-config-test.json'),
  WECHAT_LONG_POLL_MS: '999999',
} as NodeJS.ProcessEnv);
assert.equal(parsedConfig.enabled, true);
assert.deepEqual([...parsedConfig.allowFrom], ['User-id', 'second-id']);
assert.equal(parsedConfig.longPollMs, 60_000);

const requests: Array<{ url: string; init: RequestInit; body: any }> = [];
const protocolFetch: typeof fetch = async (input, init) => {
  requests.push({
    url: String(input),
    init: init ?? {},
    body: JSON.parse(String(init?.body ?? '{}')),
  });
  return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
};
const protocol = new WechatApiClient({
  baseUrl: 'https://ilinkai.weixin.qq.com',
  token: 'secret-token',
  fetchImpl: protocolFetch,
});
await protocol.sendText({
  to: 'User-id',
  text: '[Claude] hello',
  contextToken: 'context-token',
  clientId: 'stable-client-id',
});
assert.equal(requests[0].url, 'https://ilinkai.weixin.qq.com/ilink/bot/sendmessage');
const headers = requests[0].init.headers as Record<string, string>;
assert.equal(headers.Authorization, 'Bearer secret-token');
assert.equal(headers.AuthorizationType, 'ilink_bot_token');
assert.equal(headers['iLink-App-Id'], 'bot');
assert.equal(requests[0].body.msg.client_id, 'stable-client-id');
assert.equal(requests[0].body.msg.context_token, 'context-token');
assert.equal(requests[0].body.base_info.bot_agent, 'ai-hub/0.1.0');

const imageKey = crypto.randomBytes(16);
assert.deepEqual(parseWechatAesKey(imageKey.toString('base64')), imageKey);
assert.deepEqual(
  parseWechatAesKey(Buffer.from(imageKey.toString('hex'), 'ascii').toString('base64')),
  imageKey,
);
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const cipher = crypto.createCipheriv('aes-128-ecb', imageKey, null);
const encryptedPng = Buffer.concat([cipher.update(png), cipher.final()]);
let requestedMediaUrl = '';
const mediaFetch: typeof fetch = async (input) => {
  requestedMediaUrl = String(input);
  return new Response(encryptedPng, {
    status: 200,
    headers: { 'content-length': String(encryptedPng.length) },
  });
};
const decrypted = await downloadWechatImage({
  type: WECHAT_ITEM_TYPE.image,
  image_item: {
    aeskey: imageKey.toString('hex'),
    media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?id=test' },
  },
}, 'https://novac2c.cdn.weixin.qq.com/c2c', mediaFetch);
assert.deepEqual(decrypted, { bytes: png, mimeType: 'image/png' });
assert.equal(requestedMediaUrl, 'https://novac2c.cdn.weixin.qq.com/c2c/download?id=test');

await downloadWechatImage({
  type: WECHAT_ITEM_TYPE.image,
  image_item: {
    aeskey: imageKey.toString('hex'),
    media: { encrypt_query_param: 'signed-value' },
  },
}, 'https://novac2c.cdn.weixin.qq.com/c2c', mediaFetch);
assert.equal(
  requestedMediaUrl,
  'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=signed-value',
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-wechat-channel-'));
const db = openDb(path.join(tempDir, 'hub.db'));
const uploadsDir = path.join(tempDir, 'uploads');
const sent: Array<{ to: string; text: string; clientId: string }> = [];
const fakeApi = {
  async notifyStart() {},
  async notifyStop() {},
  async getUpdates() { return { ret: 0, msgs: [] }; },
  async getTypingTicket() { return null; },
  async sendTyping() {},
  async sendText(input: { to: string; text: string; clientId: string }) {
    sent.push(input);
  },
};
const broadcasts: unknown[] = [];

try {
  for (const [id, name] of [['claude', 'Claude'], ['codex', 'Codex'], ['aye', '阿野']]) {
    db.prepare(
      "INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, 'api', 'dm', '{}')",
    ).run(id, name);
  }
  const manager = {
    get(contact: ContactRow) {
      return {
        enqueueTracked(input: { userMessageId: number; text: string }) {
          const result = db.prepare(
            `INSERT INTO messages
             (contact_id, sender, role, kind, content, status, turn_id, meta, origin)
             VALUES (?, ?, 'assistant', 'text', ?, 'done', 'turn-test', ?, 'main')`,
          ).run(
            contact.id,
            contact.id,
            `收到：${input.text}`,
            JSON.stringify({ replyToMessageId: input.userMessageId }),
          );
          return {
            status: 'queued' as const,
            completion: Promise.resolve({
              outcome: 'done' as const,
              text: `收到：${input.text}`,
              messageId: Number(result.lastInsertRowid),
            }),
          };
        },
      };
    },
  };
  const config: WechatChannelConfig = {
    enabled: true,
    token: 'secret-token',
    botId: 'bot@im.bot',
    allowFrom: new Set(['User-id']),
    baseUrl: 'https://ilinkai.weixin.qq.com',
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    stateFile: path.join(tempDir, 'wechat-state.json'),
    longPollMs: 35_000,
  };
  const channel = new WechatChannel({
    config,
    db,
    uploadsDir,
    manager: manager as any,
    sse: { broadcast: (_event: string, data: unknown) => broadcasts.push(data) } as any,
    logger: { info() {}, warn() {}, error() {} } as any,
    api: fakeApi as any,
    fetchImpl: mediaFetch,
  });
  const inbound = (overrides: Record<string, unknown>) => ({
    message_id: 1,
    from_user_id: 'User-id',
    to_user_id: 'bot@im.bot',
    message_type: WECHAT_MESSAGE_TYPE.user,
    context_token: 'context-token',
    item_list: [{ type: WECHAT_ITEM_TYPE.text, text_item: { text: 'Claude 你好' } }],
    ...overrides,
  });

  await (channel as any).handleInbound(inbound({}));
  let rows = db.prepare("SELECT * FROM messages WHERE role = 'user' ORDER BY id").all() as MessageRow[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].contact_id, 'claude');
  assert.equal(rows[0].content, '你好');
  assert.equal(sent.at(-1)?.text, '[Claude] 收到：你好');
  assert.equal(JSON.parse(rows[0].meta).wechat.status, 'sent');

  const beforeDuplicate = sent.length;
  await (channel as any).handleInbound(inbound({}));
  assert.equal(sent.length, beforeDuplicate, 'same platform message is not sent twice');

  await (channel as any).handleInbound(inbound({
    message_id: 2,
    item_list: [{ type: WECHAT_ITEM_TYPE.text, text_item: { text: '继续' } }],
  }));
  rows = db.prepare("SELECT * FROM messages WHERE role = 'user' ORDER BY id").all() as MessageRow[];
  assert.equal(rows[1].contact_id, 'claude', '30-minute sticky target is reused');

  (channel as any).state.sticky.touchedAt = Date.now() - 30 * 60_000 - 1;
  await (channel as any).handleInbound(inbound({
    message_id: 3,
    item_list: [{ type: WECHAT_ITEM_TYPE.text, text_item: { text: '该发谁' } }],
  }));
  assert.equal(sent.at(-1)?.text, '发给谁？Claude / Codex / 阿野');

  const beforeUnauthorized = sent.length;
  await (channel as any).handleInbound(inbound({ message_id: 4, from_user_id: 'stranger' }));
  assert.equal(sent.length, beforeUnauthorized, 'non-whitelisted sender is silently dropped');

  await (channel as any).handleInbound(inbound({
    message_id: 5,
    item_list: [
      { type: WECHAT_ITEM_TYPE.text, text_item: { text: '阿野' } },
      { type: WECHAT_ITEM_TYPE.voice, voice_item: {} },
    ],
  }));
  assert.equal(sent.at(-1)?.text, '暂时听不懂语音，打字吧');

  await (channel as any).handleInbound(inbound({
    message_id: 6,
    item_list: [
      { type: WECHAT_ITEM_TYPE.text, text_item: { text: 'Codex 看图' } },
      {
        type: WECHAT_ITEM_TYPE.image,
        image_item: {
          aeskey: imageKey.toString('hex'),
          media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?id=image' },
        },
      },
    ],
  }));
  const imageUser = db.prepare(
    "SELECT * FROM messages WHERE role = 'user' AND contact_id = 'codex' ORDER BY id DESC LIMIT 1",
  ).get() as MessageRow;
  assert.equal(imageUser.content, '看图');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM message_attachments WHERE message_id = ?')
      .get(imageUser.id) as { count: number }).count,
    1,
  );
  assert.equal(sent.at(-1)?.text, '[Codex] 收到：看图');
  assert.ok(broadcasts.length >= 3, 'accepted hub messages are visible over SSE');
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const loopStateFile = path.join(tempDir, 'loop-state.json');
let loopPolls = 0;
let notifyStarts = 0;
let notifyStops = 0;
const loopApi = {
  async notifyStart() { notifyStarts++; },
  async notifyStop() { notifyStops++; },
  async getUpdates(_cursor: string, _timeout: number, signal: AbortSignal) {
    loopPolls++;
    if (loopPolls === 1) {
      return {
        ret: 0,
        msgs: [{
          message_id: 99,
          from_user_id: 'stranger',
          to_user_id: 'bot@im.bot',
          message_type: WECHAT_MESSAGE_TYPE.user,
        }],
        get_updates_buf: 'cursor-after-batch',
      };
    }
    return await new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({
        ret: 0,
        msgs: [],
        get_updates_buf: 'cursor-after-batch',
      }), { once: true });
    });
  },
};
const loopChannel = new WechatChannel({
  config: {
    enabled: true,
    token: 'secret-token',
    botId: 'bot@im.bot',
    allowFrom: new Set(['User-id']),
    baseUrl: 'https://ilinkai.weixin.qq.com',
    cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
    stateFile: loopStateFile,
    longPollMs: 35_000,
  },
  db: {} as any,
  uploadsDir,
  manager: {} as any,
  sse: {} as any,
  logger: { info() {}, warn() {}, error() {} } as any,
  api: loopApi as any,
});
loopChannel.start();
for (let attempt = 0; attempt < 100 && !fs.existsSync(loopStateFile); attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
assert.equal(JSON.parse(fs.readFileSync(loopStateFile, 'utf8')).cursor, 'cursor-after-batch');
assert.equal(loopChannel.status().running, true);
await loopChannel.stop();
assert.equal(loopChannel.status().running, false);
assert.equal(notifyStarts, 1);
assert.equal(notifyStops, 1);
assert.ok(loopPolls >= 2, 'poll loop resumes after persisting the batch cursor');
fs.rmSync(tempDir, { recursive: true, force: true });

console.log('wechat channel routing, protocol, media, allow-list, and bridge tests passed');
