import crypto from 'node:crypto';

/**
 * Closure-client bearer: a read-only credential for the deterministic
 * merge/deploy closure scripts running off-box (today: the vps-dev worker).
 *
 * Why it exists. `deploy/merge-close-job.mjs` re-verifies the room-task ledger
 * before it pushes master, and `deploy/room-deploy-job.mjs` checks for
 * in-flight room rounds before it deploys. Both are hard, fail-closed gates,
 * so both need a bearer. Handing the VPS the raw HUB_TOKEN would give a
 * closure script the ability to log in, mint 30-day sessions and write
 * anything in the hub — far more than "read two ledger endpoints".
 *
 * Shape follows the existing per-contact hub-mcp bearer (hubMcpAuth.ts):
 *   token = HMAC-SHA256(HUB_TOKEN, 'closure-v1\0' + clientId)
 * Deterministic, so nothing is stored server-side; derive it on the box that
 * needs it, straight from HUB_TOKEN, and the value never travels. Rotating
 * HUB_TOKEN invalidates every derived token at once.
 *
 * Scope is the whole point: GET only, and only the three read-only endpoints
 * the two closure scripts actually call. It can never authenticate a write, a
 * login, or any other path — CLOSURE_SCOPE below is an allowlist, not a
 * prefix check, so a new route is out of scope until someone adds it here on
 * purpose.
 */

/** Clients allowed to hold a closure bearer. One entry per off-box runner. */
export const CLOSURE_CLIENT_IDS = ['vps-dev'] as const;

/**
 * GET paths a closure bearer may read. Exact-match regexes on purpose:
 * `/api/room-tasks/:room/:task` must not also open `/api/room-tasks/:room`
 * or anything nested below the task.
 */
const CLOSURE_SCOPE: RegExp[] = [
  // merge-close-job.mjs: live candidate_sha / review_status re-verification.
  /^\/api\/room-tasks\/[^/]+\/[^/]+$/,
  // room-deploy-job.mjs: pre-deploy "no room round in flight" check.
  /^\/api\/contacts$/,
  /^\/api\/contacts\/[^/]+\/messages$/,
];

export function closureBearerToken(hubToken: string, clientId: string): string {
  return crypto.createHmac('sha256', hubToken)
    .update(`closure-v1\0${clientId}`)
    .digest('base64url');
}

export function closureScopeAllows(method: string, path: string): boolean {
  if (method !== 'GET') return false;
  return CLOSURE_SCOPE.some((pattern) => pattern.test(path));
}

/** Constant-time match against every configured client's derived token. */
export function closureBearerMatches(
  hubToken: string,
  credential: string | null | undefined,
  clientIds: readonly string[] = CLOSURE_CLIENT_IDS,
): boolean {
  const received = String(credential ?? '');
  if (!received || !hubToken) return false;
  const receivedBuffer = Buffer.from(received);
  let matched = false;
  for (const clientId of clientIds) {
    const expectedBuffer = Buffer.from(closureBearerToken(hubToken, clientId));
    // No early return: every candidate is compared so the work does not depend
    // on which client (if any) matched.
    if (receivedBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
      matched = true;
    }
  }
  return matched;
}
