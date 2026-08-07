[CmdletBinding()]
param(
  [long]$RunId,
  [string]$SshHost = 'User-vps',
  [string]$RemoteRepo = '/opt/ai-hub',
  [string]$RemoteReleaseDir = '/var/lib/ai-hub/releases'
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$mobilePackage = Get-Content -LiteralPath (Join-Path $repo 'mobile/package.json') -Raw | ConvertFrom-Json
$version = [string]$mobilePackage.version
$localHead = (& git -C $repo rev-parse HEAD).Trim()

if (-not $RunId) {
  $runsJson = & gh run list --repo Irisiochan/ai-hub --workflow android.yml --branch master --status success --limit 1 --json databaseId,headSha
  if ($LASTEXITCODE -ne 0) { throw 'gh run list failed.' }
  $run = @($runsJson | ConvertFrom-Json)[0]
  if (-not $run) { throw 'No successful Android workflow run found.' }
  $RunId = [long]$run.databaseId
  $runHead = [string]$run.headSha
}
else {
  $runJson = & gh run view $RunId --repo Irisiochan/ai-hub --json headSha
  if ($LASTEXITCODE -ne 0) { throw "gh run view failed for $RunId." }
  $runHead = [string](($runJson | ConvertFrom-Json).headSha)
}

if ($runHead -ne $localHead) {
  throw "Workflow run $RunId belongs to $runHead, but local HEAD is $localHead. Refusing to publish a mismatched APK."
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) "ai-hub-apk-$([guid]::NewGuid().ToString('N'))"
$null = New-Item -ItemType Directory -Path $tempRoot

try {
  & gh run download $RunId --repo Irisiochan/ai-hub --name ai-hub-apk --dir $tempRoot
  if ($LASTEXITCODE -ne 0) { throw "Failed to download ai-hub-apk from run $RunId." }

  $apk = Get-ChildItem -LiteralPath $tempRoot -Filter '*.apk' -File | Select-Object -First 1
  if (-not $apk) { throw 'The workflow artifact did not contain an APK.' }
  $sha256 = (Get-FileHash -LiteralPath $apk.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $remoteTemp = "/tmp/ai-hub-$version-$RunId.apk"

  & scp $apk.FullName "${SshHost}:$remoteTemp"
  if ($LASTEXITCODE -ne 0) { throw 'scp failed.' }

  $publishCommand = @(
    'sudo', 'node',
    "$RemoteRepo/server/scripts/publish-apk-release.mjs",
    '--source', $remoteTemp,
    '--version', $version,
    '--sha256', $sha256,
    '--release-dir', $RemoteReleaseDir
  ) -join ' '
  & ssh $SshHost $publishCommand
  if ($LASTEXITCODE -ne 0) { throw 'Remote APK publish failed.' }

  & ssh $SshHost "rm -f '$remoteTemp'"
  if ($LASTEXITCODE -ne 0) { Write-Warning "Published successfully, but could not remove $remoteTemp." }

  [pscustomobject]@{
    ok = $true
    runId = $RunId
    version = $version
    sha256 = $sha256
    url = "/releases/ai-hub-$version.apk"
  } | ConvertTo-Json
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
