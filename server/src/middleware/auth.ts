import crypto from 'node:crypto';
import { type RequestHandler } from 'express';

const COOKIE_NAME = 'hub_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;

function parseCookies(raw: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (raw ?? '').split(';').filter(Boolean).map((part) => {
      const separator = part.indexOf('=');
      return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
    })
  );
}

export function sessionAuth(hubToken: string | undefined): RequestHandler | null {
  if (!hubToken) return null;
  const loginFailures = new Map<string, { count: number; resetAt: number }>();
  const isProtocolPath = (path: string, prefix: string): boolean =>
    path === prefix || path.startsWith(`${prefix}/`);
  const tokenMatches = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    const received = Buffer.from(value);
    const expected = Buffer.from(hubToken);
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  };
  const sessionSignature = (payload: string): string =>
    crypto.createHmac('sha256', hubToken).update(`hub-session\0${payload}`).digest('base64url');
  const issueSession = (): string => {
    const payload = `${Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS}.${crypto.randomBytes(16).toString('base64url')}`;
    return `v1.${payload}.${sessionSignature(payload)}`;
  };
  const sessionMatches = (value: unknown): boolean => {
    if (typeof value !== 'string') return false;
    const match = /^v1\.(\d+)\.([A-Za-z0-9_-]{20,})\.([A-Za-z0-9_-]+)$/.exec(value);
    if (!match || Number(match[1]) < Math.floor(Date.now() / 1000)) return false;
    const payload = `${match[1]}.${match[2]}`;
    const received = Buffer.from(match[3]);
    const expected = Buffer.from(sessionSignature(payload));
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  };
  const bearer = (header: string | undefined): string | null => {
    const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
    return match?.[1]?.trim() || null;
  };
  const authenticated = (req: Parameters<RequestHandler>[0]): boolean => {
    const credential = bearer(req.header('authorization'));
    return tokenMatches(credential)
      || sessionMatches(credential)
      || sessionMatches(parseCookies(req.headers.cookie)[COOKIE_NAME])
      || (req.path === '/api/events' && sessionMatches(req.query.session));
  };
  const setSessionCookie = (res: Parameters<RequestHandler>[1], session: string): void => {
    res.cookie(COOKIE_NAME, session, {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: '/',
    });
  };
  return (req, res, next) => {
    if (req.path === '/api/session') {
      if (req.method === 'GET') {
        return res.json({ enabled: true, authenticated: authenticated(req) });
      }
      if (req.method === 'DELETE') {
        res.clearCookie(COOKIE_NAME, { sameSite: 'lax', secure: false, path: '/' });
        return res.json({ enabled: true, authenticated: false });
      }
      if (req.method === 'POST') {
        const key = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const existing = loginFailures.get(key);
        const failures = existing && existing.resetAt > now
          ? existing
          : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
        if (failures.count >= LOGIN_FAILURE_LIMIT) {
          res.setHeader('Retry-After', String(Math.ceil((failures.resetAt - now) / 1000)));
          return res.status(429).json({ error: 'too many login attempts' });
        }
        if (!tokenMatches(req.body?.password)) {
          failures.count += 1;
          loginFailures.set(key, failures);
          return res.status(401).json({ error: 'invalid password' });
        }
        loginFailures.delete(key);
        const session = issueSession();
        setSessionCookie(res, session);
        return res.json({ enabled: true, authenticated: true, sessionToken: session });
      }
      return res.status(405).json({ error: 'method not allowed' });
    }

    // Health and signed release metadata/assets stay public so an old Android
    // shell can fetch the login-capable Web OTA before it has a session.
    // /api/worker 与 /api/hub-mcp 不是无认证：worker 走 worker token，
    // hub-mcp 走 per-contact HMAC bearer（middleware/hubMcpAuth.ts），
    // 这里只是把 hub session cookie 这层豁免掉。
    if (
      req.path === '/api/health'
      || isProtocolPath(req.path, '/api/app')
      || isProtocolPath(req.path, '/releases')
      || isProtocolPath(req.path, '/api/worker')
      || isProtocolPath(req.path, '/api/hub-mcp')
    ) return next();

    // Static Web assets must load before the login UI can authenticate API calls.
    if (!req.path.startsWith('/api/')) {
      if (req.method === 'GET' && tokenMatches(req.query.token)) {
        setSessionCookie(res, issueSession());
        return res.redirect(req.path === '/' ? '/' : req.path);
      }
      return next();
    }

    if (authenticated(req)) return next();
    return res.status(401).json({ error: 'missing or invalid session token' });
  };
}
