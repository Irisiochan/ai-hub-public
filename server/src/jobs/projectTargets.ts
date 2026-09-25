/**
 * G02 target freeze (simplified): config-driven VPS project-target mapping.
 *
 * The mapping table lives in `server/config.json` (`projectTargets`), is
 * validated by `normalizeProjectTargets` in config.ts, and defaults to empty.
 * There are NO built-in worker/workspace/runner/ssh defaults: with no config
 * every lookup misses and all PC dispatch flows see zero behavior change.
 *
 * Kept surface: resolve / match / enforceDispatchTarget /
 * checkProjectTargetClaim / fenced attempt-directory derivation. Dropped from
 * the old branch: baseSha freeze helpers, assertJobTarget, review-workspace
 * builders, sibling-workspace helpers — the room_tasks.baseline_sha column
 * (migration 0037_room_task_baseline) stays the single baseline authority.
 */

import {
  normalizeProjectTargetEntry,
  type ProjectTargetConfig,
} from '../platform/index.js';

export interface ProjectTarget {
  repoId: string;
  platform: 'linux' | 'win32';
  workerId: string;
  /** Mapped root for resolve(); concrete attempt dir once stamped per attempt. */
  workspace: string;
  requiredCapabilities: { runners: string[]; shell: boolean; ssh: boolean };
  /** Reserved null in G02: no second baseline authority beside baseline_sha. */
  baseSha: string | null;
}

/** Anything resolve()/match() accept as the configured mapping table. */
export type ProjectTargetsInput =
  | Record<string, ProjectTargetConfig>
  | ProjectTargetConfig[]
  | { projectTargets?: Record<string, ProjectTargetConfig> | ProjectTargetConfig[] | null }
  | null
  | undefined;

