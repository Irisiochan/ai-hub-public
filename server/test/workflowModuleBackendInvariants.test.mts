import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/platform/db.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { BackendFactory } from '../src/runtime/backendFactory.js';
import { verifyInvocationScope, moduleBindingHash } from '../src/workflow/moduleAuthority.js';

test('module backend capabilities follow its invocation, isolate MCP files and preserve private contact settings', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-module-backends-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const jobs = new JobStore(db, { broadcast() {} } as any);
  const previousToken = process.env.HUB_TOKEN; process.env.HUB_TOKEN = 'module-backend-test-secret';
  // Grok's session store defaults to ~/.grok; the vps-dev Worker unit mounts
  // HOME read-only, so the merge gate's pretest failed there. Keep it in dir.
  const previousGrokHome = process.env.GROK_HOME; process.env.GROK_HOME = path.join(dir, 'grok-home');
  const privateCfg = { allowedTools: ['Read', 'Bash', 'Write', 'Edit'], delegation: { enabled: false }, heartbeat: { enabled: false }, projectAccess: { enabled: true, workspace: dir, allowShell: true } };
  const config = { dbPath: path.join(dir, 'hub.db'), agentsDir: path.join(dir, 'read-only-deployment-tree'),
    host: '127.0.0.1', port: 3900, memory: {}, claude: {}, codex: {}, opencode: {}, grok: {} };
  const prompts = { composeStart: async () => ({ preamble: 'Approved module task', memoryPreamble: '' }),
    withDelegation: (text: string) => text, staticTokens: () => 0 };
  const factory = new BackendFactory({ db, jobStore: jobs, config, vault: null, prompts } as any);
  try {
    for (const backend of ['codex', 'opencode-cli', 'grok-cli', 'claude-cli']) {
      const agent = { id: 'reserve', kind: 'dm', backend, config: JSON.stringify(privateCfg) };
      const invocation = { moduleId: 'plan', revision: 7, permissions: { write: false, shell: true, ssh: false },
        binding: { contactId: 'reserve', runner: backend.replace('-cli', ''), model: 'test-model', reasoning: 'high' } };
      const context = { agent, convo: { id: 'room-one', kind: 'room' }, isRoom: true, memberId: `reserve::plan::${backend}`,
        memory: { injectOnSpawn: false }, moduleInvocation: invocation, log() {}, nameOf: (id: string) => id };
      const first: any = await factory.build(context as any);
      assert.equal(first.opts.sshAllowed, false);
      assert.ok(first.opts.cwd.startsWith(path.join(dir, 'agents', 'workflow')));
      assert.equal(agent.config, JSON.stringify(privateCfg), 'private persona settings are not mutated');
      if (backend === 'claude-cli') {
        for (const tool of ['Write', 'Edit', 'Bash']) assert.ok(first.opts.disallowedTools.includes(tool), `${tool} must not leak from the private config`);
      }
      if (backend === 'codex') {
        assert.equal(first.opts.sandbox, 'read-only');
        const hub = first.opts.mcpServers.find((server: any) => server.name === 'hub');
        assert.ok(hub, 'newly bound reserve receives module delegation tools');
        const scope = verifyInvocationScope(process.env.HUB_TOKEN, hub.httpHeaders.Authorization)!;
        assert.equal(scope.roomId, 'room-one'); assert.deepEqual(scope.invocation, invocation);
      }
      if (backend === 'opencode-cli') {
        assert.equal(first.opts.permission.bash, 'deny');
        const before = fs.readFileSync(first.opts.configPath, 'utf8');
        const second: any = await factory.build({ ...context, convo: { id: 'room-two', kind: 'room' } } as any);
        assert.notEqual(first.opts.configPath, second.opts.configPath);
        assert.equal(fs.readFileSync(first.opts.configPath, 'utf8'), before, 'another room cannot replace the in-flight MCP bearer');
        const headers = JSON.parse(before).mcp.hub.headers;
        assert.equal(verifyInvocationScope(process.env.HUB_TOKEN, headers.Authorization)!.roomId, 'room-one');
      }
    }
    assert.notEqual(moduleBindingHash({ moduleId: 'execute', taskPath: 'tasks/one.md' }),
      moduleBindingHash({ moduleId: 'execute', taskPath: 'tasks/two.md' }), 'task scopes do not share a persistent model session');
  } finally {
    if (previousToken === undefined) delete process.env.HUB_TOKEN; else process.env.HUB_TOKEN = previousToken;
    if (previousGrokHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previousGrokHome;
    jobs.stopOutOfBandResolver(); db.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('ai-hub-module-backends-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claude module turns can reach hub task tools even when the module never dispatches Worker jobs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-module-hub-tools-'));
  const db = openDb(path.join(dir, 'hub.db'));
  const jobs = new JobStore(db, { broadcast() {} } as any);
  const previousToken = process.env.HUB_TOKEN; process.env.HUB_TOKEN = 'module-hub-tools-test-secret';
  const config = { dbPath: path.join(dir, 'hub.db'), agentsDir: path.join(dir, 'agents'),
    host: '127.0.0.1', port: 3900, memory: {}, claude: {}, codex: {}, opencode: {}, grok: {} };
  const prompts = { composeStart: async () => ({ preamble: 'Approved module task', memoryPreamble: '' }),
    withDelegation: (text: string) => text, staticTokens: () => 0 };
  const factory = new BackendFactory({ db, jobStore: jobs, config, vault: null, prompts } as any);
  try {
    const agent = { id: 'claude', kind: 'dm', backend: 'claude-cli', config: JSON.stringify({ delegation: { enabled: false } }) };
    for (const moduleId of ['plan', 'review', 'arbitration', 'merge', 'deploy']) {
      const invocation = { moduleId, revision: 16, permissions: { write: false, shell: true, ssh: false },
        binding: { contactId: 'claude', runner: 'claude', model: 'claude-sonnet-5', reasoning: 'max' } };
      const context = { agent, convo: { id: 'room-one', kind: 'room' }, isRoom: true, memberId: `claude::${moduleId}`,
        memory: { injectOnSpawn: false }, moduleInvocation: invocation, log() {}, nameOf: (id: string) => id };
      const backend: any = await factory.build(context as any);
      assert.ok(backend.opts.allowedTools?.includes('mcp__hub__*'), `${moduleId}: hub task tools must be on the CLI allowlist`);
      assert.ok(backend.opts.mcpConfig, `${moduleId}: hub MCP server config is attached`);
    }
    const dm = { agent, convo: { id: 'claude', kind: 'dm' }, isRoom: false, memberId: 'claude',
      memory: { injectOnSpawn: false }, log() {}, nameOf: (id: string) => id };
    const dmBackend: any = await factory.build(dm as any);
    assert.ok(!dmBackend.opts.allowedTools?.includes('mcp__hub__*'), 'DM turns without delegation keep hub tools off');
  } finally {
    if (previousToken === undefined) delete process.env.HUB_TOKEN; else process.env.HUB_TOKEN = previousToken;
    jobs.stopOutOfBandResolver(); db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
