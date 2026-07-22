import crypto from 'node:crypto';
import type { Request, RequestHandler } from 'express';

export function secretMatches(value: unknown, expected: string): boolean {
  if (typeof value !== 'string' || !expected) return false;
  const got = Buffer.from(value);
  const want = Buffer.from(expected);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export function bearerMatches(req: Request, expected: string): boolean {
  const authorization = req.header('authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) return false;
  return secretMatches(authorization.slice(7).trim(), expected);
}

export function isSelfAuthenticatedInternalPath(requestPath: string): boolean {
  const workerDevicePath =
    /^\/api\/worker\/(?:connect|claim|reconcile)$/.test(requestPath)
    || /^\/api\/worker\/jobs\/[^/]+\/(?:reconcile|start|heartbeat|events|complete)$/.test(requestPath);
  const hubMcpPath = /^\/api\/hub-mcp\/[^/]+$/.test(requestPath);
  return workerDevicePath || hubMcpPath;
}

export function desktopSessionAuth(hubToken: string): RequestHandler {
  const COOKIE = 'hub_session';
  return (req, res, next) => {
    // Singular /worker/* endpoints validate device tokens themselves. hub-mcp
    // validates its independent HUB_MCP_TOKEN. Plural /workers is deliberately
    // not exempt: it is the privileged management API.
    if (isSelfAuthenticatedInternalPath(req.path)) return next();
    const cookies = Object.fromEntries(
      (req.headers.cookie ?? '').split(';').flatMap((part) => {
        const i = part.indexOf('=');
        return i > 0 ? [[part.slice(0, i).trim(), part.slice(i + 1).trim()]] : [];
      })
    );
    if (secretMatches(cookies[COOKIE], hubToken)) return next();
    if (secretMatches(req.query.token, hubToken)) {
      res.cookie(COOKIE, hubToken, { httpOnly: true, sameSite: 'lax' });
      const clean = req.path === '/' ? '/' : req.path;
      if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.redirect(clean);
      return next();
    }
    return res.status(401).json({ error: 'missing or invalid session token' });
  };
}
