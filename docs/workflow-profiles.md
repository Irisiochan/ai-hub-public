# Fixed workflow modules

> Superseded by [model-driven room workflow](model-driven-room-workflow.md) (2026-09-12): modules stay as
> responsibility+capability bindings, but the fixed graph, automatic review/rework/closure chain and
> quality-counter routing are retired. This file remains for history.

The engineering workflow uses one fixed graph, derived from the former Profile B. Users configure the agent, model and reasoning effort assigned to each module. A/B switching is retired. The old filename and historical job snapshots remain readable for existing links and audit records.

```text
Intake / Plan -> Execute -> Independent Review -> Merge -> Deploy / Verify
                   ^               |
                   +----- Fix -----+
                   |
            Technical Arbitration -> User when still unresolved

Maintenance / Patrol is an independent branch.
```

## Module authority

| Module | Responsibility |
| --- | --- |
| `plan` | Room intake, requirements, scope, Plan and trusted dispatch. Plan acceptance never substitutes for implementation review. |
| `execute` | Implement approved changes and repair review MUST findings with proportionate tests. Execute and fix share the same binding and quality counter. |
| `review` | Independent session, requirement/diff/test evidence and baseline/candidate SHAs; structured APPROVE or REQUEST_CHANGES. No code writes or deployment. |
| `arbitration` | Diagnose whether the Plan or implementation is wrong after two consecutive inadequate implementation attempts. Scope/authorization changes still require User. |
| `merge` | Check the approved candidate SHA, validate and use the existing fast-forward merge/push closure. |
| `deploy` | Deploy the approved SHA via the existing HTTP script, drain/maintenance gate and post-deployment health verification. |
| `maintenance` | Script-first maintenance/patrol; model work is limited to the authorized follow-up. |

An agent's personal identity is not an authority source. Each invocation has one module policy, task authorization and host capability ceiling. Those constraints must be applied to the actual runner's tools and operations. Combining several module bindings never combines their privileges. Unsupported model/effort or permission enforcement must fail explicitly instead of silently widening access or choosing another model.

The module graph and policy version are separate from the user-editable binding revision. Every dispatch records its module, binding revision, selected agent/runner/model/effort, effective permissions, task identity and evidence. New dispatches resolve the latest binding; active attempts retain their captured values.

Room invocations use signed MCP scopes with immutable room/module/task/binding data, separate runtime identities and separate generated MCP files. Their Worker dispatch requires a matching, unexpired trusted room-host task. Personal delegation switches and personal heartbeat tools do not supply module authority. Model-written override reasons cannot bypass the module human-escalation gate or rewrite delivery acceptance.

Codex enforces read-only execution with its sandbox. Claude and Grok deny writable terminal tools for read-only jobs; OpenCode applies explicit runtime edit/terminal denial rules. The deployment job uses a per-invocation Codex read-only network profile so the existing HTTP script can run. Deployment therefore accepts only Codex bindings until another adapter can retain a networked shell while enforcing read-only access. SSH authorization is checked at the gateway and Worker claim boundaries; unapproved jobs lose ambient SSH-agent variables. Full-shell runners continue to rely on the host's existing isolation for access to on-disk credentials.

## Room controls and reserve agents

Workflow rooms show a module diagram with agent/model/effort selectors, fixed permissions, availability and actual task snapshots. The PC Worker panel exposes the same configuration. These controls share one global configuration; they are not per-room alternative workflows.

Eligible agents are visible in the reserve pool. Unbound agents do not run for ordinary room messages, `@all`, reaction rounds or host receipts. Being bound does not mean every room message wakes the agent: the dispatcher selects only the module required by the event. Ordinary room intake goes to the planning module. Personal DMs and social rooms keep their existing behavior.

Saving a binding only updates configuration. It does not send a message or probe the model. Model choices expose supported effort values. Availability and quota-pool information must be based on observed data, without inventing remaining quota.

The model registry reads built-in/file metadata and cached results from explicit contact-page model lookups. A module-page refresh performs no provider query. Per-model effort metadata takes precedence over adapter defaults.

## Binding updates and takeover

- `GET /api/workflow-modules` returns the configuration revision, module cards, compatible agents/model efforts, task attempts and audit events.
- `PATCH /api/workflow-modules/:moduleId` accepts `{expectedRevision, binding}`. Invalid bindings do not mutate configuration; a stale revision returns a conflict.
- `POST /api/workflow-modules/jobs/:jobId/takeover` accepts `{expectedRevision}` and requests a replacement using that module's current binding.
- Historical `options.workflow` snapshots remain readable. Operational A/B switch/rollback endpoints no longer change the workflow.

There is no automatic model fallback in this version. Quota/auth/capability failures identify the affected binding or shared credential pool without disabling room configuration or unrelated modules.

Manual takeover requires a stopped or safely fenced old attempt. The replacement uses a fresh session and preserves the original task/fingerprint, scope, authorization, remaining budget/TTL, candidate SHA and relevant review evidence. Duplicate takeover requests resolve to one replacement. Late receipts from the abandoned attempt cannot advance the pipeline.

Uncertain merge/deploy side effects must be reconciled before retry; a new model is not permission to blindly repeat a deployment. Successful code review and successful post-deployment verification remain separate delivery records.

## Quality and escalation

| Consecutive implementation `inadequate` results | Result |
| --- | --- |
| 1 | Continue the execution/fix loop on the same problem. |
| 2 | Enter the technical arbitration module. |
| 3 | Escalate to User if the problem is still unresolved. |

The counter follows the task problem and execution/fix group. Changing model, binding revision, stage or attempt does not reset it. An infrastructure failure records an event without incrementing or clearing quality. Existing TTL and retry budgets still apply.

Only independent review confirming that the implementation issue is solved clears implementation failures. Normal process exit, a commit, a self-report or a planning/arbitration verdict is not implementation acceptance. Review REQUEST_CHANGES counts against implementation; review's own inadequate results have a separate three-failure human escalation rule.

Review MUST findings have stable IDs, evidence and falsifiable acceptance conditions; OPTIONAL preferences cannot block delivery. The candidate SHA must still match the reviewed SHA at merge. Additional changes require additional review.

## Validation

Behavioral coverage includes migration with old snapshots, the two/three thresholds, counter preservation across swaps/restarts, permission enforcement, zero calls for unbound agents, quota isolation, takeover idempotency and stale receipts, frozen-SHA gates and concurrent binding edits.

The frontend test `node web/test/workflowBrowser.test.mjs` renders the actual React panel in a local headless browser with mocked HTTP responses. It checks binding updates, old task display, conflict handling, takeover requests, supported efforts and 375px dark/light layout. Its mock does not prove a real provider execution or production deployment.
