import crypto from 'node:crypto';
import type { Db, JobRow } from '../platform/index.js';
import { modelCatalog } from '../contacts/index.js';

/**
 * Fixed workflow modules (sole operational policy, modular B).
 * policyVersion is immutable (1); dynamic binding changes bump revision.
 * Authority belongs to module invocation, never contact persona.
 */

export const WORKFLOW_MODULE_POLICY_VERSION = 1;

export type WorkflowModuleId =
  | 'plan' | 'execute' | 'review' | 'arbitration' | 'merge' | 'deploy' | 'maintenance';

export const WORKFLOW_MODULE_IDS: readonly WorkflowModuleId[] = [
  'plan', 'execute', 'review', 'arbitration', 'merge', 'deploy', 'maintenance',
];

export interface ModulePermissions {
  write: boolean;
  shell: boolean;
  ssh: boolean;
}

export interface ModuleBinding {
  contactId: string;
  runner: 'codex' | 'claude' | 'grok' | 'opencode';
  model: string;
  reasoning: string;
}

/** User-selected default for newly created room tasks. A task freezes its
 * resolved workspace at creation; changing this value never moves a task. */
export interface WorkflowWorkerTarget {
  workerId: string;
  workspace: string;
  repoId?: string;
}

export interface ModuleDefinition {
  id: WorkflowModuleId;
  label: string;
  description: string;
  permissions: ModulePermissions;
}

export const WORKFLOW_MODULES: readonly ModuleDefinition[] = [
  {
    id: 'plan',
    label: '接入／规划',
    description: '接收需求、只读核查并形成待批准的实施范围。',
    permissions: { write: false, shell: true, ssh: false },
  },
  {
    id: 'execute',
    label: '执行／修复',
    description: '实现已批准的范围，修复评审必须项，并完成相关验证。',
    permissions: { write: true, shell: true, ssh: false },
  },
  {
    id: 'review',
    label: '独立评审',
    description: '只读核对候选版本与证据，明确通过或必须修复项。',
    permissions: { write: false, shell: true, ssh: false },
  },
  {
    id: 'arbitration',
    label: '技术仲裁',
    description: '同一问题累计两轮未收敛后，判断方案或实现问题并给出修正意见。',
    permissions: { write: false, shell: true, ssh: false },
  },
  {
    id: 'merge',
    label: '合并',
    description: '评审通过后，校验冻结版本、完成验证并按既有流程合并推送。',
    permissions: { write: true, shell: true, ssh: false },
  },
  {
    id: 'deploy',
    label: '部署／验证',
    description: '复用已授权的部署通道，等待在途任务结束并验证上线结果。',
    permissions: { write: false, shell: true, ssh: true },
  },
  {
    id: 'maintenance',
    label: '维护／巡逻',
    description: '处理已授权的维护与巡检，只修改明确范围内的问题。',
    permissions: { write: true, shell: true, ssh: false },
  },
];

