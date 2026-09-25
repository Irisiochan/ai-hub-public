import crypto from 'node:crypto';
import type { ContactRow } from '../platform/index.js';
import { contactConfig } from '../contacts/index.js';
import { DEFAULT_ROOM_ORCHESTRATOR_ID, resolveRoomOrchestratorId } from '../rooms/index.js';
import {
  WORKFLOW_MODULES,
  isWorkflowRoomConfig,
  runnerForBackend,
  type ModuleBinding,
  type ModulePermissions,
  type WorkflowModuleId,
  type WorkflowModulesStore,
} from './workflowModules.js';

/**
 * Module invocation authority for room turns and gateway/MCP dispatch.
 *
 * A capability is always derived server-side from a trusted source (the
 * current binding for NEW turns, the captured room-host snapshot for
 * in-flight rounds). Caller input (route_class, runner/model/effort flags,
 * override reasons, self-asserted workflowModule objects) never creates one.
 *
 * Two transports:
 * - in-process: the ModuleTurnInvocation object travels manager -> runtime
 *   -> backendFactory -> delegate tools (same process, no serialization).
 * - hub MCP HTTP boundary (CLI subprocess -> /api/hub-mcp): a signed bearer
 *   carries {contact, room, module, revision}; the router re-verifies it per
 *   request, including SSE follow-ups. DM turns keep the legacy per-contact
 *   bearer untouched.
 */

export interface ModuleTurnBinding {
  contactId: string;
  runner: string;
  model: string;
  reasoning: string;
}

export interface ModuleTurnInvocation {
  moduleId: string;
  binding: ModuleTurnBinding;
  revision: number;
  permissions: ModulePermissions;
  taskPath?: string;
  workspace?: string;
  /**
   * Model-driven task provenance: durable room_tasks row id + handoff row id
   * verified by the manager at dispatch. Ordinary intake turns leave these
   * unset (room+module authority only). Never trusted from caller arguments;
   * set only from the verified handoff row in-process, or from a
   * server-signed bearer at the HTTP boundary.
   */
  taskId?: string;
  handoffId?: string;
  /** Callback-woken turns carry the durable callback job id (same trust). */
  callbackJobId?: string;
  /**
   * Server-created origin-turn nonce for this exact turn. Bound at turn
   * start into this turn's own closures/bearer and validated per call
   * against the active-turn registry. Deliberately EXCLUDED from
   * moduleBindingHash (runtime/session identity stays stable across turns).
   */
  turnId?: string;
}

export interface InvocationScope {
  contactId: string;
  roomId: string;
  moduleId: string;
  revision: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  invocation?: ModuleTurnInvocation;
}

export interface DelegateScope {
  /** False for non-dispatch modules (review/arbitration/merge/deploy): no dispatch. */
  allow: boolean;
  routeClasses: string[];
  invocation: ModuleTurnInvocation | null;
}

/** Short immutable binding qualifier for runtime keys and session identity. */
export function moduleBindingHash(ctx: {
  moduleId: string;
  model?: string;
  reasoning?: string;
  bindingRevision?: number;
  taskPath?: string;
  workspace?: string;
  permissions?: ModulePermissions;
  taskId?: string;
  handoffId?: string;
  callbackJobId?: string;
}): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    ctx.moduleId, ctx.model, ctx.reasoning, ctx.bindingRevision, ctx.taskPath, ctx.workspace, ctx.permissions,
    ctx.taskId ?? null, ctx.handoffId ?? null, ctx.callbackJobId ?? null,
  ])).digest('hex').slice(0, 24);
}

/** Module dispatch capability is independent of a persona's private DM settings.
 * The gateway still requires a trusted room-host task/workspace and worker claim caps. */
export function moduleDelegationConfig(invocation: ModuleTurnInvocation) {
  return {
    enabled: delegateScopeForModule(invocation.moduleId).allow,
    workspaces: invocation.workspace ? [invocation.workspace] : [],
    runners: ['codex', 'claude', 'grok', 'opencode'] as Array<'codex' | 'claude' | 'grok' | 'opencode'>,
    allowShell: invocation.permissions.shell,
    allowSsh: invocation.permissions.ssh,
    maxOpenJobs: 3,
  };
}

