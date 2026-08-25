# Changelog

## Unreleased

## 0.2.1 - 2026-08-25

- Make task rescheduling converge the new `due` value back into Memory Vault so the controller
  and Agenda no longer expose different dates.
- Require machine-readable `update_task` success from Vault projections; retry open-task
  `not_found` outcomes and dead-letter persistent failures instead of silently settling them.
- Attribute manual runner overrides to the actual runner for display while excluding override
  outcomes from automatic Workflow Profile fallback statistics.
- Pin the independent Memory Vault dependency to `v0.7.1` and exercise due write-read plus
  structured failure behavior in the public contract workflow.
- Refresh supported dependency locks; local audits for server, web, mobile, and desktop report
  zero known vulnerabilities.

This public release is a curated, sanitized snapshot based on private source revision
`c9efbcc201febe103fb3506313fc519f4465971c`; private contacts, personas, real evaluation data,
databases, credentials, token-rotation scripts, and author-specific deployment tooling are excluded.

## 0.2.0 - 2026-08-25

- Add versioned Workflow Profiles with immutable job snapshots, preview/switch/rollback APIs,
  explicit quality outcomes, and bounded fallback routing.
- Add a centralized task controller and Vault projection/writeback path so status changes,
  assignments, and completion receipts converge through one authority.
- Add the incremental daily Agenda shadow with overflow rotation, suppression/resurface rules,
  job reconciliation, and quiet no-change days.
- Split the triage worker into focused modules and add migration visibility plus maintenance mode
  when its SQLite store cannot be opened or upgraded safely.
- Add optional cross-contact life-event extraction, image captions, an isolated API-agent harness,
  and runner-availability signals.
- Make room orchestration configurable, expire stale coordination dispatches, redact secrets from
  user-visible backend errors, and close receipt cards whose Vault tasks are already complete.
- Preserve Memory Vault as an independent `v0.7.0` dependency with contract CI, dependency/license
  checks, Windows desktop builds, and public-tree sanitization.

This public release is a curated, sanitized snapshot based on private source revision
`438dec05f42a0e9ce5ed333d0b819aa1e248e507`; private contacts, personas, real evaluation data,
databases, credentials, and author-specific deployment tooling are excluded.
