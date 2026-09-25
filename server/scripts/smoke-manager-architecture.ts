import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendFactory } from '../src/runtime/backendFactory.js';
import { Debouncer } from '../src/runtime/debouncer.js';
import { MessageRepo } from '../src/messages/messageRepo.js';
import { AgentManager } from '../src/runtime/manager.js';
import { PromptComposer } from '../src/prompt/promptComposer.js';
import { SessionRepo } from '../src/runtime/sessionRepo.js';
import { estimateTokens } from '../src/prompt/tokenEstimate.js';
import { openContact } from '../src/contacts/configSchemas.js';
import { openDb } from '../src/platform/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(here, '.manager-architecture.db');
const agentsDir = path.join(here, '.manager-architecture-agents');
const uploadsDir = path.join(here, '.manager-architecture-uploads');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
fs.rmSync(agentsDir, { recursive: true, force: true });
fs.rmSync(uploadsDir, { recursive: true, force: true });
fs.mkdirSync(agentsDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

const db = openDb(dbPath);
const messages = new MessageRepo(db);
const sessions = new SessionRepo(db);
const prompts = new PromptComposer(null, messages);
const config = {
  port: 3900,
  host: '127.0.0.1',
  dbPath,
  agentsDir,
  webDist: '',
  uploadsDir,
  claude: { cliPath: 'claude' },
  codex: { cliPath: 'codex' },
  grok: { cliPath: 'grok' },
  api: { turnTimeoutMs: 5000 },
  memory: {
    mcpUrl: null,
    repoPath: null,
    injectOnSpawn: false,
    searchPerTurn: false,
    capture: false,
    maxTurnChars: 0,
    sessionMaxAgeHours: 0,
  },
  backup: { enabled: false, dir: '', intervalHours: 24, keep: 1 },
};
const factory = new BackendFactory({
  db,
  config: config as any,
  vault: null,
  jobStore: null,
  prompts,
});

function addContact(id: string, backend: string, cfg: Record<string, unknown>) {
  db.prepare('INSERT INTO contacts (id, name, backend, kind, config) VALUES (?, ?, ?, ?, ?)')
    .run(id, id, backend, 'dm', JSON.stringify(cfg));
  return openContact(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as any);
}

try {
  const rows = [
    addContact('claude-smoke', 'claude-cli', {}),
    addContact('codex-smoke', 'codex', {}),
    addContact('grok-smoke', 'grok-cli', {}),
    addContact('api-smoke', 'api', { provider: 'openai-compat', apiKey: 'test', model: 'test-model' }),
  ];
  for (const row of rows) {
    const backend = await factory.build({
      agent: row,
      convo: row,
      isRoom: false,
      memberId: '',
      resumeToken: null,
      memory: config.memory as any,
      userName: 'User',
      nameOf: (sender) => sender,
      log: () => {},
    });
    assert.equal(backend.kind, row.backend, `${row.backend} strategy must build matching backend`);
  }

  const first = messages.insert('claude-smoke', 'user', {
    role: 'user', kind: 'text', content: '保留的上下文', status: 'done', turnId: null,
  });
  assert.equal(messages.update(first.id, '更新后的上下文', 'done').content, '更新后的上下文');
  const prompt = await prompts.composeStart({
    agent: rows[0], convo: rows[0], isRoom: false, memory: config.memory as any,
    userName: 'User', nameOf: (sender) => sender, log: () => {},
  }, null);
  assert(prompt.preamble.includes('更新后的上下文'), 'CLI fresh session must retain archive bridge');

  const staticTokens = prompts.staticTokens('system\nMEMORY', 'MEMORY');
  assert.equal(staticTokens.system + staticTokens.memory, estimateTokens('system\nMEMORY'));

  sessions.save('claude-smoke', 'resume-token');
  assert.equal(sessions.active('claude-smoke'), 'resume-token');
  sessions.deactivate('claude-smoke');
  assert.equal(sessions.active('claude-smoke'), null);

  const flushed: number[] = [];
  const debouncer = new Debouncer<string, number>(
    20,
    (previous, next) => Math.min(previous, next),
    async (payload) => { flushed.push(payload); }
  );
  await Promise.all([
    debouncer.push('conversation', 12),
    debouncer.push('conversation', 8),
    debouncer.push('conversation', 10),
  ]);
  assert.deepEqual(flushed, [8], 'debouncer must merge one keyed batch and resolve all waiters');

  const manager = new AgentManager({
    db,
    sse: { broadcast: () => {} } as any,
    config: config as any,
    vault: null,
    jobStore: null,
  });
  const runtime = manager.get(rows[0]);
  const tail = messages.insert('claude-smoke', 'claude-smoke', {
    role: 'assistant', kind: 'text', content: '旧回复', status: 'done', turnId: null,
  });
  const regenerated: number[] = [];
  (runtime as any).invalidateCliContext = async (fromId: number) => { regenerated.push(fromId); };
  (runtime as any).enqueue = ({ userMessageId, text }: any) => {
    assert.equal(userMessageId, first.id);
    assert.equal(text, '重新生成');
    return 'queued';
  };
  assert.equal(await runtime.regenerateFrom(first.id, '重新生成'), 'queued');
  assert.deepEqual(regenerated, [first.id], 'regenerate must invalidate from the source user message');
  assert.equal((db.prepare('SELECT deleted FROM messages WHERE id = ?').get(tail.id) as any).deleted, 1,
    'regenerate must prune later messages');

  const invalidated: number[] = [];
  (runtime as any).invalidateCliContext = async (fromId: number) => { invalidated.push(fromId); };
  await Promise.all([
    manager.invalidateConversation(rows[0], 12),
    manager.invalidateConversation(rows[0], 8),
    manager.invalidateConversation(rows[0], 10),
  ]);
  assert.deepEqual(invalidated, [8], 'edit invalidation batch must keep earliest affected id');

  let resetCalls = 0;
  (runtime as any).reset = async () => { resetCalls++; };
  await manager.resetConversation(rows[0]);
  assert.equal(resetCalls, 1, 'DM reset must reach its runtime');

  const managerSource = fs.readFileSync(path.resolve(here, '../src/runtime/manager.ts'), 'utf-8');
  // 棘轮，不是目标值：400 行那版预算在会议室任务账本进来之后就没兑现过（一度 1567 行，
  // 这条断言因此长期红着没人看）。这里只挡住继续膨胀——manager 缩了就把数字调小，
  // 想往上调之前先拆文件。2026-09-24 从 1678 行拆出 roomDispatchRecovery.ts 降到 1280，
  // 预算跟着降；这条 smoke 从此挂在 npm test 里。下一刀的候选见 docs/ARCHITECTURE.md §4.6。
  const MANAGER_LINE_BUDGET = 1300;
  const managerLines = managerSource.split(/\r?\n/).length;
  assert(
    managerLines <= MANAGER_LINE_BUDGET,
    `manager.ts grew to ${managerLines} lines (budget ${MANAGER_LINE_BUDGET}): split it instead of raising the budget`,
  );
  const runtimeSource = fs.readFileSync(path.resolve(here, '../src/runtime/runtime.ts'), 'utf-8');
  assert(!/INSERT INTO messages|UPDATE messages|SELECT .*messages/.test(
    runtimeSource
  ), 'runtime must not own message SQL');
  assert(/const CRASH_LOCKOUT = 3/.test(runtimeSource) && /if \(this\.lockedOut\(\)\)/.test(runtimeSource),
    'crash lockout guard must remain in the turn path');

  console.log('manager architecture smoke: ok');
} finally {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.rmSync(agentsDir, { recursive: true, force: true });
  fs.rmSync(uploadsDir, { recursive: true, force: true });
}
