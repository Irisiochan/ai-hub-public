import crypto from 'node:crypto';
import type { Db, JobRow } from '../platform/index.js';
import { modelCatalog } from '../contacts/index.js';

export type WorkflowRunner = 'claude' | 'codex' | 'grok' | 'opencode';
export type WorkflowEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type WorkflowStage = 'plan' | 'review' | 'execute' | 'fix' | 'maintenance' | 'patrol';
export type WorkflowQuality = 'success' | 'inadequate' | 'infrastructure';

export interface WorkflowBinding {
  runner: WorkflowRunner;
  model: string;
  reasoning: WorkflowEffort;
}

export interface WorkflowRoute {
  primary: WorkflowBinding;
  /** 连续 inadequate 次数达到后：有 upgrade 则改用 upgrade，否则转人工。 */
  escalateAfter?: number;
  /** 执行/修复未收敛时的升级出口（Profile B：Sora 两轮后交给 Astra 判断方案）。 */
  upgrade?: WorkflowBinding;
}

export interface WorkflowProfile {
  id: string;
  version: number;
  label: string;
  description: string;
  routes: Record<WorkflowStage, WorkflowRoute>;
  capabilities: {
    deepseekBulkHarness: 'unavailable' | 'planned' | 'available';
  };
}

export interface WorkflowSnapshot {
  profileId: string;
  profileVersion: number;
  profileLabel: string;
  stage: WorkflowStage;
  taskPath: string;
  problemFingerprint: string;
  primary: WorkflowBinding;
  escalateAfter?: number;
  escalateToHuman: boolean;
  /** @deprecated 与 escalateToHuman 同值，兼容旧 job 快照与前端 */
  fallbackActive: boolean;
  selected: WorkflowBinding;
  workflowFingerprint: string;
}

export const WORKFLOW_HUMAN_ESCALATION_ERROR =
  '该问题已质量未收敛并转人工。需要 User 决定下一步；若要继续，请显式覆盖 runner。';

export function selectionForStreak(route: WorkflowRoute, streak: number): {
  selected: WorkflowBinding
  escalateToHuman: boolean
  upgradeActive: boolean
} {
  const after = route.escalateAfter;
  if (!after || streak < after) {
    return { selected: route.primary, escalateToHuman: false, upgradeActive: false };
  }
  const upgraded = Boolean(route.upgrade);
  const selected = upgraded ? route.upgrade! : route.primary;
  const escalateToHuman = streak >= after + (upgraded ? 1 : 0);
  return { selected, escalateToHuman, upgradeActive: upgraded && !escalateToHuman };
}

export interface WorkflowQualityInput {
  quality: WorkflowQuality;
  detail?: string;
}

const A: WorkflowProfile = {
  id: 'protocol-a',
  version: 1,
  label: 'A · Fable / Codex / Grok',
  description: 'Fable 负责 Plan/Review，Codex 执行，Grok 维护与巡逻。',
  routes: {
    plan: { primary: { runner: 'claude', model: 'fable', reasoning: 'high' } },
    review: { primary: { runner: 'grok', model: 'grok-4.6', reasoning: 'high' } },
    execute: { primary: { runner: 'codex', model: 'gpt-6-astra', reasoning: 'medium' } },
    fix: { primary: { runner: 'codex', model: 'gpt-6-astra', reasoning: 'medium' } },
    maintenance: { primary: { runner: 'grok', model: 'grok-4.6', reasoning: 'high' } },
    patrol: { primary: { runner: 'grok', model: 'grok-4.6', reasoning: 'high' } },
  },
  capabilities: { deepseekBulkHarness: 'unavailable' },
};

