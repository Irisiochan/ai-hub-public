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
gateway before starting Node. `launcher-state.json` reports
`online | waiting | restarting | failed | stopped`, PIDs, restart count and the
last error. `worker-state.json` remains reserved for job/event recovery and must
not be edited by the launcher.

The ai-hub Worker panel can pause or resume job acceptance. Pausing keeps only a
lightweight control heartbeat so the panel can wake the worker remotely; it does
not kill a running job. The pause survives reconnects and child-process restarts
within the same Windows boot. A new Windows boot restores job polling, matching
the normal logon auto-start behavior.

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
uses `/etc/ai-hub/triage.env` for secrets and `/var/lib/ai-hub/triage` for the
SQLite database. `/health` exposes the current NO_OP ratio, fallback count, cost,
and per-recipient delivery distribution.
