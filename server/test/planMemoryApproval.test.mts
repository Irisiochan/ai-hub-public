import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  elicitationDetail,
  isMemoryVaultApproval,
  isTrustedMcpApproval,
  isTrustedMcpServerName,
} from '../src/backends/codexAppServer.js';
import { delegateScopeForModule } from '../src/workflow/moduleAuthority.js';
import { roomTurnNotice, type RoomModuleAuthority } from '../src/rooms/roomPrompt.js';
import { WORKFLOW_MODULES } from '../src/workflow/workflowModules.js';

const senders = [{ id: 'user', name: 'User' }];
const window = { messageIds: [1] };

/** Authority block built from the real module definition and dispatch scope,
 * exactly as AgentRuntime.roomNoticeModule() does in production. Permissions
 * may be overridden to mirror a narrowed captured snapshot
 * (validateCapturedSnapshot intersects snapshot flags with the definition). */
function authorityFor(
  moduleId: string,
  permissions?: { write: boolean; shell: boolean; ssh: boolean },
  executeContactId?: string,
): RoomModuleAuthority {
  const definition = WORKFLOW_MODULES.find((item) => item.id === moduleId)!;
  const scope = delegateScopeForModule(moduleId);
  return {
    moduleId,
    permissions: permissions ?? { ...definition.permissions },
    bindingRevision: 7,
    canDispatch: scope.allow,
    routeClasses: [...scope.routeClasses],
    ...(moduleId === 'plan' && scope.allow ? { executeContactId } : {}),
  };
}

function noticeFor(
  moduleId: string,
  permissions?: { write: boolean; shell: boolean; ssh: boolean },
  executeContactId?: string,
): string {
  return roomTurnNotice('normal', senders, window, null, 'codex', 'codex', false, authorityFor(moduleId, permissions, executeContactId));
}

// Positive: authorized Memory read access via the dedicated vault MCP.
test('trusted Memory read approvals accept the dedicated vault server', () => {
  assert.equal(isTrustedMcpServerName('memory_vault'), true);
  assert.equal(isTrustedMcpServerName('memory-vault'), true);
  assert.equal(
    isTrustedMcpApproval('mcpServer/elicitation/request', { serverName: 'memory_vault' }),
    true,
  );
  assert.equal(
    isTrustedMcpApproval('mcp/tool/requestApproval', { serverName: 'memory_vault' }),
    true,
  );
  assert.equal(isMemoryVaultApproval('mcp/tool/requestApproval', { serverName: 'memory_vault' }), true);
});

// Negative: unrelated connectors and unknown servers never gain approval,
// even when their free text mentions trusted names (no blob keyword trust).
test('unrelated codex_apps elicitation is declined without tool identity', () => {
  assert.equal(isTrustedMcpServerName('codex_apps'), false);
  assert.equal(
    isTrustedMcpApproval('mcpServer/elicitation/request', { serverName: 'codex_apps' }),
    false,
  );
  assert.equal(
    isTrustedMcpApproval('mcpServer/elicitation/request', {
      serverName: 'codex_apps',
      mode: 'form',
      message: 'approve memory_vault requirement search and mcp__hub__delegate?',
    }),
    false,
  );
  assert.equal(
    isTrustedMcpApproval('mcpServer/elicitation/request', { serverName: 'unknown-connector' }),
    false,
  );
  const detail = elicitationDetail({ serverName: 'codex_apps', mode: 'form', message: '  hello world  ' });
  assert.match(detail, /mode=form/);
  assert.ok(!detail.includes('hello'), 'log metadata must not echo raw message text');
});

