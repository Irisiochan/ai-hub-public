param(
  [string]$Destination = (Join-Path $env:USERPROFILE 'Backups\ai-hub'),
  [ValidateRange(1, 365)]
  [int]$Keep = 14,
  [string]$Remote = 'User-vps',
  [ValidateRange(0, 8760)]
  [int]$SkipIfNewerThanHours = 0
)

$ErrorActionPreference = 'Stop'
$verifier = Join-Path $PSScriptRoot 'offsite-backup.mjs'
$destinationRoot = [System.IO.Path]::GetFullPath($Destination)
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-hub-offsite-restore-" + [guid]::NewGuid().ToString('N'))
$mutexHash = [Security.Cryptography.SHA256]::Create().ComputeHash(
  [Text.Encoding]::UTF8.GetBytes($destinationRoot.ToLowerInvariant())
)
$mutexName = 'Local\AiHubOffsiteBackup_' + ([BitConverter]::ToString($mutexHash, 0, 8).Replace('-', ''))
$mutex = New-Object Threading.Mutex($false, $mutexName)
$mutexAcquired = $false

function Invoke-Native([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$File exited with code $LASTEXITCODE"
  }
}

try {
  try {
    $mutexAcquired = $mutex.WaitOne(0)
  } catch [Threading.AbandonedMutexException] {
    $mutexAcquired = $true
  }
  if (-not $mutexAcquired) {
    [pscustomobject]@{
      ok = $true
      skipped = $true
      reason = 'backup-already-running'
    } | ConvertTo-Json -Compress
    return
  }

  New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
  if ($SkipIfNewerThanHours -gt 0) {
    $latest = Get-ChildItem -LiteralPath $destinationRoot -File -Filter 'ai-hub-offsite-*.tar.gz' |
      Sort-Object LastWriteTimeUtc -Descending |
      Select-Object -First 1
    if ($latest) {
      $ageHours = ([DateTime]::UtcNow - $latest.LastWriteTimeUtc).TotalHours
      if ($ageHours -lt $SkipIfNewerThanHours) {
        [pscustomobject]@{
          ok = $true
          skipped = $true
          reason = 'recent-backup'
          archive = $latest.FullName
          ageHours = [Math]::Round($ageHours, 2)
          thresholdHours = $SkipIfNewerThanHours
        } | ConvertTo-Json -Compress
        return
      }
    }
  }

  $remoteOutput = & ssh $Remote 'sudo bash /opt/ai-hub/deploy/create-offsite-archive.sh'
  if ($LASTEXITCODE -ne 0) {
    throw "Remote archive creation failed with code $LASTEXITCODE"
  }
  $archiveLine = @($remoteOutput) | Where-Object { $_ -like 'ARCHIVE=*' } | Select-Object -Last 1
  if (-not $archiveLine) {
    throw 'Remote archive output did not include ARCHIVE='
  }
  $remoteArchive = $archiveLine.Substring('ARCHIVE='.Length)
  if ($remoteArchive -notmatch '^/var/backups/ai-hub/offsite/ai-hub-offsite-\d{8}T\d{6}Z\.tar\.gz$') {
    throw "Unsafe remote archive path: $remoteArchive"
  }

  $fileName = [System.IO.Path]::GetFileName($remoteArchive)
  $partFile = Join-Path $destinationRoot "$fileName.part"
  $partSha = "$partFile.sha256"
  $finalFile = Join-Path $destinationRoot $fileName

  try {
    Invoke-Native 'scp' @("${Remote}:$remoteArchive", $partFile)
    Invoke-Native 'scp' @("${Remote}:$remoteArchive.sha256", $partSha)

    $expected = ((Get-Content -LiteralPath $partSha -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') {
      throw "Invalid SHA-256 file for $fileName"
    }
    $actual = (Get-FileHash -LiteralPath $partFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "Archive SHA-256 mismatch: expected $expected, got $actual"
    }

    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    Invoke-Native 'tar.exe' @('-xzf', $partFile, '-C', $tempRoot)
    $bundleDirs = @(Get-ChildItem -LiteralPath $tempRoot -Directory)
    if ($bundleDirs.Count -ne 1) {
      throw "Archive must contain exactly one bundle directory, got $($bundleDirs.Count)"
    }
    Invoke-Native 'node.exe' @($verifier, 'verify', '--bundle', $bundleDirs[0].FullName)

    Move-Item -LiteralPath $partFile -Destination $finalFile -Force
    Remove-Item -LiteralPath $partSha -Force

    $remoteCleanup = "sudo rm -f -- '$remoteArchive' '$remoteArchive.sha256'"
    Invoke-Native 'ssh' @($Remote, $remoteCleanup)

    $archives = @(Get-ChildItem -LiteralPath $destinationRoot -File -Filter 'ai-hub-offsite-*.tar.gz' |
      Sort-Object Name -Descending)
    foreach ($old in $archives | Select-Object -Skip $Keep) {
      Remove-Item -LiteralPath $old.FullName -Force
    }

    [pscustomobject]@{
      ok = $true
      archive = $finalFile
      sha256 = $actual
      retained = @(Get-ChildItem -LiteralPath $destinationRoot -File -Filter 'ai-hub-offsite-*.tar.gz').Count
    } | ConvertTo-Json -Compress
  } finally {
    if (Test-Path -LiteralPath $partFile) { Remove-Item -LiteralPath $partFile -Force }
    if (Test-Path -LiteralPath $partSha) { Remove-Item -LiteralPath $partSha -Force }
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
  }
} finally {
  if ($mutexAcquired) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
