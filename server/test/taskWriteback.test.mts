import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadMigrations } from '../src/migrations.js';
import {
  maybeWriteBackTask,
  ownTaskUpdateText,
  type TaskWritebackReview,
  type TaskWritebackVault,
} from '../src/memory/taskWriteback.js';
import { TaskStateService } from '../src/tasks/taskStateService.js';
import { VaultTaskProjection } from '../src/tasks/vaultProjection.js';

const TASK_PATH = 'tasks/rent-new-home-2026-07.md';
const SEARCH_RESULT = JSON.stringify({
  result: `找到 1 个匹配：\n\n- **为新工作外出租房** (\`${TASK_PATH}\`)`,
});

function taskText(due = '2026-07-30', body = 'User 明天出去看房、租房。'): string {
  return [
    '---',
    'type: task',
    `due: '${due}'`,
    'status: open',
    '---',
    '',
    '# 为新工作外出租房',
    '',
    body,
  ].join('\n');
}

interface Fixture {
  db: Database.Database;
  root: string;
  tasksDir: string;
  taskFile: string;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-task-writeback-'));
  const tasksDir = path.join(root, 'tasks');
  const taskFile = path.join(tasksDir, path.basename(TASK_PATH));
  fs.mkdirSync(tasksDir);
  fs.writeFileSync(taskFile, taskText(), 'utf8');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of loadMigrations()) db.exec(migration);
  for (const [id, name] of [['claude', 'Claude'], ['codex', 'Codex']]) {
    db.prepare(
      "INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, 'api', 'dm', '{}')"
    ).run(id, name);
  }
  return { db, root, tasksDir, taskFile };
}

function closeFixture(fixture: Fixture): void {
  fixture.db.close();
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function addMessage(db: Database.Database, contactId: string, content: string): number {
  return Number(db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES (?, 'user', 'user', 'text', ?, 'done', '{}', 'main')`
  ).run(contactId, content).lastInsertRowid);
}

class FakeVault implements TaskWritebackVault {
  raw = taskText();
  calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
  afterRead?: () => void;

  constructor(private readonly projectedTaskFile?: string) {}

  async call(name: string, args?: Record<string, unknown>): Promise<string> {
    if (name === 'search_vault') return SEARCH_RESULT;
    if (name === 'read_file') {
      const result = JSON.stringify({ result: this.raw });
      this.afterRead?.();
      this.afterRead = undefined;
      return result;
    }
    if (name === 'update_task') {
      this.calls.push({ name, args });
      if (this.projectedTaskFile) {
        const current = fs.readFileSync(this.projectedTaskFile, 'utf8').trimEnd();
        this.raw = `${current}\n\n## 更新\n${String(args?.note ?? '')}\n`;
        fs.writeFileSync(this.projectedTaskFile, this.raw, 'utf8');
      }
      return 'updated';
    }
    throw new Error(`unexpected call ${name}`);
  }
}

const rescheduleReview: TaskWritebackReview = {
  decision: 'candidate',
  confidence: 0.98,
  action: 'reschedule',
  taskQuery: '租房 看房',
  due: '2026-08-10',
};
const progressReview: TaskWritebackReview = {
  decision: 'candidate',
  confidence: 0.97,
  action: 'progress',
  taskQuery: '租房 看房',
  due: null,
};

