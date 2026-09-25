import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCapabilityCard,
  defaultRunnerProbeCommand,
  probeConfigVisible,
  probeRunner,
  probeWorkspaceWritable,
  refreshCapabilityCard,
  resolveCapabilityProbeIntervalMs,
  resolveNpmCacheDir,
  versionProbeSpawnSpec,
} from './capability-card.mjs';

test('heartbeat card carries exactly the four fields (runners/workspaceWritable/npmCacheWritable/configVisible)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-card-'));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cache-'));
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, '{}\n');
  const card = await refreshCapabilityCard(
    { runners: ['codex', 'opencode'] },
    {
      configPath: configFile,
      workspaceRoots: [root],
      npmCacheDir: cache,
      // Pin POSIX command names; win32 .cmd defaults are covered separately.
      platform: 'linux',
      execVersion: (command) => {
        if (command === 'codex') return;
        throw new Error(`${command} --version failed: not found`);
      },
      // No VPS-side file on this host: absence must not fail the card.
      exists: () => false,
    },
  );
  assert.deepEqual(Object.keys(card).sort(), ['configVisible', 'npmCacheWritable', 'runners', 'workspaceWritable']);
  assert.equal(card.runners.codex.ok, true);
  assert.ok(typeof card.runners.codex.checkedAt === 'string');
  assert.ok(!('error' in card.runners.codex), 'ok entries carry no error');
  assert.equal(card.runners.opencode.ok, false);
  assert.match(card.runners.opencode.error ?? '', /not found/);
  assert.equal(card.workspaceWritable, true);
  assert.equal(card.npmCacheWritable, true);
  assert.equal(card.configVisible, true);
});

test('probe interval defaults to 60 minutes and is configurable as capabilityProbeIntervalMinutes', () => {
  assert.equal(resolveCapabilityProbeIntervalMs({}, {}), 60 * 60_000);
  assert.equal(resolveCapabilityProbeIntervalMs({ capabilityProbeIntervalMinutes: 30 }, {}), 30 * 60_000);
  assert.equal(resolveCapabilityProbeIntervalMs({}, { AI_HUB_CAPABILITY_PROBE_MINUTES: '15' }), 15 * 60_000);
  // Clamped, never zero/negative (a dead timer would silently stop re-probing).
  assert.equal(resolveCapabilityProbeIntervalMs({ capabilityProbeIntervalMinutes: 0 }, {}), 1 * 60_000);
  assert.equal(resolveCapabilityProbeIntervalMs({ capabilityProbeIntervalMinutes: 99999 }, {}), 24 * 60 * 60_000);
});

test('runner probe records ok=false with bounded error instead of throwing', () => {
  const entry = probeRunner('codex', {
    command: 'codex',
    execVersion: () => { throw new Error('x'.repeat(5000)); },
  });
  assert.equal(entry.ok, false);
  assert.ok((entry.error ?? '').length <= 300);
  assert.ok(typeof entry.checkedAt === 'string');
});

test('workspace probe fails closed on read-only roots and empty config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-ws-'));
  assert.equal(probeWorkspaceWritable([root]), true);
  assert.equal(probeWorkspaceWritable([]), false);
  assert.equal(
    probeWorkspaceWritable([root], { writeFile: () => { throw new Error('EROFS'); } }),
    false,
  );
  assert.equal(
    probeWorkspaceWritable([path.join(root, 'no-such-dir')], {}),
    false,
  );
});

test('config probe: own config must read; VPS-side file is required only when present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-cfg-'));
  const own = path.join(root, 'config.json');
  fs.writeFileSync(own, '{}\n');
  const vps = path.join(root, 'vps-config.json');
  // PC host: no VPS-side file → own readability decides.
  assert.equal(probeConfigVisible(own, { vpsConfigPath: vps, exists: () => false }), true);
  // Missing own config → false even when the VPS side is fine.
  assert.equal(
    probeConfigVisible(path.join(root, 'missing.json'), { vpsConfigPath: vps, exists: () => false }),
    false,
  );
  // VPS host: side file present but unreadable → false.
  fs.writeFileSync(vps, '{}\n');
  assert.equal(
    probeConfigVisible(own, {
      vpsConfigPath: vps,
      readFile: (file) => {
        if (String(file) === vps) throw new Error('EACCES');
        return fs.readFileSync(file, 'utf8');
      },
    }),
    false,
  );
});

test('buildCapabilityCard normalizes entries and never throws on junk', () => {
  const card = buildCapabilityCard({
    runners: { codex: { ok: true, checkedAt: '2026-09-23T00:00:00.000Z' }, broken: null },
    workspaceWritable: 1,
    npmCacheWritable: 'yes',
    configVisible: true,
  });
  assert.equal(card.runners.codex.ok, true);
  assert.equal(card.runners.broken.ok, false);
  assert.equal(card.workspaceWritable, false);
  assert.equal(card.npmCacheWritable, false);
  assert.equal(card.configVisible, true);
  assert.deepEqual(buildCapabilityCard({}), {
    runners: {},
    workspaceWritable: false,
    npmCacheWritable: false,
    configVisible: false,
  });
});

test('runner probe command honors config overrides and platform defaults', () => {
  assert.equal(defaultRunnerProbeCommand('codex', { codexCommand: '/opt/codex/bin/codex' }, 'linux'), '/opt/codex/bin/codex');
  assert.equal(defaultRunnerProbeCommand('codex', {}, 'linux'), 'codex');
  assert.equal(defaultRunnerProbeCommand('codex', {}, 'win32'), 'codex.cmd');
  assert.equal(defaultRunnerProbeCommand('opencode', {}, 'win32'), 'opencode.cmd');
});

test('version probe runs win32 .cmd shims through cmd, everything else directly', () => {
  assert.deepEqual(versionProbeSpawnSpec('codex', 'linux'), { file: 'codex', args: ['--version'], options: {} });
  assert.deepEqual(versionProbeSpawnSpec('codex.exe', 'win32'), { file: 'codex.exe', args: ['--version'], options: {} });
  const spec = versionProbeSpawnSpec('codex.cmd', 'win32');
  assert.match(spec.file, /cmd(\.exe)?$/i);
  assert.deepEqual(spec.args, ['/d', '/s', '/c', '""codex.cmd" --version"']);
  assert.equal(spec.options.windowsVerbatimArguments, true);
});

test('npm cache dir honors npm_config_cache', () => {
  assert.equal(resolveNpmCacheDir({ npm_config_cache: '/tmp/custom-npm-cache' }, '/home/u'), '/tmp/custom-npm-cache');
  assert.equal(resolveNpmCacheDir({}, '/home/u'), path.join('/home/u', '.npm'));
});

test('worker heartbeat capabilities include capabilityCard beside releaseSha (static pin)', () => {
  // worker.mjs has module-level side effects (config load + boot), so the
  // heartbeat payload shape is pinned statically instead of importing it.
  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker.mjs');
  const source = fs.readFileSync(workerPath, 'utf8');
  assert.match(source, /capabilityCard,/);
  assert.match(source, /refreshCapabilityCard/);
  assert.match(source, /capabilityProbeIntervalMinutes/);
});
