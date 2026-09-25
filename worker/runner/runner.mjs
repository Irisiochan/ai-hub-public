import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SESSION_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MODEL_RE = /^[a-zA-Z0-9._-]{1,100}$/;
const OPENCODE_MODEL_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]{1,80}$/;
const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const OPENCODE_VARIANTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const CLAUDE_PERMISSIONS = {
  read: { allowed: ['Read', 'Grep', 'Glob'], denied: ['Bash'] },
  // shellRead cannot exist on claude: Bash can write files, so granting it
  // would silently allow writes. Deny shell (downgrade to read) instead.
  shellRead: { allowed: ['Read', 'Grep', 'Glob'], denied: ['Bash', 'Write', 'Edit'] },
  write: { allowed: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], denied: ['Bash'] },
  shell: { allowed: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'], denied: [] },
};

const GROK_PERMISSIONS = {
  read: { denied: ['search_replace', 'run_terminal_command'], approve: false },
  // shellRead cannot exist on grok either: an approved terminal can write
  // anywhere. Deny the terminal tool as well instead of allowing writes.
  shellRead: { denied: ['search_replace', 'run_terminal_command'], approve: true },
  write: { denied: ['run_terminal_command'], approve: true },
  shell: { denied: [], approve: true },
};

// D4a: OpenCode read-only shell whitelist (write=false + shell=true).
// Bash is granted per command pattern; everything else stays denied.
// edit/write remain denied; `*` first so later specific allows win
// (OpenCode evaluates last matching rule wins).
export const OPENCODE_READONLY_SHELL_BASH = {
  '*': 'deny',
  'git show*': 'allow',
  'git log*': 'allow',
  'git diff*': 'allow',
  'git rev-parse*': 'allow',
  'git status*': 'allow',
  'git cat-file*': 'allow',
  'ls*': 'allow',
  'cat*': 'allow',
  'head*': 'allow',
  'tail*': 'allow',
  'wc*': 'allow',
  'grep*': 'allow',
  'find*': 'allow',
  'rg*': 'allow',
};

function permissionProfile(perms = {}) {
  if (perms.write && perms.shell) return 'shell';
  if (perms.write) return 'write';
  if (perms.shell) return 'shellRead';
  return 'read';
}

function validModel(value) {
  return typeof value === 'string' && MODEL_RE.test(value);
}

function validOpencodeModel(value) {
  return typeof value === 'string' && value.length <= 120 && OPENCODE_MODEL_RE.test(value);
}

function promptFor(job) {
  return [
    `ai-hub worker job ${job.id}.`,
    'Work only inside the assigned workspace. Do not delegate to other agents.',
    job.permissions?.ssh
      ? 'SSH/VPS operations are explicitly allowed for this job.'
      : 'Do not use SSH or operate remote machines. SSH agent credentials are removed from your environment.',
    typeof job.deliveryContract === 'string' ? job.deliveryContract.trim() : '',
    job.prompt,
  ].filter(Boolean).join('\n\n');
}

/**
 * Env overlay removing ambient SSH agent credentials. Applied whenever the
 * job does not grant ssh. `undefined` values mean "delete the variable".
 * Genuinely breaks agent-socket ssh/git transports; on-disk keys remain a
 * documented residual risk (hard containment is the codex sandbox or no shell).
 */
export function sshDeniedEnv() {
  return { SSH_AUTH_SOCK: undefined, SSH_AGENT_PID: undefined };
}

/**
 * G01 Linux worker adaptation: default executable names are platform-aware
 * (.cmd only on Windows). Spawn uses a detached process group on POSIX so a
 * hung runner tree can be cleaned as a group; killRunnerTree kills the group
 * on POSIX and falls back to a direct kill. Windows behavior is unchanged.
 */
export function defaultRunnerCommand(runner, platform = process.platform) {
  if (platform === 'win32') {
    if (runner === 'claude') return 'claude.cmd';
    if (runner === 'codex') return 'codex.cmd';
    if (runner === 'opencode') return 'opencode.cmd';
    return runner;
  }
  return runner;
}

export function spawnOptionsForRunner(platform = process.platform) {
  if (platform === 'win32') return { shell: true, windowsHide: true, detached: false };
  return { shell: false, windowsHide: false, detached: true };
}