{
  const fixture = makeFixture();
  const { db, tasksDir, taskFile } = fixture;
  const vault = new FakeVault(taskFile);
  const text = '租房要过几天再去看，等 8 月 10 日发工资后再安排。';
  const messageId = addMessage(db, 'claude', text);
  const outcome = await maybeWriteBackTask(
    db, vault, tasksDir, { id: 'claude', name: 'Claude' }, messageId, text, () => {}, async () => rescheduleReview
  );
  assert.equal(outcome.status, 'applied');
  assert.equal(outcome.taskPath, TASK_PATH);
  assert.deepEqual(
    db.prepare('SELECT due, version, status FROM work_items WHERE source_path = ?').get(TASK_PATH),
    { due: '2026-08-10', version: 2, status: 'open' },
  );
  const event = db.prepare(
    'SELECT event_id, kind, previous_status, next_status, payload FROM task_events WHERE task_id = ?'
  ).get('rent-new-home-2026-07') as {
    event_id: string;
    kind: string;
    previous_status: string;
    next_status: string;
    payload: string;
  };
  assert.equal(event.kind, 'task_rescheduled');
  assert.equal(event.previous_status, 'open');
  assert.equal(event.next_status, 'open');
  assert.match(event.payload, /"nextDue":"2026-08-10"/);
  const writeback = db.prepare(
    'SELECT status, command_id, event_id, detail FROM task_writebacks WHERE message_id = ?'
  ).get(messageId) as { status: string; command_id: string; event_id: string; detail: string };
  assert.equal(writeback.status, 'applied');
  assert.equal(writeback.command_id, outcome.idempotencyKey);
  assert.equal(writeback.event_id, event.event_id);
  assert.match(writeback.detail, /SQLite/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_outbox').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_outbox').get().count, 1);

  const projection = new VaultTaskProjection(db, vault, () => {});
  assert.equal(await projection.flushOutbox(), 1);
  assert.equal(vault.calls.length, 1);
  assert.equal(vault.calls[0].name, 'update_task');
  assert.equal(vault.calls[0].args?.status, 'open');
  assert.match(String(vault.calls[0].args?.note), /幂等键：chat-task:claude:/);
  assert.match(String(vault.calls[0].args?.note), /新时间承诺：2026-08-10/);
  assert.match(fs.readFileSync(taskFile, 'utf8'), /due: '2026-07-30'/);

  const duplicate = await maybeWriteBackTask(
    db, vault, tasksDir, { id: 'claude', name: 'Claude' }, messageId, text, () => {},
    async () => { throw new Error('duplicate must not review again'); }
  );
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_outbox').get().count, 1);

  const progressText = '租房已经开始联系中介了。';
  const progress = await maybeWriteBackTask(
    db, vault, tasksDir, { id: 'claude', name: 'Claude' }, addMessage(db, 'claude', progressText), progressText,
    () => {}, async () => progressReview
  );
  assert.equal(progress.status, 'applied');
  assert.deepEqual(
    db.prepare('SELECT due, version, status FROM work_items WHERE source_path = ?').get(TASK_PATH),
    { due: '2026-08-10', version: 4, status: 'open' },
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_outbox').get().count, 2);
  console.log('task writeback round-trip: reschedule due=2026-08-10 event=1 outbox=1 projected=1; follow-up progress due=2026-08-10 conflict=0');
  closeFixture(fixture);
}

{
  const fixture = makeFixture();
  const { db, tasksDir } = fixture;
  const vault = new FakeVault();
  const text = '租房要过几天再去看，改到 8 月 10 日。';
  const messageId = addMessage(db, 'claude', text);
  let reviews = 0;
  const outcome = await maybeWriteBackTask(
    db, vault, tasksDir, { id: 'claude', name: 'Claude' }, messageId, text, () => {}, async () => {
      reviews += 1;
      return reviews === 1
        ? { decision: 'pending', confidence: null, action: null, taskQuery: null, due: null, detail: 'transient' }
        : rescheduleReview;
    }
  );
  assert.equal(reviews, 2);
  assert.equal(outcome.status, 'applied');
  closeFixture(fixture);
}

{
  assert.equal(ownTaskUpdateText('> Claude说租房完成了'), null);
  assert.equal(ownTaskUpdateText('他说打算把租房改到下周'), null);
  assert.equal(ownTaskUpdateText('我没说要把租房任务改期'), null);
  const fixture = makeFixture();
  const vault = new FakeVault();
  const text = '我还没完成租房任务。';
  const outcome = await maybeWriteBackTask(
    fixture.db, vault, fixture.tasksDir, { id: 'claude', name: 'Claude' },
    addMessage(fixture.db, 'claude', text), text, () => {},
    async () => ({ decision: 'reject', confidence: 0.05, action: null, taskQuery: null, due: null })
  );
  assert.equal(outcome.status, 'rejected');
  closeFixture(fixture);
}

