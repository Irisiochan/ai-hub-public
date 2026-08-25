import crypto from 'node:crypto';
import type { Db, JobRow } from '../db.js';
import { modelCatalog } from '../modelCatalog.js';

export type WorkflowRunner = 'claude' | 'codex' | 'grok';
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
  fallback?: WorkflowBinding;
  fallbackAfter?: number;
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
  fallback?: WorkflowBinding;
  fallbackAfter?: number;
  fallbackActive: boolean;
  selected: WorkflowBinding;
  workflowFingerprint: string;
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
    review: { primary: { runner: 'claude', model: 'fable', reasoning: 'high' } },
    execute: { primary: { runner: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' } },
    fix: { primary: { runner: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' } },
    maintenance: { primary: { runner: 'grok', model: 'grok-4.6', reasoning: 'high' } },
    patrol: { primary: { runner: 'grok', model: 'grok-4.6', reasoning: 'high' } },
  },
  capabilities: { deepseekBulkHarness: 'unavailable' },
};

const B: WorkflowProfile = {
  id: 'protocol-b',
  version: 1,
  label: 'B · Codex / Grok 双引擎',
  description: 'Codex 规划与评审，Grok 执行；连续三次质量未收敛后切换兜底。',
  routes: {
    plan: { primary: { runner: 'codex', model: 'gpt-5.6-sol', reasoning: 'ultra' } },
    review: {
      primary: { runner: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' },
      fallback: { runner: 'claude', model: 'claude-opus-4-7', reasoning: 'high' },
      fallbackAfter: 3,
    },
    execute: {
      primary: { runner: 'grok', model: 'grok-4.6', reasoning: 'high' },
      fallback: { runner: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' },
      fallbackAfter: 3,
    },
    fix: {
      primary: { runner: 'grok', model: 'grok-4.6', reasoning: 'high' },
      fallback: { runner: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium' },
      fallbackAfter: 3,
    },
    maintenance: { primary: { runner: 'grok', model: 'grok-4.6', reasoning: 'high' } },
    patrol: { primary: { runner: 'grok', model: 'grok-4.6', reasoning: 'high' } },
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
    const codexEfforts: WorkflowEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    for (const [stage, route] of Object.entries(profile.routes) as [WorkflowStage, WorkflowRoute][]) {
      for (const [kind, binding] of [['primary', route.primary], ['fallback', route.fallback]] as const) {
        if (!binding) continue;
        if (!/^[a-zA-Z0-9._-]{1,100}$/.test(binding.model)) {
          errors.push(`${stage}.${kind} model id is invalid`);
        }
        if (binding.runner === 'claude') {
          if (!claude.models.some((item) => item.id === binding.model)) {
            errors.push(`${stage}.${kind} Claude model ${binding.model} is absent from the hot catalog`);
          }
          if (!claude.efforts?.some((item) => item.id === binding.reasoning)) {
            errors.push(`${stage}.${kind} Claude effort ${binding.reasoning} is unavailable`);
          }
        }
        if (binding.runner === 'grok' && !grok.models.some((item) => item.id === binding.model)) {
          errors.push(`${stage}.${kind} Grok model ${binding.model} is absent from the hot catalog`);
        }
        if (binding.runner === 'codex' && !codexEfforts.includes(binding.reasoning)) {
          errors.push(`${stage}.${kind} Codex effort ${binding.reasoning} is unavailable`);
        }
        if (binding.reasoning === 'ultra' && binding.runner !== 'codex') {
          errors.push(`${stage}.${kind} ultra is only supported by Codex`);
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
    const streak = this.streak(profile, input.stage, taskPath, input.problemFingerprint, route.primary);
    const fallbackActive = !!route.fallback && streak.fallback_active === 1;
    const selected = fallbackActive ? route.fallback! : route.primary;
    const base: Omit<WorkflowSnapshot, 'workflowFingerprint'> = {
      profileId: profile.id,
      profileVersion: profile.version,
      profileLabel: profile.label,
      stage: input.stage,
      taskPath,
      problemFingerprint: input.problemFingerprint,
      primary: route.primary,
      ...(route.fallback ? { fallback: route.fallback } : {}),
      ...(route.fallbackAfter ? { fallbackAfter: route.fallbackAfter } : {}),
      fallbackActive,
      selected,
    };
    return { ...base, workflowFingerprint: workflowFingerprint(base) };
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
          reason: 'manual runner overrides do not affect profile fallback streaks',
        } as const;
      }
      if (input.quality === 'infrastructure') {
        return { counted: false, reason: 'infrastructure failures do not affect quality streaks' } as const;
      }
      if (input.quality === 'success') {
        this.db.prepare(
          `DELETE FROM workflow_quality_streaks
           WHERE profile_id = ? AND profile_version = ? AND task_path = ? AND stage = ?
             AND problem_fingerprint = ? AND primary_runner = ? AND primary_model = ?`
        ).run(...key);
        return { counted: true, streak: 0, fallbackActive: false } as const;
      }
      const threshold = route.fallback && route.fallbackAfter ? route.fallbackAfter : null;
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
      const updated = this.streak(
        findProfile(snapshot.profileId, snapshot.profileVersion)!,
        snapshot.stage,
        snapshot.taskPath,
        snapshot.problemFingerprint,
        snapshot.primary,
      );
      return {
        counted: true,
        streak: updated.streak,
        fallbackActive: updated.fallback_active === 1,
        threshold,
      } as const;
    })();
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
