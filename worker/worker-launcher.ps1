[CmdletBinding()]
param(
  [ValidateSet('run', 'start', 'stop', 'restart', 'status', 'install', 'uninstall')]
  [string]$Action = 'status',
  [string]$Config = '',
  [int]$StartupDelaySeconds = 0
)

$ErrorActionPreference = 'Stop'
if (-not $Config) { $Config = Join-Path $PSScriptRoot 'config.json' }
$Config = [IO.Path]::GetFullPath($Config)
$script:LauncherVersion = 2
$script:WorkerDir = $PSScriptRoot
$script:LauncherPath = $MyInvocation.MyCommand.Path
$script:WorkerPath = Join-Path $script:WorkerDir 'worker.mjs'
$script:StateStorePath = Join-Path $script:WorkerDir 'state-store.mjs'
$script:BackupCatchupPath = Join-Path (Split-Path $script:WorkerDir -Parent) 'deploy\startup-offsite-backup.ps1'
$script:LegacyStatePath = Join-Path $script:WorkerDir 'launcher-state.json'
$stateFile = 'worker-state.json'
if (Test-Path -LiteralPath $Config) {
  try {
    $stateConfig = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
    if ($stateConfig.stateFile) { $stateFile = [string]$stateConfig.stateFile }
  } catch {}
}
$script:StatePath = if ([IO.Path]::IsPathRooted($stateFile)) {
  [IO.Path]::GetFullPath($stateFile)
} else {
  [IO.Path]::GetFullPath((Join-Path (Split-Path $Config -Parent) $stateFile))
}
$script:StopPath = Join-Path $script:WorkerDir 'launcher.stop'
$script:LogPath = Join-Path $script:WorkerDir 'worker.log'
$script:RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:RunName = 'ai-hub PC Worker'
$script:Child = $null
$script:Status = $null
$script:LastError = $null
$script:RestartCount = 0
$script:ReleaseSha = $null
$script:BootId = $null

function Get-ShanghaiTime {
  $value = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'China Standard Time')
  return $value.ToString('yyyy-MM-ddTHH:mm:ss') + '+08:00'
}

# The worker appends to the same file. Logging is best-effort: a sharing
# violation right after spawning the worker used to throw inside the start
# path, mark the start failed and orphan the just-started child.
function Write-LauncherLog([string]$Level, [string]$Message) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes("[$(Get-ShanghaiTime)] $Level launcher $Message" + [Environment]::NewLine)
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try {
      $stream = [IO.FileStream]::new($script:LogPath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
      try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
      return
    } catch {
      Start-Sleep -Milliseconds 50
    }
  }
}

function Save-State(
  [string]$State,
  [string]$Detail,
  [int]$WorkerPid = 0,
  [string]$ErrorMessage = $script:LastError,
  [AllowNull()][object]$NextRetryAt = $null
) {
  if ($ErrorMessage) { $script:LastError = $ErrorMessage }
  $script:Status = [ordered]@{
    version = $script:LauncherVersion
    state = $State
    detail = $Detail
    launcherPid = $PID
    workerPid = if ($WorkerPid -gt 0) { $WorkerPid } else { $null }
    restartCount = $script:RestartCount
    lastError = $script:LastError
    startedAt = if ($script:Status) { $script:Status.startedAt } else { Get-ShanghaiTime }
    updatedAt = Get-ShanghaiTime
    nextRetryAt = $NextRetryAt
    serverUrl = if ($script:Status) { $script:Status.serverUrl } else { $null }
    releaseSha = $script:ReleaseSha
  }
  $json = $script:Status | ConvertTo-Json -Depth 5
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $node = (Get-Command node -ErrorAction Stop).Source
  & $node $script:StateStorePath patch-launcher $script:StatePath $encoded
  if ($LASTEXITCODE -ne 0) { throw "state-store exited with code $LASTEXITCODE" }
}

