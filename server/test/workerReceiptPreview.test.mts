import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DirectApiBackend } from '../src/agents/directApi.js';
import { buildDelegateTools } from '../src/agents/gatewayTools.js';
import { updateCoordinationRoomReceipt } from '../src/agents/coordinationRoom.js';
import { historicalMessageText } from '../src/agents/sideChannel.js';
import { openDb, type JobRow, type MessageRow } from '../src/db.js';
import { formatCoordinationReceipt } from '../src/workers/coordinationReceipt.js';
import { JobStore } from '../src/workers/jobStore.js';
import {
  formatWorkerReceiptPreview,
  WORKER_RECEIPT_PREVIEW_MAX_CHARS,
} from '../src/workers/receiptPreview.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-receipt-preview-'));
const db = openDb(path.join(dir, 'test.db'));
const uploadsDir = path.join(dir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const sse = { broadcast: () => {} } as any;

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-preview-123',
    requested_by: 'codex',
    worker_id: 'pc-1',
    runner: 'codex',
    workspace: 'C:/path/to/project',
    prompt: 'test',
    status: 'blocked',
    priority: 0,
    ttl_at: null,
    lease_until: null,
    session_id: null,
    idempotency_key: 'preview-key',
    permissions: JSON.stringify({ write: true, shell: true, ssh: false }),
    result: [
      '改动已完成。',
      '验证：server tests 101/101 PASS；web tests PASS；双 build PASS；git diff --check PASS。',
      'FULL-TAIL-SENTINEL'.repeat(2_000),
    ].join('\n'),
    error: null,
    delivery_state: 'blocked_unpushed',
    delivery_meta: JSON.stringify({
      declared: {
        committed: true,
        pushed: false,
        stage: 'delivered_waiting_deploy',
        summary: '验证全绿并已本地提交，等待 review。',
        nextOwner: '只读 reviewer',
      },
      git: {
        branch: 'preview-review',
        head: 'abcdef1234567890',
        ahead: 1,
        behind: 0,
        dirty: false,
        dirtyFiles: [],
      },
      checks: [{
        id: 'pushed-but-ahead',
        pass: false,
        detail: 'declared pushed=true but git ahead=1',
      }],
    }),
    origin_contact_id: 'codex',
    origin_anchor_id: 42,
    options: '{}',
    deleted: 0,
    created_at: '2026-08-13 12:00:00',
    updated_at: '2026-08-13 12:00:00',
    ...overrides,
  };
}

