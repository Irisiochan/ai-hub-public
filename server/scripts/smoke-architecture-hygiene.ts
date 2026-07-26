import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DirectApiBackend } from '../dist/agents/directApi.js';
import { chooseKeepFrom } from '../dist/agents/historyPolicy.js';
import { parseRoomTargets } from '../dist/agents/roomTargets.js';
import { HeuristicTokenizer } from '../dist/agents/tokenEstimate.js';
import { openDb } from '../dist/db.js';

const tokenizer = new HeuristicTokenizer();
assert.equal(tokenizer.estimate('你好ab'), 3);
const unitTokenizer = { estimate: (_text: string) => 5 };
const candidates = Array.from({ length: 5 }, (_, index) => ({ content: `row-${index}` }));
assert.equal(chooseKeepFrom(candidates, 2, 3, 100, unitTokenizer), 2, 'hard max keeps newest three');
assert.equal(chooseKeepFrom(candidates, 2, 5, 18, unitTokenizer), 3, 'budget applies after minimum');

const members = [
  { id: 'alpha', name: 'Agent Alpha' },
  { id: 'gem', name: 'Gem' },
  { id: 'gamma', name: 'Agent Gamma' },
] as any[];
assert.deepEqual(parseRoomTargets(members, '@alpha @gem 来一下', {}).map((row) => row.id), ['alpha', 'gem']);
assert.deepEqual(parseRoomTargets(members, '@all 集合', {}).map((row) => row.id), ['alpha', 'gem', 'gamma']);
assert.deepEqual(parseRoomTargets(members, '无点名', {}).map((row) => row.id), []);
assert.deepEqual(parseRoomTargets(members, '无点名', { respondAllByDefault: true }).map((row) => row.id),
  ['alpha', 'gem', 'gamma']);

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.architecture-hygiene.db');
const uploadsDir = path.join(here, '.architecture-hygiene-uploads');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
fs.rmSync(uploadsDir, { recursive: true, force: true });
fs.mkdirSync(uploadsDir, { recursive: true });
const db = openDb(dbPath);

try {
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('api-test', 'API', 'api', 'dm', '{}')").run();
  const insert = db.prepare(
    `INSERT INTO messages (contact_id, sender, role, kind, content, status)
     VALUES ('api-test', ?, ?, 'text', ?, 'done')`
  );
  insert.run('api-test', 'assistant', 'orphan assistant');
  insert.run('user', 'user', 'first');
  insert.run('user', 'user', 'second');
  insert.run('api-test', 'assistant', 'answer');
  const current = insert.run('user', 'user', 'persisted current');

  const backend = new DirectApiBackend({
    provider: 'openai-compat',
    baseUrl: 'http://127.0.0.1/unused',
    apiKey: 'test',
    model: 'test',
    maxHistoryMessages: 20,
    historyTokenBudget: 4096,
    minRecentTurns: 2,
    summaryMaxTokens: 512,
    historySummaryStrategy: 'off',
    maxTokens: 64,
    contextWindowTokens: 8192,
    turnTimeoutMs: 1000,
    db,
    uploadsDir,
    contactId: 'api-test',
    memberId: '',
    log: () => {},
  });
  const history = (backend as any).history('injected current', Number(current.lastInsertRowid));
  assert.equal(history.messages[0].role, 'user', 'history cannot start with assistant');
  assert.equal(history.messages.at(-1).content, 'injected current', 'current turn uses injected text');
  assert(history.messages.some((message: any) => message.role === 'user' && message.content.includes('first')),
    'adjacent user rows remain represented after merge');

  console.log('architecture hygiene smoke: ok');
} finally {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.rmSync(uploadsDir, { recursive: true, force: true });
}
