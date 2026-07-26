import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectApiBackend } from '../dist/agents/directApi.js';
import { openDb } from '../dist/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.history-cache.db');
const uploadsDir = path.join(here, '.history-cache-uploads');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
fs.rmSync(uploadsDir, { recursive: true, force: true });
fs.mkdirSync(uploadsDir, { recursive: true });
const rawDb = openDb(dbPath);
const historyCalls: unknown[][] = [];

const db = new Proxy(rawDb as any, {
  get(target, property) {
    if (property === 'prepare') {
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("role IN ('user','assistant') AND id > ?")) return statement;
        return new Proxy(statement, {
          get(stmt, key) {
            if (key === 'all') {
              return (...args: unknown[]) => {
                historyCalls.push(args);
                return stmt.all(...args);
              };
            }
            const value = stmt[key];
            return typeof value === 'function' ? value.bind(stmt) : value;
          },
        });
      };
    }
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

try {
  rawDb.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('cache', 'Cache', 'api', 'dm', '{}')").run();
  const insert = rawDb.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status)
     VALUES ('cache', ?, ?, 'text', ?, 'done')`
  );
  for (let index = 0; index < 3; index++) {
    insert.run('user', 'user', `u${index}`);
    insert.run('cache', 'assistant', `a${index}`);
  }

  const backend = new DirectApiBackend({
    provider: 'openai-compat', baseUrl: 'http://127.0.0.1/unused', apiKey: 'test', model: 'test',
    maxHistoryMessages: 100, historyTokenBudget: 10_000, minRecentTurns: 2,
    summaryMaxTokens: 1000, historySummaryStrategy: 'off', maxTokens: 64,
    contextWindowTokens: 32_000, turnTimeoutMs: 1000, db: db as any, uploadsDir,
    contactId: 'cache', memberId: '', log: () => {},
  });

  (backend as any).history('first');
  assert.equal(historyCalls[0][1], 0, 'first history load starts after summary boundary');
  const next = insert.run('user', 'user', 'new user');
  (backend as any).history('new injected', Number(next.lastInsertRowid));
  assert.equal(historyCalls[1][1], 6, 'second history load fetches only rows after cached max id');
  (backend as any).history('same turn');
  assert.equal(historyCalls[2][1], 7, 'cache hit with no new rows keeps incremental boundary');

  backend.invalidateHistory(3);
  (backend as any).history('after edit');
  assert.equal(historyCalls[3][1], 0, 'edit/delete invalidation forces a full live-row reload');

  rawDb.prepare(
    `INSERT INTO conversation_summaries (contact_id, member_id, summary, through_message_id, version)
     VALUES ('cache', '', 'summary', 2, 1)`
  ).run();
  (backend as any).history('after summary version');
  assert.equal(historyCalls[4][1], 2, 'summary version change reloads from the new through boundary');

  console.log('history cache smoke: ok');
} finally {
  rawDb.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.rmSync(uploadsDir, { recursive: true, force: true });
}
