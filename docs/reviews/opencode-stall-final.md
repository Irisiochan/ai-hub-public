# OpenCode stall recovery: final orphan fix

Base: a484a23. The final patch preserves historical process identities in
cleanup, restart reconciliation and the workspace mutex. A parent exiting
does not make a newly observed descendant disappear from the proof. Unknown
descendants block recovery; only twice-observed identities are signaled.

## Verification (2026-09-14)

- Worker full regression: 246 passed, 0 failed, exit 0.
- Three deterministic regressions cover a newborn after parent exit,
  pre-kill identity cleanup after chain loss, and restart with a dead parent.
- Real Windows process test: parent exits, orphan stays alive; historical
  inspection blocks, then cleanup with the captured orphan identity succeeds.
- Receipt tests: pass. Job outbox tests: pass. Plan dispatch tests: 3 pass.
- Actual server module completion / handoff code against temporary databases:
  roomTaskModelDriven + taskHandoffObligation, 32 pass, exit 0. No production
  room messages were sent; this is not a production callback claim.
- Real OpenCode, shortened test windows and local gateway: original session
  ses_f61e42c52ffeAWz02snId9kHf0 resumed exactly once; new steps, step2.txt,
  final done receipt. No replay of node hold.js. Pipe-holder PID 34708 was
  absent on subsequent process enumeration. The reproducer keeps the parent
  alive while the pipe is held and has a 240-second auto-stop deadline.

The first full suite encountered a local fixture-connect failure in the
no-enumeration test. The isolated test then passed, followed by the full
246-test passing run. This was not hidden or counted as a passing first run.

Local raw evidence:

- C:/Users/Administrator/AppData/Local/Temp/stall-final-tests-rerun.log
- C:/Users/Administrator/AppData/Local/Temp/stall-final-callback.log
- C:/Users/Administrator/AppData/Local/Temp/stall-final-real.log
- C:/Users/Administrator/AppData/Local/Temp/real-e2e-hang-1789359017737/

These checks do not prove attribution of a process whose entire ancestry
disappeared before any observation. Unknown evidence must never be described
as proven cleanup. Independent review remains required before merge/deploy.