{
  const fixture = makeFixture();
  const vault = new FakeVault();
  const text = '租房的事情已经全部搞定了。';
  const outcome = await maybeWriteBackTask(
    fixture.db, vault, fixture.tasksDir, { id: 'claude', name: 'Claude' },
    addMessage(fixture.db, 'claude', text), text, () => {}, async () => ({ ...progressReview, action: 'done' })
  );
  assert.equal(outcome.status, 'proposed');
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM task_commands').get().count, 0);
  closeFixture(fixture);
}

{
  const fixture = makeFixture();
  const vault = new FakeVault();
  const text = '租房已经开始联系中介了。';
  const outcome = await maybeWriteBackTask(
    fixture.db, vault, null, { id: 'claude', name: 'Claude' },
    addMessage(fixture.db, 'claude', text), text, () => {}, async () => progressReview
  );
  assert.equal(outcome.status, 'ambiguous');
  assert.match(outcome.detail ?? '', /任务目录未配置/);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM task_commands').get().count, 0);
  closeFixture(fixture);
}

{
  const fixture = makeFixture();
  const { db, tasksDir, taskFile } = fixture;
  const service = new TaskStateService(db);
  assert.equal(service.refreshTask(tasksDir, TASK_PATH).version, 1);
  const vault = new FakeVault();
  vault.afterRead = () => {
    fs.writeFileSync(taskFile, taskText('2026-07-30', '候选生成后任务正文发生变化。'), 'utf8');
  };
  const text = '租房已经开始联系中介了。';
  const outcome = await maybeWriteBackTask(
    db, vault, tasksDir, { id: 'claude', name: 'Claude' }, addMessage(db, 'claude', text), text,
    () => {}, async () => progressReview
  );
  assert.equal(outcome.status, 'conflict');
  assert.match(outcome.detail ?? '', /task_content_changed_after_review/);
  assert.equal(db.prepare('SELECT version FROM work_items WHERE source_path = ?').get(TASK_PATH).version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_commands').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_outbox').get().count, 0);
  closeFixture(fixture);
}

{
  const fixture = makeFixture();
  const { db, tasksDir, taskFile } = fixture;
  const service = new TaskStateService(db);
  assert.equal(service.refreshTask(tasksDir, TASK_PATH).version, 1);
  const before = db.prepare(
    'SELECT version, due, spec_fingerprint, content_fingerprint FROM work_items WHERE source_path = ?'
  ).get(TASK_PATH);
  const refreshedText = taskText('2026-07-30', '投影后的正文，refresh 本来会更新 work_items。');
  fs.writeFileSync(taskFile, refreshedText, 'utf8');
  const vault = new FakeVault();
  vault.raw = refreshedText;
  db.exec(`
    CREATE TRIGGER force_writeback_command_conflict
    AFTER INSERT ON task_commands
    BEGIN
      UPDATE work_items SET version = version + 1 WHERE task_id = NEW.task_id;
    END;
  `);
  const text = '租房刚刚又联系了一家中介。';
  const outcome = await maybeWriteBackTask(
    db, vault, tasksDir, { id: 'claude', name: 'Claude' }, addMessage(db, 'claude', text), text,
    () => {}, async () => progressReview
  );
  assert.equal(outcome.status, 'conflict');
  assert.match(outcome.detail ?? '', /version_conflict/);
  assert.deepEqual(
    db.prepare('SELECT version, due, spec_fingerprint, content_fingerprint FROM work_items WHERE source_path = ?')
      .get(TASK_PATH),
    before,
    'a rejected Controller command must roll back every refreshTask work_items write',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_commands').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_outbox').get().count, 0);
  closeFixture(fixture);
}

{
  const fixture = makeFixture();
  const vault = new FakeVault();
  const text = '租房改期，日期稍后再定。';
  const outcome = await maybeWriteBackTask(
    fixture.db, vault, fixture.tasksDir, { id: 'claude', name: 'Claude' },
    addMessage(fixture.db, 'claude', text), text, () => {},
    async () => ({ ...rescheduleReview, due: null })
  );
  assert.equal(outcome.status, 'ambiguous');
  assert.match(outcome.detail ?? '', /缺少明确日期/);
  closeFixture(fixture);
}

console.log('chat task writeback checks passed');
