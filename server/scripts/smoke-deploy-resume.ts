/**
 * 部署重启的恢复边界（anti-regression）。
 *
 * 2026-09-16 重写：旧脚本从 `POST /api/contacts/room/room-host/messages` 带
 * `coordination` 建派单，再断言重启后自动续跑。这两件事都已随会议室任务账本改造
 * 退役——入口对任何带 coordination 的请求返回 410（routes/messages.ts），恢复侧对
 * host/coordination 行显式拒绝重放（manager.recoverDeferredRoomDispatches）。
 * 脚本因此长期红着，且守的是不存在的行为。
 *
 * 现在断言当前真实边界：
 *  1) 遗留 host coordination 派单在 stopAll('deploy-restart') 时仍写 durable 中断快照，
 *     轮次回调后到也不许把它改回 done（面板上那条「部署重启中断」靠它）；
 *  2) 恢复只唤醒 drain 期间推迟的普通派单，一次且只有一次，复用原行与幂等键；
 *  3) 三类行永远不唤醒：遗留 host coordination 行、coordinationDomain 的 drain 推迟、
 *     普通用户消息。前两类被打上退役标记，不是静默丢弃。
 *
 * 任务账本自己的 taskHandoff / taskCallback 恢复路径由
 * test/roomTaskModelDriven.test.mts 覆盖，这里不重复：M2 段是 drain 推迟后的恢复，
 * M4 段是在途派单被部署重启打断后的续跑（durable 快照、不翻 failed、气泡改「已排队续跑」、只续一次）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentManager, type RoomRoundStats } from '../src/runtime/manager.js';
import type { HubConfig } from '../src/platform/config.js';
import { openDb, type ContactRow } from '../src/platform/db.js';
import { SseHub } from '../src/platform/sse.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-deploy-resume-'));
const db = openDb(path.join(tempDir, 'hub.sqlite'));
const sse = new SseHub();
const outcome: RoomRoundStats = {
  normal: { spoke: 1, passed: 0, silent: 0, error: 0 },
  reactions: [],
};
const config: HubConfig = {
  port: 3900, host: '127.0.0.1', dbPath: path.join(tempDir, 'hub.sqlite'),
  agentsDir: tempDir, webDist: '', uploadsDir: tempDir, releasesDir: tempDir,
  claude: { cliPath: 'claude' },
  codex: { cliPath: 'codex' },
  grok: { cliPath: 'grok' },
  opencode: { cliPath: 'opencode' },
  api: { turnTimeoutMs: 300_000 },
  memory: {
    mcpUrl: null, repoPath: null, injectOnSpawn: false, searchPerTurn: false,
    capture: false, maxTurnChars: 1200, sessionMaxAgeHours: 0,
  },
  backup: { enabled: false, dir: tempDir, intervalHours: 24, keep: 1 },
  purge: {
    enabled: false, messagesRetentionDays: 14, jobsRetentionDays: 30,
    intervalHours: 24, batchSize: 100,
  },
};

const metaOf = (id: number): Record<string, any> =>
  JSON.parse((db.prepare('SELECT meta FROM messages WHERE id = ?').get(id) as { meta: string }).meta);
const insertRow = (
  contactId: string, sender: string, content: string, meta: unknown, idempotencyKey: string | null = null,
): number => Number(db.prepare(
  `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
   VALUES (?, ?, 'user', 'text', ?, 'done', ?, 'main', ?)`,
).run(contactId, sender, content, JSON.stringify(meta), idempotencyKey).lastInsertRowid);

try {
  // room：普通会议室；room-wf：配了 coordination，即 isWorkflowRoomConfig 认的 workflow 房
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room', '会议室', 'api', 'room', ?)`)
    .run(JSON.stringify({ members: ['claude'] }));
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-wf', '工作会议室', 'api', 'room', ?)`)
    .run(JSON.stringify({ members: ['claude'], coordination: { enabled: true, orchestrator: 'claude' } }));
  db.prepare(`INSERT INTO contacts (id, name, backend, kind, config) VALUES ('claude', 'Claude', 'api', 'dm', '{}')`).run();
  const room = db.prepare("SELECT * FROM contacts WHERE id = 'room'").get() as ContactRow;
  const claude = db.prepare("SELECT * FROM contacts WHERE id = 'claude'").get() as ContactRow;

  // ── 1. 在途遗留 host 派单：部署重启写 durable 中断快照 ──
  let release!: (value: RoomRoundStats) => void;
  const firstManager = new AgentManager({ db, sse, config, vault: null, jobStore: null });
  (firstManager as any).runRoomRound = () => new Promise<RoomRoundStats>((resolve) => { release = resolve; });
  const coordination = {
    kind: 'execution' as const,
    taskPath: 'tasks/deploy-resume-smoke.md',
    branch: 'deploy-resume-smoke',
    workspace: tempDir,
    planHash: 'a'.repeat(64),
    executor: 'claude',
  };
  const hostId = insertRow('room', 'room-host', '@claude durable coordination', {
    roomHost: { name: 'DS 主持', targets: ['claude'], reactionRounds: 0, coordination },
  });
  const tracked = firstManager.dispatchRoomMessageTracked(room, '@claude durable coordination', {
    targetOverride: [claude],
    capture: false,
    reactionRounds: 0,
    coordinationDomain: true,
    coordination,
    userMessageId: hostId,
  });
  assert.deepEqual(tracked.targets, ['claude']);
  await new Promise((resolve) => setImmediate(resolve));
  const dispatching = metaOf(hostId);
  assert.equal(dispatching.roomDispatch.status, 'dispatching');
  assert.equal(dispatching.roomDispatch.dispatchClass, 'live');

  await firstManager.stopAll('deploy-restart');
  const interrupted = metaOf(hostId);
  assert.equal(interrupted.roomDispatch.status, 'error');
  assert.equal(interrupted.roomDispatch.interruptionReason, 'deploy-restart');
  assert.deepEqual(interrupted.roomDispatch.targetIds, ['claude']);
  assert.equal(interrupted.roomDispatch.reactionRounds, 0);
  assert.equal(interrupted.roomDispatch.coordinationDomain, true);
  assert.deepEqual(interrupted.roomDispatch.coordination, coordination);
  assert.equal(interrupted.roomHost.interruptionReason, 'deploy-restart');

  // 轮次回调在 stop 之后才落地：完成态不得盖掉中断标记，否则重启后这条看起来是正常结束。
  release(outcome);
  await tracked.completion;
  await new Promise((resolve) => setImmediate(resolve));
  const afterCompletion = metaOf(hostId);
  assert.equal(afterCompletion.roomDispatch.status, 'error');
  assert.equal(afterCompletion.roomDispatch.interruptionReason, 'deploy-restart');

  // ── 2. 重启后的恢复扫描 ──
  const drainKey = 'drain:v1:deploy-resume-smoke';
  const drainId = insertRow('room', 'system', '@claude drain deferral', {
    roomDispatch: {
      status: 'deferred', dispatchClass: 'drain', interruptionReason: 'deploy-restart',
      targetIds: ['claude'], reactionRounds: 0,
    },
  }, drainKey);
  const coordDrainId = insertRow('room', 'system', '@claude coordination drain deferral', {
    roomDispatch: {
      status: 'deferred', dispatchClass: 'drain', targetIds: ['claude'],
      reactionRounds: 0, coordinationDomain: true,
    },
  });
  const ordinaryId = insertRow('room', 'user', '@claude ordinary user message', {
    roomDispatch: {
      status: 'error', dispatchClass: 'live', interruptionReason: 'deploy-restart', targetIds: ['claude'],
    },
  });
  const workflowHostId = insertRow('room-wf', 'room-host', '@claude 旧 nudge', {
    roomHost: { targets: ['claude'] },
    roomDispatch: { status: 'deferred', dispatchClass: 'drain', targetIds: ['claude'] },
  });

  const scheduled: Array<{ messageId: number; targetIds: string[]; options: any }> = [];
  const recoveredManager = new AgentManager({ db, sse, config, vault: null, jobStore: null });
  (recoveredManager as any).scheduleRoomRound = async (
    _room: unknown, targets: any[], options: { userMessageId: number },
  ) => {
    scheduled.push({ messageId: options.userMessageId, targetIds: targets.map((target) => target.id), options });
    return outcome;
  };

  assert.equal(recoveredManager.recoverDeferredRoomDispatches(), 1, 'only the plain drain deferral wakes again');
  assert.deepEqual(scheduled.map((item) => item.messageId), [drainId]);
  assert.deepEqual(scheduled[0].targetIds, ['claude']);
  assert.equal(scheduled[0].options.reactionRounds, 0);
  assert.ok(!scheduled.some((item) => item.messageId === ordinaryId), 'ordinary user messages must never deploy-resume');

  assert.match(metaOf(hostId).roomDispatch.error, /retired: automatic host\/coordination dispatch removed/);
  assert.match(metaOf(coordDrainId).roomDispatch.error, /retired: automatic host\/coordination dispatch removed/);
  assert.match(metaOf(workflowHostId).roomDispatch.error, /legacy host source never replays/);
  assert.equal(metaOf(ordinaryId).roomDispatch.status, 'error', 'refused rows are marked, ordinary rows are left alone');
  assert.equal(metaOf(ordinaryId).roomDispatch.error, undefined);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM messages WHERE idempotency_key = ?').get(drainKey) as any).count,
    1,
    'recovery must reuse the original row and its idempotency key',
  );
  assert.equal(recoveredManager.recoverDeferredRoomDispatches(), 0, 'completed recovery must not dispatch twice');
  assert.equal(scheduled.filter((item) => item.messageId === drainId).length, 1);
} finally {
  sse.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('deploy resume smoke: ok');