function entriesOf(targets: ProjectTargetsInput): ProjectTargetConfig[] {
  const raw: unknown = targets && typeof targets === 'object' && !Array.isArray(targets) && 'projectTargets' in (targets as Record<string, unknown>)
    ? (targets as { projectTargets?: unknown }).projectTargets
    : targets;
  if (!raw || typeof raw !== 'object') return [];
  const items: unknown[] = Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>);
  const out: ProjectTargetConfig[] = [];
  for (const item of items) {
    const normalized = normalizeProjectTargetEntry(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

function toProjectTarget(entry: ProjectTargetConfig): ProjectTarget {
  return {
    repoId: entry.repoId,
    platform: entry.platform,
    workerId: entry.workerId,
    workspace: entry.workspace,
    requiredCapabilities: {
      runners: [...entry.runners],
      shell: entry.shell === true,
      ssh: entry.ssh,
    },
    baseSha: null,
  };
}

/** Resolve a repoId against the configured mapping; null on miss OR no config. */
export function resolveProjectTarget(repoId: string, targets?: ProjectTargetsInput): ProjectTarget | null {
  const key = String(repoId ?? '').trim();
  if (!key) return null;
  for (const entry of entriesOf(targets)) {
    if (entry.repoId === key) return toProjectTarget(entry);
  }
  return null;
}

function isWindowsPath(text: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(text) || /^\\\\[^\\]+\\[^\\/]+/.test(text);
}

function isUrl(text: string): boolean {
  return /^https?:\/\//i.test(text) || text.includes('://') || /\.git\s*$/i.test(text);
}

/**
 * Reverse lookup: workspace inside a mapped root yields its target.
 * Windows paths and repository URLs never match — they are not VPS targets.
 * Nested roots resolve to the deepest one, independent of config order
 * (ai-dashboard declared first at /srv/ai-dev/jobs once swallowed ai-hub).
 */
export function matchWorkspaceTarget(workspace: string, targets?: ProjectTargetsInput): ProjectTarget | null {
  const text = String(workspace ?? '').trim();
  if (!text || isWindowsPath(text) || isUrl(text)) return null;
  let best: ReturnType<typeof entriesOf>[number] | null = null;
  for (const entry of entriesOf(targets)) {
    if (text === entry.workspace || text.startsWith(`${entry.workspace}/`)) {
      if (!best || entry.workspace.length > best.workspace.length) best = entry;
    }
  }
  return best ? toProjectTarget(best) : null;
}

export interface DispatchTargetCheck {
  workspace: string;
  workerId: string | null;
  runner: string;
  ssh: boolean;
}

/**
 * Dispatch-time freeze: a workspace inside a mapped target must keep the
 * mapped worker, a mapped runner, and the mapped ssh grant. Anything outside
 * mapped targets passes through untouched (projectTarget null).
 */
export function enforceDispatchTarget(
  input: DispatchTargetCheck,
  targets?: ProjectTargetsInput,
):
  | { ok: true; projectTarget: ProjectTarget | null }
  | { ok: false; error: string } {
  const target = matchWorkspaceTarget(input.workspace, targets);
  if (!target) return { ok: true, projectTarget: null };
  const workerId = String(input.workerId ?? '').trim();
  if (workerId !== target.workerId) {
    return {
      ok: false,
      error: `workspace 属于 VPS 试点映射 ${target.repoId}，仅允许 worker=${target.workerId} 认领；`
        + `当前联系人 delegation.workerId=${workerId || '（未固定）'}，先固定后再派单`,
    };
  }
  if (!target.requiredCapabilities.runners.includes(String(input.runner ?? ''))) {
    return {
      ok: false,
      error: `VPS 试点映射 ${target.repoId} 仅允许 runner=${target.requiredCapabilities.runners.join('/')}；`
        + `runner=${String(input.runner ?? '')} 不可派到 ${target.workspace}`,
    };
  }
  if (input.ssh === true && target.requiredCapabilities.ssh !== true) {
    return {
      ok: false,
      error: `VPS 试点映射 ${target.repoId} 未开放 SSH；远程部署只能登记 deploy-tail，不得传 ssh=true`,
    };
  }
  return { ok: true, projectTarget: target };
}

/**
 * Claim isolation: a job carrying a frozen `options.projectTarget` may only
 * be claimed by the mapped worker, with a runner inside the frozen set and
 * without ungranted SSH. The stamped target is the freeze authority (not the
 * live mapping), so attempts dispatched before a mapping change keep their
 * frozen isolation. Jobs without a frozen target are unaffected.
 */
export function checkProjectTargetClaim(input: {
  options: unknown;
  workerId: string;
  runner: string;
  ssh: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const raw = input.options;
  let parsed: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ok: true };
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    parsed = raw as Record<string, unknown>;
  } else {
    return { ok: true };
  }
  const frozen = parsed.projectTarget;
  if (!frozen || typeof frozen !== 'object' || Array.isArray(frozen)) return { ok: true };
  const stamp = frozen as Record<string, unknown>;
  const repoId = typeof stamp.repoId === 'string' && stamp.repoId ? stamp.repoId : 'unknown-repo';
  const pinned = typeof stamp.workerId === 'string' ? stamp.workerId.trim() : '';
  if (!pinned) {
    return { ok: false, reason: `frozen VPS attempt ${repoId} 缺少 worker 固定，不允许认领` };
  }
  if (String(input.workerId ?? '').trim() !== pinned) {
    return {
      ok: false,
      reason: `frozen VPS attempt ${repoId} 仅允许 worker=${pinned} 认领；worker=${String(input.workerId ?? '').trim() || '（未知）'} 不得接管`,
    };
  }
  const caps = stamp.requiredCapabilities;
  if (caps && typeof caps === 'object' && !Array.isArray(caps)) {
    const runners = (caps as Record<string, unknown>).runners;
    if (Array.isArray(runners) && !runners.map(String).includes(String(input.runner ?? ''))) {
      return {
        ok: false,
        reason: `frozen VPS attempt ${repoId} 仅允许 runner=${runners.map(String).join('/')}；runner=${String(input.runner ?? '')} 不得认领`,
      };
    }
    if (input.ssh === true && (caps as Record<string, unknown>).ssh !== true) {
      return {
        ok: false,
        reason: `frozen VPS attempt ${repoId} 未开放 SSH；不得以 ssh=true 认领`,
      };
    }
  }
  return { ok: true };
}

// ── fenced layout ──────────────────────────────────────────────────────
// Mapped root itself is never a task workspace: tasks register
// `<root>/<taskSlug>` (depth 1) and every formal attempt lands in
// `<root>/<taskSlug>/<attemptSlug>/<repoId>` (depth 3). Every segment is a
// strict slug so `..`, empty segments, and shell/path injections can never
// escape the fence.

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_FENCE_DEPTH = 6;
const REVIEW_SLUG_RE = /^review-[0-9a-f]{7,64}$/i;

export function slugSegment(value: string): string | null {
  const text = String(value ?? '').trim();
  return SLUG_RE.test(text) ? text : null;
}

/** Reserved `review-<hex>` prefix (isolated review checkouts); never a task/attempt slug. */
export function isReservedReviewSlug(slug: string): boolean {
  return REVIEW_SLUG_RE.test(String(slug ?? '').trim());
}

export interface ClassifiedTargetWorkspace {
  target: ProjectTarget;
  /** Segments below the mapped root: 0 means the mapped root itself. */
  depth: number;
  segments: string[];
}

/**
 * Classify a workspace against the configured targets. Null for anything
 * not strictly inside a mapped fence (PC paths, URLs, dot segments,
 * over-deep nesting, non-slug segments) or when no targets are configured.
 */
export function classifyTargetWorkspace(
  workspace: string,
  targets?: ProjectTargetsInput,
): ClassifiedTargetWorkspace | null {
  const target = matchWorkspaceTarget(workspace, targets);
  if (!target) return null;
  const text = String(workspace ?? '').trim().replace(/\/+$/, '');
  const rel = text === target.workspace ? '' : text.slice(target.workspace.length + 1);
  const segments = rel ? rel.split('/') : [];
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  if (segments.length > MAX_FENCE_DEPTH) return null;
  if (segments.some((segment) => slugSegment(segment) === null)) return null;
  return { target, depth: segments.length, segments };
}

/** Register a fenced per-task workspace `<root>/<taskSlug>` for a repo. */
export function buildTaskWorkspace(repoId: string, taskSlug: string, targets?: ProjectTargetsInput): string {
  const target = resolveProjectTarget(repoId, targets);
  if (!target) throw new Error(`unknown repoId: ${repoId}`);
  const slug = slugSegment(taskSlug);
  if (!slug) throw new Error('task slug must be 1-64 chars of [A-Za-z0-9_-], starting with alnum');
  if (isReservedReviewSlug(slug)) {
    throw new Error('task slug prefix review-<sha> is reserved for isolated review checkouts');
  }
  return `${target.workspace}/${slug}`;
}

/**
 * Derive a fenced attempt directory `<taskWorkspace>/<attemptSlug>/<repoId>`
 * (`<root>/<task>/<attempt>/<repo>`, exactly 3 segments below the root).
 * The parent must be the task fence itself (`<root>/<taskSlug>`, depth 1)
 * so attempts are always siblings — never nested under a previous attempt.
 * Anything outside the fence throws; callers fail closed.
 */
export function buildExecutionAttemptWorkspace(
  taskWorkspace: string,
  attemptSlug: string,
  repoId: string,
  targets?: ProjectTargetsInput,
): string {
  const parent = classifyTargetWorkspace(taskWorkspace, targets);
  if (!parent || parent.depth !== 1) {
    throw new Error('execution attempt parent must be a fenced task workspace <root>/<taskSlug>');
  }
  const slug = slugSegment(attemptSlug);
  if (!slug) throw new Error('attempt slug must be 1-64 chars of [A-Za-z0-9_-], starting with alnum');
  if (isReservedReviewSlug(slug)) {
    throw new Error('attempt slug prefix review-<sha> is reserved for isolated review checkouts');
  }
  const repo = String(repoId ?? '').trim();
  const target = resolveProjectTarget(repo, targets);
  if (!target) throw new Error(`unknown repoId: ${repoId}`);
  if (target.repoId !== parent.target.repoId) {
    throw new Error('execution attempt escapes the mapped VPS target fence');
  }
  const composed = `${String(taskWorkspace).trim().replace(/\/+$/, '')}/${slug}/${target.repoId}`;
  const fenced = classifyTargetWorkspace(composed, targets);
  if (!fenced || fenced.depth !== 3 || fenced.segments[0] !== parent.segments[0] || fenced.segments[2] !== target.repoId) {
    throw new Error('execution attempt escapes the mapped VPS target fence');
  }
  return composed;
}
