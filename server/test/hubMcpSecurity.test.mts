import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { openDb, type ContactRow } from '../src/platform/db.js';
import {
  auditRoomOrchestratorConfigs,
  dispatchCoordinationRoomHost,
} from '../src/workflow/coordinationRoom.js';
import { buildDelegateTools } from '../src/jobs/delegateTools.js';
import {
  coordinationAuthorityHolderIds,
  resolveRoomOrchestratorId,
} from '../src/rooms/roomPrompt.js';
import { codexAppServerArgs } from '../src/backends/codexAppServer.js';
import { redactSecrets } from '../src/platform/redactSecrets.js';
import { hubMcpAuthMode, hubMcpBearerMatches, hubMcpBearerToken } from '../src/platform/middleware/hubMcpAuth.js';
import { hubMcpRouter } from '../src/tools/hubMcpRoutes.js';
import { JobStore } from '../src/jobs/jobStore.js';
import { ensureRoomOrchestratorCove } from '../src/contacts/seed.js';
import type { SseHub } from '../src/platform/sse.js';
import type { HubLogger } from '../src/platform/logger.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-mcp-security-'));
const db = openDb(path.join(tempDir, 'hub.db'));
const sse = { broadcast() {} } as unknown as SseHub;
const jobs = new JobStore(db, sse);

const auditRecords: Array<Record<string, unknown>> = [];
const logger = {
  warn(fields: Record<string, unknown>) { auditRecords.push(fields); },
  info() {},
  error() {},
} as unknown as HubLogger;

const HUB_TOKEN = 'test-hub-token-0123456789abcdef0123456789abcdef';

// ── bearer 派生与模式 ──
assert.equal(hubMcpAuthMode(undefined, undefined), 'disabled');
assert.equal(hubMcpAuthMode(HUB_TOKEN, undefined), 'enforce');
assert.equal(hubMcpAuthMode(HUB_TOKEN, 'warn'), 'warn');
const coveToken = hubMcpBearerToken(HUB_TOKEN, 'codex');
assert.equal(coveToken, hubMcpBearerToken(HUB_TOKEN, 'codex'), 'token 必须是确定性派生');
assert.notEqual(coveToken, hubMcpBearerToken(HUB_TOKEN, 'aye'), '不同联系人 token 必须不同');
assert.notEqual(coveToken, hubMcpBearerToken('rotated-token-0123456789abcdef0123456789ab', 'codex'), '轮换 HUB_TOKEN 必须使旧 token 失效');
assert.equal(hubMcpBearerMatches(HUB_TOKEN, 'codex', `Bearer ${coveToken}`), true);
assert.equal(hubMcpBearerMatches(HUB_TOKEN, 'codex', `Bearer ${hubMcpBearerToken(HUB_TOKEN, 'aye')}`), false, '跨联系人 token 不得互认');
assert.equal(hubMcpBearerMatches(HUB_TOKEN, 'codex', undefined), false);

// ── 路由层 enforce / warn ──
db.prepare(
  `INSERT INTO contacts (id, name, backend, kind, config) VALUES ('codex', 'Codex', 'codex', 'dm', ?)`
).run(JSON.stringify({ delegation: { enabled: true, workspaces: ['C:/ai-hub-codex'], allowShell: true } }));
db.prepare(
  `INSERT INTO contacts (id, name, backend, kind, config) VALUES ('aye', 'Aye', 'grok-cli', 'dm', ?)`
).run(JSON.stringify({ delegation: { enabled: false }, heartbeat: { enabled: false } }));

