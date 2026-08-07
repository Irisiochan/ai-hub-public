param(
  [string]$Destination = (Join-Path $env:USERPROFILE 'Backups\ai-hub'),
  [ValidateRange(1, 365)]
  [int]$Keep = 14,
  [string]$At = '03:30',
  [string]$TaskName = 'ai-hub-offsite-backup'
)

$ErrorActionPreference = 'Stop'
$pullScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'pull-offsite-backup.ps1')).Path
$destinationRoot = [System.IO.Path]::GetFullPath($Destination)
$time = [datetime]::ParseExact($At, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)

New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null

$argument = @(
  '-NoLogo'
  '-NoProfile'
  '-NonInteractive'
  '-ExecutionPolicy Bypass'
  "-File `"$pullScript`""
  "-Destination `"$destinationRoot`""
  "-Keep $Keep"
) -join ' '

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
$trigger = New-ScheduledTaskTrigger -Daily -At $time
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'Pull and verify an ai-hub SQLite + uploads recovery bundle over Tailscale SSH.' `
  -Force `
  -ErrorAction Stop | Out-Null

[pscustomobject]@{
  ok = $true
  taskName = $TaskName
  localTime = $time.ToString('HH:mm')
  startWhenAvailable = $true
  destination = $destinationRoot
  keep = $Keep
} | ConvertTo-Json -Compress