const B: WorkflowProfile = {
  id: 'protocol-b',
  version: 1,
  label: 'B · Codex / Sora / Grok',
  description: 'Codex Astra 规划，Sora 执行，Grok 独立评审；修复两轮未收敛升 Astra；巡逻 medium，健康检查先走脚本。',
  routes: {
    plan: { primary: { runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' } },
    review: {
      primary: { runner: 'grok', model: 'grok-4.6', reasoning: 'high' },
      escalateAfter: 3,
    },
    execute: {
      primary: { runner: 'opencode', model: 'opencode-go/muse-spark-1.3-contributor', reasoning: 'high' },
      escalateAfter: 2,
      upgrade: { runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' },
    },
    fix: {
      primary: { runner: 'opencode', model: 'opencode-go/muse-spark-1.3-contributor', reasoning: 'high' },
      escalateAfter: 2,
      upgrade: { runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' },
    },
    maintenance: { primary: { runner: 'grok', model: 'grok-4.6', reasoning: 'medium' } },
    patrol: { primary: { runner: 'grok', model: 'grok-4.6', reasoning: 'medium' } },
  },
  capabilities: { deepseekBulkHarness: 'planned' },
};

export const WORKFLOW_PROFILES: readonly WorkflowProfile[] = [A, B];

const ROUTE_STAGE: Record<string, WorkflowStage> = {
  implement: 'execute',
  fix: 'fix',
  review: 'review',
  recon: 'patrol',
  mechanical: 'maintenance',
};

function profileKey(id: string, version: number): string {
  return `${id}@${version}`;
}

function findProfile(id: string, version: number): WorkflowProfile | undefined {
  return WORKFLOW_PROFILES.find((profile) => profile.id === id && profile.version === version);
}

function canonical(value: string): string {
  return String(value ?? '').trim().replaceAll('\\', '/');
}

export function stageForRouteClass(routeClass: string | null | undefined): WorkflowStage {
  return ROUTE_STAGE[String(routeClass ?? '').trim()] ?? 'execute';
}

export function isImplementationStage(stage: WorkflowStage | string | null | undefined): stage is 'execute' | 'fix' {
  return stage === 'execute' || stage === 'fix';
}

export function problemFingerprint(prompt: string, taskPath = ''): string {
  const planHash = /^planHash=([a-f0-9]{64})$/im.exec(prompt)?.[1];
  if (planHash) return planHash.toLowerCase();
  return crypto.createHash('sha256').update([
    'ai-hub-workflow-problem',
    'v1',
    canonical(taskPath).toLowerCase(),
    prompt.replace(/\s+/g, ' ').trim(),
  ].join('\n')).digest('hex');
}

export function workflowFingerprint(snapshot: Omit<WorkflowSnapshot, 'workflowFingerprint'>): string {
  return crypto.createHash('sha256').update([
    'ai-hub-workflow',
    'v3',
    snapshot.profileId,
    String(snapshot.profileVersion),
    snapshot.stage,
    canonical(snapshot.taskPath).toLowerCase(),
    snapshot.problemFingerprint.toLowerCase(),
    snapshot.selected.runner,
    snapshot.selected.model,
    snapshot.selected.reasoning,
  ].join('\n')).digest('hex');
}

type ProfileStateRow = {
  active_profile_id: string;
  active_profile_version: number;
  previous_profile_id: string | null;
  previous_profile_version: number | null;
  updated_by: string;
  updated_at: string;
};

type StreakRow = { streak: number; fallback_active: number };

export class WorkflowProfileStore {
  constructor(private readonly db: Db) {}

  list(): WorkflowProfile[] {
    return WORKFLOW_PROFILES.map((profile) => structuredClone(profile));
  }

  state(): ProfileStateRow & { active: WorkflowProfile; previous: WorkflowProfile | null } {
    const row = this.db.prepare(
      'SELECT active_profile_id, active_profile_version, previous_profile_id, previous_profile_version, updated_by, updated_at FROM workflow_profile_state WHERE singleton = 1'
    ).get() as ProfileStateRow;
    const active = findProfile(row.active_profile_id, row.active_profile_version);
    if (!active) throw new Error(`unknown active workflow profile ${profileKey(row.active_profile_id, row.active_profile_version)}`);
    const previous = row.previous_profile_id && row.previous_profile_version
      ? findProfile(row.previous_profile_id, row.previous_profile_version) ?? null
      : null;
    return { ...row, active: structuredClone(active), previous: previous ? structuredClone(previous) : null };
  }

  preview(id: string, version: number) {
    const current = this.state().active;
    const target = findProfile(id, version);
    if (!target) return { error: 'workflow profile not found' } as const;
    const changes = (Object.keys(current.routes) as WorkflowStage[]).flatMap((stage) => {
      const from = current.routes[stage];
      const to = target.routes[stage];
      return JSON.stringify(from) === JSON.stringify(to) ? [] : [{ stage, from, to }];
    });
    return { current, target: structuredClone(target), changes, validation: this.validate(target) };
  }

  switchTo(id: string, version: number, actor: string) {
    const preview = this.preview(id, version);
    if ('error' in preview) return preview;
    if (!preview.validation.ok) {
      return { error: `workflow profile activation blocked: ${preview.validation.errors.join('; ')}` } as const;
    }
    if (preview.current.id === id && preview.current.version === version) {
      return { active: preview.current, changed: false, changes: [] };
    }
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `UPDATE workflow_profile_state
         SET previous_profile_id = active_profile_id,
             previous_profile_version = active_profile_version,
             active_profile_id = ?, active_profile_version = ?, updated_by = ?, updated_at = datetime('now')
         WHERE singleton = 1`
      ).run(id, version, actor);
      this.db.prepare(
        `INSERT INTO workflow_profile_audit
         (action, actor, from_profile_id, from_profile_version, to_profile_id, to_profile_version, detail)
         VALUES ('switch', ?, ?, ?, ?, ?, ?)`
      ).run(actor, preview.current.id, preview.current.version, id, version, JSON.stringify({ changes: preview.changes }));
    });
    tx();
    return { active: structuredClone(preview.target), changed: true, changes: preview.changes };
  }

  rollback(actor: string) {
    const state = this.state();
    if (!state.previous) return { error: 'no previous workflow profile' } as const;
    const target = state.previous;
    const outcome = this.switchTo(target.id, target.version, actor);
    if ('error' in outcome) return outcome;
    this.db.prepare(
      `UPDATE workflow_profile_audit SET action = 'rollback'
       WHERE id = (SELECT MAX(id) FROM workflow_profile_audit)`
    ).run();
    return outcome;
  }

  audit(limit = 30) {
    return this.db.prepare(
      `SELECT * FROM workflow_profile_audit ORDER BY id DESC LIMIT ?`
    ).all(Math.min(Math.max(limit, 1), 100));
  }

  validate(profile: WorkflowProfile) {
    const errors: string[] = [];
    const claude = modelCatalog('claude-cli');
    const grok = modelCatalog('grok-cli');
    const opencode = modelCatalog('opencode-cli');
    const codexEfforts: WorkflowEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const opencodeModel = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]{1,80}$/;
    for (const [stage, route] of Object.entries(profile.routes) as [WorkflowStage, WorkflowRoute][]) {
      const binding = route.primary;
      if (binding.runner === 'opencode') {
        if (!opencodeModel.test(binding.model) || binding.model.length > 120) {
          errors.push(`${stage}.primary model id is invalid`);
        }
      } else if (!/^[a-zA-Z0-9._-]{1,100}$/.test(binding.model)) {
        errors.push(`${stage}.primary model id is invalid`);
      }
      if (binding.runner === 'claude') {
        if (!claude.models.some((item) => item.id === binding.model)) {
          errors.push(`${stage}.primary Claude model ${binding.model} is absent from the hot catalog`);
        }
        if (!claude.efforts?.some((item) => item.id === binding.reasoning)) {
          errors.push(`${stage}.primary Claude effort ${binding.reasoning} is unavailable`);
        }
      }
      if (binding.runner === 'grok' && !grok.models.some((item) => item.id === binding.model)) {
        errors.push(`${stage}.primary Grok model ${binding.model} is absent from the hot catalog`);
      }
      if (binding.runner === 'opencode') {
        if (!opencode.models.some((item) => item.id === binding.model)) {
          errors.push(`${stage}.primary OpenCode model ${binding.model} is absent from the hot catalog`);
        }
        if (opencode.efforts?.length && !opencode.efforts.some((item) => item.id === binding.reasoning)) {
          errors.push(`${stage}.primary OpenCode effort ${binding.reasoning} is unavailable`);
        }
      }
      if (binding.runner === 'codex' && !codexEfforts.includes(binding.reasoning)) {
        errors.push(`${stage}.primary Codex effort ${binding.reasoning} is unavailable`);
      }
      if (binding.reasoning === 'ultra' && binding.runner !== 'codex') {
        errors.push(`${stage}.primary ultra is only supported by Codex`);
      }
      if (route.escalateAfter !== undefined) {
        const after = route.escalateAfter;
        if (!Number.isInteger(after) || after < 1 || after > 10) {
          errors.push(`${stage}.escalateAfter must be an integer between 1 and 10`);
        }
      }
      if (route.upgrade) {
        const upgrade = route.upgrade;
        if (upgrade.runner === 'opencode') {
          if (!opencodeModel.test(upgrade.model) || upgrade.model.length > 120) {
            errors.push(`${stage}.upgrade model id is invalid`);
          }
        } else if (!/^[a-zA-Z0-9._-]{1,100}$/.test(upgrade.model)) {
          errors.push(`${stage}.upgrade model id is invalid`);
        }
        if (upgrade.runner === 'codex' && !codexEfforts.includes(upgrade.reasoning)) {
          errors.push(`${stage}.upgrade Codex effort ${upgrade.reasoning} is unavailable`);
        }
        if (upgrade.runner === 'grok' && !grok.models.some((item) => item.id === upgrade.model)) {
          errors.push(`${stage}.upgrade Grok model ${upgrade.model} is absent from the hot catalog`);
        }
        if (upgrade.reasoning === 'ultra' && upgrade.runner !== 'codex') {
          errors.push(`${stage}.upgrade ultra is only supported by Codex`);
        }
      }
    }
    return { ok: errors.length === 0, errors };
  }

  snapshot(input: {
    stage: WorkflowStage;
    taskPath?: string;
    problemFingerprint: string;
  }): WorkflowSnapshot {
    const profile = this.state().active;
    const route = profile.routes[input.stage];
    const taskPath = canonical(input.taskPath ?? '');
    const count = this.effectiveStreak(profile, input.stage, taskPath, input.problemFingerprint);
    const decision = selectionForStreak(route, count);
    const base: Omit<WorkflowSnapshot, 'workflowFingerprint'> = {
      profileId: profile.id,
      profileVersion: profile.version,
      profileLabel: profile.label,
      stage: input.stage,
      taskPath,
      problemFingerprint: input.problemFingerprint,
      primary: route.primary,
      ...(route.escalateAfter ? { escalateAfter: route.escalateAfter } : {}),
      escalateToHuman: decision.escalateToHuman,
      fallbackActive: decision.escalateToHuman,
      selected: decision.selected,
    };
    return { ...base, workflowFingerprint: workflowFingerprint(base) };
  }

  isEscalatedToHuman(snapshot: Pick<
    WorkflowSnapshot,
    'profileId' | 'profileVersion' | 'stage' | 'taskPath' | 'problemFingerprint' | 'primary'
  > & { escalateToHuman?: boolean; fallbackActive?: boolean }): boolean {
    const profile = findProfile(snapshot.profileId, snapshot.profileVersion);
    if (!profile) return snapshot.escalateToHuman === true || snapshot.fallbackActive === true;
    const route = profile.routes[snapshot.stage];
    if (!route?.escalateAfter) return false;
    const count = this.effectiveStreak(
      profile,
      snapshot.stage,
      snapshot.taskPath,
      snapshot.problemFingerprint,
    );
    return selectionForStreak(route, count).escalateToHuman;
  }

  record(job: JobRow, input: WorkflowQualityInput) {
    const options = (() => {
      try { return JSON.parse(job.options || '{}') as Record<string, unknown>; } catch { return {}; }
    })();
    const snapshot = options.workflow as WorkflowSnapshot | undefined;
    if (!snapshot?.profileId || !snapshot.problemFingerprint || !snapshot.primary) {
      return { error: 'job has no workflow snapshot' } as const;
    }
    const route = findProfile(snapshot.profileId, snapshot.profileVersion)?.routes[snapshot.stage];
    if (!route) return { error: 'workflow snapshot references an unknown profile route' } as const;
    const priorEvent = this.db.prepare(
      'SELECT quality FROM workflow_quality_events WHERE job_id = ?'
    ).get(job.id) as { quality: WorkflowQuality } | undefined;
    if (priorEvent) {
      return { counted: false, reason: 'job quality already recorded', quality: priorEvent.quality } as const;
    }
    if (input.quality === 'success' && isImplementationStage(snapshot.stage)) {
      return {
        counted: false,
        reason: 'implementation self-report does not clear quality streaks; independent review APPROVE does',
      } as const;
    }
    const key = [
      snapshot.profileId,
      snapshot.profileVersion,
      snapshot.taskPath,
      snapshot.stage,
      snapshot.problemFingerprint,
      snapshot.primary.runner,
      snapshot.primary.model,
    ];
    return this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO workflow_quality_events
         (job_id, profile_id, profile_version, stage, problem_fingerprint, quality, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        job.id,
        snapshot.profileId,
        snapshot.profileVersion,
        snapshot.stage,
        snapshot.problemFingerprint,
        input.quality,
        String(input.detail ?? '').slice(0, 2000),
      );
      if (options.runnerSource === 'override') {
        return {
          counted: false,
          reason: 'manual runner overrides do not affect profile quality streaks',
        } as const;
      }
      if (input.quality === 'infrastructure') {
        return { counted: false, reason: 'infrastructure failures do not affect quality streaks' } as const;
      }
      if (input.quality === 'success') {
        if (snapshot.stage === 'review') {
          this.clearImplementationStreaks(snapshot);
        }
        this.db.prepare(
          `DELETE FROM workflow_quality_streaks
           WHERE profile_id = ? AND profile_version = ? AND task_path = ? AND stage = ?
             AND problem_fingerprint = ? AND primary_runner = ? AND primary_model = ?`
        ).run(...key);
        return { counted: true, streak: 0, fallbackActive: false, escalateToHuman: false } as const;
      }
      const threshold = route.escalateAfter ?? null;
      this.db.prepare(
        `INSERT INTO workflow_quality_streaks
         (profile_id, profile_version, task_path, stage, problem_fingerprint, primary_runner, primary_model,
          streak, fallback_active, last_quality, last_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'inadequate', ?)
         ON CONFLICT(profile_id, profile_version, task_path, stage, problem_fingerprint, primary_runner, primary_model)
         DO UPDATE SET streak = workflow_quality_streaks.streak + 1,
           fallback_active = CASE WHEN ? IS NOT NULL AND workflow_quality_streaks.streak + 1 >= ? THEN 1 ELSE workflow_quality_streaks.fallback_active END,
           last_quality = 'inadequate', last_detail = excluded.last_detail, updated_at = datetime('now')`
      ).run(...key, threshold === 1 ? 1 : 0, String(input.detail ?? '').slice(0, 2000), threshold, threshold);
      const count = this.effectiveStreak(
        findProfile(snapshot.profileId, snapshot.profileVersion)!,
        snapshot.stage,
        snapshot.taskPath,
        snapshot.problemFingerprint,
      );
      const decision = selectionForStreak(route, count);
      return {
        counted: true,
        streak: count,
        fallbackActive: decision.escalateToHuman,
        escalateToHuman: decision.escalateToHuman,
        upgradeActive: decision.upgradeActive,
        threshold,
      } as const;
    })();
  }

  private clearImplementationStreaks(snapshot: Pick<
    WorkflowSnapshot,
    'profileId' | 'profileVersion' | 'taskPath' | 'problemFingerprint'
  >): void {
    this.db.prepare(
      `DELETE FROM workflow_quality_streaks
       WHERE profile_id = ? AND profile_version = ? AND task_path = ?
         AND stage IN ('execute', 'fix') AND problem_fingerprint = ?`
    ).run(snapshot.profileId, snapshot.profileVersion, snapshot.taskPath, snapshot.problemFingerprint);
  }

  private effectiveStreak(
    profile: WorkflowProfile,
    stage: WorkflowStage,
    taskPath: string,
    fingerprint: string,
  ): number {
    if (isImplementationStage(stage)) {
      return this.streak(profile, 'execute', taskPath, fingerprint, profile.routes.execute.primary).streak
        + this.streak(profile, 'fix', taskPath, fingerprint, profile.routes.fix.primary).streak;
    }
    return this.streak(profile, stage, taskPath, fingerprint, profile.routes[stage].primary).streak;
  }

  private streak(
    profile: WorkflowProfile,
    stage: WorkflowStage,
    taskPath: string,
    fingerprint: string,
    primary: WorkflowBinding,
  ): StreakRow {
    return (this.db.prepare(
      `SELECT streak, fallback_active FROM workflow_quality_streaks
       WHERE profile_id = ? AND profile_version = ? AND task_path = ? AND stage = ?
         AND problem_fingerprint = ? AND primary_runner = ? AND primary_model = ?`
    ).get(profile.id, profile.version, taskPath, stage, fingerprint, primary.runner, primary.model) as StreakRow | undefined)
      ?? { streak: 0, fallback_active: 0 };
  }
}
