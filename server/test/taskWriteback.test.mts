import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { loadMigrations } from '../src/migrations.js';
import {
  maybeWriteBackTask,
  ownTaskUpdateText,
  type TaskWritebackReview,
  type TaskWritebackVault,
} from '../src/memory/taskWriteback.js';

const TASK_PATH = 'tasks/rent-new-home-2026-07.md';
const SEARCH_RESULT = JSON.stringify({
  result: `找到 1 个匹配：\n\n- **为新工作外出租房** (\`${TASK_PATH}\`)\n  > User 明天出去看房、租房。`,
});
const OPEN_TASK = [
  '---',
  'type: task',
  "due: '2026-07-30'",
  'status: open',
  '---',
  '',
  '# 为新工作外出租房',
  '',
  'User 明天出去看房、租房。',
].join('\n');

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of loadMigrations()) db.exec(migration);
  for (const [id, name] of [['claude', 'Claude'], ['codex', 'Codex']]) {
    db.prepare(
      "INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, 'api', 'dm', '{}')"
    ).run(id, name);
  }
  return db;
}

function addMessage(db: Database.Database, contactId: string, content: string): number {
  return Number(db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status, meta, origin)
     VALUES (?, 'user', 'user', 'text', ?, 'done', '{}', 'main')`
  ).run(contactId, content).lastInsertRowid);
}

class FakeVault implements TaskWritebackVault {
  raw = OPEN_TASK;
  writes: Array<{ name: string; args: Record<string, unknown> }> = [];
  writeResult: 'ok' | 'queued' = 'ok';
  mutateOnWrite = true;
  beforeWrite?: () => Promise<void>;

  async call(name: string): Promise<string> {
    if (name === 'search_vault') return SEARCH_RESULT;
    if (name === 'read_file') return JSON.stringify({ result: this.raw });
    throw new Error(`unexpected call ${name}`);
  }

  async write(name: string, args: Record<string, unknown>): Promise<'ok' | 'queued'> {
    this.writes.push({ name, args });
    await this.beforeWrite?.();
    if (this.writeResult === 'ok' && this.mutateOnWrite) {
      this.raw += `\n\n## 更新\n${String(args.note ?? '')}`;
    }
    return this.writeResult;
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
  const db = makeDb();
  const vault = new FakeVault();
  const text = '租房要过几天再去看，等 8 月 10 日发工资后再安排。';
  const messageId = addMessage(db, 'claude', text);
  const outcome = await maybeWriteBackTask(
    db,
    vault,
    { id: 'claude', name: 'Claude' },
    messageId,
    text,
    () => {},
    async () => rescheduleReview
  );
  assert.equal(outcome.status, 'applied');
  assert.equal(outcome.taskPath, TASK_PATH);
  assert.equal(vault.writes.length, 1);
  assert.deepEqual(
    { name: vault.writes[0].name, path: vault.writes[0].args.path, status: vault.writes[0].args.status, source: vault.writes[0].args.source },
    { name: 'update_task', path: TASK_PATH, status: 'open', source: 'claude' }
  );
  assert.match(String(vault.writes[0].args.note), /User 原话：租房要过几天再去看/);
  assert.match(String(vault.writes[0].args.note), /消息引用：ai-hub:claude\/messages\//);
  assert.match(String(vault.writes[0].args.note), /幂等键：chat-task:claude:/);
  assert.match(String(vault.writes[0].args.note), /新时间承诺：2026-08-10/);

  const duplicate = await maybeWriteBackTask(
    db,
    vault,
    { id: 'claude', name: 'Claude' },
    messageId,
    text,
    () => {},
    async () => { throw new Error('duplicate must not review again'); }
  );
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(vault.writes.length, 1);
  db.close();
}

{
  const db = makeDb();
  const vault = new FakeVault();
  const text = '租房要过几天再去看，改到 8 月 10 日。';
  const messageId = addMessage(db, 'claude', text);
  let reviews = 0;
  const outcome = await maybeWriteBackTask(
    db,
    vault,
    { id: 'claude', name: 'Claude' },
    messageId,
    text,
    () => {},
    async () => {
      reviews++;
      return reviews === 1
        ? { decision: 'pending', confidence: null, action: null, taskQuery: null, due: null, detail: 'transient' }
        : rescheduleReview;
    }
  );
  assert.equal(reviews, 2, 'a pending review gets one bounded retry');
  assert.equal(outcome.status, 'applied');
  db.close();
}

