# Deterministic lane-A merge/push runner. It deliberately stops before deploy.
#
# R3: same repo priority as the posix entry. Explicit -Repo keeps the
# built-in ai-hub suite set (the only one this entry knows) and never reads
# a manifest; otherwise < -RepoDir or cwd >/.ai-hub-merge.json declares
# repoId/targetBranch/suites (manifest suites run with cwd=repoDir, only
# `npm`/`node` commands, invalid manifests refuse fail-closed); otherwise
# the historical ai-hub default. The receipt reports repoId + manifest.
# -DryRun runs every gate but records validation passes without executing
# and never pushes (mirrors the posix --dry-run).
#
# Open-governance O5: worktree-safe (never `git switch`es to the target branch,
# so it runs inside a linked worktree while another checkout holds master).
# Release-evidence handling is two-step: a LOCAL self-check against the
# -ReleaseEvidence argument (deliberately not called a hard gate — the
# argument is just a claim) followed by SERVER re-verification via a bearer
# callback to the gateway ledger (live candidate_sha / review_status).
# The server re-verification is a HARD gate whenever the evidence carries a
# roomId: missing bearer, unreachable gateway, non-2xx or a ledger body
# without task.candidate_sha all fail the job (fail-closed).
# The merge itself is a direct `push <frozen>:refs/heads/<target>` after
# ancestry + validation gates. The only ancestry gate is
# `<remote>/<target>` must be an ancestor of <frozen> (freshness); a rebase
# always rewrites history, so the claimed -BaselineSha (the candidate job's
# before.head evidence baked at release time) is NEVER asserted against
# <frozen>. It is recorded in the receipt only. The merge baseline written to
# the receipt is computed live as `git merge-base <remote>/<target> <frozen>`.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$FrozenSha,

  # Claimed baseline: the candidate job's before.head evidence baked at
  # release time. Optional and informational only — a rebase rewrites history
  # so it is routinely NOT an ancestor of frozen. Recorded in the receipt,
  # never asserted. The merge baseline is computed live after fetch.
  [string]$BaselineSha = '',

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._/-]{1,120}$')]
  [ValidateScript({ -not $_.StartsWith('-') -and -not $_.StartsWith('/') -and -not $_.EndsWith('/') -and -not $_.Contains('..') -and -not $_.Contains('//') })]
  [string]$WorkingBranch,

  [ValidatePattern('^[A-Za-z0-9._-]{1,80}$')]
  [ValidateScript({ -not $_.StartsWith('-') })]
  [string]$Remote = 'origin',

  [ValidatePattern('^[A-Za-z0-9._/-]{1,120}$')]
  [ValidateScript({ -not $_.StartsWith('-') -and -not $_.StartsWith('/') -and -not $_.EndsWith('/') -and -not $_.Contains('..') -and -not $_.Contains('//') })]
  [string]$TargetBranch = 'master',

  [Parameter(Mandatory = $true)]
  [string]$ReleaseEvidence,

  [string]$MainCheckoutPath = '',

  [string]$GatewayUrl = '',

  [string]$VerifyToken = '',

  # R3: explicit repo tag. When given it keeps the built-in ai-hub mapping
  # (the only suite set this entry knows) and never reads a manifest.
  [ValidateScript({ $_ -eq '' -or ($_ -match '^[A-Za-z0-9._-]{1,80}$' -and -not $_.StartsWith('-')) })]
  [string]$Repo = '',

  # R3: repo checkout carrying .ai-hub-merge.json. The gateway stamps the
  # candidate workspace here; empty means the current directory.
  [string]$RepoDir = '',

  [switch]$RequireServerVerify,

  # Validation + push are skipped; gates still run and the receipt reports
  # pass with dryRun flags (mirrors the posix --dry-run).
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$frozen = $FrozenSha.ToLowerInvariant()
$claimedBaseline = if ($BaselineSha) { $BaselineSha.ToLowerInvariant() } else { '' }
if ($claimedBaseline -and $claimedBaseline -notmatch '^[0-9a-f]{40}$') {
  throw "claimed -BaselineSha is not a 40-hex SHA: $BaselineSha"
}
$tests = New-Object System.Collections.Generic.List[object]
# R3 receipt fields (defaults = historical ai-hub behavior); the resolver
# inside try reassigns them before any gate runs.
$repoId = 'ai-hub'
$manifestUsed = $false