/** B-style seed contacts: codex plans/arbitrates, muse executes, aye reviews/maintains, codex merges/deploys (Grok decoupled). */
export const DEFAULT_MODULE_BINDINGS: Record<WorkflowModuleId, ModuleBinding> = {
  plan: { contactId: 'codex', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' },
  execute: { contactId: 'muse', runner: 'opencode', model: 'opencode-go/muse-spark-1.3-contributor', reasoning: 'high' },
  review: { contactId: 'aye', runner: 'grok', model: 'grok-4.6', reasoning: 'high' },
  arbitration: { contactId: 'codex', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' },
  merge: { contactId: 'codex', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' },
  deploy: { contactId: 'codex', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' },
  maintenance: { contactId: 'aye', runner: 'grok', model: 'grok-4.6', reasoning: 'medium' },
};

/** Consecutive implementation inadequates before technical arbitration / human escalation. */
export const IMPLEMENT_ARBITRATION_AFTER = 2;
export const IMPLEMENT_HUMAN_AFTER = 3;
/** Consecutive review inadequates before human escalation. */
export const REVIEW_HUMAN_AFTER = 3;

const KNOWN_RUNNERS = new Set(['codex', 'claude', 'grok', 'opencode']);

function catalogBackend(runner: string): string {
  if (runner === 'claude') return 'claude-cli';
  if (runner === 'grok') return 'grok-cli';
  if (runner === 'opencode') return 'opencode-cli';
  return 'codex-cli';
}

/** Contact backend ids ('codex', 'claude-cli', …) resolve to runner ids. */
export function runnerForBackend(backend: string): string {
  return String(backend ?? '').replace(/-cli$/, '');
}

/**
 * Model-level supported effort choices (hot catalogs only, no live calls).
 * OpenCode Muse Spark 1.3 supports max; other opencode models use the catalog.
 */
export function supportedEfforts(runner: string, model: string): string[] {
  const catalog = modelCatalog(catalogBackend(runner));
  const selected = catalog.models.find((item) => item.id === model);
  if (!selected) return [];
  return (selected.supportedReasoningEfforts ?? catalog.efforts ?? []).map((item) => item.id).filter(Boolean);
}

export function modelInHotCatalog(runner: string, model: string): boolean {
  const catalog = modelCatalog(catalogBackend(runner));
  return catalog.models.some((item) => item.id === model);
}

function canonical(value: string): string {
  return String(value ?? '').trim().replaceAll('\\', '/');
}

export interface ModuleInvocation {
  moduleId: WorkflowModuleId;
  policyVersion: number;
  bindingRevision: number;
  binding: ModuleBinding;
  permissions: ModulePermissions;
  /** Effective execution binding after streak routing (arbitration upgrade). */
  selected: ModuleBinding;
  escalateToHuman: boolean;
  arbitrationActive: boolean;
  taskPath: string;
  problemFingerprint: string;
}

export interface QualityRecordInput {
  quality: 'success' | 'inadequate' | 'infrastructure';
  detail?: string;
}

function poolOf(binding: ModuleBinding): string {
  return `credential:${binding.runner}`;
}

export class WorkflowModulesStore {
  constructor(private readonly db: Db) {}

  /** Additive migration helper: create tables if an old DB predates migration 0034. */
  ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_module_arbitration_verdicts (
        task_path TEXT NOT NULL,
        problem_fingerprint TEXT NOT NULL,
        verdict_job_id TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('proceed', 'needs_iris')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task_path, problem_fingerprint)
      );
      CREATE TABLE IF NOT EXISTS workflow_module_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        policy_version INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL DEFAULT 'system',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO workflow_module_state (singleton, policy_version, revision, updated_by)
      VALUES (1, 1, 1, 'migration');
      CREATE TABLE IF NOT EXISTS workflow_module_bindings (
        module_id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        runner TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        updated_by TEXT NOT NULL DEFAULT 'system',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS workflow_module_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        module_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS workflow_module_streaks (
        task_path TEXT NOT NULL,
        problem_fingerprint TEXT NOT NULL,
        streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task_path, problem_fingerprint)
      );
      CREATE TABLE IF NOT EXISTS workflow_module_review_streaks (
        task_path TEXT NOT NULL,
        problem_fingerprint TEXT NOT NULL,
        streak INTEGER NOT NULL DEFAULT 0 CHECK (streak >= 0),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (task_path, problem_fingerprint)
      );
      CREATE TABLE IF NOT EXISTS workflow_module_quality_events (
        job_id TEXT PRIMARY KEY,
        module_id TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT '',
        problem_fingerprint TEXT NOT NULL DEFAULT '',
        quality TEXT NOT NULL CHECK (quality IN ('success', 'inadequate', 'infrastructure')),
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS workflow_module_takeovers (
        old_job_id TEXT PRIMARY KEY,
        new_job_id TEXT NOT NULL,
        module_id TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 0,
        actor TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  revision(): number {
    this.ensureSchema();
    const row = this.db.prepare(
      'SELECT policy_version, revision FROM workflow_module_state WHERE singleton = 1',
    ).get() as { policy_version: number; revision: number };
    return Number(row.revision);
  }

  workerTarget(): WorkflowWorkerTarget | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'workflow.worker-target'")
      .get() as { value: string } | undefined;
    if (!row) return null;
    try {
      const value = JSON.parse(row.value) as WorkflowWorkerTarget;
      if (typeof value.workerId === 'string' && typeof value.workspace === 'string') return value;
    } catch { /* a damaged setting is shown as unset, never used for routing */ }
    return null;
  }

  setWorkerTarget(target: WorkflowWorkerTarget, expectedRevision: number, actor: string):
    { ok: true; revision: number } | { ok: false; error: string; code: 409 } {
    this.ensureSchema();
    return this.db.transaction(() => {
      const current = this.revision();
      if (current !== expectedRevision) {
        return { ok: false as const, error: `stale revision: expected ${expectedRevision}, current ${current}`, code: 409 as const };
      }
      const previous = this.workerTarget();
      const revision = current + 1;
      this.db.prepare("INSERT INTO settings (key, value) VALUES ('workflow.worker-target', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(target));
      this.db.prepare("UPDATE workflow_module_state SET revision = ?, updated_by = ?, updated_at = datetime('now') WHERE singleton = 1")
        .run(revision, actor);
      this.db.prepare("INSERT INTO workflow_module_audit (action, actor, revision, detail) VALUES ('worker-target', ?, ?, ?)")
        .run(actor, revision, JSON.stringify({ from: previous, to: target }));
      return { ok: true as const, revision };
    })();
  }

  policyVersion(): number {
    return WORKFLOW_MODULE_POLICY_VERSION;
  }

  bindings(): Record<WorkflowModuleId, ModuleBinding> {
    this.ensureSchema();
    this.ensureSeeded('system');
    const rows = this.db.prepare('SELECT * FROM workflow_module_bindings').all() as Array<{
      module_id: string; contact_id: string; runner: string; model: string; reasoning: string;
    }>;
    const out = {} as Record<WorkflowModuleId, ModuleBinding>;
    for (const id of WORKFLOW_MODULE_IDS) {
      const row = rows.find((item) => item.module_id === id);
      out[id] = row
        ? { contactId: row.contact_id, runner: row.runner as ModuleBinding['runner'], model: row.model, reasoning: row.reasoning }
        : { ...DEFAULT_MODULE_BINDINGS[id] };
    }
    return out;
  }

  ensureSeeded(actor = 'system'): void {
    this.ensureSchema();
    const existing = new Set(
      (this.db.prepare('SELECT module_id FROM workflow_module_bindings').all() as Array<{ module_id: string }>)
        .map((row) => row.module_id),
    );
    const missing = WORKFLOW_MODULE_IDS.filter((id) => !existing.has(id));
    if (missing.length === 0) return;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO workflow_module_bindings
        (module_id, contact_id, runner, model, reasoning, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    );
    const tx = this.db.transaction(() => {
      for (const id of missing) {
        const seed = DEFAULT_MODULE_BINDINGS[id];
        insert.run(id, seed.contactId, seed.runner, seed.model, seed.reasoning, actor);
      }
      this.db.prepare(
        `INSERT INTO workflow_module_audit (action, actor, revision, detail)
         VALUES ('seed', ?, ?, ?)`,
      ).run(actor, this.revision(), JSON.stringify({ modules: missing }));
    });
    tx();
  }

  /**
   * One-time additive migration from legacy profile streaks/events.
   * Execute+fix counters are summed per task/problem so nothing is lost;
   * job-level events are copied with OR IGNORE so re-runs never double count.
   */
  migrateLegacy(): { implementation: number; review: number; events: number } {
    this.ensureSchema();
    let implementation = 0;
    let review = 0;
    let events = 0;
    const tables = new Set(
      (this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!tables.has('workflow_quality_streaks') || !tables.has('workflow_quality_events')) {
      return { implementation: 0, review: 0, events: 0 };
    }
    const tx = this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM workflow_module_audit WHERE action = 'legacy-migrate-v1' LIMIT 1").get()) return;
      const implRows = this.db.prepare(
        `SELECT task_path, problem_fingerprint, SUM(streak) AS streak
         FROM workflow_quality_streaks
         WHERE stage IN ('execute', 'fix')
         GROUP BY task_path, problem_fingerprint`,
      ).all() as Array<{ task_path: string; problem_fingerprint: string; streak: number }>;
      for (const row of implRows) {
        const change = this.db.prepare(
          `INSERT INTO workflow_module_streaks (task_path, problem_fingerprint, streak, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(task_path, problem_fingerprint)
           DO UPDATE SET streak = MAX(workflow_module_streaks.streak, excluded.streak)`,
        ).run(row.task_path, row.problem_fingerprint, Number(row.streak));
        implementation += Number(change.changes);
      }
      const reviewRows = this.db.prepare(
        `SELECT task_path, problem_fingerprint, SUM(streak) AS streak
         FROM workflow_quality_streaks
         WHERE stage = 'review'
         GROUP BY task_path, problem_fingerprint`,
      ).all() as Array<{ task_path: string; problem_fingerprint: string; streak: number }>;
      for (const row of reviewRows) {
        const change = this.db.prepare(
          `INSERT INTO workflow_module_review_streaks (task_path, problem_fingerprint, streak, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(task_path, problem_fingerprint)
           DO UPDATE SET streak = MAX(workflow_module_review_streaks.streak, excluded.streak)`,
        ).run(row.task_path, row.problem_fingerprint, Number(row.streak));
        review += Number(change.changes);
      }
      const eventRows = this.db.prepare(
        `SELECT job_id, stage, problem_fingerprint, quality, detail
         FROM workflow_quality_events`,
      ).all() as Array<{ job_id: string; stage: string; problem_fingerprint: string; quality: string; detail: string | null }>;
      for (const row of eventRows) {
        const moduleId = moduleForStage(row.stage as never);
        const change = this.db.prepare(
          `INSERT OR IGNORE INTO workflow_module_quality_events
            (job_id, module_id, stage, problem_fingerprint, quality, detail)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(row.job_id, moduleId, row.stage, row.problem_fingerprint, row.quality, row.detail);
        events += Number(change.changes);
      }
      this.db.prepare("INSERT INTO workflow_module_audit (action, actor, revision, detail) VALUES ('legacy-migrate-v1', 'migration', ?, ?)")
        .run(this.revision(), JSON.stringify({ implementation, review, events }));
    });
    tx();
    return { implementation, review, events };
  }

  audit(limit = 30): Array<Record<string, unknown>> {
    this.ensureSchema();
    return this.db.prepare(
      'SELECT * FROM workflow_module_audit ORDER BY id DESC LIMIT ?',
    ).all(Math.min(Math.max(limit, 1), 100)) as Array<Record<string, unknown>>;
  }

  validateBinding(moduleId: string, binding: Partial<ModuleBinding>): { ok: true } | { ok: false; error: string } {
    if (!WORKFLOW_MODULE_IDS.includes(moduleId as WorkflowModuleId)) {
      return { ok: false, error: `unknown module ${moduleId}` };
    }
    const contactId = String(binding.contactId ?? '').trim();
    const runner = String(binding.runner ?? '').trim();
    const model = String(binding.model ?? '').trim();
    const reasoning = String(binding.reasoning ?? '').trim();
    if (!contactId || !runner || !model || !reasoning) {
      return { ok: false, error: 'binding contactId/runner/model/reasoning required' };
    }
    if (!KNOWN_RUNNERS.has(runner)) return { ok: false, error: `unsupported runner ${runner}` };
    const contact = this.db.prepare(
      "SELECT id, backend, enabled, kind FROM contacts WHERE id = ?",
    ).get(contactId) as { id: string; backend: string; enabled: number; kind: string } | undefined;
    if (!contact || contact.kind !== 'dm' || contact.enabled !== 1) {
      return { ok: false, error: `contact ${contactId} is not an enabled agent` };
    }
    if (runnerForBackend(contact.backend) !== runner) {
      return { ok: false, error: `contact ${contactId} runs ${contact.backend}, not ${runner}` };
    }
    if (!modelInHotCatalog(runner, model)) {
      return { ok: false, error: `${runner} model ${model} is absent from the hot catalog` };
    }
    if (!supportedEfforts(runner, model).includes(reasoning)) {
      return { ok: false, error: `${runner} model ${model} does not support effort ${reasoning}` };
    }
    if (runner === 'codex' && !/^[a-zA-Z0-9._-]{1,100}$/.test(model)) {
      return { ok: false, error: 'codex model id is invalid' };
    }
    if (runner === 'opencode' && !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]{1,80}$/.test(model)) {
      return { ok: false, error: 'opencode model id is invalid' };
    }
    // Reject incompatible bindings rather than silently relaxing enforcement:
    // unknown adapters cannot enforce shell-write/SSH separation.
    const definition = WORKFLOW_MODULES.find((item) => item.id === moduleId)!;
    if (!isRunnerCompatible(runner, definition.permissions)) {
      return { ok: false, error: `${runner} cannot enforce ${moduleId} permissions; binding incompatible` };
    }
    return { ok: true };
  }

  /**
   * Atomic revision-checked binding swap. No mutation on validation failure;
   * stale expectedRevision yields 409-style { error, code: 409 }.
   */
  setBinding(
    moduleId: WorkflowModuleId,
    binding: ModuleBinding,
    expectedRevision: number,
    actor: string,
  ): { ok: true; revision: number } | { ok: false; error: string; code: 404 | 409 | 400 } {
    this.ensureSchema();
    this.ensureSeeded(actor);
    if (!WORKFLOW_MODULE_IDS.includes(moduleId)) {
      return { ok: false, error: `unknown module ${moduleId}`, code: 404 };
    }
    const validation = this.validateBinding(moduleId, binding);
    if (!validation.ok) {
      const result = validation as { ok: false; error: string };
      return { ok: false, error: result.error, code: 400 };
    }
    const tx = this.db.transaction(() => {
      const state = this.db.prepare(
        'SELECT revision FROM workflow_module_state WHERE singleton = 1',
      ).get() as { revision: number };
      if (Number(state.revision) !== Number(expectedRevision)) {
        return { ok: false as const, error: `stale revision: expected ${expectedRevision}, current ${state.revision}`, code: 409 as const };
      }
      const current = this.db.prepare(
        'SELECT contact_id, runner, model, reasoning FROM workflow_module_bindings WHERE module_id = ?',
      ).get(moduleId) as { contact_id: string; runner: string; model: string; reasoning: string } | undefined;
      const nextRevision = Number(state.revision) + 1;
      this.db.prepare(
        `UPDATE workflow_module_bindings
         SET contact_id = ?, runner = ?, model = ?, reasoning = ?, updated_by = ?, updated_at = datetime('now')
         WHERE module_id = ?`,
      ).run(binding.contactId, binding.runner, binding.model, binding.reasoning, actor, moduleId);
      this.db.prepare(
        'UPDATE workflow_module_state SET revision = ?, updated_by = ?, updated_at = datetime(\'now\') WHERE singleton = 1',
      ).run(nextRevision, actor);
      this.db.prepare(
        `INSERT INTO workflow_module_audit (action, actor, module_id, revision, detail)
         VALUES ('bind', ?, ?, ?, ?)`,
      ).run(actor, moduleId, nextRevision, JSON.stringify({ from: current ?? null, to: binding }));
      return { ok: true as const, revision: nextRevision };
    });
    return tx();
  }

  implStreak(taskPath: string, fingerprint: string): number {
    this.ensureSchema();
    const row = this.db.prepare(
      'SELECT streak FROM workflow_module_streaks WHERE task_path = ? AND problem_fingerprint = ?',
    ).get(canonical(taskPath), fingerprint.toLowerCase()) as { streak: number } | undefined;
    return Number(row?.streak ?? 0);
  }

  reviewStreak(taskPath: string, fingerprint: string): number {
    this.ensureSchema();
    const row = this.db.prepare(
      'SELECT streak FROM workflow_module_review_streaks WHERE task_path = ? AND problem_fingerprint = ?',
    ).get(canonical(taskPath), fingerprint.toLowerCase()) as { streak: number } | undefined;
    return Number(row?.streak ?? 0);
  }

  /**
   * Resolve the invocation for a module. Running attempts capture this object;
   * hot swaps only affect NEW turns/dispatches.
   *
   * Model-driven workflow: quality counters are observations only. This method
   * NEVER routes to another module and NEVER escalates on its own; the model
   * explicitly names the next module via task_handoff, and humans intervene by
   * explicit action, not by counter.
   */
  invoke(
    moduleId: WorkflowModuleId,
    taskPath = '',
    problemFingerprint = '',
  ): ModuleInvocation {
    const bindings = this.bindings();
    const definition = WORKFLOW_MODULES.find((item) => item.id === moduleId)!;
    const revision = this.revision();
    const task = canonical(taskPath);
    const fingerprint = String(problemFingerprint ?? '').toLowerCase();
    const binding = bindings[moduleId];
    return {
      moduleId, policyVersion: WORKFLOW_MODULE_POLICY_VERSION, bindingRevision: revision,
      binding, permissions: definition.permissions, selected: binding,
      escalateToHuman: false, arbitrationActive: false, taskPath: task, problemFingerprint: fingerprint,
    };
  }

  isEscalated(invocation: Pick<ModuleInvocation, 'escalateToHuman'>): boolean {
    return invocation.escalateToHuman === true;
  }

  /** Called only after the server validates a terminal arbitration and its source chain. */
  recordArbitrationVerdict(taskPath: string, fingerprint: string, jobId: string, verdict: 'proceed' | 'needs_iris'): void {
    this.ensureSchema();
    this.db.prepare(`INSERT OR IGNORE INTO workflow_module_arbitration_verdicts
      (task_path, problem_fingerprint, verdict_job_id, verdict) VALUES (?, ?, ?, ?)`)
      .run(canonical(taskPath), fingerprint.toLowerCase(), jobId, verdict);
  }

  /**
   * Record terminal quality. Infrastructure never increments/resets.
   * Duplicate job ids (including migrated legacy events) never double count.
   */
  record(
    job: Pick<JobRow, 'id'> & { options?: string },
    invocation: Pick<ModuleInvocation, 'moduleId' | 'taskPath' | 'problemFingerprint'>,
    input: QualityRecordInput,
  ): { counted: boolean; streak?: number; escalateToHuman?: boolean; arbitrationActive?: boolean; reason?: string } {
    this.ensureSchema();
    if (this.isFenced(job.id)) {
      return { counted: false, reason: 'job fenced by takeover; late quality rejected' };
    }
    const moduleId = invocation.moduleId;
    const task = canonical(invocation.taskPath);
    const fingerprint = String(invocation.problemFingerprint ?? '').toLowerCase();
    // Execution/arbitration completion is not an independent quality decision.
    // Do not consume its idempotency key: a later review may reject this attempt.
    if (input.quality === 'success' && (moduleId === 'execute' || moduleId === 'arbitration')) {
      return { counted: false, reason: 'independent implementation review is required' };
    }
    if (input.quality === 'infrastructure') return { counted: false, reason: 'infrastructure does not affect quality' };
    return this.db.transaction(() => {
      const prior = this.db.prepare(
        'SELECT quality FROM workflow_module_quality_events WHERE job_id = ?',
      ).get(job.id) as { quality: string } | undefined;
      if (prior && !(prior.quality === 'success' && (moduleId === 'execute' || moduleId === 'arbitration'))) {
        return { counted: false, reason: 'job quality already recorded' };
      }
      if (prior) this.db.prepare('DELETE FROM workflow_module_quality_events WHERE job_id = ?').run(job.id);
      this.db.prepare(
        `INSERT INTO workflow_module_quality_events
          (job_id, module_id, stage, problem_fingerprint, quality, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(job.id, moduleId, '', fingerprint, input.quality, String(input.detail ?? '').slice(0, 2000));
      if (input.quality === 'infrastructure') {
        return { counted: false, reason: 'infrastructure failures do not affect quality streaks' };
      }
      if (input.quality === 'success') {
        // Implementation self-report never clears; only independent review
        // APPROVE of the corrected implementation does. An arbitration
        // verdict alone is not implementation acceptance either.
        if (moduleId === 'execute' || moduleId === 'arbitration') {
          return { counted: false, reason: moduleId === 'execute'
            ? 'implementation self-report does not clear quality streaks; independent review APPROVE does'
            : 'arbitration verdict is not independent implementation acceptance' };
        }
        if (moduleId === 'review') {
          if (fingerprint) {
            this.db.prepare(
              'DELETE FROM workflow_module_streaks WHERE task_path = ? AND problem_fingerprint = ?',
            ).run(task, fingerprint);
            this.db.prepare(
              'DELETE FROM workflow_module_review_streaks WHERE task_path = ? AND problem_fingerprint = ?',
            ).run(task, fingerprint);
            this.db.prepare('DELETE FROM workflow_module_arbitration_verdicts WHERE task_path = ? AND problem_fingerprint = ?').run(task, fingerprint);
            // Legacy tables remain historical. The one-time migration marker
            // prevents their old counters from being imported again.
          }
          return { counted: true, streak: 0, escalateToHuman: false, arbitrationActive: false };
        }
        return { counted: true, streak: 0, escalateToHuman: false, arbitrationActive: false };
      }
      // inadequate
      if (moduleId === 'execute' || moduleId === 'arbitration') {
        if (!fingerprint) return { counted: false, reason: 'missing problem fingerprint' };
        this.db.prepare(
          `INSERT INTO workflow_module_streaks (task_path, problem_fingerprint, streak, updated_at)
           VALUES (?, ?, 1, datetime('now'))
           ON CONFLICT(task_path, problem_fingerprint)
           DO UPDATE SET streak = workflow_module_streaks.streak + 1, updated_at = datetime('now')`,
        ).run(task, fingerprint);
        const streak = this.implStreak(task, fingerprint);
        return {
          counted: true, streak,
          escalateToHuman: streak >= IMPLEMENT_HUMAN_AFTER,
          arbitrationActive: streak >= IMPLEMENT_ARBITRATION_AFTER && streak < IMPLEMENT_HUMAN_AFTER,
        };
      }
      if (moduleId === 'review') {
        if (!fingerprint) return { counted: false, reason: 'missing problem fingerprint' };
        this.db.prepare(
          `INSERT INTO workflow_module_review_streaks (task_path, problem_fingerprint, streak, updated_at)
           VALUES (?, ?, 1, datetime('now'))
           ON CONFLICT(task_path, problem_fingerprint)
           DO UPDATE SET streak = workflow_module_review_streaks.streak + 1, updated_at = datetime('now')`,
        ).run(task, fingerprint);
        const streak = this.reviewStreak(task, fingerprint);
        return { counted: true, streak, escalateToHuman: streak >= REVIEW_HUMAN_AFTER, arbitrationActive: false };
      }
      return { counted: true, streak: 0, escalateToHuman: false, arbitrationActive: false };
    })();
  }

  isFenced(jobId: string): boolean {
    this.ensureSchema();
    const row = this.db.prepare(
      'SELECT old_job_id FROM workflow_module_takeovers WHERE old_job_id = ?',
    ).get(jobId) as { old_job_id: string } | undefined;
    return Boolean(row);
  }

  takeoverOf(oldJobId: string): Record<string, unknown> | undefined {
    this.ensureSchema();
    return this.db.prepare(
      'SELECT * FROM workflow_module_takeovers WHERE old_job_id = ?',
    ).get(oldJobId) as Record<string, unknown> | undefined;
  }

  takeoverByNew(newJobId: string): Record<string, unknown> | undefined {
    this.ensureSchema();
    return this.db.prepare(
      'SELECT * FROM workflow_module_takeovers WHERE new_job_id = ?',
    ).get(newJobId) as Record<string, unknown> | undefined;
  }

  fence(oldJobId: string, newJobId: string, moduleId: string, revision: number, actor: string, reason: string): void {
    this.ensureSchema();
    this.db.prepare(
      `INSERT OR IGNORE INTO workflow_module_takeovers
        (old_job_id, new_job_id, module_id, revision, actor, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(oldJobId, newJobId, moduleId, revision, actor, reason.slice(0, 1000));
    this.db.prepare(
      `INSERT INTO workflow_module_audit (action, actor, module_id, revision, detail)
       VALUES ('takeover', ?, ?, ?, ?)`,
    ).run(actor, moduleId, revision, JSON.stringify({ oldJobId, newJobId, reason: reason.slice(0, 1000) }));
  }

  fingerprintFor(taskPath: string, prompt: string): string {
    const planHash = /^planHash=([a-f0-9]{64})$/im.exec(prompt)?.[1];
    if (planHash) return planHash.toLowerCase();
    return crypto.createHash('sha256').update([
      'ai-hub-workflow-problem',
      'v1',
      canonical(taskPath).toLowerCase(),
      prompt.replace(/\s+/g, ' ').trim(),
    ].join('\n')).digest('hex');
  }
}

/** Legacy stage/route-class mapping onto fixed modules (backward compat). */
export function moduleForStage(stage: string | null | undefined): WorkflowModuleId {
  switch (String(stage ?? '').trim()) {
    case 'plan': return 'plan';
    case 'review': return 'review';
    case 'execute':
    case 'fix': return 'execute';
    case 'maintenance':
    case 'patrol': return 'maintenance';
    case 'merge': return 'merge';
    case 'deploy': return 'deploy';
    case 'arbitration': return 'arbitration';
    default: return 'execute';
  }
}

export function moduleForRouteClass(routeClass: string | null | undefined): WorkflowModuleId {
  switch (String(routeClass ?? '').trim()) {
    case 'implement':
    case 'fix': return 'execute';
    case 'review': return 'review';
    case 'recon':
    case 'mechanical': return 'maintenance';
    default: return 'execute';
  }
}

/** Legacy stage equivalent for old snapshot readers (merge/deploy/arbitration fold into maintenance). */
export function legacyStageForModule(moduleId: WorkflowModuleId): 'plan' | 'review' | 'execute' | 'fix' | 'maintenance' | 'patrol' {
  switch (moduleId) {
    case 'plan': return 'plan';
    case 'review': return 'review';
    case 'execute': return 'execute';
    default: return 'maintenance';
  }
}

export function isRunnerCompatible(runner: string, permissions: ModulePermissions): boolean {
  // Known adapters apply module tool restrictions and worker claim caps.
  // Read-only jobs lose unsafe native shells on non-Codex adapters. SSH is
  // an application/host capability ceiling, not a new OS isolation layer.
  if (!KNOWN_RUNNERS.has(runner)) return false;
  // A remote read-only closure needs a working networked shell, not merely
  // read tools. Other adapters withhold the terminal to enforce read-only.
  if (permissions.ssh && !permissions.write && permissions.shell) return runner === 'codex';
  if (!permissions.shell && runner === 'codex') return false;
  return true;
}

/** Workflow-room marker: explicit opt-in, never every social room. */
export function isWorkflowRoomConfig(config: Record<string, unknown>): boolean {
  if (!config || typeof config !== 'object') return false;
  if (config.workflowEnabled === false) return false;
  if ((config as Record<string, unknown>).workflowEnabled === true) return true;
  const coordination = (config as Record<string, unknown>).coordination;
  return Boolean(coordination && typeof coordination === 'object' && !Array.isArray(coordination));
}

/**
 * Room governance mode (O1 open-governance).
 * - 'strict': legacy model-driven workflow (default, preserves all rituals).
 * - 'open': five invariants only; task_pass single action + wake budget.
 * Stored in room contacts.config.governance; unknown values fall back to strict.
 */
export type RoomGovernance = 'strict' | 'open';

export function parseRoomGovernance(config: unknown): RoomGovernance {
  if (config && typeof config === 'object') {
    const value = (config as Record<string, unknown>).governance;
    if (value === 'open' || value === 'strict') return value;
  }
  return 'strict';
}

export function isOpenGovernance(config: unknown): boolean {
  return parseRoomGovernance(config) === 'open';
}

/** Derive the owning module from parsed job options (new or legacy shapes). */
export function moduleOfJobOptions(options: Record<string, unknown>): WorkflowModuleId {
  const invocation = options.workflowModule && typeof options.workflowModule === 'object'
    ? options.workflowModule as { moduleId?: unknown }
    : null;
  const candidate = typeof invocation?.moduleId === 'string' ? invocation.moduleId : '';
  if ((WORKFLOW_MODULE_IDS as readonly string[]).includes(candidate)) {
    return candidate as WorkflowModuleId;
  }
  if (options.closureKind === 'merge' || options.closureKind === 'deploy') return options.closureKind;
  const stage = typeof options.workflowStage === 'string' ? options.workflowStage : '';
  if (stage) return moduleForStage(stage);
  const routeClass = typeof options.routeClass === 'string' ? options.routeClass : '';
  return moduleForRouteClass(routeClass);
}

export { poolOf };
