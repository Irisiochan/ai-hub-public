import type { JobRow } from '../db.js';
import type { JobStore } from './jobStore.js';
import { deliveryMeta, structuredReceiptFields } from './receiptFields.js';
import { problemFingerprint } from './workflowProfiles.js';

type JsonRecord = Record<string, unknown>;
type ClosureOutcome = {
  status: 'not-eligible' | 'rejected' | 'existing' | 'created';
  kind?: 'merge' | 'deploy';
  reason?: string;
  job?: JobRow;
};

const SHA_RE = /^[0-9a-f]{40}$/i;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,120}$/;

function safeBranch(value: string): boolean {
  return BRANCH_RE.test(value)
    && !value.startsWith('-')
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('..')
    && !value.includes('//');
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function parse(raw: string | null | undefined): JsonRecord {
  try { return raw ? record(JSON.parse(raw)) : {}; } catch { return {}; }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function declared(job: JobRow): JsonRecord {
  return record(deliveryMeta(job).declared);
}

export function strictReviewDecision(job: Pick<JobRow, 'result' | 'error'>): 'approve' | 'request_changes' | 'ambiguous' {
  const result = String(job.result || job.error || '');
  const approve = /(?:^|\n)\s*(?:结论\s*[:：]\s*)?APPROVE(?:\s*(?:[:：-]|$))/im.test(result);
  const requestChanges = /\bREQUEST_CHANGES\b/i.test(result);
  if (requestChanges) return 'request_changes';
  return approve ? 'approve' : 'ambiguous';
}

function isHarnessReview(job: JobRow): boolean {
  const options = parse(job.options);
  return text(options.routeClass) === 'review'
    && options.dispatchSource === 'harness-auto'
    && job.status === 'done'
    && job.delivery_state === 'delivered';
}

function hasRequiredMergeTests(job: JobRow): boolean {
  const reported = new Set((structuredReceiptFields(job).tests ?? [])
    .filter((item) => item.status === 'pass')
    .map((item) => item.suite.toLowerCase()));
  return [
    'server npm run pretest',
    'server npm test',
    'web npm test',
    'smoke:deploy-drain',
    'smoke:turn-timeouts',
    'smoke:review-auto-batch',
    'smoke:deploy-resume',
    'smoke:receipt-deploy-closure',
  ].every((suite) => reported.has(suite));
}

function mergeSource(store: JobStore, review: JobRow): {
  parent: JobRow;
  taskPath: string;
  branch: string;
  frozenSha: string;
  baselineSha: string;
} | { error: string } {
  const reviewOptions = parse(review.options);
  const parentId = text(reviewOptions.parentJobId);
  const parent = parentId ? store.get(parentId) : undefined;
  if (!parent) return { error: 'review parent job is missing' };
  const parentOptions = parse(parent.options);
  const parentDeclared = declared(parent);
  const receipt = structuredReceiptFields(parent);
  const before = record(deliveryMeta(parent).before);
  const taskPath = text(parentOptions.taskPath);
  const routeClass = text(parentOptions.routeClass);
  if (!['implement', 'fix'].includes(routeClass)
      || parent.status !== 'blocked'
      || parent.delivery_state !== 'blocked_unpushed'
      || text(parentDeclared.stage).toLowerCase().replace(/-/g, '_') !== 'waiting_review') {
    return { error: 'review parent is no longer at the waiting_review gate' };
  }
  if (!receipt.branch || !safeBranch(receipt.branch) || ['master', 'main'].includes(receipt.branch)) {
    return { error: 'review parent branch is missing or unsafe' };
  }
  if (!receipt.head || !SHA_RE.test(receipt.head)) return { error: 'review parent frozen SHA is missing' };
  const baselineSha = text(before.head);
  if (!SHA_RE.test(baselineSha)) return { error: 'review parent baseline SHA is missing' };
  if (!receipt.diffstat || !receipt.changedFiles || !receipt.tests) {
    return { error: 'review parent structured receipt fields are incomplete' };
  }
  if (receipt.tests.some((item) => item.status !== 'pass')) {
    return { error: 'review parent reports a failing test conclusion' };
  }
  return {
    parent,
    taskPath,
    branch: receipt.branch,
    frozenSha: receipt.head.toLowerCase(),
    baselineSha: baselineSha.toLowerCase(),
  };
}

export function buildMergeClosurePrompt(input: {
  parentJobId: string;
  reviewJobId: string;
  taskPath: string;
  branch: string;
  frozenSha: string;
  baselineSha: string;
}): string {
  return [
    '【harness-auto merge closure v1】',
    '这是 review 严格判定 APPROVE 后规则化创建的车道 A 机械收口单。只执行合并/验证/push；禁止 SSH、部署、重启、改需求或修测试失败。',
    `parentJobId=${input.parentJobId}`,
    `reviewJobId=${input.reviewJobId}`,
    `taskPath=${input.taskPath || '未提供'}`,
    `workingBranch=${input.branch}`,
    `frozenSha=${input.frozenSha}`,
    `baselineSha=${input.baselineSha}`,
    '',
    '运行固定脚本：',
    `powershell -ExecutionPolicy Bypass -File deploy/merge-close-job.ps1 -FrozenSha ${input.frozenSha} -BaselineSha ${input.baselineSha} -WorkingBranch ${input.branch}`,
    '',
    '脚本必须依次执行 Gate0（当前工作分支/HEAD 冻结、工作树 clean、local master==origin/master、master 为 frozen SHA 祖先可 ff）→ ff-only 合 master → server npm run pretest → server npm test → web npm test → smoke:deploy-drain → smoke:turn-timeouts → smoke:review-auto-batch → smoke:deploy-resume → smoke:receipt-deploy-closure → push origin master → 远端 SHA 复核。',
    '任何 Gate 或验证失败都必须停下，不得修代码、降级验证、force push、回滚、部署或另建分支。',
    '成功后 stage=delivered_waiting_deploy、nextOwner=claude-review；回执 JSON 必须申报 branch=master 对应的结构化 diffstat/changedFiles/tests。',
  ].join('\n');
}

export function buildDeployClosurePrompt(input: {
  mergeJobId: string;
  parentJobId: string;
  taskPath: string;
  frozenSha: string;
}): string {
  return [
    '【harness-auto deploy closure v1】',
    '这是车道 A 全量验证并 push 后规则化创建的车道 B 机械部署单。只复用现有 HTTP 部署通道；禁止改文件、SSH、绕过 drain 或省略部署前在途检查。',
    `mergeJobId=${input.mergeJobId}`,
    `parentJobId=${input.parentJobId}`,
    `taskPath=${input.taskPath || '未提供'}`,
    `frozenSha=${input.frozenSha}`,
    '',
    `唯一命令：powershell -ExecutionPolicy Bypass -File deploy/room-deploy-job.ps1 -Sha ${input.frozenSha}`,
    'room-deploy-job.ps1 保留 prepareDeployDrain、部署前房间在途检查、最长等待、restart 前复检、deploy ok 与 /api/health 验收；不得换成 SSH 或直接运行 update.sh。',
    '成功后 stage=closed_loop、nextOwner=claude-review；失败则如实报告，不得重试成绕闸路径。回执仍交Claude验收，不得自动关闭父任务。',
  ].join('\n');
}

function createMergeJob(store: JobStore, review: JobRow): ClosureOutcome {
  const decision = strictReviewDecision(review);
  if (decision !== 'approve') {
    return { status: 'rejected', kind: 'merge', reason: `review decision is ${decision}` };
  }
  const source = mergeSource(store, review);
  if ('error' in source) return { status: 'rejected', kind: 'merge', reason: source.error };
  const idempotencyKey = `merge:v1:${source.parent.id}`;
  const existing = store.getByIdempotencyKey(idempotencyKey);
  if (existing) return { status: 'existing', kind: 'merge', job: existing };
  const fingerprint = problemFingerprint(review.prompt, source.taskPath);
  const workflow = store.workflowProfiles.snapshot({
    stage: 'maintenance',
    taskPath: source.taskPath,
    problemFingerprint: fingerprint,
  });
  if (store.workflowProfiles.isEscalatedToHuman(workflow)) {
    return { status: 'rejected', kind: 'merge', reason: 'workflow three-strike escalation requires User' };
  }
  const created = store.create({
    requestedBy: 'claude',
    runner: workflow.selected.runner,
    workspace: source.parent.workspace,
    prompt: buildMergeClosurePrompt({
      parentJobId: source.parent.id,
      reviewJobId: review.id,
      taskPath: source.taskPath,
      branch: source.branch,
      frozenSha: source.frozenSha,
      baselineSha: source.baselineSha,
    }),
    priority: source.parent.priority,
    idempotencyKey,
    permissions: { write: true, shell: true, ssh: false },
    originContactId: review.origin_contact_id,
    originAnchorId: review.origin_anchor_id,
    options: {
      model: workflow.selected.model,
      reasoning: workflow.selected.reasoning,
      routeClass: 'mechanical',
      runnerSource: 'policy',
      workflowStage: 'maintenance',
      problemFingerprint: fingerprint,
      taskPath: source.taskPath,
      workflow,
      parentJobId: source.parent.id,
      sourceReviewJobId: review.id,
      closureKind: 'merge',
      frozenSha: source.frozenSha,
      dispatchSource: 'harness-auto',
    },
  });
  if ('error' in created) {
    const replay = store.getByIdempotencyKey(idempotencyKey);
    if (replay) return { status: 'existing', kind: 'merge', job: replay };
    throw new Error(`automatic merge closure creation failed: ${created.error}`);
  }
  if (created.job.idempotency_key !== idempotencyKey) {
    throw new Error(`automatic merge closure merged into unrelated active job ${created.job.id}`);
  }
  return { status: 'created', kind: 'merge', job: created.job };
}

function createDeployJob(store: JobStore, merge: JobRow): ClosureOutcome {
  const options = parse(merge.options);
  if (text(options.closureKind) !== 'merge' || options.dispatchSource !== 'harness-auto') {
    return { status: 'not-eligible' };
  }
  const frozenSha = text(options.frozenSha).toLowerCase();
  const parentJobId = text(options.parentJobId);
  const declaredMerge = declared(merge);
  const receipt = structuredReceiptFields(merge);
  if (merge.status !== 'done'
      || merge.delivery_state !== 'delivered'
      || text(declaredMerge.stage).toLowerCase().replace(/-/g, '_') !== 'delivered_waiting_deploy'
      || declaredMerge.committed !== true
      || declaredMerge.pushed !== true
      || !SHA_RE.test(frozenSha)
      || receipt.head?.toLowerCase() !== frozenSha
      || receipt.branch !== 'master'
      || !receipt.diffstat
      || !receipt.changedFiles
      || !receipt.tests
      || receipt.tests.some((item) => item.status !== 'pass')
      || !hasRequiredMergeTests(merge)) {
    return { status: 'rejected', kind: 'deploy', reason: 'merge closure did not prove pushed frozen SHA and passing validation' };
  }
  const idempotencyKey = `deploy:v1:${frozenSha}`;
  const existing = store.getByIdempotencyKey(idempotencyKey);
  if (existing) return { status: 'existing', kind: 'deploy', job: existing };
  const taskPath = text(options.taskPath);
  const fingerprint = problemFingerprint(merge.prompt, taskPath);
  const workflow = store.workflowProfiles.snapshot({
    stage: 'maintenance',
    taskPath,
    problemFingerprint: fingerprint,
  });
  if (store.workflowProfiles.isEscalatedToHuman(workflow)) {
    return { status: 'rejected', kind: 'deploy', reason: 'workflow three-strike escalation requires User' };
  }
  const created = store.create({
    requestedBy: 'claude',
    runner: workflow.selected.runner,
    workspace: merge.workspace,
    prompt: buildDeployClosurePrompt({ mergeJobId: merge.id, parentJobId, taskPath, frozenSha }),
    priority: merge.priority,
    idempotencyKey,
    // The SSH capability is the existing dispatch-level authorization for a
    // production deploy. The fixed prompt still forbids using SSH and executes
    // only the already-gated HTTP deploy script.
    permissions: { write: false, shell: true, ssh: true },
    originContactId: merge.origin_contact_id,
    originAnchorId: merge.origin_anchor_id,
    options: {
      model: workflow.selected.model,
      reasoning: workflow.selected.reasoning,
      routeClass: 'mechanical',
      runnerSource: 'policy',
      workflowStage: 'maintenance',
      problemFingerprint: fingerprint,
      taskPath,
      workflow,
      parentJobId,
      closureKind: 'deploy',
      frozenSha,
      dispatchSource: 'harness-auto',
    },
  });
  if ('error' in created) {
    const replay = store.getByIdempotencyKey(idempotencyKey);
    if (replay) return { status: 'existing', kind: 'deploy', job: replay };
    throw new Error(`automatic deploy closure creation failed: ${created.error}`);
  }
  if (created.job.idempotency_key !== idempotencyKey) {
    throw new Error(`automatic deploy closure merged into unrelated active job ${created.job.id}`);
  }
  return { status: 'created', kind: 'deploy', job: created.job };
}

/** One deterministic Graph edge per terminal job; jobs.idempotency_key is the durable dedupe. */
export function ensureAutomaticClosureJob(store: JobStore, job: JobRow): ClosureOutcome {
  if (isHarnessReview(job)) return createMergeJob(store, job);
  return createDeployJob(store, job);
}