function Invoke-Checked([string]$Suite, [string]$Command, [string[]]$Arguments) {
  # PS 5.1: native stderr becomes a terminating error under Stop before any
  # $LASTEXITCODE check runs. Hold Continue across the call and judge ONLY by
  # the exit code (the task's "stderr 误判" defect); cmdlet errors elsewhere
  # still stop via the global preference.
  $prevAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command @Arguments
  } finally {
    $ErrorActionPreference = $prevAction
  }
  if ($LASTEXITCODE -ne 0) {
    $tests.Add([ordered]@{ suite = $Suite; status = 'fail' })
    throw "$Suite failed with exit code $LASTEXITCODE"
  }
  $tests.Add([ordered]@{ suite = $Suite; status = 'pass' })
}

function Invoke-Git([string[]]$Arguments) {
  $prevAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & git @Arguments 2>&1
  } finally {
    $ErrorActionPreference = $prevAction
  }
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
  }
  return ($output -join "`n").Trim()
}

function Test-Ancestor([string]$Ancestor, [string]$Descendant) {
  $prevAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & git merge-base --is-ancestor $Ancestor $Descendant 2>&1 | Out-Null
  } finally {
    $ErrorActionPreference = $prevAction
  }
  return $LASTEXITCODE -eq 0
}

# R3: in-repo merge manifest (<repoDir>/.ai-hub-merge.json). Same priority as
# the posix entry: explicit -Repo keeps the built-in mapping; otherwise a
# manifest declares repoId/targetBranch/suites (invalid refuses fail-closed);
# otherwise the historical ai-hub default. Returns a hashtable with repoId,
# targetBranch (possibly overriding -TargetBranch), manifestUsed, manifestCwd
# and suites (@{ suite; command; args }).
function Resolve-MergeRepo([string]$Repo, [string]$RepoDir, [string]$TargetBranch, [bool]$TargetExplicit) {
  $explicit = ($Repo -ne '')
  if ($explicit) {
    if ($Repo.ToLowerInvariant() -ne 'ai-hub') {
      throw "no validation suites configured for repo: $Repo; refusing to run another repo's suites"
    }
    return @{ repoId = 'ai-hub'; targetBranch = $TargetBranch; manifestUsed = $false; manifestCwd = $null; suites = $null }
  }
  $base = if ($RepoDir -ne '') { $RepoDir } else { (Get-Location).Path }
  if ($RepoDir -ne '') {
    if ($RepoDir.StartsWith('-') -or $RepoDir.Length -gt 500 -or $RepoDir.Contains("`0")) { throw 'invalid repoDir' }
    if (-not (Test-Path -LiteralPath $RepoDir -PathType Container)) { throw "repoDir not found: $RepoDir" }
    $base = (Resolve-Path -LiteralPath $RepoDir).Path
  }
  $manifestPath = Join-Path $base '.ai-hub-merge.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    return @{ repoId = 'ai-hub'; targetBranch = $TargetBranch; manifestUsed = $false; manifestCwd = $null; suites = $null }
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
  $manifestRepo = [string]$manifest.repoId
  if ($manifestRepo -notmatch '^[A-Za-z0-9._-]{1,80}$') { throw "merge manifest ${manifestPath}: invalid repoId" }
  $manifestTarget = [string]$manifest.targetBranch
  if ($manifestTarget -notmatch '^[A-Za-z0-9._/-]{1,120}$' -or $manifestTarget.StartsWith('-') -or $manifestTarget.StartsWith('/') `
    -or $manifestTarget.EndsWith('/') -or $manifestTarget.Contains('..') -or $manifestTarget.Contains('//')) {
    throw "merge manifest ${manifestPath}: invalid targetBranch"
  }
  $entries = @($manifest.validation)
  if (($null -eq $manifest.validation) -or ($manifest.validation -isnot [Array]) -or $entries.Count -eq 0 -or $entries.Count -gt 32) {
    throw "merge manifest ${manifestPath}: validation must be a non-empty array (max 32)"
  }
  $suites = New-Object System.Collections.Generic.List[object]
  $index = 0
  foreach ($entry in $entries) {
    $where = "$manifestPath validation[$index]"
    $name = [string]$entry.suite
    if ($name.Length -eq 0 -or $name.Length -gt 120 -or $name.Contains("`r") -or $name.Contains("`n")) {
      throw "merge manifest ${where}: suite must be 1-120 chars without newlines"
    }
    $command = [string]$entry.command
    if ($command -cne 'npm' -and $command -cne 'node') {
      throw "merge manifest ${where}: command must be one of npm, node"
    }
    $entryArgs = @($entry.args)
    if (($null -eq $entry.args) -or ($entry.args -isnot [Array]) -or $entryArgs.Count -eq 0 -or $entryArgs.Count -gt 64) {
      throw "merge manifest ${where}: args must be a non-empty string array"
    }
    $cleanArgs = New-Object System.Collections.Generic.List[string]
    foreach ($arg in $entryArgs) {
      if ($arg -isnot [string]) { throw "merge manifest ${where}: args entries must be strings without newlines or '..'" }
      $text = [string]$arg
      if ($text.Length -eq 0 -or $text.Length -gt 1000 -or $text.Contains("`r") -or $text.Contains("`n") `
        -or $text.Contains("`0") -or $text.Contains('..')) {
        throw "merge manifest ${where}: args entries must be strings without newlines or '..'"
      }
      $cleanArgs.Add($text)
    }
    $suites.Add([ordered]@{ suite = $name; command = $command; args = $cleanArgs.ToArray() })
    $index += 1
  }
  $effectiveTarget = if ($TargetExplicit) { $TargetBranch } else { $manifestTarget }
  return @{ repoId = $manifestRepo.ToLowerInvariant(); targetBranch = $effectiveTarget; manifestUsed = $true; manifestCwd = $base; suites = $suites.ToArray() }
}

