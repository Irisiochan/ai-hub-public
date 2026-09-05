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

export function canonicalWorkspacePath(workspace: string | null | undefined): string;
export function executionFingerprint(input: ExecutionKeyInput): string;
export function executionDispatchKey(input: ExecutionKeyInput): string;
export function legacyExecutionDispatchKey(input: Pick<ExecutionKeyInput, 'taskPath' | 'planHash'>): string;
export function verificationDispatchKey(input: VerificationKeyInput): string;
export function legacyVerificationDispatchKey(input: Pick<VerificationKeyInput, 'taskPath' | 'due'>): string;
