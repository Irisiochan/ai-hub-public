import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GrokRuntimeHome {
  home: string;
  authPath: string;
}

/** Room MCP credentials must load even when Grok distrusts the scratch cwd.
 * Keep auth and session continuity in the original home; never copy a login or
 * persist a turn bearer in the shared user config / folder-trust store.
 */
export function prepareGrokRuntimeHome(opts: {
  cwd: string;
  servers: Record<string, { url: string; headers?: Record<string, string> }>;
}): GrokRuntimeHome {
  const sharedHome = path.resolve(process.env.GROK_HOME || path.join(process.env.HOME || os.homedir(), '.grok'));
  const home = path.join(opts.cwd, '.grok-runtime');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  // Grok merges project entries before applying the trust gate. An old
  // project `hub` therefore shadows even our valid user-level entry, then
  // gets dropped as untrusted. Remove only the block previously owned by us.
  const projectFile = path.join(opts.cwd, '.grok', 'config.toml');
  if (fs.existsSync(projectFile)) {
    const original = fs.readFileSync(projectFile, 'utf8');
    const cleaned = original.replace(/# >>> AI Hub managed MCP: hub[\s\S]*?# <<< AI Hub managed MCP: hub\r?\n?/g, '');
    if (/^\s*\[mcp_servers\.(?:hub|"hub"|'hub')(?:\.|\])/m.test(cleaned)) {
      throw new Error('grok room project defines an unmanaged hub MCP; refusing stale credential fallback');
    }
    if (cleaned !== original) fs.writeFileSync(projectFile, cleaned, { mode: 0o600 });
  }
  const sharedSessions = path.join(sharedHome, 'sessions');
  fs.mkdirSync(sharedSessions, { recursive: true });
  const sessions = path.join(home, 'sessions');
  if (fs.existsSync(sessions)) {
    if (fs.realpathSync(sessions) !== fs.realpathSync(sharedSessions)) {
      throw new Error('grok runtime sessions must reference the original session store');
    }
  } else {
    fs.symlinkSync(sharedSessions, sessions, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const lines = [
    '# AI Hub room runtime MCP; generated, never commit.',
    '[cli]', 'use_leader = false',
    // Keep project MCP/hooks gated; only our user-level config is authoritative.
    '[folder_trust]', 'enabled = true',
  ];
  for (const [name, server] of Object.entries(opts.servers)) {
    lines.push('', `[mcp_servers.${JSON.stringify(name)}]`, `url = ${JSON.stringify(server.url)}`, 'enabled = true');
    if (server.headers) {
      lines.push(`[mcp_servers.${JSON.stringify(name)}.headers]`);
      for (const [key, value] of Object.entries(server.headers)) lines.push(`${JSON.stringify(key)} = ${JSON.stringify(value)}`);
    }
  }
  const file = path.join(home, 'config.toml');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { home, authPath: path.resolve(process.env.GROK_AUTH_PATH || path.join(sharedHome, 'auth.json')) };
}
