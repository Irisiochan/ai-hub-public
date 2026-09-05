import crypto from 'node:crypto';

// Shared by the gateway and triage worker. Keep v1 keys for stored receipts
// and staggered deployments; v2 includes reassignment in dispatch identity.
export function canonicalWorkspacePath(workspace) {
  let value = String(workspace ?? '').trim().replaceAll('\\', '/');
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
}

export function executionFingerprint(input) {
  return crypto.createHash('sha256').update([
    'ai-hub-coordination-execution',
    'v2',
    String(input?.taskPath ?? '').trim().replaceAll('\\', '/'),
    String(input?.executor ?? '').trim().toLowerCase(),
    canonicalWorkspacePath(input?.workspace),
    String(input?.branch ?? '').trim(),
    String(input?.planHash ?? '').trim().toLowerCase(),
  ].join('\n')).digest('hex');
}

export function executionDispatchKey(input) {
  return `coordination:v2:${input.taskPath}:${executionFingerprint(input)}`;
}

export function legacyExecutionDispatchKey(input) {
  return `coordination:${input.taskPath}:${input.planHash}`;
}

export function verificationDispatchKey(input) {
  return `verification:v2:${input.taskPath}:${input.due}:${String(input?.verifier ?? '').trim().toLowerCase()}`;
}

export function legacyVerificationDispatchKey(input) {
  return `verification:v1:${input.taskPath}:${input.due}`;
}
