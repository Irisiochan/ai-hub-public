import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db, JobRow } from '../platform/index.js';
import {
  type JobStore,
  normalizeWorkspace,
  workspaceAllowed,
  buildExecutionAttemptWorkspace,
  buildTaskWorkspace,
  classifyTargetWorkspace,
  isReservedReviewSlug,
  matchWorkspaceTarget,
  resolveProjectTarget,
  type ProjectTarget,
  type ProjectTargetsInput,
  buildDeployClosureCommand,
  buildDeployClosurePrompt,
  buildMergeClosureCommand,
  buildMergeClosurePrompt,
  hasRequiredMergeTests,
  deliveryMeta,
  receiptPatch,
  receiptPatchDelta,
  receiptUsage,
  structuredReceiptFields,
  splitPatchByFile,
  listPatchFiles,
  capabilityRejection,
  formatCapabilityReject,
  parseCapabilityCard,
} from '../jobs/index.js';
import {
  productionBaselineReaders,
  resolveBaselineDefault,
  taskSlugOf,
  type BaselineReaders,
  type BaselineSource,
  type PcCapability,
} from './baselineDefaults.js';
import { ensureTurnSchema, validateTurnCall } from './turnAttribution.js';
import {
  WORKFLOW_MODULE_IDS,
  WORKFLOW_MODULE_POLICY_VERSION,
  WORKFLOW_MODULES,
  isWorkflowRoomConfig,
  type ModuleBinding,
  type ModuleInvocation,
  type ModulePermissions,
  type WorkflowModuleId,
} from '../workflow/index.js';

/**
 * Model-driven room workflow: durable task-scoped operational ledger.
 *
 * One row in room_tasks is the single authority for status/revision/owner.
 * Events and evidence are append-only; historical job rows are never mutated
 * here (conclusions stay where the worker declared them). Every automatic
 * wakeup traces to a durable explicit model/user invocation: handoffs capture
 * the full target binding/permissions/approved-workspace snapshot at creation,
 * delivery wakes ONLY the captured recipient. Completion fulfills the return
 * mode registered at start: a pending handoff (accept still required) or a
 * notification. It never chooses a next stage or starts another job.
 */

export type RoomTaskStatus = 'open' | 'in_progress' | 'in_review' | 'blocked' | 'closed' | 'dropped';
export type RoomTaskHandoffStatus = 'pending' | 'accepted' | 'declined' | 'superseded' | 'failed';

