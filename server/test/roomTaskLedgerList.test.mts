import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { RoomTaskStore } from '../src/roomTasks/roomTaskStore.js';
import { JobStore } from '../src/jobs/jobStore.js';
import type { SseHub } from '../src/platform/sse.js';

test('User ledger list omits closed and dropped tasks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-ledger-list-'));
  const db = openDb(path.join(dir, 'hub.db'));
  try {
    const jobs = new JobStore(db, { broadcast() {} } as unknown as SseHub);
    const store = new RoomTaskStore(db, jobs, null, { irisReadEndpoint: true });
    store.listTasks('room-a');
    const insert = db.prepare(
      `INSERT INTO room_tasks (id, room_id, task_path, title, status, owner_module, owner_contact, created_by)
       VALUES (?, 'room-a', ?, ?, ?, 'plan', 'codex', 'codex')`,
    );
    insert.run('room-a::tasks/open.md', 'tasks/open.md', 'open task', 'in_progress');
    insert.run('room-a::tasks/closed.md', 'tasks/closed.md', 'closed task', 'closed');
    insert.run('room-a::tasks/dropped.md', 'tasks/dropped.md', 'dropped task', 'dropped');
    insert.run('room-a::tasks/blocked.md', 'tasks/blocked.md', 'blocked task', 'blocked');
    const listed = store.listTasks('room-a').map((row) => row.task_path).sort();
    assert.deepEqual(listed, ['tasks/blocked.md', 'tasks/open.md']);
  } finally {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
