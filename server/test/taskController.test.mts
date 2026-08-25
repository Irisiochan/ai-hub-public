import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type JobRow } from '../src/db.js';
import { attachWorkerCompletion } from '../src/server.js';
import {
  collectInvariantReport,
  renderInvariantJson,
  renderInvariantMarkdown,
} from '../src/tasks/invariants.js';
import { TaskStateService } from '../src/tasks/taskStateService.js';
import { VaultTaskProjection } from '../src/tasks/vaultProjection.js';
import { JobStore } from '../src/workers/jobStore.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-task-controller-'));
const tasksDir = path.join(tempDir, 'tasks');
fs.mkdirSync(tasksDir);
const db = openDb(path.join(tempDir, 'hub.db'));

function writeTask(name: string, status: string, body: string, extra = ''): void {
  fs.writeFileSync(
    path.join(tasksDir, `${name}.md`),
    `---\ntype: task\nstatus: ${status}\ndue: none\n${extra}---\n\n# ${name}\n\n${body}\n`,
    'utf8'
  );
}

function insertJob(id: string, status: string, taskPath?: string): void {
  db.prepare(
    `INSERT INTO jobs (
       id, runner, workspace, prompt, status, idempotency_key, permissions, options
     ) VALUES (?, 'codex', 'C:/ai-hub-codex', 'fixture', ?, ?, '{}', ?)`
  ).run(id, status, `fixture:${id}`, JSON.stringify(taskPath ? { taskPath } : {}));
}

function insertWriteback(idempotencyKey: string, taskPath: string, status: string): number {
  return Number(db.prepare(
    `INSERT INTO task_writebacks (
       idempotency_key, message_id, contact_id, contact_name, task_path,
       source_quote, source_ref, status
     ) VALUES (?, 1, 'User', 'User', ?, 'fixture', 'fixture:1', ?)`
  ).run(idempotencyKey, taskPath, status).lastInsertRowid);
}