export interface RoomTaskRow {
  id: string;
  room_id: string;
  task_path: string;
  title: string;
  requirements: string;
  requirements_sha: string;
  approved_workspace: string;
  anchor_message_id: number | null;
  status: RoomTaskStatus;
  revision: number;
  owner_module: string;
  owner_contact: string;
  /** O1 open-governance: holder module (single baton). Mirrors owner_module in strict mode. */
  holder_module: string | null;
  /** O1 open-governance: queued next holder while a Worker job is in flight. */
  next_module: string | null;
  /** O1 open-governance: wake-budget day bucket (YYYY-MM-DD, Shanghai). */
  wake_count_date: string | null;
  /** O1 open-governance: model wake count for the current day bucket. */
  wake_count: number;
  /** Min-closure-2: W-sequence JSON (array of {label, objective, write?, shell?}) or null. */
  sequence_json: string | null;
  /** Min-closure-2: current W-sequence index (0-based) or null. */
  sequence_index: number | null;
  active_handoff_id: string | null;
  candidate_sha: string | null;
  candidate_job_id: string | null;
  baseline_sha: string | null;
  /** W3: baseline 缺省来源（manual | deploy-receipt | ls-remote）；PC 未填时为 null。 */
  baseline_source: string | null;
  /** W3: 建账声明的 PC-only 能力（JSON 数组，camera/taobao/ssh/win32 子集）；无声明为 null。 */
  needs_pc: string | null;
  review_status: string | null;
  review_evidence_id: number | null;
  imported: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface RoomTaskHandoffRow {
  id: string;
  task_id: string;
  idempotency_key: string;
  from_module: string;
  from_contact: string;
  to_module: string;
  to_contact: string;
  to_revision: number;
  to_binding: string;
  to_permissions: string;
  approved_workspace: string;
  request: string;
  evidence_refs: string;
  status: RoomTaskHandoffStatus;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface CapturedHandoffSnapshot {
  binding: ModuleBinding;
  permissions: ModulePermissions;
  revision: number;
  workspace: string;
}

export interface RoomTaskCallbackRow {
  job_id: string;
  task_id: string;
  return_module: string;
  return_contact: string;
  return_revision: number;
  return_binding: string;
  return_permissions: string;
  created_at: string;
}

interface CompletionHandoffRow {
  job_id: string;
  task_id: string;
  from_module: string;
  from_contact: string;
  after_event_id: number;
  origin_turn_id: string;
  handoff_id: string | null;
}

/** Durable wake reference: exactly one of handoffId / callbackJobId. */
export interface RoomTaskWakeRef {
  taskId: string;
  handoffId?: string;
  callbackJobId?: string;
}

export interface RoomTaskDispatchResult {
  status: 'posted' | 'duplicate' | 'failed';
  messageId?: number;
  reason?: string;
}

/**
 * Delivery transport for handoffs and completion callbacks. Implementations
 * may only retry delivery to the SAME captured recipient (or wake the
 * explicitly registered return callback); they MUST NOT pick the next
 * task/stage/recipient.
 */
export interface RoomTaskDispatcher {
  /** Broadcast a persisted system fact only; never starts a room turn. */
  publishFact?(messageId: number): void;
  /** Notify room clients to re-read the ledger after a committed task event. */
  publishTaskChange?(roomId: string): void;
  dispatchToModule(
    roomId: string,
    moduleId: string,
    toContact: string,
    content: string,
    idempotencyKey: string,
    ref?: RoomTaskWakeRef,
  ): RoomTaskDispatchResult;
}

export interface RoomTaskStoreOptions {
  /** Trusted Vault task source for imports (server reads the file; models cannot). */
  readVaultTask?: (taskPath: string) => string | null;
  /**
   * Trusted User HTTP read endpoints (roomTasks.ts routes, User session
   * auth) may read without a model turn. NEVER set for the model tool
   * channel: buildRoomTaskTools force-clears it, so model native/MCP reads
   * always require a live exact origin-turn nonce.
   */
  irisReadEndpoint?: boolean;
  /**
   * Trusted per-turn tool context (server-built, never from caller args):
   * native builds it from the verified module invocation, MCP from the
   * signed invocation bearer. Null for DMs/legacy turns, which get NO room
   * task capabilities at all.
   */
  toolContext?: RoomTaskToolContext | null;
  /**
   * G02 VPS target map (from config.projectTargets). Absent/empty means no
   * mapped targets: the fence and attempt derivation stay inert and every PC
   * flow behaves exactly as before.
   */
  projectTargets?: ProjectTargetsInput;
  /**
   * W3 baseline 缺省读取器（部署回执 / git ls-remote / 祖先校验）。
   * 测试注入桩；缺省用生产 readers（只在 VPS 任务缺 baseline 时调用）。
   */
  baselineReaders?: BaselineReaders;
}

/**
 * Server-verified authority of the calling turn: the room session, the
 * captured module, and (for handoff/callback-woken turns) the pinned task.
 * Room/task/module mismatches against these values are rejected; a missing
 * context means the caller has no room authority (DMs included).
 */
export interface RoomTaskToolContext {
  roomId: string;
  moduleId: string;
  taskId?: string;
  handoffId?: string;
  /** Callback-woken turns carry the durable callback job id (server-verified). */
  callbackJobId?: string;
  /**
   * Trusted server-created origin-turn nonce for this call (bound at turn
   * start into this turn's own closures/bearer, never from model args).
   * Mutations present it; the store validates it is still active with exact
   * room/contact/module match so stale prior-turn calls can never satisfy a
   * newer turn.
   */
  turnId?: string;
}

export type StoreError = { error: string; code: 400 | 403 | 404 | 409 | 410 | 503 };

class AutoStartRollback extends Error {
  constructor(readonly failure: StoreError) { super(failure.error); }
}

const TASK_PATH_RE = /^tasks\/[^/\\]{1,100}\.md$/i;
const SHA40_RE = /^[0-9a-f]{40}$/i;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,120}$/;
/** Execute attempts allowed between independent review verdicts before a handoff back to execute is refused. */
export const EXECUTE_ROUNDS_BEFORE_REVIEW = 3;
/**
 * Min-closure-2: one W-sequence block handed by plan. `write`/`shell`
 * default to true (execute snapshot); only explicit false narrows.
 */
export interface RoomTaskSequenceItem {
  label: string;
  objective: string;
  write?: boolean;
  shell?: boolean;
}
/** Min-closure-2: W-sequence length guard (one W series per task). */
export const ROOM_TASK_SEQUENCE_MAX_ITEMS = 20;
/** R1: fixed preamble for the repair-Worker objective built from review findings. */
export const REVIEW_CHANGES_DIRECT_OBJECTIVE_PREAMBLE = '按评审 MUST 项返修；逐项满足通过条件；完成后送审';
/**
 * R2-D: review-patch machine gates (=原 R2a，上限/敏感清单/解析要求原样保留，
 * 落账形态按 D 改为合入脚本应用）。具名常量，单测覆盖。
 */
export const REVIEW_PATCH_MAX_CHARS = 8000;
export const REVIEW_PATCH_MAX_LINES = 40;
export const REVIEW_PATCH_MAX_FILES = 3;
// Pre-refactor paths stay listed: other repos and older branches may still use them.
export const REVIEW_PATCH_SENSITIVE = [
  'deploy/**',
  'worker/closure-runner.mjs',
  'worker/runner/closure-runner.mjs',
  'worker/provision.mjs',
  'worker/runner/provision.mjs',
  'server/src/middleware/**',
  'server/src/platform/middleware/**',
  'server/src/workers/workflowModules*',
  'server/src/workflow/workflowModules*',
  'server/src/workers/closureAutomation.ts',
  'server/src/jobs/closureAutomation.ts',
  'server/src/roomTasks/**',
  '**/*.ps1|sh|service',
  '.env*',
  'config*.json',
];
const REVIEW_PATCH_SHA256_RE = /^[0-9a-f]{64}$/i;
const ACTIVE_JOB_STATUSES = new Set([
  'pending', 'claimed', 'running', 'recovering', 'pause_requested', 'cancel_requested',
]);

function fail(error: string, code: StoreError['code'] = 400): StoreError {
  return { error, code };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJson(raw: string | null | undefined): Record<string, unknown> {
  try {
    return raw ? record(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

function text(value: unknown, limit = 20_000): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * P1 cost ledger: wall-clock duration of one attempt, derived from the job
 * row timestamps (created_at → updated_at, second precision). Null when
 * either timestamp is missing or unparseable — never estimated.
 */
function attemptDurationMs(job: Pick<JobRow, 'created_at' | 'updated_at'>): number | null {
  const start = Date.parse(String(job.created_at ?? ''));
  const end = Date.parse(String(job.updated_at ?? ''));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

/**
 * P1 cost ledger: the dispatch-time binding of one attempt. moduleId/runner/
 * model/reasoning come from `options.workflowModule.selected` (the real
 * binding at dispatch); legacy rows without it fall back to the job row /
 * top-level options, or null. Never throws on old shapes.
 */
function attemptLedgerIdentity(job: JobRow): {
  moduleId: string | null;
  runner: string;
  model: string | null;
  reasoning: string | null;
} {
  const options = parseJson(job.options);
  const workflowModule = record(options.workflowModule);
  const selected = record(workflowModule.selected);
  const moduleId = typeof workflowModule.moduleId === 'string' && workflowModule.moduleId
    ? workflowModule.moduleId
    : null;
  const runner = typeof selected.runner === 'string' && selected.runner
    ? selected.runner
    : job.runner;
  const model = typeof selected.model === 'string' && selected.model
    ? selected.model
    : typeof options.model === 'string' && options.model ? options.model : null;
  const reasoning = typeof selected.reasoning === 'string' && selected.reasoning
    ? selected.reasoning
    : typeof options.reasoning === 'string' && options.reasoning ? options.reasoning : null;
  return { moduleId, runner, model, reasoning };
}

function safeBranch(value: string): boolean {
  return BRANCH_RE.test(value)
    && !value.startsWith('-')
    && !value.startsWith('/')
    && !value.endsWith('/')
    && !value.includes('..')
    && !value.includes('//');
}

/**
 * R2-D D1: review-patch machine gates. Pure helpers so unit tests can pin
 * the exact rejection reason without a DB.
 */
function isWindowsPathForPatch(text: string): boolean {
  // Same shape as projectTargets.ts isWindowsPath: PC workspaces never take a patch.
  return /^[A-Za-z]:[\\/]/.test(text) || /^\\\\[^\\]+\\[^\\/]+/.test(text);
}

function unquoteReviewPatchPath(raw: string): string {
  let out = raw.trim();
  if (out.length >= 2 && out.startsWith('"') && out.endsWith('"')) {
    try {
      out = JSON.parse(out) as string;
    } catch {
      out = out.slice(1, -1);
    }
  }
  return out.replace(/^a\//, '').replace(/^b\//, '');
}

function normalizeReviewPatchPath(file: string): string | null {
  const normalized = file.trim().replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('-')) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return normalized;
}

export function isReviewPatchTestFile(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  if (/(^|\/)test\//.test(normalized)) return true;
  const base = normalized.split('/').pop() ?? '';
  return /\.test\.[^/]+$/.test(base);
}

export function isSensitiveReviewPatchFile(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  const base = normalized.split('/').pop() ?? '';
  const lower = normalized.toLowerCase();
  const baseLower = base.toLowerCase();
  if (normalized === 'deploy' || normalized.startsWith('deploy/')) return true;
  if (normalized === 'worker/closure-runner.mjs' || normalized === 'worker/provision.mjs') return true;
  if (normalized === 'worker/runner/closure-runner.mjs' || normalized === 'worker/runner/provision.mjs') return true;
  if (normalized.startsWith('server/src/middleware/')) return true;
  if (normalized.startsWith('server/src/platform/middleware/')) return true;
  if (normalized.startsWith('server/src/workers/workflowModules')) return true;
  if (normalized.startsWith('server/src/workflow/workflowModules')) return true;
  if (normalized === 'server/src/workers/closureAutomation.ts') return true;
  if (normalized === 'server/src/jobs/closureAutomation.ts') return true;
  if (normalized.startsWith('server/src/roomTasks/')) return true;
  if (lower.endsWith('.ps1') || lower.endsWith('.sh') || lower.endsWith('.service')) return true;
  if (base === '.env' || base.startsWith('.env.') || base.startsWith('.env-') || normalized.includes('/.env')) return true;
  if (baseLower.startsWith('config') && baseLower.endsWith('.json')) return true;
  return false;
}

interface ParsedReviewPatch {
  files: string[];
  lines: number;
  chars: number;
  sha256: string;
}

function parseReviewPatchStrict(patchText: string): { files: string[]; lines: number } {
  // Reuse splitPatchByFile/listPatchFiles for the file list (R2a requirement);
  // strict per-file checks (a/b consistency, no new/delete/rename/mode/binary)
  // are done on the raw blocks here.
  const listed = listPatchFiles(patchText);
  const header = /^diff --git ("[^"\n]+"|\S+) ("[^"\n]+"|\S+)\s*$/gm;
  const matches = [...patchText.matchAll(header)];
  if (matches.length === 0) {
    throw new Error('补丁无法严格解析：缺少 diff --git 头');
  }
  if (listed.length !== matches.length) {
    throw new Error('补丁无法严格解析：文件头与切分结果不一致');
  }
  const files: string[] = [];
  let lines = 0;
  for (let i = 0; i < matches.length; i += 1) {
    const aRaw = String(matches[i][1] ?? '');
    const bRaw = String(matches[i][2] ?? '');
    const aPath = unquoteReviewPatchPath(aRaw);
    const bPath = unquoteReviewPatchPath(bRaw);
    if (!aPath || !bPath || aPath !== bPath) {
      throw new Error(`补丁无法严格解析：a/ b/ 路径不一致（${aRaw} vs ${bRaw}）`);
    }
    const normalized = normalizeReviewPatchPath(bPath);
    if (!normalized) {
      throw new Error(`补丁路径非法（含 ..、绝对路径或空段）：${bPath.slice(0, 120)}`);
    }
    const start = matches[i].index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? patchText.length) : patchText.length;
    const block = patchText.slice(start, end);
    if (/^(new file mode|deleted file mode|rename from|rename to|old mode|new mode|Binary files |GIT binary patch)/m.test(block)
      || /^--- \/dev\/null/m.test(block) || /^\+\+\+ \/dev\/null/m.test(block)) {
      throw new Error(`补丁不得新增/删除/重命名/改 mode/binary：${normalized}`);
    }
    for (const line of block.split('\n')) {
      const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (stripped.startsWith('+++') || stripped.startsWith('---')) continue;
      if (stripped.startsWith('+') || stripped.startsWith('-')) lines += 1;
    }
    files.push(normalized);
  }
  return { files, lines };
}

export function validateReviewPatch(
  patchText: string,
  changedFiles: string[] | null,
): ParsedReviewPatch {
  const chars = patchText.length;
  if (chars === 0 || chars > REVIEW_PATCH_MAX_CHARS) {
    throw new Error(`补丁大小超限：${chars} 字符（上限 ${REVIEW_PATCH_MAX_CHARS}）`);
  }
  const parsed = parseReviewPatchStrict(patchText);
  if (parsed.files.length === 0 || parsed.files.length > REVIEW_PATCH_MAX_FILES) {
    throw new Error(`补丁文件数超限：${parsed.files.length} 个（上限 ${REVIEW_PATCH_MAX_FILES}）`);
  }
  if (parsed.lines > REVIEW_PATCH_MAX_LINES) {
    throw new Error(`补丁增删合计超限：${parsed.lines} 行（上限 ${REVIEW_PATCH_MAX_LINES}）`);
  }
  const allowed = new Set((changedFiles ?? []).map((file) => file.replaceAll('\\', '/')));
  for (const file of parsed.files) {
    if (isSensitiveReviewPatchFile(file)) {
      throw new Error(`补丁触碰敏感路径：${file}`);
    }
    if (!allowed.has(file) && !isReviewPatchTestFile(file)) {
      throw new Error(`补丁文件不在候选 changedFiles 且非测试文件：${file}`);
    }
  }
  return { files: parsed.files, lines: parsed.lines, chars, sha256: sha256(patchText) };
}

/**
 * Deploy gate branch proof for merge jobs.
 *
 * Old merges finished with the workspace switched onto master, so the
 * harness-collected receipt branch is 'master'. O5 worktree-safe merges
 * deliberately never check out the target branch (a linked worktree cannot
 * hold a branch checked out elsewhere) — Gate0 pins the workspace to the
 * working candidate branch instead — so their harness receipt branch is the
 * candidate branch. The push proof for those rows is the merge script's own
 * success report embedded in the job result (emitted only after its
 * push + ls-remote verification; any failure ends the job non-zero): lane
 * merge, ok true, target master, head equals the frozen candidate.
 *
 * WP-C: deterministic closure workers store the parsed script report at
 * delivery_meta.receipt.scriptReport. When present it is authoritative and
 * the result-text regex is skipped; legacy rows without scriptReport fall
 * back to the regex scan.
 */
export function mergeTargetBranchOk(
  result: string | null | undefined,
  receiptBranch: string | null,
  pinned: string,
  scriptReport?: unknown,
  expectedPatchSha256?: string | null,
): boolean {
  const report = scriptReport && typeof scriptReport === 'object' && !Array.isArray(scriptReport)
    ? scriptReport as Record<string, unknown>
    : null;
  if (report) {
    const head = String(report.head ?? '').toLowerCase();
    const branch = String(report.branch ?? '');
    const targetBranch = String((report as Record<string, unknown>).targetBranch ?? '');
    return report.ok === true
      && report.lane === 'merge'
      && (branch === 'master' || targetBranch === 'master')
      && mergedHeadOf(report, pinned, expectedPatchSha256) === head;
  }
  if (receiptBranch === 'master') return true;
  if (typeof result !== 'string' || !result) return false;
  const headRe = new RegExp(`"head"\\s*:\\s*"${pinned}"`, 'i');
  return /"ok"\s*:\s*true/i.test(result)
    && /"lane"\s*:\s*"merge"/.test(result)
    && /"(branch|targetBranch)"\s*:\s*"master"/.test(result)
    && headRe.test(result);
}

/**
 * The SHA a merge script report actually pushed for the approved `pinned`
 * candidate: pinned itself, or — after the script's own clean rebase
 * (User 2026-09-21) — the replayed head, accepted only when the report says
 * rebase=identical from exactly this pinned SHA. R2-D adds the review-patch
 * head: accepted only when the report says patch=identical from pinned (or
 * from the clean rebase of pinned) AND patchSha256 equals the pinning
 * APPROVE's structured patch sha (expectedPatchSha256, read from the event
 * payload — never from evidence prose). Null for anything else, including a
 * patched head with a mismatched or missing sha.
 */
export function mergedHeadOf(
  report: Record<string, unknown> | null,
  pinned: string,
  expectedPatchSha256?: string | null,
): string | null {
  if (!report) return null;
  const head = String(report.head ?? '').toLowerCase();
  const want = pinned.toLowerCase();
  if (head === want) return head;
  if (!SHA40_RE.test(head)) return null;
  if (report.patch === 'identical') {
    const patchedFrom = String(report.patchedFrom ?? '').toLowerCase();
    const patchSha = String(report.patchSha256 ?? '').toLowerCase();
    const expected = String(expectedPatchSha256 ?? '').toLowerCase();
    if (!SHA40_RE.test(patchedFrom)) return null;
    if (!REVIEW_PATCH_SHA256_RE.test(patchSha)) return null;
    if (!REVIEW_PATCH_SHA256_RE.test(expected) || patchSha !== expected) return null;
    if (patchedFrom === want) return head;
    if (report.rebase === 'identical' && String(report.rebasedFrom ?? '').toLowerCase() === want) {
      return head;
    }
    return null;
  }
  if (report.rebase === 'identical' && String(report.rebasedFrom ?? '').toLowerCase() === want) {
    return head;
  }
  return null;
}

function scriptReportOf(job: { delivery_meta?: string | null }): Record<string, unknown> | null {
  try {
    const meta = job.delivery_meta ? JSON.parse(job.delivery_meta) as Record<string, unknown> : {};
    const receipt = meta.receipt && typeof meta.receipt === 'object' && !Array.isArray(meta.receipt)
      ? meta.receipt as Record<string, unknown>
      : {};
    const report = receipt.scriptReport;
    return report && typeof report === 'object' && !Array.isArray(report)
      ? report as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function canonicalWorkspace(value: string): string {
  return normalizeWorkspace(value.trim()).toLowerCase();
}

export function roomTaskId(roomId: string, taskPath: string): string {
  return `${roomId}::${taskPath}`;
}

export function isModuleId(value: unknown): value is WorkflowModuleId {
  return typeof value === 'string'
    && (WORKFLOW_MODULE_IDS as readonly string[]).includes(value);
}

function moduleDefinition(moduleId: WorkflowModuleId) {
  return WORKFLOW_MODULES.find((item) => item.id === moduleId)!;
}

function parseBinding(raw: string): ModuleBinding | null {
  const value = parseJson(raw);
  if (typeof value.contactId !== 'string' || !value.contactId
    || typeof value.runner !== 'string' || !value.runner
    || typeof value.model !== 'string' || !value.model
    || typeof value.reasoning !== 'string' || !value.reasoning) {
    return null;
  }
  return {
    contactId: value.contactId,
    runner: value.runner as ModuleBinding['runner'],
    model: value.model,
    reasoning: value.reasoning,
  };
}

function parsePermissions(raw: string, moduleId: WorkflowModuleId): ModulePermissions | null {
  const value = parseJson(raw);
  if (['write', 'shell', 'ssh'].some((key) => typeof value[key] !== 'boolean')) return null;
  const definition = moduleDefinition(moduleId).permissions;
  // Stored snapshot may only narrow the static module policy, never widen.
  return {
    write: value.write === true && definition.write,
    shell: value.shell === true && definition.shell,
    ssh: value.ssh === true && definition.ssh,
  };
}

export class RoomTaskStore {
  private readonly readVaultTask: ((taskPath: string) => string | null) | null;
  private readonly toolContext: RoomTaskToolContext | null;
  private readonly irisReadEndpoint: boolean;
  private readonly projectTargets: ProjectTargetsInput;
  private readonly baselineReadersOverride: BaselineReaders | undefined;

  constructor(
    private readonly db: Db,
    private readonly jobs: JobStore,
    private readonly dispatch: RoomTaskDispatcher | null = null,
    options: RoomTaskStoreOptions = {},
  ) {
    this.readVaultTask = options.readVaultTask ?? null;
    this.toolContext = options.toolContext ?? null;
    this.irisReadEndpoint = options.irisReadEndpoint === true;
    this.projectTargets = options.projectTargets;
    this.baselineReadersOverride = options.baselineReaders;
  }

  /** W3 缺省 baseline 的读取器：测试桩优先，否则生产实现（懒解析，无缓存）。 */
  private baselineReaders(repoId: string): BaselineReaders {
    return this.baselineReadersOverride ?? productionBaselineReaders({ repoId });
  }

  /**
   * W3：解析任务声明的 PC-only 能力。needs_pc 列存 JSON 数组；
   * 空/非法一律按“不需要 PC”处理（fail open 只影响提示事件，不影响执行）。
   */
  private taskNeedsPc(task: Pick<RoomTaskRow, 'needs_pc'>): PcCapability[] {
    try {
      const raw = task.needs_pc ? JSON.parse(task.needs_pc) : [];
      if (!Array.isArray(raw)) return [];
      return raw.filter((item): item is PcCapability =>
        item === 'camera' || item === 'taobao' || item === 'ssh' || item === 'win32');
    } catch {
      return [];
    }
  }

  /** W3：worker 是否在线且接单（与 jobStore 70s 规则一致）。 */
  private isWorkerLive(workerId: string): boolean {
    try {
      const row = this.db.prepare(
        `SELECT id FROM workers WHERE id = ?
          AND accepting_jobs = 1 AND last_seen_at IS NOT NULL
          AND last_seen_at >= datetime('now', '-70 seconds')`,
      ).get(workerId) as { id: string } | undefined;
      return Boolean(row);
    } catch {
      return false;
    }
  }

  /** W3：是否有在线且接单的 worker 能认领该 job（runner + workspace + shell/ssh 上限）。 */
  private liveWorkersServing(job: { runner: string; workspace: string; permissions: string }): string[] {
    let workers: Array<{ id: string; capabilities: string }>;
    try {
      workers = this.db.prepare(
        `SELECT id, capabilities FROM workers
          WHERE accepting_jobs = 1 AND last_seen_at IS NOT NULL
            AND last_seen_at >= datetime('now', '-70 seconds')`,
      ).all() as Array<{ id: string; capabilities: string }>;
    } catch {
      return [];
    }
    let perms: { shell?: unknown; ssh?: unknown };
    try {
      perms = JSON.parse(job.permissions || '{}');
    } catch {
      perms = {};
    }
    const out: string[] = [];
    for (const worker of workers) {
      let caps: { runners?: unknown; workspaces?: unknown; shell?: unknown; ssh?: unknown };
      try {
        caps = JSON.parse(worker.capabilities || '{}');
      } catch {
        continue;
      }
      if (!Array.isArray(caps.runners) || !caps.runners.includes(job.runner)) continue;
      const roots = Array.isArray(caps.workspaces)
        ? caps.workspaces.filter((item): item is string => typeof item === 'string')
        : [];
      if (!workspaceAllowed(job.workspace, roots)) continue;
      if (perms.shell === true && caps.shell !== true) continue;
      if (perms.ssh === true && caps.ssh !== true) continue;
      out.push(worker.id);
    }
    return out;
  }

  /** W3：execute 绑定联系人的 delegation 固定 worker（未配置时 null）。 */
  private delegationWorkerOf(contactId: string): string | null {
    try {
      const row = this.db.prepare("SELECT config FROM contacts WHERE id = ?").get(contactId) as
        | { config: string }
        | undefined;
      if (!row) return null;
      const delegation = parseJson(row.config).delegation;
      const pinned = delegation && typeof delegation === 'object' && !Array.isArray(delegation)
        ? (delegation as Record<string, unknown>).workerId
        : null;
      return typeof pinned === 'string' && pinned.trim() ? pinned.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Capability-card admission: after the worker is selected (frozen VPS
   * target pin, else the execute binding's delegation pin), the worker's
   * card is checked BEFORE any job is created. A missing card (old worker)
   * passes. Pure read — safe inside the auto-start transactions; callers
   * persist the rejection (event + system fact) via
   * recordCapabilityRejectFromFailure after rollback.
   */
  private evaluateCapabilityCard(input: {
    task: RoomTaskRow;
    bindingContactId: string;
    frozenTarget: ProjectTarget | null;
    runner: string;
    needWrite: boolean;
  }): { workerId: string; field: string; value: string; reason: string; reasonLine: string } | null {
    const frozen = typeof input.frozenTarget?.workerId === 'string'
      ? input.frozenTarget.workerId.trim()
      : '';
    const workerId = frozen || this.delegationWorkerOf(input.bindingContactId) || '';
    if (!workerId) return null;
    let capabilities = '';
    try {
      const row = this.db.prepare('SELECT capabilities FROM workers WHERE id = ?').get(workerId) as
        | { capabilities: string }
        | undefined;
      if (!row) return null;
      capabilities = row.capabilities;
    } catch {
      return null;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(capabilities || '{}');
    } catch {
      return null;
    }
    const card = parseCapabilityCard(parsed);
    if (!card) return null;
    const rejection = capabilityRejection(card, { runner: input.runner, needWrite: input.needWrite });
    if (!rejection) return null;
    return {
      workerId,
      ...rejection,
      reasonLine: formatCapabilityReject(workerId, rejection.field, rejection.value, rejection.reason),
    };
  }

  /**
   * Persist a capability refusal: room_task_events kind=capability-reject
   * plus one system fact carrying the exact machine-readable reason line.
   * Binding, workspace and job ownership are untouched (refuse only).
   */
  private recordCapabilityRejection(
    taskId: string,
    actor: string,
    module: string,
    rejection: { workerId: string; field: string; value: string; reason: string; reasonLine: string },
  ): void {
    try {
      this.event(taskId, 'capability-reject', actor, {
        workerId: rejection.workerId,
        field: rejection.field,
        value: rejection.value,
        reason: rejection.reason,
        reasonLine: rejection.reasonLine,
      }, module);
    } catch {
      return;
    }
    try {
      const task = this.getTaskById(taskId);
      if (!task) return;
      const factId = Number(this.db.prepare(`INSERT INTO messages
        (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
        VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main', ?)`).run(
        task.room_id,
        `【能力卡拒绝】${task.task_path}：${rejection.reasonLine}；绑定与工作区未改动。`,
        JSON.stringify({
          event: 'room-task-capability-reject', taskId,
          workerId: rejection.workerId, field: rejection.field, value: rejection.value,
        }),
        `task-capability-reject:v1:${taskId}:${rejection.workerId}:${rejection.field}:${crypto.randomUUID().slice(0, 8)}`,
      ).lastInsertRowid);
      try { this.dispatch?.publishFact?.(factId); } catch { /* reconnect reloads the fact */ }
    } catch { /* the event above stands */ }
  }

  /**
   * After an AutoStartRollback (or a direct execution_start failure), persist
   * the capability refusal when the failure carries the reason line. No-op
   * for every other failure kind.
   */
  private recordCapabilityRejectFromFailure(
    taskId: string,
    actor: string,
    module: string,
    failure: { error: string },
  ): void {
    const match = /^capability-reject: (\S+) (\S+)=(\S+) ([\s\S]+)$/.exec(String(failure?.error ?? ''));
    if (!match) return;
    this.recordCapabilityRejection(taskId, actor, module, {
      workerId: match[1],
      field: match[2],
      value: match[3],
      reason: match[4],
      reasonLine: String(failure.error),
    });
  }

  /**
   * W3 MUST 4：execute 派发时的离线 fallback 提示——只记事件，不改绑定语义。
   * 触发条件（缺一不可）：任务批准工作区是 PC（非 VPS 围栏）、任务未声明
   * 任何 PC-only 能力、当前没有在线且接单的 worker 能认领该执行 job。
   * 事件载明可改选 VPS 工作区；绑定、工作区、job 归属一律不动。
   */
  private emitPcOfflineFallbackHint(
    task: RoomTaskRow,
    job: JobRow,
    bindingContactId: string,
    actor: string,
    module: string,
  ): void {
    if (this.taskNeedsPc(task).length > 0) return;
    if (matchWorkspaceTarget(task.approved_workspace, this.projectTargets)) return;
    const live = this.liveWorkersServing({ runner: job.runner, workspace: job.workspace, permissions: job.permissions });
    if (live.length > 0) return;
    const pinned = job.worker_id ?? this.delegationWorkerOf(bindingContactId);
    let pcIrisOffline = false;
    try {
      const row = this.db.prepare('SELECT id FROM workers WHERE id = ?').get('pc-User') as
        | { id: string }
        | undefined;
      pcIrisOffline = Boolean(row) && !this.isWorkerLive('pc-User');
    } catch {
      pcIrisOffline = false;
    }
    this.event(task.id, 'execute-pc-offline-fallback', actor, {
      jobId: job.id,
      runner: job.runner,
      workspace: job.workspace,
      ...(pinned ? { pinnedWorkerId: pinned } : {}),
      ...(pinned && !this.isWorkerLive(pinned) ? { pinnedWorkerOffline: true } : {}),
      pcIrisOffline,
      reason: pinned === 'pc-User' && !this.isWorkerLive('pc-User')
        ? 'execute 绑定指向 pc-User，但 pc-User 离线，执行 job 只能静默等待认领'
        : '当前没有在线且接单的 Worker 能认领该执行 job，只能静默等待',
      suggestion: '任务不需要 PC 能力（camera/taobao/ssh/win32 均未声明）；可在 VPS 围栏工作区重建任务（repo 进 projectTargets 映射后默认走 vps-dev），或等 pc-User 恢复后重试。绑定与工作区未改动。',
    }, module);
  }

  /**
   * Turn authority gate: every task tool requires a server-built room+module
   * context. Membership alone (e.g. a DM from a member contact, or the same
   * contact acting in another room) grants nothing.
   */
  private requireToolContext(): RoomTaskToolContext | StoreError {
    const c = this.toolContext;
    if (!c || typeof c.roomId !== 'string' || !c.roomId || typeof c.moduleId !== 'string' || !c.moduleId) {
      return fail('该工具需要会议室模块轮次授权；DM 或无模块上下文不能调用任务工具', 403);
    }
    if (!isModuleId(c.moduleId)) return fail(`轮次模块非法：${c.moduleId}`, 403);
    return c;
  }

  private checkRoom(c: RoomTaskToolContext, roomId: string): StoreError | null {
    if (roomId !== c.roomId) {
      return fail(`本轮次只授权房间 ${c.roomId}；不得操作 ${roomId}`, 403);
    }
    return null;
  }

  private checkTask(c: RoomTaskToolContext, task: RoomTaskRow): StoreError | null {
    if (c.taskId && c.taskId !== task.id) {
      return fail('本轮次只授权当前交接的任务；不得操作其他任务', 403);
    }
    return null;
  }

  /**
   * Origin-turn gate for model task READS (writes use requireActiveTurn).
   * Stale closures and old non-nonce bearers cannot read: the presented
   * nonce must still be active with exact room/contact/module match. The
   * trusted User HTTP endpoints bypass via the constructor carve-out only.
   * O3: open rooms fall back to per-contact bearer + membership (the hub MCP
   * bearer is verified at the HTTP layer; here we recheck room membership).
   */
  private requireReadTurn(c: RoomTaskToolContext, actor: string): StoreError | null {
    if (this.irisReadEndpoint) return null;
    const turn = validateTurnCall(c.turnId, {
      roomId: c.roomId,
      contactId: actor,
      moduleId: c.moduleId,
    });
    if (!turn) {
      try {
        if (this.isOpenGovernance(c.roomId) && this.isParticipant(c.roomId, actor)) return null;
      } catch { /* fall through to failure */ }
      return fail('任务读取需要当前轮次授权；旧轮次凭证不得读取（按当前轮次重读）', 403);
    }
    return null;
  }

  ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_tasks (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        task_path TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        requirements TEXT NOT NULL DEFAULT '',
        requirements_sha TEXT NOT NULL DEFAULT '',
        approved_workspace TEXT NOT NULL DEFAULT '',
        anchor_message_id INTEGER,
        status TEXT NOT NULL DEFAULT 'open',
        revision INTEGER NOT NULL DEFAULT 1,
        owner_module TEXT NOT NULL DEFAULT 'plan',
        owner_contact TEXT NOT NULL DEFAULT '',
        holder_module TEXT,
        next_module TEXT,
        wake_count_date TEXT,
        wake_count INTEGER NOT NULL DEFAULT 0,
        sequence_json TEXT,
        sequence_index INTEGER,
        active_handoff_id TEXT,
        candidate_sha TEXT,
        candidate_job_id TEXT,
        baseline_sha TEXT,
        baseline_source TEXT,
        needs_pc TEXT,
        review_status TEXT,
        review_evidence_id INTEGER,
        imported INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(room_id, task_path)
      );
      CREATE INDEX IF NOT EXISTS idx_room_tasks_room ON room_tasks(room_id);
      CREATE TABLE IF NOT EXISTS room_task_handoffs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES room_tasks(id),
        idempotency_key TEXT NOT NULL UNIQUE,
        from_module TEXT NOT NULL,
        from_contact TEXT NOT NULL,
        to_module TEXT NOT NULL,
        to_contact TEXT NOT NULL,
        to_revision INTEGER NOT NULL,
        to_binding TEXT NOT NULL DEFAULT '{}',
        to_permissions TEXT NOT NULL DEFAULT '{}',
        approved_workspace TEXT NOT NULL DEFAULT '',
        request TEXT NOT NULL DEFAULT '',
        evidence_refs TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        decided_by TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_room_task_handoffs_task ON room_task_handoffs(task_id, id);
      CREATE TABLE IF NOT EXISTS room_task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES room_tasks(id),
        kind TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT '',
        module TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_room_task_events_task ON room_task_events(task_id, id);
      CREATE TABLE IF NOT EXISTS room_task_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES room_tasks(id),
        kind TEXT NOT NULL,
        ref TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_room_task_evidence_task ON room_task_evidence(task_id, id);
      CREATE TABLE IF NOT EXISTS room_task_links (
        job_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES room_tasks(id),
        room_id TEXT NOT NULL,
        attached_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_room_task_links_task ON room_task_links(task_id);
      CREATE TABLE IF NOT EXISTS room_task_dispatches (
        idempotency_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'posted',
        message_id INTEGER,
        target TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS room_task_callbacks (
        job_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES room_tasks(id),
        return_module TEXT NOT NULL,
        return_contact TEXT NOT NULL,
        return_revision INTEGER NOT NULL,
        return_binding TEXT NOT NULL DEFAULT '{}',
        return_permissions TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_room_task_callbacks_task ON room_task_callbacks(task_id);
      CREATE TABLE IF NOT EXISTS room_task_completion_handoffs (
        job_id TEXT PRIMARY KEY REFERENCES room_task_callbacks(job_id),
        task_id TEXT NOT NULL REFERENCES room_tasks(id),
        from_module TEXT NOT NULL,
        from_contact TEXT NOT NULL,
        after_event_id INTEGER NOT NULL,
        origin_turn_id TEXT NOT NULL DEFAULT '',
        handoff_id TEXT REFERENCES room_task_handoffs(id)
      );
      CREATE TABLE IF NOT EXISTS room_task_waits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES room_tasks(id),
        mode TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        resume_condition TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1,
        actor TEXT NOT NULL DEFAULT '',
        module TEXT NOT NULL DEFAULT '',
        turn_id TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT 'task',
        callback_job_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_room_task_waits_task ON room_task_waits(task_id, id);
      CREATE INDEX IF NOT EXISTS idx_room_task_waits_turn ON room_task_waits(turn_id, id);
    `);
    // O1: additive columns for DBs created before migration 0038 (tests use
    // ensureSchema directly, bypassing the migration runner).
    this.ensureOpenGovernanceColumns();
  }

  private ensureOpenGovernanceColumns(): void {
    let info: Array<{ name: string }> = [];
    try {
      info = this.db.prepare(`PRAGMA table_info(room_tasks)`).all() as Array<{ name: string }>;
    } catch {
      return;
    }
    const names = new Set(info.map((col) => col.name));
    const missing: Array<{ name: string; ddl: string }> = [];
    if (!names.has('holder_module')) missing.push({ name: 'holder_module', ddl: `ALTER TABLE room_tasks ADD COLUMN holder_module TEXT` });
    if (!names.has('next_module')) missing.push({ name: 'next_module', ddl: `ALTER TABLE room_tasks ADD COLUMN next_module TEXT` });
    if (!names.has('wake_count_date')) missing.push({ name: 'wake_count_date', ddl: `ALTER TABLE room_tasks ADD COLUMN wake_count_date TEXT` });
    if (!names.has('wake_count')) missing.push({ name: 'wake_count', ddl: `ALTER TABLE room_tasks ADD COLUMN wake_count INTEGER NOT NULL DEFAULT 0` });
    if (!names.has('sequence_json')) missing.push({ name: 'sequence_json', ddl: `ALTER TABLE room_tasks ADD COLUMN sequence_json TEXT` });
    if (!names.has('sequence_index')) missing.push({ name: 'sequence_index', ddl: `ALTER TABLE room_tasks ADD COLUMN sequence_index INTEGER` });
    for (const col of missing) {
      try {
        this.db.exec(col.ddl);
      } catch {
        // Best-effort: concurrent ensureSchema calls may race the ALTER.
      }
    }
    try {
      this.db.exec(`UPDATE room_tasks SET holder_module = owner_module WHERE holder_module IS NULL`);
      this.db.exec(`UPDATE room_tasks SET wake_count = 0 WHERE wake_count IS NULL`);
    } catch {
      // Best-effort backfill.
    }
  }

  /**
   * O1: room governance mode. Reads contacts.config.governance, defaults to
   * 'strict'. Unknown values fall back to strict (fail-closed).
   */
  getRoomGovernance(roomId: string): 'strict' | 'open' {
    try {
      const row = this.db.prepare("SELECT config FROM contacts WHERE id = ?").get(roomId) as
        | { config: string }
        | undefined;
      if (!row) return 'strict';
      const cfg = JSON.parse(row.config || '{}') as { governance?: unknown };
      return cfg.governance === 'open' ? 'open' : 'strict';
    } catch {
      return 'strict';
    }
  }

  /** O1: true when the room runs open governance (five invariants only). */
  isOpenGovernance(roomId: string): boolean {
    return this.getRoomGovernance(roomId) === 'open';
  }

  /** O4: per-task daily wake budget (default 40, room config `wakeBudget` overrides). */
  getWakeBudget(roomId: string): number {
    try {
      const row = this.db.prepare("SELECT config FROM contacts WHERE id = ?").get(roomId) as
        | { config: string }
        | undefined;
      if (!row) return 40;
      const cfg = JSON.parse(row.config || '{}') as { wakeBudget?: unknown };
      const value = Number(cfg.wakeBudget);
      if (Number.isSafeInteger(value) && value >= 1 && value <= 10000) return value;
      return 40;
    } catch {
      return 40;
    }
  }

  /** O4: Shanghai day bucket YYYY-MM-DD for the wake budget. */
  static wakeDayBucket(now = Date.now()): string {
    return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  }

  /**
   * O4: count one model wake / Worker job start against the task's daily
   * budget. When the budget is exceeded the task auto-blocks with
   * `wake budget exhausted` (surfaced to User via blocked status + event +
   * evidence) and further wakes stop. Returns true when the caller may
   * proceed, false when exhausted.
   */
  countWakeOrBlock(taskId: string, actor: string, source: string): boolean {
    try {
      this.ensureSchema();
      const task = this.getTaskById(taskId);
      if (!task) return true;
      // Terminal tasks never wake; leave them to downstream logic untouched.
      if (['closed', 'dropped', 'blocked'].includes(task.status)) return true;
      // O4 budget is an open-governance defense; strict rooms keep legacy
      // behavior untouched (observation week).
      if (!this.isOpenGovernance(task.room_id)) return true;
      const today = RoomTaskStore.wakeDayBucket();
      const sameDay = task.wake_count_date === today;
      const next = (sameDay ? (task.wake_count ?? 0) : 0) + 1;
      this.db.prepare(`UPDATE room_tasks SET wake_count_date = ?, wake_count = ? WHERE id = ?`)
        .run(today, next, task.id);
      const budget = this.getWakeBudget(task.room_id);
      if (next > budget) {
        const bumped = this.bump(task.id, { status: 'blocked', next_module: null });
        void bumped;
        this.event(task.id, 'wake-budget-exhausted', actor, {
          source, count: next, budget, note: 'wake budget exhausted',
        });
        this.addEvidence(task.id, 'note', '', `wake budget exhausted: ${next} wakes on ${today} exceed budget ${budget} (source: ${source})`, actor);
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  /**
   * SHOULD-a: count an User @<member> direct wake against the referenced
   * task's daily budget. Only tasks/<name>.md of this room resolve; unknown
   * paths, terminal tasks and strict rooms are untouched. Never throws;
   * returns false when the wake exhausted the budget (task auto-blocked).
   */
  countMentionWake(roomId: string, taskPath: string, actor: string, moduleId: string): boolean {
    try {
      const task = this.getTask(roomId.trim(), taskPath.trim());
      if (!task) return true;
      return this.countWakeOrBlock(task.id, actor, `mention:${moduleId}`);
    } catch {
      return true;
    }
  }

  /**
   * SHOULD-a2: open tasks currently held by a module (single baton).
   * Closed/dropped tasks are excluded; a NULL holder falls back to the
   * owner module. Never throws; returns [] on any error.
   */
  openTasksHeldBy(roomId: string, moduleId: string): RoomTaskRow[] {
    try {
      this.ensureSchema();
      return this.db.prepare(
        `SELECT * FROM room_tasks WHERE room_id = ? AND status NOT IN ('closed', 'dropped')
         AND COALESCE(holder_module, owner_module) = ? ORDER BY updated_at DESC`,
      ).all(roomId, moduleId) as RoomTaskRow[];
    } catch {
      return [];
    }
  }

  private event(taskId: string, kind: string, actor: string, payload: Record<string, unknown> = {}, module?: string): void {
    const inserted = this.db.prepare(
      `INSERT INTO room_task_events (task_id, kind, actor, module, payload) VALUES (?, ?, ?, ?, ?)`,
    ).run(taskId, kind, actor, module ?? null, JSON.stringify(payload).slice(0, 20_000));
    const eventId = Number(inserted.lastInsertRowid);
    // Wait until the enclosing synchronous transaction has committed. A
    // rolled-back event must never announce a state that did not persist.
    queueMicrotask(() => {
      if (!this.dispatch?.publishTaskChange) return;
      try {
        const persisted = this.db.prepare('SELECT 1 FROM room_task_events WHERE id = ?').get(eventId);
        if (!persisted) return;
        const room = this.db.prepare('SELECT room_id FROM room_tasks WHERE id = ?').get(taskId) as { room_id: string } | undefined;
        if (room) this.dispatch.publishTaskChange(room.room_id);
      } catch { /* notification is best-effort; the ledger remains authoritative */ }
    });
  }

  /** W3：User 建账与内部建账共用的 VPS 默认工作区推导（纯确定性，可重入）。 */
  private resolveVpsDefaultWorkspace(taskPath: string, workspace: unknown, repoId: unknown): string | StoreError {
    const trimmed = typeof workspace === 'string' ? workspace.trim() : '';
    const repo = typeof repoId === 'string' ? repoId.trim() : '';
    if (trimmed || !repo) return trimmed;
    const target = resolveProjectTarget(repo, this.projectTargets);
    if (!target) return fail(`repo ${repo} 没有 projectTargets 映射；请显式给 workspace`, 400);
    const slug = taskSlugOf(taskPath);
    if (!slug) return fail('task_path 非法，无法按 repo 映射推导 VPS 工作区', 400);
    try {
      return buildTaskWorkspace(repo, slug, this.projectTargets);
    } catch (error) {
      return fail(`按 repo ${repo} 推导 VPS 工作区失败：${error instanceof Error ? error.message : String(error)}`, 400);
    }
  }
  /** Honest unsettled marker for the end-of-turn obligation gate. Never fakes a block. */
  recordUnsettled(taskId: string, actor: string, payload: { turnId: string; reason: string }, module?: string): void {
    this.ensureSchema();
    this.event(taskId, 'turn-unsettled', actor, {
      turnId: payload.turnId,
      reason: payload.reason.slice(0, 1000),
    }, module);
  }

  /**
   * Origin-turn gate for task MUTATIONS (reads stay available): the call
   * must present the nonce bound to its own origin turn, still active, with
   * exact room/contact/module match. Expired/unknown nonces are rejected —
   * never upgraded to another (e.g. latest) turn and never silently written
   * untraced. Pin consistency blocks scope borrowing (e.g. presenting B's
   * callbackJobId with A's nonce).
   * O3: open rooms fall back to per-contact bearer + membership: the bearer
   * is verified at the hub MCP HTTP layer, and here we recheck that the
   * caller is still a room member. Strict rooms keep the nonce gate.
   */
  private requireActiveTurn(c: RoomTaskToolContext, actor: string): StoreError | null {
    const turn = validateTurnCall(c.turnId, {
      roomId: c.roomId,
      contactId: actor,
      moduleId: c.moduleId,
    });
    if (!turn) {
      try {
        if (this.isOpenGovernance(c.roomId) && this.isParticipant(c.roomId, actor)) {
          if (!c.taskId && !c.handoffId && !c.callbackJobId) return null;
          // Pinned scopes still cannot be borrowed across turns, even open.
          return fail('轮次来源与任务授权不一致；不得借用其他轮次的回调/交接范围', 403);
        }
      } catch { /* fall through to failure */ }
      return fail('本轮次任务授权已过期或无效；旧轮次凭证不得操作任务（按当前轮次重走交接/等待）', 403);
    }
    for (const key of ['taskId', 'handoffId', 'callbackJobId'] as const) {
      const claimed = c[key];
      const pinned = turn[key];
      if (pinned && claimed !== pinned) {
        return fail('轮次来源与任务授权不一致；不得借用其他轮次的回调/交接范围', 403);
      }
      if (!pinned && claimed) {
        return fail('轮次来源与任务授权不一致；不得借用其他轮次的回调/交接范围', 403);
      }
    }
    return null;
  }

  private addEvidence(taskId: string, kind: string, ref: string, body: string, actor: string): number {
    const result = this.db.prepare(
      `INSERT INTO room_task_evidence (task_id, kind, ref, body, actor) VALUES (?, ?, ?, ?, ?)`,
    ).run(taskId, kind, ref.slice(0, 500), body.slice(0, 20_000), actor);
    return Number(result.lastInsertRowid);
  }

  private bump(taskId: string, patch: Record<string, string | number | null>): RoomTaskRow {
    // O1: strict mode keeps holder_module mirrored with owner_module until
    // task_pass (O2) takes over holder management in open mode.
    const effective: Record<string, string | number | null> = { ...patch };
    if ('owner_module' in effective && !('holder_module' in effective)) {
      effective.holder_module = effective.owner_module;
    }
    const keys = Object.keys(effective);
    const sets = [...keys.map((key) => `${key} = ?`), `revision = revision + 1`, `updated_at = datetime('now')`];
    const values = keys.map((key) => effective[key] ?? null);
    this.db.prepare(`UPDATE room_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, taskId);
    return this.requireTask(taskId);
  }

  requireTask(taskId: string): RoomTaskRow {
    const row = this.db.prepare('SELECT * FROM room_tasks WHERE id = ?').get(taskId) as RoomTaskRow | undefined;
    if (!row) throw new Error(`room task not found: ${taskId}`);
    return row;
  }

  handoffRow(handoffId: string): RoomTaskHandoffRow | undefined {
    this.ensureSchema();
    return this.db.prepare('SELECT * FROM room_task_handoffs WHERE id = ?').get(handoffId) as RoomTaskHandoffRow | undefined;
  }

  getTask(roomId: string, taskPath: string): RoomTaskRow | undefined {
    this.ensureSchema();
    return this.db.prepare('SELECT * FROM room_tasks WHERE id = ?').get(roomTaskId(roomId, taskPath)) as RoomTaskRow | undefined;
  }

  getTaskById(taskId: string): RoomTaskRow | undefined {
    this.ensureSchema();
    return this.db.prepare('SELECT * FROM room_tasks WHERE id = ?').get(taskId) as RoomTaskRow | undefined;
  }

  listTasks(roomId: string): RoomTaskRow[] {
    this.ensureSchema();
    return this.db.prepare(
      `SELECT * FROM room_tasks WHERE room_id = ? AND status NOT IN ('closed', 'dropped') ORDER BY updated_at DESC`,
    ).all(roomId) as RoomTaskRow[];
  }

  /** Room membership is the participation gate: members read their room's tasks, never other rooms or DMs. */
  isParticipant(roomId: string, contactId: string): boolean {
    if (!contactId) return false;
    const room = this.db.prepare("SELECT config FROM contacts WHERE id = ? AND kind = 'room' AND enabled = 1").get(roomId) as
      | { config: string }
      | undefined;
    if (!room) return false;
    try {
      const cfg = JSON.parse(room.config || '{}') as { members?: unknown };
      return Array.isArray(cfg.members) && cfg.members.includes(contactId);
    } catch {
      return false;
    }
  }

  private requireRoom(roomId: string): { id: string; members: string[] } | StoreError {
    const room = this.db.prepare("SELECT id, config FROM contacts WHERE id = ? AND kind = 'room' AND enabled = 1").get(roomId) as
      | { id: string; config: string }
      | undefined;
    if (!room) return fail(`room ${roomId} 不存在或未启用`, 404);
    let members: string[] = [];
    try {
      const cfg = JSON.parse(room.config || '{}') as { members?: unknown };
      members = Array.isArray(cfg.members) ? cfg.members.filter((item): item is string => typeof item === 'string') : [];
    } catch { members = []; }
    return { id: room.id, members };
  }

  /**
   * Creation/import must anchor to an authorized room user message (User's
   * approval in the room). Model-supplied arguments alone never grant
   * authority; the anchor is verified server-side from the messages table.
   */
  private verifyAnchor(roomId: string, anchorId: number): StoreError | null {
    if (!Number.isSafeInteger(anchorId) || anchorId <= 0) {
      return fail('anchor_message_id 必填：引用本室 User 批准该任务的用户消息 id', 400);
    }
    const row = this.db.prepare(
      'SELECT contact_id, sender, deleted FROM messages WHERE id = ?',
    ).get(anchorId) as { contact_id: string; sender: string; deleted: number } | undefined;
    if (!row || row.contact_id !== roomId || row.sender !== 'user' || Number(row.deleted) !== 0) {
      return fail('anchor 不是本室有效的 User 用户消息；先拿到批准再建账', 403);
    }
    return null;
  }

  private validateWorkspace(workspace: unknown): string | StoreError {
    const value = typeof workspace === 'string' ? workspace.trim() : '';
    if (!value || value.length > 1000) return fail('workspace 必填（绝对路径）', 400);
    if (!/^(?:[A-Za-z]:[\\/]|\/)[^\r\n]+$/.test(value)) return fail('workspace 必须是绝对路径', 400);
    // G02: a mapped VPS root itself is never a task workspace. Tasks register
    // a fenced `<root>/<taskSlug>` (exactly one segment); attempt directories
    // are derived by execution_start, never registered directly. Unmapped
    // (PC) workspaces skip this check entirely.
    const probe = value.replace(/\/+$/, '') || '/';
    const mapped = matchWorkspaceTarget(probe, this.projectTargets);
    if (mapped) {
      const fenced = classifyTargetWorkspace(probe, this.projectTargets);
      if (!fenced || fenced.depth !== 1) {
        return fail(
          `VPS 试点任务必须登记任务级工作区：${mapped.workspace}/<任务slug>（恰好一段）；执行尝试由 execution_start 派生，不得直接登记尝试目录或映射根`,
          400,
        );
      }
      if (isReservedReviewSlug(fenced.segments[0])) {
        return fail('任务工作区不得占用 review-<sha> 独立评审检出命名空间', 400);
      }
    }
    return value;
  }

  private currentBindingContact(moduleId: WorkflowModuleId): { contactId: string; revision: number } | StoreError {
    try {
      const bindings = this.jobs.workflowModules.bindings();
      const revision = this.jobs.workflowModules.revision();
      const contactId = bindings[moduleId]?.contactId;
      if (!contactId) return fail(`module ${moduleId} 当前没有绑定联系人`, 409);
      const contact = this.db.prepare("SELECT id FROM contacts WHERE id = ? AND kind = 'dm' AND enabled = 1").get(contactId);
      if (!contact) return fail(`module ${moduleId} 绑定的联系人 ${contactId} 不可用`, 409);
      return { contactId, revision };
    } catch (error) {
      return fail(`读取模块绑定失败：${error instanceof Error ? error.message : String(error)}`, 503);
    }
  }

  /**
   * Attach pre-existing jobs to a task. Only server-verified origin counts:
   * the job's origin room AND recorded taskPath must match this room/task.
   * Arbitrary job ids / forged scopes are never attached here.
   */
  attachVerifiedJobs(task: RoomTaskRow, attachedBy: string): string[] {
    const attached: string[] = [];
    const candidates = this.db.prepare(
      `SELECT * FROM jobs WHERE origin_contact_id = ? AND deleted = 0`,
    ).all(task.room_id) as JobRow[];
    for (const job of candidates) {
      const options = parseJson(job.options);
      if (typeof options.taskPath === 'string' && options.taskPath === task.task_path) {
        const change = this.db.prepare(
          'INSERT OR IGNORE INTO room_task_links (job_id, task_id, room_id, attached_by) VALUES (?, ?, ?, ?)',
        ).run(job.id, task.id, task.room_id, attachedBy);
        if (change.changes) attached.push(job.id);
      }
    }
    return attached;
  }

  linkJob(taskId: string, jobId: string, attachedBy: string): void {
    const task = this.requireTask(taskId);
    this.db.prepare(
      'INSERT OR IGNORE INTO room_task_links (job_id, task_id, room_id, attached_by) VALUES (?, ?, ?, ?)',
    ).run(jobId, taskId, task.room_id, attachedBy);
  }

  linkedJobs(taskId: string): JobRow[] {
    return this.db.prepare(
      `SELECT j.* FROM jobs j JOIN room_task_links l ON l.job_id = j.id WHERE l.task_id = ? ORDER BY j.created_at ASC, j.id ASC`,
    ).all(taskId) as JobRow[];
  }

  activeLinkedJobs(taskId: string): JobRow[] {
    return this.linkedJobs(taskId).filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
  }

  /**
   * Q1 (cost batch 2): chat-seat token usage attributed to one task.
   *
   * Attribution (additive, never averaged or duplicated):
   * - a turn pinned to this task (room_task_turns.task_id) belongs to it;
   * - otherwise an unpinned turn belongs to it only when its successful
   *   (ok=1) tool calls touch exactly one distinct task_id — that one;
   *   zero or many touches stay outside every task view.
   * Usage comes from message_usage via the turn's final assistant message_id
   * (LEFT JOIN: old rows without message_id and deleted usage rows contribute
   * count only, never throw). Split by turn module_id, never by contact, so
   * one contact holding several modules still attributes per module.
   */
  taskTurnCost(taskId: string): Record<string, unknown> {
    const zero = () => ({
      count: 0,
      byModule: {} as Record<string, Record<string, number>>,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    try {
      ensureTurnSchema(this.db);
      let hasMessageId = false;
      try {
        const info = this.db.prepare(`PRAGMA table_info(room_task_turns)`).all() as Array<{ name: string }>;
        hasMessageId = info.some((col) => col.name === 'message_id');
      } catch {
        return zero();
      }
      const msgSel = hasMessageId ? 't.message_id' : 'NULL AS message_id';
      const pinned = this.db.prepare(
        `SELECT t.turn_id AS turnId, t.module_id AS moduleId, ${msgSel} AS messageId
         FROM room_task_turns t WHERE t.task_id = ?`,
      ).all(taskId) as Array<{ turnId: string; moduleId: string; messageId: number | null }>;
      const touched = this.db.prepare(
        `SELECT t.turn_id AS turnId, t.module_id AS moduleId, ${msgSel} AS messageId
         FROM room_task_turns t
         WHERE (t.task_id IS NULL OR t.task_id = '')
           AND EXISTS (SELECT 1 FROM room_task_turn_calls c
             WHERE c.turn_id = t.turn_id AND c.ok = 1 AND c.task_id = ?)
           AND NOT EXISTS (SELECT 1 FROM room_task_turn_calls c
             WHERE c.turn_id = t.turn_id AND c.ok = 1
               AND (c.task_id IS NULL OR c.task_id <> ?))`,
      ).all(taskId, taskId) as Array<{ turnId: string; moduleId: string; messageId: number | null }>;
      const seen = new Set<string>();
      const turns: Array<{ moduleId: string; messageId: number | null }> = [];
      for (const row of [...pinned, ...touched]) {
        if (seen.has(row.turnId)) continue;
        seen.add(row.turnId);
        turns.push({ moduleId: row.moduleId ?? '', messageId: typeof row.messageId === 'number' ? row.messageId : null });
      }
      const usageByMessage = new Map<number, { input: number; output: number; creation: number; read: number }>();
      const ids = [...new Set(turns.map((t) => t.messageId).filter((id): id is number => typeof id === 'number' && id > 0))];
      if (ids.length > 0) {
        try {
          const placeholders = ids.map(() => '?').join(',');
          const rows = this.db.prepare(
            `SELECT message_id AS messageId, input_tokens AS inputTokens,
                    output_tokens AS outputTokens, cache_creation AS cacheCreation,
                    cache_read AS cacheRead
             FROM message_usage WHERE message_id IN (${placeholders})`,
          ).all(...ids) as Array<{ messageId: number; inputTokens: number; outputTokens: number; cacheCreation: number; cacheRead: number }>;
          for (const row of rows) {
            usageByMessage.set(row.messageId, {
              input: row.inputTokens ?? 0,
              output: row.outputTokens ?? 0,
              creation: row.cacheCreation ?? 0,
              read: row.cacheRead ?? 0,
            });
          }
        } catch {
          // message_usage missing (pre-0014 DB): turns still count, tokens stay zero
        }
      }
      const out = zero();
      for (const turn of turns) {
        out.count += 1;
        const module = turn.moduleId || '(unknown)';
        let slot = out.byModule[module];
        if (!slot) {
          slot = { count: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
          out.byModule[module] = slot;
        }
        slot.count += 1;
        const usage = turn.messageId !== null ? usageByMessage.get(turn.messageId) : undefined;
        if (usage) {
          slot.inputTokens += usage.input;
          slot.outputTokens += usage.output;
          slot.cacheReadTokens += usage.read;
          slot.cacheCreationTokens += usage.creation;
          out.tokens.inputTokens += usage.input;
          out.tokens.outputTokens += usage.output;
          (out.tokens as Record<string, number>).cacheReadTokens += usage.read;
          (out.tokens as Record<string, number>).cacheCreationTokens += usage.creation;
        }
      }
      return out;
    } catch {
      return zero();
    }
  }

  /**
   * P1 cost ledger: per-module-aggregatable summary of one task. Derived from
   * the linked job rows (never from model text): attempts count, summed
   * wall-clock duration, summed runner-reported tokens (present only when at
   * least one attempt reported usage), and the task's wake count. Old rows
   * without usage/timestamps simply contribute nothing — no throw.
   */
  taskCost(taskId: string): Record<string, unknown> {
    const task = this.getTaskById(taskId);
    const jobs = this.linkedJobs(taskId);
    let durationMs = 0;
    let hasDuration = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let hasTokens = false;
    let hasCacheRead = false;
    for (const job of jobs) {
      const attemptMs = attemptDurationMs(job);
      if (attemptMs !== null) {
        durationMs += attemptMs;
        hasDuration = true;
      }
      const usage = receiptUsage(job);
      if (usage) {
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        hasTokens = true;
        if (usage.cacheReadTokens !== null) {
          cacheReadTokens += usage.cacheReadTokens;
          hasCacheRead = true;
        }
      }
    }
    return {
      attempts: jobs.length,
      durationMs: hasDuration ? durationMs : null,
      ...(hasTokens
        ? {
          tokens: {
            inputTokens,
            outputTokens,
            ...(hasCacheRead ? { cacheReadTokens } : {}),
          },
        }
        : {}),
      wakes: task?.wake_count ?? 0,
      // Q1 (cost batch 2): chat-seat turns attributed to this task. Existing
      // attempts/durationMs/tokens/wakes shapes above are unchanged (tokens
      // stays Worker-attempt-only); section=summary shares this same object.
      turns: this.taskTurnCost(taskId),
    };
  }

  // ── create / import ────────────────────────────────────────────────

  createTask(input: {
    roomId: string;
    taskPath: string;
    title: string;
    requirements: string;
    workspace: string;
    anchorMessageId: number;
    actorContact: string;
    /** Trunk commit the work starts from. Required for VPS-fenced tasks. */
    baselineSha?: string | null;
    /**
     * W3: mapped repo id (server/config.json projectTargets key). When the
     * workspace is blank and the repo is mapped, the VPS fenced task
     * workspace `<root>/<taskSlug>` is used instead of a PC default.
     */
    repoId?: string | null;
    /** W3: declared PC-only capabilities (camera/taobao/ssh/win32 subset). */
    needsPc?: PcCapability[];
  }): { task: RoomTaskRow } | StoreError {
    return this.createTaskInternal(input, false);
  }

  private createTaskInternal(input: Parameters<RoomTaskStore['createTask']>[0], irisCreation: boolean): { task: RoomTaskRow } | StoreError {
    this.ensureSchema();
    const roomId = input.roomId.trim();
    const taskPath = input.taskPath.trim();
    const title = text(input.title, 300);
    const requirements = text(input.requirements, 20_000);
    const actor = input.actorContact.trim();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const roomMismatch = this.checkRoom(tc, roomId);
    if (roomMismatch) return roomMismatch;
    // Only a plan turn of THIS room may open a ledger. Membership alone is
    // not authority, and neither is being the same contact elsewhere.
    if (tc.moduleId !== 'plan') return fail('只有 plan 轮次可以创建任务账本', 403);
    if (!TASK_PATH_RE.test(taskPath)) return fail('task_path 必须是 tasks/<name>.md', 400);
    if (!title) return fail('title 必填', 400);
    if (!requirements) return fail('requirements 必填：交接必须携带原始需求全文', 400);
    // W3: 仓库有 projectTargets 映射且未显式给工作区时，默认选该映射的
    // VPS 围栏工作区（workerId/workspace/platform 按映射），不再默认 PC。
    // PC 工作区只在任务显式声明 camera/taobao/ssh/win32 能力时选。
    const needsPc = Array.isArray(input.needsPc)
      ? input.needsPc.filter((item): item is PcCapability =>
        item === 'camera' || item === 'taobao' || item === 'ssh' || item === 'win32')
      : [];
    // A saved User selection takes precedence over a model-supplied workspace
    // when a plan turn creates a NEW task. The resolved task workspace is then
    // frozen as usual; later changes to the selection cannot move it.
    const operatorTarget = irisCreation ? null : this.jobs.workflowModules.workerTarget();
    let selectedWorkspace = input.workspace;
    let selectedRepoId = input.repoId;
    if (operatorTarget) {
      const worker = this.db.prepare('SELECT capabilities FROM workers WHERE id = ?')
        .get(operatorTarget.workerId) as { capabilities: string } | undefined;
      const roots = worker ? parseJson(worker.capabilities).workspaces : null;
      if (!Array.isArray(roots) || !workspaceAllowed(operatorTarget.workspace,
        roots.filter((root): root is string => typeof root === 'string'))) {
        return fail('手动选择的 Worker 工作区已失效；请在工作流模块重新选择', 409);
      }
      if (operatorTarget.repoId) {
        const mapped = resolveProjectTarget(operatorTarget.repoId, this.projectTargets);
        if (!mapped || mapped.platform !== 'linux' || mapped.workerId !== operatorTarget.workerId || mapped.workspace !== operatorTarget.workspace) {
          return fail('手动选择的 VPS 仓库映射已变更；请在工作流模块重新选择', 409);
        }
        const slug = taskSlugOf(taskPath);
        if (!slug) return fail('task_path 非法，无法生成 VPS 工作区', 400);
        selectedWorkspace = buildTaskWorkspace(operatorTarget.repoId, slug, this.projectTargets);
        selectedRepoId = operatorTarget.repoId;
      } else {
        selectedWorkspace = operatorTarget.workspace;
        selectedRepoId = null;
      }
    }
    let workspaceRaw = this.resolveVpsDefaultWorkspace(taskPath, selectedWorkspace, selectedRepoId);
    if (typeof workspaceRaw !== 'string') return workspaceRaw;
    const repoId = typeof selectedRepoId === 'string' ? selectedRepoId.trim() : '';
    const workspace = this.validateWorkspace(workspaceRaw);
    if (typeof workspace !== 'string') return workspace;
    const vpsTarget = matchWorkspaceTarget(workspace, this.projectTargets);
    if (needsPc.length > 0 && vpsTarget) {
      return fail(
        `任务声明了 PC-only 能力（${needsPc.join('/')}），VPS 围栏工作区无法提供；请用 PC 工作区建账`,
        400,
      );
    }
    // Baseline at creation. Normally baseline_sha is learned from the first
    // implement attempt's before.head — but a VPS attempt must be PROVISIONED
    // (clone + checkout <baseSha>) before it can run at all, and provisioning
    // refuses without a baseSha by design (G04). So a VPS task created without
    // one could never start its first attempt. W3: 未填时按顺序取部署回执 /
    // git ls-remote，来源记 baseline_source；两者都取不到才报错要求手填。
    // Existence is proven by the
    // worker's checkout; a wrong-but-valid SHA surfaces as a stale merge, never
    // a silent bad one.
    const baselineRaw = typeof input.baselineSha === 'string' ? input.baselineSha.trim().toLowerCase() : '';
    if (baselineRaw && !SHA40_RE.test(baselineRaw)) return fail('baseline_sha 必须是 40 位 git SHA', 400);
    let baselineSha = baselineRaw || null;
    let baselineSource: BaselineSource | null = baselineRaw ? 'manual' : null;
    let baselineFellBackFrom: string | null = null;
    if (!baselineRaw && vpsTarget) {
      const resolved = resolveBaselineDefault(this.baselineReaders(vpsTarget.repoId));
      if (!resolved.ok) return fail(resolved.error, 400);
      baselineSha = resolved.sha;
      baselineSource = resolved.source;
      if (resolved.fellBackFromReceipt) baselineFellBackFrom = resolved.fellBackFromReceipt;
    }
    const room = this.requireRoom(roomId);
    if ('error' in room) return room;
    if (!irisCreation && !this.isParticipant(roomId, actor)) return fail('只有本会议室成员可以建任务', 403);
    const turnGate = irisCreation ? null : this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    const anchorError = this.verifyAnchor(roomId, Number(input.anchorMessageId));
    if (anchorError) return anchorError;
    if (this.getTask(roomId, taskPath)) return fail('任务已存在；用 task_get 读取或 task_import 接管', 409);
    const planBinding = this.currentBindingContact('plan');
    if ('error' in planBinding) return planBinding;
    if (!irisCreation && planBinding.contactId !== actor) {
      return fail('只有 plan 绑定者可以创建任务账本；不得冒用他人轮次身份', 403);
    }
    if (!room.members.includes(planBinding.contactId)) {
      return fail(`plan 绑定联系人 ${planBinding.contactId} 不在本会议室成员中`, 409);
    }
    const id = roomTaskId(roomId, taskPath);
    const needsPcJson = needsPc.length > 0 ? JSON.stringify(needsPc) : null;
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO room_tasks (id, room_id, task_path, title, requirements, requirements_sha,
          approved_workspace, anchor_message_id, status, revision, owner_module, owner_contact, holder_module, created_by,
          baseline_sha, baseline_source, needs_pc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, 'plan', ?, 'plan', ?, ?, ?, ?)`,
      ).run(id, roomId, taskPath, title, requirements, sha256(requirements),
        workspace, Number(input.anchorMessageId), planBinding.contactId, actor, baselineSha, baselineSource, needsPcJson);
      this.event(id, 'created', actor, {
        title, anchorMessageId: Number(input.anchorMessageId), approvedWorkspace: workspace, imported: false,
        ...(baselineSha ? { baselineSha } : {}),
        ...(baselineSource ? { baselineSource } : {}),
        ...(needsPc.length > 0 ? { needsPc } : {}),
        ...(repoId ? { repoId } : {}),
        ...(operatorTarget ? { workspaceSource: 'User-worker-default', workerId: operatorTarget.workerId } : {}),
      }, 'plan');
      if (baselineFellBackFrom && baselineSha) {
        this.event(id, 'baseline-fallback', actor, {
          receiptCommit: baselineFellBackFrom,
          masterSha: baselineSha,
          reason: '部署回执的 commit 不是远端 master 的祖先（未部署或已落后），已回退 git ls-remote master',
        }, 'plan');
      }
    })();
    const task = this.requireTask(id);
    const attached = this.attachVerifiedJobs(task, actor);
    if (attached.length) this.event(id, 'jobs-attached', actor, { jobIds: attached });
    return { task: this.requireTask(id) };
  }

  /** Only the User session HTTP route exposes this operation. The private
   * authorization flag is never accepted by model task tools. No model turn
   * is synthesized: the creator/initiator is User and the real user anchor is
   * committed atomically with the ledger and optional execution. */
  createFromIris(input: {
    roomId: string; taskPath: string; title: string; requirements: string; workspace: string;
    baselineSha?: string | null;
    /** W3: 映射仓库（workspace 为空时默认选其 VPS 围栏工作区）。 */
    repoId?: string | null;
    /** W3: 声明的 PC-only 能力（camera/taobao/ssh/win32 子集）。 */
    needsPc?: PcCapability[];
    dispatch?: { to_module: 'plan' | 'execute'; request: string; auto_start?: boolean; return_to_module?: string };
  }): { task: RoomTaskRow; anchorId: number; baselineSource: BaselineSource | null; handoff?: RoomTaskHandoffRow; job?: JobRow; delivery?: RoomTaskDispatchResult } | StoreError {
    this.ensureSchema();
    const room = this.db.prepare("SELECT config FROM contacts WHERE id = ? AND kind = 'room' AND enabled = 1")
      .get(input.roomId) as { config: string } | undefined;
    // Same room classification as module authority / dispatch: an explicit
    // workflowEnabled flag or the legacy coordination object both qualify.
    if (!room || !isWorkflowRoomConfig(parseJson(room.config))) return fail('必须是已启用的工作流会议室', 400);
    // W3: 先推导 VPS 默认工作区再做白名单检查，否则映射仓库的建账会被误拦。
    const resolvedWorkspace = this.resolveVpsDefaultWorkspace(input.taskPath, input.workspace, input.repoId);
    if (typeof resolvedWorkspace !== 'string') return resolvedWorkspace;
    const roots = (this.db.prepare('SELECT capabilities FROM workers').all() as Array<{ capabilities: string }>)
      .flatMap(row => {
        const values = parseJson(row.capabilities).workspaces;
        return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : [];
      });
    if (!resolvedWorkspace || !workspaceAllowed(resolvedWorkspace, roots)) return fail('workspace 不在 Worker 白名单中', 403);
    try {
      const result = this.jobs.transactionWithDeferredEvents(() => {
        const anchorId = Number(this.db.prepare(`INSERT INTO messages
          (contact_id, sender, role, kind, content, status, meta, origin)
          VALUES (?, 'user', 'user', 'text', ?, 'done', '{}', 'main')`)
          .run(input.roomId, `建账：${input.taskPath}`).lastInsertRowid);
        const created = this.createTaskInternal({ ...input, workspace: resolvedWorkspace, anchorMessageId: anchorId, actorContact: 'User' }, true);
        if ('error' in created) throw new AutoStartRollback(created);
        if (!input.dispatch) return { ...created, anchorId };
        const handed = this.handoffInternal({
          roomId: input.roomId, taskPath: input.taskPath, actorContact: 'User',
          toModule: input.dispatch.to_module, request: input.dispatch.request,
          autoStart: input.dispatch.auto_start, returnToModule: input.dispatch.return_to_module,
          expectedRevision: created.task.revision,
        }, true);
        if ('error' in handed) throw new AutoStartRollback(handed);
        return { ...handed, anchorId };
      });
      if ('handoff' in result) {
        if (result.job) {
          try { if (result.delivery.messageId) this.dispatch?.publishFact?.(result.delivery.messageId); } catch { /* persisted */ }
        } else {
          result.delivery = this.deliverHandoff(result.task, result.handoff, 'User');
        }
      }
      // W3 回执写清 baseline 来源（manual | deploy-receipt | ls-remote；PC 未填为 null）。
      const baselineSource = (result.task.baseline_source ?? null) as BaselineSource | null;
      return { ...result, baselineSource };
    } catch (error) {
      if (error instanceof AutoStartRollback) {
        try {
          const task = this.getTask(input.roomId.trim(), input.taskPath.trim());
          if (task) {
            this.recordCapabilityRejectFromFailure(task.id, 'User',
              typeof input.dispatch?.to_module === 'string' ? input.dispatch.to_module : 'execute',
              error.failure);
          }
        } catch { /* rejection persistence is best-effort */ }
        return error.failure;
      }
      throw error;
    }
  }

  importTask(input: {
    roomId: string;
    taskPath: string;
    title?: string;
    requirements?: string;
    workspace?: string;
    anchorMessageId: number;
    actorContact: string;
  }): { task: RoomTaskRow; attached: string[]; created: boolean } | StoreError {
    this.ensureSchema();
    const roomId = input.roomId.trim();
    const taskPath = input.taskPath.trim();
    const actor = input.actorContact.trim();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const roomMismatch = this.checkRoom(tc, roomId);
    if (roomMismatch) return roomMismatch;
    if (tc.moduleId !== 'plan') return fail('只有 plan 轮次可以接管任务', 403);
    if (!TASK_PATH_RE.test(taskPath)) return fail('task_path 必须是 tasks/<name>.md', 400);
    const room = this.requireRoom(roomId);
    if ('error' in room) return room;
    if (!this.isParticipant(roomId, actor)) return fail('只有本会议室成员可以接管任务', 403);
    const turnGate = this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    const anchorError = this.verifyAnchor(roomId, Number(input.anchorMessageId));
    if (anchorError) return anchorError;
    const existing = this.getTask(roomId, taskPath);
    if (existing) {
      const attached = this.attachVerifiedJobs(existing, actor);
      if (attached.length) this.event(existing.id, 'jobs-attached', actor, { jobIds: attached });
      return { task: this.requireTask(existing.id), attached, created: false };
    }
    // Trusted Vault source wins over model-supplied text: when the server can
    // read the approved task file, its content is the requirements.
    const vaultText = this.readVaultTask ? this.readVaultTask(taskPath) : null;
    const requirements = text(vaultText ?? input.requirements, 20_000);
    if (!requirements) return fail('requirements 必填（Vault 读不到该任务原文时由调用方提供）', 400);
    const suppliedWorkspace = input.workspace !== undefined ? this.validateWorkspace(input.workspace) : null;
    if (suppliedWorkspace && typeof suppliedWorkspace !== 'string') return suppliedWorkspace;
    const planBinding = this.currentBindingContact('plan');
    if ('error' in planBinding) return planBinding;
    const id = roomTaskId(roomId, taskPath);
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO room_tasks (id, room_id, task_path, title, requirements, requirements_sha,
          approved_workspace, anchor_message_id, status, revision, owner_module, owner_contact, holder_module, imported, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, 'plan', ?, 'plan', 1, ?)`,
      ).run(
        id, roomId, taskPath,
        text(input.title, 300) || taskPath,
        requirements, sha256(requirements),
        typeof suppliedWorkspace === 'string' ? suppliedWorkspace : '',
        Number(input.anchorMessageId),
        planBinding.contactId, actor,
      );
      this.event(id, 'created', actor, {
        title: text(input.title, 300), imported: true, fromVault: vaultText !== null,
        anchorMessageId: Number(input.anchorMessageId),
      }, 'plan');
    })();
    let task = this.requireTask(id);
    const attached = this.attachVerifiedJobs(task, actor);
    // Approved workspace binding for imports: when verified prior attempts
    // exist, the workspace they actually used is the approved one
    // (server-derived, not model-chosen). A conflicting model arg is rejected.
    if (attached.length) {
      const workspaces = new Map<string, number>();
      for (const jobId of attached) {
        const job = this.jobs.get(jobId);
        if (job) workspaces.set(canonicalWorkspace(job.workspace), (workspaces.get(canonicalWorkspace(job.workspace)) ?? 0) + 1);
      }
      const top = [...workspaces.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top) {
        const approved = this.jobs.get(attached.find((jobId) => {
          const job = this.jobs.get(jobId);
          return job ? canonicalWorkspace(job.workspace) === top[0] : false;
        })!)!.workspace;
        if (typeof suppliedWorkspace === 'string' && canonicalWorkspace(suppliedWorkspace) !== top[0]) {
          this.db.prepare('DELETE FROM room_tasks WHERE id = ?').run(id);
          return fail(`workspace 与已验证旧尝试的批准工作区不一致；用 ${approved} 重试`, 409);
        }
        this.db.prepare('UPDATE room_tasks SET approved_workspace = ? WHERE id = ?').run(approved, id);
      }
    }
    if (!attached.length && typeof suppliedWorkspace !== 'string') {
      this.db.prepare('DELETE FROM room_tasks WHERE id = ?').run(id);
      return fail('没有可验证的旧尝试，import 必须显式提供 workspace', 400);
    }
    task = this.requireTask(id);
    if (attached.length) this.event(id, 'jobs-attached', actor, { jobIds: attached });
    return { task, attached, created: true };
  }

  // ── read ───────────────────────────────────────────────────────────

  jobBrief(job: JobRow): Record<string, unknown> {
    const receipt = structuredReceiptFields(job);
    const options = parseJson(job.options);
    const identity = attemptLedgerIdentity(job);
    return {
      id: job.id,
      status: job.status,
      deliveryState: job.delivery_state,
      runner: job.runner,
      workspace: job.workspace,
      requestedBy: job.requested_by,
      model: typeof options.model === 'string' ? options.model : null,
      branch: receipt.branch ?? null,
      head: receipt.head ?? null,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      // P1 cost ledger (additive; null when the row predates the ledger).
      durationMs: attemptDurationMs(job),
      moduleId: identity.moduleId,
      ...(receipt.usage ? { usage: receipt.usage } : {}),
      ...(job.error ? { error: job.error.slice(0, 500) } : {}),
    };
  }

  getFull(input: {
    roomId: string;
    taskPath: string;
    actorContact: string;
    receiptJobId?: string;
    receiptOffset?: number;
    receiptLimit?: number;
    eventLimit?: number;
    /** P4: 'summary' returns only status + recent events (no requirements/evidence/handoffs). Default 'full' keeps current behavior. */
    section?: string;
  }): { view: Record<string, unknown> } | StoreError {
    this.ensureSchema();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const roomMismatch = this.checkRoom(tc, input.roomId.trim());
    if (roomMismatch) return roomMismatch;
    const readGate = this.requireReadTurn(tc, input.actorContact.trim());
    if (readGate) return readGate;
    const task = this.getTask(input.roomId.trim(), input.taskPath.trim());
    if (!task) return fail('任务不存在', 404);
    const taskMismatch = this.checkTask(tc, task);
    if (taskMismatch) return taskMismatch;
    if (input.actorContact.trim() !== 'User' && !this.isParticipant(task.room_id, input.actorContact.trim())) {
      return fail('跨会议室任务不可读；只有本室成员可以读取关联任务', 403);
    }
    const handoffs = this.db.prepare(
      'SELECT * FROM room_task_handoffs WHERE task_id = ? ORDER BY created_at ASC, id ASC',
    ).all(task.id) as RoomTaskHandoffRow[];
    const eventLimit = Math.min(Math.max(Number(input.eventLimit) || 100, 1), 500);
    const events = this.db.prepare(
      'SELECT * FROM room_task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?',
    ).all(task.id, eventLimit) as Array<Record<string, unknown>>;
    // P4: summary skips the heavy reads (requirements, handoffs, evidence,
    // attempts, waits) for status-only polls.
    if (input.section === 'summary') {
      return {
        view: {
          task: {
            id: task.id,
            room_id: task.room_id,
            task_path: task.task_path,
            title: task.title,
            status: task.status,
            revision: task.revision,
            owner_module: task.owner_module,
            owner_contact: task.owner_contact,
            holder_module: task.holder_module,
            next_module: task.next_module,
            candidate_sha: task.candidate_sha,
            candidate_job_id: task.candidate_job_id,
            review_status: task.review_status,
            sequence_json: task.sequence_json,
            sequence_index: task.sequence_index,
            wake_count: task.wake_count,
            updated_at: task.updated_at,
          },
          events: [...events].reverse(),
          cost: this.taskCost(task.id),
        },
      };
    }
    const evidence = this.db.prepare(
      'SELECT * FROM room_task_evidence WHERE task_id = ? ORDER BY id ASC LIMIT 200',
    ).all(task.id) as Array<Record<string, unknown>>;
    const attempts = this.linkedJobs(task.id).map((job) => this.jobBrief(job));
    let waits: Array<Record<string, unknown>> = [];
    try {
      waits = this.db.prepare(
        'SELECT * FROM room_task_waits WHERE task_id = ? ORDER BY id ASC LIMIT 100',
      ).all(task.id) as Array<Record<string, unknown>>;
    } catch {
      waits = [];
    }
    let receiptPage: Record<string, unknown> | null = null;
    if (input.receiptJobId) {
      const job = this.jobs.get(String(input.receiptJobId));
      const linked = job && this.db.prepare(
        'SELECT 1 FROM room_task_links WHERE job_id = ? AND task_id = ?',
      ).get(job.id, task.id);
      if (!job || !linked) return fail('该 job 不属于本任务（伪造/跨任务引用已拒绝）', 404);
      const payload = job.result ?? job.error ?? '';
      const offset = Math.min(Math.max(Number(input.receiptOffset) || 0, 0), payload.length);
      const limit = Math.min(Math.max(Number(input.receiptLimit) || 4000, 1), 12_000);
      const end = Math.min(offset + limit, payload.length);
      receiptPage = {
        jobId: job.id,
        kind: job.result ? 'result' : job.error ? 'error' : 'empty',
        start: offset,
        end,
        total: payload.length,
        page: payload.slice(offset, end),
        atEnd: end >= payload.length,
        nextOffset: end,
      };
    }
    let unsettledRecoveries: UnsettledRecovery[] = [];
    try {
      unsettledRecoveries = findTaskUnsettledRecoveries(this.db, this.jobs, task.id);
    } catch {
      unsettledRecoveries = [];
    }
    return {
      view: {
        task,
        handoffs: handoffs.map((row) => ({
          ...row,
          toBinding: parseJson(row.to_binding),
          toPermissions: parseJson(row.to_permissions),
          evidenceRefs: parseJson(row.evidence_refs),
        })),
        events: [...events].reverse(),
        evidence,
        attempts,
        waits,
        unsettledRecoveries,
        cost: this.taskCost(task.id),
        ...(receiptPage ? { receiptPage } : {}),
      },
    };
  }

  // ── explicit wait / blocker disposition (handoff obligation) ──────────

  listWaits(taskId: string): Array<Record<string, unknown>> {
    this.ensureSchema();
    try {
      return this.db.prepare(
        'SELECT * FROM room_task_waits WHERE task_id = ? ORDER BY id ASC LIMIT 100',
      ).all(taskId) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  }

  /**
   * Explicit waiting/blocker disposition for the end-of-turn handoff
   * obligation. The model chooses to wait; the gateway only validates and
   * persists. No timers, no auto-wake, no next-stage selection.
   *
   * - mode blocked | waiting_user: owner-only, affects task-level status
   *   (blocked sets status=blocked; waiting_user keeps status; both bump
   *   revision). The wait row saves the EFFECTIVE post-bump revision so the
   *   end-of-turn gate (wait.revision === current revision) accepts a
   *   brand-new valid wait.
   * - mode waiting_owner: callback-only scoped disposition for a verified
   *   non-owner callback turn. Records ONLY the callback scope
   *   (turn + callback job), never changes global task status/owner/revision,
   *   and grants no handoff/release rights; saves the current revision.
   */
  waitFor(input: {
    roomId: string;
    taskPath: string;
    actorContact: string;
    mode: string;
    reason: string;
    resumeCondition?: string;
    question?: string;
    expectedRevision: number;
  }): { task: RoomTaskRow; waitId: number; scope: string } | StoreError {
    this.ensureSchema();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const roomMismatch = this.checkRoom(tc, input.roomId.trim());
    if (roomMismatch) return roomMismatch;
    const task0 = this.getTask(input.roomId.trim(), input.taskPath.trim());
    if (!task0) return fail('任务不存在', 404);
    const taskMismatch = this.checkTask(tc, task0);
    if (taskMismatch) return taskMismatch;
    const actor = input.actorContact.trim();
    if (!this.isParticipant(task0.room_id, actor)) return fail('只有本会议室成员可以登记等待/受阻', 403);
    const turnGate = this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    if (['closed', 'dropped'].includes(task0.status)) return fail(`任务已 ${task0.status}，不再接受等待登记`, 409);
    const mode = String(input.mode || '').trim().toLowerCase().replace(/-/g, '_');
    if (!['blocked', 'waiting_user', 'waiting_owner'].includes(mode)) {
      return fail('mode 必须是 blocked | waiting_user | waiting_owner（waiting_owner 仅回调轮次）', 400);
    }
    const reason = text(input.reason, 5000);
    if (reason.length < 10) return fail('reason 必填且需实质内容（≥10 字）：写清为什么停在这里', 400);
    const resume = text(input.resumeCondition ?? (input as { resume_condition?: unknown }).resume_condition, 5000)
      || text(input.question, 5000);
    if (!resume || resume.length < 5) {
      return fail('resume_condition/question 必填（≥5 字）：写清恢复条件或要 User 决定的问题', 400);
    }
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      return fail('expected_revision 必须是正整数（任务 revision 守卫）', 400);
    }
    if (expectedRevision !== task0.revision) {
      return fail(`任务 revision 已变化（期望 ${expectedRevision}，当前 ${task0.revision}）；先 task_get 再试`, 409);
    }
    const turnId = typeof tc.turnId === 'string' ? tc.turnId : '';
    const callbackJobId = typeof tc.callbackJobId === 'string' ? tc.callbackJobId : '';

    if (mode === 'waiting_owner') {
      // Callback-scoped only: the turn must carry a verified callback
      // provenance for THIS task (contact + module + room + job all match a
      // live unfenced registration, task pin riding alongside). Owner turns
      // must use blocked/waiting_user. Terminal attempts are legitimate:
      // the completion callback fires exactly at terminality.
      if (!callbackJobId) return fail('waiting_owner 仅回调轮次可用；负责人用 blocked/waiting_user', 403);
      // A callback scope claim must ride with its task pin: a bare
      // callbackJobId without the task pin is a borrowed scope, never a
      // legitimate callback-woken turn (the manager always sets both).
      if (typeof tc.taskId !== 'string' || !tc.taskId) {
        return fail('waiting_owner 需要任务 pin 与回调范围同行；不得单独借用回调范围', 403);
      }
      const cb = this.db.prepare(
        'SELECT * FROM room_task_callbacks WHERE job_id = ?',
      ).get(callbackJobId) as RoomTaskCallbackRow | undefined;
      if (!cb || cb.task_id !== task0.id) return fail('回调登记与本任务不一致；不得跨任务登记 scoped 等待', 403);
      if (!isModuleId(cb.return_module)) return fail('回调登记模块非法', 410);
      if (cb.return_module !== tc.moduleId) {
        return fail(`本轮次是 ${tc.moduleId} 身份，回调点名 ${cb.return_module}；不得跨模块登记 scoped 等待`, 403);
      }
      if (cb.return_contact !== actor) {
        return fail(`该回调点名 ${cb.return_contact}；你不是被选中的回调接收人`, 403);
      }
      try {
        if (this.jobs.workflowModules.isFenced(callbackJobId)) {
          return fail('该回调尝试已被接管废弃；旧回调已失效', 409);
        }
      } catch {
        return fail('回调围栏校验失败', 503);
      }
      // waiting_owner awaits the attempt's completion callback: the callback
      // fires exactly when the job goes terminal (done/failed/blocked), so
      // terminal jobs are legitimate here — this is NOT claiming the job is
      // still ongoing (that claim belongs to execution_get acknowledgment,
      // which does reject terminal jobs). Fenced attempts stay rejected.
      const cbJob = this.jobs.get(callbackJobId);
      if (!cbJob) return fail('回调尝试已不在队列记录中', 404);
      // Same contact different role cannot bypass: an owner wearing another
      // hat is still not the callback recipient for that module.
      if (actor === task0.owner_contact && tc.moduleId === task0.owner_module) {
        return fail('负责人本轮请用 blocked/waiting_user；waiting_owner 只给非负责人回调轮次', 403);
      }
      const result = this.db.prepare(
        `INSERT INTO room_task_waits
          (task_id, mode, reason, resume_condition, revision, actor, module, turn_id, scope, callback_job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'callback', ?)`,
      ).run(task0.id, mode, reason, resume, task0.revision, actor, tc.moduleId, turnId, callbackJobId);
      const waitId = Number(result.lastInsertRowid);
      this.event(task0.id, 'callback-wait-registered', actor, {
        waitId, mode, revision: task0.revision, turnId: turnId || null,
        callbackJobId, reason: reason.slice(0, 500), resume: resume.slice(0, 500),
      }, tc.moduleId);
      return { task: this.requireTask(task0.id), waitId, scope: 'callback' };
    }

    // Task-level: owner + owner-module hat only. Bump first so the wait row
    // records the effective post-bump revision (otherwise a brand-new valid
    // wait would read as stale at the end-of-turn gate).
    const ownerScope = this.requireOwnerScope(task0, actor, tc);
    if (ownerScope) return ownerScope;
    const waitInsert = this.db.transaction(() => {
      const bumped = this.bump(task0.id, mode === 'blocked' ? { status: 'blocked' } : {});
      const result = this.db.prepare(
        `INSERT INTO room_task_waits
          (task_id, mode, reason, resume_condition, revision, actor, module, turn_id, scope, callback_job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'task', NULL)`,
      ).run(task0.id, mode, reason, resume, bumped.revision, actor, tc.moduleId, turnId);
      const waitId = Number(result.lastInsertRowid);
      const evidenceId = this.addEvidence(task0.id, 'note', String(waitId),
        [`wait=${mode}`, `reason=${reason}`, `resume=${resume}`, `turn=${turnId || '(direct)'}`].join('\n').slice(0, 5000),
        actor);
      this.event(task0.id, mode === 'blocked' ? 'blocked-registered' : 'wait-registered', actor, {
        waitId, evidenceId, mode, revision: bumped.revision, turnId: turnId || null,
        reason: reason.slice(0, 500), resume: resume.slice(0, 500),
      }, tc.moduleId);
      return { task: bumped, waitId };
    });
    const outcome = waitInsert();
    return { task: outcome.task, waitId: outcome.waitId, scope: 'task' };
  }

  // ── evidence ───────────────────────────────────────────────────────

  submitEvidence(input: {
    roomId: string;
    taskPath: string;
    actorContact: string;
    kind: string;
    ref?: string;
    body: string;
    expectedRevision?: number;
  }): { ok: true; evidenceId: number } | StoreError {
    this.ensureSchema();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const roomMismatch = this.checkRoom(tc, input.roomId.trim());
    if (roomMismatch) return roomMismatch;
    const task = this.getTask(input.roomId.trim(), input.taskPath.trim());
    if (!task) return fail('任务不存在', 404);
    const taskMismatch = this.checkTask(tc, task);
    if (taskMismatch) return taskMismatch;
    const actor = input.actorContact.trim();
    if (!this.isParticipant(task.room_id, actor)) return fail('只有本会议室成员可以提交证据', 403);
    const turnGate = this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    if (['closed', 'dropped'].includes(task.status)) return fail(`任务已 ${task.status}，不再接受证据`, 409);
    const kind = String(input.kind || '').trim().toLowerCase().replace(/-/g, '_');
    if (!['note', 'receipt_ref', 'review_note', 'delivery_note', 'candidate'].includes(kind)) {
      return fail('kind 必须是 note | receipt_ref | review_note | delivery_note | candidate', 400);
    }
    const body = text(input.body, 20_000);
    if (!body) return fail('body 必填', 400);
    // Append-only: evidence never rewrites worker declarations and never
    // flips a failure into a pass; conclusions are derived from job rows.
    //
    // Explicit candidate submission (M5): after a repair, the owner pins the
    // new implementation SHA explicitly. The referenced attempt must be a
    // linked, terminal, unfenced IMPLEMENTATION receipt (never a merge/deploy
    // closure) whose HEAD matches. Pinning invalidates any prior approval;
    // completion alone never selects or replaces a candidate.
    if (kind === 'candidate') {
      const pinned = body.trim().toLowerCase();
      if (!SHA40_RE.test(pinned)) return fail('candidate 证据正文必须是完整 40 位 SHA', 400);
      const refJobId = text(input.ref, 500);
      if (!refJobId) return fail('candidate 必须引用实现尝试 job id（ref）', 400);
      if (input.expectedRevision === undefined || !Number.isSafeInteger(Number(input.expectedRevision))) {
        return fail('candidate 提交必须带 expected_revision（任务 revision 守卫）', 400);
      }
      if (Number(input.expectedRevision) !== task.revision) {
        return fail(`任务 revision 已变化（期望 ${input.expectedRevision}，当前 ${task.revision}）；先 task_get 再试`, 409);
      }
      const attempt = this.jobs.get(refJobId);
      if (!attempt) return fail('候选实现 job 不存在', 404);
      const attemptLinked = this.db.prepare(
        'SELECT 1 FROM room_task_links WHERE job_id = ? AND task_id = ?',
      ).get(attempt.id, task.id);
      if (!attemptLinked) return fail('候选实现不属于本任务（伪造/跨任务引用已拒绝）', 404);
      if (this.jobs.workflowModules.isFenced(attempt.id)) {
        return fail('候选尝试已被接管废弃；按当前在途尝试提交', 409);
      }
      if (!['done', 'blocked'].includes(attempt.status)) {
        return fail(`候选实现尚未终态（${attempt.status}）`, 409);
      }
      const attemptOptions = parseJson(attempt.options);
      if (typeof attemptOptions.closureKind === 'string' && attemptOptions.closureKind) {
        return fail('候选只能是实现尝试，不能是合并/部署收口单', 400);
      }
      const attemptHead = (structuredReceiptFields(attempt).head ?? '').toLowerCase();
      if (!attemptHead || attemptHead !== pinned) {
        return fail('候选 SHA 与实现回执 HEAD 不一致', 409);
      }
      if (actor !== task.owner_contact) {
        return fail(`只有当前负责人 ${task.owner_contact} 可以提交候选版本`, 403);
      }
      if (task.candidate_sha && task.candidate_sha.toLowerCase() === pinned) {
        const dupId = this.addEvidence(task.id, kind, refJobId, body, actor);
        return { ok: true, evidenceId: dupId };
      }
      const priorReview = task.review_status;
      const evidenceId = this.db.transaction(() => {
        const id = this.addEvidence(task.id, kind, refJobId, body, actor);
        this.bump(task.id, {
          candidate_sha: pinned,
          candidate_job_id: attempt.id,
          review_status: null,
          review_evidence_id: null,
        });
        this.event(task.id, 'candidate-submitted', actor, {
          jobId: attempt.id, sha: pinned, invalidatedPriorReview: priorReview,
        });
        return id;
      })();
      this.event(task.id, 'evidence', actor, { kind, ref: refJobId, evidenceId });
      return { ok: true, evidenceId };
    }
    const evidenceId = this.addEvidence(task.id, kind, text(input.ref, 500), body, actor);
    this.event(task.id, 'evidence', actor, { kind, ref: text(input.ref, 500), evidenceId });
    return { ok: true, evidenceId };
  }

  // ── handoff ────────────────────────────────────────────────────────

  private activeHandoff(task: RoomTaskRow): RoomTaskHandoffRow | undefined {
    if (!task.active_handoff_id) return undefined;
    return this.db.prepare('SELECT * FROM room_task_handoffs WHERE id = ?').get(task.active_handoff_id) as RoomTaskHandoffRow | undefined;
  }

  latestAcceptedHandoff(taskId: string, moduleId: string, contact: string): RoomTaskHandoffRow | undefined {
    return this.db.prepare(
      `SELECT * FROM room_task_handoffs WHERE task_id = ? AND to_module = ? AND to_contact = ? AND status = 'accepted'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(taskId, moduleId, contact) as RoomTaskHandoffRow | undefined;
  }

  parseSnapshot(handoff: RoomTaskHandoffRow): CapturedHandoffSnapshot | StoreError {
    if (!isModuleId(handoff.to_module)) return fail(`交接目标模块非法：${handoff.to_module}`, 410);
    const binding = parseBinding(handoff.to_binding);
    if (!binding) return fail('交接快照损坏（binding）；请负责人取消重发', 410);
    const permissions = parsePermissions(handoff.to_permissions, handoff.to_module);
    if (!permissions) return fail('交接快照损坏（permissions）；请负责人取消重发', 410);
    if (!handoff.approved_workspace) return fail('交接缺少批准工作区；请负责人取消重发', 410);
    return { binding, permissions, revision: handoff.to_revision, workspace: handoff.approved_workspace };
  }

  handoffContent(task: RoomTaskRow, handoff: RoomTaskHandoffRow): string {
    return [
      `【任务交接】${task.task_path}（rev ${task.revision}，handoff ${handoff.id}）`,
      `从 ${handoff.from_module}（${handoff.from_contact}）交给 ${handoff.to_module}（${handoff.to_contact}，binding rev ${handoff.to_revision}）。`,
      `批准工作区：${handoff.approved_workspace}`,
      `请求：${handoff.request.slice(0, 2000)}`,
      handoffEvidenceLine(handoff),
      '内环直连：首轮与修复轮 execution_start 默认 return_to_module=review；review 受理后直接 review_submit，结论即 pin。REQUEST_CHANGES 直接 task_handoff execute（附 MUST 项与通过条件），APPROVE 直接交 merge；仅改方案、改范围或触发仲裁阈值时交 plan。',
      handoff.status === 'accepted'
        ? '本交接已经受理，当前由你负责。这是失败轮次的显式恢复；先 task_get 核实状态，不重复 accept，按本模块权限继续执行、显式交接或登记具体阻塞。'
        : '先 task_get 读全原始需求/证据/尝试，再 task_accept 或 task_decline；接受后按本模块权限显式执行、继续交接或登记具体阻塞。',
    ].join('\n');
  }

  handoff(input: {
    roomId: string;
    taskPath: string;
    actorContact: string;
    actorModule?: string;
    toModule: string;
    request: string;
    evidenceRefs?: string[];
    idempotencyKey?: string;
    autoStart?: boolean;
    expectedRevision?: number;
    returnToModule?: string;
    objective?: string;
    write?: boolean;
    shell?: boolean;
    ssh?: boolean;
  }): { handoff: RoomTaskHandoffRow; task: RoomTaskRow; delivery: RoomTaskDispatchResult; job?: JobRow } | StoreError {
    return this.handoffInternal(input, false);
  }

  private handoffInternal(input: Parameters<RoomTaskStore['handoff']>[0], irisCreation: boolean): ReturnType<RoomTaskStore['handoff']> {
    this.ensureSchema();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const roomMismatch = this.checkRoom(tc, input.roomId.trim());
    if (roomMismatch) return roomMismatch;
    const task0 = this.getTask(input.roomId.trim(), input.taskPath.trim());
    if (!task0) return fail('任务不存在', 404);
    const taskMismatch = this.checkTask(tc, task0);
    if (taskMismatch) return taskMismatch;
    // Open governance retires the handoff/accept ritual: any member moves
    // the baton with task_pass, so no owner-only 403 may deadlock the task.
    // The User atomic create+dispatch path (irisCreation) is exempt; model
    // turns get a 410 pointer instead of the strict checks below.
    if (!irisCreation && this.isOpenGovernance(task0.room_id)) {
      return fail('open 治理模式下 task_handoff 已停用：请用 task_pass 交棒（受阻 task_block，完工 task_done）；无需 accept/decline', 410);
    }
    const actor = input.actorContact.trim();
    if (!irisCreation && !this.isParticipant(task0.room_id, actor)) return fail('只有本会议室成员可以发起交接', 403);
    const turnGate = irisCreation ? null : this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    if (['closed', 'dropped'].includes(task0.status)) return fail(`任务已 ${task0.status}，不能再交接`, 409);
    if (!isModuleId(input.toModule)) return fail(`未知模块 ${input.toModule}`, 400);
    const toModule = input.toModule;
    // Non-execute handoffs retain their original semantics, even when callers
    // pass auto_start. Auto-start replays must be resolved before ownership
    // checks: the first successful call already transferred responsibility.
    const autoStart = input.autoStart === true && toModule === 'execute';
    const autoSignature = sha256(JSON.stringify({
      request: text(input.request, 20_000), objective: text(input.objective ?? input.request, 20_000),
      returnTo: input.returnToModule ?? 'review', write: input.write !== false,
      shell: input.shell === true || input.write !== false, ssh: input.ssh === true,
      evidenceRefs: input.evidenceRefs ?? [],
    }));
    const autoKey = text(input.idempotencyKey, 200)
      || `handoff-auto:v1:${task0.id}:${sha256(`${actor}\n${input.expectedRevision}\n${autoSignature}`).slice(0, 32)}`;
    if (autoStart) {
      const prior = this.db.prepare('SELECT * FROM room_task_handoffs WHERE idempotency_key = ?')
        .get(autoKey) as RoomTaskHandoffRow | undefined;
      if (prior) {
        if (prior.task_id !== task0.id || prior.from_contact !== actor || prior.from_module !== tc.moduleId) {
          return fail('自动启动幂等键不属于本任务/发起人/模块', 403);
        }
        const receipt = this.db.prepare(`SELECT payload FROM room_task_events WHERE task_id = ?
          AND kind = 'handoff-auto-accepted' AND json_extract(payload, '$.handoffId') = ? LIMIT 1`)
          .get(task0.id, prior.id) as { payload: string } | undefined;
        if (!receipt || parseJson(receipt.payload).signature !== autoSignature) {
          return fail('幂等键对应的交接模式或启动参数不同；不得重用', 409);
        }
        const linked = this.db.prepare(`SELECT j.id FROM jobs j JOIN room_task_links l ON l.job_id = j.id
          WHERE l.task_id = ? AND json_extract(j.options, '$.roomTaskHandoffId') = ?
          AND json_extract(j.options, '$.handoffAutoStart') = 1 ORDER BY j.rowid LIMIT 1`)
          .get(task0.id, prior.id) as { id: string } | undefined;
        if (!linked) return fail('自动启动交接缺少关联 job；先核对账本', 409);
        return { handoff: prior, task: task0, job: this.jobs.get(linked.id)!, delivery: { status: 'duplicate' } };
      }
      if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) <= 0) {
        return fail('auto_start 必须带 expected_revision（任务 revision 守卫）', 400);
      }
      if (input.expectedRevision !== task0.revision) {
        return fail(`任务 revision 已变化（期望 ${input.expectedRevision}，当前 ${task0.revision}）；先 task_get 再试`, 409);
      }
    }
    // Only the current owner hands off, wearing the owner module's hat: a
    // plan-hat turn can never move a deploy-owned task, even for the same
    // contact holding both bindings. No machine picks the next stage: the
    // model names it explicitly here.
    if (!irisCreation && actor !== task0.owner_contact) {
      return fail(`当前负责人是 ${task0.owner_module}（${task0.owner_contact}）；只有负责人才可以交接`, 403);
    }
    if (task0.owner_module !== tc.moduleId) {
      return fail(`本轮次是 ${tc.moduleId} 身份，任务负责人是 ${task0.owner_module}；不得跨模块身份交接`, 403);
    }
    if (input.actorModule && input.actorModule !== tc.moduleId) {
      return fail(`你声明的模块 ${input.actorModule} 与本轮次 ${tc.moduleId} 不一致`, 403);
    }
    if (input.actorModule && input.actorModule !== task0.owner_module) {
      return fail(`你声明的模块 ${input.actorModule} 与当前负责人 ${task0.owner_module} 不一致`, 403);
    }
    const request = text(input.request, 20_000);
    if (!request) return fail('request 必填：写清要对方做什么、验收是什么', 400);
    const evidenceRefs = Array.isArray(input.evidenceRefs)
      ? input.evidenceRefs.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 50)
      : [];
    const idempotencyKey = autoStart ? autoKey
      : text(input.idempotencyKey, 200) || `handoff:v1:${task0.id}:${toModule}:${sha256(`${actor}\n${request}`).slice(0, 16)}`;
    const prior = this.db.prepare('SELECT * FROM room_task_handoffs WHERE idempotency_key = ?').get(idempotencyKey) as RoomTaskHandoffRow | undefined;
    if (prior) {
      if (prior.task_id !== task0.id) return fail('幂等键指向其他任务的交接（伪造范围已拒绝）', 403);
      return { handoff: prior, task: task0, delivery: { status: 'duplicate' } };
    }
    const pending = this.activeHandoff(task0);
    if (pending && pending.status === 'pending') {
      return fail(`已有待处理交接 ${pending.id}（→ ${pending.to_module}）；等对方 accept/decline，或由负责人用 task_retry/cancel-handoff 取消后重发`, 409);
    }
    if (toModule === 'execute') {
      const rounds = this.executeRoundsSinceReview(task0.id);
      if (rounds >= EXECUTE_ROUNDS_BEFORE_REVIEW) {
        return fail(`本任务自上次独立评审以来已执行 ${rounds} 轮，不再继续派 execute。`
          + '先 task_handoff 到 review（候选交独立评审，证据不足就让评审 REQUEST_CHANGES）或 arbitration；'
          + '确实无法推进就 task_wait mode=blocked 交 User。', 409);
      }
    }
    // O4: wake budget counts every handoff wake. Exhaustion auto-blocks the
    // task (surfaced to User); the handoff is not created.
    if (!this.countWakeOrBlock(task0.id, actor, `handoff:${toModule}`)) {
      return fail('wake budget exhausted：本任务今日唤醒已超上限，已自动 block 交 User', 409);
    }
    // Capture the FULL target binding/permissions/workspace snapshot now.
    // Delivery, accept, runtime and execution all use this frozen snapshot;
    // later global rebinding never rewrites it.
    const bindings = this.jobs.workflowModules.bindings();
    const revision = this.jobs.workflowModules.revision();
    const binding = bindings[toModule];
    if (!binding?.contactId) return fail(`module ${toModule} 当前没有绑定联系人`, 409);
    const contact = this.db.prepare("SELECT id FROM contacts WHERE id = ? AND kind = 'dm' AND enabled = 1").get(binding.contactId);
    if (!contact) return fail(`module ${toModule} 绑定的联系人 ${binding.contactId} 不可用`, 409);
    const room = this.requireRoom(task0.room_id);
    if ('error' in room) return room;
    if (!room.members.includes(binding.contactId)) {
      return fail(`目标模块 ${toModule} 绑定的 ${binding.contactId} 不在本会议室成员中`, 409);
    }
    const definition = moduleDefinition(toModule);
    const id = crypto.randomUUID();
    let autoJob: JobRow | undefined;
    let factId: number | undefined;
    const tx = this.db.transaction(() => {
      if (autoStart) {
        const current = this.requireTask(task0.id);
        if (current.revision !== input.expectedRevision || (!irisCreation && current.owner_contact !== actor) || current.owner_module !== tc.moduleId) {
          throw new AutoStartRollback(fail('任务 revision 或负责人已变化；先 task_get 再试', 409));
        }
      }
      this.db.prepare(
        `INSERT INTO room_task_handoffs
          (id, task_id, idempotency_key, from_module, from_contact, to_module, to_contact, to_revision,
           to_binding, to_permissions, approved_workspace, request, evidence_refs, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      ).run(id, task0.id, idempotencyKey, task0.owner_module, actor, toModule, binding.contactId, revision,
        JSON.stringify(binding), JSON.stringify(definition.permissions), task0.approved_workspace,
        request, JSON.stringify(evidenceRefs));
      this.db.prepare('UPDATE room_tasks SET active_handoff_id = ? WHERE id = ?').run(id, task0.id);
      const bumped = this.bump(task0.id, {});
      const handoffTurnId = typeof tc.turnId === 'string' ? tc.turnId : undefined;
      this.event(task0.id, 'handoff-created', actor, {
        handoffId: id, fromModule: task0.owner_module, toModule, toContact: binding.contactId,
        toRevision: revision, request: request.slice(0, 1000),
        ...(handoffTurnId ? { turnId: handoffTurnId } : {}),
      }, task0.owner_module);
      if (autoStart) {
        this.db.prepare(`UPDATE room_task_handoffs SET status = 'accepted', decided_by = ?,
          decided_at = datetime('now') WHERE id = ?`).run(actor, id);
        const owned = this.bump(task0.id, {
          owner_module: toModule, owner_contact: binding.contactId, active_handoff_id: null,
        });
        this.event(task0.id, 'handoff-auto-accepted', actor, {
          handoffId: id, fromModule: task0.owner_module, toModule, toContact: binding.contactId,
          binding, permissions: definition.permissions, bindingRevision: revision,
          workspace: task0.approved_workspace, signature: autoSignature, turnId: tc.turnId,
        }, task0.owner_module);
        const started = this.startAcceptedExecution({
          roomId: task0.room_id, taskPath: task0.task_path, actorContact: actor, module: toModule,
          expectedRevision: owned.revision, workspace: task0.approved_workspace,
          objective: input.objective ?? request, returnToModule: input.returnToModule ?? 'review',
          write: input.write, shell: input.shell, ssh: input.ssh,
        }, owned, this.requireHandoff(id), true);
        if ('error' in started) throw new AutoStartRollback(started);
        autoJob = started.job;
        factId = Number(this.db.prepare(`INSERT INTO messages
          (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
          VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main', ?)`).run(
          task0.room_id,
          `【任务直接执行】${task0.task_path}：${actor} 交给 execute（${binding.contactId}），已受理并启动 job ${autoJob.id}；完成回 ${input.returnToModule ?? 'review'}。`,
          JSON.stringify({ event: 'room-task-auto-start', taskId: task0.id, handoffId: id, jobId: autoJob.id }),
          `task-auto-start:v1:${id}`,
        ).lastInsertRowid);
        return started.task;
      }
      return bumped;
    });
    let task: RoomTaskRow;
    try {
      task = autoStart ? this.jobs.transactionWithDeferredEvents(tx) : tx();
    } catch (error) {
      if (error instanceof AutoStartRollback) {
        if (autoStart) this.recordCapabilityRejectFromFailure(task0.id, actor, toModule, error.failure);
        return error.failure;
      }
      if (autoStart) throw error;
      if (String((error as Error)?.message ?? '').includes('UNIQUE')) {
        const replay = this.db.prepare('SELECT * FROM room_task_handoffs WHERE idempotency_key = ?').get(idempotencyKey) as RoomTaskHandoffRow | undefined;
        if (replay) return { handoff: replay, task: this.requireTask(task0.id), delivery: { status: 'duplicate' } };
      }
      throw error;
    }
    const handoffRow = this.requireHandoff(id);
    if (autoJob && factId) {
      // The persisted fact is authoritative even if a client disconnects;
      // publishing it never calls dispatchToModule or starts an execute turn.
      try { if (!irisCreation) this.dispatch?.publishFact?.(factId); } catch { /* reconnect reloads the fact */ }
      return { handoff: handoffRow, task, job: autoJob, delivery: { status: 'posted', messageId: factId } };
    }
    const delivery = irisCreation
      ? { status: 'failed' as const, reason: 'delivery deferred until creation commits' }
      : this.deliverHandoff(task, handoffRow, actor);
    return { handoff: handoffRow, task, delivery };
  }

  private deliverHandoff(task: RoomTaskRow, handoffRow: RoomTaskHandoffRow, actor: string): RoomTaskDispatchResult {
    const toModule = handoffRow.to_module;
    const id = handoffRow.id;
    let delivery: RoomTaskDispatchResult = { status: 'failed', reason: 'no dispatcher; handoff stays pending for task_retry' };
    if (this.dispatch) {
      try {
        delivery = this.dispatch.dispatchToModule(task.room_id, toModule, handoffRow.to_contact,
          this.handoffContent(task, handoffRow), `task-handoff:v1:${id}`, { taskId: task.id, handoffId: id });
      } catch (error) {
        delivery = { status: 'failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
      }
      this.event(task.id, delivery.status === 'failed' ? 'handoff-delivery-failed' : 'handoff-delivered', actor, {
        handoffId: id, toModule, ...(delivery.reason ? { reason: delivery.reason } : {}),
      });
    }
    return delivery;
  }

  /** Execute attempts started since the latest independent review verdict. */
  executeRoundsSinceReview(taskId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c FROM room_task_events
        WHERE task_id = ? AND kind = 'execution-started' AND module = 'execute'
          AND id > COALESCE((SELECT MAX(id) FROM room_task_events
            WHERE task_id = ? AND kind IN ('review-approved', 'review-changes-requested')), 0)`,
    ).get(taskId, taskId) as { c: number };
    return row.c;
  }

  /**
   * Min-closure-2: validate a raw `sequence` argument into normalized items.
   * Array of 1..20 {label, objective, write?, shell?}; labels and objectives
   * must be non-empty text. Returns items or a StoreError (fail-closed).
   */
  private parseSequenceInput(raw: unknown): { items: RoomTaskSequenceItem[] } | StoreError {
    if (!Array.isArray(raw) || raw.length === 0) {
      return fail('sequence 必须是非空数组，每项 {label, objective, write?, shell?}', 400);
    }
    if (raw.length > ROOM_TASK_SEQUENCE_MAX_ITEMS) {
      return fail(`sequence 最多 ${ROOM_TASK_SEQUENCE_MAX_ITEMS} 块`, 400);
    }
    const items: RoomTaskSequenceItem[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const rec = record(raw[i]);
      const label = text(rec.label, 200);
      const objective = text(rec.objective, 20_000);
      if (!label) return fail(`sequence[${i}].label 必填`, 400);
      if (!objective) return fail(`sequence[${i}].objective 必填：写清该块做什么`, 400);
      const item: RoomTaskSequenceItem = { label, objective };
      if (typeof rec.write === 'boolean') item.write = rec.write;
      if (typeof rec.shell === 'boolean') item.shell = rec.shell;
      items.push(item);
    }
    return { items };
  }

  /**
   * Min-closure-2: read the stored W-sequence (full items + current index).
   * Null when the task carries no sequence.
   */
  sequenceOf(task: RoomTaskRow): { items: RoomTaskSequenceItem[]; index: number } | null {
    try {
      if (!task.sequence_json) return null;
      const parsed = JSON.parse(task.sequence_json) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      const checked = this.parseSequenceInput(parsed);
      if ('error' in checked) return null;
      const index = Number(task.sequence_index);
      if (!Number.isSafeInteger(index) || index < 0 || index >= checked.items.length) return null;
      return { items: checked.items, index };
    } catch {
      return null;
    }
  }

  /**
   * Min-closure-2: store (or replace) the W-sequence at index 0. Emits
   * `sequence-started` on first set, `sequence-replaced` on override; the
   * full items ride in the event payload (ledger keeps sequence 全文与 index).
   */
  private storeSequence(taskId: string, actor: string, items: RoomTaskSequenceItem[], module?: string): void {
    const current = this.requireTask(taskId);
    const existed = this.sequenceOf(current) !== null;
    this.db.prepare('UPDATE room_tasks SET sequence_json = ?, sequence_index = 0 WHERE id = ?')
      .run(JSON.stringify(items).slice(0, 20_000), taskId);
    this.event(taskId, existed ? 'sequence-replaced' : 'sequence-started', actor, {
      index: 0,
      total: items.length,
      labels: items.map((item) => item.label),
      sequence: items,
    }, module);
  }

  /** Min-closure-2: drop the W-sequence (block/done/halt paths). */
  private clearSequence(taskId: string, actor: string, reason: string, module?: string): void {
    const current = this.requireTask(taskId);
    if (this.sequenceOf(current) === null) return;
    this.db.prepare('UPDATE room_tasks SET sequence_json = NULL, sequence_index = NULL WHERE id = ?').run(taskId);
    this.event(taskId, 'sequence-cleared', actor, { reason }, module);
  }

  private requireHandoff(id: string): RoomTaskHandoffRow {
    const row = this.handoffRow(id);
    if (!row) throw new Error(`handoff not found: ${id}`);
    return row;
  }

  /**
   * Owner-role scope (M6): explicit control actions require the CURRENT
   * owner persona AND the turn hat of the owner module, plus a live accepted
   * handoff for that role (except the initial plan owner, who acts on the
   * anchored creation). Persona ownership alone never suffices: the same
   * contact wearing another module's hat is rejected.
   */
  private requireOwnerScope(task: RoomTaskRow, actor: string, tc: RoomTaskToolContext): StoreError | null {
    if (actor !== task.owner_contact) {
      return fail(`当前负责人是 ${task.owner_module}（${task.owner_contact}）；只有负责人可以操作`, 403);
    }
    if (tc.moduleId !== task.owner_module) {
      return fail(`本轮次是 ${tc.moduleId} 身份，负责人角色是 ${task.owner_module}；不得跨模块身份操作`, 403);
    }
    if (task.owner_module !== 'plan') {
      const accepted = this.latestAcceptedHandoff(task.id, task.owner_module as WorkflowModuleId, actor);
      if (!accepted) return fail('没有该负责人角色的已接受交接授权', 403);
    }
    return null;
  }

  private decideHandoff(input: {
    roomId: string;
    taskPath?: string;
    handoffId?: string;
    actorContact: string;
    decision: 'accepted' | 'declined';
  }): { handoff: RoomTaskHandoffRow; task: RoomTaskRow } | StoreError {
    this.ensureSchema();
    // Open governance retires accept/decline: the baton move itself is the
    // authority, so answering a handoff is gone. Point at task_pass instead
    // of any recipient/hat 403 below.
    if (this.isOpenGovernance(input.roomId.trim())) {
      return fail('open 治理模式下 accept/decline 已停用：交棒即生效，无需应答；请用 task_pass 交棒（受阻 task_block，完工 task_done）', 410);
    }
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const actor = input.actorContact.trim();
    let handoff: RoomTaskHandoffRow | undefined;
    if (input.handoffId) {
      handoff = this.handoffRow(String(input.handoffId));
      if (!handoff) return fail('交接不存在', 404);
    } else {
      if (!input.taskPath) return fail('task_path 或 handoff_id 必填', 400);
      const task = this.getTask(input.roomId.trim(), input.taskPath.trim());
      if (!task) return fail('任务不存在', 404);
      handoff = this.activeHandoff(task);
      if (!handoff) return fail('当前没有待处理的交接', 409);
    }
    const task = this.requireTask(handoff.task_id);
    const roomMismatch = this.checkRoom(tc, task.room_id);
    if (roomMismatch) return roomMismatch;
    if (input.roomId.trim() !== task.room_id) return fail('交接不属于该会议室（跨室引用已拒绝）', 403);
    const taskMismatch = this.checkTask(tc, task);
    if (taskMismatch) return taskMismatch;
    // The answering turn must wear the recipient module's hat, and a
    // handoff-woken turn answers only its own handoff.
    if (handoff.to_module !== tc.moduleId) {
      return fail(`本轮次是 ${tc.moduleId} 身份，该交接点名 ${handoff.to_module} 应答`, 403);
    }
    if (tc.handoffId && tc.handoffId !== handoff.id) {
      return fail('本轮次只授权当前交接；不得应答其他交接', 403);
    }
    if (!this.isParticipant(task.room_id, actor)) return fail('只有本会议室成员可以应答交接', 403);
    const turnGate = this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    if (handoff.status !== 'pending') return fail(`交接已 ${handoff.status}，不能重复应答`, 409);
    // Only the captured recipient answers.
    if (actor !== handoff.to_contact) {
      return fail(`该交接点名 ${handoff.to_contact} 应答；你不是被选中的接收人`, 403);
    }
    const snapshot = this.parseSnapshot(handoff);
    if ('error' in snapshot) return snapshot;
    if (input.decision === 'accepted') {
      if (['closed', 'dropped'].includes(task.status) || task.active_handoff_id !== handoff.id) {
        return fail('任务已终结或交接已不是当前待处理交接；不得取得旧责任', 409);
      }
      const completion = this.db.prepare('SELECT job_id FROM room_task_completion_handoffs WHERE handoff_id = ?')
        .get(handoff.id) as { job_id: string } | undefined;
      if (completion && this.jobs.workflowModules.isFenced(completion.job_id)) {
        return fail('完成交接的原尝试已被接管废弃；不得接受旧交接', 409);
      }
      // The captured snapshot stays authoritative for THIS handoff even if the
      // global revision has since moved for unrelated modules. Only a true
      // rebound (someone else now holds the target role) invalidates it, and
      // then the owner explicitly cancels + re-handoffs — never a deadlock:
      // decline/cancel always stay available.
      const current = this.currentBindingContact(handoff.to_module as WorkflowModuleId);
      if ('error' in current) return current;
      if (current.contactId !== handoff.to_contact) {
        return fail(
          `目标角色已易主（当前 ${handoff.to_module}=${current.contactId}，交接点名 ${handoff.to_contact}）；请负责人用 task_retry/cancel-handoff 取消后按新绑定重发`,
          410,
        );
      }
    }
    const decision = input.decision;
    let concurrent = false;
    const tx = this.db.transaction(() => {
      const change = this.db.prepare(
        `UPDATE room_task_handoffs SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'`,
      ).run(decision, actor, handoff!.id);
      if (Number((change as { changes: number }).changes) !== 1) {
        concurrent = true;
        return this.requireTask(task.id);
      }
      if (decision === 'accepted') {
        this.db.prepare(
          `UPDATE room_tasks SET owner_module = ?, owner_contact = ?, holder_module = ?, active_handoff_id = NULL WHERE id = ?`,
        ).run(handoff!.to_module, handoff!.to_contact, handoff!.to_module, task.id);
      } else {
        this.db.prepare(
          `UPDATE room_tasks SET active_handoff_id = NULL WHERE id = ?`,
        ).run(task.id);
      }
      const bumped = this.bump(task.id, {});
      const decideTurnId = typeof tc.turnId === 'string' ? tc.turnId : undefined;
      this.event(task.id, decision === 'accepted' ? 'handoff-accepted' : 'handoff-declined', actor, {
        handoffId: handoff!.id, toModule: handoff!.to_module,
        ...(decideTurnId ? { turnId: decideTurnId } : {}),
      }, handoff!.to_module);
      return bumped;
    });
    const updated = tx();
    if (concurrent) return fail('交接已被并发应答；请 task_get 确认最新状态', 409);
    const finalHandoff = this.requireHandoff(handoff.id);
    if (finalHandoff.status !== decision) return fail('交接已被并发应答；请 task_get 确认最新状态', 409);
    return { handoff: finalHandoff, task: updated };
  }

  accept(input: { roomId: string; taskPath?: string; handoffId?: string; actorContact: string }) {
    return this.decideHandoff({ ...input, decision: 'accepted' });
  }

  decline(input: { roomId: string; taskPath?: string; handoffId?: string; actorContact: string }) {
    return this.decideHandoff({ ...input, decision: 'declined' });
  }

  /** Explicit authorized cancel of a pending handoff by the current owner. Unlocks re-handoff after rebind. */
  cancelHandoff(input: { roomId: string; taskPath?: string; handoffId?: string; actorContact: string }) {
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const actor = input.actorContact.trim();
    let handoff: RoomTaskHandoffRow | undefined;
    if (input.handoffId) {
      handoff = this.handoffRow(String(input.handoffId));
      if (!handoff) return fail('交接不存在', 404);
    } else {
      if (!input.taskPath) return fail('task_path 或 handoff_id 必填', 400);
      const task = this.getTask(input.roomId.trim(), input.taskPath.trim());
      if (!task) return fail('任务不存在', 404);
      handoff = this.activeHandoff(task);
      if (!handoff) return fail('当前没有待取消的交接', 409);
    }
    const task = this.requireTask(handoff.task_id);
    const roomMismatch = this.checkRoom(tc, task.room_id);
    if (roomMismatch) return roomMismatch;
    if (task.room_id !== input.roomId.trim()) return fail('交接不属于该会议室', 403);
    const taskMismatch = this.checkTask(tc, task);
    if (taskMismatch) return taskMismatch;
    if (!this.isParticipant(task.room_id, actor)) return fail('只有本会议室成员可以取消交接', 403);
    const turnGate = this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    if (handoff.status !== 'pending') return fail(`交接已 ${handoff.status}，无需取消`, 409);
    const ownerScope = this.requireOwnerScope(task, actor, tc);
    if (ownerScope) return ownerScope;
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE room_task_handoffs SET status = 'superseded', decided_by = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'`)
        .run(actor, handoff!.id);
      this.db.prepare('UPDATE room_tasks SET active_handoff_id = NULL WHERE id = ?').run(task.id);
      const bumped = this.bump(task.id, {});
      this.event(task.id, 'handoff-cancelled', actor, { handoffId: handoff!.id });
      return bumped;
    });
    const updated = tx();
    return { handoff: this.requireHandoff(handoff.id), task: updated };
  }

  // ── open governance: single-action pass / block / done (O2) ──────────
  // Strict-only rituals (accept/decline/frozen to_contact) are bypassed here;
  // these methods refuse to run in strict rooms.

  private requireOpen(roomId: string): StoreError | null {
    if (!this.isOpenGovernance(roomId)) {
      return fail('task_pass/task_block/task_done 仅在 open 治理模式下可用', 400);
    }
    return null;
  }

  private passContent(task: RoomTaskRow, toModule: string, note: string): string {
    return [`[task-pass] ${task.task_path} → ${toModule}`, note.trim()].filter(Boolean).join('\n').slice(0, 2000);
  }

  private deliverPass(task: RoomTaskRow, toModule: string, toContact: string, actor: string, key: string, source: string, passId: string): RoomTaskDispatchResult {
    let delivery: RoomTaskDispatchResult = { status: 'failed', reason: 'no dispatcher; holder moved, wake on next turn' };
    if (this.dispatch) {
      try {
        delivery = this.dispatch.dispatchToModule(task.room_id, toModule, toContact,
          this.passContent(task, toModule, ''), key, { taskId: task.id, handoffId: passId });
      } catch (error) {
        delivery = { status: 'failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
      }
      // B1: auto-pass wakes get their own delivery markers (source auto-pass)
      // so the ledger tells a real recipient round apart from a posted key
      // whose round never started.
      const auto = source === 'auto-pass' || source === 'review-auto-pass';
      this.event(task.id, delivery.status === 'failed'
        ? (auto ? 'auto-pass-delivery-failed' : 'pass-delivery-failed')
        : (auto ? 'auto-pass-delivered' : 'pass-delivered'), actor, {
        toModule, source, ...(delivery.reason ? { reason: delivery.reason } : {}),
      });
      // B1: mirror the durable handoff key next to the pass key, whatever
      // dispatcher implementation ran. task_retry reads the handoff key, so
      // a never-started pass wake stays explicitly retryable to the same
      // captured recipient. UPSERT makes the dispatcher's own mirror a no-op.
      try {
        if (delivery.status === 'posted' || delivery.status === 'duplicate') {
          markTaskDispatch(this.db, `task-handoff:v1:${passId}`, 'handoff', 'posted', delivery.messageId ?? null, toContact, `pass ${key}`);
        } else {
          markTaskDispatch(this.db, `task-handoff:v1:${passId}`, 'handoff', 'failed', delivery.messageId ?? null, toContact, delivery.reason ?? 'pass delivery failed');
        }
      } catch { /* ledger is best-effort; the wake result above stands */ }
    }
    return delivery;
  }

  /** B1: turn-end auto-pass stashes here until the initiator turn finalizes. */
  private deferredPassDeliveries: Array<{
    taskId: string; toModule: WorkflowModuleId; toContact: string;
    actor: string; key: string; source: string; passId: string;
  }> = [];

  /**
   * B1: dispatch stashed auto-pass wakes. Called by the runtime after the
   * initiator turn settles (lastSeen advanced, origin turn ended), never
   * from inside the turn-finalize path itself. No setTimeout guessing: the
   * caller owns the ordering. Best-effort per item; the baton already moved.
   */
  flushDeferredPass(): RoomTaskDispatchResult[] {
    const pending = this.deferredPassDeliveries.splice(0);
    return pending.map((item) => {
      try {
        const task = this.requireTask(item.taskId);
        return this.deliverPass(task, item.toModule, item.toContact, item.actor, item.key, item.source, item.passId);
      } catch (error) {
        return { status: 'failed' as const, reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
      }
    });
  }

  private passInternal(
    task0: RoomTaskRow, toModule: WorkflowModuleId, actor: string, note: string, source: string, opts?: { write?: boolean; deferDelivery?: boolean; idempotencyKey?: string },
  ): { task: RoomTaskRow; delivery: RoomTaskDispatchResult; queued: boolean; deferred?: {
    taskId: string; toModule: WorkflowModuleId; toContact: string;
    actor: string; key: string; source: string; passId: string;
  } } {
    const binding = this.currentBindingContact(toModule);
    if ('error' in binding) throw new Error(binding.error);
    const hasActiveJob = this.activeLinkedJobs(task0.id).length > 0;
    if (hasActiveJob) {
      const bumped = this.bump(task0.id, { next_module: toModule });
      this.event(task0.id, 'pass-queued', actor, {
        toModule, note: note.slice(0, 1000), source,
        ...(task0.holder_module ? { fromModule: task0.holder_module } : {}),
      }, task0.holder_module ?? undefined);
      return { task: bumped, delivery: { status: 'failed', reason: 'job in flight; queued as next' }, queued: true };
    }
    // Compatibility: leave an accepted handoff row so strict-era readers
    // (latestAcceptedHandoff, executionStart, reviewSubmit) keep working in
    // open rooms. No accept step is required; the baton move itself is the
    // authority, and holder_module is the source of truth going forward.
    const bindings = this.jobs.workflowModules.bindings();
    const bindingRevision = this.jobs.workflowModules.revision();
    const fullBinding = bindings[toModule];
    if (!fullBinding?.contactId) throw new Error(`module ${toModule} 当前没有绑定联系人`);
    const definition = moduleDefinition(toModule);
    const fromModule = task0.holder_module ?? task0.owner_module;
    const passId = crypto.randomUUID();
    // O3: plan write:false is a default. An explicit structured `write: true`
    // on task_pass (or User direction) lifts it for the frozen snapshot;
    // Worker workspace/shell/ssh boundaries still apply at launch. The note
    // text is never scanned for permission grants.
    const snapshotPermissions = toModule === 'plan' && opts?.write === true
      ? { ...definition.permissions, write: true }
      : definition.permissions;
    // O4: wake budget counts every pass wake. Exhaustion auto-blocks the
    // task (surfaced to User); the baton does not move.
    if (!this.countWakeOrBlock(task0.id, actor, `pass:${toModule}`)) {
      throw new Error('wake budget exhausted：本任务今日唤醒已超上限，已自动 block 交 User');
    }
    // Supersede stale pending handoffs so the baton move cannot deadlock.
    this.db.prepare(`UPDATE room_task_handoffs SET status = 'superseded' WHERE task_id = ? AND status = 'pending'`).run(task0.id);
    this.db.prepare(
      `INSERT INTO room_task_handoffs
        (id, task_id, idempotency_key, from_module, from_contact, to_module, to_contact, to_revision,
         to_binding, to_permissions, approved_workspace, request, evidence_refs, status, decided_by, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, datetime('now'))`,
    ).run(passId, task0.id, opts?.idempotencyKey || `pass:v1:${task0.id}:${task0.revision}:${toModule}`,
      fromModule, actor, toModule, binding.contactId, bindingRevision,
      JSON.stringify(fullBinding), JSON.stringify(snapshotPermissions), task0.approved_workspace,
      note.slice(0, 20_000), '[]', actor);
    const bumped = this.bump(task0.id, {
      owner_module: toModule,
      owner_contact: binding.contactId,
      holder_module: toModule,
      next_module: null,
      active_handoff_id: null,
      // Taking the baton resumes a blocked task; closed and dropped stay
      // terminal (callers refuse them before reaching here).
      ...(task0.status === 'blocked' ? { status: 'open' as const } : {}),
    });
    this.event(task0.id, 'pass', actor, {
      toModule, toContact: binding.contactId, note: note.slice(0, 1000), source, handoffId: passId,
      ...(task0.holder_module ? { fromModule: task0.holder_module } : {}),
    }, toModule);
    const key = `task-pass:v1:${task0.id}:${bumped.revision}`;
    if (opts?.deferDelivery) {
      const deferred = {
        taskId: task0.id, toModule, toContact: binding.contactId,
        actor, key, source, passId,
      };
      return { task: this.requireTask(task0.id), delivery: { status: 'failed', reason: 'deferred; flush after turn finalize' }, queued: false, deferred };
    }
    const delivery = this.deliverPass(bumped, toModule, binding.contactId, actor, key, source, passId);
    return { task: this.requireTask(task0.id), delivery, queued: false };
  }

  passTask(input: {
    roomId: string; taskPath: string; toModule: string; actorContact: string; note?: string; evidenceRefs?: string[]; write?: boolean;
    /** P2: only to_module=execute. Start the Worker in the same transaction instead of waking the execute chat seat. */
    autoStart?: boolean; objective?: string; returnToModule?: string; shell?: boolean; ssh?: boolean;
    expectedRevision?: number; idempotencyKey?: string;
    /** Min-closure-2: W-sequence [{label, objective, write?, shell?}];首项即本次直启目标. */
    sequence?: unknown;
  }): { task: RoomTaskRow; delivery: RoomTaskDispatchResult; queued: boolean; pass?: RoomTaskHandoffRow; job?: JobRow } | StoreError {
    this.ensureSchema();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const roomId = input.roomId.trim();
    const taskPath = input.taskPath.trim();
    const roomMismatch = this.checkRoom(tc, roomId);
    if (roomMismatch) return roomMismatch;
    const openGate = this.requireOpen(roomId);
    if (openGate) return openGate;
    const task0 = this.getTask(roomId, taskPath);
    if (!task0) return fail('任务不存在', 404);
    const taskMismatch = this.checkTask(tc, task0);
    if (taskMismatch) return taskMismatch;
    const actor = input.actorContact.trim();
    if (!this.isParticipant(roomId, actor)) return fail('只有本会议室成员可以交棒', 403);
    const turnGate = this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    if (['closed', 'dropped'].includes(task0.status)) return fail(`任务已 ${task0.status}，不能再交棒`, 409);
    if (!isModuleId(input.toModule)) return fail(`未知模块 ${input.toModule}`, 400);
    const toModule = input.toModule as WorkflowModuleId;
    const note = typeof input.note === 'string' ? input.note.slice(0, 2000) : '';
    if (input.autoStart === true && toModule !== 'execute') {
      return fail('auto_start 仅 to_module=execute 生效；其他目标用普通 task_pass 交棒', 400);
    }
    if (toModule === 'execute' && this.executeRoundsSinceReview(task0.id) >= EXECUTE_ROUNDS_BEFORE_REVIEW) {
      return fail(`已执行 ${EXECUTE_ROUNDS_BEFORE_REVIEW} 轮未送审；先 task_pass 到 review 或 arbitration`, 409);
    }
    // Min-closure-2: optional W-sequence rides on task_pass. Validated up
    // front (fail-closed); stored after the baton move below.
    let sequenceItems: RoomTaskSequenceItem[] | undefined;
    if (input.sequence !== undefined) {
      const parsed = this.parseSequenceInput(input.sequence);
      if ('error' in parsed) return parsed;
      sequenceItems = parsed.items;
    }
    if (input.autoStart === true) {
      return this.passAutoStart({
        task0, actor, note,
        objective: input.objective, returnToModule: input.returnToModule,
        write: input.write, shell: input.shell, ssh: input.ssh,
        expectedRevision: Number(input.expectedRevision),
        idempotencyKey: typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined,
        sequenceItems,
      });
    }
    try {
      const passed = this.passInternal(task0, toModule, actor, note, 'task_pass', { write: input.write });
      if (sequenceItems) {
        // Plan override: a fresh sequence replaces the running one
        // (`sequence-replaced`); a bare pass back to plan takes the baton
        // back and stops the automation (`sequence-cleared`).
        this.storeSequence(task0.id, actor, sequenceItems, tc.moduleId);
      } else if (toModule === 'plan' && !passed.queued) {
        this.clearSequence(task0.id, actor, 'pass-to-plan', tc.moduleId);
      }
      return passed;
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 409);
    }
  }

  /**
   * P2: open-room `task_pass to_module=execute` with `auto_start` starts the
   * Worker in the same transaction instead of waking the execute chat seat.
   * Same frozen-snapshot + single-write-lease + revision-guard + idempotency
   * guarantees as strict `task_handoff auto_start`; only the baton move
   * itself uses open semantics (no accept step, holder is the authority).
   * `review_submit` auto-pass is untouched: it keeps waking the execute seat.
   */
  private passAutoStart(input: {
    task0: RoomTaskRow;
    actor: string;
    note: string;
    objective?: string;
    returnToModule?: string;
    write?: boolean;
    shell?: boolean;
    ssh?: boolean;
    expectedRevision: number;
    idempotencyKey?: string;
    /** Min-closure-2: validated W-sequence;首项即本次直启目标. */
    sequenceItems?: RoomTaskSequenceItem[];
  }): { task: RoomTaskRow; delivery: RoomTaskDispatchResult; queued: boolean; pass?: RoomTaskHandoffRow; job?: JobRow } | StoreError {
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const { task0, actor } = input;
    const returnTo = input.returnToModule ?? 'review';
    if (!isModuleId(returnTo)) return fail(`return_to_module 未知：${input.returnToModule}`, 400);
    // Min-closure-2: sequence[0] is this direct start's objective. An
    // explicit objective must match it; otherwise the sequence head wins.
    let objective = text(input.objective ?? input.note, 20_000);
    if (input.sequenceItems) {
      const head = input.sequenceItems[0];
      const explicit = text(input.objective, 20_000);
      if (explicit && explicit !== head.objective) {
        return fail('sequence 首项 objective 与 objective 参数不一致；二者需相同或只传其一', 400);
      }
      objective = head.objective;
    }
    if (!objective) return fail('auto_start 需要 objective（本轮做什么）；或在 note 写清后重试', 400);
    // Sequence head narrows only when the caller leaves the flag unset.
    const write = input.write ?? input.sequenceItems?.[0]?.write;
    const shell = input.shell ?? input.sequenceItems?.[0]?.shell;
    const autoSignature = sha256(JSON.stringify({
      objective,
      returnTo,
      write: write !== false,
      shell: shell === true || write !== false,
      ssh: input.ssh === true,
      sequence: input.sequenceItems ?? null,
    }));
    const autoKey = text(input.idempotencyKey, 200)
      || `pass-auto:v1:${task0.id}:${sha256(`${actor}\n${input.expectedRevision}\n${autoSignature}`).slice(0, 32)}`;
    const replay = (key: string): { task: RoomTaskRow; delivery: RoomTaskDispatchResult; queued: boolean; pass: RoomTaskHandoffRow; job: JobRow } | StoreError | null => {
      const prior = this.db.prepare('SELECT * FROM room_task_handoffs WHERE idempotency_key = ?').get(key) as RoomTaskHandoffRow | undefined;
      if (!prior) return null;
      if (prior.task_id !== task0.id || prior.from_contact !== actor) {
        return fail('自动启动幂等键不属于本任务/发起人', 403);
      }
      const receipt = this.db.prepare(`SELECT payload FROM room_task_events WHERE task_id = ?
        AND kind = 'pass-auto-accepted' AND json_extract(payload, '$.passId') = ? LIMIT 1`)
        .get(task0.id, prior.id) as { payload: string } | undefined;
      if (!receipt || parseJson(receipt.payload).signature !== autoSignature) {
        return fail('幂等键对应的交棒模式或启动参数不同；不得重用', 409);
      }
      const linked = this.db.prepare(`SELECT j.id FROM jobs j JOIN room_task_links l ON l.job_id = j.id
        WHERE l.task_id = ? AND json_extract(j.options, '$.roomTaskHandoffId') = ?
        AND json_extract(j.options, '$.handoffAutoStart') = 1 ORDER BY j.rowid LIMIT 1`)
        .get(task0.id, prior.id) as { id: string } | undefined;
      if (!linked) return fail('自动启动交棒缺少关联 job；先核对账本', 409);
      return { task: this.requireTask(task0.id), pass: prior, job: this.jobs.get(linked.id)!, delivery: { status: 'duplicate' }, queued: false };
    };
    const seen = replay(autoKey);
    if (seen) return seen;
    if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) <= 0) {
      return fail('auto_start 必须带 expected_revision（任务 revision 守卫）；用 task_get 当前 revision', 400);
    }
    if (input.expectedRevision !== task0.revision) {
      return fail(`任务 revision 已变化（期望 ${input.expectedRevision}，当前 ${task0.revision}）；先 task_get 再试`, 409);
    }
    // A Worker job in flight keeps plain-pass semantics: record next, start nothing.
    if (this.activeLinkedJobs(task0.id).length > 0) {
      if (input.sequenceItems) this.storeSequence(task0.id, actor, input.sequenceItems);
      return this.passInternal(task0, 'execute', actor, input.note, 'task_pass', { write });
    }
    const tx = this.db.transaction(() => {
      const current = this.requireTask(task0.id);
      if (current.revision !== input.expectedRevision) {
        throw new AutoStartRollback(fail('任务 revision 已变化；先 task_get 再试', 409));
      }
      const passed = this.passInternal(current, 'execute', actor, input.note, 'task_pass-auto-start', {
        write, deferDelivery: true, idempotencyKey: autoKey,
      });
      if (passed.queued) {
        throw new AutoStartRollback(fail('任务已有在途执行；交棒已登记为 next，本次未直启', 409));
      }
      const accepted = this.db.prepare('SELECT * FROM room_task_handoffs WHERE idempotency_key = ?').get(autoKey) as RoomTaskHandoffRow | undefined;
      if (!accepted) throw new AutoStartRollback(fail('交棒落账缺失；先核对账本', 409));
      const started = this.startAcceptedExecution({
        roomId: current.room_id, taskPath: current.task_path, actorContact: actor, module: 'execute',
        expectedRevision: passed.task.revision, workspace: current.approved_workspace,
        objective, returnToModule: returnTo,
        write, shell, ssh: input.ssh,
      }, passed.task, accepted, true);
      if ('error' in started) throw new AutoStartRollback(started);
      // Min-closure-2: the W-sequence lands in the same transaction as the
      // first block's job (revision untouched: bookkeeping never invalidates
      // revision guards).
      if (input.sequenceItems) this.storeSequence(task0.id, actor, input.sequenceItems);
      this.event(task0.id, 'pass-auto-accepted', actor, {
        passId: accepted.id, fromModule: accepted.from_module, toModule: 'execute', toContact: accepted.to_contact,
        binding: parseJson(accepted.to_binding), permissions: parseJson(accepted.to_permissions),
        bindingRevision: accepted.to_revision, workspace: accepted.approved_workspace,
        signature: autoSignature, objective: objective.slice(0, 1000), returnTo,
        ...(typeof tc.turnId === 'string' ? { turnId: tc.turnId } : {}),
      }, accepted.from_module);
      const factId = Number(this.db.prepare(`INSERT INTO messages
        (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
        VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main', ?)`).run(
        current.room_id,
        `【任务直接执行】${current.task_path}：${actor} 交给 execute（${accepted.to_contact}），已受理并启动 job ${started.job.id}；完成回 ${returnTo}；不唤醒执行席聊天轮次。`,
        JSON.stringify({ event: 'room-task-pass-auto-start', taskId: task0.id, passId: accepted.id, jobId: started.job.id }),
        `task-pass-auto-start:v1:${accepted.id}`,
      ).lastInsertRowid);
      return { task: started.task, pass: accepted, job: started.job, factId };
    });
    let out: { task: RoomTaskRow; pass: RoomTaskHandoffRow; job: JobRow; factId: number };
    try {
      out = this.jobs.transactionWithDeferredEvents(tx);
    } catch (error) {
      if (error instanceof AutoStartRollback) {
        this.recordCapabilityRejectFromFailure(task0.id, actor, 'execute', error.failure);
        return error.failure;
      }
      if (String((error as Error)?.message ?? '').includes('UNIQUE')) {
        const dup = replay(autoKey);
        if (dup) return dup;
      }
      throw error;
    }
    try { this.dispatch?.publishFact?.(out.factId); } catch { /* reconnect reloads the fact */ }
    return { task: out.task, pass: out.pass, job: out.job, delivery: { status: 'posted', messageId: out.factId }, queued: false };
  }

  private blockOrDone(input: {
    roomId: string; taskPath: string; actorContact: string; note?: string; target: 'blocked' | 'closed'; kind: string;
  }): { task: RoomTaskRow } | StoreError {
    this.ensureSchema();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const roomId = input.roomId.trim();
    const taskPath = input.taskPath.trim();
    const roomMismatch = this.checkRoom(tc, roomId);
    if (roomMismatch) return roomMismatch;
    const openGate = this.requireOpen(roomId);
    if (openGate) return openGate;
    const task0 = this.getTask(roomId, taskPath);
    if (!task0) return fail('任务不存在', 404);
    const taskMismatch = this.checkTask(tc, task0);
    if (taskMismatch) return taskMismatch;
    const actor = input.actorContact.trim();
    if (!this.isParticipant(roomId, actor)) return fail('只有本会议室成员可以操作', 403);
    const turnGate = this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    if (['closed', 'dropped'].includes(task0.status)) return fail(`任务已 ${task0.status}`, 409);
    const holder = task0.holder_module ?? task0.owner_module;
    const isHolder = tc.moduleId === holder;
    const isIris = actor === 'User';
    if (!isHolder && !isIris) {
      return fail(`当前持棒是 ${holder}；只有持棒人或 User 可以登记 ${input.target}`, 403);
    }
    const note = typeof input.note === 'string' ? input.note.slice(0, 2000) : '';
    if (input.target === 'blocked' && note.trim().length < 5) return fail('block 需要 5 字以上原因', 400);
    const bumped = this.bump(task0.id, { status: input.target, next_module: null });
    // Min-closure-2: terminal dispositions drop the W-sequence with it.
    this.clearSequence(task0.id, actor, input.kind, tc.moduleId);
    this.event(task0.id, input.kind, actor, { note: note.slice(0, 1000) }, tc.moduleId);
    if (note) this.addEvidence(task0.id, 'note', '', note.slice(0, 20_000), actor);
    return { task: bumped };
  }

  blockTask(input: { roomId: string; taskPath: string; actorContact: string; note?: string }): { task: RoomTaskRow } | StoreError {
    return this.blockOrDone({ ...input, target: 'blocked', kind: 'blocked' });
  }

  doneTask(input: { roomId: string; taskPath: string; actorContact: string; note?: string }): { task: RoomTaskRow } | StoreError {
    return this.blockOrDone({ ...input, target: 'closed', kind: 'done' });
  }

  /**
   * O2 invariant #2: end-of-turn auto-pass. When an open-mode turn ends with
   * the baton still held by this module, no terminal disposition, and no
   * in-flight Worker job, the gateway moves the baton back to plan and logs
   * `auto-pass: unfinished` instead of failing the turn.
   */
  autoPassUnfinished(taskId: string, actor: string, moduleId: string, summary: string, opts?: { deferDelivery?: boolean }): { task: RoomTaskRow } | null {
    try {
      this.ensureSchema();
      const task = this.getTaskById(taskId);
      if (!task) return null;
      if (!this.isOpenGovernance(task.room_id)) return null;
      if (['closed', 'dropped', 'blocked'].includes(task.status)) return null;
      const holder = task.holder_module ?? task.owner_module;
      if (holder !== moduleId) return null;
      if (this.activeLinkedJobs(task.id).length > 0) return null;
      if (holder === 'plan') return null;
      const result = this.passInternal(task, 'plan', actor, `auto-pass: unfinished${summary ? ` · ${summary.slice(0, 300)}` : ''}`, 'auto-pass',
        opts?.deferDelivery ? { deferDelivery: true } : undefined);
      this.event(task.id, 'auto-pass', actor, { fromModule: holder, summary: summary.slice(0, 500) }, moduleId);
      if (result.deferred) {
        this.deferredPassDeliveries.push(result.deferred);
      }
      return { task: result.task };
    } catch {
      return null;
    }
  }

  /** O2: apply a queued `next` baton once the in-flight job drains. */
  applyQueuedNext(taskId: string, actor: string): { task: RoomTaskRow; delivery: RoomTaskDispatchResult } | null {
    try {
      this.ensureSchema();
      const task = this.getTaskById(taskId);
      if (!task || !task.next_module) return null;
      if (!this.isOpenGovernance(task.room_id)) return null;
      if (['closed', 'dropped', 'blocked'].includes(task.status)) return null;
      if (this.activeLinkedJobs(task.id).length > 0) return null;
      if (!isModuleId(task.next_module)) {
        this.bump(task.id, { next_module: null });
        return null;
      }
      const result = this.passInternal(task, task.next_module as WorkflowModuleId, actor, 'queued next applied after job drain', 'next-applied');
      return { task: result.task, delivery: result.delivery };
    } catch {
      return null;
    }
  }

  // ── execution ──────────────────────────────────────────────────────

  executionStart(input: {
    roomId: string;
    taskPath: string;
    actorContact: string;
    module: string;
    expectedRevision: number;
    workspace: string;
    objective: string;
    returnToModule: string;
    returnMode?: string;
    write?: boolean;
    shell?: boolean;
    ssh?: boolean;
    priority?: number;
  }): { job: JobRow; task: RoomTaskRow } | StoreError {
    this.ensureSchema();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const roomMismatch = this.checkRoom(tc, input.roomId.trim());
    if (roomMismatch) return roomMismatch;
    const task0 = this.getTask(input.roomId.trim(), input.taskPath.trim());
    if (!task0) return fail('任务不存在', 404);
    const taskMismatch = this.checkTask(tc, task0);
    if (taskMismatch) return taskMismatch;
    const actor = input.actorContact.trim();
    if (!this.isParticipant(task0.room_id, actor)) return fail('只有本会议室成员可以启动执行', 403);
    const turnGate = this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    if (['closed', 'dropped'].includes(task0.status)) return fail(`任务已 ${task0.status}，不能再执行`, 409);
    if (!isModuleId(input.module)) return fail(`未知模块 ${input.module}`, 400);
    if (!isModuleId(input.returnToModule)) return fail(`return_to_module 未知：${input.returnToModule}`, 400);
    if (input.returnMode !== undefined && !['handoff', 'notify'].includes(input.returnMode)) return fail('return_mode 必须是 handoff | notify', 400);
    const moduleId = input.module;
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      return fail('expected_revision 必须是正整数（任务 revision 守卫）', 400);
    }
    if (expectedRevision !== task0.revision) {
      return fail(`任务 revision 已变化（期望 ${expectedRevision}，当前 ${task0.revision}）；先 task_get 再试`, 409);
    }
    if (task0.owner_module !== moduleId || task0.owner_contact !== actor) {
      return fail(`当前负责人是 ${task0.owner_module}（${task0.owner_contact}）；先完成 task_handoff/task_accept 拿到显式授权`, 403);
    }
    // The acting turn must wear this module's hat: a plan-hat turn cannot
    // start deploy work even when the same contact holds both bindings.
    if (moduleId !== tc.moduleId) {
      return fail(`本轮次是 ${tc.moduleId} 身份，不得以 ${moduleId} 名义启动执行`, 403);
    }
    // Accepted-handoff authorization from the durable row (no bypasses, no
    // marker fallback, no live re-resolution): the captured snapshot IS the
    // authority for this attempt. A handoff-woken turn uses its own handoff;
    // anything else resolves the latest accepted handoff for this role.
    let accepted: RoomTaskHandoffRow | undefined;
    if (tc.handoffId) {
      const pinned = this.handoffRow(tc.handoffId);
      if (!pinned || pinned.task_id !== task0.id) return fail('本轮次交接已不在该任务上', 410);
      const pinUsable = pinned.status === 'accepted' && pinned.to_module === moduleId && pinned.to_contact === actor;
      if (pinUsable) {
        accepted = pinned;
      } else if (this.isOpenGovernance(task0.room_id)) {
        // Open governance: holder/owner (checked above) is the authority; a
        // superseded pin falls back to the latest accepted pass row.
        accepted = this.latestAcceptedHandoff(task0.id, moduleId, actor);
      } else if (pinned.status !== 'accepted') {
        return fail(`本轮次交接已 ${pinned.status}；按最新状态重走交接`, 409);
      } else {
        return fail('本轮次交接与执行模块/执行人不一致', 403);
      }
    } else {
      accepted = this.latestAcceptedHandoff(task0.id, moduleId, actor);
    }
    if (!accepted) {
      return fail('没有已接受的交接授权；先 task_handoff/task_accept，再 execution_start', 403);
    }
    const started = this.startAcceptedExecution(input, task0, accepted);
    if ('error' in started) {
      this.recordCapabilityRejectFromFailure(task0.id, actor, moduleId, started);
    }
    return started;
  }

  /** Both explicit execution and owner-authorized auto-start use the same
   * frozen implementation identity and launch checks. No fabricated execute
   * turn is created: the original initiating turn remains the audit origin. */
  private startAcceptedExecution(
    input: Parameters<RoomTaskStore['executionStart']>[0],
    task0: RoomTaskRow,
    accepted: RoomTaskHandoffRow,
    autoStart = false,
  ): { job: JobRow; task: RoomTaskRow } | StoreError {
    const actor = accepted.to_contact;
    const moduleId = accepted.to_module as WorkflowModuleId;
    // Q4: system paths (merge-stale auto-start from handleJobFinished) run
    // without a model turn context; only the audit turn id is optional here.
    const tc = this.toolContext;
    // O4: wake budget counts every Worker job start. Exhaustion auto-blocks
    // the task (surfaced to User); the job is not launched.
    if (!this.countWakeOrBlock(task0.id, actor, `job:${moduleId}`)) {
      return fail('wake budget exhausted：本任务今日唤醒已超上限，已自动 block 交 User', 409);
    }
    if (!isModuleId(input.returnToModule)) return fail(`return_to_module 未知：${input.returnToModule}`, 400);
    const snapshot = this.parseSnapshot(accepted);
    if ('error' in snapshot) return snapshot;
    if (snapshot.binding.contactId !== actor) {
      return fail('交接快照的接收人与你不一致；不得冒用他人授权', 403);
    }
    // Approved workspace binding: the attempt runs exactly where the task
    // approves. Narrowing and widening are both rejected: the worker claim
    // caps still apply on top, but the ledger never authorizes a drift.
    if (canonicalWorkspace(input.workspace) !== canonicalWorkspace(task0.approved_workspace)) {
      return fail(`执行工作区必须与任务批准工作区一致：${task0.approved_workspace}`, 403);
    }
    // Module policy intersects requested actions; the frozen snapshot can only
    // narrow, never widen.
    const wantWrite = input.write !== false;
    const wantShell = input.shell === true || wantWrite;
    const wantSsh = input.ssh === true;
    for (const [key, want] of [['write', wantWrite], ['shell', wantShell], ['ssh', wantSsh]] as const) {
      if (want && !snapshot.permissions[key]) {
        return fail(`交接快照没有 ${key} 权限；请求不得扩大授权`, 403);
      }
    }
    const objective = text(input.objective, 20_000);
    if (!objective) return fail('objective 必填：写清本轮要做什么', 400);
    const returnTarget = this.resolveReturnTarget(task0, input.returnToModule as WorkflowModuleId);
    if ('error' in returnTarget) return returnTarget;
    // Task-level single active write lease: one writer at a time. Read-only
    // attempts (write=false) may run only as their own explicit request.
    if (wantWrite) {
      const activeWriter = this.activeLinkedJobs(task0.id).find((job) => {
        try {
          return (JSON.parse(job.permissions || '{}') as { write?: unknown }).write === true;
        } catch {
          return false;
        }
      });
      if (activeWriter) {
        return fail(`任务已有在途写操作 ${activeWriter.id}（${activeWriter.status}）；等它结束或用 task_retry/takeover 显式接管`, 409);
      }
    }
    // Problem identity is the task's requirements (or an explicit planHash),
    // never this round's wording: re-sliced objectives must not reset the
    // implementation counters (2026-09-14: 24 rounds, 24 fingerprints).
    const planHashLine = /^planHash=[a-f0-9]{64}$/im.exec(objective)?.[0];
    const fingerprint = this.jobs.workflowModules.fingerprintFor(task0.task_path, planHashLine ?? task0.requirements);
    const invocation: ModuleInvocation = {
      moduleId,
      policyVersion: WORKFLOW_MODULE_POLICY_VERSION,
      bindingRevision: snapshot.revision,
      binding: { ...snapshot.binding },
      permissions: { ...snapshot.permissions },
      selected: { ...snapshot.binding },
      escalateToHuman: false,
      arbitrationActive: false,
      taskPath: task0.task_path,
      problemFingerprint: fingerprint,
    };
    const perms = {
      write: snapshot.permissions.write && wantWrite,
      shell: snapshot.permissions.shell && wantShell,
      ssh: snapshot.permissions.ssh && wantSsh,
    };
    // G02: tasks fenced inside a configured VPS target never run in place.
    // Each execution_start derives a sibling attempt directory
    // `<root>/<task>/<attempt>/<repo>` (exactly 3 segments below the mapped
    // root) and freezes the mapped worker/runner/ssh grant for the attempt.
    // Unmapped (PC) tasks keep the approved workspace unchanged. No second
    // baseline authority is created: baseline_sha flows untouched via patchBase.
    let executionWorkspace = task0.approved_workspace;
    let executionAttempt: string | null = null;
    let frozenTarget: ProjectTarget | null = null;
    const approvedTarget = matchWorkspaceTarget(task0.approved_workspace, this.projectTargets);
    if (approvedTarget) {
      const fenced = classifyTargetWorkspace(task0.approved_workspace, this.projectTargets);
      if (!fenced || fenced.depth !== 1 || isReservedReviewSlug(fenced.segments[0])) {
        return fail(`VPS 试点任务工作区必须是围栏内任务级目录：${approvedTarget.workspace}/<任务slug>；不得原地执行`, 409);
      }
      if (!approvedTarget.requiredCapabilities.runners.includes(snapshot.binding.runner)) {
        return fail(
          `VPS 试点映射 ${approvedTarget.repoId} 仅允许 runner=${approvedTarget.requiredCapabilities.runners.join('/')}；`
          + `当前交接绑定 runner=${snapshot.binding.runner} 不可在此工作区执行`,
          403,
        );
      }
      if (perms.ssh === true && approvedTarget.requiredCapabilities.ssh !== true) {
        return fail(`VPS 试点映射 ${approvedTarget.repoId} 未开放 SSH；远程部署只能登记 deploy-tail`, 403);
      }
      const taken = new Set(this.linkedJobs(task0.id).map((job) => job.workspace));
      let derived: string | null = null;
      for (let i = 0; i < 3 && !derived; i += 1) {
        const slug = `attempt-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
        try {
          const candidate = buildExecutionAttemptWorkspace(
            task0.approved_workspace, slug, approvedTarget.repoId, this.projectTargets,
          );
          if (!taken.has(candidate)) {
            derived = candidate;
            executionAttempt = slug;
          }
        } catch {
          // Fence rejection means the approved row drifted out of the fence;
          // surface it below instead of silently running in place.
        }
      }
      if (!derived) {
        return fail(
          fenced ? '执行尝试目录分配冲突；稍后重试 execution_start'
            : `VPS 试点执行目录不在围栏内：${approvedTarget.workspace}/<任务slug>/<尝试slug>/${approvedTarget.repoId}；不得原地执行`,
          409,
        );
      }
      executionWorkspace = derived;
      frozenTarget = {
        ...approvedTarget,
        workspace: derived,
        requiredCapabilities: { ...approvedTarget.requiredCapabilities },
      };
    }
    // Capability-card admission (selected worker = frozen VPS pin, else the
    // execute binding's delegation pin): refuse BEFORE creating the job.
    // execution_start, handoff/pass auto_start, review direct repair,
    // merge-stale direct rebase and sequence next-block starts all funnel
    // through here. A missing card (old worker) passes; the refusal is
    // persisted (event + system fact) by the caller via
    // recordCapabilityRejectFromFailure.
    const capabilityHit = this.evaluateCapabilityCard({
      task: task0,
      bindingContactId: snapshot.binding.contactId,
      frozenTarget,
      runner: snapshot.binding.runner,
      needWrite: perms.write === true,
    });
    if (capabilityHit) return fail(capabilityHit.reasonLine, 409);
    const evidenceRows = this.db.prepare(
      'SELECT kind, ref FROM room_task_evidence WHERE task_id = ? ORDER BY id DESC LIMIT 20',
    ).all(task0.id) as Array<{ kind: string; ref: string }>;
    const prompt = [
      `【room-task execution】${task0.task_path}（task rev ${task0.revision}，handoff ${accepted.id}，return_to=${input.returnToModule}）`,
      '',
      '### 原始需求（源任务，不可改写）',
      // Every round carries the full text: a repair Worker starts from a
      // fresh workspace, cannot call room tools, and has nowhere else to read it.
      task0.requirements.slice(0, 8000),
      '',
      '### 本轮目标（发起人说明）',
      objective,
      '',
      '### 已有证据引用',
      evidenceRows.length ? evidenceRows.map((row) => `- ${row.kind} ${row.ref}`.trim()).join('\n') : '（无）',
      '',
      '### 范围与纪律',
      `- workspace：${executionWorkspace}；只改本任务相关文件。`,
      '- 完成后按 Worker 回执规范如实申报 branch/HEAD/diffstat/tests；不得虚构，不得把失败写成通过。',
      '- Worker 会从 git 直接采集本轮 diff 原文供评审读取；回执里不必贴整段 diff 或源码。',
      '- 本轮未经独立评审：不要登记 deploy-tail，部署步骤写进回执即可。',
      ...(!perms.write && snapshot.binding.runner === 'opencode' && perms.shell
        ? ['- 本轮只读（OpenCode）：shell 仅放行只读命令（git show/log/diff/rev-parse/status/cat-file、ls/cat/head/tail/wc/grep/find/rg），其余命令与 edit/write 均拒绝；可用 git show <sha>:<path> 取证。需要写操作请由发起人改用 write=true。']
        : !perms.write && snapshot.binding.runner === 'opencode'
          ? ['- 本轮只读（OpenCode）：没有 shell/命令工具（仅 read/glob/grep/list）；需要命令请由发起人改用 shell=true 的只读交接或 write=true。']
          : []),
      '- 未完成也要如实报告：已做进度、受阻原因与恢复条件写进回执正文；本任务的轮次交接义务由登记了 return_to 回调的 room controller 负责，你无需、也不得调用任何 room 任务工具。',
      '- 自写回执（O6）：把本轮完整回执（含 blocked 时的改动清单）同时写一份文本文件到 %AI_HUB_SCRATCH_DIR% 目录（本 job 专属本地目录，AI_HUB_JOB_ID 子目录）；不要写进 vault backlog/worker-tail，也不要在回执里贴整段 diff。留守改动（blocked_local_changes）时正文必须含 git status --short 原文与脏文件清单，网关不再回头找你要。',
      `- task_id=${task0.id}`,
    ].join('\n');
    const jobOptions: NonNullable<Parameters<JobStore['create']>[0]['options']> = {
      model: snapshot.binding.model,
      reasoning: snapshot.binding.reasoning,
      routeClass: wantWrite ? 'implement' : 'recon',
      runnerSource: 'policy',
      problemFingerprint: fingerprint,
      taskPath: task0.task_path,
      ...(task0.baseline_sha ? { patchBase: task0.baseline_sha } : {}),
      // P3 review delta: the last pinned candidate is the increment base.
      // The worker collects an extra patchSince..HEAD diff; unusable bases
      // fall back to no delta (marked patchSinceFallback), never an error.
      ...(task0.candidate_sha && SHA40_RE.test(task0.candidate_sha) ? { patchSince: task0.candidate_sha.toLowerCase() } : {}),
      // User 2026-09-23: an execute write round that leaves its work
      // uncommitted while declaring every test passing is committed and
      // pushed by the Worker itself (worker/auto-commit.mjs), so review gets
      // a SHA instead of another "just commit it" round.
      ...(moduleId === 'execute' && perms.write ? { autoCommitOnPass: true } : {}),
    };
    if (frozenTarget) {
      // The stamped target is the freeze authority for claim isolation
      // (checkProjectTargetClaim). Written without touching jobStore.ts:
      // options JSON is schemaless at runtime; the static options type is
      // left exactly as master has it.
      (jobOptions as Record<string, unknown>).projectTarget = frozenTarget;
    }
    const created = this.jobs.create({
      requestedBy: actor,
      runner: snapshot.binding.runner,
      workspace: executionWorkspace,
      prompt,
      priority: Math.min(Math.max(Number(input.priority) || 0, -10), 10),
      ...(frozenTarget ? { workerId: frozenTarget.workerId } : {}),
      permissions: perms,
      trustedInvocation: invocation,
      options: jobOptions,
      originContactId: task0.room_id,
      originAnchorId: task0.anchor_message_id,
    });
    if ('error' in created) return fail(`创建执行任务失败：${created.error}`, 409);
    if (created.merged) return fail(`任务被并入在途 job ${created.job.id}；先确认其状态`, 409);
    this.stampTaskJob(created.job.id, task0, actor, {
      roomTaskRevision: task0.revision,
      roomTaskReturn: input.returnToModule,
      handoffId: accepted.id,
      ...(autoStart ? { handoffAutoStart: true, initiatedBy: input.actorContact } : {}),
    });
    const tx = this.db.transaction(() => {
      this.addEvidence(task0.id, 'note', created.job.id, `执行启动：${moduleId} ${created.job.id}（handoff=${accepted.id}，return_to=${input.returnToModule}）`, actor);
      if (frozenTarget && executionAttempt) {
        this.addEvidence(task0.id, 'note', created.job.id,
          [`执行目录：${executionWorkspace}`, `task=${task0.approved_workspace}`, `attempt=${executionAttempt}`, `repo=${frozenTarget.repoId}`].join('\n').slice(0, 2000),
          actor);
      }
      this.insertCallback(task0, created.job.id, input.returnToModule as WorkflowModuleId, returnTarget, actor, input.returnMode !== 'notify');
      const bumped = this.bump(task0.id, { status: 'in_progress' });
      const execTurnId = tc && typeof tc.turnId === 'string' ? tc.turnId : undefined;
      this.event(task0.id, 'execution-started', actor, {
        jobId: created.job.id, module: moduleId, handoffId: accepted.id,
        returnTo: input.returnToModule, revision: task0.revision,
        ...(frozenTarget && executionAttempt
          ? { workspace: executionWorkspace, attempt: executionAttempt, repoId: frozenTarget.repoId }
          : {}),
        ...(autoStart ? { initiatedBy: input.actorContact, autoStart: true } : {}),
        ...(execTurnId ? { turnId: execTurnId } : {}),
      }, moduleId);
      this.emitPcOfflineFallbackHint(task0, created.job, snapshot.binding.contactId, actor, moduleId);
      return bumped;
    });
    const task = tx();
    return { job: this.jobs.get(created.job.id)!, task };
  }

  executionGet(input: {
    roomId: string;
    taskPath: string;
    actorContact: string;
    jobId: string;
    section?: 'result' | 'patch' | 'patch_delta';
    resultOffset?: number;
    resultLimit?: number;
    patchOffset?: number;
    patchLimit?: number;
    patchFile?: string;
  }): { job: Record<string, unknown>; receiptPage: Record<string, unknown> } | StoreError {
    this.ensureSchema();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const roomMismatch = this.checkRoom(tc, input.roomId.trim());
    if (roomMismatch) return roomMismatch;
    const readGate = this.requireReadTurn(tc, input.actorContact.trim());
    if (readGate) return readGate;
    const task = this.getTask(input.roomId.trim(), input.taskPath.trim());
    if (!task) return fail('任务不存在', 404);
    const taskMismatch = this.checkTask(tc, task);
    if (taskMismatch) return taskMismatch;
    const actor = input.actorContact.trim();
    if (actor !== 'User' && !this.isParticipant(task.room_id, actor)) return fail('跨会议室执行记录不可读', 403);
    const job = this.jobs.get(String(input.jobId || '').trim());
    if (!job) return fail('job 不存在', 404);
    const linked = this.db.prepare(
      'SELECT 1 FROM room_task_links WHERE job_id = ? AND task_id = ?',
    ).get(job.id, task.id);
    if (!linked) return fail('该 job 不属于本任务（伪造/跨任务引用已拒绝）', 404);
    const patch = input.section === 'patch' ? receiptPatch(job) : null;
    const patchDelta = input.section === 'patch_delta' ? receiptPatchDelta(job) : null;
    if (input.section === 'patch' && (!patch || patch.dropped)) {
      return fail(patch?.dropped
        ? `该执行的 diff 原文超出存储上限已丢弃（原长 ${patch.chars} 字符）；按 diffstat/changedFiles 分文件核对`
        : '该执行没有 Worker 采集的 diff（无代码变化，或 Worker 版本早于 diff 采集）', 404);
    }
    if (input.section === 'patch_delta' && (!patchDelta || patchDelta.dropped)) {
      return fail(patchDelta?.dropped
        ? `该执行的增量 diff 超出存储上限已丢弃（原长 ${patchDelta.chars} 字符）；用 section=patch 读累计 diff`
        : '该执行没有增量 diff（启动时任务没有已 pin 候选，或 Worker 版本早于增量采集）；用 section=patch 读累计 diff', 404);
    }
    // B2: patch sections page over the stored diff (worker caps it at 120k)
    // with its own offset/limit (default 120000, max 120000) plus an optional
    // per-file slice. The result section keeps the old 4000/12000 paging.
    const diff = patch ?? patchDelta;
    const diffSection = input.section === 'patch_delta' ? 'patch_delta' : 'patch';
    let payload = diff ? diff.patch : job.result ?? job.error ?? '';
    let offset = Math.min(Math.max(Number(input.resultOffset) || 0, 0), payload.length);
    let limit = Math.min(Math.max(Number(input.resultLimit) || 4000, 1), 12_000);
    let patchFiles: string[] = [];
    let patchHint: string | null = null;
    if (diff && (input.section === 'patch' || input.section === 'patch_delta')) {
      patchFiles = listPatchFiles(diff.patch);
      const wantFile = typeof input.patchFile === 'string' ? input.patchFile.trim().replaceAll('\\', '/') : '';
      if (wantFile) {
        const block = splitPatchByFile(diff.patch).blocks.find((item) => item.path === wantFile);
        if (!block) {
          return fail(`patch 里没有该文件 ${wantFile}（共 ${patchFiles.length} 个：${patchFiles.slice(0, 20).join('、')}${patchFiles.length > 20 ? '…' : ''}）；照 patchFiles 里的原名重取`, 404);
        }
        payload = diff.patch.slice(block.start, block.end);
      }
      offset = Math.min(Math.max(Number(input.patchOffset) || 0, 0), payload.length);
      const rawLimit = Number(input.patchLimit);
      limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 120_000) : 120_000;
    }
    const end = Math.min(offset + limit, payload.length);
    const atEnd = end >= payload.length;
    if (diff && (input.section === 'patch' || input.section === 'patch_delta')) {
      const nextArgs = [`patch_offset=${end}`, ...(limit !== 120_000 ? [`patch_limit=${limit}`] : []),
        ...(typeof input.patchFile === 'string' && input.patchFile.trim() ? [`patch_file="${input.patchFile.trim()}"`] : [])].join(', ');
      if (!atEnd) {
        patchHint = `还有后页：execution_get(room_id="${input.roomId.trim()}", task_path="${input.taskPath.trim()}", job_id="${job.id}", section="${diffSection}", ${nextArgs})`;
      } else if (diff.truncated) {
        patchHint = `本页已到存储末尾，但 Worker 采集时已截断（原长 ${diff.chars} 字符）；用 patch_file 按文件分取所需部分`;
      } else if (patchDelta?.patchDeltaKind === 'rebase-identical') {
        patchHint = '干净 rebase：本任务自身的 patch 与上次 pin 候选逐字一致，只是换了主干基点，所以增量为空';
      }
    }
    return {
      job: this.jobBrief(job),
      receiptPage: {
        jobId: job.id,
        kind: patch ? 'patch' : patchDelta ? 'patch_delta' : job.result ? 'result' : job.error ? 'error' : 'empty',
        ...(patch ? { patchChars: patch.chars, patchTruncated: patch.truncated,
          patchBase: patch.patchBase, patchBaseKind: patch.patchBaseKind,
          patchBaseFallback: patch.patchBaseFallback } : {}),
        ...(patchDelta ? { patchDeltaChars: patchDelta.chars, patchDeltaTruncated: patchDelta.truncated,
          patchDeltaBase: patchDelta.patchDeltaBase, patchDeltaKind: patchDelta.patchDeltaKind,
          patchSinceFallback: patchDelta.patchSinceFallback } : {}),
        start: offset,
        end,
        total: payload.length,
        page: payload.slice(offset, end),
        atEnd,
        nextOffset: end,
        ...(diff && (input.section === 'patch' || input.section === 'patch_delta') ? {
          patchNextOffset: end,
          patchAtEnd: atEnd,
          patchTotalChars: payload.length,
          patchFiles,
          ...(patchHint ? { hint: patchHint } : {}),
        } : {}),
      },
    };
  }

  // ── review ─────────────────────────────────────────────────────────

  private validateEvidenceRefs(taskId: string, refs: string[]): StoreError | null {
    const linked = new Set(this.linkedJobs(taskId).map((job) => job.id));
    for (const ref of refs) {
      if (linked.has(ref)) continue;
      if (/^\d+$/.test(ref)) {
        const row = this.db.prepare(
          'SELECT 1 FROM room_task_evidence WHERE id = ? AND task_id = ?',
        ).get(Number(ref), taskId);
        if (row) continue;
      }
      return fail(`证据引用不存在于本任务：${ref.slice(0, 120)}`, 400);
    }
    return null;
  }

  reviewSubmit(input: {
    roomId: string;
    taskPath: string;
    actorContact: string;
    module: string;
    candidateJobId: string;
    candidateSha: string;
    verdict: string;
    findings?: string;
    evidenceRefs?: string[];
    /** Q3: only meaningful with verdict=approve. 'done' declares "close on
     * successful merge" (open rooms, no-deploy tasks); default 'review' keeps
     * the classic close-by-reviewer flow. Strict rooms ignore the value. */
    afterMerge?: string;
    /** R2-D: optional unified diff, only verdict=approve + open rooms.
     * Applied mechanically by the merge script after Gate, verified identical. */
    patch?: string;
  }): { task: RoomTaskRow; evidenceId: number; autoPass?: { toModule: string; queued: boolean; jobId?: string; existing?: boolean; fallbackReason?: string }; autoRelease?: { jobId?: string; existing?: boolean; fallbackReason?: string } } | StoreError {
    this.ensureSchema();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const roomMismatch = this.checkRoom(tc, input.roomId.trim());
    if (roomMismatch) return roomMismatch;
    const task0 = this.getTask(input.roomId.trim(), input.taskPath.trim());
    if (!task0) return fail('任务不存在', 404);
    const taskMismatch = this.checkTask(tc, task0);
    if (taskMismatch) return taskMismatch;
    const actor = input.actorContact.trim();
    if (!this.isParticipant(task0.room_id, actor)) return fail('只有本会议室成员可以评审', 403);
    const turnGate = this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    if (['closed', 'dropped'].includes(task0.status)) return fail(`任务已 ${task0.status}，不再接受评审`, 409);
    if (!['review', 'arbitration'].includes(input.module)) return fail('评审只能由 review 或 arbitration 模块发起', 400);
    const moduleId = input.module as WorkflowModuleId;
    // Trusted invocation chain: the reviewer must hold the current ownership
    // AND an accepted handoff to this review module, AND act in this module's
    // turn. A contact wearing two hats cannot cross roles on argument claims
    // alone (plan-hat review of a deploy-owned task is rejected here).
    if (moduleId !== tc.moduleId) {
      return fail(`本轮次是 ${tc.moduleId} 身份，不得以 ${moduleId} 名义提交评审`, 403);
    }
    if (task0.owner_module !== moduleId || task0.owner_contact !== actor) {
      return fail(`当前负责人是 ${task0.owner_module}（${task0.owner_contact}）；评审需先拿到该模块的显式交接受理`, 403);
    }
    let accepted: RoomTaskHandoffRow | undefined;
    if (tc.handoffId) {
      const pinned = this.handoffRow(tc.handoffId);
      if (!pinned || pinned.task_id !== task0.id) return fail('本轮次交接已不在该任务上', 410);
      const pinUsable = pinned.status === 'accepted' && pinned.to_module === moduleId && pinned.to_contact === actor;
      if (pinUsable) {
        accepted = pinned;
      } else if (this.isOpenGovernance(task0.room_id)) {
        // Open governance: the baton (holder/owner, checked above) is the
        // authority. A pinned handoff superseded by a task_pass in the same
        // turn must not strand the verdict; fall back to the latest pass row.
        accepted = this.latestAcceptedHandoff(task0.id, moduleId, actor);
      } else if (pinned.status !== 'accepted') {
        return fail(`本轮次交接已 ${pinned.status}`, 409);
      } else {
        return fail('本轮次交接与评审模块/评审人不一致', 403);
      }
    } else {
      accepted = this.latestAcceptedHandoff(task0.id, moduleId, actor);
    }
    if (!accepted) return fail('没有已接受的评审交接授权；先 task_handoff/task_accept', 403);
    const binding = this.currentBindingContact(moduleId);
    if ('error' in binding) return binding;
    if (binding.contactId !== actor) {
      return fail(`模块 ${moduleId} 当前绑定 ${binding.contactId}；只有绑定者可以提交评审`, 403);
    }
    const candidate = this.jobs.get(String(input.candidateJobId || '').trim());
    if (!candidate) return fail('候选 job 不存在', 404);
    const linked = this.db.prepare(
      'SELECT 1 FROM room_task_links WHERE job_id = ? AND task_id = ?',
    ).get(candidate.id, task0.id);
    if (!linked) return fail('候选 job 不属于本任务（伪造/跨任务引用已拒绝）', 404);
    if (this.jobs.workflowModules.isFenced(candidate.id)) {
      return fail('候选尝试已被接管废弃；按当前在途尝试重审', 409);
    }
    if (!['done', 'blocked'].includes(candidate.status)) {
      return fail(`候选 job 尚未终态（${candidate.status}）；等它结束再评审`, 409);
    }
    const receipt = structuredReceiptFields(candidate);
    const actualHead = (receipt.head ?? '').toLowerCase();
    const pinned = String(input.candidateSha || '').trim().toLowerCase();
    if (!SHA40_RE.test(pinned)) return fail('candidate_sha 必须是完整 40 位 commit SHA', 400);
    if (!actualHead || actualHead !== pinned) {
      return fail('候选 SHA 与 job 回执 HEAD 不一致；先 execution_get 核对完整回执', 409);
    }
    // Candidate age follows the implementation job, never git ancestry (a
    // repair may amend/rebase). Same-job and equal-time reviews are allowed;
    // only a demonstrably older job must not replace the current pin.
    if (task0.candidate_job_id && task0.candidate_job_id !== candidate.id) {
      const currentCandidate = this.jobs.get(task0.candidate_job_id);
      if (!currentCandidate) return fail('当前 pin 的候选 job 不存在；先核对任务账本', 409);
      if (candidate.created_at < currentCandidate.created_at) {
        return fail('候选 job 比当前 pin 更旧；必须按新候选重审，不得回退旧版本', 409);
      }
    }
    // Independence: reject the reviewer matching ANY known actual
    // implementer identity. requested_by is the author in every creation
    // path, but a legacy import may carry requested_by=plan while the real
    // execution binding names the reviewer — prioritizing the requester
    // would conceal the captured actor and allow self-review.
    // Merge/deploy closures are never reviewable candidates (implementation
    // attempts only, mirroring candidate evidence).
    const candidateOptions = parseJson(candidate.options);
    if (typeof candidateOptions.closureKind === 'string' && candidateOptions.closureKind) {
      return fail('候选只能是实现尝试，不能是合并/部署收口单', 400);
    }
    const capturedImpl = record(candidateOptions.workflowModule);
    const capturedBinding = record(capturedImpl.binding);
    const capturedSelected = record(capturedImpl.selected);
    const implActors = new Set<string>();
    for (const value of [capturedBinding.contactId, capturedSelected.contactId]) {
      if (typeof value === 'string' && value) implActors.add(value);
    }
    if (typeof candidate.requested_by === 'string' && candidate.requested_by && candidate.requested_by !== 'User') {
      implActors.add(candidate.requested_by);
    }
    if (implActors.has(actor)) {
      return fail('不能评审自己执行的候选版本；换独立评审人', 403);
    }
    const verdict = String(input.verdict || '').trim().toLowerCase();
    if (!['approve', 'request_changes'].includes(verdict)) {
      return fail('verdict 必须是 approve 或 request_changes', 400);
    }
    const afterMerge = String(input.afterMerge ?? 'review').trim().toLowerCase();
    if (!['review', 'done', 'deploy'].includes(afterMerge)) {
      return fail('after_merge 必须是 review、done 或 deploy', 400);
    }
    if (afterMerge !== 'review' && verdict !== 'approve') {
      return fail(`after_merge="${afterMerge}" 只在 verdict=approve 时有意义`, 400);
    }
    const findings = text(input.findings, 20_000);
    if (verdict === 'request_changes' && !findings) {
      return fail('REQUEST_CHANGES 必须写清 MUST 项与可判真伪的通过条件', 400);
    }
    const evidenceRefs = Array.isArray(input.evidenceRefs)
      ? input.evidenceRefs.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 50)
      : [];
    const dangling = this.validateEvidenceRefs(task0.id, evidenceRefs);
    if (dangling) return dangling;
    // Deterministic evidence bar for APPROVE: real diff + a non-empty,
    // all-green test set bound to this candidate. Empty tests[] never passes.
    if (verdict === 'approve') {
      if (!receipt.diffstat || !receipt.changedFiles || !receipt.tests || receipt.tests.length === 0) {
        return fail('候选回执缺少 diffstat/changedFiles/非空 tests；APPROVE 需要真实 diff 与测试证据', 409);
      }
      if (receipt.tests.some((item) => item.status !== 'pass')) {
        return fail('候选报告了未通过的测试；不得 APPROVE', 409);
      }
    }
    // R2-D D1: review-patch machine gates. Candidate_sha is never advanced;
    // the frozen candidate stays review-approved so Q2/mergeGates/Gate L are untouched.
    const rawPatch = typeof (input as { patch?: unknown }).patch === 'string'
      ? String((input as { patch?: unknown }).patch ?? '')
      : '';
    const hasPatch = rawPatch.trim().length > 0;
    let patchMeta: ParsedReviewPatch | null = null;
    if (hasPatch) {
      if (verdict !== 'approve') {
        return fail('patch 只在 verdict=approve 时有意义', 400);
      }
      if (!this.isOpenGovernance(task0.room_id)) {
        return fail('strict 房不支持评审补丁；请用 REQUEST_CHANGES', 400);
      }
      const workspaces = [task0.approved_workspace, candidate.workspace].filter(Boolean).map(String);
      if (workspaces.some((ws) => isWindowsPathForPatch(ws))) {
        return fail('PC 工作区暂不支持评审补丁', 400);
      }
      try {
        patchMeta = validateReviewPatch(rawPatch, receipt.changedFiles?.files ?? null);
      } catch (error) {
        return fail((error instanceof Error ? error.message : String(error)).slice(0, 500), 400);
      }
    }
    let evidenceId = 0;
    // R1: the three-round gate is evaluated against rounds since the previous
    // review verdict (captured before this verdict lands and resets the
    // counter). A tripped gate falls back to the classic execute-seat wake.
    const roundsBeforeReview = this.executeRoundsSinceReview(task0.id);
    const tx = this.db.transaction(() => {
      if (task0.candidate_job_id !== candidate.id || task0.candidate_sha?.toLowerCase() !== pinned) {
        this.event(task0.id, 'candidate-submitted', actor, {
          jobId: candidate.id, sha: pinned, invalidatedPriorReview: task0.review_status,
        }, moduleId);
      }
      evidenceId = this.addEvidence(task0.id, 'review', candidate.id,
        [`verdict=${verdict}`, `candidate=${pinned}`, `reviewer=${actor}`, `handoff=${accepted.id}`,
          `after_merge=${afterMerge}`,
          findings, `refs=${evidenceRefs.join(',')}`,
          ...(patchMeta ? [`review-patch sha256=${patchMeta.sha256} chars=${patchMeta.chars} lines=${patchMeta.lines} files=${patchMeta.files.join(',')}`, rawPatch] : []),
        ].filter(Boolean).join('\n').slice(0, 20_000),
        actor);
      // R2-D: patch原文另存一处可被合入链读到的地方；id 记进事件 payload。
      // 机器判定只读事件 payload 的结构化 patch 字段，不从证据正文正则读。
      let patchEvidenceId: number | null = null;
      if (patchMeta) {
        patchEvidenceId = this.addEvidence(task0.id, 'review-patch', candidate.id, rawPatch.slice(0, 20_000), actor);
      }
      let bumped: RoomTaskRow;
      if (verdict === 'approve') {
        bumped = this.bump(task0.id, {
          status: 'in_review',
          candidate_sha: pinned,
          candidate_job_id: candidate.id,
          review_status: 'approved',
          review_evidence_id: evidenceId,
        });
      } else {
        bumped = this.bump(task0.id, {
          status: 'open',
          candidate_sha: pinned,
          candidate_job_id: candidate.id,
          review_status: 'changes_requested',
          review_evidence_id: evidenceId,
        });
      }
      this.event(task0.id, verdict === 'approve' ? 'review-approved' : 'review-changes-requested', actor, {
        candidateJobId: candidate.id, candidateSha: pinned, evidenceId,
        findings: findings.slice(0, 1000),
        ...(verdict === 'approve' ? { afterMerge } : {}),
        ...(patchMeta ? { patch: { sha256: patchMeta.sha256, chars: patchMeta.chars, lines: patchMeta.lines, files: patchMeta.files }, patchEvidenceId } : {}),
      }, moduleId);
      return bumped;
    });
    tx();
    // Quality is keyed to the candidate's own problem identity. A correct
    // REQUEST_CHANGES is an implementation failure (execute streak), not a
    // reviewer failure; APPROVE clears that problem's counters.
    try {
      const candidateFingerprint = typeof candidateOptions.problemFingerprint === 'string'
        ? candidateOptions.problemFingerprint
        : '';
      this.jobs.workflowModules.record(
        { id: candidate.id },
        {
          moduleId: verdict === 'approve' ? moduleId : 'execute',
          taskPath: task0.task_path,
          problemFingerprint: candidateFingerprint,
        },
        verdict === 'approve'
          ? { quality: 'success', detail: `independent review APPROVE ${pinned}` }
          : { quality: 'inadequate', detail: `independent review REQUEST_CHANGES ${candidate.id}` },
      );
    } catch { /* stats are best-effort */ }
    // O2: open mode review auto-pass. REQUEST_CHANGES → execute repair Worker
    // started directly (R1, no execute chat wake); APPROVE → merge closure
    // started directly (Q2), no merge chat wake. Strict rooms keep the
    // explicit handoff ritual.
    let autoPass: { toModule: string; queued: boolean; jobId?: string; existing?: boolean; fallbackReason?: string } | undefined;
    let autoRelease: { jobId?: string; existing?: boolean; fallbackReason?: string } | undefined;
    if (this.isOpenGovernance(task0.room_id)) {
      if (verdict === 'approve') {
        const direct = this.reviewAutoReleaseToMerge(task0.id, actor, moduleId);
        autoPass = { toModule: 'merge', queued: direct.queued };
        autoRelease = {
          ...(direct.jobId ? { jobId: direct.jobId } : {}),
          ...(direct.existing ? { existing: true } : {}),
          ...(direct.fallbackReason ? { fallbackReason: direct.fallbackReason } : {}),
        };
      } else {
        const direct = this.reviewChangesDirectStart(task0.id, actor, moduleId, findings, roundsBeforeReview);
        autoPass = {
          toModule: 'execute',
          queued: direct.queued,
          ...(direct.jobId ? { jobId: direct.jobId } : {}),
          ...(direct.existing ? { existing: true } : {}),
          ...(direct.fallbackReason ? { fallbackReason: direct.fallbackReason } : {}),
        };
      }
    }
    return { task: this.requireTask(task0.id), evidenceId, ...(autoPass ? { autoPass } : {}), ...(autoRelease ? { autoRelease } : {}) };
  }

  /**
   * R1 (cost batch 3): open-room review REQUEST_CHANGES starts the repair
   * Worker in the same flow: baton to execute (deferred delivery = no chat
   * wake) plus an execution job whose objective is the fixed preamble plus
   * the review findings verbatim — equivalent to the execute seat turning the
   * findings into an objective itself. Only a system fact is posted to the
   * room. The three-round gate, single-write lease, frozen execute snapshot
   * and patchBase/patchSince plumbing all stay enforced inside
   * startAcceptedExecution; wake-budget accounting matches Q4 (pass wake +
   * job-start wake both counted). Direct-start failure (tripped gate, no
   * usable binding, lease conflict, budget, …) falls back to the classic
   * execute-seat wake with a `review-changes-auto-start-fallback` reason
   * event; the task is never blocked on that account. Like the merge auto
   * path, a direct start never fails the review_submit call itself.
   */
  private reviewChangesDirectStart(
    taskId: string, reviewer: string, reviewModule: string, findings: string, roundsBeforeReview: number,
  ): {
    toModule: 'execute'; queued: boolean; jobId?: string; existing?: boolean; fallbackReason?: string;
  } {
    const note = 'review REQUEST_CHANGES auto-pass to execute (direct repair start, no execute chat wake)';
    // Fixed preamble + findings verbatim (existing 20_000 objective ceiling).
    const objective = `${REVIEW_CHANGES_DIRECT_OBJECTIVE_PREAMBLE}\n\n${findings}`.slice(0, 20_000);
    // Tripped three-round gate: keep the pre-R1 semantics (classic wake, no
    // direct job). The fresh verdict would reset the counter, so the gate is
    // evaluated against rounds since the previous verdict instead of being
    // bypassed.
    if (roundsBeforeReview >= EXECUTE_ROUNDS_BEFORE_REVIEW) {
      const reason = `本任务自上次独立评审以来已执行 ${roundsBeforeReview} 轮，不再直接启动返修；已按原流程唤醒 execute 席`;
      try {
        const passed = this.passInternal(this.requireTask(taskId), 'execute', reviewer, note, 'review-auto-pass');
        this.event(taskId, 'review-changes-auto-start-fallback', reviewer, { reason }, reviewModule);
        return { toModule: 'execute', queued: passed.queued, fallbackReason: reason };
      } catch (error2) {
        this.event(taskId, 'auto-pass-failed', reviewer, {
          toModule: 'execute', reason: (error2 instanceof Error ? error2.message : String(error2)).slice(0, 500),
        }, reviewModule);
        return { toModule: 'execute', queued: false, fallbackReason: reason };
      }
    }
    const tx = this.db.transaction(() => {
      const current = this.requireTask(taskId);
      if (['closed', 'dropped', 'blocked'].includes(current.status)) {
        throw new AutoStartRollback(fail(`任务已 ${current.status}，不再自动返修`, 409));
      }
      const passed = this.passInternal(current, 'execute', reviewer, note, 'review-auto-pass', { deferDelivery: true });
      if (passed.queued) {
        throw new AutoStartRollback(fail('任务已有在途执行；交棒已登记为 next，本次未直启', 409));
      }
      const passKey = `pass:v1:${current.id}:${current.revision}:execute`;
      const accepted = this.db.prepare('SELECT * FROM room_task_handoffs WHERE idempotency_key = ?').get(passKey) as RoomTaskHandoffRow | undefined;
      if (!accepted) throw new AutoStartRollback(fail('交棒落账缺失；先核对账本', 409));
      const started = this.startAcceptedExecution({
        roomId: current.room_id,
        taskPath: current.task_path,
        actorContact: reviewer,
        module: 'execute',
        expectedRevision: passed.task.revision,
        workspace: current.approved_workspace,
        objective,
        returnToModule: 'review',
      }, passed.task, accepted, true);
      if ('error' in started) throw new AutoStartRollback(started);
      this.event(taskId, 'review-changes-auto-started', reviewer, {
        jobId: started.job.id, passId: accepted.id, returnTo: 'review',
      });
      const factId = Number(this.db.prepare(`INSERT INTO messages
        (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
        VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main', ?)`).run(
        current.room_id,
        `【返修直接启动】${current.task_path}：${reviewer} REQUEST_CHANGES 后网关已直接为 execute 启动返修 job ${started.job.id}；完成回 review；不唤醒 execute 席聊天轮次。`,
        JSON.stringify({ event: 'room-task-review-changes-auto-start', taskId: current.id, jobId: started.job.id }),
        `task-review-changes-auto-start:v1:${accepted.id}`,
      ).lastInsertRowid);
      return { task: started.task, job: started.job, factId };
    });
    let out: { task: RoomTaskRow; job: JobRow; factId: number };
    try {
      out = this.jobs.transactionWithDeferredEvents(tx);
    } catch (error) {
      const reason = (error instanceof AutoStartRollback
        ? error.failure.error
        : (error instanceof Error ? error.message : String(error))).slice(0, 500);
      if (error instanceof AutoStartRollback) {
        this.recordCapabilityRejectFromFailure(taskId, reviewer, reviewModule, error.failure);
      }
      try {
        const passed = this.passInternal(this.requireTask(taskId), 'execute', reviewer,
          'review REQUEST_CHANGES auto-pass to execute', 'review-auto-pass');
        this.event(taskId, 'review-changes-auto-start-fallback', reviewer, { reason }, reviewModule);
        return { toModule: 'execute', queued: passed.queued, fallbackReason: reason };
      } catch (error2) {
        this.event(taskId, 'auto-pass-failed', reviewer, {
          toModule: 'execute', reason: (error2 instanceof Error ? error2.message : String(error2)).slice(0, 500),
        }, reviewModule);
        return { toModule: 'execute', queued: false, fallbackReason: reason };
      }
    }
    try { this.dispatch?.publishFact?.(out.factId); } catch { /* reconnect reloads the fact */ }
    return { toModule: 'execute', queued: false, jobId: out.job.id };
  }

  /**
   * Q2: open-room review APPROVE starts the merge closure in the same flow:
   * baton to merge (deferred delivery = no chat wake) plus a merge closure
   * job built from the frozen merge-module snapshot — equivalent to the merge
   * seat calling `release_execute kind=merge return_to_module=review
   * return_mode=handoff`. Only a system fact is posted to the room.
   *
   * Missing merge binding or any gate refusal falls back to the classic
   * merge-seat wake with a `release-auto-start-fallback` reason event; the
   * task is never blocked on that account. Like the old auto-pass, a direct
   * start never fails the review_submit call itself.
   */
  private reviewAutoReleaseToMerge(taskId: string, reviewer: string, reviewModule: string): {
    toModule: 'merge'; queued: boolean; jobId?: string; existing?: boolean; fallbackReason?: string;
  } {
    const note = 'review APPROVE auto-pass to merge (direct release, no merge chat wake)';
    const tx = this.db.transaction(() => {
      const current = this.requireTask(taskId);
      if (['closed', 'dropped', 'blocked'].includes(current.status)) {
        throw new AutoStartRollback(fail(`任务已 ${current.status}，不再自动合入`, 409));
      }
      const passed = this.passInternal(current, 'merge', reviewer, note, 'review-auto-pass', { deferDelivery: true });
      if (passed.queued) {
        throw new AutoStartRollback(fail('任务已有在途执行；交棒已登记为 next，本次未直启', 409));
      }
      const passKey = `pass:v1:${current.id}:${current.revision}:merge`;
      const accepted = this.db.prepare('SELECT * FROM room_task_handoffs WHERE idempotency_key = ?').get(passKey) as RoomTaskHandoffRow | undefined;
      if (!accepted) throw new AutoStartRollback(fail('交棒落账缺失；先核对账本', 409));
      const mergeBinding = this.currentBindingContact('merge');
      if ('error' in mergeBinding) throw new AutoStartRollback(mergeBinding);
      const started = this.startMergeClosureRelease({
        task: passed.task,
        accepted,
        actor: mergeBinding.contactId,
        initiatedBy: reviewer,
        returnToModule: 'review',
        returnMode: 'handoff',
        mode: 'auto',
      });
      if ('error' in started) throw new AutoStartRollback(started);
      // Idempotent replay (same candidate): the baton move above still
      // commits, but no second job and no second fact — mirrors P2's
      // duplicate delivery. Fresh starts post one fact keyed by THIS pass
      // (passId, never the job id: a replayed job id would collide with the
      // first fact's UNIQUE key and roll the whole start back).
      if (started.existing) {
        return { task: started.task, job: started.job, factId: null, existing: true };
      }
      const factId = Number(this.db.prepare(`INSERT INTO messages
        (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
        VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main', ?)`).run(
        current.room_id,
        `【合入直接启动】${current.task_path}：${reviewer} APPROVE 后网关已直接为 merge（${mergeBinding.contactId}）启动合入 job ${started.job.id}；完成回 review；不唤醒 merge 席聊天轮次。`,
        JSON.stringify({ event: 'room-task-release-auto-start', taskId: current.id, jobId: started.job.id }),
        `task-release-auto-start:v1:${accepted.id}`,
      ).lastInsertRowid);
      return { task: started.task, job: started.job, factId, existing: started.existing };
    });
    let out: { task: RoomTaskRow; job: JobRow; factId: number | null; existing?: boolean };
    try {
      out = this.jobs.transactionWithDeferredEvents(tx);
    } catch (error) {
      const reason = (error instanceof AutoStartRollback
        ? error.failure.error
        : (error instanceof Error ? error.message : String(error))).slice(0, 500);
      try {
        const passed = this.passInternal(this.requireTask(taskId), 'merge', reviewer,
          'review APPROVE auto-pass to merge', 'review-auto-pass');
        this.event(taskId, 'release-auto-start-fallback', reviewer, { reason }, reviewModule);
        return { toModule: 'merge', queued: passed.queued, fallbackReason: reason };
      } catch (error2) {
        this.event(taskId, 'auto-pass-failed', reviewer, {
          toModule: 'merge', reason: (error2 instanceof Error ? error2.message : String(error2)).slice(0, 500),
        }, reviewModule);
        return { toModule: 'merge', queued: false, fallbackReason: reason };
      }
    }
    try { if (out.factId) this.dispatch?.publishFact?.(out.factId); } catch { /* reconnect reloads the fact */ }
    return { toModule: 'merge', queued: false, jobId: out.job.id, ...(out.existing ? { existing: true } : {}) };
  }

  // ── release ────────────────────────────────────────────────────────

  /**
   * R2-D: read the pinning APPROVE's structured patch sha (event payload only,
   * never evidence prose). Null when the APPROVE carries no patch.
   */
  private approvePatchRecord(task: RoomTaskRow): { sha256: string; evidenceId: number } | null {
    try {
      if (task.review_evidence_id === null) return null;
      const row = this.db.prepare(
        `SELECT payload FROM room_task_events WHERE task_id = ? AND kind = 'review-approved'
         AND json_extract(payload, '$.evidenceId') = ? ORDER BY id DESC LIMIT 1`,
      ).get(task.id, task.review_evidence_id) as { payload: string } | undefined;
      if (!row) return null;
      const payload = parseJson(row.payload);
      const patch = record(payload.patch);
      const sha = String(patch.sha256 ?? '').toLowerCase();
      const evidenceId = Number((payload as { patchEvidenceId?: unknown }).patchEvidenceId);
      if (!REVIEW_PATCH_SHA256_RE.test(sha)) return null;
      if (!Number.isSafeInteger(evidenceId) || evidenceId <= 0) return null;
      return { sha256: sha, evidenceId };
    } catch {
      return null;
    }
  }

  private approvePatchSha(task: RoomTaskRow): string | null {
    return this.approvePatchRecord(task)?.sha256 ?? null;
  }

  /**
   * R2-D: build the merge-script patch args from the pinning APPROVE. Returns
   * null when the APPROVE carries no patch; returns a StoreError when it does
   * but the review-patch evidence is missing or disagrees (callers fail closed).
   */
  private reviewPatchInput(task: RoomTaskRow): { b64: string; sha256: string } | null | StoreError {
    const rec = this.approvePatchRecord(task);
    if (!rec) return null;
    try {
      const ev = this.db.prepare(
        'SELECT body FROM room_task_evidence WHERE id = ? AND task_id = ?',
      ).get(rec.evidenceId, task.id) as { body: string } | undefined;
      if (!ev || typeof ev.body !== 'string' || !ev.body) {
        return fail('评审补丁证据缺失；重审后再发布', 409);
      }
      if (sha256(ev.body) !== rec.sha256) {
        return fail('评审补丁证据与批准记录不一致；重审后再发布', 409);
      }
      return { b64: Buffer.from(ev.body, 'utf8').toString('base64'), sha256: rec.sha256 };
    } catch (error) {
      if (error && typeof error === 'object' && 'error' in (error as Record<string, unknown>)) {
        return error as StoreError;
      }
      return fail('评审补丁证据读取失败；重审后再发布', 409);
    }
  }

  private mergeGates(candidate: JobRow, pinned: string): StoreError | {
    branch: string;
    frozenSha: string;
    baselineSha: string;
  } {
    const receipt = structuredReceiptFields(candidate);
    const before = record(deliveryMeta(candidate).before);
    if (!receipt.branch || !safeBranch(receipt.branch) || ['master', 'main'].includes(receipt.branch)) {
      return fail('候选分支缺失、不安全或直接就是主分支', 409);
    }
    if (!receipt.head || receipt.head.toLowerCase() !== pinned) {
      return fail('候选 SHA 已变化；重审后再发布', 409);
    }
    const baselineSha = String(before.head ?? '').toLowerCase();
    if (!SHA40_RE.test(baselineSha)) return fail('候选缺少 baseline SHA 证据', 409);
    if (!receipt.diffstat || !receipt.changedFiles || !receipt.tests || receipt.tests.length === 0) {
      return fail('候选结构化回执不完整（diffstat/changedFiles/非空 tests）', 409);
    }
    if (receipt.tests.some((item) => item.status !== 'pass')) {
      return fail('候选报告了未通过的测试', 409);
    }
    return { branch: receipt.branch, frozenSha: pinned, baselineSha };
  }

  /**
   * W0: natural-key-first release dedupe. The caller-supplied idempotency key
   * only distinguishes network retries of the SAME call; it must never bypass
   * the (task, kind, sha) natural key `release:v1:<task>:<kind>:<sha>`. A prior
   * release for the same natural key is returned as-is unless every matching
   * row terminally failed (failed / cancelled), in which case the caller may
   * retry with a fresh row. Different SHA or different kind never collides by
   * construction, so legitimate publishes are never swallowed.
   */
  private findNaturalRelease(taskId: string, kind: 'merge' | 'deploy', sha: string): JobRow | undefined {
    const natural = `release:v1:${taskId}:${kind}:${sha.toLowerCase()}`;
    const candidates: JobRow[] = [];
    const byKey = this.jobs.getByIdempotencyKey(natural);
    if (byKey) {
      const linked = this.db.prepare(
        'SELECT 1 FROM room_task_links WHERE job_id = ? AND task_id = ?',
      ).get(byKey.id, taskId);
      if (linked) candidates.push(byKey);
    }
    // Releases created with a caller-supplied key carry the natural key in
    // options.releaseNaturalKey (and are linked at creation), so a second
    // caller key for the same (task, kind, sha) still hits the same release.
    for (const job of this.linkedJobs(taskId)) {
      if (job.id === byKey?.id) continue;
      if (parseJson(job.options).releaseNaturalKey === natural) candidates.push(job);
    }
    // linkedJobs is oldest-first: prefer the latest live release. Only when
    // every match failed/cancelled is a fresh row allowed.
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      if (candidates[i].status !== 'failed' && candidates[i].status !== 'cancelled') {
        return candidates[i];
      }
    }
    return undefined;
  }

  /**
   * W0: resolve the stored idempotency key for a release. No usable prior
   * release exists on entry (callers check findNaturalRelease first). The
   * caller key (network-retry scope) is stored when present; otherwise the
   * natural key is stored — suffixed when a failed/cancelled prior row still
   * occupies it, so the retry can insert a fresh row instead of hitting the
   * UNIQUE constraint and replaying the dead row.
   */
  private resolveReleaseKey(
    taskId: string,
    kind: 'merge' | 'deploy',
    sha: string,
    callerKey: string | undefined,
  ): { naturalKey: string; releaseKey: string } {
    const naturalKey = `release:v1:${taskId}:${kind}:${sha.toLowerCase()}`;
    const clean = text(callerKey, 200);
    if (clean) return { naturalKey, releaseKey: clean };
    const occupies = this.jobs.getByIdempotencyKey(naturalKey);
    if (occupies) return { naturalKey, releaseKey: `${naturalKey}:retry:${crypto.randomUUID().slice(0, 8)}` };
    return { naturalKey, releaseKey: naturalKey };
  }

  /**
   * Q2 (cost batch 2): shared merge-closure starter. BOTH the explicit
   * `release_execute kind=merge` (merge seat) and the open-room review
   * APPROVE direct path run through this exact function — same mergeGates,
   * baseline/frozen SHA checks, ReleaseEvidence assembly, idempotency key,
   * write lease and frozen merge-snapshot permissions. No gate logic is
   * duplicated at the call sites.
   *
   * Ledger statements are plain (no transaction of their own): the explicit
   * caller wraps them like before, the review auto path wraps them together
   * with its passInternal baton move. `mode` only changes audit wording
   * (prompt header + event kind + dispatchSource stays 'explicit-release' so
   * the Worker still runs the closure directly).
   */
  private startMergeClosureRelease(input: {
    task: RoomTaskRow;
    accepted: RoomTaskHandoffRow;
    actor: string;
    initiatedBy?: string;
    returnToModule: string;
    returnMode?: string;
    evidenceRefs?: string[];
    releaseKey?: string;
    /** Manual caller only: task revision guard, checked at the original
     * position (after the idempotency replay, before the write lease). The
     * review auto path omits it and serializes inside a single tx instead. */
    expectedRevision?: number;
    mode: 'explicit' | 'auto';
  }): { job: JobRow; task: RoomTaskRow; existing?: boolean } | StoreError {
    const task0 = input.task;
    const accepted = input.accepted;
    const actor = input.actor.trim();
    if (!actor) return fail('发起人必填', 400);
    const snapshot = this.parseSnapshot(accepted);
    if ('error' in snapshot) return snapshot;
    if (snapshot.binding.contactId !== actor) return fail('交接快照的接收人与发起人不一致', 403);
    if (task0.review_status !== 'approved' || !task0.candidate_sha || !task0.candidate_job_id || task0.review_evidence_id === null) {
      return fail('任务没有已批准的候选版本；先走 review_submit 拿到 APPROVE', 409);
    }
    const pinned = task0.candidate_sha.toLowerCase();
    const candidate = this.jobs.get(task0.candidate_job_id);
    if (!candidate) return fail('候选 job 已不在队列记录中', 404);
    // The reviewed candidate must be unchanged since approval.
    const candidateHead = (structuredReceiptFields(candidate).head ?? '').toLowerCase();
    if (!candidateHead || candidateHead !== pinned) {
      return fail('候选版本在评审后已变化；重审后再发布', 409);
    }
    if (this.jobs.workflowModules.isFenced(candidate.id)) {
      return fail('候选尝试已被接管废弃；按当前在途尝试重审', 409);
    }
    const evidenceRefs = Array.isArray(input.evidenceRefs)
      ? input.evidenceRefs.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 50)
      : [];
    const dangling = this.validateEvidenceRefs(task0.id, evidenceRefs);
    if (dangling) return dangling;
    // M7: task-wide operation lease + idempotency, so a release never
    // overlaps an in-flight writer and repeats never duplicate. The natural
    // key (task, kind, sha) is checked first: a caller-supplied key only
    // covers network retries of the same call and can never mint a second
    // release for an already-published candidate (W0).
    const priorNatural = this.findNaturalRelease(task0.id, 'merge', pinned);
    if (priorNatural) return { job: priorNatural, task: task0, existing: true };
    const { naturalKey, releaseKey } = this.resolveReleaseKey(task0.id, 'merge', pinned, input.releaseKey);
    if (input.expectedRevision !== undefined) {
      const expectedRevision = Number(input.expectedRevision);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
        return fail('expected_revision 必填（任务 revision 守卫）', 400);
      }
      if (expectedRevision !== task0.revision) {
        return fail(`任务 revision 已变化（期望 ${expectedRevision}，当前 ${task0.revision}）；先 task_get 再试`, 409);
      }
    }
    const activeWriter = this.activeLinkedJobs(task0.id).find((job) => {
      try {
        return (JSON.parse(job.permissions || '{}') as { write?: unknown }).write === true;
      } catch {
        return false;
      }
    });
    if (activeWriter) {
      return fail(`任务已有在途写操作 ${activeWriter.id}（${activeWriter.status}）；发布必须等写租约释放`, 409);
    }
    if (!isModuleId(input.returnToModule)) return fail(`return_to_module 未知：${input.returnToModule}`, 400);
    if (input.returnMode !== undefined && !['handoff', 'notify'].includes(input.returnMode)) return fail('return_mode 必须是 handoff | notify', 400);
    const returnTarget = this.resolveReturnTarget(task0, input.returnToModule as WorkflowModuleId);
    if ('error' in returnTarget) return returnTarget;
    const invocation: ModuleInvocation = {
      moduleId: 'merge',
      policyVersion: WORKFLOW_MODULE_POLICY_VERSION,
      bindingRevision: snapshot.revision,
      binding: { ...snapshot.binding },
      permissions: { ...snapshot.permissions },
      selected: { ...snapshot.binding },
      escalateToHuman: false,
      arbitrationActive: false,
      taskPath: task0.task_path,
      problemFingerprint: '',
    };
    const gates = this.mergeGates(candidate, pinned);
    if ('error' in gates) return gates;
    // R2-D: Q2 direct path and manual release_execute share this starter, so a
    // pinning APPROVE with a patch flows into the closure command here for both.
    const patchInput = this.reviewPatchInput(task0);
    if (patchInput && 'error' in patchInput) return patchInput;
    const releaseEvidence = {
      roomId: task0.room_id,
      taskPath: task0.task_path,
      candidateSha: pinned,
      reviewStatus: task0.review_status ?? '',
      reviewEvidenceId: task0.review_evidence_id,
    };
    // A candidate that ran against a frozen VPS target carries its repo in
    // options.projectTarget; its workspace IS the repo checkout
    // (<root>/<task>/<attempt>/<repoId>). The merge gate needs both, or it
    // validates the wrong repo's suites.
    const frozenRepo = record(parseJson(candidate.options).projectTarget);
    const mergeRepo = typeof frozenRepo.repoId === 'string' && frozenRepo.repoId
      ? { repoId: frozenRepo.repoId, repoDir: candidate.workspace }
      : null;
    // R3: without a frozen target the scripts resolve the checkout's own
    // .ai-hub-merge.json from the candidate workspace (directory only, never
    // --repo); checkouts without a manifest keep the ai-hub default.
    const closureCommand = buildMergeClosureCommand({
      taskPath: task0.task_path,
      branch: gates.branch,
      frozenSha: gates.frozenSha,
      baselineSha: gates.baselineSha,
      releaseEvidence,
      repo: mergeRepo,
      repoDir: mergeRepo ? null : candidate.workspace,
      autoRebase: this.isOpenGovernance(task0.room_id),
      reviewPatch: patchInput && !('error' in patchInput) ? patchInput : null,
    });
    const prompt = [
      input.mode === 'auto'
        ? `【auto release merge】review APPROVE 后网关直接启动：merge ${actor}（handoff ${accepted.id}，binding rev ${snapshot.revision}，发起评审 ${input.initiatedBy ?? 'unknown'}）；未唤醒 merge 席聊天轮次。`
        : `【explicit release merge】由 ${actor}（merge，handoff ${accepted.id}，binding rev ${snapshot.revision}）显式发起；非自动链路。`,
      `task_id=${task0.id} evidenceRefs=${evidenceRefs.join(',')}`,
      '',
      buildMergeClosurePrompt({
        parentJobId: candidate.id,
        reviewJobId: `review-evidence:${task0.review_evidence_id}`,
        taskPath: task0.task_path,
        roomId: task0.room_id,
        branch: gates.branch,
        frozenSha: gates.frozenSha,
        baselineSha: gates.baselineSha,
        releaseEvidence,
        repo: mergeRepo,
        repoDir: mergeRepo ? null : candidate.workspace,
      }),
    ].join('\n');
    const created = this.jobs.create({
      requestedBy: actor,
      runner: snapshot.binding.runner,
      workspace: candidate.workspace,
      prompt,
      priority: candidate.priority,
      permissions: { ...snapshot.permissions },
      trustedInvocation: invocation,
      idempotencyKey: releaseKey,
      options: {
        model: snapshot.binding.model,
        reasoning: snapshot.binding.reasoning,
        routeClass: 'mechanical',
        runnerSource: 'policy',
        problemFingerprint: '',
        taskPath: task0.task_path,
        parentJobId: candidate.id,
        closureKind: 'merge',
        frozenSha: gates.frozenSha,
        baselineSha: gates.baselineSha,
        dispatchSource: 'explicit-release',
        releaseNaturalKey: naturalKey,
        closureCommand,
      },
      originContactId: task0.room_id,
      originAnchorId: task0.anchor_message_id,
    });
    if ('error' in created) {
      const replay = this.jobs.getByIdempotencyKey(releaseKey)
        ?? this.findNaturalRelease(task0.id, 'merge', pinned);
      if (replay) return { job: replay, task: task0, existing: true };
      return fail(`创建合并任务失败：${created.error}`, 409);
    }
    if (created.merged) return fail(`合并任务被并入在途 job ${created.job.id}`, 409);
    this.stampTaskJob(created.job.id, task0, actor, {
      roomTaskRevision: task0.revision,
      roomTaskReturn: input.returnToModule,
      handoffId: accepted.id,
    });
    this.addEvidence(task0.id, 'note', created.job.id, `合并启动：${created.job.id}（frozen=${gates.frozenSha.slice(0, 12)}）`, actor);
    this.insertCallback(task0, created.job.id, input.returnToModule as WorkflowModuleId, returnTarget, actor, input.returnMode !== 'notify');
    const bumped = this.bump(task0.id, { status: 'in_review' });
    const tc = this.toolContext;
    const mergeTurnId = tc && typeof tc.turnId === 'string' ? tc.turnId : undefined;
    this.event(task0.id, input.mode === 'auto' ? 'release-auto-started' : 'release-started', actor,
      {
        kind: 'merge', jobId: created.job.id, frozenSha: gates.frozenSha,
        ...(mergeTurnId ? { turnId: mergeTurnId } : {}),
        ...(input.mode === 'auto' && input.initiatedBy ? { initiatedBy: input.initiatedBy } : {}),
      }, 'merge');
    return { job: this.jobs.get(created.job.id)!, task: bumped };
  }

  releaseExecute(input: {
    roomId: string;
    taskPath: string;
    actorContact: string;
    kind: string;
    returnToModule: string;
    returnMode?: string;
    expectedRevision: number;
    idempotencyKey?: string;
    evidenceRefs?: string[];
  }): { job: JobRow; task: RoomTaskRow; existing?: boolean } | StoreError {
    this.ensureSchema();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const roomMismatch = this.checkRoom(tc, input.roomId.trim());
    if (roomMismatch) return roomMismatch;
    const task0 = this.getTask(input.roomId.trim(), input.taskPath.trim());
    if (!task0) return fail('任务不存在', 404);
    const taskMismatch = this.checkTask(tc, task0);
    if (taskMismatch) return taskMismatch;
    const actor = input.actorContact.trim();
    if (!this.isParticipant(task0.room_id, actor)) return fail('只有本会议室成员可以发起发布', 403);
    const turnGate = this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    if (['closed', 'dropped'].includes(task0.status)) return fail(`任务已 ${task0.status}，不能再发布`, 409);
    if (!['merge', 'deploy'].includes(input.kind)) return fail('kind 必须是 merge 或 deploy', 400);
    const kind = input.kind as 'merge' | 'deploy';
    const moduleId: WorkflowModuleId = kind;
    if (!isModuleId(input.returnToModule)) return fail(`return_to_module 未知：${input.returnToModule}`, 400);
    if (input.returnMode !== undefined && !['handoff', 'notify'].includes(input.returnMode)) return fail('return_mode 必须是 handoff | notify', 400);
    // Correct role + accepted handoff + current ownership + turn hat: the
    // same contact holding another binding cannot cross-invoke here
    // (plan-hat deploy is rejected even with an older deploy handoff).
    if (moduleId !== tc.moduleId) {
      return fail(`本轮次是 ${tc.moduleId} 身份，不得以 ${moduleId} 名义发起发布`, 403);
    }
    if (task0.owner_module !== moduleId || task0.owner_contact !== actor) {
      return fail(`当前负责人是 ${task0.owner_module}（${task0.owner_contact}）；${kind} 需先拿到该模块的显式交接受理`, 403);
    }
    let accepted: RoomTaskHandoffRow | undefined;
    if (tc.handoffId) {
      const pinned = this.handoffRow(tc.handoffId);
      if (!pinned || pinned.task_id !== task0.id) return fail('本轮次交接已不在该任务上', 410);
      if (pinned.status !== 'accepted') return fail(`本轮次交接已 ${pinned.status}`, 409);
      if (pinned.to_module !== moduleId || pinned.to_contact !== actor) {
        return fail('本轮次交接与发布模块/发起人不一致', 403);
      }
      accepted = pinned;
    } else {
      accepted = this.latestAcceptedHandoff(task0.id, moduleId, actor);
    }
    if (!accepted) return fail(`没有已接受的 ${kind} 交接授权；先 task_handoff/task_accept`, 403);
    const snapshot = this.parseSnapshot(accepted);
    if ('error' in snapshot) return snapshot;
    if (snapshot.binding.contactId !== actor) return fail('交接快照的接收人与你不一致', 403);
    const binding = this.currentBindingContact(moduleId);
    if ('error' in binding) return binding;
    if (binding.contactId !== actor) {
      return fail(`模块 ${moduleId} 当前绑定 ${binding.contactId}；只有绑定者可以发起 ${kind}`, 403);
    }
    if (task0.review_status !== 'approved' || !task0.candidate_sha || !task0.candidate_job_id || task0.review_evidence_id === null) {
      return fail('任务没有已批准的候选版本；先走 review_submit 拿到 APPROVE', 409);
    }
    const pinned = task0.candidate_sha.toLowerCase();
    const candidate = this.jobs.get(task0.candidate_job_id);
    if (!candidate) return fail('候选 job 已不在队列记录中', 404);
    // The reviewed candidate must be unchanged since approval.
    const candidateHead = (structuredReceiptFields(candidate).head ?? '').toLowerCase();
    if (!candidateHead || candidateHead !== pinned) {
      return fail('候选版本在评审后已变化；重审后再发布', 409);
    }
    if (this.jobs.workflowModules.isFenced(candidate.id)) {
      return fail('候选尝试已被接管废弃；按当前在途尝试重审', 409);
    }
    const evidenceRefs = Array.isArray(input.evidenceRefs)
      ? input.evidenceRefs.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 50)
      : [];
    const dangling = this.validateEvidenceRefs(task0.id, evidenceRefs);
    if (dangling) return dangling;
    // M7: task-wide operation lease + revision guard + idempotency, so a
    // release never overlaps an in-flight writer and repeats never duplicate.
    // Natural key first (W0): any caller key only scopes network retries.
    const priorNatural = this.findNaturalRelease(task0.id, kind, pinned);
    if (priorNatural) return { job: priorNatural, task: task0, existing: true };
    const { releaseKey } = this.resolveReleaseKey(task0.id, kind, pinned, input.idempotencyKey);
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      return fail('expected_revision 必填（任务 revision 守卫）', 400);
    }
    if (expectedRevision !== task0.revision) {
      return fail(`任务 revision 已变化（期望 ${expectedRevision}，当前 ${task0.revision}）；先 task_get 再试`, 409);
    }
    const activeWriter = this.activeLinkedJobs(task0.id).find((job) => {
      try {
        return (JSON.parse(job.permissions || '{}') as { write?: unknown }).write === true;
      } catch {
        return false;
      }
    });
    if (activeWriter) {
      return fail(`任务已有在途写操作 ${activeWriter.id}（${activeWriter.status}）；发布必须等写租约释放`, 409);
    }
    const returnTarget = this.resolveReturnTarget(task0, input.returnToModule as WorkflowModuleId);
    if ('error' in returnTarget) return returnTarget;
    if (kind === 'merge') {
      // Same shared starter as the review-APPROVE direct path (Q2): identical
      // gates, evidence, idempotency, revision guard, lease and frozen merge
      // snapshot. The whole start commits atomically (previously only the
      // ledger tail did).
      const started = this.db.transaction(() => this.startMergeClosureRelease({
        task: task0,
        accepted,
        actor,
        returnToModule: input.returnToModule,
        returnMode: input.returnMode,
        evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs as string[] : undefined,
        releaseKey: typeof input.idempotencyKey === 'string' ? input.idempotencyKey : undefined,
        expectedRevision: input.expectedRevision,
        mode: 'explicit',
      }))();
      if ('error' in started) return started;
      return { job: started.job, task: started.task, ...(started.existing ? { existing: true as const } : {}) };
    }
    // deploy: same shared starter as the merge-done direct path.
    const started = this.db.transaction(() => this.startDeployClosureRelease({
      task: task0,
      accepted,
      actor,
      returnToModule: input.returnToModule,
      returnMode: input.returnMode,
      evidenceRefs,
      releaseKey,
      mode: 'explicit',
    }))();
    if ('error' in started) return started;
    return { job: started.job, task: started.task, ...(started.existing ? { existing: true as const } : {}) };
  }

  /**
   * Shared deploy-closure starter: explicit `release_execute kind=deploy`
   * and the open-room merge-done direct path (after_merge='deploy') both run
   * through here — same merge-proof gates, deploy command, idempotency key and
   * frozen deploy-module snapshot. Plain statements; callers wrap the tx.
   * The deployed SHA is what the merge actually pushed (mergedHeadOf): the
   * approved candidate itself, or its clean identical rebase.
   */
  private startDeployClosureRelease(input: {
    task: RoomTaskRow;
    accepted: RoomTaskHandoffRow;
    actor: string;
    initiatedBy?: string;
    returnToModule: string;
    returnMode?: string;
    evidenceRefs?: string[];
    releaseKey?: string;
    mode: 'explicit' | 'auto';
  }): { job: JobRow; task: RoomTaskRow; existing?: boolean } | StoreError {
    const task0 = input.task;
    const accepted = input.accepted;
    const actor = input.actor.trim();
    const snapshot = this.parseSnapshot(accepted);
    if ('error' in snapshot) return snapshot;
    if (snapshot.binding.contactId !== actor) return fail('交接快照的接收人与发起人不一致', 403);
    if (task0.review_status !== 'approved' || !task0.candidate_sha || !task0.candidate_job_id || task0.review_evidence_id === null) {
      return fail('任务没有已批准的候选版本；先走 review_submit 拿到 APPROVE', 409);
    }
    const pinned = task0.candidate_sha.toLowerCase();
    const candidate = this.jobs.get(task0.candidate_job_id);
    if (!candidate) return fail('候选 job 已不在队列记录中', 404);
    const evidenceRefs = input.evidenceRefs ?? [];
    // W0: natural key first — a caller key never mints a second deploy for an
    // already-published SHA (double drain + double gateway restart).
    const priorNatural = this.findNaturalRelease(task0.id, 'deploy', pinned);
    if (priorNatural) return { job: priorNatural, task: task0, existing: true };
    const { naturalKey, releaseKey } = this.resolveReleaseKey(task0.id, 'deploy', pinned, input.releaseKey);
    if (!isModuleId(input.returnToModule)) return fail(`return_to_module 未知：${input.returnToModule}`, 400);
    const returnTarget = this.resolveReturnTarget(task0, input.returnToModule as WorkflowModuleId);
    if ('error' in returnTarget) return returnTarget;
    const invocation: ModuleInvocation = {
      moduleId: 'deploy',
      policyVersion: WORKFLOW_MODULE_POLICY_VERSION,
      bindingRevision: snapshot.revision,
      binding: { ...snapshot.binding },
      permissions: { ...snapshot.permissions },
      selected: { ...snapshot.binding },
      escalateToHuman: false,
      arbitrationActive: false,
      taskPath: task0.task_path,
      problemFingerprint: '',
    };
    const mergeJobs = this.linkedJobs(task0.id).filter((job) => {
      const options = parseJson(job.options);
      const expectedPatch = this.approvePatchSha(task0);
      return options.closureKind === 'merge'
        && job.status === 'done'
        // The pinned candidate, its clean rebase, or its review-patched head
        // as reported by the script; proof gaps are itemized below, not
        // hidden as "no merge".
        && ((structuredReceiptFields(job).head ?? '').toLowerCase() === pinned
          || mergedHeadOf(scriptReportOf(job), pinned, expectedPatch) !== null);
    });
    const merge = mergeJobs[mergeJobs.length - 1];
    if (!merge) return fail('找不到该候选版本的已完成合并任务；先走 merge 发布', 409);
    if (this.jobs.workflowModules.isFenced(merge.id)) {
      return fail('合并尝试已被接管废弃；按当前状态重新推进', 409);
    }
    const mergeReceipt = structuredReceiptFields(merge);
    const declared = record(deliveryMeta(merge).declared);
    const expectedPatchForDeploy = this.approvePatchSha(task0);
    const scriptReport = scriptReportOf(merge);
    const branchProofOk = mergeTargetBranchOk(merge.result, mergeReceipt.branch, pinned, scriptReport, expectedPatchForDeploy);
    const tests = mergeReceipt.tests;
    const hasTests = Array.isArray(tests) && tests.length > 0;
    const allPass = hasTests && tests!.every((item) => item.status === 'pass');
    // WP-C: deterministic closure rows carry receipt.scriptReport; push-only
    // merge jobs have no round diff, so diffstat/changedFiles are required
    // only on the legacy (no-scriptReport) path. Candidate diff was already
    // proven by mergeGates at merge release time.
    const needsLegacyDiff = !scriptReport;
    const missing: string[] = [];
    if (merge.delivery_state !== 'delivered') missing.push('delivery_state=delivered');
    if (String(declared.stage ?? '').toLowerCase().replace(/-/g, '_') !== 'delivered_waiting_deploy') {
      missing.push('declared.stage=delivered_waiting_deploy');
    }
    if (declared.committed !== true) missing.push('declared.committed=true');
    if (declared.pushed !== true) missing.push('declared.pushed=true');
    if (!branchProofOk) {
      const actual = scriptReport
        ? String((scriptReport as Record<string, unknown>).head ?? '').toLowerCase() || '(empty)'
        : (mergeReceipt.branch ?? '(empty)');
      missing.push(scriptReport
        ? `scriptReport.head≠frozen(实际 ${actual}) 或 lane/branch 不符`
        : 'mergeTargetBranchOk=false（receipt branch≠master 且 result 无 lane=merge 成功报告）');
    }
    if (needsLegacyDiff && !mergeReceipt.diffstat) missing.push('receipt.diffstat');
    if (needsLegacyDiff && !mergeReceipt.changedFiles) missing.push('receipt.changedFiles');
    if (!hasTests) missing.push('receipt.tests 非空');
    else if (!allPass) missing.push('receipt.tests 全 pass');
    if (!hasRequiredMergeTests(merge)) {
      const have = new Set((tests ?? []).filter((t) => t.status === 'pass').map((t) => t.suite.toLowerCase()));
      const required = [
        'server npm run pretest', 'server npm test', 'web npm test',
        'smoke:deploy-drain', 'smoke:turn-timeouts', 'smoke:deploy-resume',
      ];
      for (const suite of required) {
        if (!have.has(suite)) missing.push(`tests 缺 ${suite}`);
      }
    }
    if (missing.length > 0) {
      return fail(
        `合并回执缺：${missing.join('；')}。远端核对命令：git ls-remote origin refs/heads/master`,
        409,
      );
    }
    const deploySha = mergedHeadOf(scriptReport, pinned, expectedPatchForDeploy) ?? pinned;
    const deployClosureCommand = buildDeployClosureCommand({ frozenSha: deploySha });
    const prompt = [
      input.mode === 'auto'
        ? `【auto release deploy】合入完成后网关直接启动：deploy ${actor}（handoff ${accepted.id}，binding rev ${snapshot.revision}，发起 ${input.initiatedBy ?? 'unknown'}）；未唤醒 deploy 席聊天轮次。`
        : `【explicit release deploy】由 ${actor}（deploy，handoff ${accepted.id}，binding rev ${snapshot.revision}）显式发起；非自动链路。`,
      `task_id=${task0.id} evidenceRefs=${evidenceRefs.join(',')}`,
      '',
      buildDeployClosurePrompt({ mergeJobId: merge.id, parentJobId: candidate.id, taskPath: task0.task_path, frozenSha: deploySha }),
    ].join('\n');
    const created = this.jobs.create({
      requestedBy: actor,
      runner: snapshot.binding.runner,
      workspace: merge.workspace,
      prompt,
      priority: merge.priority,
      // The closure only runs the local room-deploy-job script over the hub's
      // HTTP deploy API; it never needs SSH. Inheriting the deploy module's
      // ssh=true left every VPS deploy pending: vps-dev advertises ssh=false
      // and claim silently skips the job (seen live 2026-09-24).
      permissions: { ...snapshot.permissions, ssh: false },
      trustedInvocation: invocation,
      idempotencyKey: releaseKey,
      options: {
        model: snapshot.binding.model,
        reasoning: snapshot.binding.reasoning,
        routeClass: 'mechanical',
        runnerSource: 'policy',
        problemFingerprint: '',
        taskPath: task0.task_path,
        parentJobId: candidate.id,
        closureKind: 'deploy',
        frozenSha: deploySha,
        dispatchSource: 'explicit-release',
        releaseNaturalKey: naturalKey,
        closureCommand: deployClosureCommand,
      },
      originContactId: task0.room_id,
      originAnchorId: task0.anchor_message_id,
    });
    if ('error' in created) {
      const replay = this.jobs.getByIdempotencyKey(releaseKey)
        ?? this.findNaturalRelease(task0.id, 'deploy', pinned);
      if (replay) return { job: replay, task: task0, existing: true };
      return fail(`创建部署任务失败：${created.error}`, 409);
    }
    if (created.merged) return fail(`部署任务被并入在途 job ${created.job.id}`, 409);
    this.stampTaskJob(created.job.id, task0, actor, {
      roomTaskRevision: task0.revision,
      roomTaskReturn: input.returnToModule,
      handoffId: accepted.id,
    });
    this.addEvidence(task0.id, 'note', created.job.id, `部署启动：${created.job.id}（sha=${deploySha.slice(0, 12)}）`, actor);
    this.insertCallback(task0, created.job.id, input.returnToModule as WorkflowModuleId, returnTarget, actor, input.returnMode !== 'notify');
    const bumped = this.bump(task0.id, { status: 'in_review' });
    const tc = this.toolContext;
    const deployTurnId = tc && typeof tc.turnId === 'string' ? tc.turnId : undefined;
    this.event(task0.id, input.mode === 'auto' ? 'release-auto-started' : 'release-started', actor, {
      kind: 'deploy', jobId: created.job.id, frozenSha: deploySha, mergeJobId: merge.id,
      ...(deploySha !== pinned ? { candidateSha: pinned } : {}),
      ...(deployTurnId ? { turnId: deployTurnId } : {}),
      ...(input.mode === 'auto' && input.initiatedBy ? { initiatedBy: input.initiatedBy } : {}),
    }, 'deploy');
    return { job: this.jobs.get(created.job.id)!, task: bumped };
  }

  private stampTaskJob(
    jobId: string,
    task: RoomTaskRow,
    attachedBy: string,
    extra: { roomTaskRevision?: number; roomTaskReturn?: string; handoffId?: string; handoffAutoStart?: boolean; initiatedBy?: string } = {},
  ): void {
    const job = this.jobs.get(jobId);
    if (job) {
      const options = parseJson(job.options);
      options.roomTaskId = task.id;
      if (extra.roomTaskRevision !== undefined) options.roomTaskRevision = extra.roomTaskRevision;
      if (extra.roomTaskReturn !== undefined) options.roomTaskReturn = extra.roomTaskReturn;
      if (extra.handoffId !== undefined) options.roomTaskHandoffId = extra.handoffId;
      if (extra.handoffAutoStart !== undefined) options.handoffAutoStart = extra.handoffAutoStart;
      if (extra.initiatedBy !== undefined) options.initiatedBy = extra.initiatedBy;
      this.db.prepare('UPDATE jobs SET options = ? WHERE id = ?').run(JSON.stringify(options), jobId);
    }
    this.db.prepare(
      'INSERT OR IGNORE INTO room_task_links (job_id, task_id, room_id, attached_by) VALUES (?, ?, ?, ?)',
    ).run(jobId, task.id, task.room_id, attachedBy);
  }

  // ── explicit callback registration (M4) ──────────────────────────────

  private callbackRow(jobId: string): RoomTaskCallbackRow | undefined {
    this.ensureSchema();
    try {
      return this.db.prepare('SELECT * FROM room_task_callbacks WHERE job_id = ?').get(jobId) as RoomTaskCallbackRow | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Freeze the explicit return target at start time: current return-module
   * binding contact + binding + narrowed permissions. Completion delivers
   * this exact snapshot even across rebind/restart; it is never re-resolved
   * live and never borrows the execution recipient.
   */
  private resolveReturnTarget(task: RoomTaskRow, returnModule: WorkflowModuleId)
    : { contactId: string; binding: ModuleBinding; revision: number } | StoreError {
    const bindings = this.jobs.workflowModules.bindings();
    const revision = this.jobs.workflowModules.revision();
    const binding = bindings[returnModule];
    if (!binding?.contactId) return fail(`return 模块 ${returnModule} 当前没有绑定联系人`, 409);
    const room = this.requireRoom(task.room_id);
    if ('error' in room) return room;
    if (!room.members.includes(binding.contactId)) {
      return fail(`return 模块 ${returnModule} 绑定的 ${binding.contactId} 不在本会议室；先明确可达的回调接收人`, 409);
    }
    return { contactId: binding.contactId, binding: { ...binding }, revision };
  }

  private insertCallback(
    task: RoomTaskRow,
    jobId: string,
    returnModule: WorkflowModuleId,
    target: { contactId: string; binding: ModuleBinding; revision: number },
    actor: string,
    handoffOnCompletion: boolean,
  ): void {
    const definition = moduleDefinition(returnModule);
    this.db.prepare(
      `INSERT OR REPLACE INTO room_task_callbacks
        (job_id, task_id, return_module, return_contact, return_revision, return_binding, return_permissions)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(jobId, task.id, returnModule, target.contactId, target.revision,
      JSON.stringify(target.binding), JSON.stringify(definition.permissions));
    this.event(task.id, 'callback-registered', actor, {
      jobId, returnModule, returnContact: target.contactId, returnRevision: target.revision,
      returnMode: handoffOnCompletion ? 'handoff' : 'notify',
    });
    if (handoffOnCompletion && (returnModule !== task.owner_module || target.contactId !== task.owner_contact)) {
      this.registerCompletionHandoff(task, jobId);
    }
  }

  private registerCompletionHandoff(task: RoomTaskRow, jobId: string): void {
    const last = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM room_task_events WHERE task_id = ?')
      .get(task.id) as { id: number };
    this.db.prepare(`INSERT INTO room_task_completion_handoffs
      (job_id, task_id, from_module, from_contact, after_event_id, origin_turn_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(jobId, task.id, task.owner_module, task.owner_contact,
        last.id, this.toolContext?.turnId ?? '');
  }

  // ── retry / takeover ───────────────────────────────────────────────

  retryDelivery(input: {
    roomId: string;
    taskPath?: string;
    handoffId?: string;
    jobId?: string;
    actorContact: string;
  }): { delivery: RoomTaskDispatchResult; handoff?: RoomTaskHandoffRow } | StoreError {
    this.ensureSchema();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const actor = input.actorContact.trim();
    if (input.handoffId || !input.jobId) {
      let handoff: RoomTaskHandoffRow | undefined;
      if (input.handoffId) {
        handoff = this.handoffRow(String(input.handoffId));
        if (!handoff) return fail('交接不存在', 404);
      } else {
        if (!input.taskPath) return fail('task_path 或 handoff_id 必填', 400);
        const task = this.getTask(input.roomId.trim(), input.taskPath.trim());
        if (!task) return fail('任务不存在', 404);
        handoff = this.activeHandoff(task);
        if (!handoff) return fail('当前没有待重发的交接', 409);
      }
      const task = this.requireTask(handoff.task_id);
      const roomMismatch = this.checkRoom(tc, task.room_id);
      if (roomMismatch) return roomMismatch;
      if (task.room_id !== input.roomId.trim()) return fail('交接不属于该会议室', 403);
      const taskMismatch = this.checkTask(tc, task);
      if (taskMismatch) return taskMismatch;
      if (!this.isParticipant(task.room_id, actor)) return fail('只有本会议室成员可以重发', 403);
      const turnGate = this.requireActiveTurn(tc, actor);
      if (turnGate) return turnGate;
      if (handoff.status === 'accepted') {
        const lastAccepted = this.db.prepare(`SELECT json_extract(payload, '$.handoffId') AS id
          FROM room_task_events WHERE task_id = ? AND kind = 'handoff-accepted' ORDER BY id DESC LIMIT 1`)
          .get(task.id) as { id: string } | undefined;
        // B1: pass-created rows (idempotency pass:v1:*) never emit
        // handoff-accepted; the baton itself is the authority, so only the
        // owner/active/terminal checks apply and the last-accept comparison
        // is skipped. This keeps a never-started auto-pass retryable.
        const isPassRow = typeof handoff.idempotency_key === 'string'
          && handoff.idempotency_key.startsWith('pass:v1:');
        if (task.owner_module !== handoff.to_module || task.owner_contact !== handoff.to_contact
          || task.active_handoff_id || ['closed', 'dropped'].includes(task.status)
          || (!isPassRow && lastAccepted?.id !== handoff.id)) {
          return fail('旧交接已不是当前负责人授权；不得重发或唤醒旧责任人', 409);
        }
        const status = taskDispatchLedgerStatus(this.db, `task-handoff:v1:${handoff.id}`);
        if (status === 'posted') return { delivery: { status: 'duplicate' }, handoff };
        if (status !== 'failed') return fail('已受理交接没有失败派发记录，无需重发', 409);
      } else if (handoff.status !== 'pending') {
        return fail(`交接已 ${handoff.status}，无需重发`, 409);
      }
      if (!this.dispatch) return fail('本网关未配置投递器；交接保持 pending', 503);
      // Same captured recipient only: never re-resolves or upgrades the target.
      let delivery: RoomTaskDispatchResult;
      try {
        delivery = this.dispatch.dispatchToModule(task.room_id, handoff.to_module, handoff.to_contact,
          this.handoffContent(task, handoff), `task-handoff:v1:${handoff.id}`,
          { taskId: task.id, handoffId: handoff.id });
      } catch (error) {
        delivery = { status: 'failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
      }
      this.event(task.id, delivery.status === 'failed' ? 'handoff-delivery-failed' : 'handoff-delivered', actor, {
        handoffId: handoff.id, retry: true, ...(delivery.reason ? { reason: delivery.reason } : {}),
        ...(typeof tc.turnId === 'string' ? { turnId: tc.turnId } : {}),
      });
      return { delivery, handoff };
    }
    const job = this.jobs.get(String(input.jobId));
    if (!job) return fail('job 不存在', 404);
    // Fence: a taken-over attempt's callback is dead. Explicit old-job
    // retries are rejected; only the replacement job's callback delivers.
    if (this.jobs.workflowModules.isFenced(job.id)) {
      return fail('该尝试已被接管废弃；旧回调已失效，请跟进接管后的新尝试', 409);
    }
    const options = parseJson(job.options);
    const taskId = typeof options.roomTaskId === 'string' ? options.roomTaskId : '';
    if (!taskId) return fail('该 job 不是任务执行（无显式回调授权）', 404);
    const task = this.requireTask(taskId);
    const roomMismatch = this.checkRoom(tc, task.room_id);
    if (roomMismatch) return roomMismatch;
    if (task.room_id !== input.roomId.trim()) return fail('job 不属于该会议室任务', 403);
    const taskMismatch = this.checkTask(tc, task);
    if (taskMismatch) return taskMismatch;
    if (!this.isParticipant(task.room_id, actor)) return fail('只有本会议室成员可以重试回调', 403);
    const turnGate = this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    // Successful delivery is never re-woken: duplicates report without wake.
    if (this.callbackDelivered(task.id, job.id)) {
      const intent = this.completionHandoff(job.id);
      return { delivery: { status: 'duplicate' }, ...(intent?.handoff_id ? { handoff: this.requireHandoff(intent.handoff_id) } : {}) };
    }
    // Retry delivers ONLY: state was already folded exactly once by the
    // idempotent finish path; never mutate here.
    const outcome = this.deliverCallback(task, job, actor);
    if ('error' in outcome) return outcome;
    const intent = this.completionHandoff(job.id);
    return { delivery: outcome.delivery, ...(intent?.handoff_id ? { handoff: this.requireHandoff(intent.handoff_id) } : {}) };
  }

  takeoverJob(input: {
    roomId: string;
    taskPath: string;
    actorContact: string;
    oldJobId: string;
  }): { job: JobRow; task: RoomTaskRow } | StoreError {
    this.ensureSchema();
    const tc = this.requireToolContext();
    if ('error' in tc) return tc;
    const roomMismatch = this.checkRoom(tc, input.roomId.trim());
    if (roomMismatch) return roomMismatch;
    const task0 = this.getTask(input.roomId.trim(), input.taskPath.trim());
    if (!task0) return fail('任务不存在', 404);
    const taskMismatch = this.checkTask(tc, task0);
    if (taskMismatch) return taskMismatch;
    const actor = input.actorContact.trim();
    if (!this.isParticipant(task0.room_id, actor)) return fail('只有本会议室成员可以接管', 403);
    const turnGate = this.requireActiveTurn(tc, actor);
    if (turnGate) return turnGate;
    // Explicit authorized takeover only: the current owner, wearing the owner
    // module's hat, names the exact attempt to fence. Stale callbacks from it
    // stay rejected.
    const ownerScope = this.requireOwnerScope(task0, actor, tc);
    if (ownerScope) return ownerScope;
    const linked = this.db.prepare(
      'SELECT 1 FROM room_task_links WHERE job_id = ? AND task_id = ?',
    ).get(String(input.oldJobId), task0.id);
    if (!linked) return fail('该 job 不属于本任务', 404);
    const outcome = this.jobs.takeover(String(input.oldJobId), actor);
    if ('error' in outcome) return fail(`接管失败：${outcome.error}`, outcome.code);
    this.stampTaskJob(outcome.job.id, task0, actor, {});
    const task = this.db.transaction(() => {
      this.addEvidence(task0.id, 'note', outcome.job.id, `显式接管：${input.oldJobId} → ${outcome.job.id}`, actor);
      // B3: the replacement attempt inherits the old attempt's explicit
      // callback registration (same task, same chosen return target). The old
      // job's per-job delivery events/ledger keys cannot affect the new job:
      // redelivery checks are keyed by the NEW job id.
      const priorCallback = this.callbackRow(String(input.oldJobId));
      if (priorCallback && priorCallback.task_id === task0.id && isModuleId(priorCallback.return_module)) {
        this.db.prepare(
          `INSERT OR REPLACE INTO room_task_callbacks
            (job_id, task_id, return_module, return_contact, return_revision, return_binding, return_permissions)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(outcome.job.id, task0.id, priorCallback.return_module, priorCallback.return_contact,
          priorCallback.return_revision, priorCallback.return_binding, priorCallback.return_permissions);
        this.event(task0.id, 'callback-registered', actor, {
          jobId: outcome.job.id, returnModule: priorCallback.return_module,
          returnContact: priorCallback.return_contact, viaTakeoverOf: String(input.oldJobId),
        });
        if (this.completionHandoff(String(input.oldJobId))) {
          this.registerCompletionHandoff(task0, outcome.job.id);
        }
      }
      const bumped = this.bump(task0.id, { status: 'in_progress' });
      this.event(task0.id, 'attempt-takeover', actor, { oldJobId: input.oldJobId, newJobId: outcome.job.id });
      return bumped;
    })();
    return { job: this.jobs.get(outcome.job.id)!, task };
  }

  // ── completion callback (fulfills the registered return mode only) ──

  private attemptRecorded(taskId: string, jobId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = 'attempt-finished' AND json_extract(payload, '$.jobId') = ? LIMIT 1`,
    ).get(taskId, jobId);
    return Boolean(row);
  }

  private callbackDelivered(taskId: string, jobId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = 'callback-delivered' AND json_extract(payload, '$.jobId') = ? LIMIT 1`,
    ).get(taskId, jobId);
    if (!row) return false;
    // B1: the event alone is not a permanent success override. An async
    // provider failure flips the dispatch ledger to failed AFTER the event
    // was written; only a posted ledger row counts as delivered.
    const intent = this.completionHandoff(jobId);
    const key = intent?.handoff_id ? `task-handoff:v1:${intent.handoff_id}` : `task-callback:v1:${jobId}`;
    return taskDispatchLedgerStatus(this.db, key) === 'posted';
  }

  private completionHandoff(jobId: string): CompletionHandoffRow | undefined {
    return this.db.prepare('SELECT * FROM room_task_completion_handoffs WHERE job_id = ?')
      .get(jobId) as CompletionHandoffRow | undefined;
  }

  /** Fulfill a start-time choice, never infer a recipient from the current graph. */
  private fulfillCompletionHandoff(task: RoomTaskRow, job: JobRow, cb: RoomTaskCallbackRow)
    : RoomTaskHandoffRow | StoreError | null {
    const intent = this.completionHandoff(job.id);
    // Historical notification callbacks are intentionally not reinterpreted.
    if (!intent || ['closed', 'dropped'].includes(task.status)) return null;
    if (intent.task_id !== task.id) return fail('完成交接登记不属于本任务', 409);
    if (intent.handoff_id) return this.requireHandoff(intent.handoff_id);
    return this.db.transaction(() => {
      const current = this.requireTask(task.id);
      if (current.owner_module !== intent.from_module || current.owner_contact !== intent.from_contact) {
        return fail('负责人已变化；旧完成交接不得覆盖后续决定', 409);
      }
      // Even an A -> B -> A round trip invalidates the old choice. New explicit
      // handoffs or waits take precedence over a previously scheduled return.
      const changed = this.db.prepare(`SELECT 1 FROM room_task_events WHERE task_id = ? AND id > ?
        AND kind IN ('handoff-created', 'handoff-accepted', 'handoff-declined', 'handoff-cancelled',
          'wait-registered', 'blocked-registered') LIMIT 1`).get(task.id, intent.after_event_id);
      if (changed || current.active_handoff_id) {
        return fail('完成交接登记后已有新的交接或等待决定；请负责人显式处理，旧回执不抢占责任', 409);
      }
      const id = crypto.randomUUID();
      const request = `读取 job ${job.id} 的完整回执并处理剩余验收项。先 task_accept/task_decline；接受后由你显式决定继续执行、交接或登记具体阻塞。阶段完成不等于任务完成。`;
      this.db.prepare(`INSERT INTO room_task_handoffs
        (id, task_id, idempotency_key, from_module, from_contact, to_module, to_contact, to_revision,
         to_binding, to_permissions, approved_workspace, request, evidence_refs, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(
          id, task.id, `completion-handoff:v1:${job.id}`, intent.from_module, intent.from_contact,
          cb.return_module, cb.return_contact, cb.return_revision, cb.return_binding, cb.return_permissions,
          current.approved_workspace, request, JSON.stringify([job.id]));
      this.db.prepare('UPDATE room_task_completion_handoffs SET handoff_id = ? WHERE job_id = ?').run(id, job.id);
      this.db.prepare('UPDATE room_tasks SET active_handoff_id = ? WHERE id = ?').run(id, task.id);
      this.bump(task.id, {});
      this.event(task.id, 'handoff-created', intent.from_contact, {
        handoffId: id, jobId: job.id, fromModule: intent.from_module, toModule: cb.return_module,
        toContact: cb.return_contact, toRevision: cb.return_revision, source: 'registered-completion',
        turnId: intent.origin_turn_id,
      }, intent.from_module);
      return this.requireHandoff(id);
    })();
  }

  private deliverCallback(
    task: RoomTaskRow,
    job: JobRow,
    actor: string,
  ): { delivery: RoomTaskDispatchResult } | StoreError {
    if (ACTIVE_JOB_STATUSES.has(job.status)) return fail('执行尚未终态，不能提前投递完成回执或交接', 409);
    // Exact registered snapshot only: never the execution recipient, never a
    // live re-resolution. Fenced attempts never deliver, even when invoked
    // directly (both callers also check; this is the fail-closed floor).
    if (this.jobs.workflowModules.isFenced(job.id)) {
      this.event(task.id, 'attempt-fenced', actor, { jobId: job.id });
      return fail('该尝试已被接管废弃；旧回调已失效', 409);
    }
    const cb = this.callbackRow(job.id);
    if (!cb || cb.task_id !== task.id || !isModuleId(cb.return_module)) {
      this.event(task.id, 'callback-skipped', actor, { jobId: job.id, reason: 'no explicit return callback registered' });
      return { delivery: { status: 'failed', reason: 'no explicit return callback' } };
    }
    if (!this.dispatch) return fail('本网关未配置投递器；回调保持待投递', 503);
    let handoff = this.fulfillCompletionHandoff(task, job, cb);
    // Two jobs started under one baton both register a return to the same
    // module. The first to finish moves the baton there, which makes the
    // second's completion handoff look superseded — but its recipient already
    // holds the task and is waiting for exactly this receipt (2026-09-19: review
    // said "waiting for 27ccaef3" and was never woken). Deliver it as a plain
    // receipt; refuse only when the baton really went somewhere else.
    let siblingReceipt = false;
    if (handoff && 'error' in handoff) {
      const current = this.requireTask(task.id);
      siblingReceipt = this.isOpenGovernance(task.room_id)
        && !['closed', 'dropped'].includes(current.status)
        && current.holder_module === cb.return_module
        && current.owner_contact === cb.return_contact;
      if (!siblingReceipt) {
        // The caller retries on error; a refusal that can never succeed must
        // still leave one visible trace in the ledger.
        const logged = this.db.prepare(`SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = 'callback-failed'
          AND json_extract(payload, '$.jobId') = ? AND json_extract(payload, '$.reason') = ? LIMIT 1`)
          .get(task.id, job.id, handoff.error);
        if (!logged) {
          this.event(task.id, 'callback-failed', actor, {
            jobId: job.id, returnTo: cb.return_module, returnContact: cb.return_contact, reason: handoff.error,
          });
        }
        return handoff;
      }
      handoff = null;
    }
    if (handoff && handoff.status !== 'pending') {
      if (handoff.status === 'accepted') return { delivery: { status: 'duplicate' } };
      return fail(`完成交接已 ${handoff.status}；不得重新唤醒旧交接`, 409);
    }
    // Open governance: the completion callback IS the baton move. Accept the
    // registered return handoff and hand holder/owner to the return module
    // before waking it, so the woken turn already owns the task and its pinned
    // handoff is accepted — no self task_pass, no superseded-pin dead end.
    const openCallbackPass = !!handoff && this.isOpenGovernance(task.room_id) && isModuleId(cb.return_module);
    if (handoff && openCallbackPass) {
      const returnHandoff = handoff;
      this.db.transaction(() => {
        this.db.prepare(`UPDATE room_task_handoffs SET status = 'accepted', decided_by = ?, decided_at = datetime('now')
          WHERE id = ? AND status = 'pending'`).run(actor, returnHandoff.id);
        this.bump(task.id, {
          owner_module: cb.return_module as WorkflowModuleId,
          owner_contact: cb.return_contact,
          holder_module: cb.return_module as WorkflowModuleId,
          next_module: null,
          active_handoff_id: null,
        });
        this.event(task.id, 'callback-pass', actor, {
          jobId: job.id, handoffId: returnHandoff.id, toModule: cb.return_module, toContact: cb.return_contact,
          fromModule: task.holder_module ?? task.owner_module,
        }, cb.return_module);
      })();
      handoff = this.requireHandoff(returnHandoff.id);
    }
    const receipt = structuredReceiptFields(job);
    // P3: point the reviewer at the incremental diff when the worker
    // collected one. The cumulative patch stays readable; APPROVE evidence
    // still uses the full patch.
    const delta = receiptPatchDelta(job);
    const deltaHint = delta && !delta.dropped && delta.patchDeltaKind === 'rebase-identical'
      ? `干净 rebase（Worker 从 git 直接比对，不经模型）：相对上次 pin 候选 ${String(delta.patchDeltaBase ?? '').slice(0, 12)}，本任务自身的 patch 逐字一致，只是换了主干基点；无需重读 diff，需要核对再读 section="patch"。`
      : delta && !delta.dropped && delta.patch
        ? `增量优先：本轮相对上次 pin 候选的变化可用 execution_get(room_id="${task.room_id}", task_path="${task.task_path}", job_id="${job.id}", section="patch_delta") 先读增量${delta.patchDeltaKind === 'rebase-range-diff' ? '（本轮做过 rebase，增量是 git range-diff 原文）' : ''}，需要全量再读 section="patch"。`
        : null;
    const content = [
      `【任务回执】${task.task_path} job ${job.id} → ${cb.return_module}（${cb.return_contact}，启动时显式登记）`,
      `终态：${job.status} / ${job.delivery_state ?? 'unknown'}`,
      receipt.head ? `HEAD=${receipt.head} branch=${receipt.branch ?? '未报告'}` : 'HEAD 未申报（旧 runner 或失败尝试）',
      (job.result || job.error || '（无输出）').slice(0, 2000),
      ...(deltaHint ? [deltaHint] : []),
      ...(handoff ? [this.handoffContent(this.requireTask(task.id), handoff)] : []),
      '用 task_get（含 receipt 分页）读完整回执与证据；完成只兑现已登记的回执/交接，不自动开后续执行单。下一步由模型显式决定（review 交接 / 返工交接 / 发布）。',
      ...(openCallbackPass || siblingReceipt
        ? [
          siblingReceipt
            ? `open 模式：棒已在 ${cb.return_module}（你）手上；这是同一次交棒下另一轮执行的回执，无需 accept。review 直接 review_submit（candidate_job_id=${job.id}，结论即 pin 并自动交棒：REQUEST_CHANGES→execute，APPROVE→merge）；其他模块直接执行或 task_pass。`
            : `open 模式：棒已随本回执交到 ${cb.return_module}（你），无需 accept。review 直接 review_submit（candidate_job_id=${job.id}，结论即 pin 并自动交棒：REQUEST_CHANGES→execute，APPROVE→merge）；其他模块直接执行或 task_pass。`,
        ]
        : [
          'review 收到完成交接先 accept，再直接 review_submit 新候选（结论即 pin，无需负责人先提交 candidate）；REQUEST_CHANGES 直接 task_handoff execute（附 MUST 项与通过条件，修复完成回 review），APPROVE 直接交 merge。仅改方案、改范围或触发仲裁阈值时交 plan。',
          '交接义务：收到本回执的轮次结束前必须留可验证责任去向（继续执行、显式 task_handoff、登记 task_wait blocked/waiting_user，回调非负责人轮次可用 waiting_owner，或 decline 不再承接）；只报 done、只 accept 不做事、或静默 PASS 会被网关判为未交接失败。阶段完成不是任务完成。',
        ]),
    ].join('\n');
    let delivery: RoomTaskDispatchResult;
    // O4: wake budget counts every callback wake. Exhaustion auto-blocks the
    // task (surfaced to User); the callback is not delivered.
    if (!this.countWakeOrBlock(task.id, actor, `callback:${cb.return_module}`)) {
      return { delivery: { status: 'failed', reason: 'wake budget exhausted; task auto-blocked' } };
    }
    try {
      delivery = this.dispatch.dispatchToModule(task.room_id, cb.return_module, cb.return_contact,
        content, handoff ? `task-handoff:v1:${handoff.id}` : `task-callback:v1:${job.id}`,
        handoff ? { taskId: task.id, handoffId: handoff.id } : { taskId: task.id, callbackJobId: job.id });
    } catch (error) {
      delivery = { status: 'failed', reason: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
    if (delivery.status === 'failed') {
      this.event(task.id, 'callback-failed', actor, {
        jobId: job.id, returnTo: cb.return_module, returnContact: cb.return_contact,
        reason: delivery.reason ?? 'dispatch failed',
      });
    } else {
      this.event(task.id, 'callback-delivered', actor, {
        jobId: job.id, returnTo: cb.return_module, returnContact: cb.return_contact,
      });
    }
    return { delivery };
  }

  /**
   * Terminal-job continuation for task-linked jobs. Idempotent BEFORE any
   * business mutation: replays that already folded this attempt skip straight
   * to the delivery check. Finishes never select or replace the implementation
   * candidate (explicit candidate evidence and review verdicts do). Closed
   * tasks are never downgraded, and a late non-candidate finish never reverts
   * reviewed state. Delivery notifies ONLY the explicitly registered return
   * callback, fulfilling a registered pending handoff when requested, but
   * never starts a new job or selects the next stage.
   */
  handleJobFinished(job: JobRow, opts: { finalAttempt: boolean; actor?: string }): { handled: boolean } {
    this.ensureSchema();
    const options = parseJson(job.options);
    const taskId = typeof options.roomTaskId === 'string' ? options.roomTaskId : '';
    if (!taskId) return { handled: false };
    const actor = opts.actor ?? job.requested_by ?? 'system';
    let task: RoomTaskRow;
    try {
      task = this.requireTask(taskId);
    } catch {
      return { handled: false };
    }
    if (this.jobs.workflowModules.isFenced(job.id)) {
      this.event(task.id, 'attempt-fenced', actor, { jobId: job.id });
      return { handled: true };
    }
    if (!this.attemptRecorded(task.id, job.id)) {
      const receipt = structuredReceiptFields(job);
      const head = (receipt.head ?? '').toLowerCase() || null;
      const closureKind = typeof options.closureKind === 'string' ? options.closureKind : '';
      // P1 cost ledger: dispatch-time identity + runner-reported usage.
      const ledgerIdentity = attemptLedgerIdentity(job);
      const ledgerUsage = receipt.usage;
      this.db.transaction(() => {
        const payload = job.result || job.error || '';
        const beforeHead = String(record(deliveryMeta(job).before).head ?? '').toLowerCase();
        if (!closureKind && options.routeClass === 'implement' && SHA40_RE.test(beforeHead)) {
          this.db.prepare('UPDATE room_tasks SET baseline_sha = ? WHERE id = ? AND baseline_sha IS NULL')
            .run(beforeHead, task.id);
        }
        this.addEvidence(task.id, 'receipt_ref', job.id,
          [`status=${job.status}`, `delivery=${job.delivery_state ?? 'unknown'}`, head ? `head=${head}` : 'head=missing',
            payload.slice(0, 4000),
            ...(payload.length > 4000
              ? [`…（摘要截断：回执全文 ${payload.length} 字符，用 execution_get 分页读取；diff 原文用 section=patch）`]
              : [])].join('\n'),
          actor);
        // Closed tasks never downgrade: late finishes only append evidence.
        // A late non-candidate done must not revert reviewed state either:
        // only the candidate, a closure, or an open-progress task advances.
        if (task.status !== 'closed') {
          const jobIsCandidate = task.candidate_job_id === job.id;
          const isClosure = closureKind === 'merge' || closureKind === 'deploy';
          const lateNonCandidate = task.status === 'in_review' && job.status === 'done'
            && !jobIsCandidate && !isClosure;
          let status: RoomTaskStatus = task.status;
          if (lateNonCandidate) {
            this.event(task.id, 'attempt-late', actor, { jobId: job.id, head });
          } else if (job.status === 'failed' || job.status === 'interrupted') {
            status = 'blocked';
          } else if (closureKind === 'deploy' && job.status === 'done') {
            status = 'closed';
          } else if (closureKind === 'merge' && job.status === 'done') {
            status = 'in_review';
          } else if (job.status === 'done') {
            status = 'in_progress';
          }
          // M5: finishes never select or replace the implementation candidate.
          // The owner pins repairs explicitly via candidate evidence (which
          // invalidates prior approval); review pins at verdict time. Status
          // folds here; candidate/review columns are untouched.
          this.db.prepare(
            `UPDATE room_tasks SET status = ?,
              revision = revision + 1, updated_at = datetime('now') WHERE id = ?`,
          ).run(status, task.id);
        }
        if (closureKind === 'merge' && job.status === 'done') {
          const report = scriptReportOf(job);
          if (report?.rebase === 'identical') {
            this.event(task.id, 'merge-rebased', actor, {
              jobId: job.id, from: String(report.rebasedFrom ?? '').toLowerCase(), to: String(report.head ?? '').toLowerCase(),
            }, 'merge');
          }
          // R2-D: patched merge proven against the pinning APPROVE's patch sha.
          if (report?.patch === 'identical') {
            const pinned = task.candidate_sha?.toLowerCase() ?? '';
            const expected = this.approvePatchSha(task);
            if (pinned && mergedHeadOf(report, pinned, expected)) {
              this.event(task.id, 'merge-patched', actor, {
                jobId: job.id,
                from: String(report.patchedFrom ?? '').toLowerCase(),
                to: String(report.head ?? '').toLowerCase(),
                patchSha256: String(report.patchSha256 ?? '').toLowerCase(),
                evidenceId: task.review_evidence_id,
              }, 'merge');
            }
          }
        }
        this.event(task.id, 'attempt-finished', actor, {
          jobId: job.id, status: job.status, deliveryState: job.delivery_state ?? null, head,
          // P1 cost ledger (additive JSON fields; old readers ignore them).
          durationMs: attemptDurationMs(job),
          moduleId: ledgerIdentity.moduleId,
          runner: ledgerIdentity.runner,
          model: ledgerIdentity.model,
          reasoning: ledgerIdentity.reasoning,
          usage: ledgerUsage,
        });
      })();
    }
    if (this.callbackDelivered(task.id, job.id)) return { handled: true };
    // Min-closure-2: a proven merge with a remaining W-sequence block starts
    // that block directly (no review/plan wake). The last block falls through
    // to the after_merge/callback flow unchanged.
    // Q3: a proven merge may close the task outright (after_merge='done');
    // the review seat is then not woken. Anything short falls through to the
    // classic callback flow unchanged.
    try {
      if (this.trySequenceNext(task.id, job, actor)) return { handled: true };
      if (this.tryMergeAutoClose(task.id, job, actor)) return { handled: true };
      if (this.tryMergeAutoDeploy(task.id, job, actor)) return { handled: true };
      if (this.tryDeployAutoClose(task.id, job, actor)) return { handled: true };
    } catch { /* classic flow below stays the fallback */ }
    try {
      const outcome = this.deliverCallback(this.requireTask(task.id), job, actor);
      if ('error' in outcome) {
        if (!opts.finalAttempt) throw new Error(outcome.error);
        this.event(task.id, 'callback-failed', actor, { jobId: job.id, reason: outcome.error, final: true });
      } else if (outcome.delivery.status === 'failed' && !opts.finalAttempt) {
        throw new Error(outcome.delivery.reason ?? 'callback dispatch failed; will retry');
      }
    } catch (error) {
      if (!opts.finalAttempt) throw error;
      this.event(task.id, 'callback-failed', actor, {
        jobId: job.id, reason: (error instanceof Error ? error.message : String(error)).slice(0, 500), final: true,
      });
    }
    // O2: a pass queued while the job was in flight takes effect now that the
    // job drained (strict rooms never set next_module).
    try {
      this.applyQueuedNext(task.id, actor);
    } catch { /* wake is best-effort */ }
    // O5: stale merge candidate (master moved past frozen): the script refuses
    // to push and reports machine-readable stale. Open rooms auto-pass back to
    // execute with the rebase target; the three-round gate still applies
    // (tripped gate blocks instead of passing).
    try {
      this.autoPassMergeStale(task.id, job, actor);
    } catch { /* wake is best-effort */ }
    return { handled: true };
  }

  /**
   * O5: handle a stale merge-script report. Detects the script's
   * `{ok:false, stale:true, masterSha}` JSON in the finished merge job result
   * and moves the baton back to execute with a rebase note (open rooms only;
   * strict rooms keep the manual path).
   *
   * Q4 (cost batch 2): the baton move starts the rebase Worker in the same
   * transaction (P2-style: passInternal with deferred delivery +
   * startAcceptedExecution, return_to review, no execute chat wake) instead
   * of waking the execute seat. The three-round gate, single-write lease,
   * frozen execute snapshot and patchBase/patchSince plumbing all stay
   * enforced inside startAcceptedExecution. Direct-start failure (no usable
   * binding, lease conflict, budget, …) falls back to the classic
   * execute-seat wake with a `merge-stale-auto-start-fallback` reason event.
   */
  autoPassMergeStale(taskId: string, job: JobRow, actor: string): boolean {
    try {
      this.ensureSchema();
      const task = this.getTaskById(taskId);
      if (!task || !this.isOpenGovernance(task.room_id)) return false;
      const options = parseJson(job.options);
      if (options.closureKind !== 'merge') return false;
      const text = `${job.result ?? ''}\n${job.error ?? ''}`;
      if (!/"stale"\s*:\s*true/.test(text)) return false;
      const master = /"masterSha"\s*:\s*"([0-9a-f]{40})"/i.exec(text)?.[1]?.toLowerCase();
      if (!master) return false;
      if (['closed', 'dropped'].includes(task.status)) return false;
      const note = `rebase 到 ${master} 后重推候选（merge 时 master 已超前，脚本拒推）`;
      this.event(task.id, 'merge-stale', actor, { jobId: job.id, masterSha: master });
      if (this.executeRoundsSinceReview(task.id) >= EXECUTE_ROUNDS_BEFORE_REVIEW) {
        this.bump(task.id, { status: 'blocked', next_module: null });
        this.event(task.id, 'merge-stale-blocked', actor, { masterSha: master, note });
        this.addEvidence(task.id, 'note', '', note, actor);
        return true;
      }
      const initiator = this.isParticipant(task.room_id, actor) ? actor : this.requireTask(task.id).owner_contact;
      const objective = `${note}。边界：无冲突则 force-with-lease 重推并送审；有冲突就地停、如实回报，不得自行解冲突后直接送合入`;
      const tx = this.db.transaction(() => {
        const current = this.requireTask(task.id);
        const passed = this.passInternal(current, 'execute', initiator, note, 'merge-stale-auto-pass', { deferDelivery: true });
        if (passed.queued) {
          throw new AutoStartRollback(fail('任务已有在途执行；交棒已登记为 next，本次未直启', 409));
        }
        const passKey = `pass:v1:${current.id}:${current.revision}:execute`;
        const accepted = this.db.prepare('SELECT * FROM room_task_handoffs WHERE idempotency_key = ?').get(passKey) as RoomTaskHandoffRow | undefined;
        if (!accepted) throw new AutoStartRollback(fail('交棒落账缺失；先核对账本', 409));
        const started = this.startAcceptedExecution({
          roomId: current.room_id,
          taskPath: current.task_path,
          actorContact: initiator,
          module: 'execute',
          expectedRevision: passed.task.revision,
          workspace: current.approved_workspace,
          objective,
          returnToModule: 'review',
        }, passed.task, accepted, true);
        if ('error' in started) throw new AutoStartRollback(started);
        this.event(task.id, 'merge-stale-auto-started', initiator, {
          jobId: started.job.id, masterSha: master, passId: accepted.id, returnTo: 'review',
        });
        const factId = Number(this.db.prepare(`INSERT INTO messages
          (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
          VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main', ?)`).run(
          current.room_id,
          `【rebase 直接启动】${current.task_path}：merge-stale（master 已到 ${master.slice(0, 12)}）后网关已直接为 execute 启动 rebase job ${started.job.id}；完成回 review；不唤醒 execute 席聊天轮次。`,
          JSON.stringify({ event: 'room-task-merge-stale-auto-start', taskId: current.id, jobId: started.job.id, masterSha: master }),
          `task-merge-stale-auto-start:v1:${accepted.id}`,
        ).lastInsertRowid);
        return { task: started.task, job: started.job, factId };
      });
      let out: { task: RoomTaskRow; job: JobRow; factId: number };
      try {
        out = this.jobs.transactionWithDeferredEvents(tx);
      } catch (error) {
        if (error instanceof AutoStartRollback) {
          this.recordCapabilityRejectFromFailure(task.id, initiator, 'execute', error.failure);
        }
        const reason = (error instanceof AutoStartRollback
          ? error.failure.error
          : (error instanceof Error ? error.message : String(error))).slice(0, 500);
        this.event(task.id, 'merge-stale-auto-start-fallback', initiator, { reason, masterSha: master });
        try {
          this.passInternal(this.requireTask(task.id), 'execute', initiator, note, 'merge-stale-auto-pass');
        } catch { /* wake best-effort; the reason event above stands */ }
        return true;
      }
      try { this.dispatch?.publishFact?.(out.factId); } catch { /* reconnect reloads the fact */ }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Q3: close an open-room task when its merge closure proves success and the
   * pinning APPROVE declared after_merge='done'. All machine-checked, reusing
   * scriptReportOf + mergeTargetBranchOk (scriptReport.head must equal the
   * pinned candidate_sha; rows without scriptReport keep the classic flow):
   * the merge job must be done, its parent must still be the pinned
   * candidate, review must still be approved on the same evidence, and no
   * re-pin or newer verdict may have landed since that APPROVE. On success
   * the task closes via the normal done path (event `done` with auto:true +
   * proof) with a system fact, and the review seat is NOT woken. Anything
   * short — stale/failed merges, head mismatch, re-pin, strict rooms —
   * returns false and the classic callback flow runs unchanged.
   */
  private mergeAutoClosed(taskId: string, jobId: string): boolean {
    try {
      const row = this.db.prepare(
        `SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = 'auto-closed'
          AND json_extract(payload, '$.jobId') = ? LIMIT 1`,
      ).get(taskId, jobId);
      return Boolean(row);
    } catch {
      return false;
    }
  }

  /**
   * Min-closure-2: a proven merge with a W-sequence and a remaining block
   * starts the next block's execute Worker directly (frozen execute snapshot,
   * return_to review, one system fact, no review/plan wake) instead of the
   * after_merge/callback flow. The last block falls through (returns false)
   * so the declared after_merge — or the classic wake — runs unchanged.
   *
   * A tripped three-round gate halts the sequence: the ledger keeps
   * `sequence-halted`, the baton wakes plan, and the merge callback is
   * consumed (returns true). A direct-start failure (no usable binding, gate
   * refusal, lease conflict, budget, …) records `sequence-next-fallback` and
   * returns false so the classic flow wakes the review seat.
   *
   * Wake-budget caliber matches the existing execute direct starts: no chat
   * wake is dispatched; pass/job accounting inside passInternal +
   * startAcceptedExecution still applies.
   */
  private trySequenceNext(taskId: string, job: JobRow, actor: string): boolean {
    try {
      const task = this.getTaskById(taskId);
      if (!task || !this.isOpenGovernance(task.room_id)) return false;
      if (['closed', 'dropped', 'blocked'].includes(task.status)) return false;
      const options = parseJson(job.options);
      if (options.closureKind !== 'merge' || job.status !== 'done') return false;
      // Replay guard: this merge already advanced, completed or halted the sequence.
      const replayed = this.db.prepare(
        `SELECT 1 FROM room_task_events WHERE task_id = ?
          AND kind IN ('sequence-next-started', 'sequence-completed', 'sequence-halted')
          AND json_extract(payload, '$.mergeJobId') = ? LIMIT 1`,
      ).get(taskId, job.id);
      if (replayed) return true;
      const seq = this.sequenceOf(task);
      if (!seq) return false;
      const pinned = task.candidate_sha?.toLowerCase();
      if (!pinned) return false;
      // Machine proof first (same mergedHeadOf gate as the after_merge
      // decision point): only a verified merge advances the sequence.
      const proof = this.provenMergeAfterApproval(task, job, pinned);
      if (!proof) return false;
      const initiator = this.isParticipant(task.room_id, actor) ? actor : task.owner_contact;
      const nextIndex = seq.index + 1;
      if (nextIndex >= seq.items.length) {
        // Last block: a declared after_merge runs the existing flow
        // (sequence bookkeeping drops with it); an undeclared merge hands
        // the baton back to plan instead of waking the review seat.
        const finish = (wakePlan: boolean): boolean => {
          this.db.prepare('UPDATE room_tasks SET sequence_json = NULL, sequence_index = NULL WHERE id = ?').run(task.id);
          this.event(task.id, 'sequence-completed', initiator, {
            total: seq.items.length, mergedSha: proof.mergedSha, mergeJobId: job.id,
            ...(wakePlan ? {} : { afterMerge: proof.afterMerge }),
          });
          if (wakePlan) {
            try {
              this.passInternal(this.requireTask(task.id), 'plan', initiator,
                `sequence 完成（${seq.items.length} 块全部合入 ${proof.mergedSha.slice(0, 12)}），交 plan 收口`, 'sequence-complete');
            } catch { /* wake is best-effort; the completion event above stands */ }
            return true;
          }
          return false;
        };
        return proof.afterMerge === 'review' ? finish(true) : finish(false);
      }
      const next = seq.items[nextIndex];
      const rounds = this.executeRoundsSinceReview(task.id);
      if (rounds >= EXECUTE_ROUNDS_BEFORE_REVIEW) {
        const reason = `本任务自上次独立评审以来已执行 ${rounds} 轮，sequence 不再自动派下一块；已交 plan 接管`;
        this.db.prepare('UPDATE room_tasks SET sequence_json = NULL, sequence_index = NULL WHERE id = ?').run(task.id);
        this.event(task.id, 'sequence-halted', initiator, {
          reason, index: nextIndex, label: next.label, mergeJobId: job.id,
        }, 'plan');
        try {
          this.passInternal(this.requireTask(task.id), 'plan', initiator, `sequence halted: ${reason}`, 'sequence-halt');
        } catch { /* wake is best-effort; the halt event above stands */ }
        return true;
      }
      const tx = this.db.transaction(() => {
        const current = this.requireTask(task.id);
        const passed = this.passInternal(current, 'execute', initiator,
          `sequence 下一块 ${next.label}（合入 ${proof.mergedSha.slice(0, 12)} 已核对通过，直接启动，不唤醒 review/plan 席）`,
          'sequence-next', { deferDelivery: true, ...(next.write !== undefined ? { write: next.write } : {}) });
        if (passed.queued) {
          throw new AutoStartRollback(fail('任务已有在途执行；交棒已登记为 next，本次未直启', 409));
        }
        const passKey = `pass:v1:${current.id}:${current.revision}:execute`;
        const accepted = this.db.prepare('SELECT * FROM room_task_handoffs WHERE idempotency_key = ?').get(passKey) as RoomTaskHandoffRow | undefined;
        if (!accepted) throw new AutoStartRollback(fail('交棒落账缺失；先核对账本', 409));
        const started = this.startAcceptedExecution({
          roomId: current.room_id,
          taskPath: current.task_path,
          actorContact: initiator,
          module: 'execute',
          expectedRevision: passed.task.revision,
          workspace: current.approved_workspace,
          objective: next.objective,
          returnToModule: 'review',
          ...(next.write !== undefined ? { write: next.write } : {}),
          ...(next.shell !== undefined ? { shell: next.shell } : {}),
        }, passed.task, accepted, true);
        if ('error' in started) throw new AutoStartRollback(started);
        this.db.prepare('UPDATE room_tasks SET sequence_index = ? WHERE id = ?').run(nextIndex, task.id);
        this.event(task.id, 'sequence-next-started', initiator, {
          index: nextIndex, label: next.label, jobId: started.job.id,
          passId: accepted.id, returnTo: 'review',
          mergedSha: proof.mergedSha, mergeJobId: job.id,
        }, 'execute');
        const factId = Number(this.db.prepare(`INSERT INTO messages
          (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
          VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main', ?)`).run(
          current.room_id,
          `【序列直接启动】${current.task_path}：${next.label}（第 ${nextIndex + 1}/${seq.items.length} 块）合入已核对通过，网关已直接为 execute 启动下一块 job ${started.job.id}；完成回 review；不唤醒 review/plan 席聊天轮次。`,
          JSON.stringify({ event: 'room-task-sequence-next-auto-start', taskId: current.id, jobId: started.job.id, index: nextIndex }),
          `task-sequence-next-auto-start:v1:${accepted.id}`,
        ).lastInsertRowid);
        return { task: started.task, job: started.job, factId };
      });
      let out: { task: RoomTaskRow; job: JobRow; factId: number };
      try {
        out = this.jobs.transactionWithDeferredEvents(tx);
      } catch (error) {
        if (error instanceof AutoStartRollback) {
          this.recordCapabilityRejectFromFailure(task.id, initiator, 'execute', error.failure);
        }
        const reason = (error instanceof AutoStartRollback
          ? error.failure.error
          : (error instanceof Error ? error.message : String(error))).slice(0, 500);
        this.event(task.id, 'sequence-next-fallback', initiator, {
          reason, index: nextIndex, label: next.label, mergeJobId: job.id,
        }, 'review');
        return false;
      }
      try { this.dispatch?.publishFact?.(out.factId); } catch { /* reconnect reloads the fact */ }
      return true;
    } catch {
      return false;
    }
  }

  private tryMergeAutoClose(taskId: string, job: JobRow, actor: string): boolean {
    try {
      // Replay guard: an already auto-closed merge never delivers twice.
      if (this.mergeAutoClosed(taskId, job.id)) return true;
      const task = this.getTaskById(taskId);
      if (!task || !this.isOpenGovernance(task.room_id)) return false;
      if (['closed', 'dropped', 'blocked'].includes(task.status)) return false;
      const options = parseJson(job.options);
      if (options.closureKind !== 'merge') return false;
      if (job.status !== 'done') return false;
      const pinned = task.candidate_sha?.toLowerCase();
      if (!pinned || !task.candidate_job_id || task.review_status !== 'approved' || task.review_evidence_id === null) {
        return false;
      }
      if (String(options.parentJobId ?? '') !== task.candidate_job_id) return false;
      // Machine proof: authoritative scriptReport with head == pinned
      // candidate; legacy rows without scriptReport keep current behavior.
      const proof = this.provenMergeAfterApproval(task, job, pinned);
      if (!proof || proof.afterMerge !== 'done') return false;
      const report = proof.report;
      const reportRecord = report as Record<string, unknown>;
      const branch = String(reportRecord.branch ?? reportRecord.targetBranch ?? 'master');
      let factId = 0;
      this.db.transaction(() => {
        this.addEvidence(taskId, 'note', job.id,
          [`auto-close: merge ${job.id} head=${proof.mergedSha.slice(0, 12)} branch=${branch}`,
            `after_merge=done (review-evidence:${task.review_evidence_id})`].join('\n'), actor);
        this.bump(taskId, { status: 'closed', next_module: null });
        this.event(taskId, 'done', actor, {
          auto: true, jobId: job.id, sha: proof.mergedSha, branch, afterMerge: 'done',
          reviewEvidenceId: task.review_evidence_id,
        }, 'review');
        this.event(taskId, 'auto-closed', actor, { jobId: job.id, sha: proof.mergedSha, branch });
        factId = Number(this.db.prepare(`INSERT INTO messages
          (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
          VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main', ?)`).run(
          task.room_id,
          `【任务自动收口】${task.task_path}：合入 ${proof.mergedSha.slice(0, 12)} 已推送到 ${branch}（机器核对通过），按评审 APPROVE 声明直接关闭；不再唤醒评审席。`,
          JSON.stringify({ event: 'room-task-auto-close', taskId, jobId: job.id, sha: proof.mergedSha }),
          `task-auto-close:v1:${job.id}`,
        ).lastInsertRowid);
      })();
      try { this.dispatch?.publishFact?.(factId); } catch { /* reconnect reloads the fact */ }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Machine proof shared by the merge-done direct paths: a done merge closure
   * of the pinned candidate whose authoritative script report pushed it (or
   * its clean identical rebase) to master, with the pinning APPROVE still the
   * latest verdict. Returns that APPROVE's structured after_merge declaration
   * (never a line matched out of the evidence body: findings are free text in
   * that same body and could spell it by accident).
   */
  private provenMergeAfterApproval(task: RoomTaskRow, job: JobRow, pinned: string): {
    report: Record<string, unknown>; mergedSha: string; afterMerge: string | null;
  } | null {
    const options = parseJson(job.options);
    if (options.closureKind !== 'merge' || job.status !== 'done') return null;
    if (!task.candidate_job_id || task.review_status !== 'approved' || task.review_evidence_id === null) return null;
    if (String(options.parentJobId ?? '') !== task.candidate_job_id) return null;
    const report = scriptReportOf(job);
    if (!report) return null;
    const approval = this.db.prepare(
      `SELECT id, json_extract(payload, '$.afterMerge') AS afterMerge,
        json_extract(payload, '$.patch.sha256') AS patchSha256 FROM room_task_events
        WHERE task_id = ? AND kind = 'review-approved'
        AND json_extract(payload, '$.evidenceId') = ? ORDER BY id DESC LIMIT 1`,
    ).get(task.id, task.review_evidence_id) as { id: number; afterMerge: string | null; patchSha256: string | null } | undefined;
    if (!approval) return null;
    const expectedPatch = typeof approval.patchSha256 === 'string' && approval.patchSha256 ? approval.patchSha256 : null;
    const receipt = structuredReceiptFields(job);
    if (!mergeTargetBranchOk(job.result, receipt.branch, pinned, report, expectedPatch)) return null;
    const mergedSha = mergedHeadOf(report, pinned, expectedPatch);
    if (!mergedSha) return null;
    const laterVerdict = this.db.prepare(
      `SELECT 1 FROM room_task_events WHERE task_id = ? AND id > ?
        AND kind IN ('review-approved', 'review-changes-requested', 'candidate-submitted') LIMIT 1`,
    ).get(task.id, approval.id);
    if (laterVerdict) return null;
    return { report, mergedSha, afterMerge: approval.afterMerge };
  }

  /**
   * Open-room merge done + APPROVE declared after_merge='deploy': start the
   * deploy closure directly (deploy-module snapshot, return to review) instead
   * of waking the review seat to hand off and the deploy seat to release.
   * Only ai-hub self-deploy has a deploy channel; other repos, missing
   * bindings or any gate refusal fall back to the classic review wake with a
   * `deploy-auto-start-fallback` reason event.
   */
  private tryMergeAutoDeploy(taskId: string, job: JobRow, actor: string): boolean {
    // Replay guard: a merge that already started its deploy never delivers
    // the review callback afterwards.
    const alreadyStarted = this.db.prepare(
      `SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = 'release-auto-started'
        AND json_extract(payload, '$.kind') = 'deploy' AND json_extract(payload, '$.mergeJobId') = ? LIMIT 1`,
    ).get(taskId, job.id);
    if (alreadyStarted) return true;
    const task = this.getTaskById(taskId);
    if (!task || !this.isOpenGovernance(task.room_id)) return false;
    if (['closed', 'dropped', 'blocked'].includes(task.status)) return false;
    const pinned = task.candidate_sha?.toLowerCase();
    if (!pinned) return false;
    const proof = this.provenMergeAfterApproval(task, job, pinned);
    if (!proof || proof.afterMerge !== 'deploy') return false;
    const candidate = task.candidate_job_id ? this.jobs.get(task.candidate_job_id) : undefined;
    const repoId = String(record(parseJson(candidate?.options).projectTarget).repoId ?? 'ai-hub') || 'ai-hub';
    const initiator = this.isParticipant(task.room_id, actor) ? actor : task.owner_contact;
    if (repoId !== 'ai-hub') {
      this.event(task.id, 'deploy-auto-start-fallback', initiator, { reason: `repo ${repoId} 没有自部署通道`, mergeJobId: job.id });
      return false;
    }
    const note = `merge done auto-pass to deploy (direct release, no deploy chat wake; sha=${proof.mergedSha.slice(0, 12)})`;
    const tx = this.db.transaction(() => {
      const current = this.requireTask(task.id);
      const passed = this.passInternal(current, 'deploy', initiator, note, 'merge-auto-deploy', { deferDelivery: true });
      if (passed.queued) throw new AutoStartRollback(fail('任务已有在途执行；交棒已登记为 next，本次未直启', 409));
      const passKey = `pass:v1:${current.id}:${current.revision}:deploy`;
      const accepted = this.db.prepare('SELECT * FROM room_task_handoffs WHERE idempotency_key = ?').get(passKey) as RoomTaskHandoffRow | undefined;
      if (!accepted) throw new AutoStartRollback(fail('交棒落账缺失；先核对账本', 409));
      const deployBinding = this.currentBindingContact('deploy');
      if ('error' in deployBinding) throw new AutoStartRollback(deployBinding);
      const started = this.startDeployClosureRelease({
        task: passed.task,
        accepted,
        actor: deployBinding.contactId,
        initiatedBy: initiator,
        returnToModule: 'review',
        returnMode: 'handoff',
        mode: 'auto',
      });
      if ('error' in started) throw new AutoStartRollback(started);
      if (started.existing) return { job: started.job, factId: null as number | null };
      const factId = Number(this.db.prepare(`INSERT INTO messages
        (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
        VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main', ?)`).run(
        current.room_id,
        `【部署直接启动】${current.task_path}：合入 ${proof.mergedSha.slice(0, 12)} 已推送，按评审 APPROVE 声明 after_merge=deploy，网关已直接启动部署 job ${started.job.id}；部署验证通过即自动收口，不唤醒 deploy/评审席。`,
        JSON.stringify({ event: 'room-task-deploy-auto-start', taskId: current.id, jobId: started.job.id }),
        `task-deploy-auto-start:v1:${accepted.id}`,
      ).lastInsertRowid);
      return { job: started.job, factId };
    });
    let out: { job: JobRow; factId: number | null };
    try {
      out = this.jobs.transactionWithDeferredEvents(tx);
    } catch (error) {
      const reason = (error instanceof AutoStartRollback
        ? error.failure.error
        : (error instanceof Error ? error.message : String(error))).slice(0, 500);
      this.event(task.id, 'deploy-auto-start-fallback', initiator, { reason, mergeJobId: job.id });
      return false;
    }
    try { if (out.factId) this.dispatch?.publishFact?.(out.factId); } catch { /* reconnect reloads the fact */ }
    return true;
  }

  /**
   * A directly started deploy (after_merge='deploy') that finished done has
   * already folded the task to closed; post the proof and skip waking the
   * review seat. Failed deploys, explicit deploys and replays fall through
   * to the classic callback.
   */
  private tryDeployAutoClose(taskId: string, job: JobRow, actor: string): boolean {
    if (this.mergeAutoClosed(taskId, job.id)) return true;
    const task = this.getTaskById(taskId);
    if (!task || !this.isOpenGovernance(task.room_id)) return false;
    const options = parseJson(job.options);
    if (options.closureKind !== 'deploy' || job.status !== 'done' || task.status !== 'closed') return false;
    const autoStarted = this.db.prepare(
      `SELECT 1 FROM room_task_events WHERE task_id = ? AND kind = 'release-auto-started'
        AND json_extract(payload, '$.kind') = 'deploy' AND json_extract(payload, '$.jobId') = ? LIMIT 1`,
    ).get(taskId, job.id);
    if (!autoStarted) return false;
    const sha = String(options.frozenSha ?? '').toLowerCase();
    // Machine proof, like the merge side: the deploy script's own report
    // must say it put exactly this SHA online. Anything short wakes review.
    const report = scriptReportOf(job);
    if (!report || report.ok !== true || report.mode !== 'deploy'
      || String(report.targetSha ?? '').toLowerCase() !== sha
      || !report.deployOkLine || String(report.health ?? '') !== 'ok') {
      return false;
    }
    let factId = 0;
    this.db.transaction(() => {
      this.addEvidence(taskId, 'note', job.id, `auto-close: deploy ${job.id} sha=${sha.slice(0, 12)} 部署验证通过`, actor);
      this.bump(taskId, { next_module: null });
      this.event(taskId, 'done', actor, {
        auto: true, jobId: job.id, sha, afterMerge: 'deploy', reviewEvidenceId: task.review_evidence_id,
      }, 'deploy');
      this.event(taskId, 'auto-closed', actor, { jobId: job.id, sha, kind: 'deploy' });
      factId = Number(this.db.prepare(`INSERT INTO messages
        (contact_id, sender, role, kind, content, status, meta, origin, idempotency_key)
        VALUES (?, 'system', 'user', 'text', ?, 'done', ?, 'main', ?)`).run(
        task.room_id,
        `【任务自动收口】${task.task_path}：${sha.slice(0, 12)} 已部署并通过 deploy ok + /api/health 验证，按评审 APPROVE 声明直接关闭；不再唤醒评审席。`,
        JSON.stringify({ event: 'room-task-auto-close', taskId, jobId: job.id, sha }),
        `task-auto-close:v1:${job.id}`,
      ).lastInsertRowid);
    })();
    try { this.dispatch?.publishFact?.(factId); } catch { /* reconnect reloads the fact */ }
    return true;
  }
}

/** Shared dispatch-ledger helpers (single writer logic for dispatcher, manager recovery, and redelivery checks). */
export function taskDispatchLedgerStatus(db: Db, idempotencyKey: string): string | null {  try {
    const row = db.prepare(
      'SELECT status FROM room_task_dispatches WHERE idempotency_key = ?',
    ).get(idempotencyKey) as { status: string } | undefined;
    return row?.status ?? null;
  } catch {
    return null;
  }
}

export function markTaskDispatch(
  db: Db,
  idempotencyKey: string,
  kind: string,
  status: 'posted' | 'failed',
  messageId: number | null,
  target: string,
  detail: string,
): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS room_task_dispatches (
        idempotency_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'posted',
        message_id INTEGER,
        target TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      `INSERT INTO room_task_dispatches (idempotency_key, kind, status, message_id, target, detail, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(idempotency_key) DO UPDATE SET
         status = excluded.status, message_id = excluded.message_id,
         target = excluded.target, detail = excluded.detail, updated_at = datetime('now')`,
    ).run(idempotencyKey, kind, status, messageId, target, detail.slice(0, 1000));
  } catch { /* ledger is best-effort; wakes fail loudly on their own */ }
}
/** Server-side Vault task reader: trusted approved-source text for imports. */
export function readVaultTaskFile(tasksDir: string | null, taskPath: string): string | null {
  if (!tasksDir) return null;
  if (!/^tasks\/[a-z0-9][a-z0-9-]*\.md$/i.test(taskPath)) return null;
  try {
    return fs.readFileSync(path.join(tasksDir, taskPath.slice('tasks/'.length)), 'utf8').slice(0, 20_000);
  } catch {
    return null;
  }
}

function handoffEvidenceLine(handoff: RoomTaskHandoffRow): string {
  try {
    const refs = JSON.parse(handoff.evidence_refs) as unknown;
    if (Array.isArray(refs) && refs.length) {
      return `证据引用：${refs.map(String).join('、').slice(0, 1000)}`;
    }
  } catch { /* fall through */ }
  return '证据引用：（无，随 task_get 自取）';
}

/** Recovery evidence for a preserved unsettled audit row (display-only). */
export interface UnsettledRecovery {
  turnId: string;
  recovered: boolean;
  evidence: Array<{
    eventId: number;
    kind: string;
    turnId?: string;
    handoffId?: string;
    jobId?: string;
  }>;
  summary?: string;
}

const RECOVERY_ACTIVE_JOB_STATUSES = new Set([
  'pending', 'claimed', 'running', 'recovering', 'pause_requested', 'cancel_requested',
]);

function recoveryPayloadTurnId(payload: unknown): string | undefined {
  try {
    const turnId = (payload as Record<string, unknown>).turnId;
    return typeof turnId === 'string' && turnId ? turnId : undefined;
  } catch {
    return undefined;
  }
}

function recoveryPayloadId(payload: unknown, ...keys: string[]): string | undefined {
  try {
    const record = payload as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value) return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function recoveryPayloadWaitId(payload: unknown): number | undefined {
  try {
    const record = payload as Record<string, unknown>;
    for (const key of ['waitId', 'wait_id']) {
      const value = record[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
      if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const parsed = Number(value.trim());
        if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Display-layer recovery lookup for one unsettled turn.
 * Never rewrites the original turn-unsettled event. Returns recovered=true
 * only when a LATER event for the same task shows a currently-valid
 * disposition on the same chain: posted handoff, active unfenced job with
 * callback, valid wait, or delivered callback. Unrelated activity never counts.
 */
export function findUnsettledRecovery(
  db: Db,
  jobs: JobStore | null,
  taskId: string,
  failedTurnId: string,
): UnsettledRecovery {
  const empty: UnsettledRecovery = { turnId: failedTurnId, recovered: false, evidence: [] };
  try {
    const unsettled = db.prepare(
      `SELECT id FROM room_task_events
        WHERE task_id = ? AND kind = 'turn-unsettled'
          AND json_extract(payload, '$.turnId') = ?
        ORDER BY id ASC LIMIT 1`,
    ).get(taskId, failedTurnId) as { id: number } | undefined;
    if (!unsettled) return empty;
    const later = db.prepare(
      `SELECT id, kind, payload FROM room_task_events
        WHERE task_id = ? AND id > ?
          AND kind IN (
            'handoff-created', 'handoff-delivered', 'handoff-accepted',
            'execution-started', 'callback-delivered',
            'wait-registered', 'blocked-registered', 'callback-wait-registered'
          )
        ORDER BY id ASC LIMIT 50`,
    ).all(taskId, unsettled.id) as Array<{ id: number; kind: string; payload: string }>;
    for (const row of later) {
      let payload: unknown = {};
      try {
        payload = JSON.parse(row.payload || '{}');
      } catch {
        payload = {};
      }
      const eventTurnId = recoveryPayloadTurnId(payload);
      if (eventTurnId && eventTurnId === failedTurnId) continue;
      if (row.kind === 'handoff-created' || row.kind === 'handoff-delivered') {
        const handoffId = recoveryPayloadId(payload, 'handoffId', 'handoff_id');
        if (!handoffId) continue;
        try {
          const handoff = db.prepare(
            'SELECT status FROM room_task_handoffs WHERE id = ? AND task_id = ?',
          ).get(handoffId, taskId) as { status: string } | undefined;
          if (!handoff || !['pending', 'accepted'].includes(handoff.status)) continue;
          if (taskDispatchLedgerStatus(db, `task-handoff:v1:${handoffId}`) !== 'posted') continue;
          return {
            turnId: failedTurnId,
            recovered: true,
            evidence: [{ eventId: row.id, kind: row.kind, ...(eventTurnId ? { turnId: eventTurnId } : {}), handoffId }],
            summary: '本轮交接检查曾失败，后续已恢复',
          };
        } catch {
          continue;
        }
      }
      if (row.kind === 'handoff-accepted') {
        const handoffId = recoveryPayloadId(payload, 'handoffId', 'handoff_id');
        if (!handoffId) continue;
        try {
          const handoff = db.prepare(
            'SELECT status FROM room_task_handoffs WHERE id = ? AND task_id = ?',
          ).get(handoffId, taskId) as { status: string } | undefined;
          if (!handoff || handoff.status !== 'accepted') continue;
          return {
            turnId: failedTurnId,
            recovered: true,
            evidence: [{ eventId: row.id, kind: row.kind, ...(eventTurnId ? { turnId: eventTurnId } : {}), handoffId }],
            summary: '本轮交接检查曾失败，后续已恢复',
          };
        } catch {
          continue;
        }
      }
      if (row.kind === 'execution-started' || row.kind === 'callback-delivered') {
        const jobId = recoveryPayloadId(payload, 'jobId', 'job_id');
        if (!jobId || !jobs) continue;
        try {
          const job = jobs.get(jobId);
          if (!job) continue;
          try {
            if (jobs.workflowModules.isFenced(jobId)) continue;
          } catch {
            continue;
          }
          const linked = db.prepare(
            'SELECT 1 FROM room_task_links WHERE job_id = ? AND task_id = ?',
          ).get(jobId, taskId);
          if (!linked) continue;
          const cb = db.prepare(
            'SELECT 1 FROM room_task_callbacks WHERE job_id = ? AND task_id = ?',
          ).get(jobId, taskId);
          if (!cb) continue;
          if (RECOVERY_ACTIVE_JOB_STATUSES.has(job.status)) {
            return {
              turnId: failedTurnId,
              recovered: true,
              evidence: [{ eventId: row.id, kind: row.kind, ...(eventTurnId ? { turnId: eventTurnId } : {}), jobId }],
              summary: '本轮交接检查曾失败，后续已恢复',
            };
          }
          const returned = db.prepare(
            `SELECT h.id AS id, h.status AS status FROM room_task_completion_handoffs c
              JOIN room_task_handoffs h ON h.id = c.handoff_id
              WHERE c.job_id = ? AND c.task_id = ?`,
          ).get(jobId, taskId) as { id: string; status: string } | undefined;
          if (!returned || !['pending', 'accepted'].includes(returned.status)) continue;
          if (taskDispatchLedgerStatus(db, `task-handoff:v1:${returned.id}`) !== 'posted') continue;
          return {
            turnId: failedTurnId,
            recovered: true,
            evidence: [{ eventId: row.id, kind: row.kind, ...(eventTurnId ? { turnId: eventTurnId } : {}), jobId, handoffId: returned.id }],
            summary: '本轮交接检查曾失败，后续已恢复',
          };
        } catch {
          continue;
        }
      }
      if (row.kind === 'wait-registered' || row.kind === 'blocked-registered' || row.kind === 'callback-wait-registered') {
        // Exact-wait recovery only: the event must name its wait row (real
        // payloads carry a numeric waitId), the row must belong to this task
        // and to the event's own later turn, carry a live mode, match the
        // CURRENT task revision, and — for callback scope — ride a live
        // unfenced callback registration for the same actor/module. Stale
        // revisions, fenced/taken-over callbacks, cross-task waits and the
        // old "any later wait" fallback never count.
        const waitId = recoveryPayloadWaitId(payload);
        if (!waitId) continue;
        try {
          const wait = db.prepare(
            `SELECT id, mode, revision, actor, module, turn_id, scope, callback_job_id
               FROM room_task_waits WHERE id = ? AND task_id = ?`,
          ).get(waitId, taskId) as
            | {
                id: number; mode: string; revision: number; actor: string;
                module: string; turn_id: string; scope: string;
                callback_job_id: string | null;
              }
            | undefined;
          if (!wait) continue;
          if (!['blocked', 'waiting_user', 'waiting_owner'].includes(wait.mode)) continue;
          // The wait must be subsequent handling, on the event's own turn —
          // never the failed turn itself, never an unrelated turn's row.
          if (!wait.turn_id || wait.turn_id === failedTurnId) continue;
          if (!eventTurnId || wait.turn_id !== eventTurnId) continue;
          const current = db.prepare(
            'SELECT revision FROM room_tasks WHERE id = ?',
          ).get(taskId) as { revision: number } | undefined;
          if (!current || wait.revision !== current.revision) continue;
          if (wait.scope === 'callback' || row.kind === 'callback-wait-registered') {
            if (wait.scope !== 'callback' || wait.mode !== 'waiting_owner') continue;
            const callbackJobId = wait.callback_job_id;
            if (!callbackJobId) continue;
            const cb = db.prepare(
              `SELECT task_id, return_module, return_contact FROM room_task_callbacks
                 WHERE job_id = ?`,
            ).get(callbackJobId) as
              | { task_id: string; return_module: string; return_contact: string }
              | undefined;
            if (!cb || cb.task_id !== taskId) continue;
            if (cb.return_module !== wait.module || cb.return_contact !== wait.actor) continue;
            if (!jobs) continue;
            try {
              if (jobs.workflowModules.isFenced(callbackJobId)) continue;
            } catch {
              continue;
            }
            if (!jobs.get(callbackJobId)) continue;
          } else if (wait.scope !== 'task') {
            continue;
          }
          return {
            turnId: failedTurnId,
            recovered: true,
            evidence: [{ eventId: row.id, kind: row.kind, ...(eventTurnId ? { turnId: eventTurnId } : {}) }],
            summary: '本轮交接检查曾失败，后续已恢复',
          };
        } catch {
          continue;
        }
      }
    }
    return empty;
  } catch {
    return empty;
  }
}

/** Batch recovery lookup for every unsettled turn of one task (display only). */
export function findTaskUnsettledRecoveries(
  db: Db,
  jobs: JobStore | null,
  taskId: string,
): UnsettledRecovery[] {
  try {
    const rows = db.prepare(
      `SELECT DISTINCT json_extract(payload, '$.turnId') AS turnId FROM room_task_events
        WHERE task_id = ? AND kind = 'turn-unsettled'`,
    ).all(taskId) as Array<{ turnId: string | null }>;
    const turnIds = rows.map((row) => row.turnId).filter((id): id is string => typeof id === 'string' && Boolean(id));
    return [...new Set(turnIds)].map((turnId) => findUnsettledRecovery(db, jobs, taskId, turnId));
  } catch {
    return [];
  }
}

/**
 * Bounded remedy bookkeeping: at most one automatic remedy wake per failed
 * turn+task, and remedy turns never chain. The gateway never auto-selects a
 * next stage/contact — the remedy turn simply re-invokes the ORIGINAL
 * module/contact with a FRESH nonce, and the model still decides the
 * operation (execute / handoff / wait / decline) under the normal validators
 * (owner, revision, nonce, fenced, single-write-lease, dispatch idempotency).
 * All helpers are best-effort and fail closed (no remedy on any doubt).
 */
export function ensureRemedySchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_task_remedies (
      failed_turn_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      room_id TEXT NOT NULL DEFAULT '',
      contact_id TEXT NOT NULL DEFAULT '',
      module_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'scheduled',
      remedy_turn_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (failed_turn_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_room_task_remedies_turn ON room_task_remedies(remedy_turn_id);
  `);
}

/** Claim the single automatic remedy for one failed turn+task. First call wins. */
export function tryClaimRemedy(
  db: Db,
  input: { failedTurnId: string; taskId: string; roomId: string; contactId: string; moduleId: string },
): { claimed: boolean } {
  try {
    if (!input.failedTurnId || !input.taskId) return { claimed: false };
    ensureRemedySchema(db);
    const result = db.prepare(
      `INSERT OR IGNORE INTO room_task_remedies
        (failed_turn_id, task_id, room_id, contact_id, module_id, status)
       VALUES (?, ?, ?, ?, ?, 'scheduled')`,
    ).run(input.failedTurnId, input.taskId, input.roomId, input.contactId, input.moduleId);
    return { claimed: Number((result as { changes?: unknown }).changes ?? 0) === 1 };
  } catch {
    return { claimed: false };
  }
}

/** Link a freshly begun remedy turn to the failed turn it补办s (chain-breaker). */
export function markRemedyTurn(db: Db, remedyTurnId: string, failedTurnId: string, taskId: string): void {
  try {
    if (!remedyTurnId || !failedTurnId || !taskId) return;
    ensureRemedySchema(db);
    db.prepare(
      `UPDATE room_task_remedies
         SET remedy_turn_id = ?, status = 'started', updated_at = datetime('now')
       WHERE failed_turn_id = ? AND task_id = ?`,
    ).run(remedyTurnId, failedTurnId, taskId);
  } catch {
    // best-effort
  }
}

/** True when this turn itself is a remedy turn: it must never schedule another. */
export function isRemedyTurn(db: Db, turnId: string): boolean {
  try {
    if (!turnId) return false;
    ensureRemedySchema(db);
    const row = db.prepare(
      'SELECT 1 AS hit FROM room_task_remedies WHERE remedy_turn_id = ? LIMIT 1',
    ).get(turnId) as { hit?: unknown } | undefined;
    return Boolean(row);
  } catch {
    return false;
  }
}
