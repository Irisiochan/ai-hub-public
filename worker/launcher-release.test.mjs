// worker-launcher.ps1 runs a per-commit export of worker/ + shared/ + deploy/ instead
// of whatever branch the shared checkout has checked out. Windows-only: the
// launcher is PowerShell. Exercises the real Resolve-WorkerScript function.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker-launcher.ps1');

function runResolver(repo, localAppData, releaseRef) {
  const script = `
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${launcher.replaceAll("'", "''")}', [ref]$null, [ref]$null)
foreach ($name in 'Write-LauncherLog', 'Resolve-WorkerScript') {
  $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1
  . ([scriptblock]::Create($fn.Extent.Text))
}
function Get-ShanghaiTime { 'now' }
$env:LOCALAPPDATA = '${localAppData.replaceAll("'", "''")}'
$script:WorkerDir = Join-Path '${repo.replaceAll("'", "''")}' 'worker'
$script:WorkerPath = Join-Path $script:WorkerDir 'worker.mjs'
$script:LogPath = Join-Path $env:LOCALAPPDATA 'launcher.log'
$cfg = [pscustomobject]@{ releaseRef = '${releaseRef}' }
Resolve-WorkerScript $cfg
`;
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
}

test('launcher logging tolerates the worker holding worker.log open', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-launcher-log-'));
  const log = path.join(root, 'worker.log');
  const fd = fs.openSync(log, 'a');
  try {
    fs.writeSync(fd, 'worker line\n');
    const script = `
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${launcher.replaceAll("'", "''")}', [ref]$null, [ref]$null)
$fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Write-LauncherLog' }, $true) | Select-Object -First 1
. ([scriptblock]::Create($fn.Extent.Text))
function Get-ShanghaiTime { 'now' }
$script:LogPath = '${log.replaceAll("'", "''")}'
Write-LauncherLog 'INFO' 'worker started pid=1'
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    fs.writeSync(fd, 'worker line 2\n');
  } finally {
    fs.closeSync(fd);
  }
  const text = fs.readFileSync(log, 'utf8');
  assert.match(text, /INFO launcher worker started pid=1/);
  assert.match(text, /worker line 2/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('start detaches the launcher from the caller tree via WMI (parent WmiPrvSE)', { skip: process.platform !== 'win32' }, async () => {
  // A launcher left inside the caller's Job dies with that caller: seen live
  // when a Codex desktop auto-update killed a Codex-issued restart.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-launcher-detach-'));
  const stub = path.join(root, 'stub-launcher.ps1');
  const out = path.join(root, 'parent.txt');
  fs.writeFileSync(stub, `param([string]$Action, [string]$Config, [int]$StartupDelaySeconds)
$me = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
$parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($me.ParentProcessId)"
[IO.File]::WriteAllText($Config, "$($parent.Name)|$Action|$StartupDelaySeconds")
`);
  const script = `
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${launcher.replaceAll("'", "''")}', [ref]$null, [ref]$null)
foreach ($name in 'Write-LauncherLog', 'Get-LauncherCommandLine', 'Start-HiddenLauncher') {
  $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1
  . ([scriptblock]::Create($fn.Extent.Text))
}
function Get-ShanghaiTime { 'now' }
$script:LogPath = '${path.join(root, 'launcher.log').replaceAll("'", "''")}'
$script:LauncherPath = '${stub.replaceAll("'", "''")}'
$Config = '${out.replaceAll("'", "''")}'
Start-HiddenLauncher 7
`;
  try {
    const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.ok(fs.existsSync(out), 'stub launcher never ran');
    assert.equal(fs.readFileSync(out, 'utf8'), 'WmiPrvSE.exe|run|7');
    assert.equal(fs.existsSync(path.join(root, 'launcher.log')), false, 'no Start-Process fallback warning');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launcher runs an exported release of the configured ref, not the checked-out branch', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-launcher-release-'));
  const repo = path.join(root, 'repo');
  const appData = path.join(root, 'appdata');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  try {
    fs.mkdirSync(path.join(repo, 'worker'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'shared', 'keys'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'deploy'), { recursive: true });
    fs.mkdirSync(appData);
    git('init', '--initial-branch=master');
    git('config', 'user.email', 'worker-test@example.invalid');
    git('config', 'user.name', 'Worker Test');
    fs.writeFileSync(path.join(repo, 'worker', 'worker.mjs'), "export const flavor = 'master';\n");
    fs.writeFileSync(path.join(repo, 'shared', 'keys', 'index.mjs'), 'export {};\n');
    fs.writeFileSync(path.join(repo, 'deploy', 'merge-close-job.ps1'), '# gate: master\n');
    git('add', '.');
    git('commit', '-m', 'master');
    const masterSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    git('checkout', '-b', 'task/unreviewed');
    fs.writeFileSync(path.join(repo, 'worker', 'worker.mjs'), "export const flavor = 'unreviewed';\n");
    // An unreviewed branch rewriting its own merge gate must not reach the
    // release: closure scripts are resolved from the release, not the checkout.
    fs.writeFileSync(path.join(repo, 'deploy', 'merge-close-job.ps1'), '# gate: weakened by the candidate\n');
    git('commit', '-am', 'unreviewed');

    const first = runResolver(repo, appData, 'master');
    assert.equal(first.status, 0, first.stderr);
    const script = first.stdout.trim().split(/\r?\n/).pop();
    assert.equal(path.normalize(script), path.join(appData, 'ai-hub-worker', 'releases', masterSha, 'worker', 'worker.mjs'));
    assert.match(fs.readFileSync(script, 'utf8'), /'master'/, 'the checked-out task branch must not leak into the release');
    assert.ok(fs.existsSync(path.join(appData, 'ai-hub-worker', 'releases', masterSha, 'shared', 'keys', 'index.mjs')));
    const releasedGate = path.join(appData, 'ai-hub-worker', 'releases', masterSha, 'deploy', 'merge-close-job.ps1');
    assert.ok(fs.existsSync(releasedGate), 'the release must carry deploy/ so closure gates resolve from it');
    assert.match(fs.readFileSync(releasedGate, 'utf8'), /gate: master/, 'the candidate branch must not supply its own gate');

    const again = runResolver(repo, appData, 'master');
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout.trim().split(/\r?\n/).pop(), script, 'an existing release is reused');

    const missing = runResolver(repo, appData, 'no-such-ref');
    assert.notEqual(missing.status, 0, 'an unresolvable ref refuses to fall back to the checkout');

    const direct = runResolver(repo, appData, '');
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(path.normalize(direct.stdout.trim().split(/\r?\n/).pop()), path.join(repo, 'worker', 'worker.mjs'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