async function post(base: string, contactId: string, authorization?: string): Promise<number> {
  const response = await fetch(`${base}/hub-mcp/${contactId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
  });
  await response.text();
  return response.status;
}

const enforceApp = express();
enforceApp.use(express.json());
enforceApp.use('/api', hubMcpRouter(db, jobs, { hubToken: HUB_TOKEN, logger }));
const enforceServer = enforceApp.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => enforceServer.once('listening', resolve));
const enforceAddress = enforceServer.address();
assert.ok(enforceAddress && typeof enforceAddress !== 'string');
const enforceBase = `http://127.0.0.1:${enforceAddress.port}/api`;

try {
  assert.equal(await post(enforceBase, 'codex'), 401, '无凭证必须拒绝');
  assert.equal(await post(enforceBase, 'codex', `Bearer ${hubMcpBearerToken(HUB_TOKEN, 'aye')}`), 401, '拿别人 token 伪造 contactId 必须拒绝');
  assert.equal(await post(enforceBase, 'ghost', `Bearer ${hubMcpBearerToken(HUB_TOKEN, 'codex')}`), 401, '伪造不存在的 contactId 也过不了对应 token 校验');
  assert.equal(await post(enforceBase, 'aye', `Bearer ${hubMcpBearerToken(HUB_TOKEN, 'aye')}`), 403, '凭证正确但 delegation 未开启 → 403（撤销通道）');
  assert.equal(await post(enforceBase, 'codex', `Bearer ${coveToken}`), 200, '正确 per-contact token 放行');

  // OpenCode 1.18.x 使用旧 HTTP+SSE：GET 建流，再 POST 到 endpoint 事件给出的地址。
  const rejectedSse = await fetch(`${enforceBase}/hub-mcp/codex`, {
    headers: { accept: 'text/event-stream' },
  });
  assert.equal(rejectedSse.status, 401, 'SSE 建流同样必须携带 per-contact token');
  await rejectedSse.text();

  const sseAbort = new AbortController();
  const sseResponse = await fetch(`${enforceBase}/hub-mcp/codex`, {
    headers: { accept: 'text/event-stream', authorization: `Bearer ${coveToken}` },
    signal: sseAbort.signal,
  });
  assert.equal(sseResponse.status, 200, '正确 token 应建立 SSE');
  assert.match(sseResponse.headers.get('content-type') ?? '', /^text\/event-stream/);
  const sseReader = sseResponse.body!.getReader();
  const firstEvent = await sseReader.read();
  const firstEventText = new TextDecoder().decode(firstEvent.value);
  const endpointMatch = firstEventText.match(/event: endpoint\r?\ndata: ([^\r\n]+)/);
  assert.ok(endpointMatch, 'SSE 必须发布带 sessionId 的消息 endpoint');
  const messageUrl = new URL(endpointMatch[1], new URL(enforceBase).origin);

  const rejectedMessage = await fetch(messageUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: {}, id: 1 }),
  });
  assert.equal(rejectedMessage.status, 401, 'SSE 消息 POST 也必须重新鉴权');

  const acceptedMessage = await fetch(messageUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${coveToken}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      id: 1,
    }),
  });
  assert.equal(acceptedMessage.status, 202, '正确 token + sessionId 的 SSE 消息应被接收');
  const responseEvent = await sseReader.read();
  assert.match(new TextDecoder().decode(responseEvent.value), /event: message/, 'MCP 响应应回到同一 SSE 流');
  sseAbort.abort();
  await sseReader.cancel().catch(() => undefined);

  assert.ok(
    auditRecords.filter((entry) => entry.component === 'hub-mcp').length >= 3,
    '每次拒绝都必须留审计记录'
  );
} finally {
  await new Promise<void>((resolve, reject) => enforceServer.close((error) => error ? reject(error) : resolve()));
}

const warnApp = express();
warnApp.use(express.json());
warnApp.use('/api', hubMcpRouter(db, jobs, { hubToken: HUB_TOKEN, envMode: 'warn', logger }));
const warnServer = warnApp.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => warnServer.once('listening', resolve));
const warnAddress = warnServer.address();
assert.ok(warnAddress && typeof warnAddress !== 'string');
const warnBase = `http://127.0.0.1:${warnAddress.port}/api`;
try {
  const auditBefore = auditRecords.filter((entry) => entry.component === 'hub-mcp').length;
  assert.equal(await post(warnBase, 'codex'), 200, 'warn 模式只审计不拒绝（存量客户端迁移窗口）');
  assert.equal(
    auditRecords.filter((entry) => entry.component === 'hub-mcp').length,
    auditBefore + 1,
    'warn 模式也必须留审计'
  );
} finally {
  await new Promise<void>((resolve, reject) => warnServer.close((error) => error ? reject(error) : resolve()));
}

// ── codex per-process 配置注入 http_headers ──
const codexArgs = codexAppServerArgs([{
  name: 'hub',
  url: 'http://127.0.0.1:3900/api/hub-mcp/codex',
  required: true,
  httpHeaders: { Authorization: `Bearer ${coveToken}` },
}]);
// codex -c 的 value 按 TOML 解析：必须是 inline table 而不是 JSON 对象字符串，
// 否则 codex 启动即报 "expected a map" 且报错原文回显 bearer（2026-08-19 生产事故）。
assert.ok(
  codexArgs.includes(`mcp_servers.hub.http_headers={ "Authorization" = "Bearer ${coveToken}" }`),
  'codex http_headers 必须是 TOML inline table 且带 per-contact Authorization header'
);
assert.ok(
  codexArgs.every((arg) => !arg.includes('http_headers={"')),
  'http_headers 不得再以 JSON 对象字符串下发'
);

// ── 用户可见错误文本的凭据脱敏 ──
const leakyCodexError = 'codex app-server exited code=1 signal=null — Error: error loading default config '
  + `after config error: invalid type: string "{\\"Authorization\\":\\"Bearer ${coveToken}\\"}", expected a map`;
