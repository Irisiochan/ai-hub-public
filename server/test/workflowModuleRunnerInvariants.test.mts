// Independent checks of actual CLI capabilities emitted for module jobs. No model calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRunnerSpec } from '../../worker/runner/runner.mjs';

function job(runner: string, permissions = { write: false, shell: true, ssh: false }) {
  return { id: 'module-capability-check', runner, workspace: process.cwd(), prompt: 'Only inspect approved files.',
    permissions, options: { model: runner === 'codex' ? 'gpt-6-astra' : runner === 'opencode' ? 'opencode-go/muse-spark-1.3-contributor' : 'grok-4.6',
      reasoning: 'high', workflowModule: { moduleId: permissions.ssh ? 'deploy' : 'review', bindingRevision: 1, permissions } } };
}

test('Grok module review cannot write through terminal even when the module permits read-only shell', () => {
  const spec = buildRunnerSpec(job('grok'), {}, { platform: 'linux' });
  try {
    const denied = spec.args[spec.args.indexOf('--disallowed-tools') + 1] ?? '';
    assert.ok(denied.split(',').includes('search_replace'));
    assert.ok(denied.split(',').includes('run_terminal_command'), 'blocking Edit alone leaves a writable shell escape');
  } finally { spec.cleanup?.(); }
});

test('Claude module review denies Bash as well as file editing', () => {
  const spec = buildRunnerSpec(job('claude'), {}, { platform: 'linux' });
  const denied = spec.args[spec.args.indexOf('--disallowedTools') + 1] ?? '';
  for (const tool of ['Bash', 'Write', 'Edit']) assert.ok(denied.split(',').includes(tool), `${tool} must be denied`);
});

test('OpenCode review overrides permissive project tool rules explicitly', () => {
  const spec = buildRunnerSpec(job('opencode'), {}, { platform: 'linux' });
  assert.equal(spec.args.includes('--auto'), false);
  const permission = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT).permission;
  assert.equal(permission.read, 'allow');
  for (const key of ['*', 'edit', 'task', 'external_directory']) assert.equal(permission[key], 'deny');
  // D4a: shellRead keeps a read-only bash whitelist instead of a blanket deny.
  assert.equal(typeof permission.bash, 'object');
  assert.equal(permission.bash['*'], 'deny');
  for (const pattern of ['git show*', 'git log*', 'git diff*', 'git rev-parse*', 'git status*', 'git cat-file*',
    'ls*', 'cat*', 'head*', 'tail*', 'wc*', 'grep*', 'find*', 'rg*']) {
    assert.equal(permission.bash[pattern], 'allow', `${pattern} must be allowed`);
  }
});

test('OpenCode pure read without shell keeps bash fully denied', () => {
  const spec = buildRunnerSpec(job('opencode', { write: false, shell: false, ssh: false }), {}, { platform: 'linux' });
  const permission = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT).permission;
  assert.equal(permission.bash, 'deny');
  assert.equal(permission.edit, 'deny');
});

test('Codex deploy keeps files read-only while enabling the required HTTP network path', () => {
  const input = job('codex', { write: false, shell: true, ssh: true });
  for (const session_id of [null, 'resume-deploy']) {
    const spec = buildRunnerSpec({ ...input, session_id }, { codexSandboxMode: 'danger-full-access' }, { platform: 'linux' });
    const encoded = spec.args.join(' ');
    assert.doesNotMatch(encoded, /danger-full-access|workspace-write/);
    // Named per-invocation profile was verified against the installed CLI's
    // thread/start response: readOnly + networkAccess:true. Global config stays untouched.
    assert.match(encoded, /extends=":read-only"/);
    assert.match(encoded, /network\.enabled=true/);
    assert.match(encoded, /default_permissions=/);
  }
});
