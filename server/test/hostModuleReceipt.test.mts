// Host receipt module-handoff repair: persona-free stage-aware receipts,
// plan-coordinator dispatch targets, and review-gate behavior.
//
// Default fixture has NO claude contact: any hardcoded @claude dependency fails
// here. Covers production job 643efc79 (blocked/blocked_unpushed, missing
// declaration => correctly NOT review-eligible), waiting_review gate text,
// deployment tails, dispatch metadata/targets, idempotency, unbound
// fail-closed with no reserve wakeups, and independent review following a
// changed review binding while running attempts keep snapshots.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type ContactRow, type JobRow } from '../src/platform/db.js';
import { dispatchCoordinationRoomHost } from '../src/workflow/coordinationRoom.js';
import { historicalMessageText } from '../src/messages/sideChannel.js';
import {
  coordinationReceiptClosing,
  formatCoordinationReceipt,
  parseCoordinationMarker,
} from '../src/jobs/coordinationReceipt.js';
import { formatWorkerReceiptPreview } from '../src/jobs/receiptPreview.js';
import { isWaitingReviewGate } from '../src/jobs/receiptPreview.js';
import { JobStore } from '../src/jobs/jobStore.js';

const PLAN_HASH = 'a'.repeat(64);
const BASELINE = 'a'.repeat(40);