// Blocking review fixture: secret-bearing external message content must never
// appear in logs — only allowlisted mode plus presence/length metadata.
test('elicitation logs never carry secret-bearing message content', () => {
  const secret = 'sk-test-9f8e7d6c';
  const tokenUrl = 'https://connector.example/cb?token=tok-test-secret-12345';
  const elicitationId = 'secret-elicitation-id-1';
  const detail = elicitationDetail({
    serverName: 'codex_apps',
    mode: 'form',
    message: `approve access, my key is ${secret}`,
    url: tokenUrl,
    requestedSchema: { type: 'object', properties: { apiKey: { type: 'string' }, other: { type: 'string' } } },
    elicitationId,
  });
  for (const leaked of [secret, tokenUrl, 'tok-test-secret-12345', elicitationId, 'apiKey']) {
    assert.ok(!detail.includes(leaked), `log must not contain secret material: ${leaked}`);
  }
  assert.match(detail, /mode=form/);
  assert.match(detail, /messageLen=\d+/);
  assert.match(detail, /schemaProps=2/);
  assert.match(detail, /hasUrl=true/);
  assert.match(detail, /hasElicitationId=true/);
  assert.match(elicitationDetail({ mode: 'evil"; DROP', message: 'x' }), /mode=other/);
  assert.equal(elicitationDetail({ serverName: 'codex_apps' }), '');
});

// Negative: native writes are never approved, even for trusted servers.
test('native shell and patch approvals are always declined', () => {
  for (const method of ['execCommandApproval', 'applyPatchApproval']) {
    for (const params of [{ serverName: 'memory_vault' }, { serverName: 'hub' }, { serverName: 'codex_apps' }]) {
      assert.equal(isTrustedMcpApproval(method, params), false, `${method} ${JSON.stringify(params)}`);
    }
  }
});

// Plan keeps implement/fix dispatch while project writes stay forbidden,
// including an explicit direct-deploy ban (plan is orchestrator, so shared
// orchestrator deploy guidance must not read as a personal deploy grant).
test('plan module works through task tools with project writes forbidden', () => {
  assert.deepEqual(delegateScopeForModule('plan'), { allow: true, routeClasses: ['implement', 'fix'] });
  const notice = noticeFor('plan');
  assert.match(notice, /write=禁止/);
  assert.match(notice, /任务协作走 task_\* 工具/);
  assert.match(notice, /本轮次身份 plan 即工具授权身份/);
  assert.match(notice, /项目直接写禁止：不得直接改文件、提交或直接部署。/);
  assert.match(notice, /memory_vault/);
  assert.doesNotMatch(notice, /delegate_to_worker/);
});

// Plan handoff names the server-derived execute contact id verbatim: the id
// (not a display name, not self) is what the task handoff will require.
// Nothing counts as executed before Worker acceptance.
test('plan handoff pins the trusted execute contact id and wait semantics', () => {
  const notice = noticeFor('plan', undefined, 'sora');
  assert.match(notice, /联系人 id=sora/);
  assert.match(notice, /task_handoff 点名 execute/);
  assert.doesNotMatch(notice, /联系人 id=Sora/, 'display names must never fill the executor line');
  assert.doesNotMatch(notice, /联系人 id=codex/, 'Plan must not substitute itself');
  assert.match(notice, /对方受理前只报待受理、不推进/);
  assert.match(notice, /Worker 认领前不得宣称已执行或已完成/);
});

// No trusted id, no guessing: an unavailable execute binding blocks loudly.
test('plan handoff without a trusted execute id blocks instead of guessing', () => {
  const notice = noticeFor('plan');
  assert.match(notice, /无法确定交接接收人/);
  assert.match(notice, /不得臆测接收人/);
  assert.match(notice, /先如实报障等待/);
  assert.doesNotMatch(notice, /联系人 id=/);
});

// Non-plan modules never gain the handoff sentence.
test('execute turns carry no plan handoff sentence', () => {
  const notice = noticeFor('execute', undefined, 'sora');
  assert.doesNotMatch(notice, /交接固定给联系人/);
  assert.doesNotMatch(notice, /无法确定交接接收人/);
});


