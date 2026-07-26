# PC Worker launcher

`worker-launcher.ps1` is the single Windows entrypoint for the PC Worker. It owns the
HKCU logon entry, single-instance lock, Tailscale/gateway wait, child process,
crash backoff and local status.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\worker-launcher.ps1 -Action install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\worker-launcher.ps1 -Action start
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\worker-launcher.ps1 -Action status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\worker-launcher.ps1 -Action restart
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\worker-launcher.ps1 -Action stop
```

At logon the installed command waits 300 seconds, then waits for Tailscale and the
gateway before starting Node. Once those checks pass, it also starts one detached
offsite-backup catch-up check. The catch-up waits for SSH, skips when the newest
verified archive is less than 20 hours old, and otherwise pulls and verifies a new
archive. `worker-state.json` is the single durable state file: its `launcher`
section reports `online | waiting | restarting | failed | stopped`, PIDs, restart
count and the last error, while `jobs` and `events` hold Worker recovery data.
`state-store.mjs` serializes launcher and Worker writes through one lock so the
two processes cannot overwrite each other's section. A legacy
`launcher-state.json` is read only as a migration fallback.

`maxConcurrent` defaults to `1` and is capped at `8`. A value of `2` is the
recommended starting point for a normal PC. The server enforces both the slot
limit and one active job per exact workspace, so two jobs may run together only
when their workspaces do not overlap.

Workspace entries can be either a path string or an object with a delivery mode:

```json
{
  "workspaces": [
    "C:/path/to/code-workspace",
    {
      "path": "C:/path/to/managed-vault-content",
      "deliveryMode": "trust-cli"
    }
  ]
}
```

Path strings default to `git-check`. Use `trust-cli` only for a content vault
whose own managed sync may write or commit files after the runner exits. Code
repositories, including the Memory Vault implementation repository, should stay
on `git-check`. The worker still honors an explicit final
`{"delivery":{"committed":...,"pushed":...}}` declaration from the runner.

The ai-hub Worker panel can pause or resume job acceptance. Pausing keeps only a
lightweight control heartbeat so the panel can wake the worker remotely; it does
not kill a running job. The pause survives reconnects and child-process restarts
within the same Windows boot. A new Windows boot restores job polling, matching
the normal logon auto-start behavior.

The claim response carries protocol version `2` and the current delivery
contract. The Worker inserts that server-provided text into the runner prompt;
contract wording can therefore change without a PC Worker restart. Runner
permission flags are generated from the table in `runner.mjs`.

If the Node Worker restarts with an active job, it first checks the saved child
PID. A live child is reattached and kept leased. If the child is gone but a
Claude/Codex/Grok session id was captured, the Worker performs one automatic
resume. Jobs without either proof become `interrupted`; the server keeps a
10-minute `recovering` window before making that terminal.

## Autonomous triage worker

`triage-worker.mjs` is the VPS-side event gate. It keeps a durable SQLite queue,
uses a cheap DeepSeek Flash model for strict-JSON L1 triage, routes by contact
`config.routing`, calls the Pro model only when rules and the L1 suggestion both
miss, and dispatches through the normal AI Hub message API. Unroutable actionable
events are parked in Memory Vault `inbox/` with the `triage-backlog` tag.

Requirements:

- Node.js 22.13 or newer (`node:sqlite` is used for the queue).
- A dedicated DeepSeek API key. Do not put Claude, Codex, or Grok subscription
  credentials in this service.
- Hub and Memory Vault tokens supplied through environment variables, never in
  the JSON config.

```bash
cd worker
cp triage.config.example.json /etc/ai-hub/triage.json
node triage-worker.mjs /etc/ai-hub/triage.json --once
node triage-worker.mjs /etc/ai-hub/triage.json --metrics
```

Set current DeepSeek prices in `deepseek.pricing`; zero means cost metrics are
unknown rather than guessed. The daily event and cost breakers, per-recipient
daily limit, and cooldown are all enforced before dispatch.

`routing.rules` wins over the L1 suggestion, and the Pro fuzzy fallback only runs
when no candidate exists at all. A rules table that covers every category
therefore disables L2.5 completely — leave the long tail (`other`, and anything
else without an obvious owner) unmapped if you want the fallback to run.

### Proactive daily companion

A separate timer source with `"mode": "daily"` (and category `daily`) asks L1
whether Iris should get a proactive message: care/routine nudges, practical
reminders, or light chat openers are all allowed. This path is independent of
the task/backlog gate:

- **Model routing only** among `proactive.recipients` (default `cheng`, `cove`,
  `aye`). Static `routing.rules` never override daily category.
- **Shanghai quiet hours** default `00:00–09:00` — the daily timer does not emit
  inside that window, and any queued daily event is forced to NO_OP.
- **Separate daily pool**: `proactive.dailyDispatchLimit` (default 10) counts
  Shanghai-calendar-day dispatches in delivery pool `daily`. Task per-recipient
  `dailyLimit` / cooldown only count pool `task`, so companion outreach does not
  burn work quotas.
- Timer summary is rebuilt each wake with the current Asia/Shanghai clock.

```json
{
  "proactive": {
    "enabled": true,
    "dailyDispatchLimit": 10,
    "silentStartHour": 0,
    "silentEndHour": 9,
    "recipients": ["cheng", "cove", "aye"]
  },
  "sources": [
    {
      "id": "daily-check-in",
      "type": "timer",
      "mode": "daily",
      "intervalMinutes": 45,
      "jitterSeconds": 900,
      "category": "daily",
      "summary": "Proactive daily companion check for Iris."
    }
  ]
}
```

Timer sources fire after `intervalMinutes` plus a fresh random jitter below
`jitterSeconds`, so consecutive wakes are never closer than the interval. Only
the first wake after start may land early, inside the jitter window alone.

Each routable contact may add:

```json
{
  "routing": {
    "enabled": true,
    "recipientKey": "engineering",
    "categories": ["file-change", "system"],
    "minPriority": 1,
    "dailyLimit": 10,
    "cooldownMinutes": 30,
    "fallback": false
  }
}
```

Copy `ai-hub-triage-worker.service` to systemd after adapting paths. Its sample
uses `/etc/ai-hub/triage.env` for secrets and `/var/lib/ai-hub-triage` for the
SQLite database. `/health` exposes the current NO_OP ratio, fallback count, cost,
and per-recipient delivery distribution.