const scrubbed = redactSecrets(leakyCodexError);
assert.ok(!scrubbed.includes(coveToken), '错误文本里的 bearer 必须被脱敏');
assert.ok(scrubbed.includes('[REDACTED_SECRET]'), '脱敏后必须留下占位标记');
assert.ok(scrubbed.includes('expected a map'), '脱敏不得吞掉诊断信息本身');
assert.equal(redactSecrets('后端启动失败：连接超时'), '后端启动失败：连接超时', '无凭据文本必须原样保留');

// ── retired marker authority：marker 文本不再授予任何东西 ──
// DM 普通委派只看联系人委派配置（白名单/SSH）；marker 是惰性文本，既不能
// 扩大权限，也不能跨任务/跨人转移授权。真正的任务授权在 room task ledger
//（task_handoff/task_accept + execution_start），见 roomTaskModelDriven。
const taskPath = 'tasks/gate-demo.md';
const planHash = 'a'.repeat(64);
db.prepare(
  `INSERT INTO contacts (id, name, backend, kind, config) VALUES ('room', '会议室', 'room', 'room', '{}')`
).run();
const markerPrompt = (fp: string) => [
  '[AI_HUB_COORDINATION_V2]',
  `taskPath=${taskPath}`,
  `planHash=${planHash}`,
  `fingerprint=${fp}`,
  '只执行任务文件 Plan。',
].join('\n');
const delegationCfg = { enabled: true, workspaces: ['C:/ai-hub-codex', 'C:/other'], allowShell: true };
const delegateAs = (contactId: string) =>
  buildDelegateTools(jobs, db, contactId, delegationCfg, contactId, logger)
    .find((tool) => tool.name === 'delegate_to_worker')!;
const baseInput = {
  route_class: 'implement',
  workspace: 'C:/ai-hub-codex',
  shell: true,
};

const executorOk = await delegateAs('codex').exec({ ...baseInput, prompt: markerPrompt('f'.repeat(64)) });
assert.equal(executorOk.ok, true, 'marker 只是普通文本：联系人自己的合法委派不受影响');

const memberOrdinary = await delegateAs('aye').exec({ ...baseInput, prompt: markerPrompt('f'.repeat(64)).replaceAll(taskPath, 'tasks/gate-demo-aye.md') });
assert.equal(memberOrdinary.ok, true, '没有可偷的 marker 授权：DM 委派只看自己的联系人配置');

const wrongWorkspace = await delegateAs('codex').exec({
  ...baseInput,
  workspace: 'C:/not-allowed',
  prompt: markerPrompt('f'.repeat(64)),
});
assert.equal(wrongWorkspace.ok, false, 'marker 文本不能扩大白名单');
assert.match(wrongWorkspace.text, /白名单/);

const sshSmuggle = await delegateAs('codex').exec({
  ...baseInput,
  prompt: markerPrompt('f'.repeat(64)),
  ssh: true,
});
assert.equal(sshSmuggle.ok, false, 'marker 文本不能偷渡 SSH');

const plainDelegate = await delegateAs('aye').exec({
  ...baseInput,
  prompt: '普通的非 coordination 委派任务：跑一遍测试并回报。',
});
assert.equal(plainDelegate.ok, true, '非 coordination prompt 的普通委派不受影响');

