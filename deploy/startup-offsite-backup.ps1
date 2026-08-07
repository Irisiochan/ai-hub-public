[CmdletBinding()]
param(
  [string]$Destination = (Join-Path $env:USERPROFILE 'Backups\ai-hub'),
  [ValidateRange(1, 8760)]
  [int]$MaxAgeHours = 20,
  [ValidateRange(0, 7200)]
  [int]$ReadyTimeoutSeconds = 1800,
  [ValidateRange(1, 600)]
  [int]$RetrySeconds = 30,
  [string]$Remote = 'User-vps',
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$pullScript = Join-Path $PSScriptRoot 'pull-offsite-backup.ps1'
$destinationRoot = [IO.Path]::GetFullPath($Destination)
$logPath = Join-Path $destinationRoot 'startup-backup.log'

function Get-ShanghaiTime {
  $value = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, 'China Standard Time')
  return $value.ToString('yyyy-MM-ddTHH:mm:ss') + '+08:00'
}

function Write-BackupEvent([string]$State, [string]$Detail, [object]$Data = $null) {
  New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
  $event = [ordered]@{
    at = Get-ShanghaiTime
    state = $State
    detail = $Detail
  }
  if ($null -ne $Data) { $event.data = $Data }
  [IO.File]::AppendAllText(
    $logPath,
    (($event | ConvertTo-Json -Compress -Depth 6) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($false)
  )
}

function Get-BackupFreshness {
  $latest = Get-ChildItem -LiteralPath $destinationRoot -File -Filter 'ai-hub-offsite-*.tar.gz' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if (-not $latest) {
    return [pscustomobject]@{ due = $true; archive = $null; ageHours = $null }
  }
  $ageHours = ([DateTime]::UtcNow - $latest.LastWriteTimeUtc).TotalHours
  return [pscustomobject]@{
    due = $ageHours -ge $MaxAgeHours
    archive = $latest.FullName
    ageHours = [Math]::Round($ageHours, 2)
  }
}

function Test-TailscaleReady {
  $tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
  if (-not (Test-Path -LiteralPath $tailscale)) { return $false }
  try {
    $status = (& $tailscale status --json 2>$null | ConvertFrom-Json)
    if ($status.BackendState -ne 'Running') { return $false }
    if ($status.ExitNodeStatus -and $status.ExitNodeStatus.Online -ne $true) { return $false }
    return $true
  } catch {
    return $false
  }
}

function Test-SshReady {
  & ssh.exe -o BatchMode=yes -o ConnectTimeout=5 $Remote 'true' 2>$null
  return $LASTEXITCODE -eq 0
}

try {
  New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
  $freshness = Get-BackupFreshness
  if ($CheckOnly) {
    [pscustomobject]@{
      ok = $true
      status = if ($freshness.due) { 'due' } else { 'recent' }
      archive = $freshness.archive
      ageHours = $freshness.ageHours
      thresholdHours = $MaxAgeHours
    } | ConvertTo-Json -Compress
    return
  }
  if (-not $freshness.due) {
    Write-BackupEvent 'skipped' 'recent verified backup is still within the startup threshold' $freshness
    [pscustomobject]@{
      ok = $true
      skipped = $true
      reason = 'recent-backup'
      archive = $freshness.archive
      ageHours = $freshness.ageHours
      thresholdHours = $MaxAgeHours
    } | ConvertTo-Json -Compress
    return
  }

  $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
  Write-BackupEvent 'waiting' 'backup is due; waiting for Tailscale and SSH'
  while (-not ((Test-TailscaleReady) -and (Test-SshReady))) {
    if ([DateTime]::UtcNow -ge $deadline) {
      throw "Tailscale/SSH did not become ready within $ReadyTimeoutSeconds seconds"
    }
    Start-Sleep -Seconds $RetrySeconds
  }

  Write-BackupEvent 'running' 'Tailscale and SSH are ready; starting catch-up backup'
  $result = @(& $pullScript -Destination $destinationRoot -Remote $Remote -SkipIfNewerThanHours $MaxAgeHours)
  Write-BackupEvent 'completed' 'startup catch-up backup finished' $result
  $result
} catch {
  Write-BackupEvent 'failed' $_.Exception.Message
  throw
}
