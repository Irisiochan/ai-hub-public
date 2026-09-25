# Exercise the polling functions without triggering a real deployment.
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'room-deploy-job.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "deploy script parse failed: $parseErrors" }
foreach ($name in @('Get-DeployOkEvidence', 'Test-ShaMatches', 'Get-LastDeployMarkerKind', 'Wait-DeployResult')) {
  $definition = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
  if (-not $definition) { throw "missing function $name" }
  Invoke-Expression $definition.Extent.Text
}

$targetSha = 'b' * 40
$oldSha = 'a' * 40
$baselineTail = "== deploy ok $oldSha =="
$TimeoutSeconds = 10
$PollSeconds = 1
$UnreachableToleranceSeconds = 2
$started = [Diagnostics.Stopwatch]::StartNew()
function Start-Sleep { param([int]$Seconds) }
function Get-DeployStatusOrNull {
  param([hashtable]$Headers)
  $value = $script:statuses[$script:statusIndex]
  $script:statusIndex++
  return $value
}

$script:statuses = @(
  [pscustomobject]@{ running = $false; tail = $baselineTail },
  [pscustomobject]@{ running = $true; tail = "$baselineTail`n== deploy start ==" },
  [pscustomobject]@{ running = $false; tail = "$baselineTail`n== deploy start ==`n== deploy ok $targetSha ==" }
)
$script:statusIndex = 0
$result = Wait-DeployResult @{} $baselineTail
if ($script:statusIndex -ne 3 -or -not (Get-DeployOkEvidence $result)) { throw 'stale idle receipt ended polling early' }

$script:statuses = @(
  [pscustomobject]@{ running = $false; tail = $baselineTail },
  [pscustomobject]@{ running = $false; tail = "$baselineTail`n== deploy start ==`n== deploy fail ==" }
)
$script:statusIndex = 0
try {
  $null = Wait-DeployResult @{} $baselineTail
  throw 'new deploy fail was accepted'
} catch {
  if ($_.Exception.Message -notmatch 'deployment failed') { throw }
}
Write-Output 'Windows deployment receipt polling: pass'
