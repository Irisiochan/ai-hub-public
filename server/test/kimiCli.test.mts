import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  KIMI_DEFAULT_MODELS,
  KimiCliBackend,
  buildKimiChildEnv,
  interpretKimiStreamLine,
  parseKimiModelsToml,
  resolveKimiCodeHome,
} from '../src/backends/kimiCli.js';

/** Exact stdout lines from VPS ai-hub user after mainland OAuth (kimi 2.0.2). */
const LIVE_STREAM = [
  { role: 'meta', type: 'system.version', version: '2.0.2' },
  { role: 'assistant', content: 'OK' },
  {
    role: 'meta',
    type: 'session.resume_hint',
    session_id: 'session_00d0df90-0db9-4e65-9adb-4830a225363a',
    command: 'kimi -r session_00d0df90-0db9-4e65-9adb-4830a225363a',
    content: 'To resume this session: kimi -r session_00d0df90-0db9-4e65-9adb-4830a225363a',
  },
] as const;

test('interpretKimiStreamLine: live oauth print-mode transcript', () => {
  const actions = LIVE_STREAM.flatMap((line) => interpretKimiStreamLine(line));
  assert.deepEqual(
    actions.filter((a) => a.kind !== 'ignore'),
    [
      { kind: 'delta', text: 'OK' },
      { kind: 'session', sessionId: 'session_00d0df90-0db9-4e65-9adb-4830a225363a' },
    ],
  );
});

test('interpretKimiStreamLine: system.version meta is ignored', () => {
  assert.deepEqual(interpretKimiStreamLine(LIVE_STREAM[0]), [{ kind: 'ignore' }]);
});

test('interpretKimiStreamLine: session id recoverable from resume_hint.command alone', () => {
  const actions = interpretKimiStreamLine({
    role: 'meta',
    type: 'session.resume_hint',
    command: 'kimi -r session_abc',
    content: 'To resume this session: kimi -r session_abc',
  });
  assert.deepEqual(actions, [{ kind: 'session', sessionId: 'session_abc' }]);
});

test('interpretKimiStreamLine: documented tool_calls → tool message pair', () => {
  const start = interpretKimiStreamLine({
    role: 'assistant',
    content: 'Let me check.',
    tool_calls: [
      {
        type: 'function',
        id: 'tc_1',
        function: { name: 'Shell', arguments: '{"command":"ls"}' },
      },
    ],
  });
  assert.deepEqual(start, [
    { kind: 'delta', text: 'Let me check.' },
    { kind: 'tool_use', id: 'tc_1', name: 'Shell', inputSummary: '{"command":"ls"}' },
  ]);

  const result = interpretKimiStreamLine({
    role: 'tool',
    tool_call_id: 'tc_1',
    content: 'file1.py\nfile2.py',
  });
  assert.deepEqual(result, [
    { kind: 'tool_result', id: 'tc_1', name: 'tool', ok: true, summary: 'file1.py\nfile2.py' },
  ]);
});

test('listModels returns static kimi-code defaults without probing CLI', async () => {
  const models = await KimiCliBackend.listModels({
    cliPath: '/nonexistent/kimi',
    cwd: process.cwd(),
    kimiCodeHome: path.join(os.tmpdir(), 'kimi-missing-home-for-tests'),
    log: () => {},
  });
  assert.ok(models.some((m) => m.id === 'kimi-code/kimi-for-coding'));
  assert.equal(models.find((m) => m.id === '')?.isDefault, true);
  assert.deepEqual(
    KIMI_DEFAULT_MODELS.map((m) => m.id),
    ['', 'kimi-code/kimi-for-coding', 'kimi-for-coding'],
  );
});

const SAMPLE_TOML = `
default_model = "kimi-code/kimi-for-coding"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
display_name = "Kimi for Coding"
support_efforts = ["low", "high", "max"]
default_effort = "high"

[models."kimi-for-coding-highspeed"]
provider = "managed:kimi-code"
model = "kimi-for-coding-highspeed"
display_name = "Kimi Highspeed"

[models.k3]
provider = "managed:kimi-code"
model = "k3"
display_name = "K3"
support_efforts = [
  "low",
  "high",
  "max",
]
default_effort = "max"

[models."k3-256k"]
provider = "managed:kimi-code"
model = "k3-256k"
display_name = "K3 256K"

[models."kimi-code/kimi-for-coding".overrides]
max_context_size = 200000

[thinking]
effort = "high"
`;

test('parseKimiModelsToml: extracts id, display_name, support_efforts, default_effort', () => {
  const models = parseKimiModelsToml(SAMPLE_TOML);
  assert.deepEqual(
    models.map((m) => m.id),
    ['kimi-code/kimi-for-coding', 'kimi-for-coding-highspeed', 'k3', 'k3-256k'],
  );
  const coding = models.find((m) => m.id === 'kimi-code/kimi-for-coding')!;
  assert.equal(coding.label, 'Kimi for Coding');
  assert.equal(coding.defaultReasoningEffort, 'high');
  assert.deepEqual(coding.supportedReasoningEfforts, [
    { id: 'low', label: 'low' },
    { id: 'high', label: 'high' },
    { id: 'max', label: 'max' },
  ]);
  const k3 = models.find((m) => m.id === 'k3')!;
  assert.equal(k3.label, 'K3');
  assert.deepEqual(
    k3.supportedReasoningEfforts?.map((e) => e.id),
    ['low', 'high', 'max'],
  );
  assert.equal(models.find((m) => m.id === 'kimi-for-coding-highspeed')?.supportedReasoningEfforts, undefined);
});

test('listModels reads config.toml from kimiCodeHome and falls back without it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-models-'));
  try {
    fs.writeFileSync(path.join(dir, 'config.toml'), SAMPLE_TOML, 'utf8');
    const live = await KimiCliBackend.listModels({
      cliPath: '/nonexistent/kimi',
      cwd: process.cwd(),
      kimiCodeHome: dir,
      log: () => {},
    });
    assert.ok(live.some((m) => m.id === 'k3'));
    assert.ok(live.some((m) => m.id === 'kimi-code/kimi-for-coding'));
    assert.equal(live.find((m) => m.id === '')?.isDefault, true);

    const missing = await KimiCliBackend.listModels({
      cliPath: '/nonexistent/kimi',
      cwd: process.cwd(),
      kimiCodeHome: path.join(dir, 'does-not-exist'),
      log: () => {},
    });
    assert.ok(missing.some((m) => m.id === 'kimi-code/kimi-for-coding'));
    assert.equal(missing.find((m) => m.id === '')?.isDefault, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildKimiChildEnv sets KIMI_MODEL_THINKING_EFFORT only when effort is set', () => {
  const withEffort = buildKimiChildEnv(
    { PATH: '/usr/bin', KIMI_MODEL_THINKING_EFFORT: 'stale', SSH_AUTH_SOCK: '/tmp/sock' },
    { effort: 'max', sshAllowed: false },
  );
  assert.equal(withEffort.KIMI_MODEL_THINKING_EFFORT, 'max');
  assert.equal(withEffort.SSH_AUTH_SOCK, undefined);

  const cleared = buildKimiChildEnv(
    { PATH: '/usr/bin', KIMI_MODEL_THINKING_EFFORT: 'stale' },
    { effort: '' },
  );
  assert.equal(cleared.KIMI_MODEL_THINKING_EFFORT, undefined);

  assert.ok(resolveKimiCodeHome({ kimiCodeHome: '/var/lib/ai-hub/home/.kimi-code' }).endsWith('.kimi-code'));
});
