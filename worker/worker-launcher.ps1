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
$script:BootId = $null

function Get-ShanghaiTime {
  $value = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'China Standard Time')
  return $value.ToString('yyyy-MM-ddTHH:mm:ss') + '+08:00'
}

function Write-LauncherLog([string]$Level, [string]$Message) {
  $line = "[$(Get-ShanghaiTime)] $Level launcher $Message"
  [IO.File]::AppendAllText($script:LogPath, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
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

function Start-HiddenLauncher([int]$DelaySeconds = 0) {
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
  $command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Action run -Config "{1}" -StartupDelaySeconds 300' -f $script:LauncherPath, $Config
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

function Test-WorkerOnline([string]$ServerUrl, [string]$WorkerId) {
  try {
    $response = Invoke-RestMethod -Uri ($ServerUrl.TrimEnd('/') + '/api/workers') -TimeoutSec 5
    return $null -ne ($response.workers | Where-Object { $_.id -eq $WorkerId -and $_.status -in @('online', 'busy', 'paused') } | Select-Object -First 1)
  } catch { return $false }
}

function Start-WorkerProcess([string]$NodePath) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $NodePath
  $info.Arguments = ('"{0}" "{1}"' -f $script:WorkerPath, $Config)
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
    $workerId = ([string]$cfg.token).Split('.')[0]
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
    while (-not (Test-StopRequested)) {
      while (-not (Test-NetworkReady $serverUri)) {
        Save-State 'waiting' 'waiting for Tailscale and gateway'
        if (-not (Wait-Controlled 10)) { break }
      }
      if (Test-StopRequested) { break }
      try {
        $script:Child = Start-WorkerProcess $node
        Save-State 'starting' 'worker process started' $script:Child.Id
        Write-LauncherLog 'INFO' "worker started pid=$($script:Child.Id)"
        $lastStateWrite = [DateTime]::MinValue
        while (-not $script:Child.HasExited -and -not (Test-StopRequested)) {
          if (([DateTime]::UtcNow - $lastStateWrite).TotalSeconds -ge 10) {
            if (Test-WorkerOnline $serverUrl $workerId) {
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