function fixture(run: (ctx: any) => Promise<void> | void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-host-receipt-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const sse = { broadcast() {} } as any;
  const jobs = new JobStore(db, sse);
  // NOTE: no claude anywhere. Persona dependency must fail here.
  for (const [id, backend] of [['codex', 'codex'], ['muse', 'opencode-cli'], ['aye', 'grok-cli']] as const) {
    db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, 'dm', '{}')")
      .run(id, id, backend);
  }
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room-host-test', 'Coord Room', 'room', 'room', ?)")
    .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'muse', 'aye'], coordination: { enabled: true } }));
  const wakeCalls: Array<{ text: string; targets: string[] }> = [];
  const manager = {
    imageRoomMembers: (room: ContactRow) => {
      if (room.id !== 'room-host-test') return [];
      return (['codex', 'muse', 'aye'] as const).map(
        (id) => db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow,
      );
    },
    dispatchRoomMessageTracked: (_room: ContactRow, text: string, options: any) => {
      wakeCalls.push({ text, targets: options.targetOverride.map((m: ContactRow) => m.id) });
      return { completion: Promise.resolve({ ok: true }) };
    },
  };
  const room = () => db.prepare("SELECT * FROM contacts WHERE id = 'room-host-test'").get() as ContactRow;
  let jobSeq = 0;
  function job(overrides: Record<string, unknown> = {}): JobRow {
    jobSeq += 1;
    return {
      id: `host-receipt-job-${jobSeq}`,
      requested_by: 'codex',
      worker_id: 'pc-1',
      runner: 'opencode',
      workspace: dir,
      prompt: ['[AI_HUB_COORDINATION_V2]', 'taskPath=tasks/ai-dashboard-grok-schema-changed.md', `planHash=${PLAN_HASH}`, `fingerprint=${'c'.repeat(64)}`].join('\n'),
      status: 'blocked',
      priority: 0,
      ttl_at: null,
      lease_until: null,
      session_id: null,
      idempotency_key: `host-receipt-${jobSeq}`,
      permissions: JSON.stringify({ write: true, shell: true, ssh: false }),
      result: 'implementation evidence',
      error: null,
      delivery_state: 'blocked_unpushed',
      delivery_meta: '{}',
      origin_contact_id: 'codex',
      origin_anchor_id: 7254,
      options: JSON.stringify({ routeClass: 'implement', taskPath: 'tasks/ai-dashboard-grok-schema-changed.md' }),
      deleted: 0,
      created_at: '2026-09-12 00:00:00',
      updated_at: '2026-09-12 00:00:00',
      ...overrides,
    } as JobRow;
  }
  const marker = parseCoordinationMarker(job().prompt)!;
  const ctx = { dir, db, sse, jobs, manager, wakeCalls, room, job, marker };
  return (async () => {
    try { await run(ctx); }
    finally {
      jobs.stopOutOfBandResolver();
      db.close();
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(dir).startsWith('ai-hub-host-receipt-'));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
}

function waitingReviewParent(jobs: JobStore, dir: string, taskPath: string, head: string): JobRow {
  const created = jobs.create({
    requestedBy: 'codex', runner: 'opencode', workspace: dir,
    prompt: 'Implement the approved fix.',
    permissions: { write: true, shell: true, ssh: false },
    options: { routeClass: 'implement', taskPath },
  });
  if ('error' in created) throw new Error(created.error);
  jobs.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(created.job.id);
  jobs.complete(jobs.get(created.job.id)!, 'blocked', 'candidate ready', null, 'blocked_unpushed', JSON.stringify({
    before: { head: BASELINE },
    declared: { stage: 'waiting_review', committed: true, pushed: false },
    receipt: {
      branch: 'worker/gate', head, diffstat: '1 file changed',
      changedFiles: { files: ['fix.ts'], total: 1, truncated: false },
      tests: [{ suite: 'targeted regression', status: 'pass' }],
    },
  }));
  return jobs.get(created.job.id)!;
}

test('coordination receipt text is neutral and stage-aware, never persona-bound', () => fixture(({ job, marker }: any) => {
  const waiting = job({ delivery_meta: JSON.stringify({ declared: { stage: 'waiting_review' } }) });
  const blocked = job({ delivery_meta: JSON.stringify({ declared: { committed: true } }) });
  const deployed = job({
    status: 'done', delivery_state: 'delivered',
    delivery_meta: JSON.stringify({ declared: { stage: 'delivered_waiting_deploy', committed: true, pushed: true } }),
  });
  for (const candidate of [waiting, blocked, deployed]) {
    const text = formatCoordinationReceipt(candidate, marker);
    assert.doesNotMatch(text, /claude/);
    assert.doesNotMatch(text, /@\w/);
    assert.doesNotMatch(text, /请依据 preview 给出 PASS\/返工结论/);
    assert.match(text, /工作对接回执，请按阶段处理/);
    assert.match(text, /tasks\/ai-dashboard-grok-schema-changed\.md/);
    assert.match(text, /worker_job_status/);
  }
  assert.match(coordinationReceiptClosing(waiting), /独立 review 闸门.*candidate-bound/);
  assert.doesNotMatch(coordinationReceiptClosing(waiting), /已派发/);
  assert.match(coordinationReceiptClosing(blocked), /尚未形成可接收交付/);
  assert.doesNotMatch(coordinationReceiptClosing(blocked), /未进入独立 review/);
  assert.match(coordinationReceiptClosing(deployed), /APPROVE 只绑定 candidateSha，不能代替部署成功/);
}));

test('M1 closed_loop and online_waiting_validation do not read as continue-deploy', () => fixture(({ job }: any) => {
  const closed = job({
    status: 'done',
    delivery_state: 'delivered',
    permissions: JSON.stringify({ write: false, shell: true, ssh: false }),
    delivery_meta: JSON.stringify({ declared: { stage: 'closed_loop' } }),
  });
  const online = job({
    status: 'done',
    delivery_state: 'delivered',
    delivery_meta: JSON.stringify({ declared: { stage: 'online_waiting_validation' } }),
  });
  const deploy = job({
    status: 'done',
    delivery_state: 'delivered',
    delivery_meta: JSON.stringify({ declared: { stage: 'delivered_waiting_deploy', committed: true, pushed: true } }),
  });
  assert.match(coordinationReceiptClosing(closed), /已闭环，无需后续动作/);
  assert.doesNotMatch(coordinationReceiptClosing(closed), /按部署闸继续/);
  assert.match(coordinationReceiptClosing(online), /线上验收/);
  assert.doesNotMatch(coordinationReceiptClosing(online), /按部署闸继续/);
  assert.match(coordinationReceiptClosing(deploy), /按部署闸继续/);
}));

test('M3 failed jobs carry no never-entered-review history claim', () => fixture(({ job, marker }: any) => {
  const failedReview = job({
    status: 'failed',
    delivery_state: 'failed_clean',
    options: JSON.stringify({ routeClass: 'review', taskPath: 'tasks/ai-dashboard-grok-schema-changed.md' }),
    permissions: JSON.stringify({ write: false, shell: true, ssh: false }),
    result: null,
    error: 'review runner crashed',
    delivery_meta: '{}',
  });
  const closing = coordinationReceiptClosing(failedReview);
  assert.match(closing, /失败或受阻/);
  assert.doesNotMatch(closing, /未进入/);
  const text = formatCoordinationReceipt(failedReview, marker);
  assert.doesNotMatch(text, /未进入独立 review/);
}));

test('production-like missing declaration is blocked, not review-gated, with tail recall', () => fixture(({ db, job, marker, jobs }: any) => {
  // Mirrors production 643efc79: blocked/blocked_unpushed, NO declared stage
  // or blocker, receipt head present, tests empty.
  const head = '98c36b949044b4a49c717af7e1d4a6f21c88f402';
  const productionLike = job({
    delivery_meta: JSON.stringify({
      declared: { committed: true, pushed: false },
      git: { branch: 'worker/ai-dashboard-grok-schema-changed', head, ahead: 1, behind: 0, dirty: false, dirtyFiles: [] },
      receipt: { branch: 'worker/ai-dashboard-grok-schema-changed', head },
      checks: [{ id: 'blocked-missing-stage', pass: false, detail: 'missing stage' }],
    }),
    options: JSON.stringify({ routeClass: 'implement', taskPath: 'tasks/ai-dashboard-grok-schema-changed.md' }),
  });
  const text = formatCoordinationReceipt(productionLike, marker);
  assert.match(text, /尚未形成可接收交付/);
  assert.doesNotMatch(text, /未进入独立 review/);
  assert.doesNotMatch(text, /独立 review 闸门/);
  assert.match(text, /read_file\("tasks\/worker-tail-/);
  const created = jobs.create({
    requestedBy: 'codex', runner: 'opencode', workspace: 'C:/ai-hub-codex',
    prompt: productionLike.prompt,
    permissions: { write: true, shell: true, ssh: false },
    options: { routeClass: 'implement', taskPath: 'tasks/ai-dashboard-grok-schema-changed.md' },
  });
  if ('error' in created) throw new Error(created.error);
  jobs.db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(created.job.id);
  jobs.complete(jobs.get(created.job.id)!, 'blocked', 'no declaration', null, 'blocked_unpushed', productionLike.delivery_meta);
  // Retired: no automatic review job is ever created. The legacy gate reader
  // still classifies the shape (missing declaration => not review-eligible),
  // and completion alone created zero jobs.
  const finished = jobs.get(created.job.id)!;
  assert.equal(isWaitingReviewGate(finished), false);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c, 1);
}));

test('waiting_review suppresses the worker-tail recall line that has no file', () => fixture(({ job }: any) => {
  const waiting = job({ delivery_meta: JSON.stringify({ declared: { stage: 'waiting_review' } }) });
  const blocked = job({ delivery_meta: JSON.stringify({ declared: { committed: true } }) });
  assert.doesNotMatch(formatWorkerReceiptPreview(waiting), /worker-tail-/);
  assert.match(formatWorkerReceiptPreview(blocked), /read_file\("tasks\/worker-tail-/);
  assert.match(formatWorkerReceiptPreview(blocked), /preview 只是索引，不能代替/);
  assert.doesNotMatch(formatWorkerReceiptPreview(blocked), /请按 preview 验收/);
}));

test('M2 tail skip matches the exact review gate; near-misses keep the fallback', () => fixture(({ job }: any) => {
  // True gate: implement + write + blocked + blocked_unpushed + waiting_review.
  const gate = job({ delivery_meta: JSON.stringify({ declared: { stage: 'waiting_review' } }) });
  assert.equal(isWaitingReviewGate(gate), true);
  assert.doesNotMatch(formatWorkerReceiptPreview(gate), /worker-tail-/);
  // Negative 1: review-route job declaring waiting_review still gets a tail.
  const reviewRoute = job({
    options: JSON.stringify({ routeClass: 'review', taskPath: 'tasks/ai-dashboard-grok-schema-changed.md' }),
    permissions: JSON.stringify({ write: false, shell: true, ssh: false }),
    delivery_meta: JSON.stringify({ declared: { stage: 'waiting_review' } }),
  });
  assert.equal(isWaitingReviewGate(reviewRoute), false);
  assert.match(formatWorkerReceiptPreview(reviewRoute), /read_file\("tasks\/worker-tail-/);
  // Negative 2: blocked_local_changes declaring waiting_review still gets a tail.
  const localChanges = job({
    delivery_state: 'blocked_local_changes',
    delivery_meta: JSON.stringify({ declared: { stage: 'waiting_review' } }),
  });
  assert.equal(isWaitingReviewGate(localChanges), false);
  assert.match(formatWorkerReceiptPreview(localChanges), /read_file\("tasks\/worker-tail-/);
}));

test('dispatch lands on the plan coordinator with matching neutral wording, idempotent on retry', () => fixture(({ db, manager, wakeCalls, room, job, marker }: any) => {
  const blocked = job({ delivery_meta: JSON.stringify({ declared: { committed: true } }) });
  const text = formatCoordinationReceipt(blocked, marker);
  const dispatchKey = `coordination:v2:tasks/ai-dashboard-grok-schema-changed.md:${'c'.repeat(64)}`;
  db.prepare(
    `INSERT INTO messages
       (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
     VALUES ('room-host-test', 'room-host', 'user', 'text', 'prior execution dispatch', 'done',
       ?, 'main', ?)`,
  ).run(JSON.stringify({ roomHost: { coordination: { taskPath: marker.taskPath, kind: 'execution' } } }), dispatchKey);
  const first = dispatchCoordinationRoomHost(
    { db, sse: { broadcast() {} }, manager },
    {
      content: text, kind: 'receipt', idempotencyKey: `receipt:v1:${blocked.id}`,
      exactDispatchKey: dispatchKey,
      meta: { receipt: { jobId: blocked.id }, coordination: { jobId: blocked.id, taskPath: marker.taskPath, planHash: marker.planHash } },
    },
  );
  assert.equal(first.status, 'posted');
  assert.equal(first.roomId, 'room-host-test');
  const stored = db.prepare('SELECT * FROM messages WHERE id = ?').get(first.messageId) as any;
  assert.deepEqual(JSON.parse(stored.meta).roomHost.targets, ['codex']);
  assert.match(stored.content, /工作对接回执，请按阶段处理/);
  assert.doesNotMatch(stored.content, /claude/);
  assert.equal(wakeCalls.length, 1);
  assert.deepEqual(wakeCalls[0].targets, ['codex']);
  const retry = dispatchCoordinationRoomHost(
    { db, sse: { broadcast() {} }, manager },
    {
      content: text, kind: 'receipt', idempotencyKey: `receipt:v1:${blocked.id}`,
      exactDispatchKey: dispatchKey,
      meta: { receipt: { jobId: blocked.id } },
    },
  );
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.messageId, first.messageId);
  assert.equal(wakeCalls.length, 1, 'retry must not wake again');
}));

test('independent review follows the rebound review binding; running attempts keep snapshots', () => fixture(({ jobs }: any) => {
  // Retired automatic review creation: the binding snapshot semantics stay —
  // new invocations resolve the current binding, while a previously captured
  // invocation object keeps its frozen binding. No review job is created by
  // any of this; explicit review_submit (covered in roomTaskModelDriven)
  // is the only path.
  const first = jobs.workflowModules.invoke('review', 'tasks/rebound-a.md', 'b'.repeat(64));
  assert.equal(first.binding.contactId, 'aye');
  const revisionBefore = jobs.workflowModules.revision();
  const rebound = jobs.workflowModules.setBinding('review', {
    contactId: 'codex', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high',
  }, revisionBefore, 'User');
  assert.equal(rebound.ok, true);
  const second = jobs.workflowModules.invoke('review', 'tasks/rebound-b.md', 'c'.repeat(64));
  assert.equal(second.binding.contactId, 'codex');
  assert.equal(first.binding.contactId, 'aye', 'captured invocations keep their frozen binding');
  assert.equal((() => {
    try {
      return jobs.workflowModules.revision() > revisionBefore;
    } catch { return false; }
  })(), true);
  assert.equal(jobs.workflowModules.isEscalated(second), false, 'rebinds never escalate on their own');
}));

test('unbound plan target fails closed with no reserve wakeup or random fallback', () => fixture(({ db, jobs, manager, wakeCalls, job, marker }: any) => {
  db.prepare("INSERT INTO contacts (id, name, backend, kind, config) VALUES ('solo', 'Solo', 'codex', 'dm', '{}')").run();
  const swapped = jobs.workflowModules.setBinding('review', {
    contactId: 'solo', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high',
  }, jobs.workflowModules.revision(), 'User');
  void swapped;
  const planSwapped = jobs.workflowModules.setBinding('plan', {
    contactId: 'solo', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high',
  }, jobs.workflowModules.revision(), 'User');
  assert.equal(planSwapped.ok, true);
  const before = wakeCalls.length;
  const outcome = dispatchCoordinationRoomHost(
    { db, sse: { broadcast() {} }, manager },
    { content: formatCoordinationReceipt(job(), marker), kind: 'receipt', idempotencyKey: 'receipt:v1:unbound-plan', meta: {} },
  );
  assert.equal(outcome.status, 'unavailable');
  assert.match(outcome.reason ?? '', /not a room member/);
  assert.equal(wakeCalls.length, before, 'unbound target must not wake reserves or fall back');
}));

test('new neutral receipts still fold in history, including legacy claude rows', () => fixture(({ job, marker }: any) => {
  const folded = historicalMessageText({
    sender: 'room-host', role: 'user', origin: 'main',
    content: formatCoordinationReceipt(job(), marker),
    meta: JSON.stringify({ roomHost: { receipt: { jobId: 'new-neutral-1', status: 'blocked', deliveryState: 'blocked_unpushed' } } }),
  });
  assert.match(folded, /Worker 回执 · new-neutral-1 · blocked \/ blocked_unpushed/);
  const legacy = historicalMessageText({
    sender: 'room-host', role: 'user', origin: 'main',
    content: ['@claude 工作对接回执（preview），请 review。', 'Worker job：legacy-claude-1', '状态：done / delivered'].join('\n'),
    meta: '{broken-json',
  });
  assert.match(legacy, /legacy-claude-1/);
}));

console.log('host module receipt tests: ok');
