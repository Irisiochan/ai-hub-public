import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../src/db.js';
import { workersRouter } from '../src/routes/workers.js';
import { coordinationTaskPath, JobStore } from '../src/workers/jobStore.js';
import type { SseHub } from '../src/sse.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-coordination-mutex-'));
const db = openDb(path.join(tempDir, 'hub.db'));
const sse = { broadcast() {} } as unknown as SseHub;
const jobs = new JobStore(db, sse);
const app = express();
app.use(express.json());
app.use('/api', workersRouter(db, sse, jobs));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}/api`;

type CreateResponse = {
  status: number;
  body: { id?: string; merged?: boolean; message?: string; error?: string };
};

async function createJob(prompt: string): Promise<CreateResponse> {
  const response = await fetch(`${base}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestedBy: 'codex',
      runner: 'codex',
      workspace: 'C:/ai-hub-codex',
      prompt,
      permissions: { write: true, shell: true, ssh: false },
    }),
  });
  return { status: response.status, body: await response.json() as CreateResponse['body'] };
}

function executionPrompt(taskPath: string, hashChar: string): string {
  return [
    '[AI_HUB_COORDINATION_V1]',
    `taskPath=${taskPath}`,
    `planHash=${hashChar.repeat(64)}`,
    '只执行任务文件 Plan。',
  ].join('\n');
}

function executionPromptV2(taskPath: string, hashChar: string): string {
  return [
    '[AI_HUB_COORDINATION_V2]',
    `taskPath=${taskPath}`,
    `planHash=${hashChar.repeat(64)}`,
    `fingerprint=${hashChar.repeat(64)}`,
    '只执行任务文件 Plan。',
  ].join('\n');
}

function deployPrompt(taskPath: string, sha: string): string {
  return [
    '只运行 deploy/room-deploy-job.ps1，不做任何其他改动、不修任何文件。',
    `deploy-tail 任务文件：${taskPath}`,
    `命令：powershell -ExecutionPolicy Bypass -File deploy/room-deploy-job.ps1 -Sha ${sha}`,
    '回执贴脚本完整 stdout。',
  ].join('\n');
}

try {
  assert.equal(
    coordinationTaskPath(deployPrompt('tasks/deploy-ai-hub-parser.md', 'abc1234')),
    'tasks/deploy-ai-hub-parser.md',
    '固定部署模板必须解析出 deploy-tail taskPath'
  );
  const [first, duplicate] = await Promise.all([
    createJob(executionPrompt('tasks/mutex-demo.md', 'a')),
    createJob(executionPrompt('tasks/mutex-demo.md', 'b')),
  ]);
  const created = [first, duplicate].find((item) => item.status === 201);
  const merged = [first, duplicate].find((item) => item.status === 200);
  assert.ok(created?.body.id, '并发双派应有且仅有一次新建');
  assert.equal(merged?.body.id, created.body.id, '第二次创建必须返回既有 job id');
  assert.equal(merged?.body.merged, true);
  assert.match(merged?.body.message ?? '', /已并入在途 job/);
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c,
    1,
    '同 taskPath 并发双派只落一张 job'
  );

  db.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(created.body.id);
  const afterTerminal = await createJob(executionPrompt('tasks/mutex-demo.md', 'c'));
  assert.equal(afterTerminal.status, 201, '终态后必须允许同 taskPath 重派');
  assert.notEqual(afterTerminal.body.id, created.body.id);

  const otherTask = await createJob(executionPrompt('tasks/mutex-other.md', 'd'));
  assert.equal(otherTask.status, 201, '不同 taskPath 必须互不影响');
  assert.notEqual(otherTask.body.id, afterTerminal.body.id);

  const deployFirst = await createJob(deployPrompt('tasks/deploy-ai-hub-deadbee.md', 'deadbee'));
  const deployDuplicate = await createJob(deployPrompt('tasks/deploy-ai-hub-deadbee.md', 'feed123'));
  assert.equal(deployFirst.status, 201, '固定部署模板应识别为 coordination job');
  assert.equal(deployDuplicate.status, 200, '部署 job 同 taskPath 应幂等并入');
  assert.equal(deployDuplicate.body.id, deployFirst.body.id);
  assert.match(deployDuplicate.body.message ?? '', /已并入在途 job/);

  const ordinaryA = await createJob('普通任务 A');
  const ordinaryB = await createJob('普通任务 B');
  assert.equal(ordinaryA.status, 201, '普通 job 不参与 taskPath 互斥');
  assert.equal(ordinaryB.status, 201, '普通 job 仍可独立创建');

  // V2 marker 与 V1 共用同一 taskPath 互斥
  const v2First = await createJob(executionPromptV2('tasks/mutex-v2.md', 'a'));
  assert.equal(v2First.status, 201, 'V2 marker 应识别为 coordination job');
  const v2CrossVersion = await createJob(executionPrompt('tasks/mutex-v2.md', 'b'));
  assert.equal(v2CrossVersion.status, 200, 'V1/V2 marker 同 taskPath 必须互斥并入');
  assert.equal(v2CrossVersion.body.id, v2First.body.id);

  // pause_requested / cancel_requested 仍算在途：旧 worker 可能还没停稳
  db.prepare("UPDATE jobs SET status = 'pause_requested' WHERE id = ?").run(v2First.body.id);
  const duringPauseRequest = await createJob(executionPromptV2('tasks/mutex-v2.md', 'c'));
  assert.equal(duringPauseRequest.status, 200, 'pause_requested 期间同 taskPath 必须并入');
  assert.equal(duringPauseRequest.body.id, v2First.body.id);

  db.prepare("UPDATE jobs SET status = 'cancel_requested' WHERE id = ?").run(v2First.body.id);
  const duringCancelRequest = await createJob(executionPromptV2('tasks/mutex-v2.md', 'd'));
  assert.equal(duringCancelRequest.status, 200, 'cancel_requested 期间同 taskPath 必须并入');
  assert.equal(duringCancelRequest.body.id, v2First.body.id);

  // 真正 paused / cancelled 终态后才允许重派
  db.prepare("UPDATE jobs SET status = 'paused' WHERE id = ?").run(v2First.body.id);
  const afterPaused = await createJob(executionPromptV2('tasks/mutex-v2.md', 'e'));
  assert.equal(afterPaused.status, 201, 'paused 终态后必须允许同 taskPath 重派');
  assert.notEqual(afterPaused.body.id, v2First.body.id);

  db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(afterPaused.body.id);
  const afterCancelled = await createJob(executionPromptV2('tasks/mutex-v2.md', 'f'));
  assert.equal(afterCancelled.status, 201, 'cancelled 终态后必须允许同 taskPath 重派');

  console.log('coordination job mutex tests: ok');
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