function Read-State {
  if (Test-Path -LiteralPath $script:StatePath) {
    try {
      $shared = Get-Content -LiteralPath $script:StatePath -Raw | ConvertFrom-Json
      if ($shared.launcher) { return $shared.launcher }
    } catch {}
  }
  if (Test-Path -LiteralPath $script:LegacyStatePath) {
    try { return Get-Content -LiteralPath $script:LegacyStatePath -Raw | ConvertFrom-Json } catch {}
  }
  return $null
}

function Test-ProcessAlive([int]$TargetPid) {
  if ($TargetPid -le 0) { return $false }
  return $null -ne (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)
}

function Show-Status {
  $state = Read-State
  if (-not $state) {
    [pscustomobject]@{ state = 'stopped'; detail = 'no launcher state'; launcherPid = $null; workerPid = $null; lastError = $null } |
      ConvertTo-Json -Depth 5
    return
  }
  $launcherAlive = Test-ProcessAlive ([int]$state.launcherPid)
  if (-not $launcherAlive -and $state.state -ne 'stopped') {
    $state.state = 'failed'
    $state.detail = 'launcher process is not running (stale state)'
  }
  $state | ConvertTo-Json -Depth 5
}

function Get-LauncherCommandLine([int]$DelaySeconds = 0) {
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Action run -Config "{1}" -StartupDelaySeconds {2}' -f $script:LauncherPath, $Config, $DelaySeconds
}

# Start the launcher through WMI so its parent is WmiPrvSE, outside the
# caller's process tree and Job object. Start-Process inherits the caller's
# Job: a restart issued from a packaged desktop app (Codex, seen live
# 2026-09-23 23:58) died with that app's auto-update, silently taking the
# worker offline. Start-Process stays only as a fallback.
function Start-HiddenLauncher([int]$DelaySeconds = 0) {
  $commandLine = Get-LauncherCommandLine $DelaySeconds
  try {
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine = $commandLine
      ProcessStartupInformation = $startup
    }
    if ($result.ReturnValue -eq 0) { return }
    Write-LauncherLog 'WARN' "Win32_Process.Create returned $($result.ReturnValue); falling back to Start-Process"
  } catch {
    Write-LauncherLog 'WARN' "Win32_Process.Create failed: $($_.Exception.Message); falling back to Start-Process"
  }
  $args = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', ('"{0}"' -f $script:LauncherPath), '-Action', 'run',
    '-Config', ('"{0}"' -f $Config), '-StartupDelaySeconds', [string]$DelaySeconds
  )
  Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden | Out-Null
}

function Request-Stop([int]$TimeoutSeconds = 20) {
  [IO.File]::WriteAllText($script:StopPath, 'stop', [Text.UTF8Encoding]::new($false))
  $state = Read-State
  if (-not $state -or -not $state.launcherPid) { return }
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Test-ProcessAlive ([int]$state.launcherPid))) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "launcher did not stop within $TimeoutSeconds seconds"
}

function Install-Launcher {
  New-Item -Path $script:RunKey -Force | Out-Null
  $command = Get-LauncherCommandLine 300
  New-ItemProperty -Path $script:RunKey -Name $script:RunName -Value $command -PropertyType String -Force | Out-Null
  Write-Output "installed HKCU Run: $script:RunName"
}

function Uninstall-Launcher {
  Remove-ItemProperty -Path $script:RunKey -Name $script:RunName -ErrorAction SilentlyContinue
  Write-Output "removed HKCU Run: $script:RunName"
}

function Test-StopRequested {
  return Test-Path -LiteralPath $script:StopPath
}

function Wait-Controlled([int]$Seconds) {
  for ($i = 0; $i -lt $Seconds * 2; $i++) {
    if (Test-StopRequested) { return $false }
    Start-Sleep -Milliseconds 500
  }
  return $true
}

function Test-TcpEndpoint([Uri]$Uri) {
  $port = if ($Uri.Port -gt 0) { $Uri.Port } elseif ($Uri.Scheme -eq 'https') { 443 } else { 80 }
  $client = New-Object Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect($Uri.Host, $port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(2000)) { return $false }
    $client.EndConnect($pending)
    return $true
  } catch { return $false } finally { $client.Dispose() }
}

