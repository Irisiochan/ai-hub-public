import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SESSION_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MODEL_RE = /^[a-zA-Z0-9._-]{1,100}$/;
const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const CLAUDE_PERMISSIONS = {
  read: { allowed: ['Read', 'Grep', 'Glob'], denied: ['Bash'] },
  shellRead: { allowed: ['Read', 'Grep', 'Glob', 'Bash'], denied: ['Write', 'Edit'] },
  write: { allowed: ['Read', 'Grep', 'Glob', 'Write', 'Edit'], denied: ['Bash'] },
  shell: { allowed: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'], denied: [] },
};

const GROK_PERMISSIONS = {
  read: { denied: ['search_replace', 'run_terminal_command'], approve: false },
  shellRead: { denied: ['search_replace'], approve: true },
  write: { denied: ['run_terminal_command'], approve: true },
  shell: { denied: [], approve: true },
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

function promptFor(job) {
  return [
    `ai-hub worker job ${job.id}.`,
    'Work only inside the assigned workspace. Do not delegate to other agents.',
    job.permissions?.ssh
      ? 'SSH/VPS operations are explicitly allowed for this job.'
      : 'Do not use SSH or operate remote machines.',
    typeof job.deliveryContract === 'string' ? job.deliveryContract.trim() : '',
    job.prompt,
  ].filter(Boolean).join('\n\n');
}

export function supportsResume(runner) {
  return runner === 'claude' || runner === 'codex' || runner === 'grok';
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
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(opts.reasoning)) {
      args.push('--effort', opts.reasoning);
    }
    if (sessionId) args.push('--resume', sessionId);
    return {
      command: cfg.claudeCommand ?? (platform === 'win32' ? 'claude.cmd' : 'claude'),
      args,
      stdin: prompt,
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
    if (validModel(cfg.grokModel)) args.push('-m', cfg.grokModel);
    return {
      command: cfg.grokCommand ?? 'grok',
      args,
      stdin: '',
      cleanup: () => {
        try { fs.unlinkSync(promptFile); } catch {}
      },
    };
  }

  if (job.runner !== 'codex') throw new Error(`unsupported runner: ${job.runner}`);
  // codexSandboxMode="danger-full-access"：宿主沙箱在本机不可用时（见 vault
  // windows-codex-linked-worktree-apply-patch-acl），经 User 授权的全信任直通。
  // 写权限仍由 perms.write 决定：只读单照旧压成 read-only，不因直通放开。
  const fullAccess = cfg.codexSandboxMode === 'danger-full-access' && perms.write;
  const sandbox = fullAccess ? 'danger-full-access' : (perms.write ? 'workspace-write' : 'read-only');
  const command = cfg.codexCommand ?? (platform === 'win32' ? 'codex.cmd' : 'codex');
  const model = validModel(opts.model) ? opts.model : cfg.codexModel;
  const modelArgs = validModel(model) ? ['--model', model] : [];
  const reasoningArgs = CODEX_REASONING_EFFORTS.has(opts.reasoning)
    ? ['--config', `model_reasoning_effort="${opts.reasoning}"`] : [];
  const windowsSandbox = !fullAccess && platform === 'win32'
    && ['elevated', 'unelevated'].includes(cfg.codexWindowsSandbox ?? 'unelevated')
    ? ['--config', `windows.sandbox="${cfg.codexWindowsSandbox ?? 'unelevated'}"`]
    : [];
  const args = sessionId
    ? ['exec', 'resume', '--json', ...windowsSandbox, ...modelArgs, ...reasoningArgs, sessionId, '-']
    : ['exec', '--json', ...windowsSandbox, '--sandbox', sandbox, '--skip-git-repo-check',
      ...modelArgs, ...reasoningArgs, '-'];
  return { command, args, stdin: prompt, cleanup: null };
}