// 模块轮次里 marker 同样无权：只有迁移指引，没有任务创建。
const scopedMarker = buildDelegateTools(jobs, db, 'codex', delegationCfg, 'room', logger, {
  allow: true,
  routeClasses: ['implement', 'fix'],
  invocation: {
    moduleId: 'execute',
    binding: { contactId: 'codex', runner: 'codex', model: 'gpt-6-astra', reasoning: 'high' },
    revision: 1,
    permissions: { write: true, shell: true, ssh: false },
    taskPath,
    workspace: 'C:/ai-hub-codex',
  },
} as never).find((tool) => tool.name === 'delegate_to_worker')!;
const scopedResult = await scopedMarker.exec({ ...baseInput, prompt: markerPrompt('f'.repeat(64)) } as never);
assert.equal(scopedResult.ok, false);
assert.match(scopedResult.text, /execution_start/);
assert.equal(
  (db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c,
  3,
  '被拒绝的模块轮次尝试不得留下 job（三次普通委派各建一张）',
);

// ── orchestrator 配置化：room config coordination.orchestrator ──
assert.equal(resolveRoomOrchestratorId(undefined), 'codex', '无配置回落默认 orchestrator');
assert.equal(resolveRoomOrchestratorId({ coordination: { orchestrator: 'aye' } }), 'aye');
assert.equal(
  resolveRoomOrchestratorId({ coordination: { orchestrator: 'Bad Id!' } }),
  'codex',
  '非法 contact id 不得进入 authority 链'
);
assert.deepEqual(
  coordinationAuthorityHolderIds(null, 'codex'),
  ['codex'],
  'authority holder 必须跟随配置的 orchestrator'
);

db.prepare(
  `INSERT INTO contacts (id, name, backend, kind, config) VALUES
     ('room-orch-ok', '配置房', 'room', 'room', ?),
     ('room-orch-ghost', '幽灵房', 'room', 'room', ?),
     ('room-orch-bad', '坏配置房', 'room', 'room', ?)`
).run(
  JSON.stringify({ workflowEnabled: false, members: ['codex'], coordination: { enabled: true, orchestrator: 'codex' } }),
  JSON.stringify({ workflowEnabled: false, members: ['ghost'], coordination: { orchestrator: 'ghost' } }),
  JSON.stringify({ workflowEnabled: false, members: ['codex'], coordination: { orchestrator: 'Bad Id!' } }),
);
const issues = auditRoomOrchestratorConfigs(db);
assert.ok(!issues.some((issue) => issue.roomId === 'room-orch-ok'), '合法配置不得报问题');
assert.ok(
  issues.some((issue) => issue.roomId === 'room-orch-ghost' && /not an enabled dm contact/.test(issue.reason)),
  'orchestrator 指向不存在联系人必须在启动校验暴露'
);
assert.ok(
  issues.some((issue) => issue.roomId === 'room-orch-bad' && /invalid contact id/.test(issue.reason)),
  '非法 orchestrator id 必须在启动校验暴露'
);
db.prepare("UPDATE contacts SET config = ? WHERE id = 'room-orch-ghost'")
  .run(JSON.stringify({ workflowEnabled: true, members: ['codex', 'ghost'], coordination: { orchestrator: 'ghost' } }));
assert.ok(!auditRoomOrchestratorConfigs(db).some((issue) => issue.roomId === 'room-orch-ghost'),
  'workflow room authority comes from plan binding; a retained legacy orchestrator is not operational authority');

// 回执默认目标：不再硬编码 claude，落到房间配置的 orchestrator
const coveRow = db.prepare(`SELECT * FROM contacts WHERE id = 'codex'`).get() as ContactRow;
const fakeManager = {
  imageRoomMembers: () => [coveRow],
  dispatchRoomMessageTracked: () => ({ completion: Promise.resolve({ ok: true }) }),
};
const receiptPost = dispatchCoordinationRoomHost(
  { db, sse, manager: fakeManager as never, logger },
  { content: '回执：TTL 演示任务完成', kind: 'receipt', idempotencyKey: 'receipt:test:orch', meta: {} },
);
assert.equal(receiptPost.status, 'posted', '省略 targetId 的回执必须按房间配置派发');
assert.equal(receiptPost.roomId, 'room-orch-ok', '优先选择 coordination.enabled=true 的房间');
const receiptRow = db.prepare(
  `SELECT meta FROM messages WHERE idempotency_key = 'receipt:test:orch'`
).get() as { meta: string };
assert.deepEqual(
  JSON.parse(receiptRow.meta).roomHost.targets,
  ['codex'],
  '回执目标必须是房间配置的 orchestrator，而不是硬编码 claude'
);

db.prepare(
  `INSERT INTO contacts (id, name, backend, kind, config, enabled) VALUES
     ('room-seed-default', '默认房', 'room', 'room', ?, 1),
     ('room-seed-claude', '旧Claude房', 'room', 'room', ?, 1),
     ('room-seed-aye', '阿野房', 'room', 'room', ?, 1)`
).run(
  JSON.stringify({ members: ['codex', 'aye', 'muse'] }),
  JSON.stringify({ members: ['codex', 'aye'], coordination: { enabled: true, orchestrator: 'claude' } }),
  JSON.stringify({ members: ['codex', 'aye'], coordination: { enabled: true, orchestrator: 'aye' } }),
);
ensureRoomOrchestratorCove(db, logger);
assert.equal(
  JSON.parse((db.prepare(`SELECT config FROM contacts WHERE id = 'room-seed-default'`).get() as { config: string }).config).coordination.orchestrator,
  'codex',
  '缺省房间必须把 orchestrator 写成 codex',
);
assert.equal(
  JSON.parse((db.prepare(`SELECT config FROM contacts WHERE id = 'room-seed-claude'`).get() as { config: string }).config).coordination.orchestrator,
  'codex',
  '仍写Claude的房间必须迁到 codex',
);
assert.equal(
  JSON.parse((db.prepare(`SELECT config FROM contacts WHERE id = 'room-seed-aye'`).get() as { config: string }).config).coordination.orchestrator,
  'aye',
  '显式非Claude orchestrator 不得被覆盖',
);
// 等 dispatch 的 completion 回调落库完成，再关 db
await new Promise((resolve) => setImmediate(resolve));

console.log('hub mcp security tests: ok');
db.close();
fs.rmSync(tempDir, { recursive: true, force: true });
