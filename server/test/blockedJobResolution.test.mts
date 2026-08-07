import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb } from '../src/db.js';
import { workersRouter } from '../src/routes/workers.js';
import { SseHub } from '../src/sse.js';
import { JobStore } from '../src/workers/jobStore.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-blocked-oob-'));
const repo = path.join(dir, 'repo');
fs.mkdirSync(repo);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'Test');
fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
git('add', 'base.txt');
git('commit', '-m', 'base');
const baseHead = git('rev-parse', 'HEAD');
const mainBranch = git('branch', '--show-current');
fs.writeFileSync(path.join(repo, 'main.txt'), 'main\n');
git('add', 'main.txt');
git('commit', '-m', 'main');
git('checkout', '-b', 'side', baseHead);
fs.writeFileSync(path.join(repo, 'side.txt'), 'side\n');
git('add', 'side.txt');
git('commit', '-m', 'side');
const sideHead = git('rev-parse', 'HEAD');
git('checkout', mainBranch);

const db = openDb(path.join(dir, 'test.db'));
const sse = new SseHub();
const jobs = new JobStore(db, sse);
const finished: string[] = [];
jobs.onFinished = (job) => finished.push(job.id);

function blocked(head: string | null, status = 'blocked') {
  const created = jobs.create({
    requestedBy: 'codex', runner: 'codex', workspace: repo, prompt: 'resolve me',
    permissions: { write: true, shell: true, ssh: false },
  });
  assert.ok('job' in created);
  db.prepare(
    `UPDATE jobs SET status = ?, delivery_state = 'blocked_unpushed', delivery_meta = ? WHERE id = ?`
  ).run(status, JSON.stringify({ state: 'blocked_unpushed', head }), created.job.id);
  return jobs.get(created.job.id)!;
}

const ancestor = blocked(baseHead);
const nonAncestor = blocked(sideHead);
const invalid = blocked('not-a-sha');
const missing = blocked(null);

const promoted = await jobs.sweepBlockedOutOfBand(repo);
assert.deepEqual(promoted, [ancestor.id]);
const autoResolved = jobs.get(ancestor.id)!;
assert.equal(autoResolved.status, 'done');
assert.equal(autoResolved.delivery_state, 'delivered_out_of_band');
const autoMeta = JSON.parse(autoResolved.delivery_meta ?? '{}');
assert.equal(autoMeta.resolution.mode, 'git_ancestor');
assert.equal(autoMeta.resolution.head, baseHead);
assert.equal(typeof autoMeta.resolvedAt, 'string');
assert.match(autoMeta.resolutionReason, /ancestor/);
assert.deepEqual(finished, [ancestor.id], 'automatic completion must reuse the terminal receipt hook');
assert.equal(jobs.get(nonAncestor.id)?.status, 'blocked');
assert.equal(jobs.get(invalid.id)?.status, 'blocked');
assert.equal(jobs.get(missing.id)?.status, 'blocked');
assert.deepEqual(await jobs.sweepBlockedOutOfBand(repo), [], 'resolved and skipped rows stay idempotent');

const app = express();
app.use(express.json());
app.use('/api', workersRouter(db, sse, jobs));
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const endpoint = `http://127.0.0.1:${address.port}/api/jobs`;

const manual = blocked(sideHead);
const manualResponse = await fetch(`${endpoint}/${manual.id}/resolve-out-of-band`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});
assert.equal(manualResponse.status, 200);
const manualBody = await manualResponse.json() as any;
assert.equal(manualBody.job.status, 'done');
assert.equal(manualBody.job.delivery_state, 'delivered_out_of_band');
assert.equal(manualBody.job.delivery_meta.resolution.mode, 'manual');
assert.equal(finished.at(-1), manual.id, 'manual completion must reuse the terminal receipt hook');

const repeated = await fetch(`${endpoint}/${manual.id}/resolve-out-of-band`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});
assert.equal(repeated.status, 409, 'manual action is only valid while blocked');

await new Promise<void>((resolve, reject) =>
  server.close((error) => error ? reject(error) : resolve())
);
sse.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });

console.log('blocked job out-of-band resolution checks passed');
