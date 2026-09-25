import fs from 'node:fs';
import path from 'node:path';
import type { CodexMcpServerConfig } from './codexAppServer.js';

/** Reuse Claude's per-contact MCP JSON for Codex without changing global CLI configuration. */
export function contactHttpMcpServers(config: unknown, cwd: string, allowedTools: unknown): CodexMcpServerConfig[] {
  if (config === undefined || config === null || config === '') return [];
  if (typeof config !== 'string') throw new Error('mcpConfig must be JSON or a file path');
  const raw = config.trim().startsWith('{') ? config : fs.readFileSync(path.resolve(cwd, config), 'utf-8');
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw new Error('mcpConfig is invalid JSON'); }
  const entries = parsed?.mcpServers;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('mcpConfig must contain mcpServers');
  const allowed = Array.isArray(allowedTools) ? allowedTools : [];
  return Object.entries(entries).flatMap(([name, value]): CodexMcpServerConfig[] => {
    const entry = value as any;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Invalid MCP entry: ${name}`);
    if (entry.disabled === true || entry.enabled === false) return [];
    if (!/^[A-Za-z0-9_-]+$/.test(name) || ['hub', 'memory_vault', 'memory-vault'].includes(name)) {
      throw new Error(`Reserved or invalid contact MCP name: ${name}`);
    }
    if (entry.type !== 'http' || typeof entry.url !== 'string') throw new Error(`Contact MCP ${name} requires HTTP transport`);
    let url: URL;
    try { url = new URL(entry.url); } catch { throw new Error(`Invalid URL for contact MCP ${name}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`Invalid HTTP URL for contact MCP ${name}`);
    if (entry.headers !== undefined && (!entry.headers || typeof entry.headers !== 'object' || Array.isArray(entry.headers)
        || Object.values(entry.headers).some((v) => typeof v !== 'string'))) throw new Error(`Invalid headers for contact MCP ${name}`);
    return [{ name, url: entry.url, required: false,
      defaultToolsApprovalMode: allowed.includes(`mcp__${name}__*`) ? 'auto' : 'approve',
      ...(entry.headers ? { httpHeaders: { ...entry.headers } } : {}),
    }];
  });
}

/** Only the exact configured and explicitly allowed server may obtain host approval. */
export function isConfiguredMcpApproval(method: string, params: unknown, servers: CodexMcpServerConfig[] = []): boolean {
  if (!/mcp/i.test(method) || /execCommand|applyPatch|sandbox/i.test(method)) return false;
  const record = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {};
  const server = record.serverName ?? record.mcpServer ?? record.server;
  if (typeof server !== 'string') return false;
  return servers.some((entry) => entry.name === server && entry.defaultToolsApprovalMode === 'auto');
}
