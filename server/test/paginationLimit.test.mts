import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../src/db.js';
import { parsePositiveIntegerQuery } from '../src/queryParams.js';
import { journalRouter } from '../src/routes/journal.js';
import { messagesRouter } from '../src/routes/messages.js';
import { workersRouter } from '../src/routes/workers.js';
import { SseHub } from '../src/sse.js';
import { JobStore } from '../src/workers/jobStore.js';

const cases = [
  { label: 'missing', value: undefined, expected: 'default' },
  { label: 'zero', value: '0', expected: 'default' },
  { label: 'negative', value: '-2', expected: 'default' },
  { label: 'decimal', value: '2.9', expected: 2 },
  { label: 'NaN', value: 'NaN', expected: 'default' },
  { label: '+Infinity', value: '+Infinity', expected: 'default' },
  { label: '-Infinity', value: '-Infinity', expected: 'default' },
  { label: 'over max', value: '5000', expected: 'max' },
] as const;

for (const testCase of cases) {
  const expected = testCase.expected === 'default'
    ? 50
    : testCase.expected === 'max' ? 200 : testCase.expected;
  assert.equal(
    parsePositiveIntegerQuery(testCase.value, 50, 200),
    expected,
    `parser: ${testCase.label}`,
  );
}
assert.equal(
  parsePositiveIntegerQuery('0.9', 50, 200),
  50,
  'parser validates positivity after flooring decimals',
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-pagination-limit-'));
const db = openDb(path.join(tempDir, 'hub.db'));
const uploadsDir = path.join(tempDir, 'uploads');
const sse = new SseHub();
const jobs = new JobStore(db, sse);

db.prepare(
  "INSERT INTO contacts (id, name, backend, kind, config) VALUES ('codex', 'Codex', 'api', 'dm', '{}')",
).run();

const insertMessage = db.prepare(
  `INSERT INTO messages
   (contact_id, sender, role, kind, content, status, meta, origin, created_at)
   VALUES ('codex', 'user', 'user', 'text', ?, 'done', '{}', 'main', '2026-08-10 04:00:00')`,
);
const seedMessages = db.transaction(() => {
  for (let i = 0; i < 1005; i += 1) insertMessage.run(`message ${i}`);
});
seedMessages();

const insertJob = db.prepare(
  `INSERT INTO jobs
   (id, requested_by, runner, workspace, prompt, status, idempotency_key, permissions)
   VALUES (?, 'User', 'codex', 'C:/path/to/project', 'pagination test', 'done', ?, '{}')`,
);
const seedJobs = db.transaction(() => {
  for (let i = 0; i < 305; i += 1) insertJob.run(`job-${i}`, `pagination-${i}`);
});
seedJobs();

const app = express();
app.use('/api/contacts', messagesRouter(db, sse, {} as any, uploadsDir));
app.use('/api', workersRouter(db, sse, jobs));
app.use('/api', journalRouter(db));
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}/api`;

function url(pathname: string, limit: string | undefined, extra: Record<string, string> = {}): URL {
  const target = new URL(`${base}${pathname}`);
  if (limit !== undefined) target.searchParams.set('limit', limit);
  for (const [key, value] of Object.entries(extra)) target.searchParams.set(key, value);
  return target;
}

async function fetchCount(
  pathname: string,
  key: 'messages' | 'jobs',
  limit: string | undefined,
  label: string,
  extra?: Record<string, string>,
): Promise<number> {
  const response = await fetch(url(pathname, limit, extra));
  assert.equal(response.status, 200, `${label} must not return an error`);
  const body = await response.json() as Record<string, unknown>;
  assert.ok(Array.isArray(body[key]), `${label} must return ${key}`);
  return body[key].length;
}

try {
  for (const testCase of cases) {
    const messagesExpected = testCase.expected === 'default'
      ? 50
      : testCase.expected === 'max' ? 200 : testCase.expected;
    const jobsExpected = testCase.expected === 'default'
      ? 100
      : testCase.expected === 'max' ? 300 : testCase.expected;
    const journalExpected = testCase.expected === 'default'
      ? 400
      : testCase.expected === 'max' ? 1000 : testCase.expected;

    assert.equal(
      await fetchCount('/contacts/codex/messages', 'messages', testCase.value, `messages: ${testCase.label}`),
      messagesExpected,
    );
    assert.equal(
      await fetchCount('/jobs', 'jobs', testCase.value, `jobs: ${testCase.label}`),
      jobsExpected,
    );
    assert.equal(
      await fetchCount(
        '/journal/day',
        'messages',
        testCase.value,
        `journal: ${testCase.label}`,
        { date: '2026-08-10' },
      ),
      journalExpected,
    );
  }

  assert.equal(
    await fetchCount(
      '/contacts/codex/messages',
      'messages',
      '5000',
      'messages after max',
      { after: '0' },
    ),
    1000,
    'messages after requests retain their 1000-row maximum',
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  sse.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('pagination limit checks passed');