/** Which delegate route_classes a module turn may dispatch (gateway + MCP). */
export function delegateScopeForModule(moduleId: string): { allow: boolean; routeClasses: string[] } {
  switch (moduleId) {
    case 'plan':
    case 'execute':
      return { allow: true, routeClasses: ['implement', 'fix'] };
    case 'maintenance':
      return { allow: true, routeClasses: ['recon', 'mechanical'] };
    default:
      // review / arbitration / merge / deploy never dispatch via gateway tools:
      // review and arbitration are read-only verdicts, merge/deploy are
      // mechanical harness closures, not conversational dispatches.
      return { allow: false, routeClasses: [] };
  }
}

/**
 * Plan binding replaces legacy orchestrator authority in workflow rooms.
 * Social rooms keep the legacy room-config resolution untouched.
 */
export function resolveWorkflowOrchestratorId(
  store: WorkflowModulesStore | null | undefined,
  room: ContactRow,
): string {
  try {
    const cfg = contactConfig(room) as unknown as Record<string, unknown>;
    if (store && isWorkflowRoomConfig(cfg)) {
      const contactId = store.bindings().plan?.contactId;
      if (typeof contactId === 'string' && contactId) return contactId;
    }
    return resolveRoomOrchestratorId(cfg);
  } catch {
    try {
      return resolveRoomOrchestratorId(contactConfig(room) as unknown as Record<string, unknown>);
    } catch {
      return DEFAULT_ROOM_ORCHESTRATOR_ID;
    }
  }
}

function isModuleId(value: unknown): value is WorkflowModuleId {
  return typeof value === 'string'
    && (WORKFLOW_MODULES as readonly { id: string }[]).some((item) => item.id === value);
}

function isBinding(value: unknown): value is ModuleBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return typeof binding.contactId === 'string' && binding.contactId.length > 0
    && typeof binding.runner === 'string' && binding.runner.length > 0
    && typeof binding.model === 'string' && binding.model.length > 0
    && typeof binding.reasoning === 'string' && binding.reasoning.length > 0;
}

/**
 * Validate a captured room-host workflowModule snapshot (immutable room
 * snapshot for in-flight rounds). Returns the trusted snapshot or null.
 * Arbitrary caller objects never pass: the caller must reference a real
 * server-persisted room-host row, which the caller validates separately.
 */
export function validateCapturedSnapshot(value: unknown): {
  moduleId: WorkflowModuleId;
  binding: ModuleBinding;
  revision: number;
  policyVersion: number;
  permissions: ModulePermissions;
  taskPath?: string;
  workspace?: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (!isModuleId(snapshot.moduleId)) return null;
  if (!isBinding(snapshot.binding)) return null;
  const revision = Number(snapshot.bindingRevision ?? snapshot.revision);
  if (!Number.isSafeInteger(revision) || revision <= 0) return null;
  const policyVersion = Number(snapshot.policyVersion ?? 1);
  if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) return null;
  return {
    moduleId: snapshot.moduleId,
    binding: snapshot.binding,
    revision,
    policyVersion,
    permissions: Object.fromEntries(Object.entries(WORKFLOW_MODULES.find((item) => item.id === snapshot.moduleId)!.permissions)
      .map(([key, allowed]) => [key, allowed && (!snapshot.permissions || (snapshot.permissions as Record<string, unknown>)[key] === true)])) as unknown as ModulePermissions,
    ...(typeof snapshot.taskPath === 'string' ? { taskPath: snapshot.taskPath } : {}),
    ...(typeof snapshot.workspace === 'string' ? { workspace: snapshot.workspace } : {}),
  };
}

// ── signed invocation bearer (hub MCP HTTP boundary) ────────────────────────

const SCOPE_TOKEN_PREFIX = 'm1';
const SCOPE_TOKEN_DOMAIN = 'hub-module-v1';

