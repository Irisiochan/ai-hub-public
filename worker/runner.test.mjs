import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRunnerSpec, supportsResume } from './runner.mjs';

const baseJob = {
  id: 'job-1',
  workspace: 'C:/workspace',
  prompt: 'do the work',
  deliveryContract: 'SERVER DELIVERY CONTRACT',
  permissions: { write: false, shell: false, ssh: false },
  options: {},
};

test('server delivery contract is passed through to runner prompt', () => {
  const spec = buildRunnerSpec({ ...baseJob, runner: 'claude' }, {}, { platform: 'win32' });
  assert.match(spec.stdin, /SERVER DELIVERY CONTRACT/);
  assert.match(spec.stdin, /do the work/);
  assert.match(spec.stdin, /Do not use SSH or operate remote machines/);

  const ssh = buildRunnerSpec({
    ...baseJob,
    runner: 'claude',
    permissions: { write: true, shell: true, ssh: true },
  }, {}, { platform: 'win32' });
  assert.match(ssh.stdin, /SSH\/VPS operations are explicitly allowed/);
});

test('claude permission table separates read, write and shell profiles', () => {
  const read = buildRunnerSpec({ ...baseJob, runner: 'claude' }, {}, { platform: 'win32' });
  assert.equal(read.args[read.args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob');
  assert.equal(read.args[read.args.indexOf('--disallowedTools') + 1], 'Bash');

  const shellRead = buildRunnerSpec({
    ...baseJob,
    runner: 'claude',
    permissions: { write: false, shell: true },
  }, {}, { platform: 'win32' });
  assert.equal(shellRead.args[shellRead.args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob,Bash');
  assert.equal(shellRead.args[shellRead.args.indexOf('--disallowedTools') + 1], 'Write,Edit');

  const write = buildRunnerSpec({
    ...baseJob,
    runner: 'claude',
    permissions: { write: true, shell: false },
  }, {}, { platform: 'win32' });
  assert.equal(write.args[write.args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob,Write,Edit');
  assert.equal(write.args[write.args.indexOf('--disallowedTools') + 1], 'Bash');

  const shell = buildRunnerSpec({
    ...baseJob,
    runner: 'claude',
    permissions: { write: true, shell: true },
  }, {}, { platform: 'win32' });
  assert.equal(shell.args[shell.args.indexOf('--allowedTools') + 1], 'Read,Grep,Glob,Write,Edit,Bash');
  assert.equal(shell.args.includes('--disallowedTools'), false);
});

test('grok permission table and resume arguments are deterministic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-runner-test-'));
  try {
    const spec = buildRunnerSpec({
      ...baseJob,
      runner: 'grok',
      session_id: 'session_123',
      permissions: { write: true, shell: false },
    }, { grokModel: 'grok-code' }, { tmpdir: dir, platform: 'win32' });
    assert.equal(spec.args[spec.args.indexOf('--disallowed-tools') + 1], 'run_terminal_command');
    assert.equal(spec.args.includes('--always-approve'), true);
    assert.deepEqual(spec.args.slice(spec.args.indexOf('-r'), spec.args.indexOf('-r') + 2), ['-r', 'session_123']);
    assert.deepEqual(spec.args.slice(spec.args.indexOf('-m'), spec.args.indexOf('-m') + 2), ['-m', 'grok-code']);
    assert.match(fs.readFileSync(spec.args[1], 'utf8'), /SERVER DELIVERY CONTRACT/);
    spec.cleanup();
    assert.equal(fs.existsSync(spec.args[1]), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('grok task model and reasoning override worker fallback config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-runner-test-'));
  try {
    const spec = buildRunnerSpec({
      ...baseJob,
      runner: 'grok',
      options: { model: 'grok-4.6', reasoning: 'high' },
    }, { grokModel: 'grok-code' }, { tmpdir: dir, platform: 'win32' });
    assert.deepEqual(spec.args.slice(spec.args.indexOf('-m'), spec.args.indexOf('-m') + 2), ['-m', 'grok-4.6']);
    assert.deepEqual(
      spec.args.slice(spec.args.indexOf('--reasoning-effort'), spec.args.indexOf('--reasoning-effort') + 2),
      ['--reasoning-effort', 'high']
    );
    spec.cleanup();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('codex resume and fresh execution keep their distinct CLI forms', () => {
  const fresh = buildRunnerSpec({
    ...baseJob,
    runner: 'codex',
    permissions: { write: true, shell: true },
  }, {}, { platform: 'win32' });
  assert.deepEqual(fresh.args.slice(0, 2), ['exec', '--json']);
  assert.equal(fresh.args.includes('--sandbox'), true);

  const resumed = buildRunnerSpec({
    ...baseJob,
    runner: 'codex',
    session_id: 'thread-123',
    permissions: { write: true, shell: true },
  }, {}, { platform: 'win32' });
  assert.deepEqual(resumed.args.slice(0, 3), ['exec', 'resume', '--json']);
  assert.equal(resumed.args.includes('thread-123'), true);
});

test('codex danger-full-access passthrough drops windows sandbox but honors read-only jobs', () => {
  const full = buildRunnerSpec({
    ...baseJob,
    runner: 'codex',
    permissions: { write: true, shell: true },
  }, { codexSandboxMode: 'danger-full-access' }, { platform: 'win32' });
  const sandboxIndex = full.args.indexOf('--sandbox');
  assert.equal(full.args[sandboxIndex + 1], 'danger-full-access');
  assert.equal(full.args.some((arg) => arg.startsWith('windows.sandbox=')), false);

  const readOnly = buildRunnerSpec({
    ...baseJob,
    runner: 'codex',
    permissions: { write: false, shell: true },
  }, { codexSandboxMode: 'danger-full-access' }, { platform: 'win32' });
  const roIndex = readOnly.args.indexOf('--sandbox');
  assert.equal(readOnly.args[roIndex + 1], 'read-only', '只读单不得因直通配置获得写权限');

  const defaultCfg = buildRunnerSpec({
    ...baseJob,
    runner: 'codex',
    permissions: { write: true, shell: true },
  }, {}, { platform: 'win32' });
  const defIndex = defaultCfg.args.indexOf('--sandbox');
  assert.equal(defaultCfg.args[defIndex + 1], 'workspace-write', '未配置直通时行为不变');
});

test('codex reasoning effort uses the supported config override for fresh and resumed runs', () => {
  const fresh = buildRunnerSpec({
    ...baseJob,
    runner: 'codex',
    options: { reasoning: 'high' },
  }, {}, { platform: 'win32' });
  assert.equal(fresh.args.includes('--reasoning-effort'), false);
  const effortIndex = fresh.args.indexOf('model_reasoning_effort="high"');
  assert.notEqual(effortIndex, -1);
  assert.equal(fresh.args[effortIndex - 1], '--config');

  const resumed = buildRunnerSpec({
    ...baseJob,
    runner: 'codex',
    session_id: 'thread-123',
    options: { reasoning: 'max' },
  }, {}, { platform: 'win32' });
  assert.equal(resumed.args.includes('--reasoning-effort'), false);
  assert.equal(resumed.args.includes('model_reasoning_effort="max"'), true);
});

test('codex resume re-applies the exact job sandbox in all three modes', () => {
  const effectiveSandbox = (spec) => {
    const flagIndex = spec.args.indexOf('--sandbox');
    if (flagIndex !== -1) return spec.args[flagIndex + 1];
    const override = spec.args.find((arg) => arg.startsWith('sandbox_mode='));
    return override ? JSON.parse(override.slice('sandbox_mode='.length)) : null;
  };
  const cases = [
    { permissions: { write: false, shell: true }, cfg: {}, expected: 'read-only' },
    { permissions: { write: true, shell: true }, cfg: {}, expected: 'workspace-write' },
    {
      permissions: { write: true, shell: true },
      cfg: { codexSandboxMode: 'danger-full-access' },
      expected: 'danger-full-access',
    },
  ];
  for (const { permissions, cfg, expected } of cases) {
    const fresh = buildRunnerSpec({ ...baseJob, runner: 'codex', permissions }, cfg, { platform: 'win32' });
    const resumed = buildRunnerSpec(
      { ...baseJob, runner: 'codex', session_id: 'thread-9', permissions },
      cfg,
      { platform: 'win32' },
    );
    assert.equal(effectiveSandbox(fresh), expected);
    assert.equal(effectiveSandbox(resumed), expected, `resume 后有效 sandbox 必须与 fresh 一致（${expected}）`);
    // codex-cli 0.145 实测：exec resume 不接受 --sandbox 旗标，只认 -c sandbox_mode
    assert.equal(resumed.args.includes('--sandbox'), false);
    const overrideIndex = resumed.args.indexOf(`sandbox_mode="${expected}"`);
    assert.notEqual(overrideIndex, -1);
    assert.equal(resumed.args[overrideIndex - 1], '--config');
  }
});

test('job payload alone cannot escalate the codex sandbox', () => {
  const hostileJob = {
    ...baseJob,
    runner: 'codex',
    permissions: { write: true, shell: true },
    // 任务 payload 里塞进各种“像配置”的字段：sandbox 只能由 worker 侧配置授予
    options: { sandbox: 'danger-full-access', codexSandboxMode: 'danger-full-access' },
    codexSandboxMode: 'danger-full-access',
    sandbox: 'danger-full-access',
  };
  const fresh = buildRunnerSpec(hostileJob, {}, { platform: 'win32' });
  assert.equal(
    fresh.args[fresh.args.indexOf('--sandbox') + 1],
    'workspace-write',
    'danger-full-access 只能来自 worker 配置，任务 payload 不得升权',
  );
  const resumed = buildRunnerSpec({ ...hostileJob, session_id: 'thread-9' }, {}, { platform: 'win32' });
  assert.equal(resumed.args.includes('sandbox_mode="danger-full-access"'), false);
  assert.equal(resumed.args.includes('sandbox_mode="workspace-write"'), true);
});

test('all configured runners advertise one-shot resume support', () => {
  assert.equal(supportsResume('claude'), true);
  assert.equal(supportsResume('codex'), true);
  assert.equal(supportsResume('grok'), true);
  assert.equal(supportsResume('other'), false);
});
