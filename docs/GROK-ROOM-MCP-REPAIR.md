# Grok room MCP authentication repair

Request: `inbox/2026-09-16_req-hub-mcp-bearer-rejected-aye.md`.
Baseline: `eae480ef6623ed3bfb3a980b33d01367b6d792a5`.

## Scope and acceptance

Restore the room module's existing Hub MCP access, using its signed current-turn
bearer, without changing router enforcement, root tokens, provider logins,
workflow permissions, timeout settings, or DM configuration. Verify real Grok
discovery and authenticated requests, create/resume continuity, and the existing
expired-origin-turn rejection tests. Independently review before deployment.

## Root cause evidence

The 2026-09-16 08:53:12 CST rejection followed a successful managed project
configuration write. In Grok session `f51da18c-5529-48da-86e6-ac35dc4e53e0`,
`mcp_config_resolved` listed only memory-vault. Tool discovery therefore could
not find the room task tools; the later rejected request came from a manual
terminal HTTP attempt, not from a successfully initialized Hub MCP client.
The rejection correctly reported no Authorization header.

The service's actual Grok binary is 0.2.102 at
`/var/lib/ai-hub/home/.local/bin/grok`. `grok inspect` in the affected module
scratch directory reported `projectTrusted=false`. Writing `.grok/config.toml`
does not make Grok load that project's MCP servers. Native reproduction also
showed that a stale project `hub` entry shadows a user-level `hub` entry before
the trust gate drops it. This is configuration discovery, not a reason to relax
bearer validation or rotate the root token.

## Change

Room module turns receive an explicit private `.grok-runtime` home with Hub and,
when enabled, memory-vault. The old gateway-owned project Hub block is removed
so it cannot shadow the new configuration. Unmanaged project Hub entries fail
closed instead of falling back to an unrelated identity. DM behavior is unchanged.

The CLI receives `GROK_HOME` and `GROK_AUTH_PATH`; authentication stays at its
original path and sessions link to their original store. No login is copied.
The shared user config and trust store are untouched. Project trust remains
enabled, compatibility MCP discovery is disabled for the isolated process, and
shared-leader configuration caching is disabled. Existing runtime sequencing
stops the old module process before rebuilding the next turn's configuration.

## Validation

- Server build.
- `tsx --test test/grokRuntimeHome.test.mts test/roomTaskRuntimePath.test.mts test/workflowModule*.test.mts`: 56 passed.
- `tsx test/hubMcpSecurity.test.mts`: passed, including existing rejected identities.
- `tsx scripts/smoke-cli-heartbeat-defaults.ts`: passed (legacy DM coverage).
- `tsx scripts/smoke-grok-cli.ts`: passed.
- Native `scripts/smoke-grok-managed-mcp.ts` run as the production service user
  against the actual Grok executable: untrusted project, stale managed Hub
  configuration migrated, authenticated initialize and tools/list succeeded.
- Its explicit `GROK_SMOKE_MODEL_PROBE=1` variant made two small fixture-only
  model turns: create and resume both called task_get; the resumed call carried
  the newly changed bearer. Authentication worked through the original auth
  path, and no auth.json was created in the isolated home.

The native smoke uses a loopback fixture and dummy MCP bearer; it does not mutate
the real task ledger or need production Hub credentials. The opt-in model probe
uses the existing provider login and quota. No secret values belong in evidence.