function base64urlEncode(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function base64urlDecode(raw: string): string | null {
  try {
    return Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/** Sign an invocation scope. Null when no hub token is configured. */
export function signInvocationScope(
  hubToken: string | undefined,
  scope: Omit<InvocationScope, 'issuedAt' | 'expiresAt' | 'nonce'> & { ttlMs?: number },
): string | null {
  if (!hubToken) return null;
  const now = Date.now();
  const body: InvocationScope = {
    contactId: scope.contactId,
    roomId: scope.roomId,
    moduleId: scope.moduleId,
    revision: scope.revision,
    issuedAt: now,
    expiresAt: now + (typeof scope.ttlMs === 'number' && scope.ttlMs > 0 ? scope.ttlMs : 24 * 3_600_000),
    nonce: crypto.randomUUID(),
    ...(scope.invocation ? { invocation: structuredClone(scope.invocation) } : {}),
  };
  const payload = base64urlEncode(JSON.stringify(body));
  const signature = crypto.createHmac('sha256', hubToken)
    .update(`${SCOPE_TOKEN_DOMAIN}\0${payload}`)
    .digest('base64url');
  return `${SCOPE_TOKEN_PREFIX}.${payload}.${signature}`;
}

/** Verify an invocation bearer. Null on any failure (fail closed). */
export function verifyInvocationScope(
  hubToken: string | undefined,
  authorizationHeader: string | undefined,
  nowMs = Date.now(),
): InvocationScope | null {
  if (!hubToken) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? '');
  const received = match?.[1]?.trim() ?? '';
  const parts = received.split('.');
  if (parts.length !== 3 || parts[0] !== SCOPE_TOKEN_PREFIX) return null;
  const expected = crypto.createHmac('sha256', hubToken)
    .update(`${SCOPE_TOKEN_DOMAIN}\0${parts[1]}`)
    .digest('base64url');
  const receivedBuffer = Buffer.from(parts[2] ?? '');
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
    return null;
  }
  const decoded = base64urlDecode(parts[1] ?? '');
  if (!decoded) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof body.contactId !== 'string' || !body.contactId
    || typeof body.roomId !== 'string' || !body.roomId
    || !isModuleId(body.moduleId)
    || !Number.isSafeInteger(Number(body.revision))
    || !Number.isSafeInteger(Number(body.issuedAt))
    || !Number.isSafeInteger(Number(body.expiresAt))) {
    return null;
  }
  if (Number(body.expiresAt) <= nowMs || Number(body.revision) <= 0 || typeof body.nonce !== 'string') return null;
  let invocation: ModuleTurnInvocation | undefined;
  if (body.invocation !== undefined) {
    const value = body.invocation as ModuleTurnInvocation;
    const definition = WORKFLOW_MODULES.find((item) => item.id === body.moduleId)!;
    if (!value || value.moduleId !== body.moduleId || value.revision !== body.revision
      || !isBinding(value.binding) || value.binding.contactId !== body.contactId || !value.permissions
      || ['write', 'shell', 'ssh'].some((key) => typeof value.permissions[key as keyof ModulePermissions] !== 'boolean'
        || (value.permissions[key as keyof ModulePermissions] && !definition.permissions[key as keyof ModulePermissions]))) return null;
    // Task provenance is optional but strictly typed when present: a forged
    // or malformed task/handoff reference fails the whole bearer closed.
    if (value.taskId !== undefined && (typeof value.taskId !== 'string' || !value.taskId || value.taskId.length > 300)) return null;
    if (value.handoffId !== undefined && (typeof value.handoffId !== 'string' || !value.handoffId || value.handoffId.length > 100)) return null;
    if (value.callbackJobId !== undefined && (typeof value.callbackJobId !== 'string' || !value.callbackJobId || value.callbackJobId.length > 100)) return null;
    // Origin-turn nonce rides the signed invocation so the MCP credential
    // is bound to the exact turn that generated it. Optional for
    // backwards-compatible bearers, strictly typed when present.
    if (value.turnId !== undefined && (typeof value.turnId !== 'string' || !value.turnId || value.turnId.length > 100)) return null;
    invocation = value;
  }
  return {
    contactId: body.contactId,
    roomId: body.roomId,
    moduleId: body.moduleId as string,
    revision: Number(body.revision),
    issuedAt: Number(body.issuedAt),
    expiresAt: Number(body.expiresAt),
    nonce: body.nonce,
    ...(invocation ? { invocation } : {}),
  };
}

// ── contact config sanitization (genuine backend restriction) ───────────────

export interface SanitizedContactConfig {
  cfg: Record<string, unknown>;
  notes: string[];
}

const CLAUDE_SHELL_TOOLS = new Set(['Bash']);

