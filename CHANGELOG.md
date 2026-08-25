# Changelog

## Unreleased

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
