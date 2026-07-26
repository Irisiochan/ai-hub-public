import { type RequestHandler } from 'express';
import { desktopSessionAuth } from '../auth.js';

export function sessionAuth(hubToken: string | undefined): RequestHandler | null {
  if (!hubToken) return null;
  return desktopSessionAuth(hubToken);
}