{
  assert.equal(ownTaskUpdateText('> Claude说租房完成了'), null, 'quoted content is not User-authored');
  assert.equal(ownTaskUpdateText('他说打算把租房改到下周'), null, 'somebody else’s plan is rejected');
  assert.equal(ownTaskUpdateText('我没说要把租房任务改期'), null, 'meta-negation is rejected');

  const db = makeDb();
  const vault = new FakeVault();
  for (const text of ['我还没完成租房任务。', '这破事什么时候能搞定啊，哈哈。']) {
    const messageId = addMessage(db, 'claude', text);
    const outcome = await maybeWriteBackTask(
      db,
      vault,
      { id: 'claude', name: 'Claude' },
      messageId,
      text,
      () => {},
      async () => ({ decision: 'reject', confidence: 0.05, action: null, taskQuery: null, due: null })
    );
    assert.equal(outcome.status, 'rejected');
  }
  assert.equal(vault.writes.length, 0);
  db.close();
}

{
  const db = makeDb();
  const vault = new FakeVault();
  const text = '租房的事情已经全部搞定了。';
  const messageId = addMessage(db, 'claude', text);
  const outcome = await maybeWriteBackTask(
    db,
    vault,
    { id: 'claude', name: 'Claude' },
    messageId,
    text,
    () => {},
    async () => ({ ...progressReview, action: 'done' })
  );
  assert.equal(outcome.status, 'proposed');
  assert.equal(vault.writes.length, 0, 'done is never auto-applied');
  const row = db.prepare('SELECT * FROM task_writebacks WHERE message_id = ?').get(messageId) as { status: string; source_quote: string };
  assert.equal(row.status, 'proposed');
  assert.equal(row.source_quote, text);
  db.close();
}

{
  const db = makeDb();
  const vault = new FakeVault();
  let releaseWrite!: () => void;
  let writeStarted!: () => void;
  const started = new Promise<void>((resolve) => { writeStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  vault.beforeWrite = async () => {
    writeStarted();
    await gate;
  };
  const text1 = '租房已经开始联系中介看房了。';
  const text2 = '租房刚刚又约了一次看房。';
  const id1 = addMessage(db, 'claude', text1);
  const id2 = addMessage(db, 'codex', text2);
  const first = maybeWriteBackTask(db, vault, { id: 'claude', name: 'Claude' }, id1, text1, () => {}, async () => progressReview);
  await started;
  const second = await maybeWriteBackTask(db, vault, { id: 'codex', name: 'Codex' }, id2, text2, () => {}, async () => progressReview);
  assert.equal(second.status, 'conflict');
  assert.match(second.detail ?? '', /另一联系人/);
  releaseWrite();
  assert.equal((await first).status, 'applied');
  assert.equal(vault.writes.length, 1, 'concurrent contact must not overwrite the active write');
  db.close();
}

{
  const db = makeDb();
  const vault = new FakeVault();
  vault.writeResult = 'queued';
  const text = '租房已经开始联系中介了。';
  const messageId = addMessage(db, 'claude', text);
  const outcome = await maybeWriteBackTask(db, vault, { id: 'claude', name: 'Claude' }, messageId, text, () => {}, async () => progressReview);
  assert.equal(outcome.status, 'queued');
  assert.match(outcome.detail ?? '', /尚未同步/);
  const row = db.prepare('SELECT status, detail FROM task_writebacks WHERE message_id = ?').get(messageId) as { status: string; detail: string };
  assert.equal(row.status, 'queued');
  assert.match(row.detail, /尚未同步/);
  db.close();
}

{
  const db = makeDb();
  const vault = new FakeVault();
  vault.mutateOnWrite = false;
  const text = '租房已经开始联系中介了。';
  const messageId = addMessage(db, 'claude', text);
  const outcome = await maybeWriteBackTask(db, vault, { id: 'claude', name: 'Claude' }, messageId, text, () => {}, async () => progressReview);
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail ?? '', /回读验证失败/);
  db.close();
}

console.log('chat task writeback checks passed');
