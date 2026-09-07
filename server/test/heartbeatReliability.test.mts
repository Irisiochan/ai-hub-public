import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type MessageRow } from '../src/db.js';
import { CompanionHeartbeat } from '../src/agents/companionHeartbeat.js';
import { heartbeatReceipt, retryableHeartbeatError } from '../src/agents/heartbeatPolicy.js';
import { gemHeartbeatHistory } from '../src/agents/gemHeartbeatHistory.js';
import { AgentRuntime } from '../src/agents/runtime.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-reliability-'));
const db = openDb(path.join(dir, 'test.db'));
db.prepare("INSERT INTO contacts(id,name,backend,config) VALUES ('gem','Gem','api',?)")
  .run(JSON.stringify({ heartbeat: { enabled: true } }));
let state = 'idle';
let outcome: 'done' | 'error' = 'done';
let body = 'HEARTBEAT_OK';
let tools: string[] = [];
let calls = 0;
let recoveries = 0;
const rt = {
  recoverHeartbeatError() { recoveries++; state = 'idle'; return true; },
  enqueueTracked() {
    calls++;
    const turn = `turn-${calls}`;
    for (const tool of tools) db.prepare("INSERT INTO messages(contact_id,sender,role,kind,content,turn_id) VALUES ('gem','gem','assistant','tool_use',?,?)").run(tool, turn);
    const result = db.prepare("INSERT INTO messages(contact_id,sender,role,content,turn_id,meta) VALUES ('gem','gem','assistant',?,?,?)")
      .run(body, turn, JSON.stringify({ usage: { input: 100, inputRoundsSum: 450, output: 20, providerRounds: 3 } }));
    state = outcome === 'error' ? 'error' : 'idle';
    return { status: 'queued', completion: Promise.resolve({ outcome, text: body, messageId: Number(result.lastInsertRowid) }) };
  },
};
const heartbeat = new CompanionHeartbeat({ db, manager: { statusOf: () => ({ state }), get: () => rt } as any,
  sse: { broadcast() {} } as any, broker: {} as any, config: { uploadsDir: dir } as any, random: () => 0 });
async function due() {
  db.prepare("UPDATE heartbeat_sessions SET last_tick_at = '2020-01-01T00:00:00Z' WHERE stopped_at IS NULL").run();
  await heartbeat.runOnce();
  await new Promise<void>((resolve) => setImmediate(resolve));
}
try {
  heartbeat.startSession('gem', null);
  await due();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n, 0, 'silent messages removed');
  assert.equal(heartbeat.status('gem').stats?.inputTokens, 450, 'multi-round usage survives deletion');
  assert.equal(heartbeat.status('gem').stats?.silent, 1);
  state = 'thinking'; await due(); state = 'idle';
  assert.equal(heartbeat.status('gem').stats?.skipped, 1);
  outcome = 'error'; body = 'HTTP 503 temporary unavailable';
  await due();
  const before = calls;
  await heartbeat.runOnce();
  assert.equal(calls, before, 'backoff prevents immediate retry');
  await due(); await due();
  assert.equal(recoveries, 2);
  assert.ok(heartbeat.status('gem').pausedReason, 'three failures pause the session');
  await due(); assert.equal(calls, before + 2, 'paused session does not retry');
  heartbeat.stopSession('gem', 'manual');
  heartbeat.startSession('gem', null);
  tools = ['taobao_click_element'];
  await due();
  assert.match(heartbeat.status('gem').pausedReason!, /操作结果/);
  assert.equal(heartbeatReceipt('HEARTBEAT_OK', tools).includes('结果需要核对'), true);
  assert.equal(heartbeatReceipt('', ['camera_snap']), '');
  assert.equal(heartbeatReceipt('已说明结果', tools), '已说明结果');
  assert.equal(retryableHeartbeatError('HTTP 401 token expired'), false);
  assert.equal(retryableHeartbeatError('HTTP 400 Invalid schema'), false);
  assert.equal(retryableHeartbeatError('ETIMEDOUT'), true);
  assert.match(heartbeatReceipt('HEARTBEAT_OK', ['exec_command']), /结果需要核对/, 'opaque shell calls cannot silently lose their audit');
  const recoveryMock = { state: 'error', running: false, stopping: false, queue: [],
    stateTrigger: { eventSource: 'heartbeat' }, lockedOut: () => false,
    setState(value: string) { this.state = value; } };
  assert.equal(AgentRuntime.prototype.recoverHeartbeatError.call(recoveryMock as any), true);
  recoveryMock.state = 'error'; recoveryMock.stateTrigger.eventSource = 'user';
  assert.equal(AgentRuntime.prototype.recoverHeartbeatError.call(recoveryMock as any), false, 'cannot recover an unrelated user turn');
  recoveryMock.stateTrigger.eventSource = 'heartbeat'; recoveryMock.lockedOut = () => true;
  assert.equal(AgentRuntime.prototype.recoverHeartbeatError.call(recoveryMock as any), false, 'cannot bypass crash lockout');
  heartbeat.stopSession('gem', 'manual');
  assert.equal(heartbeat.status('gem').stats?.failed, 1, 'stopped session still exposes its audit');
  heartbeat.startSession('gem', null);
  outcome = 'done'; body = 'HEARTBEAT_OK';
  await due();
  assert.equal(heartbeat.status('gem').stats?.visible, 1, 'shared settlement protects write receipts even if backend returns silence');
  const protectedReply = db.prepare("SELECT content FROM messages WHERE turn_id = ? AND kind = 'text'").get(`turn-${calls}`);
  assert.match(protectedReply.content, /结果需要核对/);
  assert.equal(heartbeat.status('gem').stats?.inputTokens, 450);
  heartbeat.stopSession('gem', 'manual');
  heartbeat.startSession('gem', null);
  const active = db.prepare("SELECT id FROM heartbeat_sessions WHERE stopped_at IS NULL").get();
  db.prepare("INSERT INTO heartbeat_runs(session_id,tick,contact_id,started_at,outcome) VALUES (?,999,'gem','2026-09-05','running')").run(active.id);
  heartbeat.start(); heartbeat.stop();
  assert.match(heartbeat.status('gem').pausedReason!, /网关重启/);

  const rows = Array.from({ length: 31 }, (_, i) => ({ id: i + 1, role: i % 2 ? 'assistant' : 'user', sender: i % 2 ? 'gem' : 'user', content: `消息${i} ` + '保留近期对话，压缩较远历史。'.repeat(120), created_at: '2026-09-05 10:00:00', meta: '{}' } as MessageRow));
  const original = JSON.stringify(rows);
  const lean = gemHeartbeatHistory(rows, (r) => r.content);
  assert.ok(lean.after < lean.before * 0.9);
  assert.ok(lean.rows.includes(rows.at(-1)!));
  assert.ok(lean.rows.length >= 5, 'keep at least two complete recent exchanges and trigger');
  assert.equal(JSON.stringify(rows), original, 'request view does not mutate stored input');
  console.log('heartbeat reliability: ok', { before: lean.before, after: lean.after });
} finally { heartbeat.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