// Dispatching writable modules must not be framed as project read-only.
test('execute and maintenance dispatch without read-only framing', () => {
  assert.deepEqual(delegateScopeForModule('execute'), { allow: true, routeClasses: ['implement', 'fix'] });
  assert.deepEqual(delegateScopeForModule('maintenance'), { allow: true, routeClasses: ['recon', 'mechanical'] });
  for (const moduleId of ['execute', 'maintenance']) {
    const notice = noticeFor(moduleId);
    assert.match(notice, /write=允许/, moduleId);
    assert.match(notice, /任务协作走 task_\* 工具/, moduleId);
    assert.match(notice, /项目直接写允许/, moduleId);
    assert.doesNotMatch(notice, /项目直接写禁止/, moduleId);
    // Scope to the module block: the shared coordination template elsewhere
    // legitimately mentions 只读验收, which must not leak into module framing.
    const moduleBlock = notice.slice(notice.indexOf('本轮 fixed-module'), notice.indexOf('binding 切换'));
    assert.doesNotMatch(moduleBlock, /只读/, moduleId);
  }
});

// Review/arbitration can neither dispatch nor write.
test('review and arbitration forbid dispatch and direct writes', () => {
  for (const moduleId of ['review', 'arbitration']) {
    assert.deepEqual(delegateScopeForModule(moduleId), { allow: false, routeClasses: [] });
    const notice = noticeFor(moduleId);
    assert.match(notice, /write=禁止/, moduleId);
    assert.match(notice, new RegExp(`本轮次身份 ${moduleId} 即工具授权身份`), moduleId);
    assert.match(notice, /项目直接写禁止：不得直接改文件、提交或部署/, moduleId);
    assert.doesNotMatch(notice, /本模块有派单权/, moduleId);
  }
});

// Merge holds write by definition, but a narrowed captured snapshot must win
// over the module name: narrowed merge stays no-write/no-commit.
test('merge keeps direct-write wording despite no dispatch authority', () => {
  assert.deepEqual(delegateScopeForModule('merge'), { allow: false, routeClasses: [] });
  const notice = noticeFor('merge');
  assert.match(notice, /write=允许/);
  assert.match(notice, /本轮次身份 merge 即工具授权身份/, 'merge');
  assert.match(notice, /项目直接写允许/, 'merge');
  assert.doesNotMatch(notice, /不得直接改文件/, 'merge');
});

test('narrowed merge snapshot stays no-write and no-commit', () => {
  const notice = noticeFor('merge', { write: false, shell: true, ssh: false });
  assert.match(notice, /write=禁止/, 'narrowed merge');
  assert.match(notice, /本轮次身份 merge 即工具授权身份/, 'narrowed merge');
  assert.match(notice, /项目直接写禁止/, 'narrowed merge');
  assert.doesNotMatch(notice, /项目直接写允许/, 'narrowed merge');
});

// Deploy keeps its authorized deploy channel: no blanket deploy ban.
test('deploy keeps its authorized deploy channel wording', () => {
  assert.deepEqual(delegateScopeForModule('deploy'), { allow: false, routeClasses: [] });
  const notice = noticeFor('deploy');
  assert.match(notice, /write=禁止、shell=允许、ssh=允许/);
  assert.match(notice, /本轮次身份 deploy 即工具授权身份/, 'deploy');
  assert.match(notice, /部署仅复用已授权的部署通道/, 'deploy');
  assert.doesNotMatch(notice, /不得直接改文件、提交或部署/, 'deploy');
});

// Narrowed deploy snapshot: wording must echo the snapshot and never claim
// shell/ssh the capture denies. The deploy-channel clause names only the
// module contract, never shell/ssh capabilities.
test('narrowed deploy snapshot claims no denied shell or ssh', () => {
  const notice = noticeFor('deploy', { write: false, shell: false, ssh: false });
  assert.match(notice, /write=禁止、shell=禁止、ssh=禁止/, 'narrowed deploy');
  assert.match(notice, /项目直接写禁止/, 'narrowed deploy');
  assert.match(notice, /部署仅复用已授权的部署通道/, 'narrowed deploy');
  assert.doesNotMatch(notice, /shell=允许/, 'narrowed deploy');
  assert.doesNotMatch(notice, /ssh=允许/, 'narrowed deploy');
  assert.doesNotMatch(notice, /项目直接写允许/, 'narrowed deploy');
});