try {
  # R3 repo resolution (same priority as the posix entry): explicit -Repo
  # keeps the built-in ai-hub mapping; otherwise a manifest under -RepoDir
  # (or cwd) declares repoId/targetBranch/suites; otherwise ai-hub default.
  $resolved = Resolve-MergeRepo $Repo $RepoDir $TargetBranch ($PSBoundParameters.ContainsKey('TargetBranch'))
  $repoId = $resolved.repoId
  $TargetBranch = $resolved.targetBranch
  $manifestUsed = [bool]$resolved.manifestUsed
  $manifestSuites = $resolved.suites
  $manifestCwd = $resolved.manifestCwd
  # Gate L: release-evidence self-check + server re-verification.
  # release_execute baked these facts from the ledger (not chat), but the
  # -ReleaseEvidence argument itself is only a claim, so the local
  # comparison below is a self-check, never a hard gate. The binding check
  # is the bearer callback to the gateway ledger immediately after.
  $evidence = $ReleaseEvidence | ConvertFrom-Json
  $evidenceCandidate = ([string]$evidence.candidateSha).ToLowerInvariant()
  if ($evidenceCandidate -ne $frozen) {
    throw "ledger self-check rejected: evidence candidate $($evidence.candidateSha) != frozen $frozen"
  }
  if ([string]$evidence.reviewStatus -ne 'approved') {
    throw "ledger self-check rejected: review status '$($evidence.reviewStatus)' is not approved"
  }
  $evidenceTask = [string]$evidence.taskPath
  if (-not $evidenceTask -or $evidenceTask -notmatch '^tasks/[^/\\]{1,100}\.md$') {
    throw "ledger self-check rejected: bad task path '$evidenceTask'"
  }
  $evidenceRoom = [string]$evidence.roomId

  # Server re-verification: bearer callback to the gateway ledger, checking
  # the live candidate_sha / review_status instead of trusting the argument.
  # When the evidence carries the release-time roomId this is a HARD gate:
  # missing bearer, unreachable gateway, timeout, non-2xx answer or a ledger
  # body without task.candidate_sha all throw (fail-closed). Evidence without
  # a roomId is a manual (non-release_execute) run: local self-check only,
  # unless -RequireServerVerify forces the gate.
  # Bearer sources: explicit -VerifyToken (an explicitly passed empty string
  # disables the env fallback so tests stay hermetic on hosts carrying a
  # User-level AI_HUB_TOKEN), else AI_HUB_TOKEN user env, else process env
  # (same as room-deploy-job.ps1); -GatewayUrl overrides AI_HUB_URL.
  $verifyTokenBound = $PSBoundParameters.ContainsKey('VerifyToken')
  $verifyToken = if ($verifyTokenBound) { $VerifyToken } else { [Environment]::GetEnvironmentVariable('AI_HUB_TOKEN', 'User') }
  if (-not $verifyTokenBound -and -not $verifyToken) { $verifyToken = $env:AI_HUB_TOKEN }
  $gateway = if ($GatewayUrl) { $GatewayUrl.TrimEnd('/') } elseif ($env:AI_HUB_URL) { $env:AI_HUB_URL.TrimEnd('/') } else { 'http://100.64.0.10:3900' }
  if ($evidenceRoom) {
    if ($evidenceRoom -notmatch '^[A-Za-z0-9._:-]{1,80}$') {
      throw "server re-verification rejected: bad room id '$evidenceRoom'"
    }
    if (-not $verifyToken) {
      throw 'server re-verification rejected: no bearer (AI_HUB_TOKEN user env or -VerifyToken)'
    }
    $taskFile = $evidenceTask -replace '^tasks/', ''
    $uri = "$gateway/api/room-tasks/$evidenceRoom/$taskFile"
    $prevProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    $prevAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $ledger = Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $verifyToken" } -TimeoutSec 15
    } catch {
      $detail = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
      throw "server re-verification rejected: gateway $gateway failed: $detail"
    } finally {
      $ProgressPreference = $prevProgress
      $ErrorActionPreference = $prevAction
    }
    if (-not $ledger) {
      throw "server re-verification rejected: gateway $gateway returned an empty ledger body for this task"
    }
    $liveCandidate = ([string]$ledger.task.candidate_sha).ToLowerInvariant()
    $liveReview = [string]$ledger.task.review_status
    if (-not $liveCandidate) {
      throw "server re-verification rejected: gateway $gateway ledger returned no candidate_sha for this task"
    }
    if ($liveCandidate -ne $frozen) {
      throw "server re-verification rejected: ledger candidate $liveCandidate != frozen $frozen"
    }
    if ($liveReview -ne 'approved') {
      throw "server re-verification rejected: ledger review status '$liveReview' is not approved"
    }
  } else {
    if ($RequireServerVerify) {
      throw 'server re-verification rejected: evidence has no roomId (-RequireServerVerify)'
    }
    Write-Warning 'merge-close-job: evidence 无 roomId，跳过服务端回验 (local self-check only, not a hard gate)'
  }

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
  # No baseline→frozen ancestry assertion, ever: before.head (claimed
  # -BaselineSha) and the merge baseline are different concepts. Any rebased
  # candidate dies under such an assertion, so it was removed deliberately.

  $null = Invoke-Git @('fetch', $Remote, $TargetBranch)
  # Freshness comes from the just-fetched remote-tracking ref: the local
  # refs/heads/<target> may legitimately lag (worker workspaces never check it
  # out), so it is not compared. Ancestry + push + ls-remote carry the safety.
  $remoteTarget = (Invoke-Git @('rev-parse', "refs/remotes/$Remote/$TargetBranch")).ToLowerInvariant()

  # Stale candidate: master moved past the frozen candidate, so a fast-forward
  # is impossible. Report machine-readable stale (the gateway auto-passes the
  # task back to execute with a rebase note); never push, never rewrite.
  if (-not (Test-Ancestor $remoteTarget $frozen)) {
    [ordered]@{
      ok = $false
      lane = 'merge'
      stale = $true
      taskPath = $evidenceTask
      frozen = $frozen
      masterSha = $remoteTarget
      repoId = $repoId
      manifest = $manifestUsed
      error = "stale candidate: $TargetBranch=$remoteTarget is not an ancestor of frozen $frozen; rebase onto $remoteTarget"
      tests = $tests
    } | ConvertTo-Json -Compress -Depth 5
    exit 1
  }

  # The merge baseline is a live computation, not the claimed before.head:
  # the fork point of frozen off the current remote target.
  $computedBaseline = (Invoke-Git @('merge-base', $remoteTarget, $frozen)).ToLowerInvariant()

  # Validation runs on the frozen HEAD in place: no `git switch` to the target
  # branch (a linked worktree cannot check out a branch held by another
  # checkout), so the working branch is never disturbed. A manifest-declared
  # suite set runs with cwd=repoDir; -DryRun records passes without running.
  if ($manifestUsed) {
    Push-Location -LiteralPath $manifestCwd
    try {
      foreach ($step in $manifestSuites) {
        if ($DryRun) {
          $tests.Add([ordered]@{ suite = $step.suite; status = 'pass'; dryRun = $true })
        } else {
          Invoke-Checked $step.suite $step.command ([string[]]$step.args)
        }
      }
    } finally {
      Pop-Location
    }
  } elseif ($DryRun) {
    foreach ($name in @('server npm run pretest', 'server npm test', 'web npm test',
      'smoke:deploy-drain', 'smoke:turn-timeouts', 'smoke:deploy-resume')) {
      $tests.Add([ordered]@{ suite = $name; status = 'pass'; dryRun = $true })
    }
  } else {
    Invoke-Checked 'server npm run pretest' 'npm' @('run', 'pretest', '--prefix', 'server')
    Invoke-Checked 'server npm test' 'npm' @('test', '--prefix', 'server')
    Invoke-Checked 'web npm test' 'npm' @('test', '--prefix', 'web')
    Invoke-Checked 'smoke:deploy-drain' 'npm' @('run', 'smoke:deploy-drain', '--prefix', 'server')
    Invoke-Checked 'smoke:turn-timeouts' 'npm' @('run', 'smoke:turn-timeouts', '--prefix', 'server')
    Invoke-Checked 'smoke:deploy-resume' 'npm' @('run', 'smoke:deploy-resume', '--prefix', 'server')
  }

  $dirtyAfter = Invoke-Git @('status', '--porcelain=v1', '--untracked-files=all')
  if ($dirtyAfter) { throw "validation dirtied the workspace:`n$dirtyAfter" }
  # Direct ref update: no checkout, no merge commit, no force. Fails when the
  # remote moved since fetch (non-fast-forward), which is retried, never forced.
  # -DryRun stops before the push (gates above still ran).
  $pushedSha = $null
  if (-not $DryRun) {
    $null = Invoke-Git @('push', $Remote, "${frozen}:refs/heads/${TargetBranch}")
    $remoteLine = Invoke-Git @('ls-remote', $Remote, "refs/heads/$TargetBranch")
    $pushedSha = (($remoteLine -split '\s+')[0]).ToLowerInvariant()
    if ($pushedSha -ne $frozen) { throw "remote verification mismatch: expected $frozen, got $pushedSha" }
  }

  # Optional main-checkout fast-forward (best-effort, never fails the job).
  $mainPull = $null
  if ($MainCheckoutPath -and (Test-Path -LiteralPath $MainCheckoutPath)) {
    $prevAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $pullOutput = & git -C $MainCheckoutPath pull --ff-only 2>&1
      $pullCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prevAction
    }
    $mainPull = [ordered]@{
      path = $MainCheckoutPath
      exitCode = $pullCode
      output = ($pullOutput -join "`n")
    }
  }

  [ordered]@{
    ok = $true
    lane = 'merge'
    branch = $TargetBranch
    head = $frozen
    baselineSha = $computedBaseline
    claimedBaselineSha = $claimedBaseline
    taskPath = $evidenceTask
    remote = $Remote
    targetBranch = $TargetBranch
    repoId = $repoId
    manifest = $manifestUsed
    dryRun = [bool]$DryRun
    tests = $tests
    mainPull = $mainPull
  } | ConvertTo-Json -Compress -Depth 5
  exit 0
} catch {
  [ordered]@{
    ok = $false
    lane = 'merge'
    stale = $false
    repoId = $repoId
    manifest = $manifestUsed
    error = $_.Exception.Message
    tests = $tests
  } | ConvertTo-Json -Compress -Depth 5
  exit 1
}
