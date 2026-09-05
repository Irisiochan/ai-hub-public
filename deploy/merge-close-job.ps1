# Deterministic lane-A merge/push runner. It deliberately stops before deploy.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$FrozenSha,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$BaselineSha,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._/-]{1,120}$')]
  [ValidateScript({ -not $_.StartsWith('-') -and -not $_.StartsWith('/') -and -not $_.EndsWith('/') -and -not $_.Contains('..') -and -not $_.Contains('//') })]
  [string]$WorkingBranch,

  [ValidatePattern('^[A-Za-z0-9._-]{1,80}$')]
  [ValidateScript({ -not $_.StartsWith('-') })]
  [string]$Remote = 'origin',

  [ValidatePattern('^[A-Za-z0-9._/-]{1,120}$')]
  [ValidateScript({ -not $_.StartsWith('-') -and -not $_.StartsWith('/') -and -not $_.EndsWith('/') -and -not $_.Contains('..') -and -not $_.Contains('//') })]
  [string]$TargetBranch = 'master'
)

$ErrorActionPreference = 'Stop'
$frozen = $FrozenSha.ToLowerInvariant()
$baseline = $BaselineSha.ToLowerInvariant()
$tests = New-Object System.Collections.Generic.List[object]

function Invoke-Checked([string]$Suite, [string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    $tests.Add([ordered]@{ suite = $Suite; status = 'fail' })
    throw "$Suite failed with exit code $LASTEXITCODE"
  }
  $tests.Add([ordered]@{ suite = $Suite; status = 'pass' })
}

function Invoke-Git([string[]]$Arguments) {
  $output = & git @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
  }
  return ($output -join "`n").Trim()
}

function Assert-Ancestor([string]$Ancestor, [string]$Descendant, [string]$Label) {
  & git merge-base --is-ancestor $Ancestor $Descendant
  if ($LASTEXITCODE -ne 0) { throw "$Label is not an ancestor: $Ancestor -> $Descendant" }
}

try {
  if ((Invoke-Git @('rev-parse', '--is-inside-work-tree')) -ne 'true') {
    throw 'workspace is not a git work tree'
  }
  $dirty = Invoke-Git @('status', '--porcelain=v1', '--untracked-files=all')
  if ($dirty) { throw "Gate0 rejected dirty workspace:`n$dirty" }

  $currentBranch = Invoke-Git @('branch', '--show-current')
  $currentHead = (Invoke-Git @('rev-parse', 'HEAD')).ToLowerInvariant()
  if ($currentBranch -ne $WorkingBranch) {
    throw "Gate0 branch mismatch: expected $WorkingBranch, got $currentBranch"
  }
  if ($currentHead -ne $frozen) {
    throw "Gate0 frozen SHA mismatch: expected $frozen, got $currentHead"
  }
  Assert-Ancestor $baseline $frozen 'baseline'

  $null = Invoke-Git @('fetch', $Remote, $TargetBranch)
  $localTarget = (Invoke-Git @('rev-parse', "refs/heads/$TargetBranch")).ToLowerInvariant()
  $remoteTarget = (Invoke-Git @('rev-parse', "refs/remotes/$Remote/$TargetBranch")).ToLowerInvariant()
  if ($localTarget -ne $remoteTarget) {
    throw "Gate0 target drift: local $TargetBranch=$localTarget, $Remote/$TargetBranch=$remoteTarget"
  }
  Assert-Ancestor $localTarget $frozen 'target branch'

  $null = Invoke-Git @('switch', $TargetBranch)
  $null = Invoke-Git @('merge', '--ff-only', $frozen)
  $mergedHead = (Invoke-Git @('rev-parse', 'HEAD')).ToLowerInvariant()
  if ($mergedHead -ne $frozen) { throw "ff-only merge ended at $mergedHead instead of $frozen" }

  Invoke-Checked 'server npm run pretest' 'npm' @('run', 'pretest', '--prefix', 'server')
  Invoke-Checked 'server npm test' 'npm' @('test', '--prefix', 'server')
  Invoke-Checked 'web npm test' 'npm' @('test', '--prefix', 'web')
  Invoke-Checked 'smoke:deploy-drain' 'npm' @('run', 'smoke:deploy-drain', '--prefix', 'server')
  Invoke-Checked 'smoke:turn-timeouts' 'npm' @('run', 'smoke:turn-timeouts', '--prefix', 'server')
  Invoke-Checked 'smoke:review-auto-batch' 'npm' @('run', 'smoke:review-auto-batch', '--prefix', 'server')
  Invoke-Checked 'smoke:deploy-resume' 'npm' @('run', 'smoke:deploy-resume', '--prefix', 'server')
  Invoke-Checked 'smoke:receipt-deploy-closure' 'npm' @('run', 'smoke:receipt-deploy-closure', '--prefix', 'server')

  $dirtyAfter = Invoke-Git @('status', '--porcelain=v1', '--untracked-files=all')
  if ($dirtyAfter) { throw "validation dirtied the workspace:`n$dirtyAfter" }
  $null = Invoke-Git @('push', $Remote, "HEAD:refs/heads/$TargetBranch")
  $remoteLine = Invoke-Git @('ls-remote', $Remote, "refs/heads/$TargetBranch")
  $pushedSha = (($remoteLine -split '\s+')[0]).ToLowerInvariant()
  if ($pushedSha -ne $frozen) { throw "remote verification mismatch: expected $frozen, got $pushedSha" }

  [ordered]@{
    ok = $true
    lane = 'merge'
    branch = $TargetBranch
    head = $frozen
    baselineSha = $baseline
    remote = $Remote
    targetBranch = $TargetBranch
    tests = $tests
  } | ConvertTo-Json -Compress -Depth 5
  exit 0
} catch {
  [ordered]@{
    ok = $false
    lane = 'merge'
    error = $_.Exception.Message
    tests = $tests
  } | ConvertTo-Json -Compress -Depth 5
  exit 1
}