try {
  const dmPreview = formatWorkerReceiptPreview(job());
  assert.ok(dmPreview.length <= WORKER_RECEIPT_PREVIEW_MAX_CHARS);
  assert.match(dmPreview, /Worker job：job-preview-123/);
  assert.match(dmPreview, /状态：blocked \/ blocked_unpushed/);
  assert.match(dmPreview, /runner：codex/);
  assert.match(dmPreview, /验证：server tests 101\/101 PASS/);
  assert.match(dmPreview, /commit=是 · push=否 · stage=delivered_waiting_deploy/);
  assert.match(dmPreview, /branch=preview-review · HEAD=abcdef1234567890 · ahead=1 · behind=0 · dirty=0/);
  assert.match(dmPreview, /机检未通过：pushed-but-ahead — declared pushed=true but git ahead=1/);
  assert.match(dmPreview, /result_offset=0, result_limit=4000/);
  assert.doesNotMatch(dmPreview, /FULL-TAIL-SENTINEL/);

  const undeclaredReviewPreview = formatWorkerReceiptPreview(job({
    status: 'done',
    delivery_state: 'delivered',
    delivery_meta: '{}',
    permissions: JSON.stringify({ write: false, shell: false, ssh: false }),
    options: JSON.stringify({ routeClass: 'review', runnerSource: 'policy' }),
  }));
  assert.doesNotMatch(
    undeclaredReviewPreview,
    /^结论：/m,
    'review receipts without a machine delivery declaration omit the synthetic conclusion line'
  );
  assert.match(undeclaredReviewPreview, /^验证要点：/m);

  const passingChecksPreview = formatWorkerReceiptPreview(job({
    delivery_meta: JSON.stringify({
      declared: { committed: true, pushed: false, stage: 'delivered_waiting_deploy' },
      checks: Array.from({ length: 6 }, (_, index) => ({ id: `check-${index}`, pass: true, detail: 'ok' })),
    }),
  }));
  assert.match(passingChecksPreview, /^机检 6 项全过$/m);

  const coordinationPreview = formatCoordinationReceipt(job({
    status: 'done',
    delivery_state: 'delivered',
    delivery_meta: JSON.stringify({
      head: 'fedcba9876543210',
      declared: {
        committed: true,
        pushed: true,
        stage: 'online_waiting_validation',
        summary: '已部署，等待真实入口验收。',
        nextOwner: '验收负责人',
      },
      deployment: { commit: 'fedcba9876543210', deployedAt: '2026-08-13T12:00:00Z' },
    }),
  }), { taskPath: 'tasks/demo.md', planHash: 'a'.repeat(64) });
  assert.ok(coordinationPreview.length <= WORKER_RECEIPT_PREVIEW_MAX_CHARS);
  assert.match(coordinationPreview, /工作对接回执（preview）/);
  assert.match(coordinationPreview, /任务文件：tasks\/demo\.md/);
  assert.match(coordinationPreview, /状态：done \/ delivered/);
  assert.match(coordinationPreview, /部署 commit=fedcba9876543210/);
  assert.match(coordinationPreview, /worker_job_status/);

  const legacyDm = historicalMessageText({
    sender: 'system', role: 'user', origin: 'main',
    content: '⚙ Worker 任务回执\n任务 legacy-job-9：验证通过，等待 review。',
    meta: JSON.stringify({ event: 'worker-receipt' }),
  });
  assert.equal(legacyDm, '[后台事件] Worker 回执 · legacy-job-9 · 验证通过，等待 review。');
  const damagedMetaPreview = historicalMessageText({
    sender: 'room-host', role: 'user', origin: 'main',
    content: [
      '@claude 工作对接回执（preview），请 review。',
      'Worker job：damaged-meta-job-7',
      '状态：done / delivered',
    ].join('\n'),
    meta: '{broken-json',
  });
  assert.equal(
    damagedMetaPreview,
    '[后台事件] Worker 回执 · damaged-meta-job-7 · done / delivered',
    'receipt body fallback must preserve the job id when metadata is damaged'
  );
  const damagedLegacyMeta = historicalMessageText({
    sender: 'system', role: 'user', origin: 'main',
    content: '⚙ Worker 任务回执\n任务 damaged-legacy-job-8：review PASS。',
    meta: '{broken-json',
  });
  assert.equal(
    damagedLegacyMeta,
    '[后台事件] Worker 回执 · damaged-legacy-job-8 · review PASS。'
  );

  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room', '会议室', 'room', 'room', '{}')").run();
  const insertRoomMessage = db.prepare(
    `INSERT INTO messages
       (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key, created_at)
     VALUES ('room', 'room-host', 'user', 'text', ?, 'done', ?, 'main', ?, ?)`
  );
  const historical = insertRoomMessage.run(
    `历史全文 HISTORICAL-FULL-SENTINEL ${'x'.repeat(5_000)}`,
    JSON.stringify({ roomHost: { receipt: {
      jobId: 'room-job-old', status: 'done', deliveryState: 'delivered',
    } } }),
    'receipt:v1:room-job-old',
    '2026-08-13 11:00:00',
  );
  const current = insertRoomMessage.run(
    'CURRENT-PREVIEW-SENTINEL\nWorker job：room-job-current\n状态：done / delivered',
    JSON.stringify({ roomHost: { receipt: {
      jobId: 'room-job-current', status: 'done', deliveryState: 'delivered',
    } } }),
    'receipt:v1:room-job-current',
    '2026-08-13 12:00:00',
  );

  const backend = new DirectApiBackend({
    provider: 'openai-compat', baseUrl: 'https://example.invalid', apiKey: 'unused', model: 'test',
    maxHistoryMessages: 20, historyTokenBudget: 20_000, minRecentTurns: 2,
    summaryMaxTokens: 1_000, historySummaryStrategy: 'off', maxTokens: 64,
    contextWindowTokens: 32_000, turnTimeoutMs: 1_000, db, uploadsDir,
    contactId: 'room', memberId: 'codex', log: () => {},
    roomMode: { selfId: 'codex', nameOf: (sender) => sender },
  });
  const history = (backend as any).history('继续验收', undefined, [Number(current.lastInsertRowid)]);
  const serialized = history.messages.map((message: any) => String(message.content)).join('\n');
  assert.match(serialized, /Worker 回执 · room-job-old · done \/ delivered/);
  assert.doesNotMatch(serialized, /HISTORICAL-FULL-SENTINEL/);
  assert.match(serialized, /CURRENT-PREVIEW-SENTINEL/);

  const receiptRow = db.prepare('SELECT * FROM messages WHERE id = ?')
    .get(Number(historical.lastInsertRowid)) as MessageRow;
  for (let index = 0; index < 12; index++) {
    const updated = updateCoordinationRoomReceipt({ db, sse }, {
      idempotencyKey: receiptRow.idempotency_key!,
      status: index === 11 ? 'done' : 'blocked',
      deliveryState: index === 11 ? 'delivered' : 'blocked_unpushed',
      summary: `状态摘要 ${index}`,
    });
    assert.equal(updated.status, 'updated');
  }
  const boundedRow = db.prepare('SELECT * FROM messages WHERE id = ?').get(receiptRow.id) as MessageRow;
  assert.equal((boundedRow.content.match(/状态更新/g) ?? []).length, 1);
  assert.match(boundedRow.content, /状态摘要 11$/);
  const boundedMeta = JSON.parse(boundedRow.meta);
  assert.equal(boundedMeta.roomHost.receipt.stateUpdates.length, 5);
  assert.equal(boundedMeta.roomHost.receipt.stateUpdates[0].summary, '状态摘要 7');
  assert.match(historicalMessageText(boundedRow), /room-job-old · done \/ delivered/);

  const store = new JobStore(db, sse);
  const created = store.create({
    requestedBy: 'codex', runner: 'codex', workspace: 'C:/path/to/project', prompt: 'recall test',
    permissions: { write: true, shell: true, ssh: false },
  });
  if ('error' in created) throw new Error(created.error);
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(created.job.id);
  const fullResult = `${'A'.repeat(5_000)}${'B'.repeat(5_000)}${'C'.repeat(2_345)}`;
  store.complete(store.get(created.job.id)!, 'done', fullResult, null, 'delivered', '{}');
  db.prepare('UPDATE jobs SET options = ?, delivery_meta = ? WHERE id = ?').run(
    JSON.stringify({ routeClass: 'implement', runnerSource: 'policy' }),
    JSON.stringify({
      declared: {
        committed: true,
        pushed: true,
        stage: 'closed_loop',
        nextOwner: 'claude',
      },
      git: {
        head: '1234567890abcdef',
        ahead: 2,
        behind: 1,
        branch: 'delivery-checks',
        dirty: true,
        dirtyFiles: ['server/src/a.ts', 'server/src/b.ts'],
      },
      checks: [{
        id: 'pushed-but-ahead',
        pass: false,
        detail: 'declared pushed=true but git ahead=2',
      }],
    }),
    created.job.id,
  );
  const statusTool = buildDelegateTools(store, db, 'codex', {
    enabled: true, workspaces: ['C:/path/to/project'], runners: ['codex'], allowShell: true,
  }).find((tool) => tool.name === 'worker_job_status')!;
  const statusProperties = statusTool.schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(statusProperties.result_offset.type, 'integer');
  assert.equal(statusProperties.result_limit.maximum, 12_000);
  const page1 = await statusTool.exec({ job_id: created.job.id, result_offset: 0, result_limit: 5_000 });
  const page2 = await statusTool.exec({ job_id: created.job.id, result_offset: 5_000, result_limit: 5_000 });
  const page3 = await statusTool.exec({ job_id: created.job.id, result_offset: 10_000, result_limit: 5_000 });
  const exactLength = await statusTool.exec({
    job_id: created.job.id, result_offset: 345, result_limit: 12_000,
  });
  const exactEndOffset = await statusTool.exec({
    job_id: created.job.id, result_offset: fullResult.length, result_limit: 100,
  });
  const pastEndOffset = await statusTool.exec({
    job_id: created.job.id, result_offset: fullResult.length + 999, result_limit: 100,
  });
  const zeroLimit = await statusTool.exec({ job_id: created.job.id, result_offset: 0, result_limit: 0 });
  assert.ok(page1.ok && page1.text.includes(fullResult.slice(0, 5_000)));
  assert.match(page1.text, /状态：done \/ delivered/);
  assert.match(page1.text, /permissions：write=true，shell=true，ssh=false/);
  assert.match(page1.text, /declared：committed=true，pushed=true，stage=closed_loop，nextOwner=claude/);
  assert.match(page1.text, /git：HEAD=12345678，ahead=2，behind=1，branch=delivery-checks，dirty=2/);
  assert.match(page1.text, /机检未通过：pushed-but-ahead — declared pushed=true but git ahead=2/);
  assert.match(page1.text, /result_offset=5000/);
  assert.ok(page2.ok && page2.text.includes(fullResult.slice(5_000, 10_000)));
  assert.ok(page3.ok && page3.text.includes(fullResult.slice(10_000)));
  assert.match(page3.text, /已到全文末尾/);
  assert.ok(exactLength.ok && exactLength.text.includes(fullResult.slice(345)));
  assert.match(exactLength.text, new RegExp(`result 345-${fullResult.length}/${fullResult.length}`));
  assert.match(exactEndOffset.text, new RegExp(`result ${fullResult.length}-${fullResult.length}/${fullResult.length}`));
  assert.match(pastEndOffset.text, new RegExp(`result ${fullResult.length}-${fullResult.length}/${fullResult.length}`));
  assert.match(zeroLimit.text, /result 0-1\/12345/);
  assert.match(zeroLimit.text, /result_offset=1, result_limit=1/);

  console.log('[PASS] worker receipt preview, history folding, bounded updates, and paged recall');
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
