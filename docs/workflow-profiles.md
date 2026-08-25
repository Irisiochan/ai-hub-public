# Workflow Profiles

AI Hub keeps safety and delivery rules in one immutable workflow core. A workflow profile only selects the role-to-runner/model/reasoning mapping. Switching a profile never changes permissions, approval gates, the task state machine, fast-forward-only rules, or production maintenance-window policy.

## Built-in profiles

| Stage | Profile A | Profile B | Profile B fallback |
| --- | --- | --- | --- |
| Plan | Claude Fable / high | Codex gpt-5.6-sol / ultra | — |
| Review | Claude Fable / high | Codex gpt-5.6-sol / high | Claude Opus 4.7 / high |
| Execute, Fix | Codex gpt-5.6-sol / high | Grok 4.6 / high | Codex gpt-5.6-sol / medium |
| Maintenance, Patrol | Grok 4.6 / high | Grok 4.6 / high | — |

DeepSeek bulk/coding harness is deliberately marked `planned`. The existing triage DeepSeek API client is not exposed as a coding runner.

## Switching and snapshots

- `GET /api/workflow-profiles` returns the active/previous profiles and recent audit events.
- `POST /api/workflow-profiles/preview` validates a target and returns the role diff.
- `POST /api/workflow-profiles/switch` atomically changes the active pointer.
- `POST /api/workflow-profiles/rollback` switches back to the previous version.
- Every new job stores an immutable `options.workflow` snapshot and a v3 workflow fingerprint.
- Room coordination dispatches store the snapshot when the host message is created. A later profile switch therefore cannot reroute an already-issued dispatch.

The migration activates Profile A so rollout preserves the declared current protocol. Profile B remains available for an explicit switch.

## Three-strike fallback

Quality is explicit and structured:

- `success`: reset the streak for this problem.
- `inadequate`: increment the semantic-quality streak.
- `infrastructure`: record the event but do not increment or reset the streak.

The streak key includes profile id/version, task path, stage, problem fingerprint, and primary runner/model. Each job may contribute only one quality result. On the third `inadequate` result, the fallback is pinned for subsequent jobs with that key until a success or a changed problem fingerprint resets routing.

Review `REJECT` is not interpreted as reviewer failure. A correct review may reject weak code; the orchestrator or User must explicitly record `inadequate` when the review itself missed the problem or did not converge.