/**
 * Intersect a contact's config with the invoked module's permissions.
 * Returns a sanitized COPY (the stored contact is never mutated) plus
 * human-readable notes for the turn log and prompt.
 *
 * Enforcement matrix (fail-closed, no prompt-only claims):
 * - write:false  -> projectAccess forced off for every adapter. Read-only
 *   review/arbitration turns can never inherit contact project write access.
 * - shell:false  -> shell tools stripped where the adapter has a switch for
 *   it (claude/grok); codex has no no-shell sandbox mode, so the build is
 *   rejected instead of silently keeping shell. No current module sets
 *   shell:false; this guards future policy.
 * - shell:true + write:false (shellRead) -> codex keeps shell under the
 *   genuine read-only OS sandbox; claude/grok/opencode cannot enforce
 *   read-only shell at the CLI layer, so shell is DENIED (downgraded to a
 *   read profile) with an explicit note instead of silently allowing writes
 *   through Bash/terminal tools.
 */
export function sanitizeContactConfigForModule(
  cfg: Record<string, unknown>,
  invocation: Pick<ModuleTurnInvocation, 'moduleId' | 'permissions'>,
  backend: string,
): SanitizedContactConfig {
  const notes: string[] = [];
  const next: Record<string, unknown> = { ...cfg };
  const perms = invocation.permissions;
  const runner = runnerForBackend(backend);

  if (!perms.write) {
    if (runner === 'claude') {
      const denied = new Set([...(Array.isArray(next.disallowedTools) ? next.disallowedTools : []), 'Write', 'Edit']);
      next.disallowedTools = [...denied];
      if (Array.isArray(next.allowedTools)) next.allowedTools = next.allowedTools.filter((tool) =>
        typeof tool === 'string' && !/^(Write|Edit)(\(|$)/.test(tool));
    }
    const access = (next.projectAccess && typeof next.projectAccess === 'object' && !Array.isArray(next.projectAccess)
      ? next.projectAccess as Record<string, unknown>
      : {});
    if (access.enabled === true) {
      next.projectAccess = { ...access, enabled: false };
      notes.push(
        `project write access withheld: module ${invocation.moduleId} is read-only; ` +
        `contact projectAccess stays configured but is not applied to this turn`,
      );
    }
  }

  if (!perms.shell) {
    if (runner === 'codex') {
      throw new Error(
        `module ${invocation.moduleId} forbids shell, but the codex adapter has no no-shell sandbox mode; ` +
        `refusing the turn instead of silently keeping shell access`,
      );
    }
    const allowed = Array.isArray(next.allowedTools) ? [...next.allowedTools] : [];
    const disallowed = Array.isArray(next.disallowedTools) ? [...next.disallowedTools] : [];
    if (runner === 'claude') {
      const stripped = allowed.filter((tool) => typeof tool === 'string' && !CLAUDE_SHELL_TOOLS.has(tool));
      if (stripped.length !== allowed.length) {
        notes.push(`shell tools withheld: module ${invocation.moduleId} forbids shell`);
      }
      next.allowedTools = stripped;
      for (const tool of CLAUDE_SHELL_TOOLS) {
        if (!disallowed.includes(tool)) disallowed.push(tool);
      }
      next.disallowedTools = disallowed;
    }
    // grok/opencode room backends never grant terminal tools today; nothing to strip.
  }

  if (perms.shell && !perms.write) {
    // shellRead: genuine only where the sandbox enforces it (codex
    // read-only). Other CLI adapters cannot stop writes through the shell,
    // so deny shell (downgrade to read) with an explicit note.
    if (runner === 'claude') {
      const allowed = Array.isArray(next.allowedTools) ? [...next.allowedTools] : [];
      const stripped = allowed.filter((tool) => typeof tool === 'string' && !CLAUDE_SHELL_TOOLS.has(tool));
      if (allowed.some((tool) => typeof tool === 'string' && CLAUDE_SHELL_TOOLS.has(tool))) {
        notes.push(
          `shell withheld on ${runner}: read-only shell is not enforceable at the CLI layer; ` +
          `read tools stay available, terminal access is denied rather than silently allowing writes`,
        );
      }
      next.allowedTools = stripped;
      const disallowed = Array.isArray(next.disallowedTools) ? [...next.disallowedTools] : [];
      for (const tool of CLAUDE_SHELL_TOOLS) {
        if (!disallowed.includes(tool)) disallowed.push(tool);
      }
      next.disallowedTools = disallowed;
    } else if (runner === 'codex') {
      notes.push(`read-only shell enforced by the codex read-only sandbox`);
    } else {
      notes.push(`${runner} room adapter denies native file edits and terminal tools for this read-only invocation`);
    }
  }

  return { cfg: next, notes };
}

