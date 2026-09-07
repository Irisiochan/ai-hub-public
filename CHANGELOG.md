# Changelog

## Unreleased

## 0.3.2 - 2026-09-07

- Cascade wallet-side refunds to the linked bank row: after cross-source dedup the bank
  transaction is the one month stats count, so re-importing a fully refunded wallet
  transaction now marks its linked bank row ignored as well instead of leaving the amount
  in monthly spending.
- Restore third-party lockfile versions (`media-typer`, `node-api-version`) that a blanket
  release-version sed had rewritten without changing the resolved tarballs, and regenerate
  the third-party notices from the corrected locks; version bumps now go through
  `npm pkg set` + `npm install --package-lock-only`.

This public release is a curated, sanitized snapshot based on private source revision
`a68119c9c7aa8597e5c6d9825ade365d6280847a`; private contacts, personas, real evaluation data,
databases, credentials, token-rotation scripts, and author-specific deployment tooling are excluded.

## 0.3.1 - 2026-09-07

- Ship the desktop shell's gateway runtime dependencies (`fflate`, `pino`,
  `@ai-hub/contact-config`) and stage `server/migrations` into the packaged app; a
  packaged local-mode gateway previously crashed on boot with `ERR_MODULE_NOT_FOUND`.
- Add a post-package startup check (`npm run smoke:packaged --prefix desktop`) that boots the
  win-unpacked gateway via `ELECTRON_RUN_AS_NODE` and requires `/api/health` to answer; CI now
  runs it after building the installers instead of only proving the installer can be generated.
- Keep ledger cross-source dedup one-to-one across import batches: bank rows already consumed
  by an earlier batch can no longer absorb a second same-amount purchase and undercount spending.
- Refresh a ledger transaction's kind/status/amount when the same transaction ID is re-imported
  with a changed status (e.g. a full refund), instead of silently skipping it as a duplicate.
- Route triage escalates three-strike quality failures to the user instead of silently falling
  back to another model, and the companion heartbeat's shopping bridge favorites products
  instead of adding them to the cart.

This public release is a curated, sanitized snapshot based on private source revision
`80ed2360ad84cdec45a1205b99d14a431bee76d2`; private contacts, personas, real evaluation data,
databases, credentials, token-rotation scripts, and author-specific deployment tooling are excluded.

## 0.3.0 - 2026-09-06

> **Note:** the `v0.3.0` tag does not compile (its public seed lags a gateway import,
> fixed on `main` right after tagging). Use `v0.3.1` instead.

- Add a companion heartbeat: periodic autonomous ticks for both CLI and API contacts with
  randomized intervals, model-decided speech, an unlimited manual mode, and runtime-drawer
  controls; heartbeats can bridge desktop MCP tools and guarded PC camera capture that
  returns frames as MCP images.
- Add an OpenCode CLI backend (OpenCode Go) with model discovery in the picker, image input
  via `run --file`, and stdin/idle-timeout fixes.
- Close the route-triage loop: a patrol contact pre-screens unrouted tasks, suggestions
  auto-dispatch after an unvetoed veto window, late same-day replies are harvested, and
  presence checks are timezone-safe.
- Harden coordination rooms: structured receipts with automated deploy closure, resumable
  deploy events, guarded receipt pagination, task outcomes and due reminders routed through
  the room, and worker actions shown on room receipts.
- Refresh the web client with a Telegram-style shell, controlled theme manifests, motion and
  sound preferences, split styles with a visual baseline, and bounded long-session rendering.
- Import Alipay/WeChat/CMB bills into a personal ledger with deduplication and monthly advice.
- Add living architecture docs: a product charter, `docs/ARCHITECTURE.md` with a drift-guard
  test, and a core-implementation convergence pass unifying worker state, task transactions,
  and gateway contracts.
- List provider models with a searchable picker and keep Gemini tool schemas compatible by
  stripping unsupported JSON Schema keys.
- Refresh dependency locks (fast-uri, @xmldom/xmldom, and a `qs` override where the express
  chain pins a vulnerable range); local audits for server, web, mobile, and desktop report
  zero known vulnerabilities.

This public release is a curated, sanitized snapshot based on private source revision
`d58aa21a688283d37f876fd3185cb956e8ab579b`; private contacts, personas, real evaluation data,
databases, credentials, token-rotation scripts, and author-specific deployment tooling are excluded.

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
- Wait for Git child-process output to close before classifying Worker delivery state, removing a
  Linux race that could drop branch or ahead/behind evidence.

This public release is a curated, sanitized snapshot based on private source revision
`be56f9af8379d8c920e2c3029645b94fcae3046a`; private contacts, personas, real evaluation data,
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
