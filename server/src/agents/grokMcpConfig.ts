import fs from 'node:fs';
import path from 'node:path';

const MANAGED_START = '# >>> AI Hub managed Hub MCP >>>';
const MANAGED_END = '# <<< AI Hub managed Hub MCP <<<';
const MANAGED_BLOCK_RE = new RegExp(
  `${MANAGED_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n?`,
  'g'
);

export const GROK_HUB_ALLOW_RULE = 'MCPTool(hub__*)';

export function managedGrokHubMcpToml(url: string): string {
  if (!url || /["\r\n]/.test(url)) throw new Error('invalid Grok Hub MCP URL');
  return [
    MANAGED_START,
    '[mcp_servers.hub]',
    `url = "${url}"`,
    'headers = { Authorization = "Bearer ${HUB_MCP_TOKEN}" }',
    MANAGED_END,
    '',
  ].join('\n');
}

/**
 * Upsert only AI Hub's marked block in Grok Build's project config. Other
 * user-authored Grok settings remain untouched. Passing no URL removes a
 * stale managed block after Worker delegation is disabled.
 */
export function syncManagedGrokHubMcpConfig(cwd: string, url?: string): string | undefined {
  const dir = path.join(cwd, '.grok');
  const file = path.join(dir, 'config.toml');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const hasManagedBlock = existing.includes(MANAGED_START) && existing.includes(MANAGED_END);
  const unmanaged = existing.replace(MANAGED_BLOCK_RE, '').trimEnd();

  if (!url) {
    if (!hasManagedBlock) return undefined;
    if (unmanaged.trim()) fs.writeFileSync(file, `${unmanaged}\n`, 'utf-8');
    else fs.rmSync(file);
    return undefined;
  }

  if (/^\s*\[mcp_servers\.hub\]\s*$/m.test(unmanaged)) {
    throw new Error('Grok 项目配置已有自定义 mcp_servers.hub；请改名后再启用 Worker 委派');
  }

  fs.mkdirSync(dir, { recursive: true });
  const body = [unmanaged, managedGrokHubMcpToml(url).trimEnd()]
    .filter(Boolean)
    .join('\n\n') + '\n';
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}