async function workerTailProjectionChecks(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-worker-tail-projection-'));
  const localTasksDir = path.join(root, 'tasks');
  fs.mkdirSync(localTasksDir);
  const localDb = openDb(path.join(root, 'hub.db'));
  const sse = { broadcast() {} };
  const jobs = new JobStore(localDb, sse as never);
  const vaultCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const vaultWrites: Array<{ name: string; args: Record<string, unknown> }> = [];
  const vault = {
    async call(name: string, args: Record<string, unknown> = {}) {
      vaultCalls.push({ name, args });
      if (name === 'read_file') throw new Error('not found');
      return 'ok';
    },
    async write(name: string, args: Record<string, unknown>) {
      vaultWrites.push({ name, args });
      return 'ok';
    },
  };
  const logger = { info() {}, warn() {}, error() {} };

  const writeLocalTask = (name: string, status = 'open'): void => {
    fs.writeFileSync(
      path.join(localTasksDir, `${name}.md`),
      `---\ntype: task\nstatus: ${status}\ndue: none\n---\n\n# ${name}\n`,
      'utf8',
    );
  };
  const createJob = (taskPath?: string): JobRow => {
    const created = jobs.create({
      requestedBy: 'User',
      runner: 'codex',
      workspace: 'C:/ai-hub-codex',
      prompt: 'worker tail projection fixture',
      permissions: { write: true, shell: true, ssh: false },
      options: taskPath ? { taskPath } : {},
    });
    if ('error' in created) throw new Error(created.error);
    return created.job;
  };
  const attach = (repoPath: string | null): void => attachWorkerCompletion({
    config: { memory: { repoPath } },
    db: localDb,
    jobStore: jobs,
    vault,
    logger,
    manager: {},
    sse,
  } as never);
  const deliver = async (job: JobRow, finalAttempt = false): Promise<Record<string, unknown>> => {
    const context = {
      finalAttempt,
      meta: {} as Record<string, unknown>,
      setMeta(patch: Record<string, unknown>) {
        this.meta = { ...this.meta, ...patch };
      },
    };
    await jobs.onFinished?.(job, context);
    return context.meta;
  };

  try {
    attach(root);
    writeLocalTask('parent-task');
    const blocked = createJob('tasks/parent-task.md');
    localDb.prepare(
      `UPDATE jobs SET status = 'blocked', delivery_state = 'blocked_unpushed',
       delivery_meta = ?, result = 'blocked receipt' WHERE id = ?`
    ).run(JSON.stringify({ dirtyFiles: ['server/src/server.ts'], head: 'abc1234', ahead: 1 }), blocked.id);
    const blockedRow = jobs.get(blocked.id)!;
    assert.deepEqual(await deliver(blockedRow), { tailDone: true });
    assert.deepEqual(await deliver(blockedRow), { tailDone: true });
    assert.equal(
      (localDb.prepare("SELECT COUNT(*) AS count FROM task_events WHERE task_id = 'parent-task'").get() as { count: number }).count,
      1,
      'blocked job replay must emit one parent annotation event',
    );
    assert.equal(
      (localDb.prepare("SELECT COUNT(*) AS count FROM task_outbox WHERE task_id = 'parent-task'").get() as { count: number }).count,
      1,
      'blocked job replay must emit one parent projection',
    );
    assert.equal(
      (localDb.prepare("SELECT COUNT(*) AS count FROM task_commands WHERE idempotency_key = ?").get(
        `worker-tail-parent:${blocked.id}:blocked_unpushed`,
      ) as { count: number }).count,
      1,
    );
    assert.equal(fs.existsSync(path.join(localTasksDir, `worker-tail-${blocked.id}.md`)), false);
    assert.equal(vaultWrites.filter((entry) => entry.name === 'add_task').length, 0);

    const parentProjection = new VaultTaskProjection(localDb, vault, () => {});
    assert.equal(await parentProjection.flushOutbox(), 1);
    const parentCall = vaultCalls.find((entry) => (
      entry.name === 'update_task' && entry.args.path === 'tasks/parent-task.md'
    ));
    assert.ok(parentCall);
    assert.equal(parentCall.args.status, 'open');
    assert.match(String(parentCall.args.note), new RegExp(blocked.id));
    assert.match(String(parentCall.args.note), /blocked_unpushed/);
    assert.match(String(parentCall.args.note), /abc1234/);

    const legacy = createJob();
    localDb.prepare(
      "UPDATE jobs SET status = 'blocked', delivery_state = 'blocked_local_changes' WHERE id = ?"
    ).run(legacy.id);
    await deliver(jobs.get(legacy.id)!);
    assert.ok(vaultWrites.some((entry) => (
      entry.name === 'add_task' && entry.args.slug === `worker-tail-${legacy.id}`
    )), 'job without taskPath must retain legacy worker-tail creation');

    attach(null);
    const fallback = createJob('tasks/parent-task.md');
    localDb.prepare(
      "UPDATE jobs SET status = 'blocked', delivery_state = 'blocked_unpushed' WHERE id = ?"
    ).run(fallback.id);
    await deliver(jobs.get(fallback.id)!);
    assert.ok(vaultWrites.some((entry) => (
      entry.name === 'add_task' && entry.args.slug === `worker-tail-${fallback.id}`
    )), 'missing tasksDir must fall back to legacy worker-tail creation');

    attach(root);
    const recovered = createJob();
    writeLocalTask(`worker-tail-${recovered.id}`);
    localDb.prepare(
      "UPDATE jobs SET status = 'done', delivery_state = 'delivered_out_of_band', result = 'recovered' WHERE id = ?"
    ).run(recovered.id);
    const recoveredRow = jobs.get(recovered.id)!;
    assert.deepEqual(await deliver(recoveredRow), { tailDone: true });
    assert.deepEqual(await deliver(recoveredRow), { tailDone: true });
    const tailId = `worker-tail-${recovered.id}`;
    assert.deepEqual(
      localDb.prepare('SELECT status, version FROM work_items WHERE task_id = ?').get(tailId),
      { status: 'done', version: 2 },
    );
    assert.equal(
      (localDb.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?').get(tailId) as { count: number }).count,
      1,
    );
    assert.equal(
      (localDb.prepare('SELECT COUNT(*) AS count FROM task_outbox WHERE task_id = ?').get(tailId) as { count: number }).count,
      1,
    );
    assert.equal(await parentProjection.flushOutbox(), 1);
    const closeCall = vaultCalls.find((entry) => (
      entry.name === 'update_task' && entry.args.path === `tasks/${tailId}.md`
    ));
    assert.ok(closeCall);
    assert.equal(closeCall.args.status, 'done');
    assert.match(String(closeCall.args.note), /delivered_out_of_band/);

    writeLocalTask('closed-parent', 'done');
    const rejected = createJob('tasks/closed-parent.md');
    localDb.prepare(
      "UPDATE jobs SET status = 'blocked', delivery_state = 'blocked_unpushed' WHERE id = ?"
    ).run(rejected.id);
    const rejectedRow = jobs.get(rejected.id)!;
    await assert.rejects(deliver(rejectedRow), /parent task annotation rejected/);
    assert.deepEqual(await deliver(rejectedRow, true), {}, 'final attempt must release the receipt without marking the failed tail step done');

    console.log(
      `worker-tail round-trip: parent=${blocked.id} events=1 outbox=1 tail=0; recovered=${recovered.id} closeEvent=1 projected=1`,
    );
  } finally {
    localDb.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

try {
  await workerTailProjectionChecks();
  const expectedTables = ['work_items', 'task_events', 'task_commands', 'task_outbox'];
  for (const table of expectedTables) {
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      `migration must create ${table}`
    );
  }

  writeTask('alpha', 'open', 'first body', 'mode: auto\nsource_ref: fixture:alpha\n');
  const service = new TaskStateService(db);
  assert.deepEqual(service.importSnapshot(tasksDir), { inserted: 1, updated: 0, unchanged: 0, events: 1 });
  assert.deepEqual(service.importSnapshot(tasksDir), { inserted: 0, updated: 0, unchanged: 1, events: 0 });
  writeTask('alpha', 'open', 'changed body', 'mode: auto\nsource_ref: fixture:alpha\n');
  assert.deepEqual(service.importSnapshot(tasksDir), { inserted: 0, updated: 1, unchanged: 0, events: 1 });
  const alpha = db.prepare('SELECT * FROM work_items WHERE task_id = ?').get('alpha') as {
    version: number;
    mode: string;
  };
  assert.equal(alpha.version, 2);
  assert.equal(alpha.mode, 'auto');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?').get('alpha').count, 2);

  const applied = service.transition({
    commandId: 'command-alpha-block',
    idempotencyKey: 'idem-alpha-block',
    taskId: 'alpha',
    expectedVersion: 2,
    toStatus: 'blocked',
    actor: 'test',
    source: 'test-suite',
    reason: 'exercise successful CAS',
    evidence: { fixture: true },
  });
  assert.equal(applied.result, 'applied');
  assert.equal(applied.version, 3);
  assert.equal(db.prepare('SELECT status FROM work_items WHERE task_id = ?').get('alpha').status, 'blocked');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_outbox WHERE task_id = ?').get('alpha').count, 1);
  assert.equal(service.transition({
    commandId: 'command-alpha-block',
    idempotencyKey: 'idem-alpha-block',
    taskId: 'alpha',
    expectedVersion: 2,
    toStatus: 'blocked',
    actor: 'test',
    source: 'test-suite',
    reason: 'replay',
  }).replayed, true, 'idempotent replay must not emit another event');

  const conflict = service.transition({
    commandId: 'command-alpha-stale',
    idempotencyKey: 'idem-alpha-stale',
    taskId: 'alpha',
    expectedVersion: 2,
    toStatus: 'done',
    actor: 'test',
    source: 'test-suite',
    reason: 'exercise rejected CAS',
  });
  assert.equal(conflict.result, 'rejected');
  assert.match(conflict.error ?? '', /version_conflict/);
  assert.equal(
    db.prepare('SELECT result FROM task_commands WHERE command_id = ?').get('command-alpha-stale').result,
    'rejected',
    'CAS rejection must remain auditable'
  );
  assert.throws(
    () => db.prepare("UPDATE task_events SET kind = 'mutated' WHERE event_id = ?").run(applied.eventId),
    /task_events are immutable/
  );
  db.prepare("UPDATE task_outbox SET status = 'done' WHERE task_id = 'alpha'").run();

  writeTask('update-me', 'open', 'controller update fixture');
  const updateTask = service.refreshTask(tasksDir, 'tasks/update-me.md');
  const updateCommand = {
    commandId: 'command-update-me-reschedule',
    idempotencyKey: 'idem-update-me-reschedule',
    taskId: updateTask.taskId,
    expectedVersion: updateTask.version,
    actor: 'User',
    source: 'chat-task-writeback',
    reason: 'move the date',
    projection: { path: 'tasks/update-me.md', note: 'move the date', source: 'User' },
  };
  const rescheduled = service.reschedule(updateCommand, '2026-09-01');
  assert.equal(rescheduled.result, 'applied');
  assert.deepEqual(
    db.prepare('SELECT status, version, due FROM work_items WHERE task_id = ?').get('update-me'),
    { status: 'open', version: 2, due: '2026-09-01' },
  );
  assert.equal(
    db.prepare('SELECT kind FROM task_events WHERE event_id = ?').get(rescheduled.eventId).kind,
    'task_rescheduled',
  );
  const staleAnnotation = service.annotate({
    ...updateCommand,
    commandId: 'command-update-me-stale',
    idempotencyKey: 'idem-update-me-stale',
  });
  assert.equal(staleAnnotation.result, 'rejected');
  assert.match(staleAnnotation.error ?? '', /version_conflict/);
  writeTask('update-me', 'open', 'controller update fixture\n\n## projected note');
  const projectedRefresh = service.refreshTask(tasksDir, 'tasks/update-me.md');
  assert.equal(projectedRefresh.version, 3);
  assert.equal(
    db.prepare('SELECT due FROM work_items WHERE task_id = ?').get('update-me').due,
    '2026-09-01',
    'refreshing an existing row must preserve the authoritative SQLite due',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_outbox WHERE task_id = ?').get('update-me').count, 1);
  db.prepare("UPDATE task_outbox SET status = 'done' WHERE task_id = 'update-me'").run();

  writeTask('close-me', 'open', 'round-trip fixture');
  const refreshed = service.refreshTask(tasksDir, 'tasks/close-me.md');
  assert.equal(refreshed.version, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?').get('close-me').count,
    0,
    'single-task route refresh must not emit a second audit event before transition',
  );
  const closeCommand = {
    commandId: 'command-close-me-first',
    idempotencyKey: 'idem-close-me-first',
    taskId: 'close-me',
    expectedVersion: 1,
    toStatus: 'done' as const,
    actor: 'User',
    source: 'vault-task-status-route',
    reason: 'verified',
    projection: { path: 'tasks/close-me.md', note: 'verified', source: 'User' },
  };
  assert.equal(service.transition(closeCommand).result, 'applied');
  const concurrentClose = service.transition({
    ...closeCommand,
    commandId: 'command-close-me-second',
    idempotencyKey: 'idem-close-me-second',
  });
  assert.equal(concurrentClose.result, 'rejected');
  assert.match(concurrentClose.error ?? '', /version_conflict/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM work_items WHERE task_id = ?').get('close-me').count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?').get('close-me').count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_outbox WHERE task_id = ?').get('close-me').count, 1);

  const projected: Array<{ name: string; args?: Record<string, unknown> }> = [];
  const projection = new VaultTaskProjection(db, {
    async call(name, args) {
      projected.push({ name, args });
      const target = path.join(tasksDir, 'close-me.md');
      fs.writeFileSync(
        target,
        fs.readFileSync(target, 'utf8').replace('status: open', 'status: done'),
        'utf8',
      );
      return 'updated';
    },
  }, () => {});
  assert.equal(await projection.flushOutbox(), 1);
  assert.deepEqual(projected, [{
    name: 'update_task',
    args: { path: 'tasks/close-me.md', status: 'done', note: 'verified', source: 'User' },
  }]);
  assert.equal(db.prepare('SELECT status FROM task_outbox WHERE task_id = ?').get('close-me').status, 'done');
  const roundTripReport = collectInvariantReport(db, tasksDir);
  assert.equal(roundTripReport.summary.total, 0);
  console.log('task controller round-trip: workItems=1 event=1 outbox=1 projected=1 invariants=0');

  const crashDir = path.join(tempDir, 'crash-restart');
  const crashTasksDir = path.join(crashDir, 'tasks');
  fs.mkdirSync(crashTasksDir, { recursive: true });
  fs.writeFileSync(
    path.join(crashTasksDir, 'crash-safe.md'),
    '---\ntype: task\nstatus: open\n---\n\n# crash-safe\n',
    'utf8',
  );
  const crashDbPath = path.join(crashDir, 'hub.db');
  const beforeRestart = openDb(crashDbPath);
  const beforeRestartService = new TaskStateService(beforeRestart);
  const crashTask = beforeRestartService.refreshTask(crashTasksDir, 'tasks/crash-safe.md');
  beforeRestartService.transition({
    commandId: 'command-crash-safe',
    idempotencyKey: 'idem-crash-safe',
    taskId: crashTask.taskId,
    expectedVersion: crashTask.version,
    toStatus: 'done',
    actor: 'User',
    source: 'vault-task-status-route',
    reason: 'crash safety',
    projection: { path: 'tasks/crash-safe.md', note: 'crash safety', source: 'User' },
  });
  assert.equal(beforeRestart.prepare('SELECT status FROM task_outbox').get().status, 'pending');
  beforeRestart.close();

  const afterRestart = openDb(crashDbPath);
  assert.equal(afterRestart.prepare('SELECT status FROM task_outbox').get().status, 'pending');
  const restartProjection = new VaultTaskProjection(afterRestart, {
    async call() {
      throw new Error('文件不存在：task already archived');
    },
  }, () => {});
  assert.equal(await restartProjection.flushOutbox(), 1);
  assert.equal(afterRestart.prepare('SELECT status FROM task_outbox').get().status, 'done');

  fs.writeFileSync(
    path.join(crashTasksDir, 'retry-dead.md'),
    '---\ntype: task\nstatus: open\n---\n\n# retry-dead\n',
    'utf8',
  );
  const retryService = new TaskStateService(afterRestart);
  const retryTask = retryService.refreshTask(crashTasksDir, 'tasks/retry-dead.md');
  retryService.transition({
    commandId: 'command-retry-dead',
    idempotencyKey: 'idem-retry-dead',
    taskId: retryTask.taskId,
    expectedVersion: retryTask.version,
    toStatus: 'done',
    actor: 'User',
    source: 'vault-task-status-route',
    reason: 'retry fixture',
    projection: { path: 'tasks/retry-dead.md', note: 'retry fixture', source: 'User' },
  });
  const failingProjection = new VaultTaskProjection(afterRestart, {
    async call() {
      throw new Error('vault offline');
    },
  }, () => {});
  for (let attempt = 0; attempt < 8; attempt += 1) {
    afterRestart.prepare(
      "UPDATE task_outbox SET next_attempt_at = 0 WHERE task_id = 'retry-dead'"
    ).run();
    await failingProjection.flushOutbox();
  }
  assert.deepEqual(
    afterRestart.prepare('SELECT status, attempts FROM task_outbox WHERE task_id = ?').get('retry-dead'),
    { status: 'dead', attempts: 8 },
  );
  afterRestart.close();

  writeTask('done-active', 'done', 'terminal task fixture');
  writeTask('valid-open', 'open', 'valid live job fixture');
  writeTask('worker-tail-terminal-job', 'open', 'ghost tail fixture');
  writeTask('worker-tail-blocked-job', 'open', 'valid blocked tail fixture');
  insertJob('live-done-task', 'pending', 'tasks/done-active.md');
  insertJob('terminal-done-task', 'done', 'tasks/done-active.md');
  insertJob('valid-live-job', 'running', 'tasks/valid-open.md');
  insertJob('missing-live-job', 'running', 'tasks/missing.md');
  insertJob('missing-terminal-job', 'done', 'tasks/also-missing.md');
  insertJob('terminal-job', 'done');
  insertJob('blocked-job', 'blocked');

  const divergedWriteback = insertWriteback('wb-dead', 'tasks/valid-open.md', 'queued');
  const deadOutbox = Number(db.prepare(
    `INSERT INTO memory_outbox (tool, args, status)
     VALUES ('update_task', ?, 'dead')`
  ).run(JSON.stringify({ path: 'tasks/valid-open.md', note: 'wb-dead' })).lastInsertRowid);
  const healthyWriteback = insertWriteback('wb-pending', 'tasks/valid-open.md', 'queued');
  db.prepare(
    `INSERT INTO memory_outbox (tool, args, status)
     VALUES ('update_task', ?, 'pending')`
  ).run(JSON.stringify({ path: 'tasks/valid-open.md', note: 'wb-pending' }));
  const linkedWriteback = insertWriteback('wb-controller-dead', 'tasks/update-me.md', 'applied');
  const linkedOutbox = db.prepare(
    "SELECT id, event_id FROM task_outbox WHERE task_id = 'update-me'"
  ).get() as { id: number; event_id: string };
  db.prepare('UPDATE task_writebacks SET command_id = ?, event_id = ? WHERE id = ?')
    .run('command-update-me-reschedule', linkedOutbox.event_id, linkedWriteback);
  db.prepare("UPDATE task_outbox SET status = 'dead' WHERE id = ?").run(linkedOutbox.id);

  const report = collectInvariantReport(db, tasksDir);
  assert.equal(report.summary.total, 5);
  assert.deepEqual(report.summary.byCode, {
    I1_TERMINAL_TASK_LIVE_JOB: 1,
    I2_WRITEBACK_OUTBOX_DIVERGENCE: 2,
    I3_GHOST_WORKER_TAIL: 1,
    I4_LIVE_JOB_MISSING_TASK: 1,
  });
  assert.ok(report.violations.some((item) => item.jobId === 'live-done-task'));
  assert.ok(!report.violations.some((item) => item.jobId === 'terminal-done-task'));
  assert.ok(report.violations.some((item) => item.writebackId === divergedWriteback && item.outboxId === deadOutbox));
  assert.ok(report.violations.some((item) => item.writebackId === linkedWriteback && item.outboxId === linkedOutbox.id));
  assert.ok(!report.violations.some((item) => item.writebackId === healthyWriteback));
  assert.ok(report.violations.some((item) => item.jobId === 'terminal-job'));
  assert.ok(!report.violations.some((item) => item.jobId === 'blocked-job'));
  assert.ok(report.violations.some((item) => item.jobId === 'missing-live-job'));
  assert.ok(!report.violations.some((item) => item.jobId === 'missing-terminal-job'));
  assert.equal(renderInvariantJson(report), renderInvariantJson(collectInvariantReport(db, tasksDir)));
  assert.equal(renderInvariantMarkdown(report), renderInvariantMarkdown(collectInvariantReport(db, tasksDir)));

  console.log('task controller tests: ok');
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
