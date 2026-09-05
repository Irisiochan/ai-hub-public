import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildCameraTool } from '../src/agents/cameraTool.js';
import { frameAutomatedTurn } from '../src/agents/messageSource.js';
import {
  CompanionHeartbeat,
  HeartbeatError,
  randomHeartbeatIntervalMinutes,
  type HeartbeatStatus,
} from '../src/agents/companionHeartbeat.js';
import type { ContactRow, MessageRow } from '../src/db.js';
import { openDb } from '../src/db.js';
import { loadMigrationFiles } from '../src/migrations.js';
import { workersRouter } from '../src/routes/workers.js';
import { hubMcpRouter } from '../src/routes/hubMcp.js';
import { heartbeatRouter } from '../src/routes/heartbeat.js';
import { CameraSnapBroker } from '../src/workers/cameraSnap.js';
import { JobStore } from '../src/workers/jobStore.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-heartbeat-smoke-'));
const dbPath = path.join(dir, 'data', 'hub.db');
const uploadsDir = path.join(dir, 'uploads');
const framesDir = path.join(path.dirname(dbPath), 'camera-frames');
const db = openDb(dbPath);
const broadcasts: Array<{ event: string; data: any }> = [];
const sse = { broadcast: (event: string, data: unknown) => broadcasts.push({ event, data }) } as any;
const broker = new CameraSnapBroker();
let runtimeState = 'idle';
let enqueueCount = 0;
let scriptedText = 'HEARTBEAT_OK';
let lastTrigger: MessageRow | null = null;
const randomSamples = [0, 0.999999, 0, 0.5];

const manager = {
  statusOf: () => ({ state: runtimeState }),
  get: (_contact: ContactRow) => ({
    enqueueTracked: ({ userMessageId }: { userMessageId: number }) => {
      enqueueCount++;
      lastTrigger = db.prepare('SELECT * FROM messages WHERE id = ?').get(userMessageId) as MessageRow;
      const turnId = `heartbeat-turn-${enqueueCount}`;
      db.prepare(
        `INSERT INTO messages
         (contact_id, sender, role, kind, content, status, turn_id, meta, origin)
         VALUES ('codex', 'codex', 'assistant', 'thinking', 'thinking', 'done', ?, '{}', 'main')`
      ).run(turnId);
      const inserted = db.prepare(
        `INSERT INTO messages
         (contact_id, sender, role, kind, content, status, turn_id, meta, origin)
         VALUES ('codex', 'codex', 'assistant', 'text', ?, 'done', ?, '{}', 'main')`
      ).run(scriptedText, turnId);
      return {
        status: 'queued' as const,
        completion: Promise.resolve({
          outcome: 'done' as const,
          text: scriptedText,
          messageId: Number(inserted.lastInsertRowid),
        }),
      };
    },
  }),
} as any;
const config = { dbPath, uploadsDir } as any;
const heartbeat = new CompanionHeartbeat({
  db,
  sse,
  manager,
  broker,
  config,
  random: () => randomSamples.shift() ?? 0.25,
});

const insertContact = (id: string, heartbeatEnabled: boolean) => db.prepare(
  `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
   VALUES (?, ?, '🤖', '#888', 'codex', 'dm', ?, 0)`
).run(id, id, JSON.stringify({ heartbeat: { enabled: heartbeatEnabled } }));