export function killRunnerTree(child, platform = process.platform, signal = 'SIGTERM') {
  if (!child || !Number.isInteger(child.pid)) return 'no-pid';
  const sig = signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
  if (platform !== 'win32' && child.pid > 0) {
    try {
      // Negative pid targets the whole process group (POSIX setsid via detached:true).
      process.kill(-child.pid, sig);
      return sig === 'SIGKILL' ? 'group-sigkill' : 'group-sigterm';
    } catch {}
  }
  try { child.kill(sig); } catch {}
  if (platform === 'win32') return sig === 'SIGKILL' ? 'direct-sigkill' : 'direct-sigterm';
  return sig === 'SIGKILL' ? 'direct-sigkill-fallback' : 'direct-sigterm-fallback';
}

export function supportsResume(runner) {
  return runner === 'claude' || runner === 'codex' || runner === 'grok' || runner === 'opencode';
}

export function buildRunnerSpec(job, cfg, runtime = {}) {
  const platform = runtime.platform ?? process.platform;
  const tmpdir = runtime.tmpdir ?? os.tmpdir();
  const perms = job.permissions ?? {};
  const opts = job.options ?? {};
  const profile = permissionProfile(perms);
  const prompt = promptFor(job);
  const sessionId = typeof job.session_id === 'string' && SESSION_RE.test(job.session_id)
    ? job.session_id : null;

  if (job.runner === 'claude') {
    const policy = CLAUDE_PERMISSIONS[profile];
    const args = [
      '-p', '--verbose', '--output-format', 'stream-json',
      '--allowedTools', policy.allowed.join(','),
    ];
    if (policy.denied.length) args.push('--disallowedTools', policy.denied.join(','));
    const model = validModel(opts.model) ? opts.model : cfg.claudeModel;
    if (validModel(model)) args.push('--model', model);
    if (REASONING_EFFORTS.has(opts.reasoning)) {
      args.push('--effort', opts.reasoning);
    }
    if (sessionId) args.push('--resume', sessionId);
    return {
      command: cfg.claudeCommand ?? defaultRunnerCommand('claude', platform),
      args,
      stdin: prompt,
      env: perms.ssh === true ? {} : sshDeniedEnv(),
      cleanup: null,
    };
  }

  if (job.runner === 'grok') {
    const promptFile = path.join(tmpdir, `ai-hub-grok-prompt-${job.id}.txt`);
    fs.writeFileSync(promptFile, prompt, 'utf8');
    const policy = GROK_PERMISSIONS[profile];
    const args = ['--prompt-file', promptFile, '--output-format', 'streaming-json'];
    if (policy.denied.length) args.push('--disallowed-tools', policy.denied.join(','));
    if (policy.approve) args.push('--always-approve');
    if (sessionId) args.push('-r', sessionId);
    const model = validModel(opts.model) ? opts.model : cfg.grokModel;
    if (validModel(model)) args.push('-m', model);
    if (REASONING_EFFORTS.has(opts.reasoning)) args.push('--reasoning-effort', opts.reasoning);
    return {
      command: cfg.grokCommand ?? 'grok',
      args,
      stdin: '',
      env: perms.ssh === true ? {} : sshDeniedEnv(),
      cleanup: () => {
        try { fs.unlinkSync(promptFile); } catch {}
      },
    };
  }

  if (job.runner === 'opencode') {
    const args = ['run', '--format', 'json', '--pure', '--thinking'];
    const model = validOpencodeModel(opts.model)
      ? opts.model
      : (validOpencodeModel(cfg.opencodeModel) ? cfg.opencodeModel : 'opencode-go/muse-spark-1.3-contributor');
    args.push('-m', model);
    if (OPENCODE_VARIANTS.has(opts.reasoning)) args.push('--variant', opts.reasoning);
    if (sessionId) args.push('--session', sessionId);
    // --auto auto-approves file/shell tools: only the full shell profile
    // (write+shell) gets it. shellRead/write/read run under opencode's
    // headless approval default, where approval-gated tools fail closed.
    if (profile === 'shell') args.push('--auto');
    args.push('--dir', job.workspace);
    return {
      command: cfg.opencodeCommand ?? defaultRunnerCommand('opencode', platform),
      args,
      stdin: prompt,
      env: {
        ...(perms.ssh === true ? {} : sshDeniedEnv()),
        // Runtime inline configuration overrides project/user allow rules.
        // A read-only module must remain read-only even in a permissive repo.
        // shellRead (write=false + shell=true) keeps edit/write denied but
        // allows read-only shell commands via OPENCODE_READONLY_SHELL_BASH;
        // pure read (shell=false) keeps bash fully denied.
        ...(!perms.write && perms.shell ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: {
          '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
          bash: { ...OPENCODE_READONLY_SHELL_BASH }, edit: 'deny', task: 'deny', skill: 'deny', external_directory: 'deny',
        } }) } : !perms.write ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: {
          '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
          bash: 'deny', edit: 'deny', task: 'deny', skill: 'deny', external_directory: 'deny',
        } }) } : !perms.shell ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: {
          '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', edit: 'allow',
          bash: 'deny', task: 'deny', skill: 'deny', external_directory: 'deny',
        } }) } : {}),
      },
      cleanup: null,
    };
  }

  if (job.runner !== 'codex') throw new Error(`unsupported runner: ${job.runner}`);
  // codexSandboxMode="danger-full-access"：宿主沙箱在本机不可用时（见 vault
  // windows-codex-linked-worktree-apply-patch-acl），经 User 授权的全信任直通。
  // 写权限仍由 perms.write 决定：只读单照旧压成 read-only，不因直通放开。
  const fullAccess = cfg.codexSandboxMode === 'danger-full-access' && perms.write;
  const sandbox = fullAccess ? 'danger-full-access' : (perms.write ? 'workspace-write' : 'read-only');
  const command = cfg.codexCommand ?? defaultRunnerCommand('codex', platform);
  const model = validModel(opts.model) ? opts.model : cfg.codexModel;
  const modelArgs = validModel(model) ? ['--model', model] : [];
  const reasoningArgs = REASONING_EFFORTS.has(opts.reasoning)
    ? ['--config', `model_reasoning_effort="${opts.reasoning}"`] : [];
  const windowsSandbox = !fullAccess && platform === 'win32'
    && ['elevated', 'unelevated'].includes(cfg.codexWindowsSandbox ?? 'unelevated')
    ? ['--config', `windows.sandbox="${cfg.codexWindowsSandbox ?? 'unelevated'}"`]
    : [];
  // Verified with Codex 0.153.4 thread/start: readOnly + networkAccess:true.
  // --sandbox read-only would override this named profile and turn HTTP off.
  const readonlyNetwork = !perms.write && perms.ssh === true;
  const readonlyNetworkArgs = readonlyNetwork ? [
    '--config', 'default_permissions="hub-deploy-read"',
    '--config', 'permissions.hub-deploy-read.extends=":read-only"',
    '--config', 'permissions.hub-deploy-read.network.enabled=true',
  ] : [];
  // resume 分支必须显式重施本 job 的 sandbox：不带覆盖时 resume 会落回
  // session/全局默认，权限可能相对 fresh 启动漂移（read-only 单被放大，或
  // danger-full-access 单被压回）。`codex exec resume` 不接受 --sandbox 旗标
  // （codex-cli 0.145.0 实测 unexpected argument），等价形式是
  // `--config sandbox_mode="…"`。fresh 与 resume 的有效 sandbox 必须一致。
  const args = sessionId
    ? ['exec', 'resume', '--json', ...windowsSandbox,
      ...(readonlyNetwork ? readonlyNetworkArgs : ['--config', `sandbox_mode="${sandbox}"`]),
      ...modelArgs, ...reasoningArgs, sessionId, '-']
    : ['exec', '--json', ...windowsSandbox,
      ...(readonlyNetwork ? readonlyNetworkArgs : ['--sandbox', sandbox]), '--skip-git-repo-check',
      ...modelArgs, ...reasoningArgs, '-'];
  return {
    command,
    args,
    stdin: prompt,
    env: perms.ssh === true ? {} : sshDeniedEnv(),
    cleanup: null,
  };
}
