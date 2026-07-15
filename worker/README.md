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
