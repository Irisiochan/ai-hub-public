# Fixed workflow modules implementation plan

> Superseded by [model-driven room workflow](model-driven-room-workflow.md) (2026-09-12). Kept for history.
> Thresholds below were 4→arbitration / 5→User at approval; User 2026-09-14
> changed the live constants to 2 / 3. Do not copy the old numbers.

Approved by User on 2026-09-10. Existing B workflow becomes the sole fixed workflow. Remove A/B manual selection. Models are hot-swappable module bindings; authority belongs to module invocation, not contact persona. Implementation bypasses the broken room and never invokes Grok.

## Acceptance
- Fixed modules: plan (room intake + planning), execute (execute/fix), review, arbitration, merge, deploy, maintenance (maintenance/patrol). Four consecutive implementation inadequates enter arbitration, fifth unresolved escalates to User; review failures still three. Infrastructure failure never increments/resets quality. Model/revision changes preserve problem counters.
- User can choose agent/model/reasoning for each module in room panel. Binding changes atomic and revision checked. Future dispatches use current config; running attempts retain immutable binding and permissions snapshots.
- Module resolver is common to room, delegation, manual Worker create, review/fix/merge/deploy automation. Effective permissions are module policy intersected with task authorization and worker scope, never contact privilege union. Enforce runner-specific restrictions; reject incompatible bindings rather than silently relaxing.
- Approved rooms have a reserve pool, derived from configured available agents; unbound agents never wake from ordinary messages, @all, reactions or receipts. Social/DM behavior outside workflow rooms unchanged. A bound agent wakes only for its applicable module.
- Quota/auth/runner unavailable affects that binding/credential pool rather than entire room. No automatic model fallback. UI can manually replace binding and take over blocked/failed attempt after old attempt is terminal/fenced. Preserve authorization, task path/fingerprint, remaining budget, SHA/review inputs; start a fresh session. Stale receipts and duplicate attempts cannot advance task.
- Review and delivery no longer implicitly depend on maintenance model; merge/deploy retain version-bound gate, drain/maintenance window, HTTP script and health verification.
- Legacy profile/job snapshots remain readable without destructive migration. Remove profile switching APIs as operational path.
- Documents/prompts use module roles rather than hard-coded model names for authority. No unrelated DM/personal heartbeat/3D changes.
- Test migration, revision concurrency, permissions, four/five threshold, model-change counters, unused agents zero wake, quota fault isolation, takeover dedupe/stale receipts, frozen SHA and build/test regressions. No live provider calls in tests.

## Scope / ownership
Backend executor: direct headless OpenCode opencode-go/muse-spark-1.3-contributor max.
Backend owns server/**, shared/**, worker/**. Root owns web/**, docs/**, deployment/review.
Shared checkout C:/ai-hub-codex, branch workflow-modules, baseline fddd0b0.
No agent commits, pushes, deploys, calls room/Grok, or writes Vault. Root handles integration.
No unrelated package-lock, credentials, provider account changes or destructive operations.

## Interface contract (backend to implement, frontend consumes)
GET /api/workflow-modules returns:
{
 revision:number,
 modules:Array<{id:'plan'|'execute'|'review'|'arbitration'|'merge'|'deploy'|'maintenance',
 label:string, description:string, permissions:{write:boolean,shell:boolean,ssh:boolean},
 binding:{contactId:string,runner:'codex'|'claude'|'grok'|'opencode',model:string,reasoning:string},
 status:'idle'|'running'|'blocked'|'unavailable', statusDetail?:string}>,
 agents:Array<{contactId:string,name:string,runner:string,models:Array<{id:string,label:string,efforts:string[]}>,compatibleModules:string[],unavailableReason?:string,quotaPool?:string}>,
 jobs:Array<{id:string,moduleId:string,status:string,model:string,reasoning:string,bindingRevision:number,error?:string,canTakeover:boolean}>,
 audit:Array<{id?:number,actor?:string,createdAt?:string,detail?:string}>
}
PATCH /api/workflow-modules/:moduleId body {expectedRevision:number,binding:{contactId,runner,model,reasoning}} returns same GET representation; 409 on stale revision; no mutation on validation failure.
POST /api/workflow-modules/jobs/:jobId/takeover body {expectedRevision:number} returns {job:<normal public WorkerJob>,existing?:boolean}; uses current binding for original module, only eligible terminal/fenced attempts, deterministic idempotency.
SSE workflow-profile event remains for old worker-state refresh, plus workflow-modules if useful.
Legacy GET /workflow-profiles may return one fixed synthetic profile for existing worker stage display; POST switches must no longer select A/B.
Workflow room identification should use existing coordination configuration/room purpose and explicit workflow marker, not apply this to all social rooms. Return/normalize marker workflowEnabled on room public config if needed; frontend shows panel for config.coordination object or config.workflowEnabled true. Bootstrap existing coordination rooms add enabled CLI contacts as reserve members without invoking them.

## Verification
npm run build --prefix server
npm test --prefix server
npm run lint --prefix web
npm test --prefix web
npm run build --prefix web
node --test worker/runner.test.mjs
Relevant workflow/coordination/review/deploy smoke scripts after inspection for side effects.
Independent diff review against baseline; actual deployment uses existing authorized drain/verification gate and exact target confirmation if host requires it.

## Review gate
Root reviews Muse changes, permission enforcement, concurrency, job lineage and real test output. Frontend reviewed in separate read-only headless session. No Grok or meeting-room dependency. No claim of deployment until verified.

