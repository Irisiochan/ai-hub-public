/** Native Grok discovery/HTTP regression. No model call or production token. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareGrokRuntimeHome } from '../src/backends/grokRuntimeHome.js';

const cli = process.env.GROK_SMOKE_CLI;
assert.ok(cli, 'Set GROK_SMOKE_CLI to the real Grok executable');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-grok-native-'));
const oldHome = process.env.GROK_HOME;
const calls: string[] = [];
let bearer = 'Bearer smoke-fixture-not-a-credential';
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    if (req.headers.authorization !== bearer) { res.writeHead(401).end(); return; }
    const body = JSON.parse(raw);
    calls.push(body.method);
    if (body.id === undefined) { res.writeHead(202).end(); return; }
    const result = body.method === 'initialize'
      ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'hub-fixture', version: '1' } }
      : body.method === 'tools/call'
        ? { content: [{ type: 'text', text: 'fixture task readable' }] }
        : { tools: [{ name: 'task_get', description: 'Read-only test tool', inputSchema: { type: 'object', properties: {} } }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
});
try {
  process.env.GROK_HOME = path.join(temp, 'shared');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const cwd = path.join(temp, 'untrusted-room');
  fs.mkdirSync(path.join(cwd, '.grok'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.grok', 'config.toml'), '# >>> AI Hub managed MCP: hub\n[mcp_servers.hub]\nurl = "http://127.0.0.1:1/never"\nenabled = true\n# <<< AI Hub managed MCP: hub\n[mcp_servers.untrusted_decoy]\nurl = "http://127.0.0.1:1/never"\nenabled = true\n');
  const runtime = prepareGrokRuntimeHome({ cwd, servers: { hub: {
    url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: bearer },
  } } });
  const env = { ...process.env, GROK_HOME: runtime.home, GROK_AUTH_PATH: runtime.authPath, GROK_FOLDER_TRUST: '1',
    GROK_CLAUDE_MCPS_ENABLED: 'false', GROK_CURSOR_MCPS_ENABLED: 'false', GROK_CODEX_MCPS_ENABLED: 'false' };
  const run = promisify(execFile);
  const { stdout } = await run(cli, ['--cwd', cwd, 'inspect', '--json'], { env, timeout: 30_000, windowsHide: true });
  const inspected = JSON.parse(stdout);
  assert.equal(inspected.projectTrusted, false);
  const hub = inspected.mcpServers.find((s: any) => s.name === 'hub');
  assert.ok(hub, 'untrusted room must still discover the explicitly configured Hub server');
  assert.equal(path.resolve(hub.source.path), path.resolve(runtime.home, 'config.toml'));
  await run(cli, ['--cwd', cwd, 'mcp', 'doctor', 'hub', '--json'], { env, timeout: 45_000, windowsHide: true });
  assert.ok(calls.includes('initialize') && calls.includes('tools/list'), 'native Grok must send authenticated initialize AND tools/list');
  console.log('PASS native Grok: untrusted room discovers runtime Hub; initialize and tools/list carry the exact bearer');
  if (process.env.GROK_SMOKE_MODEL_PROBE === '1') {
    // Explicit opt-in: two tiny model turns, fixture tool only; authenticates via
    // GROK_AUTH_PATH while the generated home contains no login copy.
    assert.ok(process.env.GROK_AUTH_PATH, 'Set GROK_AUTH_PATH for the opt-in native model/resume probe');
    const session = crypto.randomUUID();
    const flags = ['--always-approve', '--no-subagents', '--disable-web-search', '--max-turns', '5'];
    const prompt = 'Call the hub MCP task_get tool exactly once with {}. It is a harmless test fixture. Then reply OK. Do not use any other tools except tool discovery.';
    for (const flag of ['-s', '-r']) {
      const before = calls.filter(method => method === 'tools/call').length;
      await run(cli, [flag, session, '-p', prompt, ...flags], { cwd, env, timeout: 120_000, windowsHide: true });
      assert.ok(calls.filter(method => method === 'tools/call').length > before, `${flag} must actually invoke the authenticated fixture tool`);
      bearer = 'Bearer smoke-next-turn-not-a-credential';
      prepareGrokRuntimeHome({ cwd, servers: { hub: { url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: bearer } } } });
    }
    assert.equal(fs.existsSync(path.join(runtime.home, 'auth.json')), false, 'login must remain at the original auth path');
    console.log('PASS native Grok create + resume: original auth path works; both turns invoke task_get with their own refreshed bearer');
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (oldHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = oldHome;
  fs.rmSync(temp, { recursive: true, force: true });
}