function Test-NetworkReady([Uri]$ServerUri) {
  $tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
  if (Test-Path -LiteralPath $tailscale) {
    try {
      $status = (& $tailscale status --json 2>$null | ConvertFrom-Json)
      if ($status.BackendState -ne 'Running') { return $false }
      if ($status.ExitNodeStatus -and $status.ExitNodeStatus.Online -ne $true) { return $false }
    } catch { return $false }
  }
  return Test-TcpEndpoint $ServerUri
}

# /api/workers requires a hub session the launcher does not have (it always
# got 401 and reported "starting" forever); ask about this worker with its token.
function Test-WorkerOnline([string]$ServerUrl, [string]$WorkerToken) {
  try {
    $response = Invoke-RestMethod -Uri ($ServerUrl.TrimEnd('/') + '/api/worker/me') -TimeoutSec 5 `
      -Headers @{ Authorization = "Bearer $WorkerToken" }
    return $response.worker.status -in @('online', 'busy', 'paused')
  } catch { return $false }
}

# The PC Worker must not run whatever branch the shared checkout happens to
# have checked out (2026-09-14 it silently sat on an unreviewed task branch).
# Each start exports worker/ + shared/ from a fixed ref (default master) into
# a per-commit release directory and runs that copy. Paths inside the worker
# resolve from the config directory, so state, locks and logs stay put.
# Config "releaseRef": "" opts out and runs the checkout directly (dev only).
function Resolve-WorkerScript([object]$Cfg) {
  $ref = 'master'
  if ($null -ne $Cfg -and $Cfg.PSObject.Properties.Name -contains 'releaseRef') { $ref = [string]$Cfg.releaseRef }
  if (-not $ref) {
    Write-LauncherLog 'WARN' 'releaseRef disabled; running worker directly from the checkout'
    return $script:WorkerPath
  }
  $repo = Split-Path $script:WorkerDir -Parent
  try {
    # No pipeline here: an early-terminating pipeline rewrites $LASTEXITCODE.
    $sha = & git -C $repo rev-parse --verify --quiet ($ref + '^{commit}') 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $sha) { throw "cannot resolve release ref '$ref'" }
    $sha = ([string]@($sha)[0]).Trim()
    $root = Join-Path $env:LOCALAPPDATA 'ai-hub-worker\releases'
    $dir = Join-Path $root $sha
    $releaseScript = Join-Path $dir 'worker\worker.mjs'
    if (-not (Test-Path -LiteralPath $releaseScript)) {
      New-Item -ItemType Directory -Force -Path $root | Out-Null
      $tmp = "$dir.tmp-$PID"
      $tar = "$dir.tmp-$PID.tar"
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Force -Path $tmp | Out-Null
      try {
        # deploy/ ships with the worker: merge/deploy closure gate scripts are
        # resolved from this release tree (worker/closure-runner.mjs
        # resolveClosureScript), never from the candidate checkout they judge.
        & git -C $repo archive --format=tar -o $tar $sha worker shared deploy
        if ($LASTEXITCODE -ne 0) { throw "git archive exited with code $LASTEXITCODE" }
        # Pin Windows bsdtar: from a Git Bash parent, PATH resolves MSYS GNU
        # tar first, which reads 'E:\...' as a remote host and fails.
        $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
        if (-not (Test-Path -LiteralPath $tarExe)) { $tarExe = 'tar' }
        & $tarExe -xf $tar -C $tmp
        if ($LASTEXITCODE -ne 0) { throw "tar exited with code $LASTEXITCODE" }
        if (-not (Test-Path -LiteralPath (Join-Path $tmp 'worker\worker.mjs'))) { throw 'release export has no worker.mjs' }
        if (-not (Test-Path -LiteralPath (Join-Path $tmp 'deploy\merge-close-job.ps1'))) { throw 'release export has no deploy\merge-close-job.ps1' }
        if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
        Rename-Item -LiteralPath $tmp -NewName (Split-Path $dir -Leaf)
      } finally {
        Remove-Item -LiteralPath $tar -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
      }
      Write-LauncherLog 'INFO' "exported worker release $ref@$sha"
    }
    Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne $sha -and $_.Name -notlike '*.tmp-*' } |
      Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 2 |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    $script:ReleaseSha = $sha
    return $releaseScript
  } catch {
    Write-LauncherLog 'ERROR' "worker release export failed ($($_.Exception.Message)); refusing to run the checkout's current branch"
    throw
  }
}

function Start-WorkerProcess([string]$NodePath, [string]$WorkerScript) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $NodePath
  $info.Arguments = ('"{0}" "{1}"' -f $WorkerScript, $Config)
  $info.WorkingDirectory = $script:WorkerDir
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.EnvironmentVariables['AI_HUB_WORKER_LOG'] = $script:LogPath
  if ($script:BootId) { $info.EnvironmentVariables['AI_HUB_WORKER_BOOT_ID'] = $script:BootId }
  $proc = New-Object Diagnostics.Process
  $proc.StartInfo = $info
  if (-not $proc.Start()) { throw 'node worker process did not start' }
  return $proc
}

function Start-BackupCatchup {
  if (-not (Test-Path -LiteralPath $script:BackupCatchupPath)) {
    Write-LauncherLog 'WARN' "backup catch-up script missing: $script:BackupCatchupPath"
    return
  }
  $args = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', ('"{0}"' -f $script:BackupCatchupPath)
  )
  Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden | Out-Null
  Write-LauncherLog 'INFO' 'startup backup catch-up requested'
}

function Stop-WorkerChild {
  if (-not $script:Child -or $script:Child.HasExited) { return }
  try {
    $script:Child.CloseMainWindow() | Out-Null
    if (-not $script:Child.WaitForExit(3000)) { $script:Child.Kill() }
  } catch {
    try { $script:Child.Kill() } catch {}
  }
}

function Invoke-LauncherRun {
  $hash = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($script:LauncherPath.ToLowerInvariant()))
  $mutexName = 'Local\AiHubPcWorker_' + ([BitConverter]::ToString($hash, 0, 8).Replace('-', ''))
  $created = $false
  $mutex = New-Object Threading.Mutex($true, $mutexName, [ref]$created)
  if (-not $created) {
    Write-LauncherLog 'INFO' 'duplicate launcher rejected by single-instance mutex'
    return
  }

  try {
    Remove-Item -LiteralPath $script:StopPath -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $Config)) { throw "missing config: $Config" }
    if (-not (Test-Path -LiteralPath $script:WorkerPath)) { throw "missing worker: $script:WorkerPath" }
    if (-not (Test-Path -LiteralPath $script:StateStorePath)) { throw "missing state store: $script:StateStorePath" }
    $node = (Get-Command node -ErrorAction Stop).Source
    $cfg = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
    $serverUrl = [string]$cfg.serverUrl
    if (-not $serverUrl -or -not $cfg.token) { throw 'config requires serverUrl and token' }
    $serverUri = [Uri]$serverUrl
    try {
      $script:BootId = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
    } catch {
      $script:BootId = $null
    }
    $script:Status = [ordered]@{ startedAt = Get-ShanghaiTime; serverUrl = $serverUrl }
    Save-State 'starting' 'launcher initialized'
    Write-LauncherLog 'INFO' "launcher started pid=$PID"

    if ($StartupDelaySeconds -gt 0) {
      Save-State 'waiting' "login delay ${StartupDelaySeconds}s"
      if (-not (Wait-Controlled $StartupDelaySeconds)) { return }
    }

    $crashes = New-Object Collections.Generic.List[DateTime]
    $backupCatchupStarted = $false
    while (-not (Test-StopRequested)) {
      while (-not (Test-NetworkReady $serverUri)) {
        Save-State 'waiting' 'waiting for Tailscale and gateway'
        if (-not (Wait-Controlled 10)) { break }
      }
      if (Test-StopRequested) { break }
      if (-not $backupCatchupStarted) {
        Start-BackupCatchup
        $backupCatchupStarted = $true
      }

      try {
        $workerScript = Resolve-WorkerScript $cfg
        $script:Child = Start-WorkerProcess $node $workerScript
        Save-State 'starting' 'worker process started' $script:Child.Id
        Write-LauncherLog 'INFO' "worker started pid=$($script:Child.Id) script=$workerScript"
        $lastStateWrite = [DateTime]::MinValue
        while (-not $script:Child.HasExited -and -not (Test-StopRequested)) {
          if (([DateTime]::UtcNow - $lastStateWrite).TotalSeconds -ge 10) {
            if (Test-WorkerOnline $serverUrl ([string]$cfg.token)) {
              Save-State 'online' 'worker connected to gateway' $script:Child.Id
            } elseif (Test-NetworkReady $serverUri) {
              Save-State 'starting' 'worker process alive; waiting for gateway registration' $script:Child.Id
            } else {
              Save-State 'waiting' 'worker alive; gateway unreachable' $script:Child.Id
            }
            $lastStateWrite = [DateTime]::UtcNow
          }
          Start-Sleep -Seconds 1
        }
        if (Test-StopRequested) { break }

        $exitCode = $script:Child.ExitCode
        $script:RestartCount++
        $script:LastError = "worker exited with code $exitCode"
        Write-LauncherLog 'ERROR' $script:LastError
        $now = [DateTime]::UtcNow
        $crashes.Add($now)
        for ($i = $crashes.Count - 1; $i -ge 0; $i--) {
          if (($now - $crashes[$i]).TotalMinutes -gt 10) { $crashes.RemoveAt($i) }
        }
        $delay = if ($crashes.Count -ge 5) { 300 } else { [Math]::Min(30 * [Math]::Pow(2, [Math]::Max($crashes.Count - 1, 0)), 300) }
        $next = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId($now.AddSeconds($delay), 'China Standard Time').ToString('yyyy-MM-ddTHH:mm:ss') + '+08:00'
        $state = if ($crashes.Count -ge 5) { 'failed' } else { 'restarting' }
        Save-State $state "retrying in ${delay}s" -ErrorMessage $script:LastError -NextRetryAt $next
        if (-not (Wait-Controlled ([int]$delay))) { break }
      } catch {
        # Never leave an untracked child behind: the retry would start a
        # second worker that only loses the instance lock.
        Stop-WorkerChild
        $script:RestartCount++
        $script:LastError = $_.Exception.Message
        Write-LauncherLog 'ERROR' $script:LastError
        Save-State 'failed' 'launcher could not start worker; retrying in 60s' -ErrorMessage $script:LastError
        if (-not (Wait-Controlled 60)) { break }
      } finally {
        if ($script:Child) {
          if (-not $script:Child.HasExited -and (Test-StopRequested)) { Stop-WorkerChild }
          $script:Child.Dispose()
          $script:Child = $null
        }
      }
    }
  } catch {
    $script:LastError = $_.Exception.Message
    Write-LauncherLog 'ERROR' $script:LastError
    Save-State 'failed' 'launcher initialization failed' -ErrorMessage $script:LastError
  } finally {
    Stop-WorkerChild
    Save-State 'stopped' 'launcher stopped'
    Remove-Item -LiteralPath $script:StopPath -Force -ErrorAction SilentlyContinue
    if ($mutex) { try { $mutex.ReleaseMutex() } catch {}; $mutex.Dispose() }
    Write-LauncherLog 'INFO' 'launcher stopped'
  }
}

switch ($Action) {
  'run' { Invoke-LauncherRun }
  'start' { Remove-Item -LiteralPath $script:StopPath -Force -ErrorAction SilentlyContinue; Start-HiddenLauncher 0; Write-Output 'start requested' }
  'stop' { Request-Stop; Write-Output 'stop requested' }
  'restart' { Request-Stop; Remove-Item -LiteralPath $script:StopPath -Force -ErrorAction SilentlyContinue; Start-HiddenLauncher 0; Write-Output 'restart requested' }
  'status' { Show-Status }
  'install' { Install-Launcher }
  'uninstall' { Uninstall-Launcher }
}
