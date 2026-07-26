import { type RequestHandler } from 'express';

export function localCors(originsRaw = process.env.HUB_CORS_ORIGINS): RequestHandler {
  const origins = new Set(
    (originsRaw ?? 'http://localhost,https://localhost,capacitor://localhost')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', (req.headers['access-control-request-headers'] as string | undefined) ?? 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.status(204).end();
        return;
      }
    }
    next();
  };
}
