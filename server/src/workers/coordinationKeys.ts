import crypto from 'node:crypto';

/**
 * Coordination dispatch-key canonicalization, fingerprint v2.
 *
 * Mirror of worker/triage-core.mjs (executionFingerprint 及其同伴)——两边必须
 * 保持字节一致，server/test/coordinationKeys.test.mts 做跨实现 parity 校验。
 * v2 的派单身份覆盖 executor/workspace/branch（执行）与 verifier（验收），
 * 使「Plan/due 不变但改派」也产生新 key；v1 旧 key 仍被端点接受以覆盖
 * worker 与 server 分批部署的过渡窗口。
 */

export interface ExecutionKeyInput {
  taskPath: string;
  planHash: string;
  executor: string;
  workspace: string;
  branch: string;
}

export interface VerificationKeyInput {
  taskPath: string;
  due: string;
  verifier: string;
}

export function canonicalWorkspacePath(workspace: string | null | undefined): string {
  let value = String(workspace ?? '').trim().replaceAll('\\', '/');
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
}

export function executionFingerprint(input: ExecutionKeyInput): string {
  return crypto.createHash('sha256').update([
    'ai-hub-coordination-execution',
    'v2',
    String(input.taskPath ?? '').trim().replaceAll('\\', '/'),
    String(input.executor ?? '').trim().toLowerCase(),
    canonicalWorkspacePath(input.workspace),
    String(input.branch ?? '').trim(),
    String(input.planHash ?? '').trim().toLowerCase(),
  ].join('\n')).digest('hex');
}

export function executionDispatchKey(input: ExecutionKeyInput): string {
  return `coordination:v2:${input.taskPath}:${executionFingerprint(input)}`;
}

export function legacyExecutionDispatchKey(input: Pick<ExecutionKeyInput, 'taskPath' | 'planHash'>): string {
  return `coordination:${input.taskPath}:${input.planHash}`;
}

export function verificationDispatchKey(input: VerificationKeyInput): string {
  return `verification:v2:${input.taskPath}:${input.due}:${String(input.verifier ?? '').trim().toLowerCase()}`;
}

export function legacyVerificationDispatchKey(input: Pick<VerificationKeyInput, 'taskPath' | 'due'>): string {
  return `verification:v1:${input.taskPath}:${input.due}`;
}
