import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareGrokRuntimeHome } from '../src/backends/grokRuntimeHome.js';
import { GrokCliBackend } from '../src/backends/grokCli.js';

test('room Grok uses explicit MCP home, preserves login/resume, isolates and refreshes turn bearers', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-room-home-'));
  const previous = { home: process.env.GROK_HOME, auth: process.env.GROK_AUTH_PATH };
  try {
    const shared = path.join(temp, 'shared');
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'config.toml'), '# unchanged user config');
    process.env.GROK_HOME = shared;
    process.env.GROK_AUTH_PATH = path.join(shared, 'original-auth.json');
    const make = (name: string, bearer: string) => prepareGrokRuntimeHome({
      cwd: path.join(temp, name),
      servers: { hub: { url: 'http://127.0.0.1:3900/api/hub-mcp/aye', headers: { Authorization: bearer } } },
    });
    const project = path.join(temp, 'room-a', '.grok', 'config.toml');
    fs.mkdirSync(path.dirname(project), { recursive: true });
    fs.writeFileSync(project, '# keep me\n# >>> AI Hub managed MCP: hub\n[mcp_servers.hub]\nurl = "http://old"\n# <<< AI Hub managed MCP: hub\n');
    const first = make('room-a', 'Bearer turn-a');
    assert.equal(fs.readFileSync(project, 'utf8'), '# keep me\n');
    const second = make('room-b', 'Bearer turn-b');
    assert.notEqual(first.home, second.home);
    assert.equal(first.authPath, process.env.GROK_AUTH_PATH);
    assert.equal(fs.realpathSync(path.join(first.home, 'sessions')), fs.realpathSync(path.join(shared, 'sessions')));
    fs.writeFileSync(path.join(shared, 'sessions', 'existing-session'), 'resume');
    assert.equal(fs.readFileSync(path.join(first.home, 'sessions', 'existing-session'), 'utf8'), 'resume');
    make('room-a', 'Bearer turn-a-new');
    assert.match(fs.readFileSync(path.join(first.home, 'config.toml'), 'utf8'), /Bearer turn-a-new/);
    assert.match(fs.readFileSync(path.join(second.home, 'config.toml'), 'utf8'), /Bearer turn-b/);
    assert.equal(fs.readFileSync(path.join(shared, 'config.toml'), 'utf8'), '# unchanged user config');
    assert.equal(fs.existsSync(path.join(shared, 'trusted_folders.toml')), false);
    const conflict = path.join(temp, 'conflict', '.grok', 'config.toml');
    fs.mkdirSync(path.dirname(conflict), { recursive: true });
    const ownedByUser = '[mcp_servers.hub]\nurl="http://unmanaged"\n';
    fs.writeFileSync(conflict, ownedByUser);
    assert.throws(() => make('conflict', 'Bearer reject'), /unmanaged hub MCP/);
    assert.equal(fs.readFileSync(conflict, 'utf8'), ownedByUser);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(first.home, 'config.toml')).mode & 0o777, 0o600);
    const mock = path.join(temp, 'cli.mjs');
    fs.writeFileSync(mock, `console.log(JSON.stringify({type:'text',data:JSON.stringify({home:process.env.GROK_HOME,auth:process.env.GROK_AUTH_PATH,compat:process.env.GROK_CLAUDE_MCPS_ENABLED,args:process.argv.slice(2)})})); console.log(JSON.stringify({type:'end',stopReason:'end_turn'}));`);
    const backend = new GrokCliBackend({ cliPath: mock, cwd: temp, runtimeHome: first, log: () => {} });
    const session = '00000000-0000-4000-8000-000000000001';
    await backend.start(session);
    try {
      const events = [];
      for await (const event of backend.sendTurn({ text: 'probe' }).events) events.push(event);
      const done = events.find(e => e.type === 'done');
      assert.ok(done?.type === 'done');
      const child = JSON.parse(done.finalText);
      assert.equal(child.home, first.home);
      assert.equal(child.auth, first.authPath);
      assert.equal(child.compat, 'false');
      assert.ok(child.args.includes('-r') && child.args.includes(session));
      assert.ok(!child.args.some((a: string) => a.includes('Bearer')));
    } finally { await backend.stop(); }
  } finally {
    for (const [key, value] of [['GROK_HOME', previous.home], ['GROK_AUTH_PATH', previous.auth]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
