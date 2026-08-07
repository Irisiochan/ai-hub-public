import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.js';
import { buildTurnBlock } from '../src/memory/inject.js';

const userText = process.argv.slice(2).join(' ').trim() || '还有 vault 检索命中质量🫡';
const config = loadConfig();
const url = config.memory.mcpUrl;
if (!url) throw new Error('memory.mcpUrl is disabled');

const token = process.env.VAULT_TOKEN?.trim();
const client = new Client({ name: 'ai-hub-vault-search-smoke', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
});

try {
  await client.connect(transport);
  const vault = {
    async call(name: string, args: Record<string, unknown>): Promise<string> {
      const response: any = await client.callTool({ name, arguments: args });
      if (response?.isError) throw new Error('vault tool returned an error');
      return (response?.content ?? [])
        .filter((item: any) => item.type === 'text')
        .map((item: any) => item.text)
        .join('\n');
    },
  };
  const maxChars = config.memory.maxTurnChars;
  const block = await buildTurnBlock(vault as never, userText, new Set(), maxChars);
  if (!block) throw new Error('gateway produced no vault search block');
  const paths = [...block.matchAll(/\(`([^`]+)`\)/g)].map((match) => match[1]);
  const snippetCount = block.split('\n').filter((line) => /^\s*>\s+/.test(line)).length;
  const expected = process.env.EXPECTED_VAULT_PATH?.trim();
  if (expected && paths[0] !== expected) {
    throw new Error(`expected first path ${expected}, received ${paths[0] ?? 'none'}`);
  }
  if (block.length > maxChars) throw new Error(`block exceeded budget: ${block.length}/${maxChars}`);
  if (snippetCount < 1) throw new Error('gateway discarded every search snippet');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    userText,
    paths,
    snippetCount,
    chars: block.length,
    maxChars,
  }, null, 2)}\n`);
} finally {
  await client.close().catch(() => {});
}