const ageActiveSession = (contactId: string, minutes = 8): void => {
  const now = Date.now();
  db.prepare(
    `UPDATE heartbeat_sessions
     SET started_at = ?, last_tick_at = ?, expires_at = ?
     WHERE contact_id = ? AND stopped_at IS NULL`
  ).run(
    new Date(now - minutes * 60_000).toISOString(),
    new Date(now - minutes * 60_000).toISOString(),
    (db.prepare(
      'SELECT expires_at FROM heartbeat_sessions WHERE contact_id = ? AND stopped_at IS NULL'
    ).get(contactId) as { expires_at: string | null }).expires_at === null
      ? null
      : new Date(now + 60 * 60_000).toISOString(),
    contactId,
  );
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
let server: http.Server | null = null;
let mcp: Client | null = null;

const verifyUnlimitedMigrationUpgrade = (): void => {
  const upgradePath = path.join(dir, 'heartbeat-upgrade.db');
  const legacyDb = new Database(upgradePath);
  try {
    const legacyMigrations = loadMigrationFiles().slice(0, -1);
    for (const migration of legacyMigrations) legacyDb.exec(migration.sql);
    legacyDb.pragma(`user_version = ${legacyMigrations.length}`);
    legacyDb.prepare(
      `INSERT INTO heartbeat_sessions
       (id, contact_id, started_at, expires_at, interval_minutes, tick_count, last_tick_at, stopped_at, stop_reason)
       VALUES ('existing-session', 'codex', '2026-08-29T16:00:00.000Z', '2026-08-29T17:00:00.000Z', 6, 3,
               '2026-08-29T16:30:00.000Z', NULL, NULL)`
    ).run();
  } finally {
    legacyDb.close();
  }

  const upgradedDb = openDb(upgradePath);
  try {
    const row = upgradedDb.prepare(
      "SELECT * FROM heartbeat_sessions WHERE id = 'existing-session'"
    ).get() as Record<string, unknown> | undefined;
    assert.equal(row?.expires_at, '2026-08-29T17:00:00.000Z', 'upgrade preserves existing timed sessions');
    assert.equal(row?.interval_minutes, 6);
    assert.equal(row?.tick_count, 3);
    const expiresColumn = (upgradedDb.pragma('table_info(heartbeat_sessions)') as Array<{
      name: string;
      notnull: number;
    }>).find((column) => column.name === 'expires_at');
    assert.equal(expiresColumn?.notnull, 0, 'upgrade makes expires_at nullable for unlimited sessions');
  } finally {
    upgradedDb.close();
  }
};

try {
  verifyUnlimitedMigrationUpgrade();
  assert.deepEqual(
    [0, 0.249999, 0.25, 0.5, 0.999999].map((sample) => randomHeartbeatIntervalMinutes(() => sample)),
    [4, 4, 5, 6, 7],
    'heartbeat interval sampling covers every integer from four through seven minutes',
  );
  insertContact('disabled', false);
  insertContact('codex', true);
  insertContact('heartbeat-only', true);
  db.prepare(
    `INSERT INTO contacts (id, name, avatar, color, backend, kind, config, sort_order)
     VALUES (?, ?, '🤖', '#888', 'api', 'dm', ?, 0)`
  ).run('gem-api', 'gem-api', JSON.stringify({
    provider: 'gemini',
    model: 'gemini-test',
    apiKey: 'smoke',
    heartbeat: { enabled: true },
  }));

  assert.throws(
    () => heartbeat.startSession('disabled', 30),
    (error: unknown) => error instanceof HeartbeatError && error.status === 400,
    'per-contact heartbeat config is a hard start gate',
  );
  const started = heartbeat.startSession('codex', 30);
  assert.equal(started.active, true);
  assert.equal(started.intervalMinutes, 4, 'the first heartbeat delay is sampled when the session starts');
  assert.throws(
    () => heartbeat.startSession('codex', 30),
    (error: unknown) => error instanceof HeartbeatError && error.status === 409,
    'a second active session is a 409 conflict',
  );

  ageActiveSession('codex');
  await heartbeat.runOnce();
  await flush();
  assert.equal(enqueueCount, 1, 'due tick enters the in-process DM runtime exactly once');
  assert.equal(
    (db.prepare("SELECT interval_minutes FROM heartbeat_sessions WHERE contact_id = 'codex' AND stopped_at IS NULL")
      .get() as { interval_minutes: number }).interval_minutes,
    7,
    'a fresh interval is sampled and persisted after every due tick',
  );
  assert.ok(lastTrigger, 'hidden tick row was visible to the runtime before settlement');
  const triggerMeta = JSON.parse(lastTrigger!.meta);
  assert.equal(triggerMeta.uiHidden, true);
  assert.equal(triggerMeta.eventSource, 'heartbeat');
  assert.equal(triggerMeta.automation.eventSource, 'heartbeat');
  assert.match(frameAutomatedTurn(lastTrigger!.meta, lastTrigger!.content), /AI_HUB_EVENT_META.*heartbeat/);
  assert.equal(lastTrigger!.idempotency_key?.startsWith('automation:heartbeat:'), true);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count,
    0,
    'HEARTBEAT_OK hard-deletes the tick and every row in the assistant turn',
  );
  const prune = broadcasts.find((item) => item.event === 'prune');
  assert.equal(prune?.data.contactId, 'codex');
  assert.equal(prune?.data.ids.length, 3, 'prune payload mirrors the hard-deleted rows');

  scriptedText = '你桌上的杯子快空了，记得喝水。';
  ageActiveSession('codex');
  await heartbeat.runOnce();
  await flush();
  assert.equal(enqueueCount, 2);
  assert.equal(
    (db.prepare("SELECT interval_minutes FROM heartbeat_sessions WHERE contact_id = 'codex' AND stopped_at IS NULL")
      .get() as { interval_minutes: number }).interval_minutes,
    4,
    'the next due tick samples again instead of reusing the previous delay',
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS count FROM messages WHERE sender = 'codex' AND kind = 'text'").get() as { count: number }).count,
    1,
    'meaningful heartbeat replies stay visible',
  );

  runtimeState = 'thinking';
  ageActiveSession('codex');
  await heartbeat.runOnce();
  assert.equal(enqueueCount, 2, 'non-idle runtime skips a due tick');
  const countAfterBusy = (db.prepare(
    "SELECT tick_count FROM heartbeat_sessions WHERE contact_id = 'codex' AND stopped_at IS NULL"
  ).get() as { tick_count: number }).tick_count;
  assert.equal(countAfterBusy, 3, 'busy skip still advances tick_count and last_tick_at');
  assert.equal(
    (db.prepare("SELECT interval_minutes FROM heartbeat_sessions WHERE contact_id = 'codex' AND stopped_at IS NULL")
      .get() as { interval_minutes: number }).interval_minutes,
    6,
    'busy skips also resample the next heartbeat delay',
  );

  runtimeState = 'idle';
  db.prepare(
    `INSERT INTO messages
     (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES ('codex', 'user', 'user', 'text', 'User is here', 'done', '{}', 'main')`
  ).run();
  ageActiveSession('codex');
  await heartbeat.runOnce();
  assert.equal(enqueueCount, 2, 'a visible User message in the last three minutes skips the tick');
  db.prepare("DELETE FROM messages WHERE sender = 'user' AND content = 'User is here'").run();

  db.prepare(
    "UPDATE heartbeat_sessions SET expires_at = ? WHERE contact_id = 'codex' AND stopped_at IS NULL"
  ).run(new Date(Date.now() - 1000).toISOString());
  await heartbeat.runOnce();
  assert.equal(heartbeat.status('codex').active, false);
  assert.equal(
    (db.prepare("SELECT stop_reason FROM heartbeat_sessions WHERE contact_id = 'codex' ORDER BY started_at DESC LIMIT 1")
      .get() as { stop_reason: string }).stop_reason,
    'expired',
  );
  assert.equal(
    broadcasts.some((item) => item.event === 'heartbeat' && item.data.contactId === 'codex' && item.data.active === false),
    true,
    'expiry broadcasts heartbeat SSE',
  );

  const unlimited = heartbeat.startSession('codex', null);
  assert.equal(unlimited.active, true);
  assert.equal(unlimited.mode, 'unlimited');
  assert.equal(unlimited.expiresAt, undefined, 'unlimited heartbeat has no artificial expiry timestamp');
  ageActiveSession('codex');
  await heartbeat.runOnce();
  await flush();
  assert.equal(heartbeat.status('codex').active, true, 'unlimited heartbeat stays active after a due tick');
  assert.match(lastTrigger!.content, /手动常开中，直到 User 手动关闭/);
  heartbeat.stopSession('codex', 'manual');

  const cameraTool = buildCameraTool(broker, heartbeat, db, 'codex');
  let cameraResult = await cameraTool.exec({});
  assert.match(cameraResult.text, /心跳窗口未激活/);
  assert.match(cameraResult.text, /不要尝试用其他工具或命令获取画面。$/);

  const activeStatus: HeartbeatStatus = heartbeat.startSession('codex', 30);
  assert.equal(activeStatus.active, true);
  cameraResult = await cameraTool.exec({});
  assert.match(cameraResult.text, /没有在线且允许摄像头/);
  assert.match(cameraResult.text, /不要尝试用其他工具或命令获取画面。$/);

  const workerToken = 'camera-worker.secret';
  db.prepare(
    `INSERT INTO workers
     (id, name, token_hash, capabilities, status, accepting_jobs, boot_id, last_seen_at)
     VALUES ('camera-worker', 'Camera', ?, '{"camera":true}', 'online', 1, 'boot', datetime('now'))`
  ).run(crypto.createHash('sha256').update(workerToken).digest('hex'));

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const jpegBase64 = jpeg.toString('base64');
  const toolPromise = cameraTool.exec({ reason: 'smoke' });
  const pending = broker.takePending({ camera: true });
  assert.ok(pending);
  assert.equal(broker.fulfill(pending!.id, jpeg), true);
  cameraResult = await toolPromise;
  assert.equal(cameraResult.ok, true);
  assert.equal(cameraResult.image?.data, jpegBase64, 'fulfilled JPEG stays in memory as base64');
  assert.equal(cameraResult.image?.mimeType, 'image/jpeg');
  assert.equal(fs.existsSync(framesDir), false, 'fulfilled JPEG never creates data/camera-frames');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM message_attachments').get() as { count: number }).count,
    0,
    'camera frame never creates an attachment row',
  );

  const heldRequest = broker.request('codex', 1000);
  assert.match((await broker.request('codex', 1000)).text, /正忙/, 'broker allows only one in-flight camera request');
  const heldId = broker.takePending({ camera: true })!.id;
  assert.equal(broker.fail(heldId, 'smoke release'), true);
  assert.equal((await heldRequest).ok, false);

  const timedOut = broker.request('codex', 10);
  const late = broker.takePending({ camera: true });
  assert.ok(late);
  const keepTimeoutAlive = setTimeout(() => {}, 100);
  assert.equal((await timedOut).ok, false);
  clearTimeout(keepTimeoutAlive);
  assert.equal(broker.fulfill(late!.id, Buffer.from([0xff, 0xd8])), false, 'late fulfill maps to HTTP 410 semantics');

  const jobs = new JobStore(db, sse);
  heartbeat.stopSession('codex', 'manual');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/contacts', heartbeatRouter(db, heartbeat));
  app.use('/api', workersRouter(db, sse, jobs, undefined, broker));
  app.use('/api', hubMcpRouter(db, jobs, {}, { broker, heartbeat }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  const port = (server.address() as { port: number }).port;
  mcp = new Client({ name: 'heartbeat-smoke', version: '0.0.1' });
  await mcp.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/api/hub-mcp/heartbeat-only`)
  ));
  const listed = await mcp.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), ['camera_snap'], 'heartbeat-only MCP exposes no delegation tools');

  const textOnlyResult = await mcp.callTool({ name: 'camera_snap', arguments: {} });
  assert.equal(textOnlyResult.isError, true);
  assert.equal(textOnlyResult.content.length, 1, 'camera failure returns only one text content block');
  assert.equal(textOnlyResult.content[0]?.type, 'text');

  heartbeat.startSession('heartbeat-only', 30);
  const [imageResult] = await Promise.all([
    mcp.callTool({ name: 'camera_snap', arguments: { reason: 'smoke MCP image' } }),
    (async () => {
      // Event-loop iterations can finish before HTTP reaches the broker; wait by elapsed time.
      const deadline = Date.now() + 5_000;
      let mcpPending = broker.takePending({ camera: true });
      while (!mcpPending && Date.now() < deadline) {
        await delay(10);
        mcpPending = broker.takePending({ camera: true });
      }
      assert.ok(mcpPending, 'MCP camera tool creates a broker request within five seconds');
      assert.equal(broker.fulfill(mcpPending.id, jpeg), true);
    })(),
  ]);
  assert.equal(imageResult.isError, false);
  assert.deepEqual(imageResult.content, [
    {
      type: 'text',
      text: '已拍摄一帧，画面已直接附在本条工具结果里，仅本轮有效、未存盘。看完自然回应或回 HEARTBEAT_OK 即可。',
    },
    { type: 'image', data: jpegBase64, mimeType: 'image/jpeg' },
  ], 'MCP camera success returns text plus a standard image content block');
  assert.equal(fs.existsSync(framesDir), false, 'MCP image response does not create a frame directory');
  heartbeat.stopSession('heartbeat-only', 'manual');
  await mcp.close();
  mcp = null;

  let apiResponse = await fetch(`http://127.0.0.1:${port}/api/contacts/codex/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ minutes: 30 }),
  });
  assert.equal(apiResponse.status, 201);
  await fetch(`http://127.0.0.1:${port}/api/contacts/codex/heartbeat`, { method: 'DELETE' });
  apiResponse = await fetch(`http://127.0.0.1:${port}/api/contacts/codex/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unlimited: true }),
  });
  assert.equal(apiResponse.status, 201);
  const unlimitedStatus = await apiResponse.json() as HeartbeatStatus;
  assert.equal(unlimitedStatus.mode, 'unlimited');
  assert.equal(unlimitedStatus.expiresAt, undefined);
  apiResponse = await fetch(`http://127.0.0.1:${port}/api/contacts/codex/heartbeat`, { method: 'DELETE' });
  assert.equal(apiResponse.status, 200);
  apiResponse = await fetch(`http://127.0.0.1:${port}/api/contacts/codex/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ minutes: 30, unlimited: true }),
  });
  assert.equal(apiResponse.status, 400, 'unlimited mode rejects a simultaneous fixed duration');
  apiResponse = await fetch(`http://127.0.0.1:${port}/api/contacts/codex/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ minutes: 30, intervalMinutes: 5 }),
  });
  assert.equal(apiResponse.status, 400, 'the API cannot pin heartbeat back to a fixed interval');
  apiResponse = await fetch(`http://127.0.0.1:${port}/api/contacts/codex/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ minutes: 30 }),
  });
  assert.equal(apiResponse.status, 201);
  apiResponse = await fetch(`http://127.0.0.1:${port}/api/contacts/codex/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ minutes: 30 }),
  });
  assert.equal(apiResponse.status, 409);
  apiResponse = await fetch(`http://127.0.0.1:${port}/api/contacts/codex/heartbeat`, { method: 'DELETE' });
  assert.equal(apiResponse.status, 200);
  apiResponse = await fetch(`http://127.0.0.1:${port}/api/contacts/codex/heartbeat`, { method: 'DELETE' });
  assert.equal(apiResponse.status, 404);
  apiResponse = await fetch(`http://127.0.0.1:${port}/api/contacts/gem-api/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ minutes: 30 }),
  });
  assert.equal(apiResponse.status, 201, 'API contacts can start heartbeat over the same HTTP API');
  await fetch(`http://127.0.0.1:${port}/api/contacts/gem-api/heartbeat`, { method: 'DELETE' });

  const oversizePending = broker.request('codex', 1000);
  const oversizeId = broker.takePending({ camera: true })!.id;
  const oversizeJpeg = Buffer.alloc(Math.floor(1.4 * 1024 * 1024) + 1);
  oversizeJpeg[0] = 0xff;
  oversizeJpeg[1] = 0xd8;
  const response = await fetch(`http://127.0.0.1:${port}/api/worker/snap/${oversizeId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ imageBase64: oversizeJpeg.toString('base64') }),
  });
  assert.equal(response.status, 413, 'server rejects JPEG payloads over 1.4MB');
  assert.equal((await oversizePending).ok, false);

  console.log('heartbeat session smoke: ok');
} finally {
  if (mcp) await mcp.close();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  heartbeat.stop();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
