import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDelegateTools } from '../src/agents/gatewayTools.js';
import { openDb } from '../src/db.js';
import { SseHub } from '../src/sse.js';
import { JobStore } from '../src/workers/jobStore.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-worker-pagination-'));
const db = openDb(path.join(tempDir, 'hub.sqlite'));
const sse = new SseHub();
try {
  const store = new JobStore(db, sse);
  const created = store.create({
    requestedBy: 'claude', runner: 'codex', workspace: 'C:/path/to/project', prompt: 'pagination smoke',
    permissions: { write: false, shell: true, ssh: false },
  });
  if ('error' in created) throw new Error(created.error);
  db.prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).run(created.job.id);
  const fullResult = `${'A'.repeat(4_000)}${'B'.repeat(1_000)}`;
  store.complete(store.get(created.job.id)!, 'done', fullResult, null, 'delivered', '{}');
  const status = buildDelegateTools(store, db, 'claude', {
    enabled: true, workspaces: ['C:/path/to/project'], runners: ['codex'], allowShell: true,
  }).find((tool) => tool.name === 'worker_job_status')!;

  const first = await status.exec({ job_id: created.job.id, result_offset: 0, result_limit: 4_000 });
  const rebuiltStatus = buildDelegateTools(store, db, 'claude', {
    enabled: true, workspaces: ['C:/path/to/project'], runners: ['codex'], allowShell: true,
  }).find((tool) => tool.name === 'worker_job_status')!;
  const repeated = await rebuiltStatus.exec({ job_id: created.job.id, result_offset: 0, result_limit: 4_000 });
  const last = await status.exec({ job_id: created.job.id, result_offset: 4_000, result_limit: 4_000 });
  assert.ok(first.ok && repeated.ok && last.ok);
  assert.ok(first.text.includes(fullResult.slice(0, 4_000)));
  assert.ok(repeated.text.includes(fullResult.slice(0, 4_000)), 'duplicate page is returned idempotently');
  assert.match(first.text, /nextOffset=4000\natEnd=false\nrepeatedOffset=false$/);
  assert.match(repeated.text, /重复分页请求：[\s\S]*nextOffset=4000\natEnd=false\nrepeatedOffset=true$/);
  assert.match(last.text, /nextOffset=5000\natEnd=true\nrepeatedOffset=false$/);
} finally {
  sse.close();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('worker status pagination smoke: ok');
